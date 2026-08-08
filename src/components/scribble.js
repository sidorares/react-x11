// The scribble a masked field is drawn with, and the arithmetic behind it.
//
// A row of bullets answers the wrong question. It says *how many characters
// you have typed* — loudly, countably, from across the room — and it says
// nothing at all about the keystroke that just landed, because one more
// identical dot at the end of a row of identical dots is the least visible
// change a field could make.
//
// This inverts both. A stroke is drawn through points chosen by a generator
// seeded from the window and the value, so **every keystroke redraws the
// whole curve**: the feedback is the entire mask moving, not a mark
// appearing. And nothing in the shape is per-character — the pen visits a
// number of points taken from the mask's *width*, where a character is worth
// about half a point, so no part of the stroke can be matched to anything
// that was typed.
//
// It is a scribble rather than a wave, and that is a decision rather than a
// look: a stroke whose `x` only ever increases is the plot of a function, and
// the eye reads it as one — value against position, meaning in the peaks —
// however wild the `y` is. So the pen doubles back, crosses what it has
// already drawn, and leaves loops. `scribblePoints` is where that happens.
//
// What does grow is the width, because a mask that did not grow would say
// nothing about progress at all. It grows by a per-position advance drawn
// from a **window-seeded** stream rather than by a fixed step, so the width
// is monotonic in the length (typing always widens it) without being a clean
// multiple of anything (a glance does not give a character count). Those two
// streams are deliberately separate: the shape reshuffles on every keystroke,
// the width never does.
//
// The honest limits, since a mask that oversells itself is worse than one
// that does not: an observer who watches the field grow keystroke by
// keystroke still learns the length, and the width still puts a long password
// in a different bracket from a short one. This hides a glance, not a
// recording.

/** FNV-1a over the UTF-16 units, which is all a seed needs to be. */
export function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32: a small, fast, well-distributed PRNG with a 32-bit state.
 *
 * The point is not statistical quality, it is that the sequence is a pure
 * function of the seed — the same value in the same window draws the same
 * scribble on every repaint, so a frame that redraws a damaged strip cannot
 * come back with a different curve than the frame before it.
 */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How many points the pen visits, per pixel of mask.
 *
 * Deriving the count from the **width** rather than fixing it keeps the
 * scrawl at one density: a fixed count stretches into a few long shallow
 * strokes as the field fills, which both stops looking like a scribble and —
 * since density would then fall with length — says as much about the length
 * as the count would. Width is already on show; density does not have to be.
 *
 * The count is not per-character either way. At this rate a character is
 * worth about half a point, so nothing in the stroke can be matched to
 * anything that was typed.
 */
const PX_PER_POINT = 9;
const MIN_POINTS = 7;

/** How far apart, in pixels, the curve is sampled when it is drawn. */
const SAMPLE_PX = 2;
const MAX_POINTS = 30;

/** How many points a mask this wide is drawn through. */
export function scribblePointCount(width) {
  return Math.max(
    MIN_POINTS,
    Math.min(MAX_POINTS, Math.round(width / PX_PER_POINT)),
  );
}

/** How far the pen may jump out of order: the width of the window the
 *  visiting order is shuffled inside. See `scribblePoints`. */
export const SCRIBBLE_GROUP = 3;

/** The narrowest and widest a character may push the mask, as a fraction of
 *  the reference advance. Wide enough that the steps do not read as a ruler,
 *  narrow enough that the mask still tracks what has been typed. */
const MIN_ADVANCE = 0.55;
const MAX_ADVANCE = 1.35;

/**
 * How wide the mask for a value of `length` characters is, in pixels.
 *
 * `unit` is the reference advance — one character of the field's own font —
 * and `seed` is derived from the **window**, never from the value, which is
 * what makes position 7 contribute the same width whatever is typed there.
 * So the mask only ever grows as you type, and never twitches when a
 * character is replaced.
 */
export function maskWidth(length, unit, seed, max = Infinity) {
  if (length <= 0) return 0;
  const rnd = seededRandom(seed);
  let width = 0;
  for (let i = 0; i < length; i++) {
    const advance = unit * (MIN_ADVANCE + rnd() * (MAX_ADVANCE - MIN_ADVANCE));
    width += advance;
    // A field that has run out of room stops growing, the way a text input
    // that has scrolled stops showing you where the end is — and the loop
    // stops with it, so a pasted novel is not a hundred thousand rounds of a
    // generator whose answer is already known.
    if (width >= max) return max;
  }
  return width;
}

