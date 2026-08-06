// What is slow about *this* machine, and which of the four things it could be?
//
//   npm run examples:sysprobe                    # ~30s, no window, prints a table
//   npm run examples:sysprobe -- --window        # same, in a mapped window you can watch
//   npm run examples:sysprobe -- --json out.json # keep the raw numbers
//   npm run examples:sysprobe -- --label "thinkpad, ssh from the laptop"
//   npm run examples:sysprobe -- --quick         # ~12s, fewer trials
//
// Needs `$DISPLAY`. Runs unattended and exits; nothing here waits for input.
//
// ## What it is for
//
// A UI frame is a chain, and any link can be the slow one:
//
//   JS builds the drawing → bytes cross a socket → the server draws it
//        client CPU            transport/SHM         driver, server CPU
//
// and when client and server are the same machine there is a fifth thing: the
// two links are *competing for one processor*, so moving work between them can
// buy nothing at all. Which link is short and which is long is not a property
// of react-x11 — it is a property of the machine, the driver, the link and the
// window system, and no single default can be right across them.
//
// So this measures each link separately, in the units a cost model needs (a
// fixed cost per operation and a marginal cost per pixel or per byte), and
// then prints:
//
//   - the model, as two lines you can evaluate for any drawing
//   - the routing policy that falls out of it, derived rather than fitted
//   - the bottlenecks, worst first, each with the number that put it there
//
// Two of these from two machines are directly comparable, which one score
// would not be. `--json` is the same thing in a form you can diff.
//
// ## Window or no window
//
// The measurements are identical either way — everything is drawn into an
// offscreen pixmap, which is also what react-x11 paints into (ntk's 2d
// contexts on windows draw into a backing pixmap and blit). `--window` adds a
// visible window that shows progress and the result, and one measurement that
// only exists when there is a window to make it: how fast frames can actually
// be *presented*, which is where a compositor and vsync show up.
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';

import * as ntk from 'ntk';

import {
  clientCoverage,
  contention,
  cpuAlloc,
  cpuCoverage,
  cpuScalar,
  download,
  fence,
  requestRate,
  roundTrip,
  serverComposite,
  serverCopyArea,
  serverFill,
  serverGlyphs,
  serverMaskedComposite,
  serverTrapezoids,
  sharedMemory,
  upload,
  useApp,
} from './probes.js';
import { costModel, format } from './report.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')
    ? argv[i + 1]
    : d;
};

if (flag('help')) {
  console.log(
    `react-x11 system probe

  npm run examples:sysprobe [-- options]

  --window          map a window and show progress in it (adds a present-rate probe)
  --json <path>     write the raw measurements as JSON
  --label <text>    a note that travels with the results
  --quick           fewer trials, ~12s instead of ~30s
  --no-contention   skip the client/server concurrency probe
  --help            this`,
  );
  process.exit(0);
}

const QUICK = flag('quick');

const WINDOW = flag('window');
const SIZES = QUICK ? [32, 128, 512] : [32, 64, 128, 256, 512];

/** The GL renderer, when the machine has glxinfo. Not reachable through the X
 * connection, and the single most predictive fact about the server numbers
 * below — "llvmpipe", "virgl" and a real GPU give three different answers. */
