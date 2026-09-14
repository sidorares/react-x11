// An offscreen surface: pixels that persist, drawn into with a 2d context and
// drawn from with `drawImage`.
//
// ntk's `Surface` is an X pixmap and a Picture; the Cocoa backend's is a CG
// bitmap. Here it is a render target (target.js) — a texture with a
// framebuffer in front of it — which is also what a window's backing store
// is, so the paint cache, scroll blits and the window all go through one
// piece of code. The contract is the one `src/ntk.js` documents: `width`/
// `height`, `getContext('2d')`, `render(fn)`, `clear()`, `copyWithin(src,
// dx, dy)`, `destroy()`, and being a valid `drawImage` source.
//
// One thing to know about GL: a context has to be *current* to draw, and
// only one surface is current at a time. Every target here shares the app's
// one EGL context, so `render()` asks the app to make it current before
// binding the target — which normally costs nothing, because it already is.

import { WaylandContext2D } from './context2d.js';
import { GLTarget } from './target.js';

export class WaylandSurface {
  /**
   * @param {import('./app.js').WaylandApp} app
   * @param {object} opts
   * @param {number} opts.width
   * @param {number} opts.height
   * @param {'argb32'|'a8'} [opts.format='argb32']
   */
  constructor(app, { width, height, format = 'argb32' } = {}) {
    if (format !== 'argb32' && format !== 'a8') {
      throw new Error(
        `Surface: unknown format ${JSON.stringify(format)} (argb32 or a8)`,
      );
    }
    this.app = app;
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.format = format;
    this._destroyed = false;
    app.makeCurrent();
    this.target = new GLTarget(app.gl, {
      width: this.width,
      height: this.height,
      stencil: true,
      format,
    });
    this._ctx = null;
  }

  getContext(name = '2d') {
    if (this._destroyed) throw new Error('Surface: destroyed');
    if (name !== '2d') {
      throw new Error(
        `Surface: getContext(${JSON.stringify(name)}) — a surface has a '2d' context and nothing else.`,
      );
    }
    if (!this._ctx) {
      this._ctx = new WaylandContext2D(this.app.gl, {
        fontManager: this.app.fonts,
        target: this.target,
      });
      this.app.makeCurrent();
      this._ctx.init();
    }
    return this._ctx;
  }

  /**
   * Draw into the surface through a context that starts clean — identity
   * transform, no clip — and is flushed when the callback returns.
   */
  render(fn) {
    if (this._destroyed) return this;
    const ctx = this.getContext('2d');
    this.app.makeCurrent();
    ctx.begin(this.width, this.height);
    try {
      fn(ctx);
    } finally {
      ctx.end();
      this.app.rebindWindowTarget();
    }
    return this;
  }

  /** Reset every pixel to fully transparent. */
  clear() {
    if (this._destroyed) return this;
    this.render((ctx) => ctx.clearRect(0, 0, this.width, this.height));
    return this;
  }

  /**
   * Scroll the pixels of `src` by (dx, dy) in place. True when a copy was
   * made; false means nothing survives the shift and the caller repaints.
   */
  copyWithin(src, dx, dy) {
    if (this._destroyed) return false;
    this.app.makeCurrent();
    const ok = this.target.copyWithin(src, dx, dy);
    this.app.rebindWindowTarget();
    return ok;
  }

  /** What `blurCoverage` and friends would want; not available on the GPU. */
  get bytes() {
    throw new Error(
      'Surface.bytes: pixels live on the GPU; use getContext("2d").getImageData()',
    );
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.app.makeCurrent();
    this._ctx?.destroy();
    this._ctx = null;
    this.target.destroy();
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}
