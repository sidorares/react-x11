// Finding this server's crossover, by measuring it.
//
// ntk's `DEFAULT_RASTER_POLICY` is two numbers — `maxArea` and
// `bytesPerEdge` — measured once, against XQuartz. On a glamor-class server
// the trapezoid path they arbitrate is a software fallback, so the same two
// numbers can be 10-40x off (sidorares/ntk#177). The honest answer to "what
// should they be here" is not a better guess; it is a measurement, and it
// takes a few seconds.
//
// ## What is measured
//
// A grid of probes (probe.js) spanning the plane `routeRaster` divides:
// sizes from a checkbox tick to a full illustration, triangle counts from a
// rounded rectangle's handful of edges to a stroked icon's hundreds. Each
// probe is drawn twice, once with the policy pinned to 'local' and once
// pinned to 'server', and the two times are compared.
//
// Timing is a batch of draws followed by a `GetInputFocus` round trip. The
// round trip is the point: X is asynchronous, the client can be finished with
// a frame long before the server is, and on the platforms this exists for the
// server is where the time goes. `issueMs` (the loop) and `totalMs` (through
// the reply) are both kept, because which of them moves is the diagnosis —
// a policy that trades server trapezoids for client rasterization moves both,
// in opposite directions.
//
// ## Where it draws
//
// Into an offscreen `Surface`, not into a window. This is not a compromise:
// ntk's 2d contexts on windows draw into a *backing pixmap* and blit, so a
// pixmap is the drawable a real frame paints into. Keeping the window out of
// it removes the compositor, the vsync and the WM from the measurement, and
// lets the example calibrate without its own UI flickering.
//
// ## What comes out
//
// `fitPolicy` searches the two thresholds jointly for the pair that minimizes
// the *measured* total across the grid — not the pair that classifies the most
// probes correctly. Those differ, and the cost-weighted one is the one worth
// having: getting a 512px drawing wrong costs more than getting twenty
// 16px ones wrong, and an accuracy score cannot see that.
import * as ntk from 'ntk';

import {
  FORCE_LOCAL,
  FORCE_SERVER,
  NTK_DEFAULT,
  drawProbe,
  probeGeometry,
  routeRaster,
} from './probe.js';

/**
 * The canonical grid, versioned.
 *
 * Cross-platform comparison is the whole point, and the totals `fitPolicy`
 * reports are sums over this grid — change it and yesterday's numbers stop
 * being comparable with today's. Hence the version, which travels in the
 * result: a run that says `grid: 1` can be put beside any other run that says
 * `grid: 1` and beside no other.
 *
 * Sizes are roughly geometric from a checkbox tick to a large illustration.
 * Triangle counts are multiples of 8 (probe.js explains why) spanning a
 * rounded rectangle's edge count to a stroked icon's.
 */
export const GRID_VERSION = 1;

export const GRID = {
  sizes: [16, 32, 64, 128, 256, 512],
  triangles: [8, 24, 64, 192],
};

/** A wider grid for a careful run — same shape, more points. Reported as
 * grid version 1 still: it is a superset, and `fitPolicy`'s totals are only
 * comparable within one `sizes x triangles` set, which the result carries. */
export const GRID_FULL = {
  sizes: [16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512],
  triangles: [8, 16, 32, 64, 128, 256],
};

/** How long one timed batch should take. Long enough that the fence round
 * trip is a rounding error, short enough that a full sweep is seconds. */
const BATCH_MS = 25;

/** Batches per (probe, routing). The median is taken; three is enough for a
 * median to mean something and cheap enough to keep the sweep interactive. */
const DEFAULT_TRIALS = 3;

/** A round trip that resolves once the server has drained everything queued
 * before it. X processes requests in order, so a reply to a request issued
 * after a batch of drawing is an acknowledgement of the drawing. */
const fence = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Time `repeats` draws of one probe, through to the server acknowledging
 * them.
 *
 * @returns {Promise<{totalMs: number, issueMs: number}>} per draw
 */
