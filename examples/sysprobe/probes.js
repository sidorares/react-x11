// The individual measurements, each isolating one thing.
//
// A UI frame is a chain, and any link can be the slow one:
//
//   JS builds the drawing  →  bytes cross a socket  →  the server draws
//        (client CPU)          (transport, or SHM)      (driver, server CPU)
//
// and on a local connection the first and third links are *competing for the
// same processor*, which is a fifth thing worth knowing and the easiest to
// forget. Nothing here reports a score. Each probe reports the two numbers a
// cost model needs — a fixed cost per operation and a marginal cost per unit —
// because those are what stay meaningful when you carry them to another
// machine, and a single "how fast is it" number is not.
//
// ## Every probe is a slope, not a point
//
// A measurement at one size cannot separate "this operation has a large fixed
// cost" from "this operation is expensive per pixel", and those two want
// opposite fixes: the first says batch, the second says draw less. So every
// probe sweeps a size and fits a line. The intercept is the fixed cost, the
// slope is the marginal cost, and `r2` says whether the line was a fair
// description of what happened.
//
// ## Why the fence
//
// X is asynchronous. A client can be finished with a frame long before the
// server is, so wall-clock around the drawing calls measures nothing but the
// socket. Every server-side probe ends in a `GetInputFocus` round trip:
// requests are processed in order, so a reply to one issued afterwards is an
// acknowledgement of everything before it.
import * as ntk from 'ntk';

// The probe shape is shared with examples/raster-gate, deliberately. Its whole
// design is that bounding box and edge count move independently (see that
// file), which is what lets the trapezoid and coverage probes below sweep one
// with the other held still. Two definitions of "the shape" would mean the two
// examples could not be read against each other.
import {
  FORCE_LOCAL,
  FORCE_SERVER,
  drawProbe,
  probeGeometry,
} from '../raster-gate/probe.js';

/** A round trip that resolves once the server has drained everything queued
 * before it. */
export const fence = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Least squares through `(x, y)`, plus the r² that says whether a line was
 * the right shape for the data.
 *
 * A poor r² is a real finding rather than a failed measurement: it means the
 * cost is not linear in what was swept — a cache tier boundary, a driver
 * changing its mind about a fallback, a pixmap migrating between system and
 * video memory. The report prints it for exactly that reason.
 */
export function fitLine(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

/**
 * Turn a raw fit into something safe to read.
 *
 * A regression through points that do not actually depend on x produces a
 * slope made of noise, and about half the time that noise is negative — which
 * would print as "this operation gets cheaper the bigger it is". The honest
 * reading is not a number at all: it is *flat*, meaning the per-unit cost is
 * somewhere below what the per-operation cost lets us resolve.
 *
 * So a fit that explains little (`r2` low) or slopes the wrong way is marked
 * `flat`, its slope is taken as zero, its fixed cost becomes the median of
 * what was measured rather than an extrapolated intercept, and it carries an
 * upper bound on the slope it *could* have had without being noticed. That
 * bound is the useful thing: "under 0.3 ns/px" is a real constraint on a cost
 * model, and "-132 ns/px" is not.
 *
 * Flatness is also a diagnosis in its own right. An operation whose cost does
 * not move with its size is not doing per-pixel work — it is paying a fixed
 * toll, which on a server means a fallback, a pipeline flush or a round trip,
 * and those want completely different remedies from work that scales.
 */
export function summarize(points, xKey = 'x') {
  const xs = points.map((p) => p[xKey]);
  const ys = points.map((p) => p.ms);
  const fit = fitLine(xs, ys);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  // Two points fit a line exactly, so r² is 1 whatever they are and says
  // nothing about whether a line was the right shape. Three is the minimum
  // that can disagree with itself, so anything less is treated as flat rather
  // than as a perfect fit.
  const flat = points.length < 3 || !(fit.r2 >= 0.5) || fit.slope <= 0;
  return {
    flat,
    slope: flat ? 0 : fit.slope,
    // what a slope could have been and still hidden inside the spread
    slopeBound: spanX > 0 ? Math.max(0, spanY) / spanX : 0,
    intercept: flat ? median(ys) : Math.max(fit.intercept, 0),
    r2: fit.r2,
    points,
  };
}

/** How long one timed batch should take: long enough that the fence round
 * trip is a rounding error, short enough that a whole run is under a minute. */
const BATCH_MS = 20;

/**
 * Time `issue(i)` — one unit of server work — through to the server
 * acknowledging it.
 *
 * The batch size comes from a pilot rather than a constant. A `FillRectangles`
 * and a trapezoid rasterization on a glamor fallback are four orders of
 * magnitude apart, and any fixed count is either swamped by the fence at one
 * end or takes a minute at the other.
 *
 * @returns {Promise<{ms: number, issueMs: number, batch: number}>} per unit.
 *   `issueMs` is the client's share — building and writing the requests — and
 *   the rest is the server draining them. When `issueMs` approaches `ms` the
 *   client is the bottleneck for that operation, which is worth seeing.
 */
export async function timeServer(app, issue, { trials = 5 } = {}) {
  const once = async (n) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) issue(i);
    const issued = performance.now();
    await fence(app);
    return { ms: (performance.now() - t0) / n, issueMs: (issued - t0) / n };
  };
  await once(2); // first touch: allocations here and in the server
  const pilot = await once(4);
  const batch = Math.max(
    1,
    Math.min(512, Math.round(BATCH_MS / Math.max(pilot.ms, 0.005))),
  );
  const runs = [];
  for (let t = 0; t < trials; t++) runs.push(await once(batch));
  return {
    ms: median(runs.map((r) => r.ms)),
    issueMs: median(runs.map((r) => r.issueMs)),
    batch,
  };
}

