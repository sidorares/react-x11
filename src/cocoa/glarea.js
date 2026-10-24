// <glarea> on the Cocoa backend: GL into a CALayer, no X server anywhere.
//
// The shape mirrors the X11 direct path (ntk's renderingcontext_cgl) with
// the XQuartz-specific half swapped out: the same x11-dri CGL context and
// WebGL-shaped `gl` table, but instead of attaching to a window surface the
// X server exported, frames render into IOSurface-backed framebuffers
// (x11-dri `createTarget`) and present by handing the IOSurface's process-
// global id to the area's own sublayer (`setLayerContentsIOSurface`). Two
// targets alternate, like any swapchain — three while a worker's flip has
// yet to let go of the buffer it replaced; the WindowServer composites.
//
// What GlAreaNode needs from us is the child-"window" contract it already
// speaks (src/glnodes.js): `createWindow({ parent, … })` answering an
// object with `getContext('opengl', config)`, `setState(rect)`, `map()`,
// `unmap()`, `destroy()`, `requestAnimationFrame`. On X11 that child is a real X
// window stacked above the parent's drawing; here it is a sublayer of the
// window's root layer with a high zPosition — the same "GL sits above the
// 2D" semantics, by the same mechanism the platform gives us. The layer
// takes no input: pointer events are the NSWindow's, and the window's hit
// test answers the surface for a point over it (`GlAreaNode.hitSurface`),
// which is where X11's event propagation ends up too.
//
// ## The API ladder
//
// `chooseGLConfig(spec)` honours `spec.api` (the `<glarea glx>` prop):
// `'auto'` and `'gl'` are this file — CGL, OpenGL 4.1 core on Metal, the
// zero-dependency rung that exists on every Mac. `'gles'` (ANGLE on Metal)
// and `'webgpu'` are named rungs that answer with what they would take,
// so the ladder is visible before it is built. Policy decides, the machine
// answers — the same rule the GL policy follows everywhere else.

import { withoutActions } from './quiet.js';

const RUNGS = ['auto', 'gl'];
const KNOWN_RUNGS = ['auto', 'gl', 'gles', 'webgpu'];

/** Buffers a surface's chain may hold: the window presenter's
 *  `MAX_BUFFERS`. A scene drawn at the display's rate takes all four, since
 *  each buffer it retires is held for `HOLD_PERIODS` and a frame that
 *  presents late in its period retires its buffer late too; with three it
 *  waited for one, and a 120Hz scene ran at 80. */
const MAX_BUFFERS = 4;
/** How many display periods a buffer is taken to stay on glass after the
 *  flip that replaced it: the render server latches a flip at a vsync a
 *  period or two after the commit, and composites from the old buffer until
 *  then. Two buffers alternating at the display's rate drew into the one it
 *  was still reading — `IOSurfaceIsInUse` true at nine frames in ten — and
 *  now and then it composited that buffer half drawn: the scene's clear
 *  colour, over the whole surface, for a frame. A period was not enough
 *  either (one frame in seven). The window presenter asks
 *  `surfaceIsInUse`; these buffers are x11-dri's, which nothing asks yet. */
const HOLD_PERIODS = 1.5;
/** How long a worker's flip may take to report its release before the
 *  buffer it retired is drawn into anyway — the window presenter's
 *  `FENCE_TIMEOUT_MS`. */
const RELEASE_TIMEOUT_MS = 100;
/** A chain past two buffers gives the rest back after this long without a
 *  frame — the window presenter's `TRIM_AFTER_MS`. */
