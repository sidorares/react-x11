// <glarea>: the one drawn element that owns a real X window.
//
// GLX needs a drawable created for a GL-capable visual, and GL output cannot
// share the parent window's XRender pipeline — so this is a child X window
// (NEXT_STEPS §4), sized and positioned by the parent's yoga layout like any
// other drawn node. Everything about the surface is here; the scene graph
// that draws into it comes later (docs/glx-plan.md).
import { cssColorStraight } from 'ntk';

// re-exported so the GL element layer stays one import for consumers
export { directGLFailure, hasDirectGL } from './glbackend.js';

import { Node } from './nodes.js';

// One visual query per (app, spec): GetFBConfigs is a round trip and every
// <glarea> in an app wants the same answer.
const configCache = new WeakMap();

// Whether GL setup has already been found impossible on this connection.
// Every reason it fails — no GLX extension, indirect GLX disabled, no
// matching visual — is a property of the X server, not of one surface, so
// the first <glarea> to find out saves the rest from asking, so a second
// surface can report `onError` on its first frame instead of showing an
// empty box for the round trip it would otherwise take.
const glxFailures = new WeakMap();

/** The error that made GL unavailable on `app`, or null if all is well (or
 * not yet known). Carries ntk's `code` — see `GLXError`. */
export function glxFailure(app) {
  return (app && glxFailures.get(app)) || null;
}

function recordGlxFailure(app, err) {
  if (app && err && !glxFailures.has(app)) glxFailures.set(app, err);
}

/**
 * The visual and depth to create the GL child window with.
 *
 * `chooseGLConfig` answers for whichever backend ntk's `glPolicy` selected
 * and tags the result with `backend`; it is the newer name and the one to
 * prefer, because asking the older `chooseGLXConfig` would pin the surface to
 * indirect GLX no matter what the policy says. The fallback keeps `<glarea>`
 * working on an ntk that predates the direct backend.
 */
export function glxConfig(app, spec) {
  const key = JSON.stringify(spec ?? null);
  let perApp = configCache.get(app);
  if (!perApp) configCache.set(app, (perApp = new Map()));
  let promise = perApp.get(key);
  if (!promise) {
    if (typeof app.chooseGLConfig === 'function') {
      promise = app.chooseGLConfig(spec);
    } else if (typeof app.chooseGLXConfig === 'function') {
      promise = app
        .chooseGLXConfig(spec)
        .then((config) => ({ backend: 'indirect', ...config }));
    } else {
      promise = Promise.reject(
        new Error(
          'react-x11: <glarea> needs ntk >= 3.6.0 (app.chooseGLConfig)',
        ),
      );
    }
    perApp.set(key, promise);
  }
  return promise;
}

/**
 * clearColor as a CSS string or an [r, g, b, a] float tuple.
 *
 * Straight alpha, not premultiplied: this goes to `glClearColor`, and GL
 * takes unassociated components. ntk's `cssColor` premultiplies for XRender,
 * which would darken any translucent clear colour.
 */
function clearColorOf(props) {
  const value = props.clearColor ?? 'black';
  if (Array.isArray(value)) return value.length === 4 ? value : [...value, 1];
  const parsed = cssColorStraight(value);
  return parsed ?? [0, 0, 0, 1];
}

const px = (v) => Math.max(1, Math.round(v || 0));

/**
 * `<glarea>` — an OpenGL surface in the layout.
 *
 * ```jsx
 * <glarea flexGrow={1} clearColor="#0b1021" frameLoop="always"
 *         onDraw={(gl, { width, height }) => { ... }} />
 * ```
 *
 * Props: layout props as usual, plus
 * - `onDraw(gl, { width, height, node })` — draw a frame. The viewport and
 *   the clear are already done; `SwapBuffers` follows.
 * - `onCreated(gl, { width, height, node })` — once, when the context is
 *   current: one-time GL state (`Enable(DEPTH_TEST)`, display lists).
 * - `clearColor` — CSS colour or `[r, g, b, a]` floats (default black).
 * - `frameLoop` — `'demand'` (default: redraw on prop/size/expose changes)
 *   or `'always'` (drive ntk's frame clock continuously).
 * - `glx` — a `chooseGLXConfig` spec, e.g. `{ DEPTH_SIZE: 24 }`.
 *
 * The X child window is stacked above everything drawn in the parent, so 2D
 * content cannot overlap it — put HUD content in a sibling `<popup>`.
 */
