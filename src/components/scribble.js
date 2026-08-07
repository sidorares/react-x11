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
// appearing. And nothing in the shape is per-character — a fixed number of
// control points, whatever the length — so there is nothing to count.
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

/** How many control points a scribble is drawn through, whatever its length
 *  — a count that grew with the value would be a character count. */
export const SCRIBBLE_POINTS = 7;

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
 * The points the curve runs through, inside a `width` × `height` box.
 *
 * `x` marches across the box so the stroke reads left to right like writing,
 * with enough jitter that the columns are not a grid; `y` is free within the
 * box, which is what makes it a scribble rather than a wave.
 */
export function scribblePoints({
  width,
  height,
  seed,
  points = SCRIBBLE_POINTS,
  inset = 2,
}) {
  const rnd = seededRandom(seed);
  const span = Math.max(1, height - inset * 2);
  const drift = width / (points * 2);
  // Which half the first point sits in; after that they alternate. Free `y`
  // in the whole box reads as a gentle wave once the field is wide — seven
  // points over two hundred pixels rarely happen to zigzag — and a mask that
  // relaxes into a line as the password gets longer is saying something about
  // the password. Alternating halves keeps the stroke oscillating at every
  // width, with the randomness spent on *where* in the half it lands.
  let high = rnd() < 0.5;
  const out = [];
  for (let i = 0; i < points; i++) {
    const t = points === 1 ? 0.5 : i / (points - 1);
    const x = t * (width - inset * 2) + inset + (rnd() - 0.5) * drift;
    const y = inset + (high ? rnd() * 0.42 : 0.58 + rnd() * 0.42) * span;
    high = !high;
    out.push({
      x: Math.min(width - inset, Math.max(inset, x)),
      y,
    });
  }
  return out;
}

/**
 * Stroke the scribble for `seed` into a `width` × `height` box.
 *
 * Catmull-Rom through the points, converted to the cubic béziers the context
 * actually draws: a curve that passes *through* every point rather than
 * being pulled towards it, which is what keeps the stroke inside the box it
 * was given.
 */
export function strokeScribble(ctx, { width, height, seed, color, lineWidth }) {
  if (!(width > 2) || !(height > 2)) return;
  const pts = scribblePoints({ width, height, seed });
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth ?? 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    ctx.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x,
      p2.y,
    );
  }
  ctx.stroke();
}
