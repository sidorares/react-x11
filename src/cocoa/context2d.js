// A canvas-shaped 2d context over a @windowkit/appkit CoreGraphics surface.
//
// This is the raster half of the Cocoa backend: on the surface presenter it
// is the whole drawing path, and on the layer presenter it stays as the
// fallback every painted-code node (<canvas>, <svg>, registered elements)
// rasters through — docs/macos.md §"Custom drawing on a layer tree".
//
// The native surface holds the real graphics state (paths, CTM, clip); this
// class keeps the JS-visible state (fillStyle strings, gradient objects,
// dash arrays) and re-syncs it when the backing surface is replaced after a
// resize — `_gen` is that generation.
import { cssColorStraight } from 'ntk';

const BLACK = [0, 0, 0, 1];

// A colour string is parsed once: a frame over a large tree sets the same
// few fills thousands of times, and the parse — a regex and four numbers —
// cost a third of `_applyFill` (measured on the presenter bench's `tiny`
// cell, 5,000 fills of two colours: 100ms of a 200ms frame). Bounded, and
// dropped whole rather than evicted, since a palette is a few dozen strings.
const parsedColors = new Map();
const PARSED_COLORS_MAX = 256;

function parseColor(value) {
  if (value == null) return BLACK;
  const key = typeof value === 'string' ? value : String(value);
  let parsed = parsedColors.get(key);
  if (parsed === undefined) {
    parsed = cssColorStraight(key) ?? BLACK;
    if (parsedColors.size >= PARSED_COLORS_MAX) parsedColors.clear();
    parsedColors.set(key, parsed);
  }
  return parsed;
}

class LinearGradient {
  constructor(x0, y0, x1, y1) {
    this._coords = [x0, y0, x1, y1];
    this._stops = [];
  }

  addColorStop(offset, color) {
    const [r, g, b, a] = parseColor(color);
    this._stops.push(offset, r, g, b, a);
  }

