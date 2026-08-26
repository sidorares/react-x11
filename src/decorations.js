// The two decorations that are not a colour: the gradient behind a box
// (`backgroundImage`) and the shadow under it (`boxShadow`). Both are pure
// here — strings in, numbers out — so the renderer half in `nodes.js` is
// only geometry and compositing, and the parsing can be tested without a
// server (issue #345).
//
// ## Why they are strings
//
// Every other paint property in this vocabulary is a number or a colour,
// and an object (`{ from, to, angle }`) would have been the house shape.
// These two are strings because a gradient and a shadow are the two style
// values people already know by heart in CSS's spelling, because a state
// block wants to overwrite the whole decoration at once rather than merge
// half an object into it, and because `linear-gradient(#2b5876, #4e4376)`
// pastes out of a design tool. Parsing is memoized per string, so the cost
// of the choice is one Map lookup per painted frame.
//
// ## What is deliberately not here
//
// - `radial-gradient` / `conic-gradient`: RENDER has both and ntk exposes
//   them, but CSS's sizing keywords (`closest-side`, `farthest-corner`, an
//   ellipse with two radii and a position) are most of the work and none of
//   the demand. `linear-gradient` is what a header, a card and a selected
//   row are made of.
// - `inset` shadows: a different drawing (the coverage is the box *minus*
//   the blurred rect) and a different damage story, since an inset shadow
//   never leaves the node. Rejected loudly rather than ignored — see
//   `parseBoxShadow` — because silently painting an outer shadow where an
//   inner one was asked for is a bug the author cannot see the cause of.
// - `textShadow`: per glyph, through the glyph cache, and much rarer in a
//   desktop UI.

// The kernel maths is ntk's: `blurCoverage` runs the blur, so the reach it
// derives is the padding a coverage surface has to carry. Both are pure
// functions — no connection, nothing drawn — so this module stays testable
// without a server.
import { shadowReach, shadowSigma } from 'ntk';

/** A number, with or without the `px` CSS wants and this vocabulary does not. */
const LENGTH = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:px)?$/i;
/** …and the same thing as a percentage, which colour stops also take. */
const PERCENT = /^[+-]?(?:\d+\.?\d*|\.\d+)%$/;
const ANGLE = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)$/i;

const TO_ANGLE = { top: 0, right: 90, bottom: 180, left: 270 };
const VERTICAL = new Set(['top', 'bottom']);
const HORIZONTAL = new Set(['left', 'right']);

/**
 * Split on `,` or on whitespace, but only at the top level: a stop is
 * `rgba(0, 0, 0, .4)` as often as it is `#333`, and every naive split on
 * this vocabulary gets that wrong.
 */
function splitTop(text, byComma) {
  const out = [];
  let depth = 0;
  let start = 0;
  const push = (end) => {
    const piece = text.slice(start, end).trim();
    if (byComma || piece) out.push(piece);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (
      depth === 0 &&
      (byComma ? ch === ',' : ch === ' ' || ch === '\t')
    ) {
      push(i);
      start = i + 1;
    }
  }
  push(text.length);
  return out;
}

const number = (text) => parseFloat(text);

function toDegrees(value, unit) {
  switch (unit.toLowerCase()) {
    case 'deg':
      return value;
    case 'grad':
      return (value * 360) / 400;
    case 'rad':
      return (value * 180) / Math.PI;
    default:
      return value * 360; // turn
  }
}

/**
 * `linear-gradient(...)` → `{ angle, corner, stops }`, or null for `none`
 * and for a value that is not a gradient at all.
 *
 * `angle` is CSS's: degrees clockwise from "up", so `180deg` is `to bottom`,
 * which is also the default when a value names no direction. `corner` is
 * `'top right'` and friends, which cannot become an angle until the box is
 * known — the corner keywords are defined so that the gradient line is
 * perpendicular to the box's *other* diagonal, and that depends on the
 * aspect ratio (see `linearGradientGeometry`).
 *
 * Stops keep their authored position (`{ value, unit }`) or `null` for one
 * that was left out; distributing those needs the gradient line's length,
 * which is again the box's business.
 *
 * Throws on a malformed value rather than dropping it: a gradient that does
 * not paint is a blank panel, and "why is my header empty" is a much worse
 * afternoon than an error naming the property.
 */
