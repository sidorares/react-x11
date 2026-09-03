// An offscreen drawing surface on the Cocoa backend — ntk's `Surface`
// contract (draw once, composite many, and shift a retained band in place)
// over one @windowkit/appkit CG bitmap. `react-x11/ntk`'s `Surface` hands
// out one of these when the app it is given is a Cocoa app (the app's
// `createSurface` seam, src/cocoa/app.js), so a component allocates its
// buffer the same way on both backends and names neither:
//
//   const surface = new Surface(app, { width, height });   // device pixels
//   const ctx = surface.getContext('2d');                    // a CocoaContext2D
//   ctx.fillRect(0, 0, width, height);
//   surface.copyWithin({ x: 0, y: 0, width, height }, 0, -rowHeight);
//   windowCtx.drawImage(surface, x, y);                      // one composite
//
// What is the same as ntk's: the constructor, `width`/`height`/`format`/
// `depth`/`bytes`, `getContext`, `render`, `clear`, `copyWithin` down to its
// clamping (ntk#252 — integer deltas, the band that survives, false when
// nothing does), `destroy`/`Symbol.dispose`, and `drawImage` taking the
// surface as a source. What differs is stated here, because this is where
// it lives:
//
// - **One graphics state per surface.** CoreGraphics keeps the CTM, the
//   clip and the path in the bitmap context itself, where an X connection
//   keeps them per Picture/GC. So `getContext('2d')` answers the same
//   context every time — a JS object over that one state, nothing to free,
//   and `destroy()` on it is a no-op — and `render()` brackets its callback
//   in save/restore from the identity transform, so a one-shot draw leaves
//   no residue for the next painter, which is what ntk gets from building a
//   fresh context per call.
// - **`format: 'a8'` is not here yet.** Coverage surfaces are what the paint
//   cache's masks and the shadows use, and both stay on their X path; every
//   consumer that allocates a surface of its own asks for argb32. Asking
//   for a8 throws rather than answering a colour surface that would
//   composite differently.
// - **No Picture.** `picture()` is X's compositing handle; here a surface
//   composites through `ctx.drawImage`, and asking for the picture says so.
// - **Freed on `destroy()`.** The bridge's `releaseSurface` (0.4) frees the
//   bitmap on the call and hands its bytes back to V8's account; the
//   handle's finalizer stays as the safety net for a surface that is
//   dropped without one. Under an older bridge the memory goes with the
//   next GC, as it always did.
//
// Units are device pixels, like the window's backing store: a caller sizes
// one from `contentBox()` numbers, which are device pixels already
// (docs/scale.md). The bridge is told the app's scale so the bitmap carries
// it — inert for a `drawImage` source, right for a layer's contents.
import { CocoaContext2D } from './context2d.js';

export class CocoaSurface {
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
        "Surface: format 'a8' (a coverage surface) is not on the cocoa " +
          'backend yet — allocate argb32, which every backend has, and ' +
          'tint through fillStyle/globalAlpha; track docs/macos.md ' +
          '"Custom drawing on a layer tree".',
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
    this._surfaceHandle = this._native.createSurface(
      width,
      height,
      app.scale ?? 1,
    );
    // a fresh bitmap's contents are the allocator's; a surface that is only
    // partly drawn must composite nothing where nothing was drawn
    this.clear();
  }

  /** bytes of backing storage — what a cache budgets against */
  get bytes() {
    return this.width * this.height * 4;
  }

  /** X's compositing handle, which this backend does not have. */
  picture() {
    throw new Error(
      'Surface: a surface on the cocoa backend has no XRender Picture — ' +
        'composite it with ctx.drawImage(surface, x, y), which takes a ' +
        'surface directly on both backends.',
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
      this._ctx = new CocoaContext2D(
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
          "cocoa backend has a '2d' context and nothing else.",
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
   * Scroll the pixels of `src` (surface coordinates, `{x, y, width,
   * height}`) by (dx, dy) in place: one in-place copy of the band that
   * survives the shift (the bridge's `scrollSurface`, a memmove per row), in
   * place of redrawing everything that merely moved. True when the copy was
   * issued; false means "nothing survives the shift here" and the caller
   * repaints `src` exactly as it would have without this method.
   *
   * ntk#252's contract, clamp for clamp: refused when the delta is
   * fractional (a sub-pixel shift changes every pixel), when it is zero,
   * when nothing of `src` survives after clamping to the surface, or on a
   * destroyed surface. The band is `clamped src ∩ (clamped src + delta)`,
   * so nothing outside `src` is written; the overlap is safe because the
   * copy walks rows in the direction that reads before it overwrites.
   */
  copyWithin(src, dx, dy) {
    if (this._destroyed) return false;
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) return false;
    if (dx === 0 && dy === 0) return false;
    const x0 = Math.max(0, Math.floor(src.x));
    const y0 = Math.max(0, Math.floor(src.y));
    const x1 = Math.min(this.width, Math.ceil(src.x + src.width));
    const y1 = Math.min(this.height, Math.ceil(src.y + src.height));
    const dstX0 = Math.max(x0, x0 + dx);
    const dstY0 = Math.max(y0, y0 + dy);
    const dstX1 = Math.min(x1, x1 + dx);
    const dstY1 = Math.min(y1, y1 + dy);
    // written as the positive test so a NaN edge (a rect with no numbers
    // in it) is a refusal too, never a native call with garbage
    if (!(dstX1 > dstX0 && dstY1 > dstY0)) return false;
    return Boolean(
      this._native.scrollSurface(
        this._surfaceHandle,
        x0,
        y0,
        x1 - x0,
        y1 - y0,
        dx,
        dy,
      ),
    );
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

export default CocoaSurface;
