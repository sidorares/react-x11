// One window as the renderer sees it: the object `app.createWindow()` hands
// back and `src/nodes/window/` drives.
//
// It wears the interface ntk's `Window` has — `getContext`, `on(...)`,
// `width`/`height`, `setTitle`, `requestAnimationFrame`, `destroy` and the
// rest — over a Wayland surface, a GL context and the client-side
// decorations. Where the X11 shape has no Wayland meaning the method is
// there and says so rather than silently doing nothing, because a stub that
// does nothing turns "not implemented" into a rendering bug two layers away.
//
// Two coordinate systems meet here and the rule is fixed: **everything the
// tree sees is content-relative and in device pixels**, as it is on the
// other backends. The surface is bigger than the content by the frame
// (decorations.js), and a compositor speaks logical pixels; the conversions
// happen at this boundary and nowhere else.
//
// The frame loop is the compositor's. `requestAnimationFrame` arms a
// `wl_surface.frame` callback (or paints straight away for the first frame,
// which nothing can pace), the callback runs the renderer's paint into the
// backing target, and the result is copied to a swapchain buffer and
// committed with the next frame request in the same commit.
//
// The frame is drawn here only until a compositor agrees to draw it:
// where xdg-decoration is offered the window asks for server-side
// decorations (ssd.js) and, granted them, switches its own off, which the
// tree sees as the content growing. And a window whose `windowType` is a
// dock, a wallpaper, a notification or a splash is not a toplevel at all
// where the compositor has layer-shell (layershell.js) — same surface, same
// loop, no frame.

import { EventEmitter } from 'node:events';
import { writeSync, writeFileSync } from 'node:fs';
import { snapshotPNG } from './readback.js';
import { WaylandWindow, TOPLEVEL_STATE } from './window.js';
import { WaylandGLContext } from './glcontext.js';
import { WaylandContext2D } from './context2d.js';
import { Decorations } from './decorations.js';
import { decorationPolicy } from './ssd.js';
import { layerRoleFor } from './layershell.js';

// What the X11 window has and this one does not — `getProperty`,
// `setProperty`, `selectXI2`, `grabKeyboard`, `setBackgroundPixel`,
// `reparent` — is *absent* rather than stubbed. That is the contract the
// tree already keeps for the cocoa backend: every caller probes
// (`wnd.setProperty?.(…)`, `typeof wnd.selectXI2 === 'function'`) and takes
// the absence as "not on this backend". A method that throws instead turns
// each of those probes into a crash two layers away (`_NET_WM_DESKTOP` was
// the first: src/windowstate.js reads it on every window).

const STATE_NAMES = {
  [TOPLEVEL_STATE.MAXIMIZED]: ['maximized_vert', 'maximized_horz'],
  [TOPLEVEL_STATE.FULLSCREEN]: ['fullscreen'],
  [TOPLEVEL_STATE.ACTIVATED]: ['focused'],
  [TOPLEVEL_STATE.SUSPENDED]: ['hidden'],
};

/** `REACT_X11_WAYLAND_TRACE=1`: a line on stderr per presented frame. */
const TRACE = Boolean(process.env.REACT_X11_WAYLAND_TRACE);
/**
 * `REACT_X11_WAYLAND_SNAPSHOT=<file.png>`: the backing target of the first
 * window, written at its present number `REACT_X11_WAYLAND_SNAPSHOT_AT`
 * (default 30) — what the compositor was handed, read back from the GPU. The
 * one way to see a frame on a desktop that offers no screenshot API.
 */
const SNAPSHOT = process.env.REACT_X11_WAYLAND_SNAPSHOT || null;
const SNAPSHOT_AT = Number(process.env.REACT_X11_WAYLAND_SNAPSHOT_AT) || 30;

let nextId = 1;

const overlaps = (a, b) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