/** The same, for work that never touches X. No fence, because there is
 * nothing to wait for — which is itself the reason client-side work is worth
 * separating out. */
export function timeClient(run, { trials = 5 } = {}) {
  const once = (n) => {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) run(i);
    return (performance.now() - t0) / n;
  };
  once(2);
  const pilot = once(4);
  const batch = Math.max(
    1,
    Math.min(4096, Math.round(BATCH_MS / Math.max(pilot, 0.002))),
  );
  const runs = [];
  for (let t = 0; t < trials; t++) runs.push(once(batch));
  return { ms: median(runs), batch };
}

/** Sweep `sizes`, time each, fit a line against `x(size)`. */
async function sweepServer(sizes, x, issueFor, opts) {
  const points = [];
  for (const size of sizes) {
    const r = await timeServer(app0, issueFor(size), opts);
    points.push({ size, x: x(size), ms: r.ms, issueMs: r.issueMs });
  }
  return summarize(points);
}

// `sweepServer` needs the app; rather than thread it through every call site
// the module is handed one for the duration of a run. One connection per run,
// one run per process — this is a benchmark, not a library.
let app0 = null;
export const useApp = (app) => {
  app0 = app;
};

// --- the client's processor -------------------------------------------------

/**
 * A fixed integer mix, for comparing two machines' single-core throughput.
 *
 * Deliberately boring, and deliberately not a proxy for anything: it exists so
 * that when the coverage number below is low you can tell "this CPU is slow"
 * from "this V8 is slow at *that*". Single-threaded on purpose — so is the
 * renderer.
 */
export function cpuScalar() {
  const ITER = 2_000_000;
  const r = timeClient(() => {
    let h = 0x811c9dc5;
    for (let i = 0; i < ITER; i++) {
      h ^= i;
      h = Math.imul(h, 0x01000193);
      h ^= h >>> 13;
    }
    return h;
  });
  return { mopsPerSec: ITER / (r.ms * 1000), ms: r.ms };
}

/**
 * Coverage rasterization throughput, through the same rasterizer ntk uses.
 *
 * This is the cost of *choosing the client*: every drawing routed local is
 * this work, on the main thread, before anything reaches the socket. Two
 * sweeps rather than one, because the accumulator's cost has two terms — area
 * (the integrate-and-emit pass over the grid) and edges (depositing signed
 * area) — and a policy that trades one route for the other needs both.
 */
