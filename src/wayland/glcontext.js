// Tier D: a GLES rendering context whose frames reach the compositor as
// dma-buf, with no pixels on the socket and no CPU rasterisation anywhere.
//
// The addon this leans on is misnamed by history. `x11-dri`'s `Gpu` is GBM +
// EGL + GLES on a DRM render node and never touches X — the X part of the
// package is the *presentation* half, DRI3 and Present, which is exactly the
// half Wayland replaces. So the accelerated backend costs a swapchain and
// nothing else; the GL context, the device selection and the buffer export
// are already there and already shared with the X11 backend.
//
// A frame here has three parts, and the middle one is the renderer's:
//
//   beginFrame()   bind the backing target at the window's buffer size
//   …the 2d context paints into it, partially, as it would into a pixmap…
//   endFrame()     copy what changed into the swapchain buffer, swap, and
//                  commit — with the configure ack and the frame request in
//                  that same commit
//
// The backing target (target.js) is what makes partial repaints correct on a
// rotating swapchain; see swapchain.js for why the copy is sized the way it
// is. It also means the window's EGL config needs no stencil bits of its own
// — the target carries them — though they are still requested, cheaply, for
// anything that draws straight at the swapchain (a `<glarea>`).

import { createRequire } from 'node:module';
import { WaylandSwapchain } from './swapchain.js';
import { GLTarget } from './target.js';

const require = createRequire(import.meta.url);

/**
 * One GPU context per pixel format, not one per surface.
 *
 * An EGL context is expensive — a device, a GBM device, a display, a config
 * scan — and every surface in an app wants the same one; sharing it also
 * means textures and programs are shared between surfaces, as they are
 * between canvases in a browser tab. The cost is that exactly one surface is
 * current at a time, which `beginFrame` takes care of.
 */
const gpuCache = new Map();

function requireDri() {
  try {
    return require('x11-dri');
  } catch (err) {
    throw new Error(
      'the accelerated backend needs the optional x11-dri addon, which is not installed',
      { cause: err },
    );
  }
}

export function sharedGpu(dri, { format, depthSize, stencilSize, devicePath }) {
  const key = `${format}|${depthSize}|${stencilSize}|${devicePath ?? ''}`;
  const existing = gpuCache.get(key);
  if (existing) return existing;
  let gpu;
  try {
    gpu = new dri.Gpu({
      format,
      depthSize,
      stencilSize,
      ...(devicePath ? { devicePath } : {}),
    });
  } catch (err) {
    throw new Error(
      `could not create a GPU context on ${devicePath ?? 'the default render node'}: ${err.message}`,
      {
        cause: err,
      },
    );
  }
  gpuCache.set(key, gpu);
  return gpu;
}

export class WaylandGLContext {
  /**
   * Build the context with nothing to await.
   *
   * Only `zwp_linux_dmabuf_v1` had to be bound asynchronously, and an app
   * binds it once at startup; the GPU context itself never needed the
   * compositor. React's commit phase cannot await, and that is where windows
   * are made.
   */
  static createSync({ conn, window, dmabuf, policy = {} }) {
    const dri = requireDri();
    const probe = dri.probe();
    if (probe.gbm !== true || probe.egl !== true || probe.gles !== true) {
      throw new Error(
        `this machine cannot render on the GPU: gbm=${probe.gbm}, egl=${probe.egl}, gles=${probe.gles}`,
      );
    }
    if (!dmabuf) {
      throw new Error(
        'this compositor does not advertise zwp_linux_dmabuf_v1, so GPU buffers cannot be handed to it',
      );
    }
    // Alpha by default: client-side decorations want rounded corners, and a
    // fully opaque window says so with `set_opaque_region` instead, which is
    // the cheaper signal anyway.
    const alpha = policy.alpha ?? true;
    const format = alpha ? dri.FORMAT.ARGB8888 : dri.FORMAT.XRGB8888;
    const gpu = sharedGpu(dri, {
      format,
      depthSize: policy.depthSize ?? 16,
      stencilSize: policy.stencilSize ?? 8,
      devicePath: policy.devicePath,
    });
    const chain = new WaylandSwapchain({
      surface: window.surface,
      dmabuf,
      gpu,
      dri,
      format,
      policy,
    });
    return new WaylandGLContext({
      conn,
      window,
      dri,
      gpu,
      chain,
      format,
      policy,
    });
  }

  /** The asynchronous form, for scripts that are not inside a React commit. */
  static async create({ conn, window, policy = {} }) {
    const dmabuf = await conn.bind('zwp_linux_dmabuf_v1');
    return WaylandGLContext.createSync({ conn, window, dmabuf, policy });
  }

  constructor({ conn, window, dri, gpu, chain, format, policy = {} }) {
    this.conn = conn;
    this.window = window;
    this.dri = dri;
    this.gpu = gpu;
    this.chain = chain;
    this.format = format;
    this.policy = policy;
    /** The GL entry points — WebGL-shaped and camelCase. */
    this.gl = gpu.gl;
    this.destroyed = false;
    /** the persistent pixels the renderer paints into */
    this.backing = null;
    this._surface = null;
    this._inFrame = false;
    this.lastFramePresented = false;

    chain.onError = (err) => {
      this.destroyed = true;
      window.emit('error', err);
    };
  }

  /** What the driver actually gave us, which can exceed what was asked for. */
  get glVersion() {
    return this.gpu.glVersion;
  }

  get features() {
    return this.gpu.features;
  }

  get width() {
    return this.backing?.width ?? 0;
  }