export class WaylandBackendWindow extends EventEmitter {
  /**
   * @param {import('./app.js').WaylandApp} app
   * @param {object} attributes what `WindowNode.realize()` built
   */
  constructor(app, attributes = {}) {
    super();
    this.setMaxListeners(0);
    this.app = app;
    this.attributes = attributes;
    this.id = nextId++;
    this.X = app.X;
    this.ownerDocument = null;
    this.isPopup = attributes.overrideRedirect === true;
    // A `<popup dragPreview>` is the picture of a drag. On Wayland it has
    // nothing to be: a popup cannot follow a drag (start_drag's icon surface
    // is the mechanism, and rendering the preview into one is a follow-up —
    // src/wayland/dnd.js), so the preview is inert here — it presents no
    // frame and holds no buffer, staying invisible rather than a static
    // xdg_popup frozen where the drag began.
    this.isDragPreview = attributes.dragPreview === true;
    // A dock, a wallpaper, a notification: a layer surface where the
    // compositor has layer-shell, an ordinary toplevel where it does not.
    this.layerRole =
      !this.isPopup && app.layerShell
        ? layerRoleFor(attributes, { scale: app.scale })
        : null;
    this.isLayer = this.layerRole !== null;
    /** the cursor the tree last asked for over the content */
    this.treeCursor = 'default';
    this._destroyed = false;
    this._contexts = new Map();
    this._raf = [];
    this._frameArmed = false;
    this._everPresented = false;
    this._eagerFired = false;
    this._presentInFlight = false;
    this._frameSize = null;
    this._frameDirty = true;
    this._resized = true;
    this._reactX11Node = null;
    /** `<glarea>`s drawing into this window's target (glarea.js) */
    this._surfaces = new Set();
    /** the panes their children are painted on */
    this._panes = new Set();
    this._surfaceRaf = [];
    /** rects (content px) a surface or pane changed since the last present */
    this._surfaceDamage = [];

    // Frame and content sizes. `attributes.width/height` are what the tree
    // measured, in device pixels of content; the surface adds the frame.
    // Popups and layer surfaces have none; a toplevel's is switched off once
    // a compositor agrees to draw it (`_setDecorationMode`).
    this._decorPolicy = decorationPolicy(
      app.options.decorations,
      attributes.decorations,
    );
    this.decor =
      this.isPopup || this.isLayer
        ? null
        : new Decorations({ enabled: this._decorPolicy.draw });
    if (this.decor) this.decor.title = attributes.title ?? 'react-x11';
    const scale = app.scale;
    const insets = this.insets;
    const contentW = Math.max(1, (attributes.width ?? 640) / scale);
    const contentH = Math.max(1, (attributes.height ?? 480) / scale);
    /** the content size the tree asked for, in logical pixels */
    this._contentWish = { width: contentW, height: contentH };
    const surfaceW = Math.round(contentW + insets.left + insets.right);
    const surfaceH = Math.round(contentH + insets.top + insets.bottom);

    if (this.isPopup) {
      const parent = app.parentFor(attributes);
      const pi = parent?.insets ?? { left: 0, top: 0 };
      const ps = parent?.scale ?? scale;
      this.wl = WaylandWindow.createPopupSync({
        conn: app.conn,
        compositor: app.compositor,
        wmBase: app.wmBase,
        parent: parent?.wl,
        x: (attributes.x ?? 0) / ps + pi.left,
        y: (attributes.y ?? 0) / ps + pi.top,
        width: surfaceW,
        height: surfaceH,
      });
      this.parentWindow = parent;
    } else if (this.isLayer) {
      this.wl = WaylandWindow.createLayerSync({
        conn: app.conn,
        compositor: app.compositor,
        layerShell: app.layerShell,
        width: surfaceW,
        height: surfaceH,
        ...this.layerRole,
      });
    } else {
      this.wl = WaylandWindow.createSync({
        conn: app.conn,
        compositor: app.compositor,
        wmBase: app.wmBase,
        title: attributes.title ?? 'react-x11',
        appId:
          attributes.appId ??
          attributes.class ??
          app.options.appId ??
          'react-x11',
        width: surfaceW,
        height: surfaceH,
        parent: app.parentFor(attributes, { toplevelOnly: true })?.wl ?? null,
        decorations: app.decorationManager
          ? { manager: app.decorationManager, prefer: this._decorPolicy.prefer }
          : null,
      });
    }
    this.wl.scale = scale;
    this.wl.useScaling({
      fractionalScaleManager: app.fractionalScale,
      viewporter: app.viewporter,
    });
    // which monitor it is on, its bounds, and the output-scale fallback
    app.outputs?.watchWindow(this.wl);
    this.glctx = WaylandGLContext.createSync({
      conn: app.conn,
      window: this.wl,
      dmabuf: app.dmabuf,
      policy: app.options.glPolicy ?? {},
    });
    this._wire();
  }

