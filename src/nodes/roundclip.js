// A rounded outline clipping a box's children, made without a clip mask
// (issue #685). The outline is the box's rectangle everywhere but its four
// corner squares, so the children are drawn once under the rectangle — the
// clip every server-side fast path takes — and each corner square a child
// reaches is put back the way it was outside the arc: kept before the
// children draw, returned through the coverage of the arc's outside after.
//
// That needs a context that can read its own pixels back into a surface of
// its own and composite a coverage surface: ntk's, whose `picture` is the
// server-side picture it draws through, and a Cocoa one, whose bitmap is CPU
// memory it names as a `drawImage` source (`readbackSource`, issue #693).
// Anywhere else the caller clips to the outline as it always has.

import { Surface } from '../offscreen.js';

// per app: the coverage of each corner's outside, by corner, radius and
// side, and the surfaces a corner is kept in between the two halves
const states = new WeakMap();

function stateFor(app) {
  let state = states.get(app);
  if (!state) {
    state = { coverage: new Map(), spare: [] };
    states.set(app, state);
  }
  return state;
}

/**
 * The outline inside one corner square, as a path: the square with the
 * outside of the arc cut away. The arc is `roundRect`'s own — the same
 * centre, radius and quarter, reached by the same line — so the pixels it
 * shades are the ones a clip to the whole outline shades.
 */
function cornerPath(ctx, box, { radius: r, side: s }, corner) {
  const left = box.x;
  const top = box.y;
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  ctx.beginPath();
  if (corner === 'tl') {
    ctx.moveTo(left, top + s);
    ctx.lineTo(left, top + r);
    ctx.arc(left + r, top + r, r, Math.PI, Math.PI * 1.5);
    ctx.lineTo(left + s, top);
    ctx.lineTo(left + s, top + s);
  } else if (corner === 'tr') {
    ctx.moveTo(right - s, top);
    ctx.lineTo(right - r, top);
    ctx.arc(right - r, top + r, r, -Math.PI / 2, 0);
    ctx.lineTo(right, top + s);
    ctx.lineTo(right - s, top + s);
  } else if (corner === 'br') {
    ctx.moveTo(right, bottom - s);
    ctx.lineTo(right, bottom - r);
    ctx.arc(right - r, bottom - r, r, 0, Math.PI / 2);
    ctx.lineTo(right - s, bottom);
    ctx.lineTo(right - s, bottom - s);
  } else {
    ctx.moveTo(left + s, bottom);
    ctx.lineTo(left + r, bottom);
    ctx.arc(left + r, bottom - r, r, Math.PI / 2, Math.PI);
    ctx.lineTo(left, bottom - s);
    ctx.lineTo(left + s, bottom - s);
  }
  ctx.closePath();
}

/**
 * A square to hold a coverage in: an a8 surface where the backend has them,
 * and elsewhere a colour one whose alpha is the coverage — which is all the
 * `destination-in` and `destination-out` it is drawn with read of it. The
 * Cocoa backend has no a8 surfaces and says so by throwing.
 */
function coverageSurface(app, side) {
  try {
    return new Surface(app, { width: side, height: side, format: 'a8' });
  } catch {
    return new Surface(app, { width: side, height: side });
  }
}

/**
 * How much of each pixel of a corner square lies outside the outline, as an
 * a8 surface the size of the square: the square filled, and the outline's
 * corner taken out of it. One per corner, radius and side on an app, and
 * kept — every box with that radius shares it.
 */
function outsideCoverage(app, corners, corner) {
  const state = stateFor(app);
  const s = corners.side;
  const key = `${corner}|${corners.radius}|${s}`;
  let surface = state.coverage.get(key);
  if (surface) return surface;
  surface = coverageSurface(app, s);
  // a box whose corner lands on the square's own, in the square's space
  const far = corner === 'tr' || corner === 'br';
  const low = corner === 'bl' || corner === 'br';
  const box = { x: far ? -s : 0, y: low ? -s : 0, width: 2 * s, height: 2 * s };
  surface.render((sctx) => {
    sctx.fillStyle = '#ffffff';
    sctx.fillRect(0, 0, s, s);
    sctx.globalCompositeOperation = 'destination-out';
    cornerPath(sctx, box, corners, corner);
    sctx.fill();
  });
  state.coverage.set(key, surface);
  return surface;
}

