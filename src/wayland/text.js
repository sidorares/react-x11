// Shaped text, positioned for the GPU context.
//
// Nothing here shapes anything: ntk's `FontManager.shape` does the work, and
// it does it with no display connection at all — fontconfig matching, fontkit
// faces, harfbuzz-equivalent shaping, bidi levels. That is the RFC's claim
// about the portable half of the text stack, and it holds exactly: the same
// call, on the same fonts, produces the same runs the X11 backend draws.
//
// What this adds is the last inch the X11 backend gets from XRender for free.
// ntk's shaped output gives each glyph an advance (`ax`) and an offset
// (`dx`/`dy`) rather than a position, because `CompositeGlyphs` walks the run
// and accumulates advances server-side. There is no server here, so the walk
// happens on this side and comes out as absolute pen positions the atlas can
// place quads at.

/**
 * Turn ntk's shaped runs into positioned glyph runs.
 *
 * Positions are relative to the text origin: x from the start of the run, y
 * on the baseline. The caller translates to put it somewhere.
 */
export function positionRuns(shaped, { color } = {}) {
  const out = [];
  let penX = 0;
  for (const run of shaped.runs) {
    const glyphs = [];
    for (const g of run.glyphs) {
      glyphs.push({ id: g.id, x: penX + (g.dx ?? 0), y: g.dy ?? 0 });
      penX += g.ax ?? 0;
    }
    out.push({
      font: run.font,
      size: run.size,
      // A run's identity for atlas keys: the same face at the same size is
      // the same pixels, whatever string it came from.
      fontKey: run.font?.postscriptName ?? run.font?.familyName ?? 'font',
      glyphs,
      color,
    });
  }
  return out;
}

/**
 * A small shaping cache in front of ntk's.
 *
 * ntk memoises at word level internally; this memoises the whole positioned
 * result, because a UI redraws the same labels every frame and the win is
 * skipping the walk and the object churn, not the shaping.
 */
export class TextShaper {
  constructor(fontManager, { limit = 512 } = {}) {
    this.fm = fontManager;
    this.limit = limit;
    this._cache = new Map();
  }

  /**
   * @returns {Promise<{width:number, runs:Array, ascent:number, descent:number, lineHeight:number}>}
   */
  /**
   * The same, synchronously — ntk's matching and shaping are synchronous once
   * the fontconfig cache is warm, which it is after the first call. For the
   * window frame's title, which is drawn inside a frame and cannot await.
   */
  measureSync(text, spec) {
    const key = `${spec.family}|${spec.size}|${spec.weight ?? ''}|${spec.italic ? 'i' : ''}|${text}`;
    const hit = this._cache.get(key);
    if (hit) return hit;
    const shaped = this.fm.shape(text, spec);
    if (!shaped || typeof shaped.then === 'function') return null;
    const font = shaped.runs[0]?.font ?? this.fm.match(spec);
    if (!font || typeof font.then === 'function') return null;
    const m = font.metrics(spec.size);
    const entry = {
      width: shaped.width,
      runs: positionRuns(shaped),
      ascent: m.ascent,
      descent: m.descent,
      lineHeight: m.lineHeight,
    };
    this._cache.set(key, entry);
    if (this._cache.size > this.limit)
      this._cache.delete(this._cache.keys().next().value);
    return entry;
  }

  async measure(text, spec) {
    const key = `${spec.family}|${spec.size}|${spec.weight ?? ''}|${spec.italic ? 'i' : ''}|${text}`;
    const hit = this._cache.get(key);
    if (hit) {
      // refresh LRU position
      this._cache.delete(key);
      this._cache.set(key, hit);
      return hit;
    }
    const shaped = await this.fm.shape(text, spec);
    const font = shaped.runs[0]?.font ?? (await this.fm.match(spec));
    const m = font.metrics(spec.size);
    const entry = {
      width: shaped.width,
      runs: positionRuns(shaped),
      ascent: m.ascent,
      descent: m.descent,
      lineHeight: m.lineHeight,
    };
    this._cache.set(key, entry);
    if (this._cache.size > this.limit) {
      this._cache.delete(this._cache.keys().next().value);
    }
    return entry;
  }
}