export function parseLinearGradient(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text === 'none') return null;
  const open = text.indexOf('(');
  const name = open === -1 ? text : text.slice(0, open).trim();
  if (name !== 'linear-gradient') {
    throw new Error(
      `react-x11: backgroundImage ${JSON.stringify(value)} is not supported ` +
        "(expected linear-gradient(…) or 'none'). url() images belong on " +
        '<image src>, and a radial or conic gradient on a <canvas onDraw>.',
    );
  }
  if (!text.endsWith(')')) {
    throw new Error(
      `react-x11: backgroundImage ${JSON.stringify(value)} is missing its ` +
        'closing parenthesis',
    );
  }
  const parts = splitTop(text.slice(open + 1, -1), true);
  let angle = null;
  let corner = null;
  const first = parts[0] ?? '';
  const asAngle = ANGLE.exec(first);
  if (asAngle) {
    angle = toDegrees(number(asAngle[1]), asAngle[2]);
    parts.shift();
  } else if (first.startsWith('to ') || first === 'to') {
    const sides = splitTop(first.slice(2), false);
    corner = readSides(sides, value);
    if (typeof corner === 'number') {
      angle = corner;
      corner = null;
    }
    parts.shift();
  }
  const stops = parts.map((part) => readStop(part, value));
  if (stops.length < 2) {
    throw new Error(
      `react-x11: backgroundImage ${JSON.stringify(value)} needs at least ` +
        'two colour stops',
    );
  }
  return { angle: angle ?? (corner ? null : TO_ANGLE.bottom), corner, stops };
}

/** `to bottom` → 180; `to bottom right` → the corner it names. */
function readSides(sides, value) {
  const bad = () =>
    new Error(
      `react-x11: backgroundImage ${JSON.stringify(value)} has an unusable ` +
        "direction (expected 'to top', 'to bottom right', … or an angle " +
        "like '135deg')",
    );
  if (sides.length === 1) {
    const one = TO_ANGLE[sides[0]];
    if (one === undefined) throw bad();
    return one;
  }
  if (sides.length !== 2) throw bad();
  const [a, b] = sides;
  const vertical = VERTICAL.has(a) ? a : VERTICAL.has(b) ? b : null;
  const horizontal = HORIZONTAL.has(a) ? a : HORIZONTAL.has(b) ? b : null;
  if (!vertical || !horizontal) throw bad();
  return `${vertical} ${horizontal}`;
}

/** `#333`, `$accent 40%`, `rgba(0, 0, 0, .4) 12px`. */
function readStop(part, value) {
  if (!part) {
    throw new Error(
      `react-x11: backgroundImage ${JSON.stringify(value)} has an empty ` +
        'colour stop',
    );
  }
  const pieces = splitTop(part, false);
  const last = pieces[pieces.length - 1];
  if (pieces.length === 1 && (PERCENT.test(last) || LENGTH.test(last))) {
    // CSS's *colour hint* — a bare position between two stops that moves the
    // midpoint of the blend. It is a curve, not a stop, and RENDER has no
    // way to express one; two stops either side say the same thing.
    throw new Error(
      `react-x11: backgroundImage ${JSON.stringify(value)} uses a colour ` +
        `hint ("${last}"), which is not supported — name the colour at that ` +
        'position instead.',
    );
  }
  if (pieces.length > 1 && (PERCENT.test(last) || LENGTH.test(last))) {
    pieces.pop();
    return {
      color: pieces.join(' '),
      position: { value: number(last), unit: PERCENT.test(last) ? '%' : 'px' },
    };
  }
  return { color: part, position: null };
}

/**
 * Where the gradient line runs for this box, and the stops along it — the
 * whole of what `ctx.createLinearGradient` and `addColorStop` need.
 *
 * CSS's geometry, which is not the obvious one: the line passes through the
 * box's centre at the given angle, and its length is the box's *projection*
 * onto it (`|w·sinθ| + |h·cosθ|`), so that the two corners nearest each end
 * land exactly on the end colours. That is what makes `135deg` on a wide
 * header look the way it does in a browser instead of running out a third of
 * the way across.
 *
 * ### The padding, and why it is not cosmetic
 *
 * Past its last stop an XRender gradient is **transparent**, not clamped:
 * `RepeatPad` is a picture attribute the gradient path does not set today
 * (sidorares/ntk#271, and the `TODO` in ntk's own `CanvasGradient`). CSS and
 * canvas both clamp. So the line is extended by `pad` device pixels at each
 * end and the stop offsets are remapped onto the longer line, with the end
 * colours pinned at 0 and 1 — which *is* pad semantics, expressed in stops.
 * Two pixels would do for the float noise at a corner; the width here also
 * covers a caller that rounds the rect it fills after asking for the
 * geometry.
 *
 * Note that this cannot be caught by a pixel test against the in-process X
 * server: node-x11's RENDER pads by construction (`gradientAt` clamps to the
 * edge stops), where a real server does not. `test/decorations.test.js`
 * asserts the stops instead, which is the part that is ours.
 *
 * Returns null for a box with no area, which has no gradient line at all.
 */
