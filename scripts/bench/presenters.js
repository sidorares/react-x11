// Cocoa presenter benchmark: the measure-first gate of docs/macos.md, as a
// number. One scenario, two presenters, the same ticks — and every frame
// broken into the stages that can be the bottleneck:
//
//   flush     JS building the frame: painters into the surface, or the
//             layer sync (prop diffing + per-visual rasters). The one paint
//             channel, so this is "client cost per frame".
//   upload    surfaceToLayer calls — the CGImage handoff to Core Animation.
//             The surface presenter pays one per frame at WINDOW size
//             whatever the damage; the layers presenter pays one per
//             re-rastered visual at the visual's size. kpx tells that story.
//   props     setLayerProps calls per frame — the layers presenter's other
//             half. A pure scroll should be ~2; a recolour wall should be
//             ~N with zero uploads (PropBox); a number that scales with the
//             tree on a one-box change is a diffing bug.
//   input     for the input scenarios: postMouseEvent → the end of the
//             flush that answered it, through the real NSApp queue and the
//             pump — the "answer the input" number, p50/p95.
//
//   npm run bench:presenters                    # every scenario, both
//   npm run bench:presenters -- --scenario=cards --seconds=8
//   npm run bench:presenters -- --x11           # third column via $DISPLAY
//   npm run bench:presenters -- --shots         # snapshot each run's last
//                                               # frame for an eyeball diff
//
// Scenario design: each isolates one shape of change, because the two
// presenters differ per shape, not overall — a wall recolour is layer
// properties on one side and full-window paint on the other, while a text
// change rasters on both and measures pure raster throughput.
//
// Comparisons hold within a run (same machine, same session); absolute
// numbers travel about as well as any timing does — that is, they don't.
import { spawnSync } from 'node:child_process';
import React from 'react';

const e = React.createElement;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SECONDS = Number(flag('seconds', 6));
const ONLY = flag('scenario', null);
const WITH_X11 = args.includes('--x11');
const SHOTS = args.includes('--shots');
const CHILD = args.includes('--child');

const W = 900;
const H = 700;
const TICK_MS = 16;

// ---------------------------------------------------------------------------
// Scenarios. Each is { tree(tick), drive? } — `tree` is rendered per tick
// (the React-state shape of change), `drive` instead pushes real events and
// leaves the tree alone (the input shape). `latency: true` marks the ones
// whose headline number is input→flush rather than fps.
// ---------------------------------------------------------------------------

const TINTS = ['#ffffff', '#eef4fb', '#fdf1e7', '#eefaf1'];

function windowOf(children, title) {
  return e(
    'window',
    { width: W, height: H, title, style: { backgroundColor: '#e9edf2' } },
    ...children,
  );
}

