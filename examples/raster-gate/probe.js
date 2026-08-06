// The probe shape, and the vocabulary both halves of this example speak.
//
// `routeRaster` (ntk's lib/rasterize.js) is handed exactly three numbers per
// drawing — width, height and edge count — and answers 'local' or 'server'.
// So a probe that can dial *those three numbers independently* can stand
// anywhere in the decision space, and a sweep over it maps the whole plane
// the policy divides.
//
// Everything a real widget draws sits somewhere on that plane too. A rounded
// card is a small box with few edges; a stroked gauge is a small box with
// hundreds; a full-window gradient mask is a huge box with four. The probe is
// not more synthetic than they are, it is just steerable.
//
// ## The shape
//
// A star fan: `triangles` triangles sharing the box centre, their outer
// vertices walking the box perimeter. Three properties earn it the job:
//
//   - **edges are exact.** Only `moveTo`/`lineTo`, so ntk's flattener emits
//     one point per point (a curve would flatten to a count decided by
//     `curveSteps`, which is not a knob). N triangles is 3N edges, always.
//   - **the box is exact**, and stays exact while the shape animates — see
//     `probeGeometry` and the note on `inner` below.
//   - **the coverage is real.** Adjacent fan triangles tile the star under
//     the non-zero rule, so both routes do the work they would do for a
//     drawing, rather than for a degenerate sliver.
//
// ## Two axes, not one
//
// `triangles` and `fills` move different things, and conflating them is the
// mistake this file exists to prevent:
//
//   triangles   how complex ONE drawing is. All of them land in a single
//               path and a single `fill()`, so the gate is consulted once
//               with `edges = 3 * triangles`.
//   fills       how MANY drawings there are. Each is its own `fill()`, its
//               own gate decision, its own mask clear and its own composite —
//               the per-operation overhead, isolated from the per-edge cost.
//
// A frame gets slow for either reason, and the remedy differs: complexity is
// what the policy arbitrates, count is what batching would fix.
import { DEFAULT_RASTER_POLICY } from 'ntk';

/**
 * ntk's routing rule, mirrored.
 *
 * Not imported: ntk's package exports map exposes `.` only, so
 * `ntk/lib/rasterize.js` is unreachable. `DEFAULT_RASTER_POLICY` *is*
 * exported, which is the part that would silently drift — the rule itself is
 * three comparisons and has been stable since it landed.
 *
 * @returns {'local'|'server'}
 */
export function routeRaster(
  width,
  height,
  edges,
  policy = DEFAULT_RASTER_POLICY,
) {
  const area = width * height;
  if (area <= 0 || area > policy.maxBytes) return 'server';
  if (area <= policy.maxArea) return 'local';
  return area <= policy.bytesPerEdge * edges ? 'local' : 'server';
}

/** What ntk uses when `app.options.rasterPolicy` is unset. */
export const NTK_DEFAULT = { ...DEFAULT_RASTER_POLICY };

/**
 * `routeRaster` returns 'server' for `area > maxBytes` before it looks at
 * anything else, so a preset that means "always local" needs a ceiling too.
 * 16MB is past any drawing this example can produce at its largest size, and
 * `maxBytes` is a safety valve on upload size rather than a routing choice —
 * pinning it out of the way is what makes the other two thresholds the only
 * thing the preset changes.
 */
export const FORCE_LOCAL = {
  maxArea: Infinity,
  bytesPerEdge: Infinity,
  maxBytes: 1 << 24,
};

/** Thresholds of zero: no drawing clears them, so every one goes to the
 * server. `maxBytes` matches FORCE_LOCAL so the pair differ in the two
 * numbers under test and in nothing else. */
export const FORCE_SERVER = { maxArea: 0, bytesPerEdge: 0, maxBytes: 1 << 24 };

/**
 * The star's waist, as a fraction of its outer radius.
 *
 * This is the animation knob, and it is the reason the probe animates through
 * `inner` rather than through a rotation. The outer vertices are what set the
 * bounding box; leaving them pinned to the perimeter and moving only the
 * waist changes every pixel of the drawing — no paint cache, no glyph cache,
 * nothing between here and the server can serve a frame from the last one —
 * while the box the gate measures stays exactly the box that was asked for.
 * A rotation would have swept the box out to the circumscribed circle and made
 * the area drift with the phase, which is precisely the number under test.
 */
const INNER_MIN = 0.28;
const INNER_MAX = 0.62;

/**
 * A point on the perimeter of a `size` x `size` box, `t` of the way around it
 * clockwise from the top-left corner.
 */
function perimeter(t, size) {
  const u = (t - Math.floor(t)) * 4 * size;
  if (u < size) return [u, 0];
  if (u < 2 * size) return [size, u - size];
  if (u < 3 * size) return [3 * size - u, size];
  return [0, 4 * size - u];
}