export function linearGradientGeometry(spec, rect, pad = 4) {
  const { width, height } = rect;
  if (!(width > 0) || !(height > 0)) return null;
  const degrees = spec.corner
    ? cornerAngle(spec.corner, width, height)
    : spec.angle;
  const theta = (degrees * Math.PI) / 180;
  // 0° points up and angles run clockwise, so the direction vector is
  // (sin, -cos) in a coordinate system whose y grows downwards
  const dx = Math.sin(theta);
  const dy = -Math.cos(theta);
  const length = Math.abs(width * dx) + Math.abs(height * dy);
  if (!(length > 0)) return null;
  const cx = rect.x + width / 2;
  const cy = rect.y + height / 2;
  const half = length / 2;
  const offsets = resolveStopOffsets(spec.stops, length);
  const total = length + pad * 2;
  const stops = [];
  if (pad > 0) stops.push([0, spec.stops[0].color]);
  for (let i = 0; i < spec.stops.length; i++) {
    stops.push([(pad + offsets[i] * length) / total, spec.stops[i].color]);
  }
  if (pad > 0) stops.push([1, spec.stops[spec.stops.length - 1].color]);
  return {
    x0: cx - dx * (half + pad),
    y0: cy - dy * (half + pad),
    x1: cx + dx * (half + pad),
    y1: cy + dy * (half + pad),
    stops,
  };
}

/**
 * The magic angle behind `to bottom right`: the gradient line is turned so
 * that a perpendicular through it passes through the two *other* corners, so
 * a square gives 45° and a wide box tends towards `to right`.
 */
function cornerAngle(corner, width, height) {
  const base = (Math.atan2(width, height) * 180) / Math.PI;
  switch (corner) {
    case 'top right':
      return base;
    case 'bottom right':
      return 180 - base;
    case 'bottom left':
      return 180 + base;
    default: // top left
      return 360 - base;
  }
}

/**
 * Stop positions as fractions of the gradient line, CSS's rules: a missing
 * first is 0 and a missing last is 1, a run of missing ones is spread evenly
 * between the neighbours that do have a position, and a position that goes
 * backwards is pulled up to the largest so far (which is how a hard colour
 * break — two stops at the same offset — stays expressible).
 */
function resolveStopOffsets(stops, length) {
  const out = stops.map(({ position }) => {
    if (!position) return null;
    return position.unit === '%'
      ? position.value / 100
      : position.value / length;
  });
  if (out[0] === null) out[0] = 0;
  if (out[out.length - 1] === null) out[out.length - 1] = 1;
  for (let i = 1; i < out.length; i++) {
    if (out[i] !== null) continue;
    let end = i + 1;
    while (out[end] === null) end++;
    const from = out[i - 1];
    const step = (out[end] - from) / (end - i + 1);
    for (let j = i; j < end; j++) out[j] = from + step * (j - i + 1);
    i = end - 1;
  }
  let highest = 0;
  for (let i = 0; i < out.length; i++) {
    highest = out[i] = Math.max(highest, Math.min(1, Math.max(0, out[i])));
  }
  return out;
}

/**
 * `boxShadow` → a list of `{ dx, dy, blur, spread, color }`, painted in the
 * order CSS paints them: first in the list is nearest the front, so the
 * renderer draws the list back to front.
 *
 * `color` may be null, which is CSS's `currentColor` — the node's own ink,
 * which the caller resolves because only it knows the cascade.
 *
 * Throws on `inset` and on anything unparseable; see the note at the top of
 * this file for why a shadow that silently does the wrong thing is worse
 * than one that refuses.
 */
export function parseBoxShadow(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text === 'none') return null;
  return splitTop(text, true).map((one) => readShadow(one, value));
}

function readShadow(part, value) {
  const bad = (why) =>
    new Error(
      `react-x11: boxShadow ${JSON.stringify(value)} ${why} (expected ` +
        "'<x> <y> [blur] [spread] [colour]', e.g. '0 2px 8px rgba(0, 0, 0, .4)')",
    );
  const pieces = splitTop(part, false);
  if (!pieces.length) throw bad('has an empty shadow');
  if (pieces.some((p) => p.toLowerCase() === 'inset')) {
    throw new Error(
      `react-x11: boxShadow ${JSON.stringify(value)} asks for an inset ` +
        'shadow, which is not implemented — only outer shadows are. An ' +
        'inner glow can be drawn with an inset border or a <canvas onDraw>.',
    );
  }
  const lengths = [];
  let color = null;
  for (const piece of pieces) {
    if (LENGTH.test(piece)) {
      if (lengths.length === 4) throw bad('has more than four lengths');
      lengths.push(number(piece));
      continue;
    }
    if (color !== null) throw bad(`has more than one colour ("${piece}")`);
    color = piece;
  }
  if (lengths.length < 2) throw bad('needs an x and a y offset');
  const [dx, dy, blur = 0, spread = 0] = lengths;
  if (blur < 0) throw bad('has a negative blur radius');
  return { dx, dy, blur, spread, color };
}