  /**
   * CoreGraphics requires stop locations inside [0, 1]; the decorations
   * parser deliberately pads a gradient's line past both ends (its end
   * colours pinned there — see src/decorations.js). Out-of-range locations
   * fed to CGGradient render as a solid block, so the line is re-derived:
   * the coordinates extend to cover the outermost stops and every location
   * remaps into [0, 1].
   */
  _normalized() {
    const stops = [];
    for (let i = 0; i + 4 < this._stops.length; i += 5) {
      stops.push(this._stops.slice(i, i + 5));
    }
    stops.sort((p, q) => p[0] - q[0]);
    if (stops.length === 0) return { coords: this._coords, flat: [] };
    if (stops.length === 1) stops.push([...stops[0]]);
    const min = Math.min(0, stops[0][0]);
    const max = Math.max(1, stops[stops.length - 1][0]);
    let [x0, y0, x1, y1] = this._coords;
    if (min !== 0 || max !== 1) {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const nx0 = x0 + dx * min;
      const ny0 = y0 + dy * min;
      x1 = x0 + dx * max;
      y1 = y0 + dy * max;
      x0 = nx0;
      y0 = ny0;
      const span = max - min;
      for (const stop of stops) stop[0] = (stop[0] - min) / span;
    }
    for (const stop of stops) stop[0] = Math.min(1, Math.max(0, stop[0]));
    return { coords: [x0, y0, x1, y1], flat: stops.flat() };
  }
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

/**
 * The Render ops text draws with, numbered as XRender numbers them so a
 * caller's `ctx.Render?.PictOp?.Over ?? 3` reads the same on both
 * backends. Every op draws as Over here: the bridge composites glyph
 * coverage with the context's fill and offers no blend-mode switch, and
 * for the opaque inks text uses Src and Over agree.
 */
const PICT_OP = Object.freeze({ Src: 1, Over: 3 });
const RENDER = Object.freeze({ PictOp: PICT_OP });

/**
 * The path, recorded alongside the native one, so `stroke` can re-issue it
 * in pieces — `CGContextStrokePath` is QUADRATIC in the number of subpaths
 * in the path it is given (issue #456). Measured here, 13-vertex closed
 * rings scattered over a 1024x1024 surface at a 2px line, one stroke call:
 *
 *    500 rings  20ms | 1000 rings  59ms | 2000 rings 208ms | 4000 rings 986ms
 *
 * Splitting the same geometry into strokes of a few hundred subpaths is
 * linear in it: 14ms, 29ms, 56ms, 113ms. The driver is the subpath count,
 * not the vertex count — one 26,000-vertex subpath strokes in 4ms where
 * two thousand 13-vertex ones take 208. The full table, the two shapes
 * left whole and why, are in docs/macos.md
 * §"Stroking a path with many subpaths".
 *
 * Note the X11 context wants the opposite — there a stroke is an a8
 * coverage mask over the path's bounding box uploaded with one PutImage,
 * so a bigger path is fewer uploads over the same pixels. That is why this
 * lives in the backend: a caller that batches for one backend pessimizes
 * the other, and it cannot know which it is drawing on.
 *
 * The commands are a flat number array — `[op, ...args, op, ...args]` —
 * reused across paths, so a path build is three pushes into a packed
 * double array per point next to the napi call it already makes.
 */
const P_MOVE = 0;
const P_LINE = 1;
const P_CURVE = 2;
const P_QUAD = 3;
const P_CLOSE = 4;
const P_RECT = 5;
const P_ROUND = 6;
const P_ARC = 7;
const P_ELLIPSE = 8;
/** how many numbers each op carries, and what it costs a chunk's budget */
const P_ARGS = [2, 2, 6, 4, 0, 4, 8, 6, 4];
const P_POINTS = [1, 1, 3, 2, 0, 4, 8, 8, 4];

/**
 * A chunk closes at the first subpath boundary past either budget. Swept
 * over the shapes above: 512 points is within 5% of the best chunk for
 * every one of them, and the subpath cap catches the degenerate shape the
 * point budget misses — thousands of 3- and 4-point subpaths, where 512
 * points is already 128 strokes' worth of setup.
 */
const STROKE_CHUNK_POINTS = 512;
const STROKE_CHUNK_SUBPATHS = 128;

/**
 * The off switch, for a process that cannot reach the context — the same
 * line `ctx.strokeChunking = false` draws, and what a bench comparing the
 * two sets. Read once.
 */
const NO_STROKE_CHUNKING = process.env.REACT_X11_NO_STROKE_CHUNKING === '1';

/**
 * A solid ink for `drawGlyphs` — ntk's `createSolidPicture` answers an
 * XRender picture; here it is the colour itself. Premultiplied 0..1 in, as
 * XRender solids are (the identity for the opaque inks text uses), straight
 * for CoreGraphics inside.
 */
class SolidPicture {
  constructor(r, g, b, a) {
    const alpha = clamp01(a);
    const straight = (c) => (alpha > 0 ? clamp01(c / alpha) : 0);
    this._rgba = [straight(r), straight(g), straight(b), alpha];
  }
}

export class CocoaContext2D {
  /**
   * @param native the @windowkit/appkit module
   * @param surfaceOf () => current surface handle — the owner replaces the
   *   surface on resize, and this context follows it.
   * @param genOf () => surface generation number
   */
  constructor(native, surfaceOf, genOf) {
    this._native = native;
    this._surfaceOf = surfaceOf;
    this._genOf = genOf;
    this._gen = -1;
    this._stack = [];
    this._state = {
      fillStyle: '#000',
      strokeStyle: '#000',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      globalAlpha: 1,
      dash: [],
      dashOffset: 0,
      font: '10px sans-serif',
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      shadowColor: 'rgba(0,0,0,0)',
      ctm: [1, 0, 0, 1, 0, 0],
    };
    this._onDirty = null;
    // the recorded path, and whether the native one still matches it (a
    // chunked stroke leaves only its last chunk behind)
    this._cmds = [];
    this._pathStale = false;
    this._strokeChunking = !NO_STROKE_CHUNKING;
  }

  _s() {
    const surface = this._surfaceOf();
    const gen = this._genOf();
    if (gen !== this._gen) {
      // fresh surface: push the sticky state back into it
      this._gen = gen;
      const n = this._native;
      const st = this._state;
      n.ctxSetLineWidth(surface, st.lineWidth);
      n.ctxSetLineCap(surface, st.lineCap);
      n.ctxSetLineJoin(surface, st.lineJoin);
      n.ctxSetGlobalAlpha(surface, st.globalAlpha);
      n.ctxSetLineDash(surface, st.dash, st.dashOffset);
      this._stack.length = 0;
      // the path went with the surface it was built on; nothing may
      // replay it onto the new one
      this._cmds.length = 0;
      this._pathStale = false;
    }
    return surface;
  }

  _dirty() {
    this._onDirty?.();
  }

  // --- state ---------------------------------------------------------------