/**
 * The points the pen visits, inside a `width` × `height` box.
 *
 * **Not in left-to-right order.** A stroke whose `x` only ever increases is a
 * plot of a function — a waveform, a time series — and it reads as one however
 * wild the `y` is: the eye follows it as "value against position" and starts
 * looking for meaning in the peaks. A pen moved at random over a piece of
 * paper does not do that. It doubles back, crosses what it has already drawn,
 * and leaves loops.
 *
 * So the points are laid out in **columns** — one per column, which is what
 * guarantees the stroke covers the width it was given rather than knotting
 * itself in one corner — and then the *visiting order is shuffled*. The pen
 * therefore starts somewhere in the middle, sweeps across, comes back, and
 * crosses itself on the way.
 */
export function scribblePoints({
  width,
  height,
  seed,
  points = scribblePointCount(width),
  group = SCRIBBLE_GROUP,
  inset = 2,
}) {
  const rnd = seededRandom(seed);
  const span = Math.max(1, height - inset * 2);
  const usable = Math.max(1, width - inset * 2);
  const column = usable / points;
  const out = [];
  for (let i = 0; i < points; i++) {
    out.push({
      // inside its own column, so no two points share a place and the whole
      // width is used, but nowhere near the middle of it
      x: inset + i * column + rnd() * column,
      y: inset + rnd() * span,
    });
  }
  // Fisher-Yates within a sliding group rather than over the whole list. A
  // full shuffle puts consecutive points a third of the width apart on
  // average, and in a box this short every one of those moves is a long
  // shallow sweep — the stroke ends up a bundle of near-horizontal scratches.
  // Shuffling locally keeps the moves short, so the pen has room to go up and
  // down between them, and it still doubles back and crosses itself.
  for (let start = 0; start < out.length; start += group) {
    const end = Math.min(out.length, start + group);
    for (let i = end - 1; i > start; i--) {
      const j = start + Math.floor(rnd() * (i - start + 1));
      const swap = out[i];
      out[i] = out[j];
      out[j] = swap;
    }
  }
  return out;
}

/**
 * The pen's path as a **dense polyline**, sampled off a Catmull-Rom spline
 * through the points — a curve that passes through every one of them rather
 * than being pulled towards it.
 *
 * Sampled here rather than handed to the context as béziers, which is what
 * this did first. A mask is 17 pixels tall, its control points land within a
 * pixel of each other constantly, and ntk's stroker answers a curve that
 * small with the occasional spike: a stray tail shooting out of the field,
 * several times the width of the mask. The same points drawn as line segments
 * are exact at any size, and a curve sampled every couple of pixels is
 * smooth long before anyone can see the difference. (The béziers themselves
 * are fine — the shape is right when it is drawn eight times bigger — so this
 * is a workaround for the stroker, not for the geometry.)
 *
 * Every sample is clamped into the box, so "the stroke stays in the field" is
 * arithmetic rather than a hope.
 */
export function scribblePath(pts, { width, height, inset = 2 }) {
  const clampX = (v) => Math.min(width, Math.max(0, v));
  const clampY = (v) => Math.min(height - inset, Math.max(inset, v));
  const out = [{ x: clampX(pts[0].x), y: clampY(pts[0].y) }];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const span = Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y);
    const steps = Math.max(3, Math.min(14, Math.round(span / SAMPLE_PX)));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      // Catmull-Rom basis, uniform parameterisation
      const at = (a, b, c, d) =>
        0.5 *
        (2 * b +
          (c - a) * t +
          (2 * a - 5 * b + 4 * c - d) * t2 +
          (3 * b - a - 3 * c + d) * t3);
      out.push({
        x: clampX(at(p0.x, p1.x, p2.x, p3.x)),
        y: clampY(at(p0.y, p1.y, p2.y, p3.y)),
      });
    }
  }
  return out;
}

/** Stroke the scribble for `seed` into a `width` × `height` box. */
export function strokeScribble(ctx, { width, height, seed, color, lineWidth }) {
  if (!(width > 2) || !(height > 2)) return;
  const inset = 2;
  const pts = scribblePoints({ width, height, seed, inset });
  const path = scribblePath(pts, { width, height, inset });
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth ?? 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(path[0].x, path[0].y);
  for (const point of path.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.stroke();
}
