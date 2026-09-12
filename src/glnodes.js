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

import { GlOverlay, canOverlay } from './gloverlay.js';
import { Node } from './nodes/node.js';
import { FramePacer, resolveFrameRate } from './pacing.js';

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
 * - `frameRate` — how the frames are paced when they are expensive
 *   (src/pacing.js): a preset, a cap, or the three numbers, the same
 *   vocabulary as `<window frameRate>`. Defaults to the owning window's.
 * - `glx` — a `chooseGLXConfig` spec, e.g. `{ DEPTH_SIZE: 24 }`.
 *
 * The X child window is stacked above everything drawn in the parent, so the
 * parent's 2D content cannot overlap it — but this node's own children do:
 * they are laid out in its box like a `<box>`'s and drawn above the surface,
 * on panes of their own (src/gloverlay.js).
 *
 * Pointer input over the surface is the tree's, on both backends: a press,
 * a drag or a wheel over it is a synthetic event at the child under the
 * pointer, or at this node, bubbling to its ancestors like anyone else's
 * (`hitSurface` says how).
 */
export class GlAreaNode extends Node {
  constructor(props, app) {
    super('glarea', props, app);
    this.window = null;
    // the panes the children are drawn on, while there are children
    this._overlay = null;
    this.gl = null;
    this.rect = null; // geometry last sent to the X window
    this._realizing = false;
    this._frameScheduled = false;
    this._created = false;
    this._pointerDirty = true;
    // The frame pacer (src/pacing.js), the surface's own: a scene's frames
    // are drawn on a clock of their own, and what one costs — `onDraw` and
    // the swap, on this thread — is what decides whether the next may
    // start at once. The policy is this element's `frameRate`, else the
    // owning window's, read at each request so a change on either follows.
    this._pacer = new FramePacer();
    this._ownPolicy = null;
    this._syncFramePolicy();
  }

  get isGlArea() {
    return true;
  }

  /** The policy this surface paces by: its own prop, else the window's. */
  _framePolicy() {
    if (this.props.frameRate !== undefined && this.props.frameRate !== null) {
      return this._ownPolicy;
    }
    return this.root?._framePolicy ?? this._pacer.policy;
  }

  _syncFramePolicy() {
    const value = this.props.frameRate;
    this._ownPolicy =
      value === undefined || value === null
        ? null
        : resolveFrameRate(value, '<glarea frameRate>');
  }

  _setRoot(root) {
    super._setRoot(root);
    // Children mounted along with this node — React builds a subtree before
    // it attaches it — are drawn from the first frame of the window it joins.
    if (this.children.length) root?._overlaid?.add(this);
    // the owning window may already exist (a <glarea> mounted into a live
    // tree); otherwise WindowNode.realize picks the subtree up
    if (root?.window) this.realize();
  }

