// The backend object `createRoot({ backend: 'wayland' })` renders through.
//
// react-x11 has three of these — an ntk X connection, `src/cocoa/app.js`,
// and this — and the shape they share is the contract: an app makes windows
// and offscreen surfaces, owns the fonts and the clipboard, and routes input;
// a window hands out a 2d context and tells the renderer when it may paint;
// everything above `src/nodes/` is supposed not to know which one it got.
//
// All the asynchrony in a Wayland client lives in `open()`, on purpose.
// Binding a global needs the registry and the registry needs a round trip —
// but that is the only part of making a window that does, so it is done
// once here and `createWindow` is synchronous, which React's commit phase
// requires (windows are realised inside it).
//
// `X` is a stand-in, not an X connection. The renderer reaches
// `app.X.keycode2keysyms` for accelerators, `app.X.on('end')` to notice the
// connection going, and a few guarded properties; the stand-in answers
// those and nothing else, and the keysym table on it comes from the
// compositor's keymap (xkb.js).
//
// The long-term home for all of this is ntk, beside its `Window` and behind
// the same `App`/`Drawable` contracts — the RFC's open question 2. It lives
// here because that is where it can be read and run without vendoring a
// second copy of the toolkit.

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { WaylandConnection } from './connection.js';
import { WaylandSeat } from './seat.js';
import { WaylandBackendWindow } from './backendwindow.js';
import { WaylandSurface } from './surface.js';
import { InputRouter } from './input.js';
import { createWaylandClipboard } from './clipboard.js';
import { WaylandOutputs } from './outputs.js';
import { WaylandTextInput } from './textinput.js';
import { sharedGpu } from './glcontext.js';
import { TextShaper } from './text.js';
import { WaylandGLArea, WaylandOverlayPane, GLAREA_VISUAL } from './glarea.js';
import { setScaleForTests } from '../scale.js';

const require = createRequire(import.meta.url);

/** The X connection stand-in. */
class XStandIn extends EventEmitter {
  constructor(app) {
    super();
    this.setMaxListeners(0);
    this.app = app;
    this.keycode2keysyms = [];
    this._closing = false;
    // `_refreshScreenOrigin` and friends bail on a null root, which is right:
    // no Wayland client knows where it is on the screen.
    this.display = { screen: [{ root: null }], Render: null };
  }

  require(name) {
    throw new Error(
      `react-x11 (wayland): X.require('${name}') — there is no X server behind this app`,
    );
  }

  // Selections are the clipboard's business (src/wayland/clipboard.js); the
  // text controls' direct calls are accepted and routed there.
  SetSelectionOwner(_wid, atom) {
    void atom;
  }

  ChangeWindowAttributes() {}
  flush() {}
}

export class WaylandApp extends EventEmitter {
  constructor(conn, options) {
    super();
    this.setMaxListeners(0);
    this.conn = conn;
    this.options = options;
    this.backend = 'wayland';
    /** wl_surface id -> WaylandBackendWindow */
    this.windows = new Map();
    this.toplevels = [];
    this.seat = null;
    this.input = null;
    this.fonts = null;
    this.fontManager = null;
    this.clipboard = null;
    /** the seat's `zwp_text_input_v3`, or null where the compositor has none */
    this.textInput = null;
    this.compositor = null;
    this.wmBase = null;
    this.dmabuf = null;
    this.viewporter = null;
    this.fractionalScale = null;
    this.activation = null;
    /** the monitors, published into src/screens.js (outputs.js) */
    this.outputs = null;
    this.X = new XStandIn(this);
    this.display = this.X.display;
    this.gpu = null;
    this.gl = null;
    this._holder = null;
    this._currentSurface = null;
    /** the app-wide output scale the renderer lays out with */
    this.scale = 1;
    this._shaper = null;
    this.frameText = null;
  }

