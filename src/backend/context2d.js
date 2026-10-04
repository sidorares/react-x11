// A canvas-shaped 2d context over a **verb table** — the drawing dialect
// every native backend answers, and the one place it is written down.
//
// This is macos.md §"The split" step 4, taken when a second native backend
// started: the class takes its `native` as a constructor argument and calls
// nothing else, so one wrapper drives @windowkit/appkit's CoreGraphics verbs
// and @windowkit/win32's Direct2D verbs alike. A bridge that lacks an
// optional verb is feature-detected (`ctxSetBlendMode`, `blitSurface`,
// `ctxDrawSymbol`) and degrades rather than throwing.
//
// **Wayland is deliberately not here.** src/wayland/context2d.js is not
// another copy of this file — it is a GLES rasterizer, wayland.md's Tier D,
// which implements the same dialect by drawing it rather than by forwarding
// it. The two are different layers, not duplicates, and folding one into the
// other would lose that.
//
// On the surface presenter this is the whole drawing path; on the layer
// presenter it stays as the fallback every painted-code node (<canvas>,
// <svg>, registered elements) rasters through — docs/macos.md §"Custom
// drawing on a layer tree".
//
// The native surface holds the real graphics state (paths, CTM, clip); this
// class keeps the JS-visible state (fillStyle strings, gradient objects,
// dash arrays) and re-syncs it when the backing surface is replaced after a
// resize — `_gen` is that generation.
import { cssColorStraight } from 'ntk/color';

import { normalizeRadii, planShadowTiles } from 'ntk/shadow-tiles';

import {
  filterColour,
  filterPixels,
  filterStops,
  filters,
  parseCanvasFilter,
} from './filter.js';
import { shadowTilesFor } from './shadowtiles.js';

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

/** Bytes as a Buffer over the same memory — for a view, its own window of
 * the ArrayBuffer, not the whole buffer from offset 0. */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(data);
}

// --- ntk Images as drawImage sources -----------------------------------------
//
// An ntk `Image` is straight RGBA in JS memory. On X, ntk uploads it to a
// pixmap per connection and caches that on the Image; here the upload is a
// CG bitmap made on the first draw and kept in this map, then composited
// through `ctxDrawSurface` like any surface, scaling and cropping included.
// The bridge's `ctxPutImageData` does the conversion — it premultiplies the
// straight bytes into the bitmap's BGRA (ByteOrder32Host + AlphaFirst) —
// so the bytes go over as the Image holds them.
//
// Images are immutable content (ntk's contract, and `<image>`'s), so an
// entry is never refreshed. The map is keyed weakly: an Image that is
// dropped takes its entry along and the handle's finalizer frees the
// bitmap; an owner that is done with one frees it on the call instead,
// through `releaseImageUpload` (the app's `releaseImage` seam).

/** Image -> { native, handle } */
const imageUploads = new WeakMap();

/** An ntk `Image`: the duck type `isDirectImageSource` and ntk's own
 * `drawImage` accept, plus the pixels this backend reads in place of the
 * picture. A bare `{ width, height, data }` is not one — `ImageData` is
 * written between draws, and caching it by identity would show stale
 * pixels. */
function isImagePixels(image) {
  const { width, height, data } = image;
  return (
    typeof image.picture === 'function' &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    data?.length === width * height * 4
  );
}

function uploadImage(native, image) {
  const held = imageUploads.get(image);
  if (held?.native === native) return held.handle;
  const { width, height } = image;
  const handle = native.createSurface(width, height, 1);
  native.ctxPutImageData(handle, toBuffer(image.data), width, height, 0, 0);
  imageUploads.set(image, { native, handle });
  return handle;
}

/** `drawImage`'s arguments as the eight numbers of its longest form, the
 *  source rect and then the destination, whichever form they came in. */
function imageRects(size, args) {
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
  return [sx, sy, sw, sh, dx, dy, dw, dh];
}

/** Free a bitmap of the context's own making now, on a bridge that can;
 *  an older one frees it with the handle's finalizer. */
function release(native, handle) {
  if (typeof native.releaseSurface === 'function') {
    native.releaseSurface(handle);
  }
}

/** Free an Image's bitmap now, if it has one; drawing it again uploads it
 * again, as ntk's `destroy()` promises for its own copies. */
export function releaseImageUpload(image) {
  const held = image != null && imageUploads.get(image);
  if (!held) return;
  imageUploads.delete(image);
  if (typeof held.native.releaseSurface === 'function') {
    held.native.releaseSurface(held.handle);
  }
}

const warnedSources = new Set();

/** A source this backend has no pixels for, said once per kind in
 * development — the alternative is an empty box and no reason. */