const SCENARIOS = {
  /** Paint-only bounded change: one 100px box recolours. The layers
   *  presenter should answer with one backgroundColor prop and zero
   *  rasters; the surface presenter with a bounded repaint plus a
   *  window-sized upload — the upload column is the point. */
  color: {
    tree: (tick) =>
      windowOf(
        [
          e('box', {
            style: {
              position: 'absolute',
              left: 340,
              top: 120,
              width: 100,
              height: 100,
              borderRadius: 8,
              backgroundColor: tick % 2 ? '#3498db' : '#e74c3c',
            },
          }),
          e(
            'text',
            { style: { margin: 16, color: '#7f8c8d' } },
            'static text to give the frame some weight',
          ),
        ],
        'bench color',
      ),
  },

  /** Position-only change: the same box slides. A layout pass claims
   *  broadly, so this measures how each presenter survives over-claimed
   *  damage — frames.js measured the same cliff on X11. */
  move: {
    tree: (tick) =>
      windowOf(
        [
          e('box', {
            style: {
              position: 'absolute',
              left: Math.round(340 + 300 * Math.sin(tick / 20)),
              top: 120,
              width: 100,
              height: 100,
              borderRadius: 8,
              backgroundColor: '#3498db',
            },
          }),
          e(
            'text',
            { style: { margin: 16, color: '#7f8c8d' } },
            'static text to give the frame some weight',
          ),
        ],
        'bench move',
      ),
  },

  /** Text relayout + raster: the label changes every tick. Both presenters
   *  must raster glyphs; the layers presenter rasters one text visual, the
   *  surface presenter repaints the claim. Raster throughput, mostly. */
  text: {
    tree: (tick) =>
      windowOf(
        [
          e(
            'box',
            { style: { flexGrow: 1, padding: 16, gap: 12 } },
            e(
              'text',
              { style: { fontSize: 20, color: '#222222' } },
              `tick ${tick}`,
            ),
            e(
              'text',
              { style: { color: '#7f8c8d' } },
              'static text below to give the frame some weight',
            ),
          ),
        ],
        'bench text',
      ),
  },

  /** The wall from issue #219: 48 rounded bordered cards, all recoloured
   *  every frame. Chrome churn — the layers presenter's best case (N
   *  property sets, no rasters) against the surface presenter's near-full
   *  repaint. */
  cards: {
    tree: (tick) => {
      const CARD_W = 130;
      const CARD_H = 70;
      const GAP = 12;
      const PAD = 16;
      const perRow = Math.max(
        1,
        Math.floor((W - 2 * PAD + GAP) / (CARD_W + GAP)),
      );
      const cards = [];
      for (let i = 0; i < 48; i += 1) {
        cards.push(
          e('box', {
            key: i,
            style: {
              position: 'absolute',
              left: PAD + (i % perRow) * (CARD_W + GAP),
              top: PAD + Math.floor(i / perRow) * (CARD_H + GAP),
              width: CARD_W,
              height: CARD_H,
              backgroundColor: TINTS[(i + tick) % TINTS.length],
              borderRadius: 8,
              borderWidth: 1,
              borderColor: '#c3ccd8',
            },
          }),
        );
      }
      return windowOf(
        [e('box', { style: { flexGrow: 1 } }, ...cards)],
        'bench cards',
      );
    },
  },

  /** 24 SVG icons re-tinted every tick — the icon hot path. In layers mode
   *  each icon is retained CAShapeLayers, so a tint change is setShapeProps
   *  on the render server's own primitives: zero rasters, zero uploads. The
   *  surface presenter re-rasters the claim and re-uploads the window. */
  svg: {
    tree: (tick) => {
      const TINT = ['#e8590c', '#1c7ed6', '#2f9e44', '#9c36b5'];
      const icons = [];
      for (let i = 0; i < 24; i += 1) {
        const color = TINT[(i + tick) % TINT.length];
        icons.push(
          e(
            'svg',
            {
              key: i,
              viewBox: '0 0 24 24',
              style: { width: 72, height: 72 },
            },
            e('circle', {
              cx: 12,
              cy: 12,
              r: 9,
              fill: 'none',
              stroke: color,
              strokeWidth: 2.5,
            }),
            e('path', {
              d: 'M12 7 v5 l4 3',
              stroke: color,
              strokeWidth: 2.5,
              fill: 'none',
              strokeLinecap: 'round',
            }),
          ),
        );
      }
      return windowOf(
        [
          e(
            'box',
            {
              style: {
                flexGrow: 1,
                padding: 20,
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 16,
                alignContent: 'flex-start',
              },
            },
            ...icons,
          ),
        ],
        'bench svg',
      );
    },
  },

  /** A wheel notch per tick over 300 rows. The layers presenter's native
   *  scroll should answer with ~2 property sets and no uploads; the
   *  surface presenter blits and re-uploads the window. Also an input
   *  scenario: the notch goes through the window's event path. */
  scroll: {
    latency: true,
    tree: () =>
      windowOf(
        [
          e(
            'box',
            { style: { flexGrow: 1, overflow: 'scroll' } },
            ...Array.from({ length: 300 }, (_, i) =>
              e(
                'box',
                {
                  key: i,
                  style: {
                    height: 28,
                    paddingLeft: 16,
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: i % 2 ? '#f6f8fb' : '#ffffff',
                  },
                },
                e(
                  'text',
                  { style: { color: '#444444' } },
                  `row ${i} — some list content`,
                ),
              ),
            ),
          ),
        ],
        'bench scroll',
      ),
    drive(ctx) {
      const { wnd, node, stamp } = ctx;
      const scroller = ctx.find((n) => n.isScroller?.());
      if (!scroller) return;
      const x = scroller.abs.x + scroller.abs.width / 2;
      const y = scroller.abs.y + scroller.abs.height / 2;
      const down = ctx.tick % 120 < 60; // sweep down, then back up
      stamp();
      wnd.emit('wheel', {
        name: 'wheel',
        x,
        y,
        rootx: 0,
        rooty: 0,
        buttons: 0,
        deltaX: 0,
        deltaY: down ? 3 : -3,
        deltaMode: 'line',
        smooth: false,
        source: 'button',
      });
      void node;
    },
  },

  /** Pointer wiggle over a hover-styled grid, through the REAL NSApp event
   *  queue (postMouseEvent): input→flush is the headline. The hover flip
   *  is one node's style state — the smallest interactive change there is,
   *  so this is the floor of perceived latency. */
  hover: {
    latency: true,
    input: 'native',
    tree: () =>
      windowOf(
        [
          e(
            'box',
            {
              style: {
                flexGrow: 1,
                padding: 24,
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 16,
                alignContent: 'flex-start',
              },
            },
            ...Array.from({ length: 24 }, (_, i) =>
              e('box', {
                key: i,
                style: {
                  width: 120,
                  height: 56,
                  borderRadius: 8,
                  backgroundColor: '#ffffff',
                  borderWidth: 1,
                  borderColor: '#c3ccd8',
                  ':hover': { backgroundColor: '#dbe7f4' },
                },
              }),
            ),
          ),
        ],
        'bench hover',
      ),
    drive(ctx) {
      // alternate between two card centres, in points
      const cards = ctx.findAll((n) => n.style?.[':hover'] !== undefined);
      const a = cards[0];
      const b = cards[7] ?? cards[cards.length - 1];
      const target = ctx.tick % 2 ? a : b;
      if (!target) return;
      const s = ctx.wnd.scale;
      ctx.stamp();
      ctx.native.postMouseEvent(
        ctx.wnd._h,
        'move',
        (target.abs.x + target.abs.width / 2) / s,
        (target.abs.y + target.abs.height / 2) / s,
      );
    },
  },
};