  get fillStyle() {
    return this._state.fillStyle;
  }

  set fillStyle(value) {
    this._state.fillStyle = value;
  }

  get strokeStyle() {
    return this._state.strokeStyle;
  }

  set strokeStyle(value) {
    this._state.strokeStyle = value;
  }

  get lineWidth() {
    return this._state.lineWidth;
  }

  set lineWidth(value) {
    if (typeof value === 'number' && value > 0) {
      this._state.lineWidth = value;
      this._native.ctxSetLineWidth(this._s(), value);
    }
  }

  get lineCap() {
    return this._state.lineCap;
  }

  set lineCap(value) {
    this._state.lineCap = value;
    this._native.ctxSetLineCap(this._s(), String(value));
  }

  get lineJoin() {
    return this._state.lineJoin;
  }

  set lineJoin(value) {
    this._state.lineJoin = value;
    this._native.ctxSetLineJoin(this._s(), String(value));
  }

  get globalAlpha() {
    return this._state.globalAlpha;
  }

  set globalAlpha(value) {
    if (typeof value === 'number' && value >= 0 && value <= 1) {
      this._state.globalAlpha = value;
      this._native.ctxSetGlobalAlpha(this._s(), value);
    }
  }

  /**
   * Whether a stroke of a path with many subpaths may go out as several
   * `CGContextStrokePath` calls — on by default, because the alternative
   * is quadratic (see P_MOVE above) and every path small enough for the
   * difference to be invisible is below the threshold anyway.
   *
   * Set it false for a path whose subpaths OVERLAP and whose seams have to
   * composite exactly: chunked, a pixel the strokes of two subpaths each
   * half cover is inked twice at half coverage rather than once at full,
   * and reads a little lighter. `REACT_X11_NO_STROKE_CHUNKING=1` is the
   * same switch for a whole process.
   */
  get strokeChunking() {
    return this._strokeChunking;
  }

  set strokeChunking(value) {
    this._strokeChunking = !!value;
  }

  get font() {
    return this._state.font;
  }

  set font(value) {
    this._state.font = String(value);
  }

  get shadowBlur() {
    return this._state.shadowBlur;
  }

  set shadowBlur(value) {
    if (typeof value === 'number' && value >= 0) {
      this._state.shadowBlur = value;
      this._syncShadow();
    }
  }

  get shadowOffsetX() {
    return this._state.shadowOffsetX;
  }

  set shadowOffsetX(value) {
    if (typeof value === 'number') {
      this._state.shadowOffsetX = value;
      this._syncShadow();
    }
  }

  get shadowOffsetY() {
    return this._state.shadowOffsetY;
  }

  set shadowOffsetY(value) {
    if (typeof value === 'number') {
      this._state.shadowOffsetY = value;
      this._syncShadow();
    }
  }

  get shadowColor() {
    return this._state.shadowColor;
  }

  set shadowColor(value) {
    this._state.shadowColor = value;
    this._syncShadow();
  }

  _syncShadow() {
    const st = this._state;
    const [r, g, b, a] = parseColor(st.shadowColor);
    const on = st.shadowBlur > 0 && a > 0;
    this._native.ctxSetShadow(
      this._s(),
      on ? st.shadowBlur : 0,
      st.shadowOffsetX,
      st.shadowOffsetY,
      r,
      g,
      b,
      a,
    );
  }

  setLineDash(segments) {
    this._state.dash = Array.isArray(segments) ? segments : [];
    this._native.ctxSetLineDash(this._s(), this._state.dash, 0);
  }

  getLineDash() {
    return [...this._state.dash];
  }

  save() {
    // Sync before pushing: a fresh surface empties the stack on its way in,
    // and a state pushed ahead of that sync was lost to it — the first
    // save/restore pair on a new context restored nothing.
    const surface = this._s();
    this._stack.push({ ...this._state, dash: [...this._state.dash] });
    this._native.ctxSave(surface);
  }

  restore() {
    // Canvas's rule: a restore with nothing saved does nothing. It is also
    // what keeps a surface's base state safe under an unbalanced painter —
    // the native stack below the JS one is the surface's own — and what a
    // replaced backing surface wants, since it has nothing saved either.
    const surface = this._s();
    const prev = this._stack.pop();
    if (!prev) return;
    this._state = prev;
    this._native.ctxRestore(surface);
  }

  /**
   * ntk's contract has a caller who took a context owing it a `destroy()`
   * — there it is a GC and a Picture. Here a context is JS state over the
   * surface's own graphics state, so there is nothing to free; the call is
   * honoured so a caller written against ntk needs no branch.
   */
  destroy() {}