export class GlAreaNode extends Node {
  constructor(props, app) {
    super('glarea', props, app);
    this.window = null;
    this.gl = null;
    this.rect = null; // geometry last sent to the X window
    this._realizing = false;
    this._frameScheduled = false;
    this._created = false;
    this._pointerDirty = true;
  }

  get isGlArea() {
    return true;
  }

  _setRoot(root) {
    super._setRoot(root);
    // the owning window may already exist (a <glarea> mounted into a live
    // tree); otherwise WindowNode.realize picks the subtree up
    if (root?.window) this.realize();
  }

  /** Create the GL child window. Async: the visual comes from the server. */
  realize() {
    if (this.window || this.destroyed || this._realizing) return;
    const parent = this.root?.window;
    if (!parent || typeof this.app?.createWindow !== 'function') return;
    // asked and answered — and whoever asked first already reported it
    const known = glxFailure(this.app);
    if (known) return this._failed(known, { reported: true });
    this._realizing = true;
    glxConfig(this.app, this.props.glx).then(
      (config) => {
        this._realizing = false;
        if (this.destroyed || this.window) return;
        // getContext() throws rather than rejects when the display has no
        // GLX at all, and a throw in here would escape as an unhandled
        // rejection instead of reaching onError
        try {
          this._create(config, parent);
        } catch (err) {
          this._failed(err);
        }
      },
      (err) => {
        this._realizing = false;
        this._failed(err);
      },
    );
  }

  /**
   * GL is not available: report it once, and give up the X child window if
   * one was created. It would otherwise sit over this rect as an unpainted
   * hole, hiding whatever the fallback draws in its place.
   *
   * `reported` means ntk has already written the diagnosis to the console —
   * it does that for a failed context, and its message is the better one.
   */
  _failed(err, { reported = false } = {}) {
    this._realizing = false;
    if (this.error) return;
    this.error = err;
    recordGlxFailure(this.app, err);
    this.gl = null;
    if (this.window) {
      this.window.destroy?.();
      this.window = null;
      this.rect = null;
    }
    if (this.props.onError) this.props.onError(err);
    else if (!reported) {
      console.warn(`react-x11: <glarea> has no GL surface: ${err.message}`);
    }
  }

  _create(config, parent) {
    const rect = this._geometry();
    const wnd = this.app.createWindow({
      parent,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      visual: config.visual,
      depth: config.depth,
      // GL draws into the window itself: no 2d backing pixmap, and the
      // frame clock is ours to drive
      backingStore: false,
      // The wheel, and only the wheel. A GL surface owns a real X window, so
      // the pointer events over it are delivered *there* rather than to the
      // window the rest of the tree is hit-tested in — which is why nothing
      // over a `<glarea>` reached an application before. Selecting it here
      // and handing it back to the owning window's manager (`_onWheel`
      // below) is the whole of it: from there the event is an ordinary
      // synthetic `Wheel` at this node, so it bubbles, `preventDefault()`
      // takes it back for a scene that zooms instead, and the default action
      // scrolls the nearest container the way it does anywhere else.
      //
      // Selected unconditionally rather than when a handler is declared: the
      // default action is what a reader expects from a wheel over a page,
      // and an element that wants it back has `preventDefault()`. One
      // ButtonPress per notch is not a cost worth a conditional.
      onWheel: (ev) => this._onWheel(ev),
    });
    this.window = wnd;
    this.rect = rect;
    this.config = config;
    wnd._reactX11Node = this;
    this.gl = wnd.getContext('opengl', config);
    // a buffer freed by the display is a frame that can be drawn again
    if (typeof this.gl?.onFrameAvailable !== 'undefined') {
      this.gl.onFrameAvailable = () => this.requestFrame();
    }
    // The context is only usable once MakeCurrent has answered, and that is
    // where a server refusing indirect GLX says so (ntk gives the rejection
    // an err.code — see GLXError). Nothing here awaits it: GL calls queue
    // until the tag arrives, so this only has to catch the failure.
    this.gl?.ready?.catch((err) => {
      if (!this.destroyed) this._failed(err, { reported: true });
    });
    wnd.on?.('expose', () => this.requestFrame());
    wnd.map?.();
    this.requestFrame();
  }

  _geometry() {
    return {
      x: Math.round(this.abs.x),
      y: Math.round(this.abs.y),
      width: px(this.abs.width),
      height: px(this.abs.height),
    };
  }