  _wire() {
    const wl = this.wl;
    wl.on('resize', () => {
      this._resized = true;
      this._frameDirty = true;
      this.emit('resize', {
        width: this.width,
        height: this.height,
        x: 0,
        y: 0,
      });
    });
    wl.on('configure', ({ states }) => {
      if (this.decor) {
        const before = this.decor.insets().top;
        this.decor.setState(states);
        this._frameDirty = true;
        if (this.decor.insets().top !== before) {
          this._resized = true;
          this.emit('resize', {
            width: this.width,
            height: this.height,
            x: 0,
            y: 0,
          });
        }
      }
      // adopting a configure needs a frame even when nothing else changed
      this._armFrame();
    });
    wl.on('decorationmode', (mode) => this._setDecorationMode(mode));
    wl.on('statechange', () => this.emit('statechange', this.getWmStates()));
    wl.on('close', () => this.requestClose());
    wl.on('scale', () => {
      this._resized = true;
      this._frameDirty = true;
      this.app.noteScale();
      this.emit('resize', {
        width: this.width,
        height: this.height,
        x: 0,
        y: 0,
      });
    });
    wl.on('error', (err) => this.emit('error', err));
  }

  /**
   * The compositor's answer to who draws the frame. 'server' switches the
   * client-side frame off: the insets go to zero, no titlebar is painted,
   * and the content grows into the whole surface — a resize, as far as the
   * tree is concerned, and `set_window_geometry` already covers the buffer.
   * Before the first frame, where the compositor has not imposed a size,
   * the surface is refitted to the content the tree asked for instead, so a
   * floating window comes up the size it was declared rather than a
   * titlebar taller. The answer can change later (a compositor's setting
   * flips) and the same switch runs the other way.
   */
  _setDecorationMode(mode) {
    if (!this.decor) return;
    const enabled = this._decorPolicy.draw && mode !== 'server';
    if (this.decor.enabled === enabled) return;
    this.decor.enabled = enabled;
    if (!this._everPresented && !this.wl.sizeImposed) {
      const i = this.insets;
      const wish = this._contentWish;
      this.wl.width = Math.max(1, Math.round(wish.width + i.left + i.right));
      this.wl.height = Math.max(1, Math.round(wish.height + i.top + i.bottom));
    }
    this._resized = true;
    this._frameDirty = true;
    this.emit('resize', { width: this.width, height: this.height, x: 0, y: 0 });
  }

  // ---- geometry ---------------------------------------------------------

  /** The frame's insets in logical pixels. */
  get insets() {
    return this.decor
      ? this.decor.insets()
      : { top: 0, left: 0, right: 0, bottom: 0 };
  }

  get scale() {
    return this.wl.scale;
  }

  /**
   * The monitor this window is on — the output the surface has entered
   * (the densest one when it straddles two), as a `screens.js`-shaped
   * record with the output's `name`, `description`, `scale` and
   * `refreshRate`; null before the first present, when no compositor has
   * said yet.
   */
  get output() {
    return this.app.outputs?.monitorFor(this.wl.outputs) ?? null;
  }

  /** Content width in device pixels — what the tree lays out to. */
  get width() {
    const i = this.insets;
    return Math.max(
      1,
      Math.round((this.wl.width - i.left - i.right) * this.wl.scale),
    );
  }

