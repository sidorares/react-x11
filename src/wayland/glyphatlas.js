// The client-side glyph cache — the thing XRender's `GlyphSet` used to be.
//
// On X11 a glyph is uploaded once into a server-resident glyph set and then
// named by id in a `CompositeGlyphs` request; the server owns the pixels and
// the client never sees them again. There is no such thing here. A Wayland
// client rasterises its own glyphs and composites them itself, so the cache
// has to live on this side of the socket — and for Tier D specifically, in
// GPU memory, as a texture that quads sample from.
//
// The rasteriser is ntk's own (`Font.rasterize` -> A8 coverage), which is the
// part of the text stack most worth keeping: shaping, bidi and line breaking
// stay exactly as they are on X11, and only the final composite changes.
//
// Packing is a shelf: glyphs arrive in no useful order and are never freed
// individually, so the classic row-by-row placement wastes little and costs
// nothing to maintain. When a shelf will not take the glyph the atlas grows
// by doubling, which invalidates every entry — the context is told first, so
// quads already buffered against the old layout are drawn before it changes
// under them (see `onBeforeGrow`).
//
// Uploads are deferred and partial: new glyphs land in a CPU copy and the
// dirty rectangle goes up with one `texSubImage2D` when the texture is next
// bound. The first version of this file re-uploaded the whole atlas per new
// glyph, which at 4096² is 16MB per character of a paragraph's first paint.

const INITIAL_SIZE = 512;
const MAX_SIZE = 4096;
/** Keep glyphs from bleeding into each other under linear filtering. */
const PAD = 1;

export class GlyphAtlas {
  constructor(gl, { size = INITIAL_SIZE } = {}) {
    this.gl = gl;
    this.size = size;
    /** key -> { x, y, w, h, left, top, u0, v0, u1, v1 } */
    this.entries = new Map();
    this._shelfY = PAD;
    this._shelfH = 0;
    this._shelfX = PAD;
    this._pixels = new Uint8Array(size * size);
    this.texture = null;
    /** dirty rectangle of the CPU copy not yet uploaded, or null */
    this._dirty = null;
    this._fresh = true; // the GPU texture needs a full upload
    this.generation = 0;
    /** called before the atlas grows, so pending quads can be flushed */
    this.onBeforeGrow = null;
  }

  /**
   * Find or make room for one rasterised glyph.
   *
   * @param {string} key identifies the glyph *and* the size it was rasterised
   *   at — a 12px 'a' and a 24px 'a' are different pixels and share nothing.
   * @param {() => {width,height,left,top,data}} raster called only on a miss,
   *   so a hit never touches the font machinery
   */
  get(key, raster) {
    const hit = this.entries.get(key);
    if (hit) return hit;

    const g = raster();
    // A space has no ink. Cache the absence so the miss is paid once.
    if (!g || g.width <= 0 || g.height <= 0) {
      const empty = { empty: true, left: g?.left ?? 0, top: g?.top ?? 0 };
      this.entries.set(key, empty);
      return empty;
    }

    const spot = this._place(g.width, g.height);
    if (!spot) return { empty: true, left: g.left, top: g.top };

    for (let row = 0; row < g.height; row++) {
      const src = row * g.width;
      const dst = (spot.y + row) * this.size + spot.x;
      this._pixels.set(g.data.subarray(src, src + g.width), dst);
    }
    this._markDirty(spot.x, spot.y, g.width, g.height);

    const inv = 1 / this.size;
    const entry = {
      empty: false,
      x: spot.x,
      y: spot.y,
      w: g.width,
      h: g.height,
      left: g.left,
      top: g.top,
      u0: spot.x * inv,
      v0: spot.y * inv,
      u1: (spot.x + g.width) * inv,
      v1: (spot.y + g.height) * inv,
    };
    this.entries.set(key, entry);
    return entry;
  }

  _markDirty(x, y, w, h) {
    const d = this._dirty;
    if (!d) {
      this._dirty = { x0: x, y0: y, x1: x + w, y1: y + h };
      return;
    }
    d.x0 = Math.min(d.x0, x);
    d.y0 = Math.min(d.y0, y);
    d.x1 = Math.max(d.x1, x + w);
    d.y1 = Math.max(d.y1, y + h);
  }

  _place(w, h) {
    if (w + PAD * 2 > this.size || h + PAD * 2 > this.size) {
      return this._grow() ? this._place(w, h) : null;
    }
    if (this._shelfX + w + PAD > this.size) {
      this._shelfY += this._shelfH + PAD;
      this._shelfH = 0;
      this._shelfX = PAD;
    }
    if (this._shelfY + h + PAD > this.size) {
      return this._grow() ? this._place(w, h) : null;
    }
    const spot = { x: this._shelfX, y: this._shelfY };
    this._shelfX += w + PAD;
    if (h > this._shelfH) this._shelfH = h;
    return spot;
  }

  /**
   * Double the atlas and start over.
   *
   * Entries are dropped rather than copied: they only remember where their
   * pixels went, and a repack at this frequency is not worth keeping a second
   * copy of every glyph. Anyone holding an entry across this call has a
   * stale one, which is why `onBeforeGrow` exists.
   */
  _grow() {
    if (this.size >= MAX_SIZE) return false;
    this.onBeforeGrow?.();
    this.size *= 2;
    this._pixels = new Uint8Array(this.size * this.size);
    this.entries.clear();
    this._shelfX = PAD;
    this._shelfY = PAD;
    this._shelfH = 0;
    this._dirty = null;
    this._fresh = true;
    this.generation++;
    if (this.texture) {
      this.gl.deleteTexture(this.texture);
      this.texture = null;
    }
    return true;
  }

  /** Make the atlas current on the active texture unit, uploading anything new. */
  bind() {
    const gl = this.gl;
    if (!this.texture) {
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._fresh = true;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
    }
    // A8 rows are tightly packed and almost never a multiple of 4.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (this._fresh) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.ALPHA,
        this.size,
        this.size,
        0,
        gl.ALPHA,
        gl.UNSIGNED_BYTE,
        this._pixels,
      );
      this._fresh = false;
      this._dirty = null;
    } else if (this._dirty) {
      const { x0, y0, x1, y1 } = this._dirty;
      const w = x1 - x0;
      const h = y1 - y0;
      // texSubImage2D wants the rows contiguous; a sub-rectangle of the CPU
      // copy is not, so gather them. Small — a frame's worth of new glyphs.
      const rows = new Uint8Array(w * h);
      for (let r = 0; r < h; r++) {
        const src = (y0 + r) * this.size + x0;
        rows.set(this._pixels.subarray(src, src + w), r * w);
      }
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        x0,
        y0,
        w,
        h,
        gl.ALPHA,
        gl.UNSIGNED_BYTE,
        rows,
      );
      this._dirty = null;
    }
    return this.texture;
  }

  destroy() {
    if (this.texture) this.gl.deleteTexture(this.texture);
    this.texture = null;
    this.entries.clear();
  }
}