function warnUndrawable(image) {
  if (process.env.NODE_ENV === 'production') return;
  const kind =
    typeof image === 'object'
      ? (image.constructor?.name ?? 'object')
      : typeof image;
  if (warnedSources.has(kind)) return;
  warnedSources.add(kind);
  const serverSide = typeof image === 'object' && 'id' in image;
  const article = /^[aeiou]/i.test(kind) ? 'an' : 'a';
  console.warn(
    `react-x11: drawImage on the cocoa backend has no pixels for ${article} ${kind}, ` +
      'and draws nothing. ' +
      (serverSide
        ? 'It names an X server-side Picture or Drawable — <image picture>, ' +
          '<image drawable>, an ntk Picture — and this backend has no X ' +
          'server to composite from, so those are X11-only. Hand <image src> ' +
          'the pixels instead: encoded PNG/JPEG bytes, raw RGBA, or an ntk Image.'
        : 'This backend draws a Surface (react-x11/ntk) or an ntk Image; wrap ' +
          'raw RGBA as new Image({ width, height, data }).'),
  );
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

// What `textAlign`, `textBaseline` and `direction` take. A value outside
// them is ignored and the last one stays, as canvas has it.
const TEXT_ALIGNS = new Set(['start', 'end', 'left', 'right', 'center']);
const TEXT_BASELINES = new Set([
  'top',
  'hanging',
  'middle',
  'alphabetic',
  'ideographic',
  'bottom',
]);
const DIRECTIONS = new Set(['ltr', 'rtl', 'inherit']);

/**
 * The Render ops text draws with, numbered as XRender numbers them so a
 * caller's `ctx.Render?.PictOp?.Over ?? 3` reads the same on both
 * backends. The `op` a `drawGlyphs` call names is ignored here: the bridge
 * composites glyph coverage with the context's fill through the context's
 * own blend mode — `globalCompositeOperation`, below — and for the opaque
 * inks text uses Src and Over agree.
 */
const PICT_OP = Object.freeze({ Src: 1, Over: 3 });
const RENDER = Object.freeze({ PictOp: PICT_OP });

/**
 * `_state.clip` when the clip in force is not one this class can name — a
 * rounded corner, a glyph, an arc, or a rect under a rotation. Null means
 * nothing is clipped and a rect means that rect, in surface pixels; this
 * means "there is one and I cannot tell you where", which is the answer
 * that turns the memcpy blit off (see `_blit`).
 */
const NON_RECT = Symbol('non-rectangular clip');

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
/** A rounded rect whose corners are elliptical: x y w h, then each corner's
 *  x and y radius, top left first. A bridge answering `ctxRoundRectXY`
 *  reads it in `ctxPath` too; one that does not is sent the curves. */
const P_ROUND_XY = 9;
/** how many numbers each op carries, and what it costs a chunk's budget */
const P_ARGS = [2, 2, 6, 4, 0, 4, 8, 6, 4, 12];
const P_POINTS = [1, 1, 3, 2, 0, 4, 8, 8, 4, 8];

/** A quarter ellipse as one cubic: how far along each tangent its handles
 *  reach, as a fraction of the radius. */
const KAPPA = 0.5522847498307936;

/**
 * An elliptical-cornered rounded rect as lines and curves, through `to` —
 * a bridge with no `ctxRoundRectXY`. `c[a]…` is the op's twelve numbers.
 */
function roundRectCurves(to, c, a) {
  const x = c[a];
  const y = c[a + 1];
  const r = x + c[a + 2];
  const b = y + c[a + 3];
  const [tlx, tly, trx, tRy, brx, bry, blx, bly] = [
    c[a + 4],
    c[a + 5],
    c[a + 6],
    c[a + 7],
    c[a + 8],
    c[a + 9],
    c[a + 10],
    c[a + 11],
  ];
  to.move(x + tlx, y);
  to.line(r - trx, y);
  if (trx > 0 && tRy > 0) {
    to.curve(r - trx * (1 - KAPPA), y, r, y + tRy * (1 - KAPPA), r, y + tRy);
  }
  to.line(r, b - bry);
  if (brx > 0 && bry > 0) {
    to.curve(r, b - bry * (1 - KAPPA), r - brx * (1 - KAPPA), b, r - brx, b);
  }
  to.line(x + blx, b);
  if (blx > 0 && bly > 0) {
    to.curve(x + blx * (1 - KAPPA), b, x, b - bly * (1 - KAPPA), x, b - bly);
  }
  to.line(x, y + tly);
  if (tlx > 0 && tly > 0) {
    to.curve(x, y + tly * (1 - KAPPA), x + tlx * (1 - KAPPA), y, x + tlx, y);
  }
  to.close();
}

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

const SQUARE = Object.freeze([
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
]);

/**
 * The shape the recorded op at `i` draws, where it is one a shadow tile
 * knows — a `rect`, or a `roundRect` with circular or elliptical corners —
 * as `{ x, y, w, h, corners, end }`, `end` the index of the op after it;
 * null for any other op.
 */
function shapeAt(c, i) {
  const op = c[i];
  const end = i + 1 + P_ARGS[op];
  if (op === P_RECT) {
    let [x, y, w, h] = [c[i + 1], c[i + 2], c[i + 3], c[i + 4]];
    if (w < 0) ((x += w), (w = -w));
    if (h < 0) ((y += h), (h = -h));
    return { x, y, w, h, corners: SQUARE, end };
  }
  if (op === P_ROUND) {
    const r = (v) => ({ x: v, y: v });
    return {
      x: c[i + 1],
      y: c[i + 2],
      w: c[i + 3],
      h: c[i + 4],
      corners: [r(c[i + 5]), r(c[i + 6]), r(c[i + 7]), r(c[i + 8])],
      end,
    };
  }
  if (op === P_ROUND_XY) {
    const r = (j) => ({ x: c[i + j], y: c[i + j + 1] });
    return {
      x: c[i + 1],
      y: c[i + 2],
      w: c[i + 3],
      h: c[i + 4],
      corners: [r(5), r(7), r(9), r(11)],
      end,
    };
  }
  return null;
}

/** Whether shape `b` lies inside shape `a`'s box. */
function contains(a, b) {
  return (
    b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h
  );
}

/** Whether two `{ x, y, width, height }` rects share any area. */
function meets(a, b) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** The qualities `imageSmoothingQuality` takes, canvas's. */
const SMOOTHING_QUALITIES = new Set(['low', 'medium', 'high']);

/** What the bridge is told to resample with: the quality, or the nearest
 *  pixel where smoothing is off. */
const smoothingOf = (st) => (st.smoothing ? st.smoothingQuality : 'none');

/**
 * The off switch for shadow tiles (src/backend/shadowtiles.js): every
 * shadow drawn by the bridge, as before them. For measuring the tiles
 * against the live blur, and as first aid. Read once.
 */
const NO_SHADOW_TILES = process.env.REACT_X11_NO_SHADOW_TILES === '1';

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

export class BackendContext2D {
  /**
   * @param native the @windowkit/appkit module
   * @param surfaceOf () => current surface handle — the owner replaces the
   *   surface on resize, and this context follows it.
   * @param genOf () => surface generation number
   * @param options.readback whether the bitmap this context draws into can
   *   be read back while it is being drawn into, cheaply — a CPU bitmap, as
   *   every Cocoa surface is (`readbackSource`)
   */
  constructor(native, surfaceOf, genOf, { readback = false } = {}) {
    this._native = native;
    this._surfaceOf = surfaceOf;
    this._genOf = genOf;
    this._readback = readback;
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
      textAlign: 'start',
      textBaseline: 'alphabetic',
      direction: 'inherit',
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      shadowColor: 'rgba(0,0,0,0)',
      ctm: [1, 0, 0, 1, 0, 0],
      gco: 'source-over',
      // null: nothing clipped. A rect (surface pixels): that rect. NON_RECT:
      // a clip this class cannot name.
      clip: null,
      // how an image drawn scaled or turned is resampled
      smoothing: true,
      smoothingQuality: 'medium',
      // canvas's `filter` as it was set, and what it comes to
      // (src/backend/filter.js): null for none
      filter: 'none',
      filterInk: null,
    };
    // What this bridge can do, asked once. Both verbs arrived together in
    // @windowkit/appkit 0.7.0, and anything older is a bridge that draws
    // every composite as `source-over` through a CGImage — so the property
    // refuses what it cannot honour rather than lying about it, and the
    // blit path is simply never taken.
    this._blendModes = typeof native.ctxSetBlendMode === 'function';
    this._blits = typeof native.blitSurface === 'function';
    // and how an image is resampled, @windowkit/appkit 0.23.0's — asked
    // with `in` as well, as `ctxPath` is below: a test's bridge that answers
    // every name must not look like one that has it
    this._smoothing =
      'ctxSetImageSmoothing' in native &&
      typeof native.ctxSetImageSmoothing === 'function';
    // and what a filter is applied to pixels with: reading a surface and
    // writing one, which every Cocoa bridge has had since 0.4 — asked all
    // the same, so a bridge without them keeps `filter` at none
    this._filters = ['createSurface', 'ctxGetImageData', 'ctxPutImageData']
      .map((name) => name in native && typeof native[name] === 'function')
      .every(Boolean);
    this._onDirty = null;
    // the recorded path, and whether the native one still matches it (a
    // chunked stroke leaves only its last chunk behind)
    this._cmds = [];
    this._pathStale = false;
    // A bridge that takes a whole path in one call (`ctxPath`, the Windows
    // bridge's) is handed it that way when something paints it: the verbs
    // below only record. A graph's edges are tens of thousands of `lineTo`s
    // a frame, and a call across the boundary for each was milliseconds of
    // every frame spent on the crossing. A bridge without it is handed the
    // path a point at a time, as it is built, exactly as before.
    // Asked with `in` as well: a test's bridge that answers every name with
    // a no-op must not look like one that takes paths whole.
    this._bulkPaths =
      'ctxPath' in native && typeof native.ctxPath === 'function';
    this._pathBuf = null;
    this._strokeChunking = !NO_STROKE_CHUNKING;
    // Elliptical corners go over whole where the bridge takes them; the
    // count of them in the recorded path is what tells `_emit` whether a
    // whole path handed to `ctxPath` needs them spelled as curves first.
    this._roundXY =
      'ctxRoundRectXY' in native && typeof native.ctxRoundRectXY === 'function';
    this._xyOps = 0;
    this._shadowTiles = !NO_SHADOW_TILES;
  }

  /**
   * The bitmap this context draws into, as a source `drawImage` reads — for
   * a caller that keeps a few of its pixels before drawing over them and
   * puts them back after, which is how a rounded box clips its children
   * without a path clip (src/nodes/roundclip.js, issue #693). A `copy` of
   * it at a whole-pixel translate is `blitSurface`'s memcpy. Null where the
   * owner has not said the bitmap reads back cheaply while it is drawn
   * into: a GPU target is a different cost, and nobody has measured it.
   */
  readbackSource() {
    if (!this._readback) return null;
    const ctx = this;
    const { width, height } = this._native.surfaceSize(this._s());
    return {
      width,
      height,
      get _surfaceHandle() {
        return ctx._s();
      },
    };
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
      // a fresh surface is already at source-over, so only a context
      // holding another op has anything to say
      if (this._blendModes && st.gco !== 'source-over') {
        n.ctxSetBlendMode(surface, st.gco);
      }
      // and one made at 'medium', which a context starts at
      if (this._smoothing && smoothingOf(st) !== 'medium') {
        n.ctxSetImageSmoothing(surface, smoothingOf(st));
      }
      // a fresh surface is unclipped, whatever the old one had in force
      st.clip = null;
      this._stack.length = 0;
      // the path went with the surface it was built on; nothing may
      // replay it onto the new one
      this._cmds.length = 0;
      this._xyOps = 0;
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

  get globalCompositeOperation() {
    return this._state.gco;
  }

  /**
   * The vocabulary is the **bridge's**, not a table kept here: the names are
   * canvas's own, `ctxSetBlendMode` answers false for one it does not have,
   * and that answer is what decides whether the assignment sticks. So this
   * class never goes stale against a bridge that grows an op, and never
   * claims one it would not actually draw.
   *
   * Which makes the detection a caller writes canvas's own — an unknown
   * value is *ignored* there too, leaving the op in force — so the way to
   * ask is to assign and read back:
   *
   *     ctx.globalCompositeOperation = 'copy';
   *     if (ctx.globalCompositeOperation === 'copy') { ... }
   *
   * A bridge with no `ctxSetBlendMode` at all — @windowkit/appkit before
   * 0.7.0 — draws everything as source-over, so source-over is the one
   * value that sticks on it. That is exactly true rather than a fallback.
   *
   * One divergence from a browser, shared with ntk and so the same on both
   * backends: an op applies inside what the draw covers, not across the
   * whole surface. A browser's `copy` clears everything the drawing missed;
   * `kCGBlendModeCopy` and XRender's `Src` both leave it alone.
   */
  set globalCompositeOperation(value) {
    if (typeof value !== 'string') return;
    if (!this._blendModes) {
      if (value === 'source-over') this._state.gco = value;
      return;
    }
    // false is the bridge saying it left its own mode alone; anything else
    // means the mode is now `value`, and the two must not drift — a JS state
    // ahead of the native one would take the memcpy path in `_blit` for a
    // composite the fallback draw would have blended.
    if (this._native.ctxSetBlendMode(this._s(), value) === false) return;
    this._state.gco = value;
  }

  /**
   * Canvas's `imageSmoothingEnabled` and `imageSmoothingQuality`: how an
   * image or a surface drawn scaled or turned is resampled — the nearest
   * pixel with smoothing off, and otherwise `'low'`, which is bilinear,
   * `'medium'` or `'high'`. A context starts at `'medium'`, which is what
   * the bridge makes its contexts at, and not at canvas's `'low'`: an image
   * drawn small keeps the quality it was drawn at. Both are state `save`
   * and `restore` keep.
   *
   * On macOS `'medium'` resamples the whole source for a draw through a
   * matrix, whatever the clip, so a surface drawn a tile at a time through
   * a perspective — `<Html>`'s box out of the plane — costs each tile all
   * of it: 784 tiles of a 1400x1120 surface took 200 ms on an M1 Pro, and
   * 27 at `'low'` (windowkit/appkit#109).
   *
   * A bridge with no `ctxSetImageSmoothing` keeps both where they start,
   * so a caller learns whether an assignment took by reading it back, as
   * with `globalCompositeOperation`.
   */
  get imageSmoothingEnabled() {
    return this._state.smoothing;
  }

  set imageSmoothingEnabled(value) {
    if (!this._smoothing) return;
    // the surface first: a fresh one is told the state it is taking over
    const surface = this._s();
    this._state.smoothing = !!value;
    this._native.ctxSetImageSmoothing(surface, smoothingOf(this._state));
  }

  get imageSmoothingQuality() {
    return this._state.smoothingQuality;
  }

  set imageSmoothingQuality(value) {
    if (!this._smoothing || !SMOOTHING_QUALITIES.has(value)) return;
    const surface = this._s();
    this._state.smoothingQuality = value;
    this._native.ctxSetImageSmoothing(surface, smoothingOf(this._state));
  }

  /**
   * Canvas's `filter`: a CSS `<filter-value-list>` applied to everything
   * drawn after it, which `save` and `restore` keep. This context applies
   * the colour functions — `grayscale()`, `sepia()`, `saturate()`,
   * `hue-rotate()`, `invert()`, `brightness()`, `contrast()` — and
   * `opacity()` (src/backend/filter.js): a fill, a stroke, a gradient, a
   * glyph run and a symbol in the colours the filter makes of theirs; an
   * image, a surface and a text layout that carries colours of its own
   * through their pixels. A list with `blur()`, `drop-shadow()` or a
   * `url()` in it, or what is no list, does not stick, nor does any on a
   * bridge that cannot read a surface's pixels back: a caller knows
   * whether an assignment took by reading it back, as with
   * `globalCompositeOperation`. The value reads back as it was written.
   */
  get filter() {
    return this._state.filter;
  }

  set filter(value) {
    if (!this._filters) return;
    const ink = parseCanvasFilter(value);
    if (ink === undefined) return;
    this._state.filter = ink === null ? 'none' : String(value).trim();
    this._state.filterInk = filters(ink) ? ink : null;
  }

  /** A straight `[r, g, b, a]` as the filter in force draws it. */
  _ink(rgba) {
    const ink = this._state.filterInk;
    return ink ? filterColour(rgba, ink) : rgba;
  }

  /** A gradient's flat stops as the filter in force draws them. */
  _stops(flat) {
    const ink = this._state.filterInk;
    return ink ? filterStops(flat, ink) : flat;
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

  /** Where `fillText`'s x is on the text: its start, end, left, right or
   *  centre. */
  get textAlign() {
    return this._state.textAlign;
  }

  set textAlign(value) {
    if (TEXT_ALIGNS.has(value)) this._state.textAlign = value;
  }

  /** Where `fillText`'s y is on the text: its alphabetic baseline, or the
   *  top, middle or bottom of its em box, or its hanging or ideographic
   *  baseline. */
  get textBaseline() {
    return this._state.textBaseline;
  }

  set textBaseline(value) {
    if (TEXT_BASELINES.has(value)) this._state.textBaseline = value;
  }

  /** Which way `start` and `end` face. `inherit`, with no element to take
   *  it from, is the text's own: right to left where it starts so. */
  get direction() {
    return this._state.direction;
  }

  set direction(value) {
    if (DIRECTIONS.has(value)) this._state.direction = value;
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
    // the offset is state of its own, and a new pattern keeps it
    this._native.ctxSetLineDash(
      this._s(),
      this._state.dash,
      this._state.dashOffset,
    );
  }

  getLineDash() {
    return [...this._state.dash];
  }

  /**
   * Where along the pattern a stroke starts — the phase a marching dash
   * moves. Missing here, a caller that asks `'lineDashOffset' in ctx` found
   * no such thing and every stroke started its pattern at nought: the
   * dashes of an animated edge were repainted sixteen times a second and
   * never moved.
   */
  /**
   * Text drawn under a transform that scales is drawn scaled, glyphs and
   * all: both bridges lay a text layout out once and draw its outlines
   * through the context's matrix (Direct2D's `DrawTextLayout`, CoreText's
   * `CTFrameDraw`). ntk's context on X11 cannot — its glyphs come out of a
   * cache rasterized at the size they were shaped at, and a transform
   * moves where each lands, not how big it is — and says nothing, which is
   * the same answer. So an element that would rather draw a layout it has
   * than shape a new one at every step of a zoom asks this first.
   */
  get scalesText() {
    return true;
  }

  get lineDashOffset() {
    return this._state.dashOffset;
  }

  set lineDashOffset(value) {
    // canvas ignores anything that is not a finite number
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    this._state.dashOffset = value;
    this._native.ctxSetLineDash(this._s(), this._state.dash, value);
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
    if (this._bulkPaths) {
      if (this._xyOps > 0 && !this._roundXY) {
        // a bridge that does not read op 9 would stop at it
        n.ctxPath(surface, this._spelledPath(from, to));
        return;
      }
      // one call, through a buffer kept between paths — the record is the
      // same stream the bridge parses, arguments and all
      const count = to - from;
      if (count <= 0) return;
      let buf = this._pathBuf;
      if (!buf || buf.length < count) {
        buf = this._pathBuf = new Float64Array(
          Math.max(count, (buf?.length ?? 512) * 2),
        );
      }
      for (let i = 0; i < count; i++) buf[i] = c[from + i];
      n.ctxPath(surface, buf.subarray(0, count));
      return;
    }
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
      else if (op === P_ROUND_XY) this._emitRoundXY(surface, c, a);
      i += 1 + P_ARGS[op];
    }
  }

  /** The record `[from, to)` as a stream for a bridge that does not know
   *  op 9: each elliptical rounded rect spelled as the lines and curves
   *  it is, everything else as it was. */
  _spelledPath(from, to) {
    const c = this._cmds;
    const out = [];
    const spell = {
      move: (x, y) => out.push(P_MOVE, x, y),
      line: (x, y) => out.push(P_LINE, x, y),
      curve: (ax, ay, bx, by, x, y) => out.push(P_CURVE, ax, ay, bx, by, x, y),
      close: () => out.push(P_CLOSE),
    };
    for (let i = from; i < to;) {
      const op = c[i];
      const end = i + 1 + P_ARGS[op];
      if (op === P_ROUND_XY) roundRectCurves(spell, c, i + 1);
      else for (let j = i; j < end; j++) out.push(c[j]);
      i = end;
    }
    return new Float64Array(out);
  }

  beginPath() {
    this._cmds.length = 0;
    this._xyOps = 0;
    if (this._bulkPaths) {
      this._s();
      // uploaded, empty or not, when something paints it
      this._pathStale = true;
      return;
    }
    this._pathStale = false;
    this._native.ctxBeginPath(this._s());
  }

  /**
   * The surface to add a path command to now, or null where the path is
   * only recorded and handed over whole when painted (`_bulkPaths`). Either
   * way a fresh surface drops the path first, as `_s` has always done.
   */
  _pathFor() {
    if (!this._bulkPaths) return this._path();
    this._s();
    this._pathStale = true;
    return null;
  }

  moveTo(x, y) {
    const surface = this._pathFor();
    this._cmds.push(P_MOVE, x, y);
    if (surface !== null) this._native.ctxMoveTo(surface, x, y);
  }

  lineTo(x, y) {
    const surface = this._pathFor();
    this._cmds.push(P_LINE, x, y);
    if (surface !== null) this._native.ctxLineTo(surface, x, y);
  }

  rect(x, y, w, h) {
    const surface = this._pathFor();
    this._cmds.push(P_RECT, x, y, w, h);
    if (surface !== null) this._native.ctxRect(surface, x, y, w, h);
  }

  /**
   * Canvas's `roundRect`: `radii` a number, a `{ x, y }` point for an
   * elliptical corner, or a list of one to four of either, scaled down
   * together where two corners on a side would overlap (HTML, "roundRect").
   * Circular corners go to the bridge as they always did; elliptical ones
   * as `ctxRoundRectXY` where the bridge has it, and as curves where not.
   */
  roundRect(x, y, w, h, radii) {
    if (![x, y, w, h].every(Number.isFinite)) return;
    // an ellipse with no extent on one axis is no curve at all: the corner
    // is square, as the spec's arc of nothing leaves it
    let corners = normalizeRadii(Math.abs(w), Math.abs(h), radii).map((r) =>
      r.x > 0 && r.y > 0 ? r : { x: 0, y: 0 },
    );
    // a negative extent is the same box drawn from its other side: the
    // corners swap across the axis it runs back along
    if (w < 0) {
      x += w;
      w = -w;
      corners = [corners[1], corners[0], corners[3], corners[2]];
    }
    if (h < 0) {
      y += h;
      h = -h;
      corners = [corners[3], corners[2], corners[1], corners[0]];
    }
    const [tl, tr, br, bl] = corners;
    const surface = this._pathFor();
    if (tl.x === tl.y && tr.x === tr.y && br.x === br.y && bl.x === bl.y) {
      this._cmds.push(P_ROUND, x, y, w, h, tl.x, tr.x, br.x, bl.x);
      if (surface !== null)
        this._native.ctxRoundRect(surface, x, y, w, h, tl.x, tr.x, br.x, bl.x);
      return;
    }
    const at = this._cmds.length + 1;
    this._cmds.push(
      P_ROUND_XY,
      x,
      y,
      w,
      h,
      tl.x,
      tl.y,
      tr.x,
      tr.y,
      br.x,
      br.y,
      bl.x,
      bl.y,
    );
    this._xyOps++;
    if (surface !== null) this._emitRoundXY(surface, this._cmds, at);
  }

  /** One elliptical-cornered rounded rect, from the record at `a`, onto a
   *  bridge's path: whole where it takes one, as curves where not. */
  _emitRoundXY(surface, c, a) {
    const n = this._native;
    if (this._roundXY) {
      n.ctxRoundRectXY(
        surface,
        c[a],
        c[a + 1],
        c[a + 2],
        c[a + 3],
        c[a + 4],
        c[a + 5],
        c[a + 6],
        c[a + 7],
        c[a + 8],
        c[a + 9],
        c[a + 10],
        c[a + 11],
      );
      return;
    }
    roundRectCurves(
      {
        move: (px, py) => n.ctxMoveTo(surface, px, py),
        line: (px, py) => n.ctxLineTo(surface, px, py),
        curve: (ax, ay, bx, by, px, py) =>
          n.ctxCurveTo(surface, ax, ay, bx, by, px, py),
        close: () => n.ctxClosePath(surface),
      },
      c,
      a,
    );
  }

  arc(x, y, radius, start, end, anticlockwise = false) {
    const surface = this._pathFor();
    this._cmds.push(P_ARC, x, y, radius, start, end, anticlockwise ? 1 : 0);
    if (surface !== null)
      this._native.ctxArc(surface, x, y, radius, start, end, anticlockwise);
  }

  ellipse(x, y, rx, ry) {
    const surface = this._pathFor();
    this._cmds.push(P_ELLIPSE, x, y, rx, ry);
    if (surface !== null) this._native.ctxEllipse(surface, x, y, rx, ry);
  }

  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    const surface = this._pathFor();
    this._cmds.push(P_CURVE, c1x, c1y, c2x, c2y, x, y);
    if (surface !== null)
      this._native.ctxCurveTo(surface, c1x, c1y, c2x, c2y, x, y);
  }

  quadraticCurveTo(cx, cy, x, y) {
    const surface = this._pathFor();
    this._cmds.push(P_QUAD, cx, cy, x, y);
    if (surface !== null) this._native.ctxQuadTo(surface, cx, cy, x, y);
  }

  closePath() {
    const surface = this._pathFor();
    this._cmds.push(P_CLOSE);
    if (surface !== null) this._native.ctxClosePath(surface);
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
    const [r, g, b, a] = this._ink(parseColor(this._state.fillStyle));
    this._native.ctxSetFillColor(this._s(), r, g, b, a);
  }

  _applyStroke() {
    const [r, g, b, a] = this._ink(parseColor(this._state.strokeStyle));
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
    if (this._castsShadow() && this._tiledShadow(rule === 'evenodd')) {
      this._unshadowed(() => this._fillPath(rule));
    } else this._fillPath(rule);
    this._dirty();
  }

  _fillPath(rule) {
    this._path();
    const style = this._state.fillStyle;
    if (style instanceof LinearGradient) {
      const { coords, flat: stops } = style._normalized();
      const flat = this._stops(stops);
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
  }

  // --- shadows from tiles (src/backend/shadowtiles.js) -----------------------

  /** Whether what is filled now casts a blurred shadow a tile could draw:
   *  one there, in a colour, composited the ordinary way. */
  _castsShadow() {
    if (!this._shadowTiles) return false;
    const st = this._state;
    return (
      st.shadowBlur > 0 &&
      st.gco === 'source-over' &&
      parseColor(st.shadowColor)[3] > 0
    );
  }

  /**
   * The current path's shadow, from a tile, where the path is a shape a
   * tile draws: one `rect` or `roundRect`, or — filled `evenodd` — two of
   * them one inside the other, the frame an inset box shadow is cast
   * around. False for anything else, and the bridge draws it.
   */
  _tiledShadow(evenodd) {
    const c = this._cmds;
    const first = shapeAt(c, 0);
    if (!first) return false;
    if (first.end === c.length) return this._drawTiledShadow(first, null);
    if (!evenodd) return false;
    const second = shapeAt(c, first.end);
    if (!second || second.end !== c.length) return false;
    if (contains(first, second)) return this._drawTiledShadow(first, second);
    if (contains(second, first)) return this._drawTiledShadow(second, first);
    return false;
  }

  /**
   * Draw the shadow of `outer` — less `inner`, where there is one — from a
   * tile: in device pixels, moved by the shadow's offset, which, like its
   * blur, the transform does not scale (HTML, "shadows"). A transform
   * that rotates, skews or mirrors is not one a tile can follow.
   */
  _drawTiledShadow(outer, inner) {
    const st = this._state;
    const [a, b, c, d, e, f] = st.ctm;
    if (b !== 0 || c !== 0 || !(a > 0) || !(d > 0)) return false;
    const device = (r) => {
      const x0 = Math.round(a * r.x + e + st.shadowOffsetX);
      const y0 = Math.round(d * r.y + f + st.shadowOffsetY);
      return {
        x0,
        y0,
        x1: Math.round(a * (r.x + r.w) + e + st.shadowOffsetX),
        y1: Math.round(d * (r.y + r.h) + f + st.shadowOffsetY),
        corners: r.corners.map((k) => ({ x: k.x * a, y: k.y * d })),
      };
    };
    const o = device(outer);
    if (![o.x0, o.y0, o.x1, o.y1].every(Number.isFinite)) return false;
    // a shape with nothing in it casts nothing
    if (!(o.x1 > o.x0 && o.y1 > o.y0)) return true;
    let hole = inner && device(inner);
    if (hole && !(hole.x1 > hole.x0 && hole.y1 > hole.y0)) hole = null;
    const plan = planShadowTiles(o, hole, st.shadowBlur);
    if (!plan) return false;
    const clip = st.clip === NON_RECT ? null : st.clip;
    if (clip && !meets(plan.bounds, clip)) return true;
    // the shadow of what a filter's `opacity()` fades is faded with it;
    // its colour is the shadow's own, cast after the filter (canvas)
    const [sr, sg, sb, sa] = parseColor(st.shadowColor);
    const fade = st.filterInk?.alpha ?? 1;
    const tile = shadowTilesFor(this._native).get(plan, [
      sr,
      sg,
      sb,
      sa * fade,
    ]);
    if (tile == null) return false;
    const s = this._s();
    const n = this._native;
    n.ctxSave(s);
    n.ctxSetShadow(s, 0, 0, 0, 0, 0, 0, 0);
    for (const [sx, sy, sw, sh, dx, dy, dw, dh] of plan.pieces) {
      if (clip && !meets({ x: dx, y: dy, width: dw, height: dh }, clip))
        continue;
      n.ctxDrawSurface(
        s,
        tile,
        sx,
        sy,
        sw,
        sh,
        (dx - e) / a,
        (dy - f) / d,
        dw / a,
        dh / d,
      );
    }
    n.ctxRestore(s);
    // the shape is filled next, from the record: nothing above may have
    // left the bridge's own copy of the path as it was
    this._pathStale = true;
    return true;
  }

  /** `fn`'s drawing with no shadow: the tile has drawn it already. */
  _unshadowed(fn) {
    const s = this._s();
    this._native.ctxSave(s);
    this._native.ctxSetShadow(s, 0, 0, 0, 0, 0, 0, 0);
    fn();
    this._native.ctxRestore(s);
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

  /**
   * `clip()`, `clip(rule)`, `clip(path)`, `clip(path, rule)`, as canvas has
   * them and as `fill` takes them. The rule reaches the bridge as the flag
   * `ctxFill` takes: SvgView cuts to a `<clipPath>` with its `clip-rule`, and
   * a ring clipped `evenodd` by nonzero is a filled square. A bridge that
   * predates the flag ignores it and clips nonzero, as every bridge did.
   */
  clip(pathOrRule, maybeRule) {
    const hasPath = pathOrRule != null && typeof pathOrRule === 'object';
    const rule = hasPath ? maybeRule : pathOrRule;
    if (hasPath && !this._replayPath(pathOrRule)) return;
    this._state.clip = this._clipAfter();
    this._native.ctxClip(this._path(), rule === 'evenodd');
  }

  /**
   * The current path as a whole-pixel rect in surface coordinates, or null
   * for anything else. CoreGraphics owns the real clip and this is only a
   * shadow of it, kept for the one caller that draws *around* the context —
   * `_blit`, whose memcpy cannot see a CGContext's clip at all.
   *
   * So the answer has to be exact, never merely close: a rect that does not
   * land on whole pixels is refused rather than rounded, because rounding
   * out would copy pixels the clip excludes and rounding in would leave a
   * seam of whatever the destination held. The clips a paint pass actually
   * sets — the damage rect, a scroll viewport, a square-cornered `overflow`
   * — are whole pixels under a translate, and those are the ones this
   * recognises.
   *
   * It answers for either fill rule. One rect is one closed subpath, wound
   * once round everything inside it, so `evenodd` and `nonzero` cut the
   * same pixels; a path of more than one shape is never a rect here.
   */
  _pathRect() {
    const cmds = this._cmds;
    if (cmds.length !== 5 || cmds[0] !== P_RECT) return null;
    const [, x, y, w, h] = cmds;
    const [a, b, c, d, e, f] = this._state.ctm;
    if (b !== 0 || c !== 0) return null; // rotated or skewed: not a rect here
    const x0 = a * x + e;
    const y0 = d * y + f;
    const x1 = a * (x + w) + e;
    const y1 = d * (y + h) + f;
    const rect = {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0),
    };
    for (const v of [rect.x, rect.y, rect.width, rect.height]) {
      if (!Number.isInteger(v)) return null;
    }
    return rect;
  }

  /** The clip `clip()` is about to leave in force: the current one
   *  intersected with the path, or NON_RECT as soon as either is one. */
  _clipAfter() {
    const current = this._state.clip;
    if (current === NON_RECT) return NON_RECT;
    const rect = this._pathRect();
    if (!rect) return NON_RECT;
    if (!current) return rect;
    const x = Math.max(current.x, rect.x);
    const y = Math.max(current.y, rect.y);
    return {
      x,
      y,
      width: Math.max(
        0,
        Math.min(current.x + current.width, rect.x + rect.width) - x,
      ),
      height: Math.max(
        0,
        Math.min(current.y + current.height, rect.y + rect.height) - y,
      ),
    };
  }

  fillRect(x, y, w, h) {
    if (!(w > 0) || !(h > 0)) return;
    if (
      this._castsShadow() &&
      this._drawTiledShadow({ x, y, w, h, corners: SQUARE }, null)
    ) {
      this._unshadowed(() => this._fillRectNow(x, y, w, h));
    } else this._fillRectNow(x, y, w, h);
    this._dirty();
  }

  _fillRectNow(x, y, w, h) {
    const style = this._state.fillStyle;
    if (style instanceof LinearGradient) {
      const { coords, flat: stops } = style._normalized();
      const flat = this._stops(stops);
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

  /**
   * An SF Symbol by name, fitted into the rect and centred, in the fill
   * colour — `ctxDrawSymbol`, `@windowkit/appkit` 0.12.0. Answers false,
   * drawing nothing, for a name the system does not know and on a bridge
   * without the verb. `options` are the bridge's: `pointSize`, `weight`,
   * `scale`, `variableValue`.
   */
  drawSymbol(name, x, y, width, height, options) {
    if (typeof this._native.ctxDrawSymbol !== 'function') return false;
    this._applyFill();
    const drawn = this._native.ctxDrawSymbol(
      this._s(),
      name,
      x,
      y,
      width,
      height,
      options,
    );
    if (drawn) this._dirty();
    return drawn === true;
  }

  drawImage(image, ...args) {
    const src = this._sourceHandle(image);
    if (!src) return;
    const size = this._native.surfaceSize(src);
    const [sx, sy, sw, sh, dx, dy, dw, dh] = imageRects(size, args);
    const ink = this._state.filterInk;
    if (ink) {
      this._drawFiltered(src, size, [sx, sy, sw, sh, dx, dy, dw, dh], ink);
      return;
    }
    if (this._blit(src, sx, sy, sw, sh, dx, dy, dw, dh)) {
      // a row memcpy
    } else if (this._faded()) {
      this._native.ctxDrawSurfaceFaded(
        this._s(),
        src,
        sx,
        sy,
        sw,
        sh,
        dx,
        dy,
        dw,
        dh,
        this._state.globalAlpha,
      );
    } else {
      this._native.ctxDrawSurface(
        this._s(),
        src,
        sx,
        sy,
        sw,
        sh,
        dx,
        dy,
        dw,
        dh,
      );
    }
    this._dirty();
  }

  /**
   * `drawImage` under a filter: the whole pixels of the source the source
   * rect covers, read from the bridge as they are, run through the filter,
   * put on a bitmap of their own, and that drawn as the source would have
   * been — the filter set aside for the draw, which a blit, a fade and the
   * resampling an `imageSmoothingQuality` sets all take as before.
   */
  _drawFiltered(src, size, [sx, sy, sw, sh, dx, dy, dw, dh], ink) {
    const x0 = Math.max(0, Math.floor(sx));
    const y0 = Math.max(0, Math.floor(sy));
    const w = Math.min(size.width, Math.ceil(sx + sw)) - x0;
    const h = Math.min(size.height, Math.ceil(sy + sh)) - y0;
    if (!(w > 0 && h > 0)) return;
    const n = this._native;
    const pixels = n.ctxGetImageData(src, x0, y0, w, h);
    filterPixels(pixels, pixels, ink);
    const filtered = n.createSurface(w, h, 1);
    const st = this._state;
    try {
      n.ctxPutImageData(filtered, pixels, w, h, 0, 0);
      st.filterInk = null;
      this.drawImage(
        { _surfaceHandle: filtered },
        sx - x0,
        sy - y0,
        sw,
        sh,
        dx,
        dy,
        dw,
        dh,
      );
    } finally {
      st.filterInk = ink;
      release(n, filtered);
    }
  }

  /**
   * Whether a surface is drawn under this `globalAlpha` from its pixels
   * scaled by it (@windowkit/appkit's `ctxDrawSurfaceFaded`): where the
   * alpha is below 1, no shadow would ink, and the bridge has the verb.
   * CoreGraphics draws an image under an alpha below 1 at some fifteen times
   * what the same draw costs at 1 — a 556x300 surface 1.24ms against 0.09 —
   * so a group faded on a surface (`NodePaint._paintGroup`) cost more than
   * fading each thing in it; scaled first, the same colours within a unit
   * take 0.25ms (#810). A shadow is drawn from the image and the alpha
   * together, so a draw that casts one is left to the draw that always did.
   */
  _faded() {
    const st = this._state;
    if (!(st.globalAlpha < 1)) return false;
    if (typeof this._native.ctxDrawSurfaceFaded !== 'function') return false;
    return !(
      parseColor(st.shadowColor)[3] > 0 &&
      (st.shadowBlur > 0 || st.shadowOffsetX !== 0 || st.shadowOffsetY !== 0)
    );
  }

  /**
   * `true` where a surface drawn under a `globalAlpha` below 1 costs about
   * what it costs drawn at 1 — the macOS context, over a bridge with
   * `ctxDrawSurfaceFaded` — so that a group faded on a surface of its own,
   * as CSS `opacity` has it, is the cheaper way to fade what overlaps, and
   * not only the right one. Absent where that is not known: on Windows,
   * where Direct2D draws the bitmap with the opacity and nobody has
   * measured it, and on X11, whose server composites a surface under an
   * alpha in the request that composites it at all.
   */
  get fadesSurfacesCheaply() {
    return typeof this._native.ctxDrawSurfaceFaded === 'function' || undefined;
  }

  /**
   * The bitmap a `drawImage` source composites from: a surface's own, an
   * ntk Image's upload (made on its first draw, see `uploadImage`), or
   * none. A destroyed surface is none, silently — it had pixels once; any
   * other source is one this backend cannot draw at all, and development
   * says so once per kind.
   */
  _sourceHandle(image) {
    if (image == null) return null;
    if (typeof image === 'object') {
      if ('_surfaceHandle' in image || image._surface) {
        return image._surfaceHandle ?? image._surface?._surfaceHandle ?? null;
      }
      if (isImagePixels(image)) return uploadImage(this._native, image);
    }
    warnUndrawable(image);
    return null;
  }

  /**
   * `drawImage` as a row memcpy, for the one shape where a copy is all it
   * ever was: a surface composited into another at a translate, whole
   * pixels, same size in as out, under `globalCompositeOperation = 'copy'`.
   * Answers false for everything else, and the caller draws.
   *
   * That shape is what an element with a surface of its own presents every
   * frame — a terminal's grid, a retained scene — and the CoreGraphics
   * route to it is `CGBitmapContextCreateImage` of the whole source plus
   * `CGContextDrawImage`: 1.7ms of a 6ms frame for a 125x45 terminal, where
   * the memcpy is 1.0 (sidorares/react-x11-components#69 §6). The saving is
   * per frame rather than per flood, which is why the frame pacer (#497)
   * had to land first for it to be worth anything.
   *
   * Every condition below is a way the memcpy would differ from the draw,
   * and a difference is a bug rather than a slower frame — so each is a
   * refusal, never a fixup:
   *
   * - **the op.** Only `copy` writes the source over the destination
   *   without reading it. `source-over` is a blend, and blending is what
   *   CoreGraphics is for.
   * - **the transform.** A pure translate at whole pixels. A scale or a
   *   rotation resamples; a fractional offset resamples too (surfaces are
   *   created with `kCGInterpolationMedium`).
   * - **`globalAlpha`, and a shadow.** Both are things `CGContextDrawImage`
   *   does to the source on its way down that a memcpy does not do at all.
   * - **the clip.** A memcpy cannot see a CGContext's clip, so the rect it
   *   copies is intersected with the one this class tracked — and a clip it
   *   could not track (NON_RECT) means it does not know, so it draws.
   * - **the same surface twice.** Overlapping memcpy rows have no defined
   *   result. The check here is on the handle; the bridge's is on the
   *   backing store, which also catches two handles onto one bitmap — the
   *   two ends of a shared IOSurface — and throws rather than corrupting it.
   */
  _blit(src, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (!this._blits) return false;
    const st = this._state;
    if (st.gco !== 'copy') return false;
    if (st.clip === NON_RECT) return false;
    if (st.globalAlpha < 1) return false;
    if (st.shadowBlur > 0 && parseColor(st.shadowColor)[3] > 0) return false;
    if (sw !== dw || sh !== dh) return false;
    const [a, b, c, d, e, f] = st.ctm;
    if (a !== 1 || b !== 0 || c !== 0 || d !== 1) return false;
    const x = dx + e;
    const y = dy + f;
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      !Number.isInteger(sx) ||
      !Number.isInteger(sy) ||
      !Number.isInteger(sw) ||
      !Number.isInteger(sh)
    ) {
      return false;
    }
    const dst = this._s();
    if (dst === src) return false;
    const clip = st.clip;
    this._native.blitSurface(
      src,
      sx,
      sy,
      sw,
      sh,
      dst,
      x,
      y,
      clip ? [clip.x, clip.y, clip.width, clip.height] : null,
    );
    return true;
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
    this._native.ctxPutImageData(
      this._s(),
      toBuffer(data.data),
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
    const [r, g, b, a] = this._ink(this._inkOf(src));
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
    if (!layout._contextInk && this._state.filterInk) {
      this._drawLayoutFiltered(layout, x, y, this._state.filterInk);
      return;
    }
    if (layout._contextInk) {
      const style = this._state.fillStyle;
      if (style instanceof LinearGradient) {
        const { coords, flat: stops } = style._normalized();
        const flat = this._stops(stops);
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

  /**
   * A layout that carries colours of its own, under a filter: the bridge
   * sets its glyphs in them, so it is drawn on a bitmap of its own the size
   * of where it lands on the surface — its box through the transform, and
   * half its height more each way for ink past the box — through the same
   * transform, and the bitmap is run through the filter and drawn where it
   * came from.
   */
  _drawLayoutFiltered(layout, x, y, ink) {
    const st = this._state;
    const [a, b, c, d, e, f] = st.ctm;
    const pad = (layout.height || 0) / 2;
    const left = x - pad;
    const top = y - pad;
    const right = x + (layout.width || 0) + pad;
    const bottom = y + (layout.height || 0) + pad;
    let X0 = Infinity;
    let Y0 = Infinity;
    let X1 = -Infinity;
    let Y1 = -Infinity;
    for (const [px, py] of [
      [left, top],
      [right, top],
      [left, bottom],
      [right, bottom],
    ]) {
      const qx = a * px + c * py + e;
      const qy = b * px + d * py + f;
      X0 = Math.min(X0, qx);
      Y0 = Math.min(Y0, qy);
      X1 = Math.max(X1, qx);
      Y1 = Math.max(Y1, qy);
    }
    const size = this._native.surfaceSize(this._s());
    X0 = Math.max(0, Math.floor(X0));
    Y0 = Math.max(0, Math.floor(Y0));
    X1 = Math.min(size.width, Math.ceil(X1));
    Y1 = Math.min(size.height, Math.ceil(Y1));
    const w = X1 - X0;
    const h = Y1 - Y0;
    if (!(w > 0 && h > 0)) return;
    const n = this._native;
    const own = n.createSurface(w, h, 1);
    try {
      n.ctxTransform(own, a, b, c, d, e - X0, f - Y0);
      n.drawLayout(own, layout._handle, x, y);
      const pixels = n.ctxGetImageData(own, 0, 0, w, h);
      filterPixels(pixels, pixels, ink);
      n.ctxPutImageData(own, pixels, w, h, 0, 0);
      this.save();
      try {
        this._state.filterInk = null;
        this.setTransform(1, 0, 0, 1, 0, 0);
        this.drawImage({ _surfaceHandle: own }, X0, Y0);
      } finally {
        this.restore();
      }
    } finally {
      release(n, own);
    }
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
    // canvas fillText's y is on the baseline `textBaseline` names, and x on
    // the side `textAlign` does; a layout draws from its top left
    const line = layout.lines[0];
    const baseline = line?.baseline ?? 0;
    this._drawLayout(
      layout,
      x + this._alignOffset(layout, line),
      y - baseline + this._baselineOffset(line),
    );
  }

  /** How far left of x the text starts: ntk's `_alignOffset`, so a label
   *  centred on X11 is centred here too. */
  _alignOffset(layout, line) {
    let align = this._state.textAlign;
    if (align === 'start' || align === 'end') {
      const direction = this._state.direction;
      const rtl =
        direction === 'rtl' ||
        (direction === 'inherit' &&
          !!line?.runs?.find((r) => r.start === 0)?.rtl);
      align = (align === 'start') !== rtl ? 'left' : 'right';
    }
    const width = layout.width ?? 0;
    if (align === 'center') return -width / 2;
    if (align === 'right') return -width;
    return 0;
  }

  /** How far below y the alphabetic baseline is: ntk's `_baselineOffset`,
   *  from the face's ascent and descent. */
  _baselineOffset(line) {
    const ascent = line?.ascent ?? 0;
    const descent = line?.descent ?? 0;
    switch (this._state.textBaseline) {
      case 'top':
        return ascent;
      case 'hanging':
        return ascent * 0.8;
      case 'middle':
        return (ascent - descent) / 2;
      case 'bottom':
      case 'ideographic':
        return -descent;
      default:
        return 0;
    }
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
    // No colour unless the caller named one, which is what `_contextInk`
    // above is waiting for: a layout with no ink of its own is drawn with the
    // context's fill, the way `fillText` is defined to be. Defaulting the
    // base to black instead made every layout carry an ink, so `fillStyle`
    // was read, found to be irrelevant, and never applied — a `fillText`
    // under a white fill came out black on both backends.
    return fonts.layout(
      [{ text: String(text), family, size, weight, style, color }],
      { family, size, weight, style, color },
      {},
    );
  }
}