  get height() {
    const i = this.insets;
    return Math.max(
      1,
      Math.round((this.wl.height - i.top - i.bottom) * this.wl.scale),
    );
  }

  get x() {
    return Math.round(this.wl.x * this.wl.scale);
  }

  get y() {
    return Math.round(this.wl.y * this.wl.scale);
  }

  /** Content origin inside the buffer, in device pixels. */
  get contentOrigin() {
    const i = this.insets;
    const s = this.wl.scale;
    return { x: Math.round(i.left * s), y: Math.round(i.top * s) };
  }

  getClientRects() {
    return [
      { x: 0, y: 0, left: 0, top: 0, width: this.width, height: this.height },
    ];
  }

  measure(callback) {
    callback?.(0, 0, this.width, this.height, 0, 0);
    return { width: this.width, height: this.height };
  }

  // ---- contexts ---------------------------------------------------------

  /**
   * The rendering context, by name. `'2d'` is the GPU context drawing into
   * this window's backing target; `'gles'` is the raw GL entry points a
   * `<glarea>` wants, with the backing target bound.
   */
  getContext(name = '2d') {
    if (this._contexts.has(name)) return this._contexts.get(name);
    let ctx;
    if (name === '2d') {
      if (!this.glctx.backing) this.glctx.beginFrame();
      ctx = new WaylandContext2D(this.glctx.gl, {
        fontManager: this.app.fonts,
        target: this.glctx.backing,
      });
      this.app.makeCurrent();
      ctx.init();
      // The renderer creates its context lazily, inside its first paint —
      // by which time this frame has begun, so the context is caught up.
      if (this._frameSize) {
        ctx.begin(
          this._frameSize.width,
          this._frameSize.height,
          this._frameSize.time,
        );
        this._enterContent(ctx);
      }
    } else if (name === 'gles' || name === 'opengl' || name === 'webgl') {
      ctx = this.glctx.gl;
    } else {
      throw new Error(
        `react-x11 (wayland): no '${name}' rendering context — this backend has '2d' and 'gles'`,
      );
    }
    this._contexts.set(name, ctx);
    return ctx;
  }

  // ---- the frame loop ---------------------------------------------------

  /**
   * The frame clock in the shape the renderer uses. On X11 this is Present
   * completions plus an estimator; here it is the compositor's own
   * `wl_surface.frame`, which is both simpler and honest about occlusion —
   * an invisible window stops being called back, and so stops painting.
   */
  requestAnimationFrame(fn) {
    this._raf.push(fn);
    this._armFrame();
    return this._raf.length;
  }

  /** Ask for a repaint of the decorations at the next frame. */
  /**
   * A `<glarea>`'s frame: after the tree's paint, in the same frame of this
   * window, so the GL goes over the 2D and out with the same present.
   */
  requestSurfaceFrame(fn) {
    this._surfaceRaf.push(fn);
    this._armFrame();
  }

  /** A surface drew: its rect is owed to the compositor. */
  _surfaceDrew(area) {
    this._surfaceDamage.push({ ...area.rect });
  }

  /** A pane was painted: it is composited over its surface this frame. */
  _paneDrew(pane) {
    this._surfaceDamage.push({ ...pane.rect });
  }

  repaintFrame() {
    this._frameDirty = true;
    this._armFrame();
  }