function glRenderer() {
  try {
    const out = execFileSync('glxinfo', ['-B'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return (
      (
        out.match(/^\s*Device:\s*(.+)$/m)?.[1] ??
        out.match(/^OpenGL renderer string:\s*(.+)$/m)?.[1] ??
        ''
      ).trim() || null
    );
  } catch {
    return null;
  }
}

/** ntk's version, read off disk: its exports map allows `.` only. */
function ntkVersion() {
  try {
    const require = createRequire(import.meta.url);
    return JSON.parse(
      require('node:fs').readFileSync(
        require.resolve('ntk').replace(/lib[/\\]index\.js$/, 'package.json'),
        'utf8',
      ),
    ).version;
  } catch {
    return null;
  }
}

// --- the run ----------------------------------------------------------------

const app = await ntk.createClient();
useApp(app);

const SIDE = 800;
const surface = new ntk.Surface(app, {
  width: SIDE,
  height: SIDE,
  format: 'argb32',
});
const mask = new ntk.Surface(app, { width: SIDE, height: SIDE, format: 'a8' });
const ctx = surface.getContext('2d');

// The visible half, if asked for. Deliberately not where anything is measured
// (see the header): it shows progress, and it is what makes the present-rate
// probe possible at all.
let window = null;
let wctx = null;
if (WINDOW) {
  window = app.createWindow({
    width: 760,
    height: 420,
    title: 'react-x11 — system probe',
    backgroundColor: '#1e2126',
  });
  window.map?.();
  await new Promise((r) => setTimeout(r, 250));
  wctx = window.getContext('2d');
}

// Progress goes to stderr and the report to stdout, so that
// `npm run examples:sysprobe > machine.txt` captures the result and nothing
// else — the whole point of it running unattended.
const lines = [];
function say(text) {
  lines.push(text);
  if (text) console.error(text);
  if (!wctx) return;
  try {
    wctx.fillStyle = '#1e2126';
    wctx.fillRect(0, 0, window.width, window.height);
    wctx.fillStyle = '#dfe6e9';
    wctx.font = '13px sans-serif';
    const shown = lines.slice(-24);
    shown.forEach((l, i) => wctx.fillText(l.slice(0, 96), 12, 24 + i * 16));
  } catch {
    // a machine with no usable font still gets the stdout version, which is
    // the one that matters for an unattended run
  }
}

const step = async (label, fn) => {
  say(`  … ${label}`);
  const t0 = performance.now();
  const value = await fn();
  lines.pop();
  say(`  ✓ ${label}  ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  lines.splice(-2, 1); // drop the '…' line the window is still showing
  return value;
};

const r = {
  version: 1,
  env: {
    os: `${process.platform} ${process.arch}`,
    node: process.version,
    ntk: ntkVersion(),
    display: process.env.DISPLAY ?? null,
    vendor: app.display.vendor ?? null,
    release: app.display.release ?? null,
    localSocket: app.display.isLocalSocket ?? null,
    cpus: os.cpus()?.length ?? null,
    cpuModel: os.cpus()?.[0]?.model ?? null,
    load: os.loadavg?.()[0] ?? null,
    gl: glRenderer(),
    label: value('label'),
    drawable: WINDOW
      ? `${SIDE}x${SIDE} pixmap (+ mapped window)`
      : `${SIDE}x${SIDE} pixmap`,
    quick: QUICK,
  },
};

console.error(
  `react-x11 system probe — measuring, about ${QUICK ? 12 : 35}s\n`,
);

r.cpu = await step('client processor', async () => ({
  scalar: cpuScalar(),
  coverage: cpuCoverage(),
  alloc: cpuAlloc(),
}));

r.roundTrip = await step('round trip latency', () =>
  roundTrip(app, { samples: QUICK ? 80 : 200 }),
);
r.requestRate = await step('request rate', () => requestRate(app, surface));
r.upload = await step('upload bandwidth', () =>
  upload(app, { sizes: QUICK ? [64, 256, 1024] : [64, 128, 256, 512, 1024] }),
);
r.download = await step('download bandwidth', () =>
  download(app, surface, {
    sizes: QUICK ? [64, 192, 384] : [64, 128, 256, 512],
  }),
);
r.shm = await step('shared memory', () => sharedMemory(app));

r.fill = await step('server: solid fill', () =>
  serverFill(app, surface, SIZES),
);
r.composite = await step('server: composite', () =>
  serverComposite(app, surface, SIZES),
);
r.masked = await step('server: masked composite', () =>
  serverMaskedComposite(app, surface, mask, SIZES),
);
r.copyArea = await step('server: copy area', () =>
  serverCopyArea(app, surface, SIZES),
);
r.trapezoids = await step('server: trapezoids', () =>
  serverTrapezoids(app, ctx, QUICK ? [32, 128, 256] : [32, 64, 128, 256]),
);
r.coverage = await step('local rasterization, end to end', () =>
  clientCoverage(app, ctx, QUICK ? [32, 128, 256] : [32, 64, 128, 256]),
);
r.glyphs = await step('server: glyphs', () => serverGlyphs(app, ctx));

if (!flag('no-contention')) {
  r.contention = await step('client/server concurrency', () =>
    // sized against the trapezoid cost, which is the only server work
    // guaranteed to be substantial enough to overlap with anything
    contention(app, ctx, r.trapezoids?.byArea?.[1]?.ms ?? 1),
  );
}

if (WINDOW) {
  r.present = await step('window: present rate', async () => {
    let frames = 0;
    const latencies = [];
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        if (performance.now() - t0 > 2000) return resolve();
        wctx.fillStyle = frames % 2 ? '#2d3436' : '#353b41';
        wctx.fillRect(window.width - 40, window.height - 40, 24, 24);
        frames++;
        if (typeof window.frameLatency === 'number')
          latencies.push(window.frameLatency);
        window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    });
    const elapsed = (performance.now() - t0) / 1000;
    latencies.sort((a, b) => a - b);
    return {
      fps: frames / elapsed,
      fenceMedianMs: latencies[Math.floor(latencies.length / 2)] ?? null,
    };
  });
}

await fence(app);

// --- out --------------------------------------------------------------------

const text = format(r);
console.log(`\n${text}`);

if (wctx) {
  // The window has been showing progress; leave the verdict on it, and hold
  // it open only long enough to be readable — this has to stay unattended.
  const summary = text.split('\n');
  lines.length = 0;
  for (const l of summary.slice(-26)) lines.push(l);
  say('');
  await new Promise((r2) => setTimeout(r2, Number(value('hold', 4)) * 1000));
}

const jsonPath = value('json');
if (jsonPath) {
  const model = costModel(r);
  writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        ...r,
        model: model && {
          localFixedUs: model.Lf,
          localNsPerPixel: model.Lp * 1000,
          serverFixedUs: model.Sf,
          serverNsPerPixel: model.Sp * 1000,
          serverNsPerEdge: model.Se * 1000,
          policy: model.policy,
          screenMs: model.screen,
        },
      },
      // JSON has no Infinity, and Infinity is a real answer here — "no
      // crossover at any size" — so it goes out as a string rather than as
      // the null JSON.stringify would otherwise produce
      (_k, v) =>
        typeof v === 'number' && !Number.isFinite(v) ? 'Infinity' : v,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${jsonPath}`);
}

ctx.destroy();
surface.destroy();
mask.destroy();
process.exit(0);
