// Turning the measurements into a cost model, a verdict, and a table.
//
// ## Why a model rather than a score
//
// The first version of this family of tools fitted two thresholds to a grid of
// shapes and printed them. On a machine where one route wins everywhere that
// fit is `{ maxArea: Infinity, bytesPerEdge: Infinity }`, which is *correct*
// and tells you nothing: it does not say by how much, or what would have to
// change, or which of the four things in the chain put it there.
//
// The coefficients do. Each route is a line in the two variables the routing
// decision actually has:
//
//   local(area)         = Lf + Lp*area                 (rasterize, upload, composite)
//   server(area, edges) = Sf + Sp*area + Se*edges      (trapezoids)
//
// and setting them equal gives back exactly the shape of ntk's policy —
//
//   local is cheaper  ⟺  area  <  (Sf - Lf)/(Lp - Sp)  +  Se/(Lp - Sp) * edges
//                          \_______  maxArea  _______/    \_ bytesPerEdge _/
//
// — so the policy is *derived* here rather than fitted, `Infinity` has a
// reading ("Lp ≤ Sp: the client's marginal pixel is no dearer than the
// server's, so local wins at every size"), and the four coefficients travel to
// another machine in a way two thresholds never could.
import { NTK_DEFAULT } from '../raster-gate/probe.js';

/** A drawing a real UI actually makes, used to turn coefficients back into
 * something with units a person can argue with: one rounded, bordered card. */
export const CARD = { width: 130, height: 70, edges: 40 };
/** ...and a screen of them. */
export const CARDS_PER_SCREEN = 48;

const us = (v) =>
  v == null || !Number.isFinite(v)
    ? '     -'
    : v >= 10000
      ? `${(v / 1000).toFixed(1)}ms`
      : `${v.toFixed(1)}µs`;
const num = (v, d = 1) =>
  v == null || !Number.isFinite(v) ? '-' : v.toFixed(d);

/**
 * The two-line cost model, and the routing policy that falls out of it.
 */
export function costModel(r) {
  const Lf = r.coverage?.fixedUs ?? null; // µs, one local drawing, fixed
  const Lp = (r.coverage?.nsPerPixel ?? 0) / 1000; // µs per pixel
  const Sf = r.trapezoids?.fixedUs ?? null;
  // Slopes arrive already zeroed when the sweep found them flat (see
  // `summarize`), so a server whose trapezoid cost does not move with the
  // shape enters the model as the constant it measured as — which is the whole
  // point. A regression's noise-slope would otherwise flow straight into the
  // thresholds below and put the crossover somewhere it has no business being.
  const Sp = (r.trapezoids?.nsPerPixel ?? 0) / 1000;
  const Se = (r.trapezoids?.nsPerEdge ?? 0) / 1000;
  if (Lf == null || Sf == null) return null;

  const local = (area) => Lf + Lp * area;
  const server = (area, edges) => Sf + Sp * area + Se * edges;

  // The client's marginal pixel is what decides whether there is a crossover
  // at all. Dearer than the server's and there is a size past which the server
  // wins; no dearer and local wins everywhere, which is not a degenerate
  // answer but a description of the machine.
  const dp = Lp - Sp;
  const unbounded = dp <= 0;
  const maxArea = unbounded ? Infinity : Math.max(0, (Sf - Lf) / dp);
  const bytesPerEdge = unbounded ? Infinity : Math.max(0, Se / dp);
  // `maxBytes` is a ceiling on how much coverage may be uploaded in one go
  // rather than a routing choice, and it wins before the two thresholds are
  // consulted. When the crossover lands above it the ceiling is what actually
  // decides, and a policy printed without saying so would not be the policy
  // that runs.
  const ceilingBites = maxArea > NTK_DEFAULT.maxBytes;

  return {
    Lf,
    Lp,
    Sf,
    Sp,
    Se,
    local,
    server,
    unbounded,
    ceilingBites,
    /** the largest drawing for which local still pays, in pixels — the number
     * to hold next to the size of a real widget */
    crossoverArea: maxArea,
    policy: {
      maxArea: Number.isFinite(maxArea) ? Math.round(maxArea) : Infinity,
      bytesPerEdge: Number.isFinite(bytesPerEdge)
        ? Math.round(bytesPerEdge)
        : Infinity,
    },
    /** what a screenful of cards costs each way, in ms */
    screen: {
      local: (local(CARD.width * CARD.height) * CARDS_PER_SCREEN * 2) / 1000,
      server:
        (server(CARD.width * CARD.height, CARD.edges) * CARDS_PER_SCREEN * 2) /
        1000,
    },
  };
}

