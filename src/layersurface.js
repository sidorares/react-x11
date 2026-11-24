// A surface an element draws into and a layer shows as it is
// (`createLayerSurface`): what a canvas, a terminal or a chart on a socket
// is, when it draws every frame with a rasterizer of its own and would
// otherwise composite its pixels over its box a second time, in the
// window's bitmap, at every one.
//
// It is a sprite part's `contents` (docs/extending.md, "Parts of your
// drawing on layers of their own"), like a `VideoFrames` sink, and with the
// same contract: where the presenter lifts it, the layer shows each frame
// the moment `draw()` returns, with no frame of the window's own, and the
// element leaves a hole where it is; where it does not — another backend,
// a bridge without IOSurface surfaces, a part something is painted over —
// the element draws `surface` itself, with `ctx.drawImage`, which is the
// newest frame on every backend.
//
// On the surface presenter the frames are a ring of IOSurface-backed
// bitmaps (`app.createSharedSurface`): one on glass, one being drawn. A
// frame is drawn into one the render server has let go of, which starts as
// the frame before it, so an element that redraws only what changed draws
// only that; `{ full: true }` says it will draw every pixel, and nothing is
// carried over. Everywhere else it is one ordinary surface, drawn in place.
import { Surface } from './offscreen.js';

// One on glass, one being drawn, and one a flip is still taking off glass.
const RING_MAX = 4;
const MAX_SIDE = 8192;

export class LayerSurface {
  constructor(app, { width, height } = {}) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > MAX_SIDE ||
      height > MAX_SIDE
    ) {
      throw new TypeError(
        'react-x11: createLayerSurface: width and height are the size in ' +
          `whole device pixels, 1 to ${MAX_SIDE} (got ${width}x${height})`,
      );
    }
    this.app = app;
    this.width = width;
    this.height = height;
    this.version = 0;
    this.closed = false;
    this.ring = [];
    this.current = null; // the newest frame
    this._listeners = new Set();
    // an app that makes surfaces a layer can show; null elsewhere
    this._shared = typeof app?.createSharedSurface === 'function';
    this._single = null;
  }

  /** The newest frame, drawn with `ctx.drawImage(layer.surface, x, y)`: null
   *  before the first `draw()`. */
  get surface() {
    return this.current;
  }

  /** A surface the render server is not reading, made while the ring is
   *  short. Null where the app makes none a layer can show. */
  _free() {
    const inUse = this.app._native?.surfaceIsInUse;
    for (const s of this.ring) {
      if (s === this.current) continue;
      if (typeof inUse !== 'function' || !inUse(s._surfaceHandle)) return s;
    }
    if (this.ring.length < RING_MAX) {
      const s = this.app.createSharedSurface({
        width: this.width,
        height: this.height,
      });
      if (!s) return null;
      this.ring.push(s);
      return s;
    }
    // every one held: the oldest not on glass, the likeliest to be let go
    return this.ring.find((s) => s !== this.current) ?? null;
  }

  /**
   * Draw a frame: `fn(ctx)` gets the 2d context of a surface that starts as
   * the frame before it, in device pixels, and the surface is the newest
   * frame once `fn` returns. `{ full: true }` is for a frame that draws
   * every pixel: nothing is copied from the one before.
   */
  draw(fn, { full = false } = {}) {
    if (this.closed) return;
    let target = null;
    if (this._shared) {
      target = this._free();
      if (!target) this._shared = false;
    }
    if (target) {
      const ctx = target.getContext('2d');
      if (!full && this.current) {
        ctx.save();
        ctx.resetTransform();
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(this.current, 0, 0);
        ctx.restore();
      }
      fn(ctx);
    } else {
      target = this._single ??= new Surface(this.app, {
        width: this.width,
        height: this.height,
      });
      fn(target.getContext('2d'));
    }
    this.current = target;
    this.version += 1;
    for (const l of [...this._listeners]) l(target);
  }

  /** Drop the frames and take no more: what shows the surface shows its
   *  poster or its background from the next frame on. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.version += 1;
    const frames = this.ring.length ? this.ring : [this._single];
    this.current = null;
    for (const l of [...this._listeners]) l(null);
    this._listeners.clear();
    for (const s of frames) s?.destroy?.();
    this.ring = [];
    this._single = null;
  }

  /** `fn(surface)` on every frame, and `fn(null)` on `close()`; answers the
   *  unsubscribe. For what shows the surface, not for applications. */
  _subscribe(fn) {
    if (this.closed) return () => {};
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
}

/** A surface for frames of one size on `app`, a layer's to show. */
export function createLayerSurface(app, options) {
  return new LayerSurface(app, options);
}

export const isLayerSurface = (v) => v instanceof LayerSurface;
