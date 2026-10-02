// `objectFit`: where a picture with a size of its own goes in a box that has
// another — CSS's `object-fit`, for `<image>` and `<video>`, centred the way
// CSS's default `object-position: 50% 50%` centres it. A leaf: no node, no
// backend, rects in and a rect out.

export const OBJECT_FITS = Object.freeze([
  'fill',
  'contain',
  'cover',
  'none',
  'scale-down',
]);

/** The element's `objectFit`, or its default where the style names none. */
export function objectFitOf(style, fallback) {
  const fit = style?.objectFit;
  return OBJECT_FITS.includes(fit) ? fit : fallback;
}

/**
 * Where a `width` x `height` picture goes in `box` under `fit`: `fill`
 * stretches it to the box, `contain` scales it to fit inside with bars,
 * `cover` scales it to fill with the overflow cut (by the caller), `none`
 * leaves it its own size, and `scale-down` is `none` or `contain`, whichever
 * is smaller. Its edges are snapped to whole pixels, so a picture drawn
 * there and a layer placed there cover exactly the same ones — except under
 * `fill`, which is the box itself, as an `<image>` has always been drawn.
 */
export function fitRect(box, width, height, fit) {
  if (fit === 'fill' || !(width > 0 && height > 0)) return { ...box };
  let k;
  if (fit === 'none') k = 1;
  else {
    const sx = box.width / width;
    const sy = box.height / height;
    k = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
    if (fit === 'scale-down') k = Math.min(k, 1);
  }
  const w = width * k;
  const h = height * k;
  const x0 = Math.round(box.x + (box.width - w) / 2);
  const y0 = Math.round(box.y + (box.height - h) / 2);
  const x1 = Math.round(box.x + (box.width + w) / 2);
  const y1 = Math.round(box.y + (box.height + h) / 2);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