// ---------------------------------------------------------------------------
// Child: run one (scenario, presenter/backend) and print a JSON line.
// ---------------------------------------------------------------------------

async function runChild() {
  const name = flag('run', 'color');
  const scenario = SCENARIOS[name];
  process.env.REACT_X11_NO_AUTORUN = '1';
  const { createRoot } = await import('../../src/index.js');
  const root = await createRoot();
  const app = root.app;
  const cocoa = Boolean(app._native);

  // --- instrumentation: wrap the native bridge, count per current frame
  const stats = {
    flushes: 0,
    flushMs: [],
    uploads: 0,
    uploadMs: 0,
    uploadPx: 0,
    props: 0,
    layersMade: 0,
    latency: [],
  };
  let inFlight = []; // input stamps waiting for the flush that answers them
  if (cocoa) {
    const native = app._native;
    const surfaceToLayer = native.surfaceToLayer.bind(native);
    const sizeOf = native.surfaceSize.bind(native);
    native.surfaceToLayer = (surface, layer) => {
      const t0 = performance.now();
      surfaceToLayer(surface, layer);
      stats.uploadMs += performance.now() - t0;
      stats.uploads += 1;
      const size = sizeOf(surface);
      stats.uploadPx += size.width * size.height;
    };
    const setLayerProps = native.setLayerProps.bind(native);
    native.setLayerProps = (layer, props) => {
      stats.props += 1;
      return setLayerProps(layer, props);
    };
    const createLayer = native.createLayer.bind(native);
    native.createLayer = (...a) => {
      stats.layersMade += 1;
      return createLayer(...a);
    };
  }

  let tick = 0;
  root.render(scenario.tree(0));
  await new Promise((r) => setTimeout(r, 700));

  const node = app._rootChildren?.[0] ?? null;
  const wnd = cocoa ? [...app._windows.values()][0] : null;
  if (node) {
    const flush = node.flush.bind(node);
    node.flush = (...a) => {
      const t0 = performance.now();
      const out = flush(...a);
      const t1 = performance.now();
      stats.flushes += 1;
      stats.flushMs.push(t1 - t0);
      for (const sent of inFlight) stats.latency.push(t1 - sent);
      inFlight = [];
      return out;
    };
  }

  function* walk(n) {
    yield n;
    for (const c of n?.children ?? []) yield* walk(c);
  }
  const ctx = {
    get tick() {
      return tick;
    },
    wnd,
    node,
    native: app._native,
    stamp: () => inFlight.push(performance.now()),
    find: (pred) => [...walk(node)].find(pred) ?? null,
    findAll: (pred) => [...walk(node)].filter(pred),
  };

  // settle counters after mount: steady state is the measurement
  stats.flushes = 0;
  stats.flushMs = [];
  stats.uploads = 0;
  stats.uploadMs = 0;
  stats.uploadPx = 0;
  stats.props = 0;
  stats.layersMade = 0;

  const t0 = performance.now();
  const timer = setInterval(() => {
    tick += 1;
    if (scenario.drive) scenario.drive(ctx);
    else root.render(scenario.tree(tick));
  }, TICK_MS);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  clearInterval(timer);
  await new Promise((r) => setTimeout(r, 120));
  const elapsed = (performance.now() - t0) / 1000;

  if (SHOTS && wnd) {
    wnd.snapshot(
      `/tmp/bench-${name}-${process.env.REACT_X11_COCOA_PRESENTER ?? 'surface'}.png`,
    );
  }

  const sorted = [...stats.flushMs].sort((a, b) => a - b);
  const lat = [...stats.latency].sort((a, b) => a - b);
  const q = (a, p) =>
    a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null;
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const out = {
    frames: stats.flushes,
    fps: stats.flushes / elapsed,
    ticks: tick,
    flushAvg: sorted.length ? sum(sorted) / sorted.length : null,
    flushP95: q(sorted, 0.95),
    flushMax: sorted.at(-1) ?? null,
    clientMsPerSec: (sum(sorted) + stats.uploadMs) / elapsed,
    uploadsPerFrame: stats.flushes ? stats.uploads / stats.flushes : 0,
    uploadKpxPerFrame: stats.flushes
      ? stats.uploadPx / stats.flushes / 1000
      : 0,
    uploadMsPerFrame: stats.flushes ? stats.uploadMs / stats.flushes : 0,
    propsPerFrame: stats.flushes ? stats.props / stats.flushes : 0,
    layersMade: stats.layersMade,
    latP50: q(lat, 0.5),
    latP95: q(lat, 0.95),
    latMax: lat.at(-1) ?? null,
    latN: lat.length,
  };
  console.log(`RESULT ${JSON.stringify(out)}`);
  await root.unmount();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent: the matrix, one child process per cell so the presenters never
// share a session — and a crash in one cell is one dash, not a lost run.
// ---------------------------------------------------------------------------

function runCell(name, env) {
  const res = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      new URL(import.meta.url).pathname,
      '--child',
      `--run=${name}`,
      `--seconds=${SECONDS}`,
      ...(SHOTS ? ['--shots'] : []),
    ],
    {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: (SECONDS + 25) * 1000,
    },
  );
  const line = (res.stdout ?? '')
    .split('\n')
    .find((l) => l.startsWith('RESULT '));
  if (!line) {
    const tail = (res.stderr ?? '').split('\n').filter(Boolean).slice(-3);
    return { error: tail.join(' | ') || 'no result' };
  }
  return JSON.parse(line.slice(7));
}