  static async open(options = {}) {
    const conn = await WaylandConnection.open({
      display: options.waylandDisplay ?? options.display,
      transport: options.transport,
    });
    const app = new WaylandApp(conn, options);
    conn.on('error', (err) => app.emit('error', err));
    conn.on('close', () => {
      app.X._closing = true;
      app.X.emit('end');
      app.emit('close');
    });

    app.compositor = await conn.require('wl_compositor');
    app.wmBase = await conn.require('xdg_wm_base');
    app.dmabuf = await conn.bind('zwp_linux_dmabuf_v1');
    app.viewporter = await conn.bind('wp_viewporter');
    app.fractionalScale = await conn.bind('wp_fractional_scale_manager_v1');
    app.activation = await conn.bind('xdg_activation_v1');
    // The scale session first, so the outputs have a per-monitor map to
    // fill; then the outputs, awaited like the X11 backend's Xinerama tier:
    // an auto-sized window clamps to a monitor synchronously inside
    // realize(), and the first window is laid out at whatever `app.scale`
    // says by then — which the densest output seeds (`noteScale`).
    setScaleForTests(app, app.scale, 'wayland');
    app.outputs = new WaylandOutputs(conn, app);
    await app.outputs.open();
    app.seat = await WaylandSeat.bind(conn);
    app.input = new InputRouter(app);
    app.clipboard = await createWaylandClipboard({
      conn,
      seat: app.seat.seat,
      serial: () => app.seat.lastSerial,
    });
    // The compositor's input method (textinput.js): enter/leave follow the
    // keyboard, and the windows keep it told about their focused field.
    app.textInput = await WaylandTextInput.create(app);

    const ntk = require('ntk');
    // `app.fonts` is the name the renderer reaches for (src/fonts.js): one
    // FontManager per connection, so a face registered by `loadFont` is
    // visible to every window and there is one glyph cache rather than two.
    app.fonts = new ntk.FontManager({ source: options.fontSource ?? 'system' });
    app.fontManager = app.fonts;
    app._shaper = new TextShaper(app.fonts);
    app.frameText = (text, size, weight) =>
      app._shaper.measureSync(text, { family: 'sans-serif', size, weight });

    // The GPU context is shared by every window and surface; make it now so
    // an offscreen surface created before the first window has one to use.
    const dri = require('x11-dri');
    app.dri = dri;
    app.gpu = sharedGpu(dri, {
      format: dri.FORMAT.ARGB8888,
      depthSize: options.glPolicy?.depthSize ?? 16,
      stencilSize: options.glPolicy?.stencilSize ?? 8,
      devicePath: options.glPolicy?.devicePath,
    });
    app.gl = app.gpu.gl;
    app._glCapsResolved = { direct: true };
    return app;
  }

  // ---- GL context plumbing ----------------------------------------------

  /**
   * Make the shared GL context current. Drawing into a render target needs
   * *a* current surface; any window's will do, and when there is none yet a
   * 1×1 holder surface stands in.
   */
  makeCurrent() {
    if (this._currentSurface) {
      try {
        this.gpu.makeCurrent(this._currentSurface);
        return;
      } catch {
        this._currentSurface = null;
      }
    }
    for (const w of this.windows.values()) {
      const s = w.glctx?.chain?.gbm;
      if (s) {
        this._currentSurface = s;
        this.gpu.makeCurrent(s);
        return;
      }
    }
    if (!this._holder) this._holder = this.gpu.createSurface(1, 1);
    this._currentSurface = this._holder;
    this.gpu.makeCurrent(this._holder);
  }

  /** After an offscreen render, put the window's backing target back. */
  rebindWindowTarget() {
    for (const w of this.windows.values()) {
      if (w._frameSize) {
        w.glctx.bindBacking();
        return;
      }
    }
  }

  // ---- windows ----------------------------------------------------------

  /**
   * Make a window. **Synchronous**, because `WindowNode.realize()` runs in
   * React's commit phase and calls `setTitle`/`getContext` on the result the
   * moment it has it. `overrideRedirect` makes it a popup, positioned by the
   * `x`/`y` the tree's anchoring computed, relative to its parent.
   */
  createWindow(attributes = {}) {
    // A `<glarea>`'s child "window" is a rect of its parent's backing target
    // (glarea.js); `chooseGLConfig` marked the visual so it can be told apart.
    if (attributes.visual === GLAREA_VISUAL) {
      if (!attributes.parent?.glctx) {
        throw new Error(
          'react-x11 (wayland): a <glarea> needs a window of this backend to draw into',
        );
      }
      return new WaylandGLArea(attributes.parent, attributes);
    }
    const win = new WaylandBackendWindow(this, attributes);
    this.windows.set(win.wl.surface.id, win);
    if (!win.isPopup) this.toplevels.push(win);
    win.on('_destroyed', () => this._forgetWindow(win));
    return win;
  }

  _forgetWindow(win) {
    if (this.windows.get(win.wl.surface.id) === win)
      this.windows.delete(win.wl.surface.id);
    const i = this.toplevels.indexOf(win);
    if (i >= 0) this.toplevels.splice(i, 1);
    if (win.glctx?.chain?.gbm === this._currentSurface)
      this._currentSurface = null;
  }

  windowById(id) {
    for (const w of this.windows.values()) if (w.id === id) return w;
    return null;
  }

  /**
   * The window a new window hangs off: the explicit parent the tree passed,
   * else the focused toplevel, else the one under the pointer, else the most
   * recent — a popup opens from an interaction, and one of those is where it
   * happened.
   */
  parentFor(attributes, { toplevelOnly = false } = {}) {
    const explicit = attributes.parent;
    if (explicit && (!toplevelOnly || !explicit.isPopup)) return explicit;
    if (toplevelOnly) return null;
    return (
      this.input?.focusWindow ??
      this.input?.pointerWindow ??
      this.toplevels[this.toplevels.length - 1] ??
      null
    );
  }