async function timeBatch(app, ctx, opts, repeats) {
  const t0 = performance.now();
  for (let i = 0; i < repeats; i++) {
    // a different phase per draw: identical drawings would let a cache
    // anywhere in the stack answer, and the point is to make every one of
    // them go all the way through
    drawProbe(ctx, { ...opts, phase: opts.phase + i * 0.37 });
  }
  const issued = performance.now();
  await fence(app);
  const done = performance.now();
  return { totalMs: (done - t0) / repeats, issueMs: (issued - t0) / repeats };
}

/**
 * How many draws one timed batch should hold, learned from a pilot run.
 *
 * Fixed counts do not work here: a 16px star and a 512px one are three orders
 * of magnitude apart, and any single number is either swamped by the fence
 * round trip at one end or takes a minute at the other.
 */
async function batchSize(app, ctx, opts) {
  await timeBatch(app, ctx, opts, 4); // first touch: accumulator, scratch mask
  const pilot = await timeBatch(app, ctx, opts, 8);
  return Math.max(
    1,
    Math.min(256, Math.round(BATCH_MS / Math.max(pilot.totalMs, 0.02))),
  );
}

/**
 * Measure one probe both ways.
 *
 * The two routes are interleaved trial by trial rather than measured in two
 * blocks, and it matters more than it sounds like it should. Anything that
 * drifts over the seconds a probe takes — another client waking up, the
 * compositor, this VM's host deciding to schedule someone else — lands on
 * whichever block it overlaps. Alternating spreads it across both, so the
 * *comparison* survives even when neither number is clean, and the comparison
 * is the only thing the fit reads.
 */
async function measurePair(app, ctx, opts, policies, trials) {
  const runs = {
    local: { totals: [], issues: [] },
    server: { totals: [], issues: [] },
  };
  const sizes = {};
  for (const [route, policy] of Object.entries(policies)) {
    app.options.rasterPolicy = policy;
    sizes[route] = await batchSize(app, ctx, opts);
  }
  for (let t = 0; t < trials; t++) {
    for (const [route, policy] of Object.entries(policies)) {
      app.options.rasterPolicy = policy;
      const r = await timeBatch(app, ctx, opts, sizes[route]);
      runs[route].totals.push(r.totalMs);
      runs[route].issues.push(r.issueMs);
    }
  }
  const summarize = (route) => ({
    totalMs: median(runs[route].totals),
    issueMs: median(runs[route].issues),
    repeats: sizes[route],
  });
  return { local: summarize('local'), server: summarize('server') };
}

/**
 * Run the sweep.
 *
 * @param {object} app an ntk App — `createRoot().app` will do, and the
 *   example passes exactly that
 * @param {object} [opts] `{grid, trials, fills, surface, onProgress}`.
 *   `fills` is how many separate `fill()` calls each sample makes; 1 isolates
 *   the per-drawing cost, which is what the policy arbitrates. `surface` is
 *   the side of the drawable in pixels — worth moving, because the scratch a8
 *   mask ntk rasterizes trapezoids into is the size of the *drawable*, not of
 *   the drawing, and on a server whose trapezoid path is a software fallback
 *   that turns out to be most of what a small shape costs. `onProgress({done,
 *   total, sample})` is called after each probe.
 * @returns {Promise<{grid: number, samples: Array}>}
 */