export function cpuCoverage() {
  const rasterizer = ntk.defaultRasterizer();
  const run = (size, triangles) => {
    const g = probeGeometry(size, triangles);
    const polys = [];
    for (let i = 0; i < g.pts.length; i += 6) {
      polys.push([
        g.pts[i],
        g.pts[i + 1],
        g.pts[i + 2],
        g.pts[i + 3],
        g.pts[i + 4],
        g.pts[i + 5],
      ]);
    }
    return {
      polys,
      width: g.width,
      height: g.height,
      area: g.area,
      edges: g.edges,
    };
  };
  const measure = (size, triangles) => {
    const job = run(size, triangles);
    const r = timeClient(() =>
      rasterizer.rasterize({
        polys: job.polys,
        width: job.width,
        height: job.height,
        rule: 'nonzero',
        dx: 0,
        dy: 0,
      }),
    );
    return { ...job, ms: r.ms };
  };
  // area at fixed complexity, then complexity at fixed area
  const byArea = [64, 128, 192, 256, 384].map((s) => measure(s, 24));
  const byEdges = [8, 32, 96, 256, 512].map((t) => measure(128, t));
  const area = fitLine(
    byArea.map((p) => p.area),
    byArea.map((p) => p.ms),
  );
  const edges = fitLine(
    byEdges.map((p) => p.edges),
    byEdges.map((p) => p.ms),
  );
  return {
    nsPerPixel: area.slope * 1e6,
    nsPerEdge: edges.slope * 1e6,
    fixedUs: area.intercept * 1000,
    r2: Math.min(area.r2, edges.r2),
    mpxPerSec: area.slope > 0 ? 1 / (area.slope * 1000) : 0,
  };
}

/**
 * Allocation and collection throughput.
 *
 * Local rasterization allocates a `Float32Array` the size of the drawing's
 * bounding box for every drawing and drops it, so on a wall of them the
 * collector is part of the frame whether or not it shows up in a profile as
 * such. A machine that rasterizes fast but allocates slowly still stutters.
 */
export function cpuAlloc() {
  const N = 1 << 16; // 256KB per allocation, the size of a 256x256 accumulator
  // Two things have to be true for this to mean anything. The allocation has
  // to be observable — an engine that can prove nobody reads the array may
  // skip creating it, and the first version of this probe measured 77 GB/s by
  // asking it to do exactly that. And every element has to be written, because
  // that is what the accumulator does: a pass that touches one float per page
  // measures page faults, not the memory bandwidth a rasterizer actually
  // needs. `sink` is what makes both survive optimization.
  let sink = 0;
  const r = timeClient(() => {
    const a = new Float32Array(N);
    for (let i = 0; i < N; i++) a[i] = i;
    sink += a[N - 1];
  });
  allocSink = sink;
  return { gbPerSec: (N * 4) / (r.ms * 1e6), ms: r.ms };
}
export let allocSink = 0;

// --- the wire ---------------------------------------------------------------

/**
 * Sequential round-trip time: issue one request with a reply, wait, repeat.
 *
 * The number that decides whether a design may ask the server anything. A
 * local socket answers in tens of microseconds and a round trip is a rounding
 * error; over ssh it is milliseconds and every reply-bearing request is a
 * frame. It also sets the floor under every other measurement here, since they
 * all end in one.
 */
export async function roundTrip(app, { samples = 200 } = {}) {
  for (let i = 0; i < 20; i++) await fence(app); // warm the path
  const times = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    await fence(app);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    minMs: times[0],
    medianMs: median(times),
    p95Ms: times[Math.floor(times.length * 0.95)],
    maxMs: times[times.length - 1],
  };
}

/**
 * Per-request cost when requests are pipelined — many issued, one reply
 * awaited.
 *
 * Against the round trip above this separates "the link is slow" from "the
 * link is far away". A high round trip with a low per-request cost is a
 * distant server that streams fine, and the remedy is to stop asking
 * questions. Both high is a saturated link, and the remedy is to send less.
 */
export async function requestRate(app, surface) {
  const R = app.display.Render;
  const pict = surface.picture(app).id;
  const r = await timeServer(app, () =>
    R.FillRectangles(R.PictOp.Over, pict, [0.1, 0.2, 0.3, 0.4], [0, 0, 1, 1]),
  );
  return { usPerRequest: r.ms * 1000, issueUs: r.issueMs * 1000 };
}

/** Make a depth-8 pixmap and a GC for it — the shape a coverage upload
 * targets. */
function maskTarget(app, side) {
  const pixmap = new ntk.Pixmap(app, { depth: 8, width: side, height: side });
  const gc = app.X.AllocID();
  app.X.CreateGC(gc, pixmap.id, {});
  return { pixmap, gc };
}

/**
 * Upload throughput: `PutImage` of 8-bit coverage, swept over size.
 *
 * This is the road local rasterization sends everything down. The slope is
 * bytes per second on this link, the intercept is what one upload costs before
 * any bytes — and on a fast local socket the intercept is most of a small
 * upload, which is why the mask cache in a renderer matters more than the mask
 * size does.
 */