  absolutize(originX, originY) {
    super.absolutize(originX, originY);
    this._syncGeometry();
  }

  // the scroll fast path moves `abs` without coming through absolutize
  // (issue #405), and the real X window has to follow it all the same
  _shiftAbs(dx, dy) {
    super._shiftAbs(dx, dy);
    this._syncGeometry();
  }

  _syncGeometry() {
    const wnd = this.window;
    if (!wnd) return;
    const rect = this._geometry();
    const prev = this.rect;
    if (
      prev &&
      prev.x === rect.x &&
      prev.y === rect.y &&
      prev.width === rect.width &&
      prev.height === rect.height
    ) {
      return;
    }
    this.rect = rect;
    if (typeof wnd.setState === 'function') wnd.setState(rect);
    else {
      wnd.move?.(rect.x, rect.y);
      wnd.resize?.(rect.width, rect.height);
    }
    this.requestFrame();
  }

  /** Draw one frame on the child window's next frame tick. */
  requestFrame() {
    if (!this.window || this.destroyed || this._frameScheduled) return;
    this._frameScheduled = true;
    const schedule =
      typeof this.window.requestAnimationFrame === 'function'
        ? (cb) => this.window.requestAnimationFrame(cb)
        : (cb) => setImmediate(cb);
    schedule(() => {
      this._frameScheduled = false;
      this._drawFrame();
    });
  }

  _drawFrame() {
    const gl = this.gl;
    if (!gl || this.destroyed) return;
    const direct = gl.backend === 'direct';
    // On the direct backend every buffer may still be held by the display,
    // and drawing into one before it comes back would paint what is on
    // screen. `onFrameAvailable` asks for this frame again when one frees.
    if (direct && gl.canRender && !gl.canRender()) return;
    // binds this surface — the GPU context is shared between every <glarea>
    // on the connection — and picks up a resize
    gl.makeCurrent?.();

    const { width, height } = this.rect;
    // x/y are where the node's origin sits in the drawable being drawn
    // into (DrawInfo's contract) — a <glarea> draws into its own X window,
    // so that is the origin.
    const info = { width, height, x: 0, y: 0, node: this };
    if (!this._created) {
      this._created = true;
      this.props.onCreated?.(gl, info);
    }
    const [r, g, b, a] = clearColorOf(this.props);
    // The two backends spell GL differently — PascalCase OpenGL 1.x against
    // camelCase ES 2 — and neither pretends to be the other, so the handful
    // of calls this element makes itself are written both ways.
    if (direct) {
      gl.viewport(0, 0, width, height);
      gl.clearColor(r, g, b, a);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    } else {
      gl.Viewport(0, 0, width, height);
      gl.ClearColor(r, g, b, a);
      gl.Clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
    this.props.onDraw?.(gl, info);
    gl.SwapBuffers();
    if (this.props.frameLoop === 'always') this.requestFrame();
  }

  /**
   * A wheel over the surface, handed to the window the tree lives in.
   *
   * ntk reports the position inside *this* window; the manager hit-tests in
   * the owning window's space, so the node's own origin goes back on. Both
   * are device pixels — the scale is applied at the far end, where a handler
   * reads `ev.x` (src/events.js).
   *
   * Smooth deltas are not part of this yet: XI2 is selected on the window
   * the manager owns, not on this child, so a touchpad's fractions arrive
   * here as whole notches from buttons 4-7.
   */
  _onWheel(native) {
    const events = this.root?.events;
    if (!events || this.destroyed) return;
    events._onWheel(
      {
        ...native,
        x: (native.x ?? 0) + this.abs.x,
        y: (native.y ?? 0) + this.abs.y,
      },
      // named rather than hit-tested: a window-owning child is not in its
      // parent's paint order, so the hit test would answer with the box
      // behind this surface
      this,
    );
  }

  applyProps(newProps, oldProps) {
    super.applyProps(newProps, oldProps);
    // onDraw/clearColor are read at frame time, so any update is a new frame
    this.requestFrame();
  }

  setHidden(hidden) {
    super.setHidden(hidden);
    if (hidden) this.window?.unmap?.();
    else this.window?.map?.();
  }

  // the child window covers this rect: nothing to paint into the parent's
  // 2d context, and no drawn children are allowed under it
  paint() {}

  destroySubtree() {
    if (this.destroyed) return;
    super.destroySubtree();
    this.gl?.destroy?.();
    this.gl = null;
    this.window?.destroy?.();
    this.window = null;
  }
}