export async function sweep(app, opts = {}) {
  const {
    grid = GRID,
    trials = DEFAULT_TRIALS,
    fills = 1,
    surface: side = 0,
    onProgress = null,
  } = opts;
  if (!app?.X) throw new Error('sweep: need a connected ntk App');
  if (!app.rasterizer) {
    // Nothing to arbitrate: without a rasterizer every drawing goes to the
    // server whatever the policy says, and a sweep would measure one route
    // twice. Say so rather than return a confident-looking flat result.
    throw new Error(
      'sweep: this app has no rasterizer, so local routing is unavailable ' +
        '(createClient({ rasterizer: null })?)',
    );
  }
  const maxSize = Math.max(...grid.sizes);
  // window-sized by default, so the scratch a8 fill mask is the size one
  // would be in a real app, and the probe has room around it for the
  // antialiasing slack rather than being clamped by the surface edge
  const px = Math.max(side || 768, maxSize + 32);
  const surface = new ntk.Surface(app, {
    width: px,
    height: px,
    format: 'argb32',
  });
  const ctx = surface.getContext('2d');
  const restore = app.options.rasterPolicy;
  const samples = [];
  const total = grid.sizes.length * grid.triangles.length;
  const routes = { local: FORCE_LOCAL, server: FORCE_SERVER };
  try {
    // A global warm-up, on top of the per-probe one. The first trapezoids of
    // the process pay for whatever the driver sets up the first time it is
    // asked for a path it cannot accelerate — on glamor that showed up as the
    // first rows of the grid reading several times slower than the same work
    // later on, which is a property of the run order and not of the shape.
    const warm = { x: 64, y: 64, size: 96, triangles: 24, fills: 1, phase: 0 };
    for (const policy of Object.values(routes)) {
      app.options.rasterPolicy = policy;
      await timeBatch(app, ctx, warm, 24);
    }
    for (const size of grid.sizes) {
      for (const triangles of grid.triangles) {
        const g = probeGeometry(size, triangles);
        // centred, so the drawing never reaches the surface edge and
        // `_clampBBox` never clamps — the box it measures is the box
        // probeGeometry predicted
        const at = Math.round((px - size) / 2);
        const opt = { x: at, y: at, size, triangles, fills, phase: 0 };
        const { local, server } = await measurePair(
          app,
          ctx,
          opt,
          routes,
          trials,
        );
        const sample = {
          size,
          triangles,
          fills,
          width: g.width,
          height: g.height,
          area: g.area,
          edges: g.edges,
          ratio: g.area / g.edges,
          local,
          server,
        };
        samples.push(sample);
        onProgress?.({ done: samples.length, total, sample });
      }
    }
  } finally {
    if (restore) app.options.rasterPolicy = restore;
    else delete app.options.rasterPolicy;
    ctx.destroy();
    surface.destroy();
  }
  return {
    grid: GRID_VERSION,
    sizes: grid.sizes,
    triangles: grid.triangles,
    fills,
    trials,
    surface: px,
    samples,
  };
}

/** What a policy costs over the measured grid, using each sample's measured
 * time for whichever route the policy picks. */
function totalUnder(samples, policy) {
  let sum = 0;
  for (const s of samples) {
    const local = routeRaster(s.width, s.height, s.edges, policy) === 'local';
    sum += (local ? s.local : s.server).totalMs;
  }
  return sum;
}

/**
 * Thresholds to try: the geometric midpoints between adjacent observed
 * values, plus 0 (below everything) and Infinity (above everything).
 *
 * Midpoints rather than the observed values themselves so the boundary lands
 * *between* the samples it separates — the point is to generalize to drawings
 * that were not measured, and a threshold sitting exactly on a sample is the
 * one that generalizes worst. Geometric rather than arithmetic because the
 * grid is geometric: halfway between 16900 and 66564 is 33k, not 41k.
 *
 * `Infinity` is a real candidate and not a formality. A server where local
 * wins everywhere measured is a server where the honest fit is "always
 * local", and saying that costs nothing — `maxBytes` is still there to stop
 * an unbounded upload.
 */
function candidates(values) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const out = [0];
  for (let i = 0; i + 1 < sorted.length; i++) {
    out.push(Math.sqrt(sorted[i] * sorted[i + 1]));
  }
  out.push(Infinity);
  return out;
}

/**
 * Fit `maxArea` and `bytesPerEdge` to the measurements.
 *
 * A joint search rather than one threshold then the other: they interact.
 * `maxArea` sends everything below it local regardless of complexity, so the
 * best `bytesPerEdge` depends on which samples `maxArea` has already claimed.
 * The candidate sets are one per sample, so the search is a few thousand
 * evaluations — small enough that there is no reason to be clever.
 *
 * The objective is measured milliseconds, not classification accuracy. Every
 * misrouted drawing costs what it costs, and a policy that gets nineteen
 * cheap probes right and one expensive one wrong is worse than the reverse.
 *
 * @returns {{policy: object, totals: object, speedup: number,
 *   agreement: number, headroom: number}}
 */