export async function upload(app, { sizes = [64, 128, 256, 512, 1024] } = {}) {
  const side = Math.max(...sizes);
  const { pixmap, gc } = maskTarget(app, side);
  const points = [];
  try {
    for (const s of sizes) {
      const data = Buffer.alloc(s * s, 0xa0);
      const r = await timeServer(app, () =>
        app.X.PutImage(2, pixmap.id, gc, s, s, 0, 0, 0, 8, data),
      );
      points.push({ bytes: s * s, ms: r.ms, issueMs: r.issueMs });
    }
  } finally {
    app.X.FreeGC(gc);
    pixmap.destroy();
  }
  const fit = summarize(points, 'bytes');
  return {
    mbPerSec: fit.slope > 0 ? 1 / (fit.slope * 1000) : Infinity,
    fixedUs: fit.intercept * 1000,
    flat: fit.flat,
    r2: fit.r2,
    points,
  };
}

/** Readback throughput: `GetImage`, swept over size. Rare in a UI — but a
 * renderer that ever reads pixels back (screenshots, `getImageData`, a
 * compositing fallback) pays this, and it is usually much worse than the
 * upload direction. */
export async function download(
  app,
  surface,
  { sizes = [64, 128, 256, 512] } = {},
) {
  const X = app.X;
  const points = [];
  for (const s of sizes) {
    const t0 = performance.now();
    const N = 8;
    for (let i = 0; i < N; i++) {
      await new Promise((resolve, reject) =>
        X.GetImage(2, surface.pixmap.id, 0, 0, s, s, 0xffffffff, (err) =>
          err ? reject(err) : resolve(),
        ),
      );
    }
    points.push({ bytes: s * s * 4, ms: (performance.now() - t0) / N });
  }
  const fit = summarize(points, 'bytes');
  return {
    mbPerSec: fit.slope > 0 ? 1 / (fit.slope * 1000) : Infinity,
    fixedUs: fit.intercept * 1000,
    flat: fit.flat,
    r2: fit.r2,
    points,
  };
}

/**
 * Can this connection bypass the socket, and is it worth it?
 *
 * MIT-SHM writes the pixels into memory the server already has mapped, so the
 * bytes never travel. It is only possible when client and server are the same
 * machine, which makes this the probe that answers "am I actually local" in
 * the only way that matters — not by looking at `$DISPLAY`, but by trying it.
 *
 * Both sides are measured the same way: one upload, one fence, repeat. That
 * serializes them, so what comes out is per-upload latency rather than peak
 * throughput — the right comparison here, because the question is whether a
 * frame's uploads land sooner, not how fast a bulk copy could go.
 */
export async function sharedMemory(app, { bytes = 1 << 20 } = {}) {
  const ready = await new Promise((resolve) => app.shm.resolve(resolve));
  const side = Math.round(Math.sqrt(bytes));
  const { pixmap, gc } = maskTarget(app, side);
  const data = Buffer.alloc(side * side, 0xa0);
  const serialized = async (put) => {
    const times = [];
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      const ok = put();
      await fence(app);
      if (i >= 4 && ok !== false) times.push(performance.now() - t0);
    }
    return times.length ? median(times) : null;
  };
  try {
    const coreMs = await serialized(() => {
      app.X.PutImage(2, pixmap.id, gc, side, side, 0, 0, 0, 8, data);
      return true;
    });
    if (!ready) {
      return {
        available: false,
        coreMs,
        shmMs: null,
        speedup: null,
        bytes: side * side,
      };
    }
    let attempts = 0;
    let used = 0;
    const shmMs = await serialized(() => {
      attempts++;
      // The uploader keeps a small pool of segments and warms a new one in the
      // background when it has none free, so the first calls legitimately
      // decline. Counting them is how the report can say "available but the
      // pool never caught up" rather than quietly reporting the fallback's
      // number as shared memory's.
      const ok = app.shm.putImage(pixmap.id, gc, {
        width: side,
        height: side,
        depth: 8,
        data,
      });
      if (ok) used++;
      return ok;
    });
    return {
      available: true,
      used,
      attempts,
      coreMs,
      shmMs,
      speedup: shmMs && coreMs ? coreMs / shmMs : null,
      bytes: side * side,
    };
  } finally {
    app.X.FreeGC(gc);
    pixmap.destroy();
  }
}

