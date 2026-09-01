// <glarea> on the Cocoa backend: GL into a CALayer, no X server anywhere.
//
// The shape mirrors the X11 direct path (ntk's renderingcontext_cgl) with
// the XQuartz-specific half swapped out: the same x11-dri CGL context and
// WebGL-shaped `gl` table, but instead of attaching to a window surface the
// X server exported, frames render into IOSurface-backed framebuffers
// (x11-dri `createTarget`) and present by handing the IOSurface's process-
// global id to the area's own sublayer (`setLayerContentsIOSurface`). Two
// targets alternate, like any swapchain; the WindowServer composites.
//
// What GlAreaNode needs from us is the child-"window" contract it already
// speaks (src/glnodes.js): `createWindow({ parent, … })` answering an
// object with `getContext('opengl', config)`, `setState(rect)`, `map()`,
// `destroy()`, `requestAnimationFrame`. On X11 that child is a real X
// window stacked above the parent's drawing; here it is a sublayer of the
// window's root layer with a high zPosition — the same "GL sits above the
// 2D" semantics, by the same mechanism the platform gives us.
//
// ## The API ladder
//
// `chooseGLConfig(spec)` honours `spec.api` (the `<glarea glx>` prop):
// `'auto'` and `'gl'` are this file — CGL, OpenGL 4.1 core on Metal, the
// zero-dependency rung that exists on every Mac. `'gles'` (ANGLE on Metal)
// and `'webgpu'` are named rungs that answer with what they would take,
// so the ladder is visible before it is built. Policy decides, the machine
// answers — the same rule the GL policy follows everywhere else.

const RUNGS = ['auto', 'gl'];
const KNOWN_RUNGS = ['auto', 'gl', 'gles', 'webgpu'];

let driPromise = null;
function loadDri() {
  if (!driPromise) {
    driPromise = import('x11-dri').then((m) => m.default ?? m);
  }
  return driPromise;
}

/**
 * The app-wide GL runtime: one CGL context shared by every `<glarea>`, the
 * way the X11 direct backend shares one GPU context per connection. Created
 * lazily by the first `chooseGLConfig` and kept on the app.
 */
export class CocoaGLRuntime {
  constructor(dri) {
    this.dri = dri;
    this.gl = dri.gl;
    this.ctx = new dri.apple.Context({
      alphaSize: 8,
      depthSize: 24,
      stencilSize: 8,
      doubleBuffer: false,
      profile: 'core',
    });
    this.ctx.makeCurrent();
    this.glVersion = this.ctx.glVersion;
    // frame pacing: how long a swap closes the canRender gate for. macOS
    // answers directly — XQuartz's RandR never could (x11-dri >= 0.6).
    const hz = dri.apple.refreshRate?.();
    this.frameInterval = hz ? 1000 / hz : 1000 / 60;
  }

  destroy() {
    this.ctx.destroy();
  }
}

/** Resolve the app's runtime, throwing the reason when there is none. */
export async function cocoaGLConfig(app, spec) {
  const mode = app.glPolicy?.mode ?? 'auto';
  if (mode === 'off') {
    const err = new Error(
      "glPolicy is 'off' on this connection, so no GL context is created at all",
    );
    err.code = 'GL_DISABLED';
    throw err;
  }
  if (mode === 'indirect') {
    const err = new Error(
      "glPolicy is 'indirect', which is GLX — the Cocoa backend has no X " +
        "server to speak it to. Use 'auto' (the default here) or 'direct'.",
    );
    err.code = 'GL_POLICY_INDIRECT';
    throw err;
  }
  const api = spec?.api ?? 'auto';
  if (!RUNGS.includes(api)) {
    const err = new Error(
      KNOWN_RUNGS.includes(api)
        ? `<glarea> api '${api}' is a named rung this backend has not ` +
            `built yet — today's rungs are ${RUNGS.join(', ')} (CGL, OpenGL ` +
            `4.1 core on Metal). 'gles' arrives with vendored ANGLE, ` +
            `'webgpu' with a wgpu bridge.`
        : `<glarea> api '${api}' is not a rung — expected one of ` +
            `${KNOWN_RUNGS.join(', ')}.`,
    );
    err.code = 'GL_API_UNAVAILABLE';
    throw err;
  }
  await resolveCocoaGLRuntime(app);
  return { backend: 'direct', api: 'gl' };
}

/**
 * One runtime per app, one probe per app: chooseGLConfig and
 * `app.glCapabilities()` share this promise, so two `<glarea>`s mounting in
 * the same commit cannot race two contexts into existence, and the settled
 * answer lands in `_glCapsResolved` either way — the property
 * `useSupports('shaders')` reads (src/glbackend.js).
 */
export function resolveCocoaGLRuntime(app) {
  if (!app._cocoaGLPromise) {
    app._cocoaGLPromise = loadDri()
      .then((dri) => {
        app._cocoaGL = new CocoaGLRuntime(dri);
        app._glCapsResolved = { direct: true };
        return app._cocoaGL;
      })
      .catch((cause) => {
        const err = new Error(
          '<glarea> on the Cocoa backend needs the x11-dri addon (the ' +
            'GPU/GL half); it did not load: ' +
            cause.message,
        );
        err.code = 'GL_NO_ADDON';
        app._glCapsResolved = { direct: false, reason: err };
        throw err;
      });
  }
  return app._cocoaGLPromise;
}

/**
 * The child-"window" a GlAreaNode owns here: one sublayer of the owning
 * window's root layer, above everything the 2D presenters put there.
 */