const TRIM_AFTER_MS = 1000;

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
    this.layer = withoutActions(this._native, () => {
      const layer = this._native.createLayer();
      this._native.addSublayer(this.parent._layer, layer);
      return layer;
    });
    this.rect = null;
    // Ours to keep, because every `setState` writes the layer's whole prop
    // set: a geometry change on a hidden surface must not show it again.
    this._hidden = false;
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
    this._setLayerProps({
      frame: [rect.x / s, rect.y / s, rect.width / s, rect.height / s],
      // above both presenters' content: the surface presenter's contents
      // live on the root layer itself, the layers presenter's visuals top
      // out at paintOrder zPositions — this clears either.
      zPosition: 1e7,
      // GL renders bottom-up and an IOSurface displays row 0 at the top;
      // mirroring the layer is the flip, applied where the compositor is
      // already transforming instead of in anyone's shader.
      transform: { scaleY: -1 },
      hidden: this._hidden,
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
    this._hidden = false;
    if (!this.destroyed) this._setLayerProps({ hidden: false });
  }

  /**
   * The other half of `map()`, which this surface went without: a layer is
   * composited by the WindowServer rather than painted by the window, so a
   * subtree going off the screen leaves it on screen over what replaced it.
   * X11 and Wayland unmap the surface's window for this; here the layer's
   * own `hidden` carries it.
   */
  unmap() {
    this._hidden = true;
    if (!this.destroyed) this._setLayerProps({ hidden: true });
  }

  /**
   * Everything this layer is handed goes out with Core Animation's implicit
   * actions off. The layer is ours, not a presenter's, so no frame's
   * transaction covers it, and a bare set animates each key for a quarter
   * of a second from wherever the layer was: the surface grew into place
   * at mount and trailed every step of a live resize. A present needs
   * nothing here — `setLayerContentsIOSurface` opens its own transaction
   * for the flip.
   */
  _setLayerProps(props) {
    const native = this._native;
    native.txBegin({ disableActions: true });
    try {
      native.setLayerProps(this.layer, props);
    } finally {
      native.txCommit();
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

  // on the owning window's clock, after its flush in the same tick (#641)
  requestAnimationFrame(cb) {
    return this.parent.requestSurfaceFrame(cb);
  }

  /**
   * The owning window's clock, asked where a gate of `interval` ms lands
   * on its grid (`CocoaWindow.nextFrameAt`) — the swap gate phase-locks to
   * it so the two do not stack. A parent with no clock (a bare stub in a
   * test) answers one interval from now, the old swap-relative wait.
   */
  nextFrameAt(interval) {
    return this.parent.nextFrameAt?.(interval) ?? performance.now() + interval;
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
    withoutActions(this._native, () =>
      this._native.removeFromSuperlayer(this.layer),
    );
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
  // The chain: every buffer this surface draws in, `{ target, released,
  // offGlassAt, unwatch }`. `front` is the one the last swap put on glass,
  // and `back` the one the frame being drawn goes into, from `makeCurrent`
  // to `SwapBuffers`.
  let buffers = [];
  let front = null;
  let back = null;
  let width = 0;
  let height = 0;
  // The moment the swap gate reopens, on the window clock's grid — not a
  // boolean a timer flips, so a frame that arrives a fraction of a
  // millisecond before its own timer still reads the true state.
  let gateOpenAt = -Infinity;
  let gateTimer = null;
  let releaseTimer = null;
  let trimTimer = null;
  let swappedAt = -Infinity;
  let destroyed = false;
  // The frame clock's time, which `canRender` is asked on and a hold is
  // counted on: the window's clock hands out the slot a frame was due at,
  // and a test drives it by hand. `skew` is how far it was from
  // `performance.now()` when it was last asked.
  let skew = 0;
  const clock = () => performance.now() + skew;

  const size = () => [
    Math.max(1, area.rect?.width ?? 1),
    Math.max(1, area.rect?.height ?? 1),
  ];

  const drop = (buffer) => {
    buffer.unwatch?.();
    buffer.target.destroy();
  };

  // A new size is a new chain, made a buffer at a time as frames take them.
  // Nothing of the old one is drawn into again, so nothing waits for it.
  const ensureTargets = () => {
    const [w, h] = size();
    if (width === w && height === h) return;
    for (const buffer of buffers) drop(buffer);
    buffers = [];
    front = back = null;
    width = w;
    height = h;
  };

  /**
   * Of the buffers off glass, the one a frame may draw in now: one the
   * flip that retired it has let go of, and of those the one off glass
   * longest, which the WindowServer has had longest to stop reading.
   * `'new'` while the chain has room for another. Past that, one whose
   * release is overdue. Else null: the frame waits for a release.
   */
  const freeBuffer = (now) => {
    const hold = runtime.frameInterval * HOLD_PERIODS;
    let free = null;
    let overdue = null;
    for (const buffer of buffers) {
      if (buffer === front) continue;
      if (buffer.released && now - buffer.offGlassAt >= hold) {
        if (!free || buffer.offGlassAt < free.offGlassAt) free = buffer;
      } else if (now - buffer.offGlassAt >= RELEASE_TIMEOUT_MS) {
        if (!overdue || buffer.offGlassAt < overdue.offGlassAt) {
          overdue = buffer;
        }
      }
    }
    if (free) return free;
    if (buffers.length < MAX_BUFFERS) return 'new';
    return overdue;
  };

  const takeBack = () => {
    const found = freeBuffer(clock());
    if (found && found !== 'new') return found;
    if (found === 'new') {
      const buffer = {
        target: runtime.ctx.createTarget(width, height),
        released: true,
        offGlassAt: -Infinity,
        unwatch: null,
      };
      buffers.push(buffer);
      return buffer;
    }
    // Asked to draw with nothing free — by a caller that did not ask
    // `canRender` first: the buffer off glass longest, which is the one a
    // chain of two always drew into.
    let oldest = null;
    for (const buffer of buffers) {
      if (buffer === front) continue;
      if (!oldest || buffer.offGlassAt < oldest.offGlassAt) oldest = buffer;
    }
    return oldest;
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
  //
  // One period *per frame*, though, not per swap: timed from the swap the
  // gate reopened at `slot + drawCost + period`, which overshoots the
  // window clock's next slot however cheap the frame, and the clock then
  // rounded it up to the slot after — two display periods, a 120Hz panel
  // pinned at 60fps whatever the scene cost (issue #631). Anchored to the
  // slot the frame was due at (`CocoaWindow.nextFrameAt`) the two gates
  // are on one grid: the clock cannot take a frame the gate would refuse,
  // because both are the same instant, and the gate still never lets two
  // frames into one period.
  //
  // And a period is not long enough to stay off the buffer the last flip
  // retired: the render server latches a flip a period or two after it is
  // committed, and reads the buffer it replaces until then — on a worker,
  // where the flip waits for the UI thread, until later still. A frame
  // drawn into it was now and then composited half drawn: the scene's
  // clear colour over the whole surface, for a frame, as a map settled
  // after a zoom. So a frame takes a buffer that has been off glass for
  // `HOLD_PERIODS` and, on a worker, released (`freeBuffer`), and the gate
  // is shut while there is none and no room in the chain for another.
  ctx.canRender = (now = performance.now()) => {
    skew = now - performance.now();
    if (destroyed || now < gateOpenAt) return false;
    const [w, h] = size();
    if (back || width !== w || height !== h || freeBuffer(now)) return true;
    armRelease();
    return false;
  };

  ctx.makeCurrent = () => {
    if (destroyed) return;
    ensureTargets();
    back ??= takeBack();
    runtime.ctx.bindTarget(back.target);
  };

  // WebGL's "null means the default framebuffer" — and this surface's
  // default is the back target's FBO, not GL's framebuffer zero, which on
  // a swapchain like this is nothing at all. A scene that renders through
  // its own FBO and unbinds at the end (the SSAA pattern) lands back here.
  ctx.bindFramebuffer = (target, fb) => {
    runtime.gl.bindFramebuffer(
      target,
      fb == null ? (back?.target.fbo ?? 0) : fb,
    );
  };

  /**
   * The buffer a worker's flip just took off glass is held until the bridge
   * says the flip applied (`surface-released`, windowkit/appkit#52) — the
   * window presenter's fence, for this surface's own buffers. The flip
   * happened then, so `HOLD_PERIODS` counts from then; a frame refused
   * meanwhile is asked for again once that is over.
   */
  const awaitRelease = (buffer) => {
    buffer.unwatch?.();
    buffer.released = false;
    buffer.unwatch = area.app.watchSurfaceRelease(
      buffer.target.iosurfaceId,
      () => {
        buffer.unwatch = null;
        buffer.released = true;
        buffer.offGlassAt = clock();
        if (!destroyed) armRelease();
      },
    );
  };

  // A frame refused for want of a buffer is asked for again when the first
  // one frees: its hold over, or its release overdue — a release that
  // never comes stops holding the frames after `RELEASE_TIMEOUT_MS`.
  let releaseDue = Infinity;
  const armRelease = () => {
    if (destroyed) return;
    const hold = runtime.frameInterval * HOLD_PERIODS;
    let due = Infinity;
    for (const buffer of buffers) {
      if (buffer === front) continue;
      const wait = buffer.released ? hold : RELEASE_TIMEOUT_MS;
      due = Math.min(due, buffer.offGlassAt + wait);
    }
    if (due === Infinity || (releaseTimer && releaseDue <= due)) return;
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseDue = due;
    releaseTimer = setTimeout(
      () => {
        releaseTimer = null;
        if (!destroyed) ctx.onFrameAvailable?.();
      },
      Math.max(1, Math.ceil(due - clock())),
    );
    releaseTimer.unref?.();
  };

  // A chain that grew past two gives the rest back once the surface has
  // gone `TRIM_AFTER_MS` without a frame: the buffers past two are what a
  // scene drawn at the display's rate needs, and a still one keeps what it
  // always had, the buffer on glass and one to draw the next frame in.
  const armTrim = () => {
    if (trimTimer || destroyed) return;
    trimTimer = setTimeout(() => {
      trimTimer = null;
      if (destroyed || buffers.length <= 2) return;
      if (clock() - swappedAt < TRIM_AFTER_MS) {
        armTrim();
        return;
      }
      const spare = buffers
        .filter((b) => b !== front && b !== back && b.released)
        .sort((a, b) => a.offGlassAt - b.offGlassAt)
        .slice(0, buffers.length - 2);
      for (const buffer of spare) drop(buffer);
      buffers = buffers.filter((b) => !spare.includes(b));
      // one still held keeps its place until its release comes
      if (buffers.length > 2) armTrim();
    }, TRIM_AFTER_MS);
    trimTimer.unref?.();
  };

  // A frame refused by the gate has nothing else to wake it, so the gate
  // says when it opens. `setTimeout` counts whole milliseconds and a
  // display period is rarely one (8.333 at 120Hz), so a timer that lands
  // early re-arms rather than announcing a gate that is still shut.
  const armGate = () => {
    if (gateTimer || destroyed) return;
    const wait = gateOpenAt - performance.now();
    gateTimer = setTimeout(
      () => {
        gateTimer = null;
        if (destroyed) return;
        if (performance.now() < gateOpenAt) armGate();
        else ctx.onFrameAvailable?.();
      },
      Math.max(1, Math.ceil(wait)),
    );
    // the timer must not hold the process open for an idle scene
    gateTimer.unref?.();
  };

  ctx.SwapBuffers = () => {
    if (destroyed || !back) return;
    runtime.gl.flush();
    native.setLayerContentsIOSurface(area.layer, back.target.iosurfaceId);
    const retired = front;
    front = back;
    back = null;
    swappedAt = clock();
    if (retired && retired !== front) {
      retired.offGlassAt = swappedAt;
      // A pump-mode flip is applied in the call; a worker's when the UI
      // thread gets to it, and until then `retired` is still on glass.
      if (area.app._threaded) awaitRelease(retired);
    }
    // one display period from the frame's slot, not from this moment
    gateOpenAt = area.nextFrameAt(runtime.frameInterval);
    armGate();
    if (buffers.length > 2) armTrim();
  };

  ctx._resized = () => {
    // targets are rebuilt lazily on the next makeCurrent, so a resize
    // storm costs one allocation per drawn frame, not per notify
  };

  ctx._destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (gateTimer) clearTimeout(gateTimer);
    if (releaseTimer) clearTimeout(releaseTimer);
    if (trimTimer) clearTimeout(trimTimer);
    for (const buffer of buffers) drop(buffer);
    buffers = [];
    front = back = null;
  };

  return ctx;
}
