// `filter` on the native 2d context: canvas's own property, a CSS
// `<filter-value-list>` (Filter Effects 1), and what this context makes of
// it — the colour functions, each a matrix over straight RGB with an
// offset that leaves alpha as it is, and `opacity()`, which scales alpha.
//
// They are the functions the context can apply to everything it draws.
// Each leaves alpha alone, so on premultiplied colour each is a linear map
// that commutes with source-over: a fill, a stroke, a gradient's stops, a
// glyph run's ink and a symbol's colour are filtered by filtering the colour
// they are drawn in, exactly. An image and a surface are filtered pixel by
// pixel, and a text layout that carries colours of its own on a surface of
// its own (src/backend/context2d.js). `blur()`, `drop-shadow()` and a
// `url()` reach past what is drawn, which a colour cannot say; this context
// does not apply them, so a list with one in it does not stick, and a
// caller knows from reading the property back.

/** A function's amount where none is written: all of the effect for the
 *  ones whose argument is how much of it to take, and none for the others
 *  (Filter Effects 1, 13). */
const AMOUNTS = {
  grayscale: 1,
  sepia: 1,
  invert: 1,
  opacity: 1,
  saturate: 1,
  brightness: 1,
  contrast: 1,
};

/** The functions this context applies; any other leaves a list unapplied. */
const COLOUR = new Set([...Object.keys(AMOUNTS), 'hue-rotate']);

const ANGLE_UNITS = {
  deg: 1,
  grad: 0.9,
  rad: 180 / Math.PI,
  turn: 360,
};

/**
 * A filter list as this context applies it: `{ matrices, alpha }`, the
 * colour matrices in the order written, each over straight RGB in 0–1 with
 * an offset — none for a function that changes no colour — and what alpha
 * is multiplied by. Null for `none`; undefined for what is no filter list,
 * or one with a function this context does not apply.
 */
export function parseCanvasFilter(value) {
  const text = String(value).trim();
  if (text.toLowerCase() === 'none') return null;
  const matrices = [];
  let alpha = 1;
  let rest = text;
  let seen = 0;
  while (rest.length) {
    const m = /^([a-z-]+)\(([^()]*)\)\s*/i.exec(rest);
    if (!m) return undefined;
    rest = rest.slice(m[0].length);
    seen += 1;
    const name = m[1].toLowerCase();
    if (!COLOUR.has(name)) return undefined;
    const arg = m[2].trim();
    if (name === 'hue-rotate') {
      const angle = arg ? angleOf(arg) : 0;
      if (angle === null) return undefined;
      const matrix = hueRotate(angle);
      if (matrix) matrices.push(matrix);
      continue;
    }
    const amount = arg ? amountOf(arg) : AMOUNTS[name];
    if (amount === null || amount < 0) return undefined;
    if (name === 'opacity') {
      alpha *= Math.min(1, amount);
      continue;
    }
    const matrix = matrixOf(name, amount);
    if (matrix) matrices.push(matrix);
  }
  if (!seen) return undefined;
  return { matrices, alpha };
}

/** Whether a parsed filter changes anything drawn. */
export function filters(filter) {
  return !!filter && (filter.matrices.length > 0 || filter.alpha < 1);
}

/** A number or a percentage of one. */
function amountOf(arg) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(arg);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] ? n / 100 : n;
}

/** An angle in degrees; a bare 0 is one. */
function angleOf(arg) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*)$/i.exec(arg);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!unit) return n === 0 ? 0 : null;
  const scale = ANGLE_UNITS[unit];
  return scale === undefined ? null : n * scale;
}

const unit = (a) => (a < 0 ? 0 : a > 1 ? 1 : a);

/** Three rows of red, green and blue weights and an offset, 0–1. */
function rows(r, g, b) {
  return Float64Array.of(...r, ...g, ...b);
}

/** `feComponentTransfer`'s `linear`: each channel times a slope, plus an
 *  intercept. */
function linear(slope, intercept) {
  return Float64Array.of(
    slope,
    0,
    0,
    intercept,
    0,
    slope,
    0,
    intercept,
    0,
    0,
    slope,
    intercept,
  );
}

/** One function's matrix (Filter Effects 1, 13); null where it changes no
 *  colour. */