  /**
   * Get a frame in flight.
   *
   * Three rules, each learned from a spin:
   *
   * - **A frame stays armed from its callback until its present has been
   *   handed over.** A callback that asks for the next frame (every
   *   animation does) queues it for the next vsync, as in a browser; it does
   *   not re-fire. The first version cleared the flag before running the
   *   callback, and an animation re-entered itself from inside the frame.
   * - **The first frame cannot be paced**, because a compositor only
   *   schedules frame callbacks for a surface it is showing — so until the
   *   first buffer has been presented, frames run from a *timer*. Never from
   *   a microtask: presenting that first buffer needs the event loop (the
   *   dma-buf import is a round trip), and a microtask chain that keeps
   *   painting never yields to it. That was 100% of a core, nothing on
   *   screen, and Ctrl+C ignored.
   * - **Post-present, an empty frame re-arms through the compositor**, so
   *   a renderer that keeps asking without drawing costs a commit per
   *   refresh, not a spin.
   */
  _armFrame() {
    // A drag preview never presents (see the constructor): no frame loop, so
    // no buffer is ever committed and the surface stays invisible.
    if (this.isDragPreview) return;
    if (this._frameArmed || this._destroyed) return;
    this._frameArmed = true;
    this.wl.whenConfigured
      .then(() => {
        if (this._destroyed) return;
        if (this._presentInFlight) return; // its vsync runs the next frame
        if (!this._everPresented) {
          const delay = this._eagerFired ? 16 : 0;
          this._eagerFired = true;
          setTimeout(() => this._fireRaf(0), delay);
          return;
        }
        const vsync = this.wl.scheduleFrame();
        this.wl.surface.$.commit();
        vsync.then(
          (t) => this._fireRaf(t),
          () => this._frameIdle(),
        );
      })
      .catch(() => this._frameIdle());
  }

  /** The frame is over with nothing presented; run again only if asked. */
  _frameIdle() {
    this._frameArmed = false;
    if (!this._destroyed && (this._raf.length || this._frameDirty)) {
      this._armFrame();
    }
  }

  /** Translate into the content area and clip to it. */
  _enterContent(ctx) {
    const o = this.contentOrigin;
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.beginPath();
    ctx.rect(0, 0, this.width, this.height);
    ctx.clip();
  }

  /**
   * Run the frame: open the GL frame, paint the decorations, let the
   * renderer paint the content, close, and present.
   *
   * On X11 none of this is needed — an ntk 2d context is an XRender encoder
   * writing straight at the window, so a paint *is* a present. Here a frame
   * has a beginning and an end, and this is where they go, because the
   * renderer's own paint is the callback in the middle.
   */
  _fireRaf(time) {
    if (this._destroyed) return;
    const due = this._raf.splice(0);
    const frameDirty = this._frameDirty;
    if (due.length === 0 && !frameDirty && this._surfaceRaf.length === 0) {
      this._frameArmed = false;
      return;
    }

    const size = this.glctx.beginFrame();
    if (!size) return this._frameIdle();
    // This window's GBM surface is current now, and stays the app's notion of
    // "current" for the frame: an offscreen render, a pane, a context made
    // lazily inside the paint — each asks `app.makeCurrent()` — must not
    // switch to another window's surface mid-frame, or the blit lands on
    // that window and `eglSwapBuffers` on this one is EGL_BAD_SURFACE (the
    // popup crash: its first frame made its context, and `makeCurrent`
    // reached for the toplevel's surface it had cached).
    if (this.glctx.chain?.gbm) this.app._currentSurface = this.glctx.chain.gbm;
    const resized = size.resized || this._resized;
    this._resized = false;
    this._frameSize = { width: size.width, height: size.height, time };
    const ctx = this._contexts.get('2d');
    if (ctx) {
      ctx.begin(size.width, size.height, time);
      this._paintFrame(ctx);
      this._enterContent(ctx);
    }

    // `_frameArmed` stays set: a callback that asks for the next frame is
    // queued for the vsync after this present, not run again now.
    for (const fn of due) {
      try {
        fn(time);
      } catch (err) {
        this.emit('error', err);
      }
    }
    // The input method hears about the focused field now, after the paint
    // has laid the tree out and the caret rectangle is current (textinput.js).
    this.app.textInput?.sync(this);

    const painted = this._contexts.get('2d');
    if (this._surfaces.size || this._surfaceRaf.length || this._panes.size) {
      this._runSurfaces(painted, time, resized || frameDirty);
    }
    if (painted) {
      painted.restore();
      painted.end();
    }
    this._frameSize = null;

    const drew =
      painted?.drew || frameDirty || resized || this._surfaceDamage.length > 0;
    if (!drew) return this._frameIdle();
    this._frameDirty = false;
    void this._present(resized || frameDirty ? 'all' : this._damageFor());
  }