/**
 * Rank what is actually in the way.
 *
 * Every entry carries the number that put it there, because a bottleneck
 * without its magnitude is an opinion. Ordered by how much time it is worth on
 * this machine, not by severity in the abstract.
 */
export function verdict(r, model) {
  const out = [];
  const add = (weightMs, title, detail) =>
    out.push({ weightMs, title, detail });

  if (model) {
    const screenLocal = model.screen.local;
    const screenServer = model.screen.server;
    const best = Math.min(screenLocal, screenServer);
    const worst = Math.max(screenLocal, screenServer);
    if (worst / Math.max(best, 1e-6) > 2) {
      add(
        worst - best,
        `routing: ${screenLocal < screenServer ? 'keep rasterization local' : 'send rasterization to the server'}`,
        `a screen of ${CARDS_PER_SCREEN} bordered cards costs ${num(screenLocal)}ms local vs ` +
          `${num(screenServer)}ms server — ${num(worst / best)}x. ` +
          `ntk's defaults route a ${CARD.width}x${CARD.height} card with ${CARD.edges} edges ` +
          `to the ${routeUnder(NTK_DEFAULT)}.`,
      );
    }
  }

  if (r.trapezoids && r.trapezoids.fixedUs > 500) {
    add(
      (r.trapezoids.fixedUs * CARDS_PER_SCREEN * 2) / 1000,
      r.trapezoids.flat
        ? 'server: no accelerated trapezoid path'
        : 'server: trapezoid rasterization is expensive',
      `${us(r.trapezoids.fixedUs)} per trapezoid operation` +
        (r.trapezoids.flat
          ? `, and it does not move with the size of the shape (under ` +
            `${num(r.trapezoids.nsPerPixelBound, 2)} ns/px) or the number of edges in it ` +
            `(under ${num(r.trapezoids.nsPerEdgeBound, 1)} ns/edge). A cost that ignores its ` +
            `input is a fixed toll, not work — the signature of a software fallback. Every ` +
            `rounded corner, stroke and non-rectangular clip pays it whole.`
          : `, plus ${num(r.trapezoids.nsPerPixel, 2)} ns/px and ` +
            `${num(r.trapezoids.nsPerEdge, 2)} ns/edge. Every rounded corner, stroke and ` +
            `non-rectangular clip goes through it.`),
    );
  }

  if (r.roundTrip && r.roundTrip.medianMs > 0.4) {
    add(
      r.roundTrip.medianMs * 60,
      'transport: round trips are expensive',
      `${num(r.roundTrip.medianMs, 3)}ms median (p95 ${num(r.roundTrip.p95Ms, 3)}). ` +
        `At 60fps a single reply-bearing request per frame is ` +
        `${num(r.roundTrip.medianMs * 6, 1)}% of the frame budget. Avoid fences and readback.`,
    );
  }

  if (r.upload && Number.isFinite(r.upload.mbPerSec)) {
    // a screenful of card-sized coverage masks, uploaded once each
    const mb = (CARD.width * CARD.height * CARDS_PER_SCREEN * 2) / 1e6;
    const ms = (mb / r.upload.mbPerSec) * 1000;
    if (r.upload.mbPerSec < 500) {
      add(
        ms,
        'transport: coverage uploads are a ceiling',
        `${num(r.upload.mbPerSec, 0)} MB/s — ${num(mb, 2)}MB of masks for a screen of cards ` +
          `is ${num(ms)}ms per frame` +
          (r.shm?.available && r.shm.speedup > 1.2
            ? `. Shared memory is ${num(r.shm.speedup)}x faster here and would take it off the socket.`
            : '.'),
      );
    }
  }

  if (r.coverage && r.cpu?.coverage) {
    const perScreen =
      (r.cpu.coverage.nsPerPixel *
        CARD.width *
        CARD.height *
        CARDS_PER_SCREEN *
        2) /
      1e6;
    if (perScreen > 4) {
      add(
        perScreen,
        'client: rasterizing locally blocks the main thread',
        `${num(r.cpu.coverage.mpxPerSec, 0)} Mpx/s — a screen of cards is ${num(perScreen)}ms ` +
          `of *synchronous* JS. Nothing else runs during it: no input dispatch, no timers, ` +
          `no React. Fast enough on throughput, still felt as latency.`,
      );
    }
  }

  if (
    r.contention?.reliable &&
    r.contention.overlap != null &&
    r.contention.overlap < 0.5
  ) {
    add(
      r.contention.clientMs * (1 - r.contention.overlap),
      'both: client and server are sharing a processor',
      `overlap ${num(r.contention.overlap, 2)} (1.0 = fully concurrent, 0 = fully serialized). ` +
        `Client and server work do not proceed at once here, so moving work from one to the ` +
        `other buys much less than the isolated numbers above suggest.`,
    );
  }

  // Only worth saying when both fits actually resolved a per-pixel cost. Two
  // operations whose costs are both below the noise floor have no ratio, and
  // dividing one noise slope by another is how a benchmark invents a finding.
  if (
    r.masked &&
    r.composite &&
    !r.masked.flat &&
    !r.composite.flat &&
    r.masked.slope > r.composite.slope * 2.5
  ) {
    add(
      (r.masked.slope - r.composite.slope) *
        CARD.width *
        CARD.height *
        CARDS_PER_SCREEN *
        2,
      'server: masked composites are much dearer than plain ones',
      `${num(r.masked.slope / r.composite.slope, 1)}x per pixel. Every locally rasterized ` +
        `drawing ends in one, so this is the floor under the local route whatever the ` +
        `upload costs.`,
    );
  }

  if (r.copyArea && r.copyArea.intercept * 1000 > 50) {
    add(
      r.copyArea.intercept * 1000 * 4,
      'server: CopyArea has a large fixed cost',
      `${us(r.copyArea.intercept * 1000)} per blit before a single pixel moves. The scroll ` +
        `fast path (a pure scroll CopyArea's the band that stays visible instead of ` +
        `repainting it) is built on this request, and at that price it only pays for ` +
        `large viewports — REACT_X11_NO_SCROLL_BLIT=1 is how to check on this machine.`,
    );
  }

  if (r.download && r.upload && r.download.mbPerSec * 20 < r.upload.mbPerSec) {
    add(
      2,
      'server: reading pixels back is far slower than writing them',
      `${num(r.download.mbPerSec, 0)} MB/s down against ${num(r.upload.mbPerSec, 0)} MB/s up — ` +
        `${num(r.upload.mbPerSec / r.download.mbPerSec, 0)}x asymmetric, which is what a ` +
        `GPU-backed server looks like. Anything that reads the framebuffer (screenshots, ` +
        `\`getImageData\`, a compositing fallback) is far more expensive here than drawing.`,
    );
  }

  if (r.present && r.present.fps < 45) {
    add(
      1000 / Math.max(r.present.fps, 1) - 16.7,
      'window: frames cannot be presented at 60Hz even when empty',
      `${num(r.present.fps, 1)} fps for a frame that draws one small rectangle. That is the ` +
        `ceiling before any of this app's own work — a compositor, vsync, or a present ` +
        `path that stalls. No amount of drawing less will get past it.`,
    );
  }

  if (r.env.load != null && r.env.cpus && r.env.load > r.env.cpus * 0.5) {
    add(
      1,
      'this machine was busy while measuring',
      `load ${num(r.env.load, 2)} across ${r.env.cpus} cores. The numbers above are a ` +
        `lower bound on what it can do; re-run on an idle machine before comparing.`,
    );
  }

  out.sort((a, b) => b.weightMs - a.weightMs);
  return out;
}