function matrixOf(name, amount) {
  switch (name) {
    case 'grayscale': {
      const a = unit(amount);
      if (a === 0) return null;
      const k = 1 - a;
      return rows(
        [0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k, 0],
        [0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k, 0],
        [0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k, 0],
      );
    }
    case 'sepia': {
      const a = unit(amount);
      if (a === 0) return null;
      const k = 1 - a;
      return rows(
        [0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k, 0],
        [0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k, 0],
        [0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k, 0],
      );
    }
    case 'saturate': {
      const s = amount;
      if (s === 1) return null;
      return rows(
        [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0],
        [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0],
        [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0],
      );
    }
    case 'brightness':
      return amount === 1 ? null : linear(amount, 0);
    case 'contrast':
      return amount === 1 ? null : linear(amount, 0.5 - 0.5 * amount);
    case 'invert': {
      const a = unit(amount);
      return a === 0 ? null : linear(1 - 2 * a, a);
    }
  }
  return null;
}

function hueRotate(degrees) {
  if (degrees % 360 === 0) return null;
  const t = (degrees * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return rows(
    [
      0.213 + c * 0.787 - s * 0.213,
      0.715 - c * 0.715 - s * 0.715,
      0.072 - c * 0.072 + s * 0.928,
      0,
    ],
    [
      0.213 - c * 0.213 + s * 0.143,
      0.715 + c * 0.285 + s * 0.14,
      0.072 - c * 0.072 - s * 0.283,
      0,
    ],
    [
      0.213 - c * 0.213 - s * 0.787,
      0.715 - c * 0.715 + s * 0.715,
      0.072 + c * 0.928 + s * 0.072,
      0,
    ],
  );
}

/** A straight `[r, g, b, a]`, 0–1, through the filter: each function's
 *  result clamped before the next, as each one's is. */
export function filterColour([r, g, b, a], filter) {
  for (const m of filter.matrices) {
    const r1 = m[0] * r + m[1] * g + m[2] * b + m[3];
    const g1 = m[4] * r + m[5] * g + m[6] * b + m[7];
    const b1 = m[8] * r + m[9] * g + m[10] * b + m[11];
    r = unit(r1);
    g = unit(g1);
    b = unit(b1);
  }
  return [r, g, b, a * filter.alpha];
}

/** A gradient's stops, flat as `[offset, r, g, b, a, …]`, through the
 *  filter: interpolating straight colours commutes with a matrix over them,
 *  but for what a clamp cuts off between two stops. */
export function filterStops(flat, filter) {
  const out = flat.slice();
  for (let i = 0; i + 4 < out.length; i += 5) {
    const [r, g, b, a] = filterColour(
      [out[i + 1], out[i + 2], out[i + 3], out[i + 4]],
      filter,
    );
    out[i + 1] = r;
    out[i + 2] = g;
    out[i + 3] = b;
    out[i + 4] = a;
  }
  return out;
}

/**
 * Straight RGBA pixels, 0–255, through the filter, `src` into `dst` — the
 * two may be one. A pixel with no alpha keeps none: its colour is no
 * colour.
 */
export function filterPixels(src, dst, filter) {
  const { matrices } = filter;
  const fade = filter.alpha;
  const one = matrices.length === 1 ? matrices[0] : null;
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 0) {
      dst[i] = 0;
      dst[i + 1] = 0;
      dst[i + 2] = 0;
      dst[i + 3] = 0;
      continue;
    }
    let r = src[i];
    let g = src[i + 1];
    let b = src[i + 2];
    if (one) {
      const m = one;
      const r1 = m[0] * r + m[1] * g + m[2] * b + m[3] * 255;
      const g1 = m[4] * r + m[5] * g + m[6] * b + m[7] * 255;
      const b1 = m[8] * r + m[9] * g + m[10] * b + m[11] * 255;
      r = r1;
      g = g1;
      b = b1;
    } else {
      for (const m of matrices) {
        const r1 = m[0] * r + m[1] * g + m[2] * b + m[3] * 255;
        const g1 = m[4] * r + m[5] * g + m[6] * b + m[7] * 255;
        const b1 = m[8] * r + m[9] * g + m[10] * b + m[11] * 255;
        r = r1 < 0 ? 0 : r1 > 255 ? 255 : r1;
        g = g1 < 0 ? 0 : g1 > 255 ? 255 : g1;
        b = b1 < 0 ? 0 : b1 > 255 ? 255 : b1;
      }
    }
    dst[i] = clampByte(r);
    dst[i + 1] = clampByte(g);
    dst[i + 2] = clampByte(b);
    dst[i + 3] = fade === 1 ? a : clampByte(a * fade);
  }
}

function clampByte(v) {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}