const ms = (v) => (v == null ? '    -' : v.toFixed(2).padStart(5));
const n1 = (v) => (v == null ? '    -' : v.toFixed(1).padStart(5));

if (CHILD) {
  await runChild();
} else {
  const names = ONLY ? [ONLY] : Object.keys(SCENARIOS);
  const columns = [
    ['surface', { REACT_X11_COCOA_PRESENTER: 'surface' }],
    ['layers', { REACT_X11_COCOA_PRESENTER: 'layers' }],
    ...(WITH_X11 ? [['x11', { REACT_X11_BACKEND: 'x11' }]] : []),
  ];
  console.log(
    `presenter bench — ${W}x${H} window, ${SECONDS}s per cell, tick ${TICK_MS}ms`,
  );
  for (const name of names) {
    if (!SCENARIOS[name]) {
      console.error(
        `unknown scenario ${name} — ${Object.keys(SCENARIOS).join(', ')}`,
      );
      process.exit(1);
    }
    console.log(`\n${name}`);
    console.log(
      '            fps   flush avg/p95/max      upload/frame        props  input p50/p95/max',
    );
    for (const [label, env] of columns) {
      const r = runCell(name, env);
      if (r.error) {
        console.log(`  ${label.padEnd(9)} FAILED: ${r.error}`);
        continue;
      }
      const upload =
        r.uploadsPerFrame > 0
          ? `${r.uploadsPerFrame.toFixed(1)}x ${Math.round(r.uploadKpxPerFrame).toString().padStart(4)}kpx ${ms(r.uploadMsPerFrame)}ms`
          : '        none      ';
      const input =
        r.latN > 0
          ? `${ms(r.latP50)}/${ms(r.latP95)}/${ms(r.latMax)}`
          : '        -';
      console.log(
        `  ${label.padEnd(9)}${n1(r.fps)}  ${ms(r.flushAvg)}/${ms(r.flushP95)}/${ms(r.flushMax)}ms  ${upload}  ${r.propsPerFrame.toFixed(1).padStart(5)}  ${input}`,
      );
    }
  }
  console.log(
    '\nnotes: upload = surfaceToLayer (CGImage handoff), at window size on the' +
      '\nsurface presenter and per re-rastered visual on layers; props =' +
      '\nsetLayerProps per frame; input = event sent → end of the flush that' +
      '\nanswered it, through the pump. Compare within this run only.',
  );
}