export class CocoaGLArea {
  constructor(app, options) {
    this.app = app;
    this.parent = options.parent;
    this._native = app._native;
    this.scale = this.parent.scale ?? app.scale ?? 1;
    this.destroyed = false;
    this._reactX11Node = null;
    this.onWheel = options.onWheel ?? null;
    this.layer = this._native.createLayer();
    this._native.addSublayer(this.parent._layer, this.layer);
    this.rect = null;
    this.setState({
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 1,
      height: options.height ?? 1,
    });
    this._context = null;
    this._listeners = new Map();
  }

  /** Geometry in device px, the unit GlAreaNode's rects are in. */
  setState(rect) {
    if (this.destroyed) return;
    this.rect = rect;
    const s = this.scale;
    this._native.setLayerProps(this.layer, {
      frame: [rect.x / s, rect.y / s, rect.width / s, rect.height / s],
      // above both presenters' content: the surface presenter's contents
      // live on the root layer itself, the layers presenter's visuals top
      // out at paintOrder zPositions — this clears either.
      zPosition: 1e7,
      // GL renders bottom-up and an IOSurface displays row 0 at the top;
      // mirroring the layer is the flip, applied where the compositor is
      // already transforming instead of in anyone's shader.
      transform: { scaleY: -1 },
      hidden: false,
    });
    this._context?._resized(rect.width, rect.height);
  }

  get width() {
    return this.rect?.width ?? 0;
  }

  get height() {
    return this.rect?.height ?? 0;
  }

  move(x, y) {
    this.setState({ ...this.rect, x, y });
  }

  resize(width, height) {
    this.setState({ ...this.rect, width, height });
  }

  map() {
    if (!this.destroyed) {
      this._native.setLayerProps(this.layer, { hidden: false });
    }
  }

  on(name, fn) {
    let set = this._listeners.get(name);
    if (!set) this._listeners.set(name, (set = new Set()));
    set.add(fn);
  }

  emit(name, ev) {
    for (const fn of this._listeners.get(name) ?? []) fn(ev);
  }

  requestAnimationFrame(cb) {
    return this.parent.requestAnimationFrame(cb);
  }

  getContext(kind, config) {
    if (kind !== 'opengl' || this.destroyed) return null;
    if (!this._context) {
      this._context = createGLAreaContext(this.app._cocoaGL, this, config);
    }
    return this._context;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._context?._destroy();
    this._context = null;
    this._native.removeFromSuperlayer(this.layer);
  }
}

/**
 * The `gl` a `<glarea>`'s onDraw receives: the shared WebGL-shaped table
 * with this area's swapchain behind it. Prototype-delegates to the table so
 * every entry point is present without copying; the own properties are the
 * per-area contract GlAreaNode drives (`backend`, `ready`, `makeCurrent`,
 * `SwapBuffers`, `canRender`, `onFrameAvailable`).
 */
function createGLAreaContext(runtime, area, config) {
  const native = area._native;
  const ctx = Object.create(runtime.gl);
  let front = null;
  let back = null;
  let width = 0;
  let height = 0;
  let gateClosed = false;
  let gateTimer = null;
  let destroyed = false;

  const ensureTargets = () => {
    const w = Math.max(1, area.rect?.width ?? 1);
    const h = Math.max(1, area.rect?.height ?? 1);
    if (front && width === w && height === h) return;
    front?.destroy();
    back?.destroy();
    front = runtime.ctx.createTarget(w, h);
    back = runtime.ctx.createTarget(w, h);
    width = w;
    height = h;
  };

  ctx.backend = 'direct';
  ctx.config = config;
  ctx.glVersion = runtime.glVersion;
  ctx.ready = Promise.resolve();
  ctx.onFrameAvailable = null;

  // On the direct backend every buffer may still be held by the display;
  // here the WindowServer reads the front IOSurface while we draw the back
  // one, so the honest gate is one display period per swap — the same
  // timer-reopened gate the XQuartz CGL flavor uses (no backpressure
  // exists on either).
  ctx.canRender = () => !destroyed && !gateClosed;

  ctx.makeCurrent = () => {
    if (destroyed) return;
    ensureTargets();
    runtime.ctx.bindTarget(back);
  };

  // WebGL's "null means the default framebuffer" — and this surface's
  // default is the back target's FBO, not GL's framebuffer zero, which on
  // a swapchain like this is nothing at all. A scene that renders through
  // its own FBO and unbinds at the end (the SSAA pattern) lands back here.
  ctx.bindFramebuffer = (target, fb) => {
    runtime.gl.bindFramebuffer(target, fb == null ? (back?.fbo ?? 0) : fb);
  };

  ctx.SwapBuffers = () => {
    if (destroyed || !back) return;
    runtime.gl.flush();
    native.setLayerContentsIOSurface(area.layer, back.iosurfaceId);
    const shown = back;
    back = front;
    front = shown;
    gateClosed = true;
    gateTimer = setTimeout(() => {
      gateTimer = null;
      gateClosed = false;
      ctx.onFrameAvailable?.();
    }, runtime.frameInterval);
    // the timer must not hold the process open for an idle scene
    gateTimer.unref?.();
  };

  ctx._resized = () => {
    // targets are rebuilt lazily on the next makeCurrent, so a resize
    // storm costs two allocations per drawn frame, not per notify
  };

  ctx._destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (gateTimer) clearTimeout(gateTimer);
    front?.destroy();
    back?.destroy();
    front = back = null;
  };

  return ctx;
}