  insertBefore(child, beforeChild) {
    super.insertBefore(child, beforeChild);
    // 2D content above the surface: the owning window's next frame gives it
    // a pane (`_syncOverlay`), and the child-list claim asks for that frame
    this.root?._overlaid?.add(this);
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
      // the children's panes stay, over whatever the fallback draws, and
      // stay hittable; with none, nothing of this node covers the rect
      if (!this._overlay) this._leaveSurfaces();
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
      // No pointer input is selected here, and that is the whole of how the
      // pointer over the surface reaches the tree. X reports a device event
      // to the first window up the hierarchy that selected it, so a press,
      // a motion or a wheel over this window arrives at the owning window
      // instead — in its coordinates and under its implicit grab, so a drag
      // that leaves the surface keeps coming — and its event manager takes
      // it from there like any other (`hitSurface` names this node).
      //
      // Selecting one here takes it away from the tree, which is how the
      // wheel alone used to be handled: the surface selected ButtonPress to
      // hear it and handed it back, and so every *press* on the surface
      // ended here too, with the drag and the release that should have
      // followed it. A listener on `node.window` does the same — ntk selects
      // what a window is listened to for — which is what `forwardsPointer`
      // exists to tell an element built on this one.
    });
    this.window = wnd;
    this.rect = rect;
    this.config = config;
    wnd._reactX11Node = this;
    // Above everything 2D in the owning window on both backends, and above
    // every surface made before this one: X stacks a new child window over
    // its siblings, and Core Animation a layer added later over one at the
    // same zPosition. The window's hit test reads the list in that order
    // (`EventManager._surfaceAt`).
    this._joinSurfaces();
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
    // made on top of its siblings — over the panes of children that were
    // laid out and painted before the visual query answered
    this._overlay?.restack();
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

  /**
   * Draw one frame on the child window's next frame tick — after whatever
   * wait the pacer asks for (src/pacing.js). Off by default it answers
   * "now"; under an adaptive policy a scene whose frames cost more than
   * their share of the thread is held between them, and a `frameLoop` of
   * `'always'` becomes a loop at the budget rather than at the display.
   */
  requestFrame() {
    if (!this.window || this.destroyed || this._frameScheduled) return;
    this._pacer.configure(this._framePolicy());
    if (this._pacer.defer(() => this._requestFrameNow())) return;
    this._requestFrameNow();
  }

  _requestFrameNow() {
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
    const pacer = this._pacer;
    pacer.began();
    let drawn = false;
    try {
      drawn = this._drawFrameNow();
    } finally {
      pacer.ended(undefined, drawn);
    }
    // after the frame is priced, so the loop's next frame is judged by
    // this one rather than by the one before
    if (drawn && this.props.frameLoop === 'always') this.requestFrame();
  }

  /** The frame itself; true when it drew. */
  _drawFrameNow() {
    const gl = this.gl;
    if (!gl || this.destroyed) return false;
    const direct = gl.backend === 'direct';
    // On the direct backend every buffer may still be held by the display,
    // and drawing into one before it comes back would paint what is on
    // screen. `onFrameAvailable` asks for this frame again when one frees.
    if (direct && gl.canRender && !gl.canRender()) return false;
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
    return true;
  }

  /**
   * `true`: pointer input over this surface is the tree's on this backend —
   * dispatched through the owning window's event manager, at this node, and
   * bubbling from it like anyone else's.
   *
   * It is here to be asked by an element built on `<glarea>` that listens on
   * `node.window` for the pointer, which it had to do before core delivered
   * it. That listener has to go wherever this is true: on X11 it selects the
   * event on the surface's own window, and X then delivers it *there*
   * instead of to the tree (see `_create`) — every press, and the wheel with
   * them, since both are ButtonPress.
   *
   * A getter on the class rather than a flag on each instance, so it can be
   * read without rendering anything: `GlAreaNode.prototype.forwardsPointer`,
   * from `react-x11/node`.
   */
  get forwardsPointer() {
    return true;
  }

  /**
   * What a point in the owning window's space lands on, if it is over this
   * surface: the child under it where there is one — the children are drawn
   * above the surface (src/gloverlay.js) — and otherwise this node.
   *
   * A point that is over the surface is over it whatever the tree's own
   * order says: X stacks the child window above the parent's drawing, and
   * the Cocoa backend puts the layer at a zPosition over both presenters. So
   * the window asks its surfaces before it hit-tests its tree
   * (`EventManager._hit`), and a point inside lands here rather than on the
   * box behind — which is all a tree walk can find, a window-owning node not
   * being in its parent's paint order. It is the same answer X gives: the
   * event it propagates to the owning window names this window, or a pane
   * over it, as the child the pointer is in.
   *
   * The rect is the surface's own, in whole pixels, since the server decides
   * by those. With no GL surface — not made yet, or given up after
   * `onError` — only the children answer, and a point between them is the
   * tree's. Hidden, or `pointerEvents: 'none'` here or above, lets the
   * pointer through to what the tree has behind, as it does for any node.
   */
  hitSurface(x, y) {
    const panes = this._overlay?.panes.length ?? 0;
    if (!this.window && panes === 0) return null;
    const rect = this.rect ?? this._geometry();
    if (
      x < rect.x ||
      y < rect.y ||
      x >= rect.x + rect.width ||
      y >= rect.y + rect.height
    ) {
      return null;
    }
    for (let n = this; n; n = n.parent) {
      if (n.destroyed || n.hidden) return null;
      if (n.style?.display === 'none' || n.style?.pointerEvents === 'none') {
        return null;
      }
      if (n.isWindow) break;
    }
    if (panes !== 0) {
      // front to back, as the tree's own hit test walks a box's children
      const order = this.paintOrder();
      for (let i = order.length - 1; i >= 0; i--) {
        const hit = order[i].hitTest(x, y);
        if (hit) return hit;
      }
    }
    return this.window ? this : null;
  }

  /** Into the owning window's hit test, once: a GL window or a pane covers
   * the rect now (`EventManager._surfaceAt`). */
  _joinSurfaces() {
    const surfaces = this.root?._surfaces;
    if (surfaces && !surfaces.includes(this)) surfaces.push(this);
  }

  /** Out of the owning window's hit test: nothing covers the rect any more,
   * and what the tree has behind it answers again. */
  _leaveSurfaces() {
    const surfaces = this.root?._surfaces;
    const at = surfaces ? surfaces.indexOf(this) : -1;
    if (at !== -1) surfaces.splice(at, 1);
  }

  /**
   * The owning window's frame, after layout (`WindowNode._syncOverlays`):
   * panes for where the children are now. True when a pane was made,
   * resized or dropped — a paint the frame then owes.
   */
  _syncOverlay() {
    if (!this._overlay) {
      if (this.children.length === 0 || !canOverlay(this.app)) {
        this.root?._overlaid?.delete(this);
        return false;
      }
      this._overlay = new GlOverlay(this);
    }
    const changed = this._overlay.sync();
    if (this._overlay.panes.length) this._joinSurfaces();
    if (this.children.length === 0 && this._overlay.panes.length === 0) {
      this._overlay = null;
      this.root?._overlaid?.delete(this);
      if (!this.window) this._leaveSurfaces();
    }
    return changed;
  }

  /** …and the paint it owes them, with the frame's damage. */
  _paintOverlay(damage) {
    this._overlay?.paint(damage);
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    super.applyProps(newProps, oldProps);
    if (newProps.frameRate !== before.frameRate) this._syncFramePolicy();
    // onDraw/clearColor are read at frame time, so any update is a new frame
    this.requestFrame();
  }

  setHidden(hidden) {
    super.setHidden(hidden);
    if (hidden) this.window?.unmap?.();
    else this.window?.map?.();
    this._overlay?.setHidden(hidden);
  }

  // The surface covers this rect: nothing of this node is painted into the
  // parent's 2d context, and its children are painted above the surface on
  // panes of their own (src/gloverlay.js) rather than in the window's walk.
  paint() {}

  // …which is also why they are cut to its box: a pane never reaches past
  // the surface, and the hit test and the damage model have to agree with
  // the panes about where the children can be
  clipsChildren() {
    return true;
  }

  destroySubtree() {
    if (this.destroyed) return;
    this._leaveSurfaces();
    this.root?._overlaid?.delete(this);
    this._overlay?.destroy();
    this._overlay = null;
    super.destroySubtree();
    this._pacer.cancel();
    this.gl?.destroy?.();
    this.gl = null;
    this.window?.destroy?.();
    this.window = null;
  }
}