  _concat(a2, b2, c2, d2, e2, f2) {
    const [a, b, c, d, e, f] = this._state.ctm;
    this._state.ctm = [
      a * a2 + c * b2,
      b * a2 + d * b2,
      a * c2 + c * d2,
      b * c2 + d * d2,
      a * e2 + c * f2 + e,
      b * e2 + d * f2 + f,
    ];
  }

  translate(x, y) {
    this._concat(1, 0, 0, 1, x, y);
    this._native.ctxTranslate(this._s(), x, y);
  }

  scale(x, y) {
    this._concat(x, 0, 0, y, 0, 0);
    this._native.ctxScale(this._s(), x, y);
  }

  rotate(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    this._concat(cos, sin, -sin, cos, 0, 0);
    this._native.ctxRotate(this._s(), angle);
  }

  transform(a, b, c, d, e, f) {
    this._concat(a, b, c, d, e, f);
    this._native.ctxTransform(this._s(), a, b, c, d, e, f);
  }

  setTransform(a, b, c, d, e, f) {
    if (typeof a === 'object' && a) ({ a, b, c, d, e, f } = a);
    // concat the delta that takes the current matrix to the requested one
    const [ca, cb, cc, cd, ce, cf] = this._state.ctm;
    const det = ca * cd - cb * cc;
    if (!det) return;
    const ia = cd / det;
    const ib = -cb / det;
    const ic = -cc / det;
    const id = ca / det;
    const ie = -(ia * ce + ic * cf);
    const iff = -(ib * ce + id * cf);
    this.transform(
      ia * a + ic * b,
      ib * a + id * b,
      ia * c + ic * d,
      ib * c + id * d,
      ia * e + ic * f + ie,
      ib * e + id * f + iff,
    );
  }

  resetTransform() {
    this.setTransform(1, 0, 0, 1, 0, 0);
  }

  getTransform() {
    const [a, b, c, d, e, f] = this._state.ctm;
    return { a, b, c, d, e, f };
  }

  // --- paths ---------------------------------------------------------------

  /**
   * The surface to build or paint the current path on, with the native
   * path restored first if a chunked stroke consumed it. Lazy on purpose:
   * a caller that strokes and then starts a new path — which is every
   * caller in a paint loop — never pays for the rebuild.
   */
  _path() {
    const surface = this._s();
    if (this._pathStale) {
      this._pathStale = false;
      this._native.ctxBeginPath(surface);
      this._emit(surface, 0, this._cmds.length);
    }
    return surface;
  }

  /** replay recorded commands `[from, to)` into the native path */
  _emit(surface, from, to) {
    const c = this._cmds;
    const n = this._native;
    for (let i = from; i < to;) {
      const op = c[i];
      const a = i + 1;
      if (op === P_MOVE) n.ctxMoveTo(surface, c[a], c[a + 1]);
      else if (op === P_LINE) n.ctxLineTo(surface, c[a], c[a + 1]);
      else if (op === P_CURVE)
        n.ctxCurveTo(
          surface,
          c[a],
          c[a + 1],
          c[a + 2],
          c[a + 3],
          c[a + 4],
          c[a + 5],
        );
      else if (op === P_QUAD)
        n.ctxQuadTo(surface, c[a], c[a + 1], c[a + 2], c[a + 3]);
      else if (op === P_CLOSE) n.ctxClosePath(surface);
      else if (op === P_RECT)
        n.ctxRect(surface, c[a], c[a + 1], c[a + 2], c[a + 3]);
      else if (op === P_ROUND)
        n.ctxRoundRect(
          surface,
          c[a],
          c[a + 1],
          c[a + 2],
          c[a + 3],
          c[a + 4],
          c[a + 5],
          c[a + 6],
          c[a + 7],
        );
      else if (op === P_ARC)
        n.ctxArc(
          surface,
          c[a],
          c[a + 1],
          c[a + 2],
          c[a + 3],
          c[a + 4],
          !!c[a + 5],
        );
      else if (op === P_ELLIPSE)
        n.ctxEllipse(surface, c[a], c[a + 1], c[a + 2], c[a + 3]);
      i += 1 + P_ARGS[op];
    }
  }

  beginPath() {
    this._cmds.length = 0;
    this._pathStale = false;
    this._native.ctxBeginPath(this._s());
  }

