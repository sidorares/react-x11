// An offscreen drawing surface on the win32 backend — ntk's `Surface`
// contract (draw once, composite many) over one Direct2D bitmap.
// `react-x11/ntk`'s `Surface` hands out one of these when the app it is
// given is a win32 app (the app's `createSurface` seam, src/win32/app.js),
// so a component allocates its buffer the same way on every backend and
// names none of them:
//
//   const surface = new Surface(app, { width, height });   // device pixels
//   const ctx = surface.getContext('2d');                    // a BackendContext2D
//   ctx.fillRect(0, 0, width, height);
//   windowCtx.drawImage(surface, x, y);                      // one composite
//
// What is the same as ntk's: the constructor, `width`/`height`/`format`/
// `depth`/`bytes`, `getContext`, `render`, `clear`, `destroy`/
// `Symbol.dispose`, and `drawImage` taking the surface as a source. What
// differs is stated here, because this is where it lives:
//
// - **One graphics state per surface.** Direct2D keeps the transform on the
//   device context and the clip as a stack on it, where an X connection
//   keeps them per Picture/GC. So `getContext('2d')` answers the same
//   context every time — a JS object over that one state, nothing to free,
//   and `destroy()` on it is a no-op — and `render()` brackets its callback
//   in save/restore from the identity transform, so a one-shot draw leaves
//   no residue for the next painter, which is what ntk gets from building a
//   fresh context per call.
// - **`format: 'a8'` is not here yet.** Every consumer that allocates a
//   surface of its own asks for argb32. Asking for a8 throws rather than
//   answering a colour surface that would composite differently.
// - **No Picture.** `picture()` is X's compositing handle; here a surface
//   composites through `ctx.drawImage`, and asking for the picture says so.
// - **`copyWithin` refuses.** The bridge has `IDCompositionSurface::Scroll`
//   for a *window*, which is a composition call and not a bitmap one, and
//   no in-place blit for an offscreen bitmap. The contract already has an
//   answer for that — false means "nothing survives the shift here" and the
//   caller repaints the rect exactly as it would have without the method —
//   so refusing is correct rather than merely convenient. A real scroll
//   belongs here when the bridge grows one.
import { BackendContext2D } from '../backend/context2d.js';

export class Win32Surface {
  constructor(app, { width, height, format = 'argb32' } = {}) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error('Surface: width and height must be positive integers');
    }
    if (format === 'a8') {
      throw new Error(
        "Surface: format 'a8' (a coverage surface) is not on the win32 " +
          'backend yet — allocate argb32, which every backend has, and ' +
          'tint through fillStyle/globalAlpha.',
      );
    }
    if (format !== 'argb32') {
      throw new Error(
        `Surface: unknown format ${JSON.stringify(format)} (argb32 or a8)`,
      );
    }
    this.app = app;
    this.width = width;
    this.height = height;
    this.format = format;
    this.depth = 32;
    this._native = app._native;
    this._fonts = app.fonts ?? null;
    this._ctx = null;
    this._destroyed = false;
    // The bridge clears the bitmap as it makes it: a fresh one's contents
    // are the allocator's, and a surface that is only partly drawn must
    // composite nothing where nothing was drawn.
    this._surfaceHandle = this._native.createSurface(
      width,
      height,
      app.scale ?? 1,
    );
  }

  /** bytes of backing storage — what a cache budgets against */
  get bytes() {
    return this.width * this.height * 4;
  }

  /** X's compositing handle, which this backend does not have. */
  picture() {
    throw new Error(
      'Surface: a surface on the win32 backend has no XRender Picture — ' +
        'composite it with ctx.drawImage(surface, x, y), which takes a ' +
        'surface directly on every backend.',
    );
  }

  _handle() {
    if (this._destroyed) {
      throw new Error(
        'Surface: destroyed — a context on a destroyed surface cannot ' +
          'draw; allocate a new Surface and draw into that.',
      );
    }
    return this._surfaceHandle;
  }

  _context() {
    if (!this._ctx) {
      this._ctx = new BackendContext2D(
        this._native,
        () => this._handle(),
        () => 1,
      );
      this._ctx._fonts = this._fonts;
    }
    return this._ctx;
  }

  /**
   * The 2d context on the bitmap — the same one every time, since the
   * bitmap has one graphics state (see the header). ntk's contract has the
   * caller owning it and owing it a `destroy()`; that call is honoured as a
   * no-op, so a caller written against ntk needs no branch.
   */
  getContext(name = '2d') {
    this._handle();
    if (name !== '2d') {
      throw new Error(
        `Surface: getContext(${JSON.stringify(name)}) — a surface on the ` +
          "win32 backend has a '2d' context and nothing else.",
      );
    }
    return this._context();
  }

  /**
   * Draw into the surface through a context that starts clean — identity
   * transform, the fill and line state as they were — and leaves the
   * surface's state as it found it: the save/restore bracket stands in for
   * the per-call context ntk builds and destroys.
   */
  render(fn) {
    const ctx = this.getContext('2d');
    ctx.save();
    try {
      ctx.resetTransform();
      fn(ctx);
    } finally {
      ctx.restore();
    }
    return this;
  }

  /** Reset every pixel to fully transparent, whatever transform a live
   * context holds — the clear is issued from the identity. */
  clear() {
    if (this._destroyed) return this;
    const ctx = this._context();
    ctx.save();
    try {
      ctx.resetTransform();
      ctx.clearRect(0, 0, this.width, this.height);
    } finally {
      ctx.restore();
    }
    return this;
  }

  /**
   * Shift the pixels of `src` in place. Always refused here, which is a
   * value the contract already has: false means "nothing survives the shift"
   * and the caller repaints `src` as it would have anyway. See the header.
   */
  copyWithin() {
    return false;
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    const handle = this._surfaceHandle;
    this._surfaceHandle = null;
    this._ctx = null;
    if (typeof this._native.releaseSurface === 'function') {
      this._native.releaseSurface(handle);
    }
  }

  [Symbol.dispose]() {
    this.destroy();
  }
}

export default Win32Surface;