  /**
   * The `<glarea>`s' turn, after the tree has painted: flush the 2D under
   * them, let each draw into its rect, put the 2d context's GL state back,
   * and blend the children's panes over the surfaces.
   *
   * One thing a shared target needs that a child window never did: where
   * the tree repainted *under* a surface that has no frame of its own this
   * time — a background fill reaching under a static scene — the surface's
   * pixels are gone with the repaint, so its node is asked for the frame
   * now, before the present, rather than showing the fill for a frame.
   */
  _runSurfaces(ctx, time, wholeFrame) {
    ctx?.flush();
    for (const area of this._surfaces) area.drewThisFrame = false;
    this._drainSurfaceFrames(time);
    if (this._surfaces.size) {
      const damage = wholeFrame ? null : this._reactX11Node?._lastDamageRects;
      for (const area of this._surfaces) {
        if (area.drewThisFrame || !area.mapped || area.destroyed) continue;
        if (damage && !damage.some((r) => overlaps(r, area.rect))) continue;
        area._reactX11Node?.requestFrame?.();
      }
      this._drainSurfaceFrames(time);
    }
    if (!ctx) return;
    ctx.restoreGLState();
    if (this._surfaceDamage.length === 0) return;
    for (const pane of this._panes) {
      if (pane.hidden || !pane.presented || pane.destroyed) continue;
      ctx.drawImage(pane.target, pane.rect.x, pane.rect.y);
    }
  }

  _drainSurfaceFrames(time) {
    // a callback may queue the next frame; that one is for the next present
    const due = this._surfaceRaf.splice(0);
    for (const fn of due) {
      try {
        fn(time);
      } catch (err) {
        this.emit('error', err);
      }
    }
  }

  _paintFrame(ctx) {
    if (!this.decor) return;
    const s = this.wl.scale;
    ctx.save();
    ctx.scale(s, s);
    this.decor.paint(ctx, this.wl.width, this.wl.height, this.app.frameText);
    ctx.restore();
  }

  /**
   * What the renderer repainted, as buffer-space rectangles. The window node
   * keeps the rects its last flush painted; `null` means all of it.
   */
  _damageFor() {
    const node = this._reactX11Node;
    const rects = node?._lastDamageRects;
    const extra = this._surfaceDamage.splice(0);
    if (!rects) return 'all';
    const o = this.contentOrigin;
    return [...rects, ...extra].map((r) => ({
      x: r.x + o.x,
      y: r.y + o.y,
      width: r.width,
      height: r.height,
    }));
  }

  /** Hand the painted buffer to the compositor and re-arm the clock. */
  async _present(damage) {
    if (this._destroyed) return;
    this._presentInFlight = true;
    if (SNAPSHOT && (this._presents ?? 0) + 1 === SNAPSHOT_AT) {
      try {
        this.glctx.bindBacking();
        const { width, height } = this.glctx.backing;
        writeFileSync(SNAPSHOT, snapshotPNG(this.glctx.gl, width, height));
        writeSync(2, `react-x11 wayland: wrote ${SNAPSHOT}\n`);
      } catch (err) {
        writeSync(2, `react-x11 wayland: snapshot failed: ${err.message}\n`);
      }
    }
    let vsync;
    try {
      vsync = await this.glctx.endFrame(damage);
    } catch (err) {
      this._presentInFlight = false;
      this.emit('error', err);
      return this._frameIdle();
    }
    this._everPresented = true;
    this.wl.mapped = true;
    this._presents = (this._presents ?? 0) + 1;
    if (TRACE) {
      // a synchronous write: Bun buffers process.stderr to a file, and a
      // buffer is what a SIGINT leaves behind
      writeSync(
        2,
        `react-x11 wayland: window ${this.id} present #${this._presents} ` +
          `${damage === 'all' ? 'full' : damage.length + ' rect(s)'}\n`,
      );
    }
    Promise.resolve(vsync).then(
      (t) => {
        this._presentInFlight = false;
        if (!this._destroyed) this._fireRaf(t);
      },
      () => {
        this._presentInFlight = false;
        this._frameIdle();
      },
    );
  }