export function fitPolicy(samples) {
  if (!samples.length) throw new Error('fitPolicy: no samples');
  const areaCandidates = candidates(samples.map((s) => s.area));
  const ratioCandidates = candidates(samples.map((s) => s.ratio));
  // A ceiling has to sit above every area the grid measured, or it would
  // override the two thresholds under test and the fit would be reading its
  // own hand. What it *should* be in production is a separate question about
  // upload size, so ntk's answer is kept.
  const maxBytes = Math.max(
    NTK_DEFAULT.maxBytes,
    ...samples.map((s) => s.area),
  );
  let best = null;
  for (const maxArea of areaCandidates) {
    for (const bytesPerEdge of ratioCandidates) {
      const policy = { maxArea, bytesPerEdge, maxBytes };
      const cost = totalUnder(samples, policy);
      // Ties go to the *larger* thresholds, and the tie is not hypothetical:
      // when one route wins across the whole grid there is a whole family of
      // policies with identical cost, and they read very differently. Both
      // thresholds enlarge the local region, so taking the largest says
      // "everything measured wanted local" instead of picking whichever
      // equivalent pair the loop happened to reach first — a fit that prints
      // `maxArea: 0` for a machine where local won every probe is technically
      // right on the grid and actively misleading off it.
      const better =
        !best ||
        cost < best.cost - 1e-9 ||
        (cost <= best.cost + 1e-9 &&
          (maxArea > best.policy.maxArea ||
            (maxArea === best.policy.maxArea &&
              bytesPerEdge > best.policy.bytesPerEdge)));
      if (better) best = { policy, cost };
    }
  }
  // Round to numbers a human will read and paste into a config, then check
  // that the rounding did not cost anything. It reliably does not — the
  // boundary sits in a gap between sample values by construction — but the
  // reported total is the rounded policy's, so a claim is never made for a
  // policy that is not the one being handed over.
  const round = (v) => (Number.isFinite(v) ? Math.round(v) : v);
  const rounded = {
    maxArea: round(best.policy.maxArea),
    bytesPerEdge: round(best.policy.bytesPerEdge),
    maxBytes: best.policy.maxBytes,
  };
  const policy =
    totalUnder(samples, rounded) <= best.cost ? rounded : best.policy;

  const fitted = totalUnder(samples, policy);
  const totals = {
    fitted,
    ntkDefault: totalUnder(samples, NTK_DEFAULT),
    allLocal: totalUnder(samples, FORCE_LOCAL),
    allServer: totalUnder(samples, FORCE_SERVER),
    // the unreachable bound: every sample routed the way it actually measured
    // fastest. How far the fit sits above this is how much the *shape* of a
    // two-threshold policy costs, as opposed to its constants.
    oracle: samples.reduce(
      (sum, s) => sum + Math.min(s.local.totalMs, s.server.totalMs),
      0,
    ),
  };
  let agree = 0;
  for (const s of samples) {
    const picked = routeRaster(s.width, s.height, s.edges, policy);
    const better = s.local.totalMs <= s.server.totalMs ? 'local' : 'server';
    if (picked === better) agree++;
  }
  return {
    policy,
    totals,
    speedup: totals.ntkDefault / totals.fitted,
    agreement: agree / samples.length,
    headroom: totals.fitted / totals.oracle,
  };
}

/** Enough about this machine to tell two result files apart. The X vendor and
 * `isLocalSocket` are the two that actually predict the answer: a software
 * server and a glamor one disagree by an order of magnitude, and a remote
 * connection changes what an upload costs. */
export function platform(app) {
  const d = app?.display ?? {};
  return {
    os: `${process.platform} ${process.arch}`,
    node: process.version,
    display: process.env.DISPLAY ?? null,
    vendor: d.vendor ?? null,
    release: d.release ?? null,
    localSocket: d.isLocalSocket ?? null,
    screen: d.screen?.[0]
      ? `${d.screen[0].pixel_width}x${d.screen[0].pixel_height}`
      : null,
  };
}
