// `<glarea>` on the Wayland backend: a viewport into the window's backing
// target, not a window of its own.
//
// On X11 a `<glarea>` is a child window — a separate drawable the X server
// stacks above the parent's drawing — and on the Cocoa backend a sublayer
// the WindowServer composites. Neither exists here. A Wayland client owns
// one buffer per surface, and a subsurface would be a second swapchain, a
// second frame clock and a second dma-buf import per frame for what is, on
// this backend, already one GL context drawing into one target. So the
// surface is a *rectangle of the backing target*: `makeCurrent()` binds the
// window's target with the viewport and scissor set to the area's rect, the
// app's GL calls land inside it, and `SwapBuffers()` is the note that the
// rect changed. The frame loop orders it — the tree's 2D paint is flushed
// under it, the area draws over, and the panes its children were painted
// on are composited over that (backendwindow.js `_runSurfaces`).
//
// What `GlAreaNode` (src/glnodes.js) needs is the child-"window" contract:
// `createWindow({ parent, … })` answering an object with
// `getContext('opengl', config)`, `setState(rect)`, `map()`, `destroy()`,
// `requestAnimationFrame`; and from the context `backend`, `ready`,
// `makeCurrent`, `SwapBuffers`, `canRender`, `onFrameAvailable`, plus the
// WebGL-shaped GL table itself. The table is the shared one, prototype-
// delegated as src/cocoa/glarea.js does it, with the entry points that name
// framebuffer coordinates — `viewport`, `scissor`, `bindFramebuffer`, and
// the scissor switch — re-based on the rect, so a scene written for a
// window of its own draws in its corner of ours.
//
// Two coordinate systems, as everywhere in this backend: the rect is in the
// window's content device pixels, y down; GL's viewport and scissor are in
// the target's pixels from the bottom-left. The content origin (the frame's
// insets) is added and y is flipped once, here, in `place()`.
//
// The pane (`WaylandOverlayPane`) is the other half of the same idea. The
// children of a `<glarea>` are 2D content drawn *above* its frames
// (src/gloverlay.js); on a backend that composites, one pane covers the
// surface and the backend blends it over the GL. Here a pane is an offscreen
// target the tree paints into during its flush, and the window draws it over
// the surface with `drawImage` once the surface has drawn — so a translucent
// legend, an antialiased edge or a shadow blends with the GL frame under it,
// as on the Cocoa backend and unlike X11's opaque child windows.

import { GLTarget } from './target.js';
import { WaylandContext2D } from './context2d.js';

/**
 * The `visual` `chooseGLConfig` answers with. `GlAreaNode` passes the config's
 * visual and depth straight back to `createWindow`, which is how the app
 * tells a `<glarea>`'s child "window" apart from a real one.
 */
export const GLAREA_VISUAL = 'wayland:glarea';