/**
 * The gaussian a `blur` asks for, and the padding its coverage surface needs.
 *
 * CSS defines the blur radius as *twice* the standard deviation, so the two
 * names that look like they match are the two that must not be passed to
 * each other; `shadowSigma` is the halving, and it applies ntk's policy cap
 * so a 4000px blur asked for by accident cannot become a kernel nothing
 * finishes.
 *
 * `pad` is the reach of the kernel **ntk will actually run** — that is why
 * it comes from `shadowReach` rather than from arithmetic of our own. The
 * blur is baked by `blurCoverage`, which derives its own kernel from sigma,
 * and a surface padded by less than that reach ends the shadow in a straight
 * line where the kernel ran out of pixels. The two numbers have to agree and
 * nothing about a wrong answer looks like a bug, so they come from one
 * place. The extra pixel is slack against the rounding above.
 */
export function blurKernel(blur) {
  const sigma = shadowSigma(blur);
  return { sigma, pad: sigma > 0 ? shadowReach(sigma) + 1 : 0 };
}

export function shadowExtent(shadows) {
  let extent = 0;
  for (const s of shadows ?? []) {
    const reach =
      Math.max(Math.abs(s.dx), Math.abs(s.dy)) +
      s.spread +
      (s.blur > 0 ? blurKernel(s.blur).pad : 0);
    if (reach > extent) extent = reach;
  }
  return Math.ceil(Math.max(0, extent));
}

// --- memoized parsing ------------------------------------------------------
//
// A style value is a string that is usually the same string as last frame —
// a hoisted style, a theme token resolved to the same colour — so the parse
// is keyed on it and never repeated. Failures are cached as `null` too:
// `validateStyle` has already thrown for them in development, and a frame in
// production must not re-throw once per node per frame for a value nothing
// is going to fix mid-run.

const MAX_CACHE = 256;
const gradients = new Map();
const shadows = new Map();

function memoize(cache, key, parse) {
  if (cache.has(key)) return cache.get(key);
  let parsed = null;
  try {
    parsed = parse(key);
  } catch {
    parsed = null;
  }
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, parsed);
  return parsed;
}

/**
 * The display scale's route into these two values, which is unlike every
 * other style length's: `boxShadow` and `backgroundImage` are *strings*,
 * so the multiply at the style funnel (styles.js, scaleResolvedStyle)
 * cannot reach the numbers inside them — and the parses are memoized on
 * the raw string, so the scaled result has to be memoized beside it
 * rather than patched after. The scale rides into the memo key.
 */
function scaleShadows(specs, scale) {
  if (!specs || scale === 1) return specs;
  return specs.map((s) => ({
    ...s,
    dx: s.dx * scale,
    dy: s.dy * scale,
    blur: s.blur * scale,
    spread: s.spread * scale,
  }));
}

function scaleGradient(spec, scale) {
  if (!spec || scale === 1) return spec;
  let stops = spec.stops;
  if (stops?.some((stop) => stop.position?.unit === 'px')) {
    stops = stops.map((stop) =>
      stop.position?.unit === 'px'
        ? {
            ...stop,
            position: { ...stop.position, value: stop.position.value * scale },
          }
        : stop,
    );
    return { ...spec, stops };
  }
  return spec;
}

/** `parseLinearGradient`, memoized and non-throwing: the paint path's door.
 *  `scale` converts any `px` stop positions to device pixels — percentages
 *  and angles mean the same thing at any density. */
export const gradientSpec = (value, scale = 1) =>
  memoize(gradients, scale === 1 ? value : `${scale}\u0000${value}`, () =>
    scaleGradient(parseLinearGradient(value), scale),
  );

/** `parseBoxShadow`, memoized and non-throwing. `scale` converts the
 *  offsets, the blur and the spread to device pixels. */
export const shadowSpecs = (value, scale = 1) =>
  memoize(shadows, scale === 1 ? value : `${scale}\u0000${value}`, () =>
    scaleShadows(parseBoxShadow(value), scale),
  );