// --- the server's drawing engine -------------------------------------------

const SIZES = [32, 64, 128, 256, 512];

/** Solid fill through XRender — the cheapest thing a server can be asked to
 * do, and therefore the baseline every other server number is read against.
 * `Over` rather than `Src` because that is what real drawing asks for and
 * `Src` can take a memcpy path that flatters the result. */
export async function serverFill(app, surface, sizes = SIZES) {
  const R = app.display.Render;
  const pict = surface.picture(app).id;
  return sweepServer(
    sizes,
    (s) => s * s,
    (s) => () =>
      R.FillRectangles(R.PictOp.Over, pict, [0.2, 0.4, 0.6, 0.5], [0, 0, s, s]),
  );
}

/** A solid source composited over the destination: the operation every
 * background, every border and every cached surface ends in. */
export async function serverComposite(app, surface, sizes = SIZES) {
  const R = app.display.Render;
  const pict = surface.picture(app).id;
  const src = app.solidPicture(0.2, 0.4, 0.6, 0.5).id;
  return sweepServer(
    sizes,
    (s) => s * s,
    (s) => () =>
      R.Composite(R.PictOp.Over, src, 0, pict, 0, 0, 0, 0, 0, 0, s, s),
  );
}

/**
 * The same composite through an 8-bit mask.
 *
 * This is the last step of *every* locally rasterized drawing, so its cost is
 * the floor under the local route no matter how fast the client is. A server
 * that composites solids quickly but masked solids slowly — some do, the mask
 * sampler is a different path — makes local rasterization much less
 * attractive than the upload number alone would suggest.
 */
export async function serverMaskedComposite(app, surface, mask, sizes = SIZES) {
  const R = app.display.Render;
  const pict = surface.picture(app).id;
  const src = app.solidPicture(0.2, 0.4, 0.6, 0.5).id;
  const m = mask.picture(app).id;
  return sweepServer(
    sizes,
    (s) => s * s,
    (s) => () =>
      R.Composite(R.PictOp.Over, src, m, pict, 0, 0, 0, 0, 0, 0, s, s),
  );
}

/** `CopyArea` within one drawable — the scroll-blit path. Usually the fastest
 * per pixel a server has, and when it is not, scrolling is why the app feels
 * slow. */
export async function serverCopyArea(app, surface, sizes = SIZES) {
  const X = app.X;
  const gc = X.AllocID();
  X.CreateGC(gc, surface.pixmap.id, {});
  try {
    return await sweepServer(
      sizes,
      (s) => s * s,
      (s) => () =>
        X.CopyArea(surface.pixmap.id, surface.pixmap.id, gc, 0, 0, 4, 4, s, s),
    );
  } finally {
    X.FreeGC(gc);
  }
}

/**
 * Trapezoid rasterization, reached the way a real drawing reaches it: a 2d
 * `fill()` with the routing policy pinned to the server.
 *
 * The operation this whole family of examples exists for. It is what a rounded
 * corner, a stroke and a non-rectangular clip all become, and it is the one
 * with no accelerated implementation on a glamor-class server — where it turns
 * into a fixed multi-millisecond stall that has nothing to do with how big or
 * complex the shape was. Two sweeps, so that flatness is visible as flatness:
 * a cost that does not move with either area or edge count is the signature of
 * a fallback, and it wants a completely different remedy from a cost that
 * scales.
 */