export class WaylandGLArea {
  /**
   * @param {import('./backendwindow.js').WaylandBackendWindow} parent
   * @param {{x?:number,y?:number,width?:number,height?:number}} options
   */
  constructor(parent, options = {}) {
    this.parent = parent;
    this.app = parent.app;
    this.destroyed = false;
    this.mapped = false;
    this._reactX11Node = null;
    this._context = null;
    this._listeners = new Map();
    /** set by `SwapBuffers` for the frame it happened in */
    this.drewThisFrame = false;
    this.rect = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: Math.max(1, options.width ?? 1),
      height: Math.max(1, options.height ?? 1),
    };
    parent._surfaces.add(this);
  }

  get width() {
    return this.rect.width;
  }

  get height() {
    return this.rect.height;
  }

  /** Geometry in content device pixels, the unit `GlAreaNode`'s rects are in. */
  setState(rect) {
    if (this.destroyed) return this;
    this.rect = {
      x: rect.x ?? this.rect.x,
      y: rect.y ?? this.rect.y,
      width: Math.max(1, rect.width ?? this.rect.width),
      height: Math.max(1, rect.height ?? this.rect.height),
    };
    return this;
  }

  move(x, y) {
    return this.setState({ x, y });
  }

  resize(width, height) {
    return this.setState({ width, height });
  }

  map() {
    this.mapped = true;
    return this;
  }

  unmap() {
    this.mapped = false;
    return this;
  }

  on(name, fn) {
    let set = this._listeners.get(name);
    if (!set) this._listeners.set(name, (set = new Set()));
    set.add(fn);
    return this;
  }

  off(name, fn) {
    this._listeners.get(name)?.delete(fn);
    return this;
  }

  emit(name, ev) {
    for (const fn of this._listeners.get(name) ?? []) fn(ev);
  }

  /**
   * The area's frame is a part of its window's: the callback runs after the
   * tree's paint, in the same frame, so what it draws goes over the 2D and
   * out with the same present.
   */
  requestAnimationFrame(fn) {
    return this.parent.requestSurfaceFrame(fn);
  }

  getContext(kind, config) {
    if (this.destroyed) return null;
    if (kind !== 'opengl' && kind !== 'gles' && kind !== 'webgl') return null;
    if (!this._context) this._context = createGLAreaContext(this, config);
    return this._context;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._context?._destroy();
    this._context = null;
    this.parent._surfaces.delete(this);
  }
}

/**
 * The `gl` a `<glarea>`'s `onDraw` receives: the shared WebGL-shaped table,
 * with this area's rect behind the entry points that would otherwise name
 * the whole target.
 */
function createGLAreaContext(area, config) {
  const parent = area.parent;
  const gl = parent.glctx.gl;
  const ctx = Object.create(gl);
  let destroyed = false;
  // the rect in the target's GL coordinates, as of the last makeCurrent
  let bx = 0;
  let by = 0;
  let bw = 1;
  let bh = 1;

  const place = () => {
    const o = parent.contentOrigin;
    const r = area.rect;
    const H = parent.glctx.backing?.height ?? 0;
    bx = o.x + r.x;
    bw = r.width;
    bh = r.height;
    by = H - (o.y + r.y + r.height);
  };

  ctx.backend = 'direct';
  ctx.config = config;
  ctx.glVersion = parent.glctx.glVersion;
  ctx.ready = Promise.resolve();
  ctx.onFrameAvailable = null;
  // No swapchain of its own to be held up by: the frame it draws in is the
  // window's, and the window's frame loop only runs it when there is one.
  ctx.canRender = () => !destroyed && !parent._destroyed;

  ctx.makeCurrent = () => {
    if (destroyed || parent._destroyed) return;
    parent.app.makeCurrent();
    parent.glctx.bindBacking();
    place();
    // The scissor is what keeps a `clear()` inside the rect. It stays on for
    // the whole draw: `disable(SCISSOR_TEST)` below re-asserts it.
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(bx, by, bw, bh);
    gl.viewport(bx, by, bw, bh);
  };

  ctx.viewport = (x, y, w, h) => gl.viewport(bx + x, by + y, w, h);

  // A scissor of the scene's own is cut to the rect: nothing it asks for
  // can reach outside, and `(0, 0, width, height)` is the whole of it.
  ctx.scissor = (x, y, w, h) => {
    const x0 = Math.max(bx, bx + x);
    const y0 = Math.max(by, by + y);
    const x1 = Math.min(bx + bw, bx + x + w);
    const y1 = Math.min(by + bh, by + y + h);
    gl.scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
  };

  ctx.disable = (cap) => {
    if (cap === gl.SCISSOR_TEST) {
      gl.scissor(bx, by, bw, bh);
      return;
    }
    gl.disable(cap);
  };

  // WebGL's "null means the default framebuffer" — and this surface's
  // default is the window's backing target, not GL's framebuffer zero,
  // which here is the swapchain buffer the 2D never draws into. A scene
  // that renders through its own FBO and unbinds at the end lands back on
  // the window (the SSAA pattern, the shadow-map pattern).
  ctx.bindFramebuffer = (target, fb) => {
    gl.bindFramebuffer(
      target,
      fb == null ? (parent.glctx.backing?.fbo ?? null) : fb,
    );
  };

  // The frame is in the target already; what a swap means here is "this
  // rect changed", for the present's damage and for the panes to be drawn
  // over it again.
  ctx.SwapBuffers = () => {
    if (destroyed) return;
    area.drewThisFrame = true;
    parent._surfaceDrew(area);
  };

  ctx._destroy = () => {
    destroyed = true;
  };
  // `GlAreaNode.destroySubtree` calls `gl.destroy?.()` before the window's
  ctx.destroy = ctx._destroy;

  return ctx;
}