  get height() {
    return this.backing?.height ?? 0;
  }

  /**
   * Make the context current, size the swapchain and the backing target to
   * the window's buffer size, and bind the target for drawing.
   *
   * The size is taken from the window rather than passed in because the
   * compositor owns it: a configure may have landed between two frames, and
   * drawing at the old size would produce a buffer the compositor stretches.
   *
   * @returns {{width:number, height:number, resized:boolean}|null}
   */
  beginFrame() {
    if (this.destroyed) return null;
    const w = this.window.bufferWidth;
    const h = this.window.bufferHeight;
    const surface = this.chain.surfaceFor(w, h);
    this._surface = surface;
    this.gpu.makeCurrent(surface);
    let resized = false;
    if (!this.backing) {
      this.backing = new GLTarget(this.gl, {
        width: w,
        height: h,
        stencil: true,
      });
      resized = true;
    } else if (this.backing.width !== w || this.backing.height !== h) {
      // Contents are dropped: a resize relayouts and repaints everything
      // upstairs (listeners.js: `invalidate(true, null, 'resize')`).
      this.backing.resize(w, h);
      resized = true;
    }
    this.backing.bind();
    this._inFrame = true;
    return { width: w, height: h, resized };
  }

  /**
   * Route GL draws at the backing target again — for a `<glarea>` that bound
   * its own framebuffer in between, or anything else that touched the
   * binding.
   */
  bindBacking() {
    this.backing?.bind();
  }

  /**
   * Finish the frame, hand it over, and hand back the frame clock.
   *
   * Pacing is owned here rather than by the caller because the two have to be
   * atomic and the failure is silent if they are not. A `wl_surface.frame`
   * request is only *delivered* by a commit, so a loop that asks for the
   * callback and then discovers it has nothing to present — every buffer
   * still held by the compositor, which is a normal thing to happen — waits
   * forever on a callback the compositor was never told to schedule. That
   * deadlock is what this method exists to make unrepresentable: the request
   * goes out with the commit, and when there is no frame to show, an empty
   * commit delivers it anyway so the clock keeps ticking and the next frame
   * gets its turn.
   *
   * @param {Array<{x,y,width,height}>|'all'} [damage] what the frame changed,
   *   in buffer coordinates. Defaults to everything.
   * @returns {Promise<Promise<number>>} awaiting the outer promise waits for
   *   the frame to be committed; awaiting the inner one waits for the
   *   compositor to say it is time to draw again.
   */
  async endFrame(damage = 'all') {
    // Always a promise for the frame clock, even when there is no frame:
    // callers chain off it unconditionally.
    if (this.destroyed || !this._inFrame)
      return Promise.resolve(Promise.resolve(0));
    this._inFrame = false;
    const gl = this.gl;
    const win = this.window;

    // The copy: backing -> the swapchain's back buffer, sized by what the
    // next buffer might be missing. Then the GPU work is settled (optionally
    // through a fence rather than a stall) before the swap hands it over.
    const rects = this.chain.blitHint(damage);
    this.backing.blitTo(
      null,
      rects === 'all' ? null : rects,
      this.chain.width,
      this.chain.height,
    );
    await this._settleGpu();

    // Queued before anything that commits, so one commit carries the frame
    // request, the configure ack, and the buffer.
    const vsync = win.scheduleFrame();
    win.ackPending();
    const presented = await this.chain.swap(damage);
    // `swap` attached and damaged but did not commit; and when nothing went
    // out — every buffer busy — the frame request still needs a commit to be
    // delivered. Either way, exactly one commit.
    if (!this.destroyed) win.surface.$.commit();
    if (presented) win.mapped = true;
    this.lastFramePresented = presented;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return vsync;
  }

  /**
   * Wait for the GPU to finish this frame *without* blocking the thread.
   *
   * `eglSwapBuffers` inside `Surface.swap()` waits for the frame's commands
   * to complete, and that wait is a hard stall of the JS thread — measured at
   * ~10ms per frame on this machine's virtio-gpu, and size-independent, so it
   * is round-trip latency to the host rather than fill rate. A stalled thread
   * is a thread not reading input or protocol events.
   *
   * A fence turns that stall into something the event loop can interleave
   * with: signal after the draw commands, then poll with a zero timeout,
   * yielding between polls so input and Wayland events get their turn. The
   * work takes just as long — this trades a blocked thread for a busy one
   * (measured: −0.9% frame rate) — so it is off by default and
   * `glPolicy: { fence: true }` turns it on where responsiveness matters more
   * than a core.
   */
  async _settleGpu() {
    if (!this.policy?.fence) return;
    const gl = this.gl;
    if (!this.gpu.features?.sync) return;
    let sync;
    try {
      sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    } catch {
      return;
    }
    if (!sync) return;
    gl.flush();
    try {
      for (let spins = 0; spins < 10000; spins++) {
        const r = gl.clientWaitSync(sync, 0, 0);
        if (r === gl.ALREADY_SIGNALED || r === gl.CONDITION_SATISFIED) return;
        if (r !== gl.TIMEOUT_EXPIRED) return;
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      gl.deleteSync(sync);
    }
  }

  canRender() {
    return this.chain.canRender();
  }

  set onReady(fn) {
    this.chain.onReady = fn;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this._surface) {
      try {
        this.gpu.makeCurrent(this._surface);
        this.backing?.destroy();
      } catch {
        /* context already gone */
      }
    }
    this.backing = null;
    this.chain.destroy();
    // The Gpu is shared; it outlives any one context.
  }
}