/**
 * A surface at least `side` square to keep a corner in, from the app's
 * spares, with the context it is drawn through: a box nested in a box keeps
 * its corners while the outer one's are still kept, so there is one per
 * corner being held, not one in all. The context is held with the surface —
 * ntk makes a new one per `getContext`, and a surface drawn into every frame
 * would otherwise make one a frame.
 */
function takeSpare(app, side) {
  const spare = stateFor(app).spare;
  for (let i = 0; i < spare.length; i++) {
    const { surface } = spare[i];
    if (surface.width >= side && surface.height >= side) {
      return spare.splice(i, 1)[0];
    }
  }
  const size = Math.max(16, side);
  const surface = new Surface(app, { width: size, height: size });
  return { surface, ctx: surface.getContext('2d') };
}

/**
 * Where the context puts window coordinate (0, 0) on the picture it draws
 * into — the only transform the paint walk runs under is a whole-pixel
 * translation (a faded group's surface, a pane's) — and that picture, as
 * something `drawImage` can read from; null when either is missing, and the
 * corners cannot be kept this way.
 */
function readback(ctx) {
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  if (!m || m.a !== 1 || m.b !== 0 || m.c !== 0 || m.d !== 1) return null;
  if (!Number.isInteger(m.e) || !Number.isInteger(m.f)) return null;
  // reading it settles the picture's clip, which the next drawing re-stamps
  if (ctx.picture && Number.isFinite(ctx.width)) {
    return {
      dx: m.e,
      dy: m.f,
      source: {
        width: ctx.width,
        height: ctx.height,
        picture: () => ctx.picture,
      },
    };
  }
  // a backend context whose owner says its bitmap reads back cheaply
  const source =
    typeof ctx.readbackSource === 'function' ? ctx.readbackSource() : null;
  return source ? { dx: m.e, dy: m.f, source } : null;
}

/**
 * Keep the corner squares in `cut` — the ones a child is about to draw into
 * — before the children draw, and hand back what puts them back afterwards:
 * `restore()` composites each square the way it was outside the arc, over
 * whatever the children left there, and `release()` returns the surfaces.
 * Null when the context cannot read its pixels back.
 *
 * Each kept square is premultiplied by the outside's coverage, so putting it
 * back is two composites and no mask: the destination scaled by the inside's
 * coverage (`destination-out` through the outside's), then the kept pixels
 * added (`lighter`). Where the outline covers a pixel wholly, nothing of what
 * the children drew changes; where it misses it wholly, what was there
 * before comes back exactly; the antialiased pixels on the arc blend the two
 * by the arc's coverage. That is the children clipped as one layer, which is
 * what a clip means — a per-drawing clip lets a covered layer bleed into
 * those pixels, and a stack of them darkens the edge.
 */
export function keepCorners(ctx, app, corners, cut) {
  const at = app ? readback(ctx) : null;
  if (!at) return null;
  const s = corners.side;
  const kept = [];
  const release = () => {
    const spare = stateFor(app).spare;
    for (const { held } of kept) spare.push(held);
    kept.length = 0;
  };
  try {
    for (const square of cut) {
      const outside = outsideCoverage(app, corners, square.corner);
      const held = takeSpare(app, s);
      kept.push({ square, outside, held });
      const sctx = held.ctx;
      sctx.save();
      sctx.globalAlpha = 1;
      sctx.globalCompositeOperation = 'copy';
      sctx.drawImage(
        at.source,
        square.x + at.dx,
        square.y + at.dy,
        s,
        s,
        0,
        0,
        s,
        s,
      );
      sctx.globalCompositeOperation = 'destination-in';
      sctx.fillStyle = '#000000';
      sctx.drawImage(outside, 0, 0);
      sctx.restore();
    }
  } catch {
    // no surface to keep a corner in: the caller clips to the outline, and
    // what was taken goes back
    release();
    return null;
  }
  return {
    restore() {
      for (const { square, outside, held } of kept) {
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = '#000000';
        ctx.drawImage(outside, square.x, square.y);
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(held.surface, 0, 0, s, s, square.x, square.y, s, s);
        ctx.restore();
      }
    },
    release,
  };
}