  moveTo(x, y) {
    const surface = this._path();
    this._cmds.push(P_MOVE, x, y);
    this._native.ctxMoveTo(surface, x, y);
  }

  lineTo(x, y) {
    const surface = this._path();
    this._cmds.push(P_LINE, x, y);
    this._native.ctxLineTo(surface, x, y);
  }

  rect(x, y, w, h) {
    const surface = this._path();
    this._cmds.push(P_RECT, x, y, w, h);
    this._native.ctxRect(surface, x, y, w, h);
  }

  roundRect(x, y, w, h, radii) {
    let r = radii ?? 0;
    if (typeof r === 'number') r = [r, r, r, r];
    else if (r.length === 1) r = [r[0], r[0], r[0], r[0]];
    else if (r.length === 2) r = [r[0], r[1], r[0], r[1]];
    else if (r.length === 3) r = [r[0], r[1], r[2], r[1]];
    const cap = Math.min(Math.abs(w) / 2, Math.abs(h) / 2);
    const clamp = (v) => Math.max(0, Math.min(Number(v) || 0, cap));
    const surface = this._path();
    const [r0, r1, r2, r3] = [
      clamp(r[0]),
      clamp(r[1]),
      clamp(r[2]),
      clamp(r[3]),
    ];
    this._cmds.push(P_ROUND, x, y, w, h, r0, r1, r2, r3);
    this._native.ctxRoundRect(surface, x, y, w, h, r0, r1, r2, r3);
  }

  arc(x, y, radius, start, end, anticlockwise = false) {
    const surface = this._path();
    this._cmds.push(P_ARC, x, y, radius, start, end, anticlockwise ? 1 : 0);
    this._native.ctxArc(surface, x, y, radius, start, end, anticlockwise);
  }

  ellipse(x, y, rx, ry) {
    const surface = this._path();
    this._cmds.push(P_ELLIPSE, x, y, rx, ry);
    this._native.ctxEllipse(surface, x, y, rx, ry);
  }

  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    const surface = this._path();
    this._cmds.push(P_CURVE, c1x, c1y, c2x, c2y, x, y);
    this._native.ctxCurveTo(surface, c1x, c1y, c2x, c2y, x, y);
  }

  quadraticCurveTo(cx, cy, x, y) {
    const surface = this._path();
    this._cmds.push(P_QUAD, cx, cy, x, y);
    this._native.ctxQuadTo(surface, cx, cy, x, y);
  }

  closePath() {
    const surface = this._path();
    this._cmds.push(P_CLOSE);
    this._native.ctxClosePath(surface);
  }

  // --- painting ------------------------------------------------------------

  createLinearGradient(x0, y0, x1, y1) {
    return new LinearGradient(x0, y0, x1, y1);
  }

  createRadialGradient() {
    // radial paints flat until someone needs it; the stop list still works
    return new LinearGradient(0, 0, 0, 0);
  }

  _applyFill() {
    const [r, g, b, a] = parseColor(this._state.fillStyle);
    this._native.ctxSetFillColor(this._s(), r, g, b, a);
  }

  _applyStroke() {
    const [r, g, b, a] = parseColor(this._state.strokeStyle);
    this._native.ctxSetStrokeColor(this._s(), r, g, b, a);
  }

  /**
   * Replay an ntk/canvas Path2D (normalized M/L/C/Q/Z commands on `_cmds`)
   * into the native context path. The fill/stroke/clip overloads that take
   * a path argument route through this — ignoring the argument would run
   * the operation on whatever path a PREVIOUS painter left behind, which
   * is how a 44px SVG icon once filled a whole card with its accent.
   */
  _replayPath(path) {
    const cmds = path?._cmds;
    if (!Array.isArray(cmds)) return false;
    this.beginPath();
    for (const c of cmds) {
      if (c.type === 'M') this.moveTo(c.x, c.y);
      else if (c.type === 'L') this.lineTo(c.x, c.y);
      else if (c.type === 'C')
        this.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
      else if (c.type === 'Q') this.quadraticCurveTo(c.x1, c.y1, c.x, c.y);
      else if (c.type === 'Z') this.closePath();
    }
    return true;
  }

