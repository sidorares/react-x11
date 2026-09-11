// Rect algebra: the pure geometry the damage model, hit testing, positions
// and the scroll blit do their sums with. Nothing in here knows about nodes.

export const rectContains = (outer, inner) =>
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  outer.x + outer.width >= inner.x + inner.width &&
  outer.y + outer.height >= inner.y + inner.height;

export const isIntegerRect = (r) =>
  Number.isInteger(r.x) &&
  Number.isInteger(r.y) &&
  Number.isInteger(r.width) &&
  Number.isInteger(r.height);

/** `rect` shrunk by `by` on every side. */
export function insetRect(rect, by) {
  return {
    x: rect.x + by,
    y: rect.y + by,
    width: rect.width - 2 * by,
    height: rect.height - 2 * by,
  };
}

/** The whole pixels inside `rect` — a fractional edge left out — or null
 * when none are. */
export function innerPixels(rect) {
  const x = Math.ceil(rect.x);
  const y = Math.ceil(rect.y);
  const right = Math.floor(rect.x + rect.width);
  const bottom = Math.floor(rect.y + rect.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** The overlap of two rects, or null when they have none. */
export function intersectRects(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function unionRect(a, b) {
  if (!b) return a ?? null;
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export function rectArea(r) {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

/** The box around a non-empty list of rects. */
export function rectsBounds(rects) {
  let out = rects[0];
  for (let i = 1; i < rects.length; i++) out = unionRect(out, rects[i]);
  return out;
}

/** Does `rect` reach into any of the four `radius`-sized corner squares of
 * `box` — the only part of a rounded border a translation cannot keep? */
export function cornerSquaresOverlap(box, radius, rect) {
  const r = Math.min(radius, box.width / 2, box.height / 2);
  if (!(r > 0)) return false;
  const corners = [
    { x: box.x, y: box.y, width: r, height: r },
    { x: box.x + box.width - r, y: box.y, width: r, height: r },
    { x: box.x, y: box.y + box.height - r, width: r, height: r },
    {
      x: box.x + box.width - r,
      y: box.y + box.height - r,
      width: r,
      height: r,
    },
  ];
  return corners.some((square) => rectsOverlap(square, rect));
}

/**
 * Do two rects share any area? Touching edges do not count. With a
 * `margin`, do they come within that many pixels of each other: the same
 * question asked of either one grown by `margin` on every side.
 */
export function rectsOverlap(a, b, margin = 0) {
  return (
    a.x < b.x + b.width + margin &&
    b.x < a.x + a.width + margin &&
    a.y < b.y + b.height + margin &&
    b.y < a.y + a.height + margin
  );
}