  // ---- window operations -------------------------------------------------

  setTitle(title) {
    if (this.decor) {
      this.decor.title = String(title ?? '');
      this.repaintFrame();
    }
    this.wl.setTitle(title);
    return this;
  }

  setClass() {
    // app_id is fixed at creation; xdg-shell has no later change
    return this;
  }

  /**
   * A size or a state. The renderer's size tracking calls this with
   * `{ width, height }` (device pixels of content); a string is a WM state.
   *
   * A Wayland client *can* pick its own size — it simply commits a buffer
   * that big — unless the compositor is imposing one (maximised, tiled, or
   * mid-resize), in which case the wish is recorded and not acted on.
   */
  setState(state) {
    if (state && typeof state === 'object') {
      if ('width' in state || 'height' in state)
        this.resize(state.width ?? this.width, state.height ?? this.height);
      return this;
    }
    if (state === 'maximized') this.wl.maximize(true);
    else if (state === 'fullscreen') this.wl.fullscreen(true);
    else if (state === 'minimized' || state === 'iconic') this.wl.minimize();
    else if (state === 'normal') {
      this.wl.maximize(false);
      this.wl.fullscreen(false);
    }
    return this;
  }

  resize(width, height) {
    const st = this.wl.states;
    const imposed =
      st.has(TOPLEVEL_STATE.MAXIMIZED) ||
      st.has(TOPLEVEL_STATE.FULLSCREEN) ||
      st.has(TOPLEVEL_STATE.RESIZING) ||
      [...st].some(
        (s) =>
          s >= TOPLEVEL_STATE.TILED_LEFT && s <= TOPLEVEL_STATE.TILED_BOTTOM,
      );
    if (imposed && this.wl.configured) {
      this._wanted = { width, height };
      return this;
    }
    const i = this.insets;
    const s = this.wl.scale;
    let w = Math.max(1, Math.round(width / s + i.left + i.right));
    let h = Math.max(1, Math.round(height / s + i.top + i.bottom));
    if (this.isPopup) {
      this.wl.reposition(this.app.wmBase, {
        x: this.wl.x,
        y: this.wl.y,
        width: w,
        height: h,
      });
    }
    if (this.isLayer) {
      // A stretched axis is the compositor's; the wish on it is not granted.
      const role = this.wl.layer;
      if (role.stretchX) w = this.wl.width;
      if (role.stretchY) h = this.wl.height;
      if (w !== this.wl.width || h !== this.wl.height) role.resize(w, h);
    }
    if (w === this.wl.width && h === this.wl.height) return this;
    this.wl.width = w;
    this.wl.height = h;
    this._resized = true;
    this._frameDirty = true;
    this._armFrame();
    return this;
  }

  move(x, y) {
    if (this.isPopup) {
      const p = this.parentWindow;
      const pi = p?.insets ?? { left: 0, top: 0 };
      const ps = p?.scale ?? this.scale;
      this.wl.reposition(this.app.wmBase, {
        x: x / ps + pi.left,
        y: y / ps + pi.top,
        width: this.wl.width,
        height: this.wl.height,
      });
      return this;
    }
    // A toplevel cannot place itself. Not an error: the tree asks on every
    // controlled position, and the compositor's answer is final.
    return this;
  }

  getWmStates() {
    const out = [];
    for (const s of this.wl.states)
      for (const n of STATE_NAMES[s] ?? []) out.push(n);
    return out;
  }

