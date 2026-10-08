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
// its own (src/backend/context2d.js). `drop-shadow()` and a `url()` reach
// past what is drawn, which a colour cannot say; this context does not
// apply them, so a list with one in it does not stick, and a caller knows
// from reading the property back.
//
// `blur()` reaches past what is drawn too, and is applied to an image or a
// surface drawn — `drawImage`, what a renderer composites a layer of its
// own with, CSS's `backdrop-filter` among them — by blurring its pixels
// (`blurPixels`). A fill, a stroke and text are drawn sharp under it, in
// the colours the rest of the list makes. Its standard deviation is in the
// units `drawImage`'s destination is given in. Several `blur()`s are one,
// the root of the sum of their squares, as two Gaussians make one; and each
// colour function here is a linear map on premultiplied colour, which a
// blur, a weighted sum of premultiplied pixels, commutes with, so where in
// the list a blur is written changes nothing but where the clamps fall.

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
 * A filter list as this context applies it: `{ matrices, alpha, blur }`,
 * the colour matrices in the order written, each over straight RGB in 0–1
 * with an offset — none for a function that changes no colour — what alpha
 * is multiplied by, and the standard deviation of the blur, 0 for none.
 * Null for `none`; undefined for what is no filter list, or one with a
 * function this context does not apply.
 */
export function parseCanvasFilter(value) {
  const text = String(value).trim();
  if (text.toLowerCase() === 'none') return null;
  const matrices = [];
  let alpha = 1;
  let blur2 = 0;
  let rest = text;
  let seen = 0;
  while (rest.length) {
    const m = /^([a-z-]+)\(([^()]*)\)\s*/i.exec(rest);
    if (!m) return undefined;
    rest = rest.slice(m[0].length);
    seen += 1;
    const name = m[1].toLowerCase();
    const arg = m[2].trim();
    if (name === 'blur') {
      const radius = arg ? lengthOf(arg) : 0;
      if (radius === null || radius < 0) return undefined;
      blur2 += radius * radius;
      continue;
    }
    if (!COLOUR.has(name)) return undefined;
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
  return { matrices, alpha, blur: Math.sqrt(blur2) };
}

/** Whether a parsed filter changes anything drawn. */
export function filters(filter) {
  return (
    !!filter &&
    (filter.matrices.length > 0 || filter.alpha < 1 || filter.blur > 0)
  );
}

/** A length in pixels; a bare 0 is one. */
function lengthOf(arg) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px)?$/i.exec(arg);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] || n === 0 ? n : null;
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

/**
 * Straight RGBA pixels, 0–255, `width` by `height`, blurred in place by a
 * Gaussian of standard deviation `sigma` pixels: three box blurs across and
 * three down, each as wide as the Gaussian they come to (Kovesi, "Fast
 * almost-Gaussian filtering", 2010), on premultiplied colour — a blur of
 * straight colour bleeds the colour of what is transparent into its edge —
 * with nothing past the edge, as canvas has it.
 */
export function blurPixels(pixels, width, height, sigma) {
  if (!(sigma > 0) || !(width > 0 && height > 0)) return;
  const n = width * height;
  // premultiplied, the four channels of a pixel side by side
  const plane = new Float32Array(n * 4);
  for (let p = 0; p < n * 4; p += 4) {
    const alpha = pixels[p + 3] / 255;
    plane[p] = pixels[p] * alpha;
    plane[p + 1] = pixels[p + 1] * alpha;
    plane[p + 2] = pixels[p + 2] * alpha;
    plane[p + 3] = pixels[p + 3];
  }
  const line = new Float32Array(Math.max(width, height) * 4);
  for (const radius of boxRadii(sigma)) {
    if (radius < 1) continue;
    boxPass(plane, width, height, radius, 4, width * 4, line);
    boxPass(plane, height, width, radius, width * 4, 4, line);
  }
  for (let p = 0; p < n * 4; p += 4) {
    const alpha = plane[p + 3];
    if (alpha <= 0.5) {
      pixels[p] = pixels[p + 1] = pixels[p + 2] = pixels[p + 3] = 0;
      continue;
    }
    const k = 255 / alpha;
    pixels[p] = clampByte(plane[p] * k);
    pixels[p + 1] = clampByte(plane[p + 1] * k);
    pixels[p + 2] = clampByte(plane[p + 2] * k);
    pixels[p + 3] = clampByte(alpha);
  }
}

/** The radii of three box blurs that come to a Gaussian of `sigma`. */
function boxRadii(sigma) {
  const passes = 3;
  const ideal = Math.sqrt((12 * sigma * sigma) / passes + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower -= 1;
  const upper = lower + 2;
  const m = Math.round(
    (12 * sigma * sigma -
      passes * lower * lower -
      4 * passes * lower -
      3 * passes) /
      (-4 * lower - 4),
  );
  const out = [];
  for (let i = 0; i < passes; i += 1) {
    out.push(((i < m ? lower : upper) - 1) / 2);
  }
  return out;
}

/**
 * One box blur of `radius` along every line of a plane of RGBA pixels:
 * `lines` lines of `length` pixels, a pixel `step` values from the next
 * along a line and a line `stride` values from the next. Past either end
 * is nothing.
 */
function boxPass(plane, length, lines, radius, step, stride, line) {
  const scale = 1 / (2 * radius + 1);
  for (let l = 0; l < lines; l += 1) {
    const base = l * stride;
    for (let i = 0, q = base; i < length; i += 1, q += step) {
      const o = i * 4;
      line[o] = plane[q];
      line[o + 1] = plane[q + 1];
      line[o + 2] = plane[q + 2];
      line[o + 3] = plane[q + 3];
    }
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let i = 0; i <= radius && i < length; i += 1) {
      const o = i * 4;
      r += line[o];
      g += line[o + 1];
      b += line[o + 2];
      a += line[o + 3];
    }
    for (let i = 0, q = base; i < length; i += 1, q += step) {
      plane[q] = r * scale;
      plane[q + 1] = g * scale;
      plane[q + 2] = b * scale;
      plane[q + 3] = a * scale;
      const enter = i + radius + 1;
      if (enter < length) {
        const o = enter * 4;
        r += line[o];
        g += line[o + 1];
        b += line[o + 2];
        a += line[o + 3];
      }
      const leave = i - radius;
      if (leave >= 0) {
        const o = leave * 4;
        r -= line[o];
        g -= line[o + 1];
        b -= line[o + 2];
        a -= line[o + 3];
      }
    }
  }
}