export async function serverTrapezoids(app, ctx, sizes = [32, 64, 128, 256]) {
  const before = app.options.rasterPolicy;
  app.options.rasterPolicy = FORCE_SERVER;
  try {
    const byArea = [];
    for (const s of sizes) {
      const g = probeGeometry(s, 24);
      const r = await timeServer(app, () =>
        drawProbe(ctx, { x: 8, y: 8, size: s, triangles: 24, phase: 0 }),
      );
      byArea.push({
        size: s,
        area: g.area,
        edges: g.edges,
        ms: r.ms,
        issueMs: r.issueMs,
      });
    }
    const byEdges = [];
    for (const t of [8, 32, 96, 256]) {
      const g = probeGeometry(128, t);
      const r = await timeServer(app, () =>
        drawProbe(ctx, { x: 8, y: 8, size: 128, triangles: t, phase: 0 }),
      );
      byEdges.push({
        triangles: t,
        area: g.area,
        edges: g.edges,
        ms: r.ms,
        issueMs: r.issueMs,
      });
    }
    const area = summarize(byArea, 'area');
    const edges = summarize(byEdges, 'edges');
    return {
      fixedUs: area.intercept * 1000,
      nsPerPixel: area.slope * 1e6,
      nsPerEdge: edges.slope * 1e6,
      // Both flat is the finding, not a failed measurement: a cost that moves
      // with neither the size of the shape nor the number of edges in it is a
      // fixed toll, and on this operation that means the server has no
      // accelerated trapezoid path at all.
      flat: area.flat && edges.flat,
      nsPerPixelBound: area.slopeBound * 1e6,
      nsPerEdgeBound: edges.slopeBound * 1e6,
      r2: Math.max(area.r2, edges.r2),
      byArea,
      byEdges,
    };
  } finally {
    if (before) app.options.rasterPolicy = before;
    else delete app.options.rasterPolicy;
  }
}

/**
 * The same drawings routed the other way: rasterized here, uploaded as an a8
 * mask, composited. Client CPU plus wire plus a masked composite, measured
 * end to end rather than added up — so the report has both the sum of the
 * parts and the thing itself to check it against.
 */
export async function clientCoverage(app, ctx, sizes = [32, 64, 128, 256]) {
  const before = app.options.rasterPolicy;
  app.options.rasterPolicy = FORCE_LOCAL;
  try {
    const byArea = [];
    for (const s of sizes) {
      const g = probeGeometry(s, 24);
      const r = await timeServer(app, () =>
        drawProbe(ctx, { x: 8, y: 8, size: s, triangles: 24, phase: 0 }),
      );
      byArea.push({
        size: s,
        area: g.area,
        edges: g.edges,
        ms: r.ms,
        issueMs: r.issueMs,
      });
    }
    const area = summarize(byArea, 'area');
    return {
      fixedUs: area.intercept * 1000,
      nsPerPixel: area.slope * 1e6,
      flat: area.flat,
      nsPerPixelBound: area.slopeBound * 1e6,
      r2: area.r2,
      byArea,
    };
  } finally {
    if (before) app.options.rasterPolicy = before;
    else delete app.options.rasterPolicy;
  }
}

/**
 * Text. Shaped once and drawn as a glyph run, which is the one path where
 * every server is expected to be good — the glyphs live in a server-side cache
 * and a run is one request. Worth measuring anyway, because when it is *not*
 * good the symptom is an app that is slow everywhere at once and no single
 * screen looks like the culprit.
 *
 * Returns null when the machine cannot produce a font at all, which happens in
 * containers and is a finding rather than an error.
 */
export async function serverGlyphs(app, ctx) {
  const line = 'The quick brown fox jumps over the lazy dog 0123456789';
  try {
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line, 8, 40);
    await fence(app);
  } catch (err) {
    return { error: err.message };
  }
  const points = [];
  for (const chars of [8, 16, 32, 53]) {
    const text = line.slice(0, chars);
    const r = await timeServer(app, (i) =>
      ctx.fillText(text, 8, 40 + (i % 8) * 16),
    );
    points.push({ chars, ms: r.ms, issueMs: r.issueMs });
  }
  const fit = summarize(points, 'chars');
  return {
    usPerGlyph: fit.slope * 1000,
    // A flat glyph fit is the good outcome and worth naming: it means the run
    // costs the same whatever is in it, which is what a server-side glyph
    // cache is supposed to buy.
    flat: fit.flat,
    usPerGlyphBound: fit.slopeBound * 1000,
    fixedUs: fit.intercept * 1000,
    r2: fit.r2,
    points,
  };
}

// --- do the two processors share one machine, and one processor? -----------

