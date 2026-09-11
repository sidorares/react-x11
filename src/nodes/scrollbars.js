// Scrollbar geometry: the track, the thumb, the hit test and the thumb's
// paint — shared by the Scrollable mixin, <textarea>'s own bar and the
// window's scroll blit.

import { insetRect } from './rects.js';

/** The full track strip a scrollbar occupies (thumb travel included), with
 * a pixel of slop for the thumb's antialiased corners. */
export function scrollbarTrackRect(bar) {
  const width = SCROLLBAR_WIDTH * (bar.scale ?? 1);
  const rect =
    bar.axis === 'x'
      ? {
          x: bar.trackStart,
          y: bar.crossStart,
          width: bar.trackLength,
          height: width,
        }
      : {
          x: bar.crossStart,
          y: bar.trackStart,
          width,
          height: bar.trackLength,
        };
  return insetRect(rect, -1);
}

export const SCROLLBAR_WIDTH = 6;
const SCROLLBAR_MIN_THUMB = 20;
// the visible bar is thin; the pointer target is not
const SCROLLBAR_SLOP = 4;

/**
 * Geometry of a scrollbar on either axis, or null when there is nothing to
 * scroll along it. Shared by scrolling boxes and `<textarea>` so what is
 * painted and what the pointer hits cannot drift apart — and written once
 * for both axes so the two cannot drift from each other either.
 *
 * `viewport`/`content`/`scroll` are along the axis; `across`/`crossSize`
 * place the bar on the other one. `shorten` keeps the two bars out of each
 * other's corner when both are showing.
 *
 * `direction` mirrors both of those. A vertical bar sits on the **left** in
 * an RTL viewport — every desktop does this, and it is not decoration: the
 * bar belongs on the edge the eye finishes a line at. And a horizontal bar's
 * thumb starts at the right, because `scroll` is measured from the start of
 * the content and the start of RTL content is its right-hand edge.
 */
export function scrollbarGeometry({
  axis = 'y',
  start,
  viewport,
  content,
  across: crossStart0,
  crossSize,
  scroll,
  inset = 0,
  shorten = 0,
  direction = 'ltr',
  scale = 1,
}) {
  const length = viewport - shorten;
  if (length <= 0 || !(content > viewport)) return null;
  // The strip's own dimensions are logical constants; everything the caller
  // passed — rects, content extents, offsets — is already device. The bar
  // carries `scale` so the track, the hit slop and the thumb's corner
  // radius downstream draw from the same number.
  const barWidth = SCROLLBAR_WIDTH * scale;
  const rtl = direction === 'rtl';
  const thumbLength = Math.max(
    SCROLLBAR_MIN_THUMB * scale,
    (length * length) / content,
  );
  const range = content - viewport;
  const travel = Math.max(0, length - thumbLength);
  const offset = range > 0 ? (scroll / range) * travel : 0;
  // a vertical bar always fills from the top; only the horizontal one runs
  // the way the text does
  const thumbStart =
    rtl && axis === 'x' ? start + travel - offset : start + offset;
  const crossStart =
    rtl && axis === 'y'
      ? crossStart0 + inset
      : crossStart0 + crossSize - barWidth - inset;
  return {
    axis,
    scale,
    trackStart: start,
    trackLength: length,
    thumbStart,
    thumbLength,
    crossStart,
    range,
    travel,
    // does a larger `scroll` move the thumb *towards* trackStart? The one
    // place the mirroring is written down, so the drag and the track-page
    // below read it rather than asking about the direction again
    reversed: rtl && axis === 'x',
    // the thumb as a rect, for painting
    x: axis === 'x' ? thumbStart : crossStart,
    y: axis === 'x' ? crossStart : thumbStart,
    width: axis === 'x' ? thumbLength : barWidth,
    height: axis === 'x' ? barWidth : thumbLength,
  };
}

/** The coordinate along a bar's own axis, and across it. */
export const along = (bar, x, y) => (bar.axis === 'x' ? x : y);
const across = (bar, x, y) => (bar.axis === 'x' ? y : x);

/** Is this point on the bar (with slop), and if so, on the thumb? */
export function scrollbarHit(bar, x, y) {
  if (!bar) return null;
  const c = across(bar, x, y);
  const s = bar.scale ?? 1;
  if (
    c < bar.crossStart - SCROLLBAR_SLOP * s ||
    c > bar.crossStart + (SCROLLBAR_WIDTH + SCROLLBAR_SLOP) * s
  ) {
    return null;
  }
  const a = along(bar, x, y);
  if (a < bar.trackStart || a > bar.trackStart + bar.trackLength) return null;
  return a >= bar.thumbStart && a <= bar.thumbStart + bar.thumbLength
    ? 'thumb'
    : 'track';
}

export function paintScrollbarThumb(ctx, bar, color) {
  ctx.fillStyle = color || 'rgba(0, 0, 0, 0.25)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(bar.x, bar.y, bar.width, bar.height, 3 * (bar.scale ?? 1));
  } else {
    ctx.rect(bar.x, bar.y, bar.width, bar.height);
  }
  ctx.fill();
}