  /**
   * Whether a stroke of the current path may be split into several
   * `CGContextStrokePath` calls. Two things say no:
   *
   * - A hairline. At or below a device-space width of 1 CoreGraphics
   *   strokes through a path that is already linear in the subpath count
   *   — 2,000 rings cost 7ms whole — and splitting it is a 2x LOSS, the
   *   per-call setup with nothing to win back.
   * - Anything that composites. Each chunk paints separately, so where two
   *   subpaths' strokes overlap, a translucent ink, a globalAlpha or a
   *   shadow blends twice and reads darker where one call blends the union
   *   once. An opaque ink is exact everywhere the coverage is full, which
   *   is what the geometry that gets big looks like; what is left is the
   *   antialiased fringe at those same overlaps, half-covered twice
   *   instead of covered once, which reads a little lighter — the one
   *   difference `strokeChunking` exists to turn off.
   */
  _chunkableStroke() {
    if (!this._strokeChunking) return false;
    const st = this._state;
    const [a, b, c, d] = st.ctm;
    const scale = Math.sqrt(Math.abs(a * d - b * c));
    if (!(st.lineWidth * scale > 1)) return false;
    if (st.globalAlpha < 1) return false;
    if (parseColor(st.strokeStyle)[3] < 1) return false;
    if (st.shadowBlur > 0 && parseColor(st.shadowColor)[3] > 0) return false;
    return true;
  }

  /**
   * Stroke the recorded path as a series of chunks, cut at subpath
   * boundaries so every chunk carries the `moveTo` its segments start
   * from. Answers false when there was nothing to split, leaving the
   * native path untouched for the caller's single stroke.
   */
  _strokeChunks(surface) {
    if (!this._chunkableStroke()) return false;
    const cmds = this._cmds;
    const n = this._native;
    let start = 0;
    let points = 0;
    let subpaths = 0;
    let split = false;
    for (let i = 0; i < cmds.length;) {
      const op = cmds[i];
      if (
        op === P_MOVE &&
        i > start &&
        (points >= STROKE_CHUNK_POINTS || subpaths >= STROKE_CHUNK_SUBPATHS)
      ) {
        n.ctxBeginPath(surface);
        this._emit(surface, start, i);
        n.ctxStroke(surface);
        split = true;
        start = i;
        points = 0;
        subpaths = 0;
      }
      if (op === P_MOVE) subpaths++;
      points += P_POINTS[op];
      i += 1 + P_ARGS[op];
    }
    if (!split) return false;
    n.ctxBeginPath(surface);
    this._emit(surface, start, cmds.length);
    n.ctxStroke(surface);
    // the native path is the last chunk now; _path() puts the whole one
    // back if anything asks for it
    this._pathStale = true;
    return true;
  }

  fill(pathOrRule, maybeRule) {
    const hasPath = pathOrRule != null && typeof pathOrRule === 'object';
    const rule = hasPath ? maybeRule : pathOrRule;
    if (hasPath && !this._replayPath(pathOrRule)) return;
    this._path();
    const style = this._state.fillStyle;
    if (style instanceof LinearGradient) {
      const { coords, flat } = style._normalized();
      this._native.ctxFillLinearGradient(
        this._s(),
        coords[0],
        coords[1],
        coords[2],
        coords[3],
        flat,
      );
    } else {
      this._applyFill();
      this._native.ctxFill(this._s(), rule === 'evenodd');
    }
    this._dirty();
  }

  stroke(path) {
    if (path != null && typeof path === 'object' && !this._replayPath(path)) {
      return;
    }
    this._applyStroke();
    // one call per chunk where the path has enough subpaths to be worth it
    // — see P_MOVE and _chunkableStroke above — and one for everything
    // else. The chunks are issued from the record, so a stroke that splits
    // never pays for the restore a previous split owed: `_path()` is asked
    // for the surface only on the whole-path route.
    if (!this._strokeChunks(this._s())) {
      this._native.ctxStroke(this._path());
    }
    this._dirty();
  }

  clip(pathOrRule) {
    if (
      pathOrRule != null &&
      typeof pathOrRule === 'object' &&
      !this._replayPath(pathOrRule)
    ) {
      return;
    }
    this._native.ctxClip(this._path());
  }

  fillRect(x, y, w, h) {
    if (!(w > 0) || !(h > 0)) return;
    const style = this._state.fillStyle;
    if (style instanceof LinearGradient) {
      const { coords, flat } = style._normalized();
      this._native.ctxFillLinearGradient(
        this._s(),
        coords[0],
        coords[1],
        coords[2],
        coords[3],
        flat,
        x,
        y,
        w,
        h,
      );
    } else {
      this._applyFill();
      this._native.ctxFillRect(this._s(), x, y, w, h);
    }
    this._dirty();
  }