const routeUnder = (policy) => {
  const area = (CARD.width + 2) * (CARD.height + 2);
  if (area <= policy.maxArea) return 'client';
  return area <= policy.bytesPerEdge * CARD.edges ? 'client' : 'server';
};

/** The whole run as text. */
export function format(r) {
  const model = costModel(r);
  const L = [];
  const head = (s) =>
    L.push('', `── ${s} ${'─'.repeat(Math.max(0, 62 - s.length))}`);
  const row = (k, v, note = '') =>
    L.push(`  ${k.padEnd(26)}${String(v).padStart(12)}  ${note}`);

  L.push(
    `react-x11 system probe — ${r.env.os}, node ${r.env.node}, ntk ${r.env.ntk ?? '?'}`,
    `  display  ${r.env.display ?? '?'}  ${r.env.vendor ?? ''}${r.env.release ? ` r${r.env.release}` : ''}`,
    `  link     ${r.env.localSocket ? 'unix socket (same machine)' : 'tcp'}` +
      (r.env.gl ? `   gl ${r.env.gl}` : ''),
    `  cpu      ${r.env.cpus} x ${r.env.cpuModel ?? '?'}   load ${num(r.env.load, 2)}`,
    r.env.label ? `  label    ${r.env.label}` : null,
    `  drawable ${r.env.drawable}`,
  );

  head('client processor');
  row(
    'scalar',
    `${num(r.cpu.scalar.mopsPerSec, 0)} Mop/s`,
    'integer mix, single core',
  );
  row(
    'coverage rasterization',
    `${num(r.cpu.coverage.mpxPerSec, 0)} Mpx/s`,
    `${num(r.cpu.coverage.nsPerPixel, 2)} ns/px + ${num(r.cpu.coverage.nsPerEdge, 1)} ns/edge (r² ${num(r.cpu.coverage.r2, 2)})`,
  );
  row(
    'allocation',
    `${num(r.cpu.alloc.gbPerSec, 2)} GB/s`,
    'Float32Array churn, as the accumulator does',
  );

  head('transport');
  row(
    'round trip',
    `${num(r.roundTrip.medianMs, 3)} ms`,
    `min ${num(r.roundTrip.minMs, 3)}  p95 ${num(r.roundTrip.p95Ms, 3)}`,
  );
  row(
    'per request (pipelined)',
    `${num(r.requestRate.usPerRequest, 1)} µs`,
    `${num(r.requestRate.issueUs, 2)} µs of it client-side`,
  );
  row(
    'upload (PutImage a8)',
    `${num(r.upload.mbPerSec, 0)} MB/s`,
    `+ ${us(r.upload.fixedUs)} fixed (r² ${num(r.upload.r2, 2)})`,
  );
  row(
    'download (GetImage)',
    `${num(r.download.mbPerSec, 0)} MB/s`,
    `+ ${us(r.download.fixedUs)} fixed (r² ${num(r.download.r2, 2)})`,
  );
  if (r.shm.available) {
    row(
      'shared memory',
      r.shm.speedup ? `${num(r.shm.speedup)}x` : 'available',
      `${num(r.shm.coreMs, 2)}ms socket vs ${num(r.shm.shmMs, 2)}ms shm for ` +
        `${num(r.shm.bytes / 1e6, 2)}MB (${r.shm.used}/${r.shm.attempts} uploads took it)`,
    );
  } else {
    row(
      'shared memory',
      'no',
      'MIT-SHM unavailable — every pixel crosses the socket',
    );
  }

  head('server drawing (per operation, and per pixel on top of it)');
  L.push(
    '  "flat" means the cost did not move with the size of the drawing — a fixed',
    '  toll rather than work, which is what a software fallback looks like.',
    '',
  );
  const perPx = (slope, flat, bound) =>
    flat
      ? `flat (<${num(bound * 1e6, 2)} ns/px)`
      : `${num(slope * 1e6, 2)} ns/px`;
  const opRow = (name, fit, note = '') =>
    fit
      ? row(
          name,
          us(fit.intercept * 1000),
          `per op, then ${perPx(fit.slope, fit.flat, fit.slopeBound)}` +
            (fit.flat ? '' : ` (r² ${num(fit.r2, 2)})`) +
            (note ? `  ${note}` : ''),
        )
      : row(name, '-', note);
  opRow('solid fill', r.fill);
  opRow('composite', r.composite);
  opRow('masked composite', r.masked, '← every local drawing ends here');
  opRow('copy area', r.copyArea, '← the scroll-blit path');
  if (r.trapezoids) {
    row(
      'trapezoids',
      us(r.trapezoids.fixedUs),
      `per op, then ` +
        (r.trapezoids.flat
          ? `flat (<${num(r.trapezoids.nsPerPixelBound, 2)} ns/px, ` +
            `<${num(r.trapezoids.nsPerEdgeBound, 1)} ns/edge)`
          : `${num(r.trapezoids.nsPerPixel, 2)} ns/px + ${num(r.trapezoids.nsPerEdge, 2)} ns/edge`),
    );
  }
  if (r.glyphs?.error) row('glyphs', 'n/a', r.glyphs.error);
  else if (r.glyphs)
    row(
      'glyphs',
      us(r.glyphs.fixedUs),
      `per run, then ` +
        (r.glyphs.flat
          ? `flat (<${num(r.glyphs.usPerGlyphBound, 2)} µs/glyph) — the server-side glyph cache working`
          : `${num(r.glyphs.usPerGlyph, 2)} µs/glyph`),
    );

  head('one drawing, both ways');
  if (r.coverage)
    row(
      'local: raster+upload+comp',
      us(r.coverage.fixedUs),
      `per drawing, then ${perPx(r.coverage.nsPerPixel / 1e6, r.coverage.flat, r.coverage.nsPerPixelBound / 1e6)}`,
    );
  if (r.trapezoids)
    row(
      'server: trapezoids',
      us(r.trapezoids.fixedUs),
      `per drawing, then ` +
        (r.trapezoids.flat
          ? 'flat'
          : `${num(r.trapezoids.nsPerPixel, 2)} ns/px`),
    );

  if (r.present) {
    head('presenting a window (only measurable with --window)');
    row(
      'frames presented',
      `${num(r.present.fps, 1)} fps`,
      `an empty frame, blitted and presented — the ceiling a compositor and ` +
        `vsync leave, before anything is drawn`,
    );
    row('fence at present', `${num(r.present.fenceMedianMs, 2)} ms`, 'median');
  }

  head('client / server concurrency');
  if (!r.contention) {
    row('overlap', 'not run', '');
  } else if (!r.contention.reliable) {
    row(
      'overlap',
      'inconclusive',
      `server batch ${num(r.contention.serverMs)}ms, client ${num(r.contention.clientMs)}ms, ` +
        `${num(r.contention.issueShare * 100, 0)}% of the server timing was issuing — too short or too write-bound to compare`,
    );
  } else {
    row(
      'overlap',
      num(r.contention.overlap, 2),
      `1 = fully concurrent, 0 = serialized. ` +
        `server ${num(r.contention.serverMs)}ms + client ${num(r.contention.clientMs)}ms ` +
        `→ together ${num(r.contention.bothMs)}ms`,
    );
  }

  head('cost model');
  if (!model) {
    L.push('  (needs both routing probes)');
  } else {
    L.push(
      `  local(area)         = ${us(model.Lf)} + ${num(model.Lp * 1000, 2)} ns/px * area`,
      `  server(area, edges) = ${us(model.Sf)} + ${num(model.Sp * 1000, 2)} ns/px * area` +
        ` + ${num(model.Se * 1000, 2)} ns * edges`,
      '',
      `  a ${CARD.width}x${CARD.height} card, ${CARD.edges} edges:` +
        `  local ${us(model.local(CARD.width * CARD.height))}` +
        `   server ${us(model.server(CARD.width * CARD.height, CARD.edges))}`,
      `  a screen of ${CARDS_PER_SCREEN} of them (background + border):` +
        `  local ${num(model.screen.local)}ms   server ${num(model.screen.server)}ms`,
      '',
      model.unbounded
        ? `  No crossover at any size: the client's marginal pixel (${num(model.Lp * 1000, 2)} ns) is` +
            `\n  no dearer than the server's (${num(model.Sp * 1000, 2)} ns). The thresholds below are` +
            `\n  Infinity because the *slopes* say so, not because a fit ran out of room.`
        : `  Crossover at area = ${fmtInt(model.policy.maxArea)}` +
            (model.policy.bytesPerEdge
              ? ` + ${model.policy.bytesPerEdge} * edges`
              : '') +
            ` px — below it local is cheaper.` +
            `\n  ${describeCrossover(model.crossoverArea)}`,
      '',
      `    root.app.options.rasterPolicy = { maxArea: ${fmtNum(model.policy.maxArea)}, ` +
        `bytesPerEdge: ${fmtNum(model.policy.bytesPerEdge)} };`,
      model.ceilingBites
        ? `\n  That crossover is past ntk's \`maxBytes\` ceiling of ${fmtInt(NTK_DEFAULT.maxBytes)}px,` +
            `\n  which is consulted first — so in practice the ceiling is what stops a drawing` +
            `\n  going local, and the two thresholds above never get a chance to. Raise` +
            `\n  \`maxBytes\` too if you mean it, and understand it as "how large an upload am I` +
            `\n  willing to make", which is a different question from routing.`
        : null,
      '',
      `  ntk's default is { maxArea: ${NTK_DEFAULT.maxArea}, bytesPerEdge: ${NTK_DEFAULT.bytesPerEdge} }` +
        ` — it routes that card to the ${routeUnder(NTK_DEFAULT)}.`,
    );
  }

  head('bottlenecks, worst first');
  const v = verdict(r, model);
  if (!v.length) {
    L.push(
      '  Nothing stands out: no link in the chain dominates the others here.',
    );
  } else {
    v.forEach((item, i) => {
      L.push(`  ${i + 1}. ${item.title}`);
      for (const line of wrap(item.detail, 68)) L.push(`     ${line}`);
    });
  }

  return L.filter((x) => x !== null).join('\n');
}

const fmtNum = (v) => (Number.isFinite(v) ? String(v) : 'Infinity');
const fmtInt = (v) =>
  Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : 'Infinity';

/** A pixel count is hard to hold; a widget is not. This is what turns
 * "crossover at 3,610,000px" into a sentence about the thing being drawn. */
function describeCrossover(area) {
  const side = Math.round(Math.sqrt(area));
  if (area >= 1920 * 1080)
    return `That is larger than a 1080p screen (${side}x${side}) — nothing a UI draws reaches it, so every drawing should be local.`;
  if (area >= 512 * 512)
    return `That is a ${side}x${side} box — larger than any widget, and about the size of a full illustration.`;
  if (area >= 128 * 128)
    return `That is a ${side}x${side} box — a card or a large icon, so widgets go local and illustrations do not.`;
  if (area >= 32 * 32)
    return `That is a ${side}x${side} box — only small controls stay local here.`;
  return `That is a ${side}x${side} box — smaller than most controls, so almost everything should go to the server.`;
}

function wrap(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}