/**
 * How much client work and server work actually overlap.
 *
 * Everything else here measures the two sides in isolation, which quietly
 * assumes they can proceed at once. On a remote server they can. On a local
 * one they are two processes on the same cores, and a renderer that "moves
 * work off the server onto the client" may have moved it onto the same
 * processor the server was going to use — the total does not improve, it just
 * changes hands.
 *
 * Three timings: the server batch alone, the client batch alone, and both
 * issued together. If they overlap perfectly the third is the larger of the
 * first two; if they serialize completely it is their sum. So
 *
 *   overlap = (client + server - both) / min(client, server)
 *
 * lands at 1 for perfect concurrency and 0 for none. Reported with the raw
 * three so a strange answer can be read rather than trusted.
 *
 * ## The trap this probe is mostly made of
 *
 * node-x11 batches requests and flushes them from a `setImmediate`. So a
 * client loop that runs *synchronously* after issuing the server batch keeps
 * the event loop to itself, the flush never runs, and the server has not
 * received a single byte by the time the client is done. Measured naively,
 * every machine on earth reports an overlap of exactly zero — a beautiful,
 * reproducible, entirely self-inflicted result.
 *
 * Hence the `yield` below: the batch is issued, the loop is given one turn so
 * the write actually reaches the socket, and only then does the clock start.
 * The same yield happens in the server-only run, so the two remain comparable.
 *
 * The other caveat is real and the report prints it: the batch has to fit in
 * the socket buffer, because a larger one blocks in the write and that wait
 * *is* client time. So the batch is capped, and when the cap leaves the server
 * side too short for the comparison to mean anything, the result says so
 * rather than guessing.
 */
export async function contention(app, ctx, serverOpMs) {
  const rasterizer = ntk.defaultRasterizer();
  const g = probeGeometry(256, 24);
  const polys = [];
  for (let i = 0; i < g.pts.length; i += 6) {
    polys.push([
      g.pts[i],
      g.pts[i + 1],
      g.pts[i + 2],
      g.pts[i + 3],
      g.pts[i + 4],
      g.pts[i + 5],
    ]);
  }
  const clientUnit = () =>
    rasterizer.rasterize({
      polys,
      width: g.width,
      height: g.height,
      rule: 'nonzero',
    });

  const TARGET_MS = 150;
  // capped so the queued requests stay inside the socket buffer; past that the
  // issue loop blocks on the write and stops being "client time"
  const MAX_OPS = 48;
  const serverOps = Math.min(
    MAX_OPS,
    Math.max(1, Math.round(TARGET_MS / Math.max(serverOpMs, 0.01))),
  );
  const one = timeClient(clientUnit, { trials: 3 }).ms;
  const clientOps = Math.max(1, Math.round(TARGET_MS / Math.max(one, 0.01)));

  const before = app.options.rasterPolicy;
  app.options.rasterPolicy = FORCE_SERVER;
  const issueServer = () => {
    for (let i = 0; i < serverOps; i++)
      drawProbe(ctx, { x: 8, y: 8, size: 128, triangles: 24, phase: i * 0.3 });
  };
  const runClient = () => {
    for (let i = 0; i < clientOps; i++) clientUnit();
  };
  // two turns: the first runs node-x11's own scheduled flush, the second
  // gives the write a chance to reach the kernel before the clock starts
  const yieldTwice = async () => {
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
  };
  try {
    const timeBoth = async (doServer, doClient) => {
      const issueStart = performance.now();
      if (doServer) issueServer();
      const issueMs = performance.now() - issueStart;
      await yieldTwice();
      const t0 = performance.now();
      if (doClient) runClient();
      if (doServer) await fence(app);
      return { ms: performance.now() - t0, issueMs };
    };
    await timeBoth(true, true); // warm
    const runs = [];
    for (let t = 0; t < 3; t++) {
      const s = await timeBoth(true, false);
      const c = await timeBoth(false, true);
      const b = await timeBoth(true, true);
      runs.push({ s, c, b });
    }
    const serverMs = median(runs.map((r) => r.s.ms));
    const clientMs = median(runs.map((r) => r.c.ms));
    const bothMs = median(runs.map((r) => r.b.ms));
    const issueShare =
      median(runs.map((r) => r.s.issueMs)) / Math.max(serverMs, 1e-6);
    const smaller = Math.min(serverMs, clientMs);
    return {
      serverMs,
      clientMs,
      bothMs,
      serverOps,
      clientOps,
      issueShare,
      // Unreliable when issuing the server batch was itself most of the server
      // timing (the write blocked), or when one side is so much smaller than
      // the other that the difference is inside the noise.
      reliable: issueShare < 0.5 && smaller > 15 && serverMs > 25,
      overlap:
        smaller > 0
          ? Math.max(0, Math.min(1, (clientMs + serverMs - bothMs) / smaller))
          : null,
    };
  } finally {
    if (before) app.options.rasterPolicy = before;
    else delete app.options.rasterPolicy;
  }
}