  fillRects(rects) {
    const flat = Array.isArray(rects?.[0]) ? rects.flat() : (rects ?? []);
    if (!flat.length) return;
    this._applyFill();
    this._native.ctxFillRects(this._s(), flat);
    this._dirty();
  }

  strokeRect(x, y, w, h) {
    this._applyStroke();
    this._native.ctxStrokeRect(this._s(), x, y, w, h);
    this._dirty();
  }

  clearRect(x, y, w, h) {
    this._native.ctxClearRect(this._s(), x, y, w, h);
    this._dirty();
  }

  drawImage(image, ...args) {
    const src = image?._surfaceHandle ?? image?._surface?._surfaceHandle;
    if (!src) return; // ntk Images/Pictures are not on this backend yet
    const size = this._native.surfaceSize(src);
    let sx = 0;
    let sy = 0;
    let sw = size.width;
    let sh = size.height;
    let dx;
    let dy;
    let dw;
    let dh;
    if (args.length >= 8) {
      [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    } else if (args.length >= 4) {
      [dx, dy, dw, dh] = args;
    } else {
      [dx, dy] = args;
      dw = sw;
      dh = sh;
    }
    this._native.ctxDrawSurface(this._s(), src, sx, sy, sw, sh, dx, dy, dw, dh);
    this._dirty();
  }

  /**
   * Browser contract: a blank RGBA pixel block for the caller to fill and
   * hand back to putImageData. Pure allocation — nothing touches the
   * surface — but it lives on the context because that is where every
   * canvas consumer looks for it (the Frame pane's mandelbrot does).
   */
  createImageData(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    return {
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    };
  }

  putImageData(data, x, y) {
    if (!data?.data) return;
    const buf = Buffer.isBuffer(data.data)
      ? data.data
      : Buffer.from(data.data.buffer ?? data.data);
    this._native.ctxPutImageData(
      this._s(),
      buf,
      data.width,
      data.height,
      Math.round(x),
      Math.round(y),
    );
    this._dirty();
  }

  /**
   * ntk's contract, not the browser's: with a callback it delivers
   * `(err, imageData)`; without one it returns a Promise. On X11 the read
   * is a server round trip, so every consumer in the tree is written
   * async — the configurator's screen capture, the pixel harness,
   * scripts/capture.js — and a backend that answered synchronously would
   * strand their callbacks unfired. The pixels are read at call time (the
   * surface only changes in the pump, which cannot run before a
   * microtask), the delivery is a tick later like a resolved promise's.
   */
  getImageData(x, y, w, h, cb) {
    const read = () => {
      const buf = this._native.ctxGetImageData(
        this._s(),
        Math.round(x),
        Math.round(y),
        Math.round(w),
        Math.round(h),
      );
      return {
        data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length),
        width: Math.round(w),
        height: Math.round(h),
      };
    };
    let result;
    let failure;
    try {
      result = read();
    } catch (err) {
      failure = err;
    }
    const promise = failure ? Promise.reject(failure) : Promise.resolve(result);
    if (typeof cb === 'function') {
      promise.then(
        (data) => cb(null, data),
        (err) => cb(err),
      );
      return undefined;
    }
    return promise;
  }

  // --- glyph runs (ntk's documented run contract) --------------------------

  /** ntk's Render extension object, as much of it as text needs. */
  get Render() {
    return RENDER;
  }

  createSolidPicture(r, g, b, a) {
    return new SolidPicture(r, g, b, a);
  }

