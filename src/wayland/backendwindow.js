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

import { EventEmitter } from 'node:events';
import { WaylandWindow, TOPLEVEL_STATE } from './window.js';
import { WaylandGLContext } from './glcontext.js';
import { WaylandContext2D } from './context2d.js';
import { Decorations } from './decorations.js';

/** What this backend cannot do, and what would have to exist instead. */
const NOT_ON_WAYLAND = {
  setProperty:
    'window properties are an X concept; the equivalents are xdg-shell requests and, for desktop integration, portals',
  getProperty: 'window properties are an X concept',
  selectXI2:
    'XI2 does not exist here; input arrives on wl_seat (src/wayland/seat.js)',
  grabKeyboard:
    'a Wayland client cannot grab the keyboard; see keyboard-shortcuts-inhibit',
  setBackgroundPixel: 'there is no server-side window background; paint it',
  reparent: 'there is no window tree a client can see',
};

function refuse(name) {
  return () => {
    throw new Error(`react-x11 (wayland): ${name}() — ${NOT_ON_WAYLAND[name]}`);
  };
}

const STATE_NAMES = {
  [TOPLEVEL_STATE.MAXIMIZED]: ['maximized_vert', 'maximized_horz'],
  [TOPLEVEL_STATE.FULLSCREEN]: ['fullscreen'],
  [TOPLEVEL_STATE.ACTIVATED]: ['focused'],
  [TOPLEVEL_STATE.SUSPENDED]: ['hidden'],
};

let nextId = 1;

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
    /** the cursor the tree last asked for over the content */
    this.treeCursor = 'default';
    this._destroyed = false;
    this._contexts = new Map();
    this._raf = [];
    this._frameArmed = false;
    this._everPresented = false;
    this._frameSize = null;
    this._frameDirty = true;
    this._resized = true;
    this._reactX11Node = null;

    for (const name of Object.keys(NOT_ON_WAYLAND)) this[name] = refuse(name);

    // Frame and content sizes. `attributes.width/height` are what the tree
    // measured, in device pixels of content; the surface adds the frame.
    this.decor = this.isPopup
      ? null
      : new Decorations({ enabled: app.options.decorations !== false });
    if (this.decor) this.decor.title = attributes.title ?? 'react-x11';
    const scale = app.scale;
    const insets = this.insets;
    const contentW = Math.max(1, (attributes.width ?? 640) / scale);
    const contentH = Math.max(1, (attributes.height ?? 480) / scale);
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
      });
    }
    this.wl.scale = scale;
    this.wl.useScaling({
      fractionalScaleManager: app.fractionalScale,
      viewporter: app.viewporter,
    });
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
  repaintFrame() {
    this._frameDirty = true;
    this._armFrame();
  }

  /**
   * Get a frame in flight.
   *
   * The first frame cannot be paced: a compositor only schedules frame
   * callbacks for a surface it is showing, and a surface shows nothing until
   * it has committed a buffer. So the first paint runs as soon as the first
   * configure has arrived, and the clock takes over from the second. While a
   * present is in flight its own callback re-arms, so nothing else may
   * commit in between — a second frame request would only cost a vblank.
   */
  _armFrame() {
    if (this._frameArmed || this._destroyed) return;
    this._frameArmed = true;
    this.wl.whenConfigured
      .then(() => {
        if (this._destroyed) return 0;
        if (!this._everPresented) return 0;
        const vsync = this.wl.scheduleFrame();
        this.wl.surface.$.commit();
        return vsync;
      })
      .then(
        (t) => {
          this._frameArmed = false;
          if (!this._destroyed) this._fireRaf(t ?? 0);
        },
        () => {
          this._frameArmed = false;
        },
      );
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
    if (due.length === 0 && !frameDirty) return;

    const size = this.glctx.beginFrame();
    if (!size) return;
    const resized = size.resized || this._resized;
    this._resized = false;
    this._frameSize = { width: size.width, height: size.height, time };
    const ctx = this._contexts.get('2d');
    if (ctx) {
      ctx.begin(size.width, size.height, time);
      this._paintFrame(ctx);
      this._enterContent(ctx);
    }

    for (const fn of due) {
      try {
        fn(time);
      } catch (err) {
        this.emit('error', err);
      }
    }

    const painted = this._contexts.get('2d');
    if (painted) {
      if (painted !== ctx) {
        // created during the paint: it was caught up in getContext, and is
        // inside the content clip
      }
      painted.restore();
      painted.end();
    }
    this._frameSize = null;

    const drew = painted?.drew || frameDirty || resized;
    if (!drew) {
      // nothing changed: no buffer goes out, but the clock must keep ticking
      // if anyone asked for a frame, and a present in flight does that
      this._frameArmed = false;
      if (this._raf.length) this._armFrame();
      return;
    }
    this._frameDirty = false;
    void this._present(resized || frameDirty ? 'all' : this._damageFor());
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
    if (!rects) return 'all';
    const o = this.contentOrigin;
    return rects.map((r) => ({
      x: r.x + o.x,
      y: r.y + o.y,
      width: r.width,
      height: r.height,
    }));
  }

  async _present(damage) {
    if (this._destroyed) return;
    const vsync = await this.glctx.endFrame(damage);
    this._everPresented = true;
    this.wl.mapped = true;
    Promise.resolve(vsync).then(
      (t) => {
        this._frameArmed = false;
        this._fireRaf(t);
      },
      () => {
        this._frameArmed = false;
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
    const w = Math.max(1, Math.round(width / s + i.left + i.right));
    const h = Math.max(1, Math.round(height / s + i.top + i.bottom));
    if (this.isPopup) {
      this.wl.reposition(this.app.wmBase, {
        x: this.wl.x,
        y: this.wl.y,
        width: w,
        height: h,
      });
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

  attachDropTransport() {
    return this;
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
    this.app.makeCurrent();
    for (const ctx of this._contexts.values()) ctx.destroy?.();
    this._contexts.clear();
    this.glctx.destroy();
    this.app._forgetWindow(this);
    this.wl.destroy();
    this.emit('_destroyed');
  }
}