  setWmState(state, on = true) {
    if (
      state === 'maximized_vert' ||
      state === 'maximized_horz' ||
      state === 'maximized'
    )
      this.wl.maximize(on);
    else if (state === 'fullscreen') this.wl.fullscreen(on);
    else if (state === 'hidden' && on) this.wl.minimize();
    return this;
  }

  setWindowType() {
    return this;
  }

  setSizeHints(hints = {}) {
    if (this.isPopup) return this;
    const s = this.wl.scale;
    const i = this.insets;
    if (hints.minWidth || hints.minHeight) {
      this.wl.setMinSize(
        (hints.minWidth ?? 0) / s + i.left + i.right,
        (hints.minHeight ?? 0) / s + i.top + i.bottom,
      );
    }
    if (hints.maxWidth || hints.maxHeight) {
      this.wl.setMaxSize(
        (hints.maxWidth ?? 0) / s + i.left + i.right,
        (hints.maxHeight ?? 0) / s + i.top + i.bottom,
      );
    }
    return this;
  }

  setTransientFor(id) {
    if (this.isPopup) return this;
    const parent = id == null ? null : this.app.windowById(id);
    this.wl.setParent(parent?.wl ?? null);
    return this;
  }

  /**
   * The drop side (src/wayland/dnd.js): the window node hands over its
   * DropSession at realize (`_initDnd`), and from then on the app-wide
   * `WaylandDnd` routes this surface's data-device events into it. The
   * method's presence is what tells the tree this backend has drop machinery
   * of its own.
   */
  attachDropTransport(session, node) {
    this.app.dnd?.attach(this, session, node);
    return this;
  }

  /**
   * The source side: hand a `DragSession`'s gesture to a `wl_data_source`
   * (see src/wayland/dnd.js). Called by `DragSession._start` once the
   * threshold is crossed; returns at once, and the session reports back on
   * the source's own events.
   */
  beginDrag(session) {
    return this.app.dnd?.beginDrag(this, session) ?? null;
  }

  /** The tree's cursor over the content. */
  setCursor(name) {
    this.treeCursor = name ?? 'default';
    if (
      this.app.input?.pointerWindow === this &&
      !this.app.input._frameCursor
    ) {
      this.app.seat.setCursor(this.treeCursor);
    }
    return this;
  }

  /**
   * A popup's grab: the press outside it that should dismiss it arrives
   * here rather than at whatever is under the pointer. Must precede the
   * popup's first buffer, which is why the request is sent now and the
   * callback answers on the next tick.
   */
  grabPointer(_opts, callback) {
    if (this.isPopup && this.wl.popup) {
      const serial = this.app.seat.lastPressSerial || this.app.seat.lastSerial;
      try {
        this.wl.popup.$.grab(this.app.seat.seat.id, serial);
      } catch (err) {
        return void queueMicrotask(() => callback?.(err));
      }
    }
    queueMicrotask(() => callback?.(null));
    return this;
  }

  ungrabPointer() {
    // a popup's grab ends when the popup does
    return this;
  }

  raise() {
    return this;
  }

  lower() {
    return this;
  }

  map() {
    this._wantMapped = true;
    this._armFrame();
    return this;
  }

  unmap() {
    this.wl.unmap();
    return this;
  }

  /** The compositor (or the frame's close button) asked; the tree decides. */
  requestClose() {
    let prevented = false;
    this.emit('close', {
      preventDefault() {
        prevented = true;
      },
      get defaultPrevented() {
        return prevented;
      },
    });
    if (!prevented) this.app.emit('closeRequest', this);
  }

  focus() {
    // Focus is the compositor's to give. xdg-activation can ask, with a token
    // from a recent interaction; without one the request is ignored.
    this.app.activate(this);
    return this;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._raf.length = 0;
    this.app.dnd?.detach(this);
    this.app.makeCurrent();
    for (const ctx of this._contexts.values()) ctx.destroy?.();
    this._contexts.clear();
    this.glctx.destroy();
    this.app._forgetWindow(this);
    this.wl.destroy();
    this.emit('_destroyed');
  }
}