  /**
   * Composite glyph runs — ntk's contract (its docs/text.md#glyph-runs),
   * so a renderer written against ntk's context runs here unchanged:
   * `positioned` is `[{ run: { font, size, glyphs: [{ id, ax, dx, dy }] },
   * x, y }]`, `x`/`y` the run's baseline origin in user space, the pen
   * starting at `x` and each glyph inking at `(pen + dx, y - dy)` — `dy`
   * y-up — before advancing by `ax`. `op` is `Render.PictOp.Over` or
   * `.Src`; `src` a `createSolidPicture` ink.
   *
   * The glyphs are grouped by face and size and go out as one native call
   * — `CTFontDrawGlyphs` per group, with the fill set to `src`'s colour —
   * so a frame of terminal text is one call per foreground colour.
   * `run.font` is a face from `fonts.match()`/`fallbackFor()`, or an ntk
   * `Font` from `openFont()` (resolved to CoreText from the same bytes, so
   * its glyph ids hold); a glyph carrying a `font` of its own — what
   * `shape()` produces when CoreText substituted a face — draws with that
   * face.
   *
   * One difference from ntk, stated: the transform applies to the glyphs as
   * well as to their origins, because CoreGraphics draws text through the
   * CTM like everything else, where ntk moves the origins and keeps the
   * advances in device pixels. Under a translate, which is what a node's
   * paint runs in, the two agree.
   */
  drawGlyphs(op, src, positioned) {
    if (!Array.isArray(positioned) || positioned.length === 0) return;
    const fonts = this._fonts;
    if (typeof fonts?._runHandle !== 'function') return;
    const batches = new Map(); // CTFont handle -> { font, glyphs, positions }
    for (const placed of positioned) {
      const run = placed?.run;
      const glyphs = run?.glyphs;
      if (!glyphs?.length) continue;
      const size = run.size;
      const runHandle = fonts._runHandle(run.font, size);
      let pen = 0;
      for (const g of glyphs) {
        const handle = g.font ? fonts._runHandle(g.font, size) : runHandle;
        if (handle) {
          let batch = batches.get(handle);
          if (!batch) {
            batch = { font: handle, glyphs: [], positions: [] };
            batches.set(handle, batch);
          }
          batch.glyphs.push(g.id);
          batch.positions.push(
            placed.x + pen + (g.dx || 0),
            placed.y - (g.dy || 0),
          );
        }
        pen += g.ax || 0;
      }
    }
    if (batches.size === 0) return;
    const [r, g, b, a] = this._inkOf(src);
    const surface = this._s();
    this._native.ctxSetFillColor(surface, r, g, b, a);
    const runs = [];
    for (const batch of batches.values()) {
      runs.push({
        font: batch.font,
        glyphs: Uint16Array.from(batch.glyphs),
        positions: Float64Array.from(batch.positions),
      });
    }
    this._native.ctxDrawGlyphs(surface, runs);
    this._dirty();
  }

  /**
   * The straight colour a `drawGlyphs` source paints with: a solid ink, a
   * CSS colour string, a straight `[r, g, b, a]` — or, for anything else
   * (a gradient, which glyph runs do not fill through here), the fill
   * style in force.
   */
  _inkOf(src) {
    if (src instanceof SolidPicture) return src._rgba;
    if (typeof src === 'string') return parseColor(src);
    if (Array.isArray(src) && src.length >= 3) {
      return [
        clamp01(src[0]),
        clamp01(src[1]),
        clamp01(src[2]),
        src.length > 3 ? clamp01(src[3]) : 1,
      ];
    }
    const style = this._state.fillStyle;
    return style instanceof LinearGradient ? BLACK : parseColor(style);
  }

  // --- text (minimal: enough for <canvas onDraw> users) --------------------

  _drawLayout(layout, x, y) {
    if (layout._contextInk) {
      const style = this._state.fillStyle;
      if (style instanceof LinearGradient) {
        const { coords, flat } = style._normalized();
        this._native.drawLayoutGradient(
          this._s(),
          layout._handle,
          x,
          y,
          coords[0],
          coords[1],
          coords[2],
          coords[3],
          flat,
        );
        this._dirty();
        return;
      }
      this._applyFill();
    }
    this._native.drawLayout(this._s(), layout._handle, x, y);
    this._dirty();
  }

  measureText(text) {
    const layout = this._fontLayout(text);
    return layout
      ? { width: layout.width }
      : { width: String(text).length * 7 };
  }

  fillText(text, x, y) {
    const layout = this._fontLayout(text);
    if (!layout) return;
    // canvas fillText's y is the baseline; layouts draw from their top
    const baseline = layout.lines[0]?.baseline ?? 0;
    this._drawLayout(layout, x, y - baseline);
  }

  _fontLayout(text, color) {
    const fonts = this._fonts;
    if (!fonts) return null;
    const m =
      /^(?:(italic|oblique)\s+)?(?:(\d{3}|bold)\s+)?(\d+(?:\.\d+)?)px\s+(.+)$/.exec(
        this._state.font,
      );
    const size = m ? Number(m[3]) : 12;
    const family = m ? m[4] : 'sans-serif';
    const weight = m?.[2] === 'bold' ? 700 : m?.[2] ? Number(m[2]) : 400;
    const style = m?.[1] ? 'italic' : 'normal';
    return fonts.layout(
      [{ text: String(text), family, size, weight, style, color }],
      { family, size, weight, style, color: color ?? '#000' },
      {},
    );
  }
}