/**
 * The pane a `<glarea>`'s children are drawn on: an offscreen target with a
 * 2d context of its own, painted by the tree inside the window's flush and
 * blended over the surface by the window's frame loop.
 *
 * It speaks the verbs the overlay drives (src/gloverlay.js `Pane`):
 * `setState`, `map`, `unmap`, `getContext`, `present`, `destroy`. The
 * context is handed out *inside a frame* — `begin()` has been called — so
 * the overlay can draw at once, as it does on the other backends where a
 * context has no frame; `present()` closes that frame and opens the next.
 */
export class WaylandOverlayPane {
  /**
   * @param {import('./app.js').WaylandApp} app
   * @param {{parent:object,x?:number,y?:number,width?:number,height?:number}} options
   */
  constructor(app, options) {
    this.app = app;
    this.parent = options.parent;
    this.destroyed = false;
    this.hidden = false;
    /** something has been painted on it: before that there is nothing to composite */
    this.presented = false;
    this.rect = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: Math.max(1, options.width ?? 1),
      height: Math.max(1, options.height ?? 1),
    };
    this.target = null;
    this._ctx = null;
    this.parent._panes.add(this);
  }

  get width() {
    return this.rect.width;
  }

  get height() {
    return this.rect.height;
  }

  /** Geometry in content device pixels. A new size is a new (cleared) target
   * and the overlay repaints it whole (`Pane.place` says so). */
  setState(rect) {
    if (this.destroyed) return this;
    const resized =
      rect.width !== this.rect.width || rect.height !== this.rect.height;
    this.rect = { ...rect };
    if (resized && this.target) {
      this.app.makeCurrent();
      this.target.resize(this.rect.width, this.rect.height);
      this.presented = false;
      this._ctx?.begin(this.target.width, this.target.height);
      this.app.rebindWindowTarget();
    }
    return this;
  }

  map() {
    this.hidden = false;
    return this;
  }

  unmap() {
    this.hidden = true;
    return this;
  }

  /** `Pane` listens for 'draw' — pixels lost to a resize. A target's are
   * lost too, and `Pane.place` already repaints whole on a size change. */
  on() {
    return this;
  }

  getContext(kind = '2d') {
    if (kind !== '2d' || this.destroyed) return null;
    if (!this._ctx) {
      this.app.makeCurrent();
      this.target = new GLTarget(this.app.gl, {
        width: this.rect.width,
        height: this.rect.height,
        stencil: true,
      });
      this._ctx = new WaylandContext2D(this.app.gl, {
        fontManager: this.app.fonts,
        target: this.target,
      });
      this._ctx.init();
      this._ctx.begin(this.target.width, this.target.height);
      // the window's own context is mid-frame; its target goes back
      this.app.rebindWindowTarget();
    }
    return this._ctx;
  }

  /** What was painted is complete; the window blends it over the surface
   * in this frame. The next paint finds the context open again. */
  present() {
    if (this.destroyed || !this._ctx) return;
    this.app.makeCurrent();
    this._ctx.end();
    this.presented = true;
    this.parent._paneDrew(this);
    this._ctx.begin(this.target.width, this.target.height);
    this.app.rebindWindowTarget();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.parent._panes.delete(this);
    this.app.makeCurrent();
    this._ctx?.destroy();
    this._ctx = null;
    this.target?.destroy();
    this.target = null;
    this.app.rebindWindowTarget();
  }
}