/**
 * The probe's vertices, and the numbers the gate will see for them.
 *
 * Outer vertices sit at `t = k / triangles` around the perimeter, so the four
 * corners (t = 0, ¼, ½, ¾) are hit exactly when `triangles` is a multiple of
 * 8 — the fan alternates outer and inner points, so only every second vertex
 * is on the perimeter. That is why the calibration grid and the example's
 * slider both step in eights: off the multiple, the star's box is a little
 * smaller than the box that was asked for, and the area under test would
 * drift with the complexity slider instead of with the size slider.
 *
 * Rather than assume, the box is measured from the points that were actually
 * generated, the same way ntk measures it. `width`/`height`/`area` are
 * therefore exact for any triangle count, multiple of 8 or not.
 *
 * @param {number} size box side, in device pixels
 * @param {number} triangles how many triangles the fan has
 * @param {number} [inner] waist, as a fraction of the outer radius. Does not
 *   move the box — every inner vertex is inside the outer hull — so the
 *   animation cannot change what the gate is asked.
 * @returns {{pts: Float64Array, edges: number, width: number, height: number,
 *   area: number}} `pts` holds `x, y` per vertex, three vertices per triangle
 */
export function probeGeometry(size, triangles, inner = INNER_MIN) {
  const n = Math.max(1, triangles | 0);
  const c = size / 2;
  const pts = new Float64Array(n * 6);
  // vertex k of the fan rim: outer (on the perimeter) for even k, pulled in
  // towards the centre for odd k
  const rim = (k) => {
    const [px, py] = perimeter((k % n) / n, size);
    if (k % 2 === 0) return [px, py];
    return [c + (px - c) * inner, c + (py - c) * inner];
  };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < n; k++) {
    const [ax, ay] = rim(k);
    const [bx, by] = rim(k + 1);
    pts.set([c, c, ax, ay, bx, by], k * 6);
    if (ax < minX) minX = ax;
    if (ax > maxX) maxX = ax;
    if (ay < minY) minY = ay;
    if (ay > maxY) maxY = ay;
  }
  // ntk's `_clampBBox`, minus its clamp to the surface: a pixel of slack on
  // every side for the antialiased edge, and no clamp because callers place
  // the probe with room around it — one pushed against the edge of its
  // drawable would be measuring the clamp instead of the shape. The padded
  // box is what reaches `routeRaster`, so it is what this file calls the
  // area: the number the gate compares, not the number the drawing nominally
  // covers. A 64px star is 66x66 = 4356 here, just over the 4096 that
  // `maxArea` defaults to.
  const width = Math.ceil(maxX) + 1 - (Math.floor(minX) - 1);
  const height = Math.ceil(maxY) + 1 - (Math.floor(minY) - 1);
  return { pts, edges: n * 3, width, height, area: width * height };
}

/** The waist this phase is at. Exported so the example can show the same
 * shape the calibration measured, at the phase it happens to be on. */
export const innerAt = (phase) =>
  INNER_MIN + (INNER_MAX - INNER_MIN) * (0.5 + 0.5 * Math.sin(phase));

/**
 * Draw the probe: `fills` separate `fill()` calls, each one a whole star of
 * `triangles` triangles across the same `size` box, nested by giving each one
 * a tighter waist than the last.
 *
 * Every fill therefore has the same box and the same edge count — they route
 * the same way, and `fills` is a clean multiplier on the per-operation cost
 * with nothing else moving.
 *
 * @param {object} ctx a 2d context
 * @param {object} opts `{x, y, size, triangles, fills, phase, color}`
 */
export function drawProbe(ctx, opts) {
  const {
    x = 0,
    y = 0,
    size,
    triangles,
    fills = 1,
    phase = 0,
    color = '#0984e3',
  } = opts;
  if (!(size > 0) || !(fills > 0)) return;
  const base = innerAt(phase);
  ctx.fillStyle = color;
  for (let f = 0; f < fills; f++) {
    // nested waists: the outermost fill keeps the animated waist, each one
    // inside it is tighter by an even share of what is left
    const inner = base * (1 - f / (fills + 1));
    const { pts } = probeGeometry(size, triangles, inner);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 6) {
      ctx.moveTo(x + pts[i], y + pts[i + 1]);
      ctx.lineTo(x + pts[i + 2], y + pts[i + 3]);
      ctx.lineTo(x + pts[i + 4], y + pts[i + 5]);
      ctx.closePath();
    }
    ctx.fill();
  }
}

/**
 * What one probe costs the gate, before anything is drawn: the area and edge
 * count a policy will be asked about, and the answer it gives.
 *
 * The example puts this on screen next to the sliders. Predicting the routing
 * rather than observing it is deliberate — observing would need a hook inside
 * ntk, and the prediction is checkable against the fence readout sitting next
 * to it, which is most of why both are on the same screen.
 */
export function probeRouting(size, triangles, fills, policy) {
  const { width, height, area, edges } = probeGeometry(size, triangles);
  return {
    area,
    edges,
    ratio: area / edges,
    route: routeRaster(width, height, edges, policy),
    drawings: fills,
  };
}