  /** Called by windows when an output scale changes, and by outputs.js. */
  noteScale() {
    // Until a window exists the outputs are the only word on the scale, and
    // the first window is laid out at whatever this says — so their
    // densest one seeds it. Once a window has heard its own, the windows'
    // is the truth: fractional-scale says 1.5 where `wl_output.scale`
    // rounds up to 2.
    let scale = this.windows.size === 0 ? (this.outputs?.maxScale ?? 1) : 1;
    for (const w of this.windows.values()) scale = Math.max(scale, w.wl.scale);
    if (scale !== this.scale) {
      this.scale = scale;
      setScaleForTests(this, scale, 'wayland');
      this.emit('scale', scale);
    }
  }

  /** Hook for the input router: a discrete event may want a paint now. */
  afterInput() {}

  // ---- app-level requests -------------------------------------------------

  createSurface(options) {
    return new WaylandSurface(this, options);
  }

  /**
   * What the machine can do, as a promise like the X11 and Cocoa answers
   * (src/glbackend.js chains on it): here the answer was settled when the
   * GPU context came up in `open()`.
   */
  async glCapabilities() {
    const caps = {
      direct: true,
      indirect: false,
      backend: 'gles',
      version: this.gpu?.glVersion?.string ?? null,
    };
    this._glCapsResolved = caps;
    return caps;
  }

  frameIntervalFor() {
    // The compositor paces us through `wl_surface.frame`, and nothing in
    // the shared renderer reads this (only the cocoa window does, to pace
    // itself). The refresh rate is known — `win.output.refreshRate`, from
    // the output's current mode — but an interval here would only invite a
    // second clock beside the compositor's.
    return 0;
  }

  findArgbVisual() {
    return { depth: 32 };
  }

  /**
   * What a `<glarea>` draws with: the window's own GLES context, into a rect
   * of its backing target (glarea.js). A promise, as the X11 and Cocoa
   * answers are — `GlAreaNode.realize` chains on it.
   *
   * `spec.api` is the `<glarea glx>` prop's rung: `'auto'` and `'gles'` are
   * this; `'gl'` (desktop GL) and `'webgpu'` are named so the ladder is
   * visible before it is built.
   */
  async chooseGLConfig(spec) {
    const mode = this.options.glPolicy?.mode ?? 'auto';
    if (mode === 'off') {
      const err = new Error(
        "glPolicy is 'off' on this connection, so no GL context is created at all",
      );
      err.code = 'GL_DISABLED';
      throw err;
    }
    if (mode === 'indirect') {
      const err = new Error(
        "glPolicy is 'indirect', which is GLX — there is no X server here to speak it to. Use 'auto' or 'direct'.",
      );
      err.code = 'GL_POLICY_INDIRECT';
      throw err;
    }
    const api = spec?.api ?? 'auto';
    if (api !== 'auto' && api !== 'gles') {
      const err = new Error(
        api === 'gl' || api === 'webgpu'
          ? `<glarea> api '${api}' is a named rung this backend has not built yet — today's rungs are auto, gles (GLES 3 on the window's own context)`
          : `<glarea> api '${api}' is not a rung — expected one of auto, gles, gl, webgpu.`,
      );
      err.code = 'GL_API_UNAVAILABLE';
      throw err;
    }
    return { backend: 'direct', api: 'gles', visual: GLAREA_VISUAL, depth: 32 };
  }

  /**
   * The pane a `<glarea>`'s children are drawn on (src/gloverlay.js): an
   * offscreen target the window blends over the surface, so the overlay is
   * translucent here as on the Cocoa backend. Having this at all is how the
   * overlay knows the backend composites.
   */
  createOverlayPane(attributes) {
    return new WaylandOverlayPane(this, attributes);
  }

  /**
   * Ask the compositor to activate a window. Stacking is the compositor's;
   * xdg-activation lets a client ask with a token from a recent interaction,
   * and the compositor decides whether the interaction was recent enough.
   */
  activate(win) {
    if (!this.activation || !win?.wl?.surface) return;
    const token = this.activation.$.get_activation_token();
    token.on('done', (value) => {
      this.activation.$.activate(value, win.wl.surface.id);
      token.$.destroy();
    });
    token.$.set_surface(win.wl.surface.id);
    if (this.seat.lastSerial)
      token.$.set_serial(this.seat.lastSerial, this.seat.seat.id);
    token.$.commit();
  }

  raiseWindow(win) {
    this.activate(win);
  }

  requestAttention() {
    // xdg-activation with a stale serial is exactly "attention, please":
    // compositors that support it mark the window rather than focusing it.
    const w = this.toplevels[0];
    if (w) this.activate(w);
    return 0;
  }

  cancelAttention() {}

  async close() {
    for (const w of [...this.windows.values()]) w.destroy();
    this.windows.clear();
    this.toplevels.length = 0;
    this.textInput?.destroy();
    this.input?.destroy();
    this.seat?.destroy();
    this.outputs?.destroy();
    if (this._holder) {
      try {
        this._holder.destroy();
      } catch {
        /* gone */
      }
      this._holder = null;
    }
    this.X._closing = true;
    this.conn.destroy();
  }
}

/** What `Reconciler.js` imports. */
export async function createWaylandApp(options = {}) {
  return await WaylandApp.open(options);
}
