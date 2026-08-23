// Protocol-traffic benchmark: how much X11 work does each scenario cost?
//
//   npm run bench                        # print the current numbers
//   npm run bench -- --save              # rewrite the committed baseline
//   npm run bench -- --check             # fail if a metric regressed
//   npm run bench -- --hotspots          # per-scenario efficiency detail:
//                                        #   the request-name histogram, and
//                                        #   which requests stalled, repeated
//                                        #   or churned
//   npm run bench -- --record-dir <dir>  # one .x11cap per scenario, openable
//                                        #   and diffable with x11vis
//
// Runs against node-x11's in-process pure-JS X server, so the numbers are
// stable and need no $DISPLAY. Stable, not perfectly deterministic: the
// client runs on a live event loop, so wall-clock timers (ntk's frame
// pacing, the 5ms output-buffer age limit) and GC (ntk frees X resources
// from FinalizationRegistry callbacks) move a few requests between runs,
// and `stalls` depends on whether a reply happened to land before the next
// request went out. The --check tolerances below are sized to that noise —
// they exist to catch step changes (a new per-frame resource cycle, a new
// serialized round trip), not single-request jitter.
//
// Metrics, and why each is here:
//
//   requests / bytesOut  round trips and wire cost of talking to the server
//   replies              requests that forced the client to wait
//   composites / pixels  Render Composite calls and the area they touch —
//                        request counts hide this completely (a Composite
//                        request is 36 bytes whether it touches ten pixels
//                        or the whole surface), and it is where "correct
//                        but does far too much pixel work" shows up
//   stalls               blocking round trips: replies that arrived while
//                        their request was the last thing sent, so nothing
//                        was pipelined behind it. The bench's own settle()
//                        fences are a fixed floor per scenario; growth means
//                        a new serialized wait crept into the path
//   dupQueries           repeated identical queries — a reply-carrying
//                        request whose exact bytes were already sent on the
//                        connection (a cacheable InternAtom, GetProperty,
//                        QueryExtension...)
//   churn                short-lived server resources: created and freed
//                        inside the measured window (the "full-window mask
//                        pixmap rebuilt every frame" class). Steady-state
//                        interactions should reuse, i.e. stay near 0
//
// The in-process server answers in microseconds, so `stalls` counts the
// round trips but cannot price them — a fence that costs nothing here costs
// a full RTT on a real display. Grading latency work needs the real-display
// lane (x11vis --record / --diff); this lane keeps the counts honest.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import {
  analysisMark,
  captureLines,
  compositePixels,
  countStream,
  windowAnalysis,
} from './xcount.js';

process.env.REACT_X11_NO_AUTORUN = '1';
const { createRoot } = await import('../../src/index.js');
const { registerElement } = await import('../../src/host.js');
const { Node } = await import('../../src/node.js');
const { Checkbox } = await import('../../src/components/index.js');

const args = process.argv.slice(2);
const recordDir = args.includes('--record-dir')
  ? args[args.indexOf('--record-dir') + 1]
  : null;
if (
  args.includes('--record-dir') &&
  (!recordDir || recordDir.startsWith('--'))
) {
  console.error('--record-dir needs a directory argument');
  process.exit(1);
}
if (recordDir) mkdirSync(recordDir, { recursive: true });

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);
const baselinePath = join(
  dirname(new URL(import.meta.url).pathname),
  'baseline.json',
);

const W = 400;
const H = 400;

async function connect() {
  const server = xserver.createServer({ width: W, height: H });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const { stats } = countStream(clientEnd, { record: Boolean(recordDir) });
  const source = new StaticFontSource();
  source.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Bench',
  });
  source.alias('sans-serif', 'Bench');
  const app = await createClient({ stream: clientEnd, fontSource: source });
  return { app, stats, server };
}

const settle = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

/**
 * Settle until the connection actually goes quiet.
 *
 * One fence proves the server consumed what has been sent, not that the
 * client has stopped sending: `prepare` can leave asynchronous chains in
 * flight that only issue their next request once a reply lands. ntk's
 * shared-glyph directory is the case that forced this — a property-mailbox
 * RPC per newly-seen glyph batch, several round trips deep, kicked off by
 * the mount's first paint. Draining one fence deep left the tail of that
 * warm-up inside the measured window, which priced a bounded one-time cost
 * as part of every interaction (a window drag read 85 requests instead of
 * 43, none of them caused by the drag).
 *
 * Quiet means a fence that provoked nothing but itself — and it has to hold
 * for several fences running, because such a chain goes quiet between its
 * steps: one idle turn is where it is waiting for the reply that starts the
 * next request, not where it has finished.
 */
async function drain(app, stats) {
  let quiet = 0;
  for (let i = 0; i < 60 && quiet < 4; i++) {
    const before = stats.requests;
    await settle(app);
    await new Promise((resolve) => setImmediate(resolve));
    quiet = stats.requests - before <= 1 ? quiet + 1 : 0;
  }
}

/** Run `fn`, measuring only what it causes (setup is drained first). A
 * scenario may be `{ prepare, run }`: `prepare` builds state — a mounted
 * tree, say — whose cost is drained and *not* measured, so `run` can time
 * an interaction rather than a mount. */
async function measure(name, fn) {
  const { app, stats, server } = await connect();
  const x11Root = await createRoot({ app });
  await settle(app);
  if (typeof fn !== 'function') {
    await fn.prepare(app, x11Root, server);
    await drain(app, stats);
    fn = fn.run;
  }
  const mark = {
    requests: stats.requests,
    bytesOut: stats.bytesOut,
    bytesIn: stats.bytesIn,
    replies: stats.replies,
    composites: stats.composites.length,
    analysis: analysisMark(stats),
  };
  // A scenario that throws used to be reported as a very fast scenario:
  // React swallows the render error, the renderer logs it, and what lands
  // in the table is the cost of drawing nothing. Saved as a baseline, that
  // then reads as "no regressions" forever. Fail the run instead.
  let failure = null;
  const onUncaught = (err) => {
    failure ??= err;
  };
  process.on('uncaughtException', onUncaught);
  try {
    await fn(app, x11Root, server);
  } catch (err) {
    failure ??= err;
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  if (failure) {
    console.error(`\nscenario "${name}" failed — it is measuring nothing:`);
    console.error(failure);
    process.exit(1);
  }
  await settle(app);

  const after = compositePixels(stats, app.display.Render.majorOpcode);
  const beforePx = compositePixels(
    { composites: stats.composites.slice(0, mark.composites) },
    app.display.Render.majorOpcode,
  );
  const analysis = windowAnalysis(stats, mark.analysis);
  const result = {
    requests: stats.requests - mark.requests,
    bytesOut: stats.bytesOut - mark.bytesOut,
    bytesIn: stats.bytesIn - mark.bytesIn,
    replies: stats.replies - mark.replies,
    composites: after.composites - beforePx.composites,
    compositePixels: after.pixels - beforePx.pixels,
    stalls: analysis.stalls,
    dupQueries: analysis.dupQueries,
    churn: analysis.churn,
  };
  hotspots[name] = analysis;
  if (recordDir) {
    const file = join(recordDir, `${name.replace(/[^a-z0-9]+/gi, '-')}.x11cap`);
    writeFileSync(file, captureLines(stats, `bench: ${name}`));
  }
  await app.close();
  return [name, result];
}

/** Per-scenario efficiency detail, filled by measure(), shown by --hotspots. */
const hotspots = {};

// --- scenarios ---------------------------------------------------------

function pixmapCtx(app) {
  const pixmap = app.createPixmap({ width: W, height: H, depth: 24 });
  const ctx = pixmap.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  return ctx;
}

const PARAGRAPH = Array.from(
  { length: 12 },
  (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog`,
).join('\n');

function paragraphLayout(app) {
  return app.fonts.layout(
    [{ text: PARAGRAPH, family: 'sans-serif', size: 13, color: 'black' }],
    { family: 'sans-serif', size: 13 },
    { maxWidth: 380 },
  );
}

// Four of the icon-wall drawings from `examples/icons.jsx`, with the same
// mix of primitives (arcs, circles, lines, polylines, rects) so no single
// route through the path code dominates. The paint attributes sit on an
// inner <g> because SvgView starts inheritance from its own defaults and
// ignores presentation attributes on the root <svg> — `fill="none"` there
// would be dropped and every stroke icon would paint as a solid blob.
const ICON_PAINT =
  'fill="none" stroke="#2d3436" stroke-width="1.7" ' +
  'stroke-linecap="round" stroke-linejoin="round"';

const ICON_BODIES = [
  // gauge
  '<path d="M4.2 16.5a8.5 8.5 0 1 1 15.6 0"/><line x1="12" y1="15.5" x2="16.6" y2="10.4"/>' +
    '<circle cx="12" cy="15.7" r="1.5"/><line x1="4.6" y1="12.6" x2="6.3" y2="13"/>' +
    '<line x1="12" y1="7.6" x2="12" y2="9.3"/><line x1="3.5" y1="19.5" x2="20.5" y2="19.5"/>',
  // compass
  '<circle cx="12" cy="12" r="9"/><path d="M15.8 8.2 13.2 14 7.4 16.6 10 10.8z"/>' +
    '<circle cx="12" cy="12" r="0.9"/><line x1="12" y1="1.6" x2="12" y2="3.4"/>' +
    '<line x1="1.6" y1="12" x2="3.4" y2="12"/>',
  // cpu
  '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/>' +
    '<line x1="9.5" y1="2" x2="9.5" y2="5"/><line x1="14.5" y1="2" x2="14.5" y2="5"/>' +
    '<line x1="2" y1="9.5" x2="5" y2="9.5"/><line x1="19" y1="14.5" x2="22" y2="14.5"/>',
  // chart
  '<polyline points="3.6 3.6 3.6 20.4 20.4 20.4"/><rect x="6.4" y="13.6" width="2.6" height="6.8"/>' +
    '<rect x="11" y="10" width="2.6" height="10.4"/><polyline points="5.6 11.4 9.4 7.2 13.6 9.6 19 4.6"/>' +
    '<circle cx="9.4" cy="7.2" r="0.9"/><circle cx="19" cy="4.6" r="0.9"/>',
];

const ICON_SOURCES = ICON_BODIES.map(
  (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<g ${ICON_PAINT}>${body}</g></svg>`,
);

/** A wrapping wall of `count` <svg> cells, four distinct drawings between
 * them — the shape `examples/icons.jsx` puts on screen, minus its controls. */
function iconWall(count, size = 20) {
  return React.createElement(
    'window',
    { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
    React.createElement(
      'box',
      {
        style: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignContent: 'flex-start',
          padding: 6,
        },
      },
      Array.from({ length: count }, (_, i) =>
        React.createElement(
          'box',
          {
            key: i,
            style: {
              width: size + 4,
              height: size + 4,
              alignItems: 'center',
              justifyContent: 'center',
            },
          },
          React.createElement('svg', {
            source: ICON_SOURCES[i % ICON_SOURCES.length],
            style: { width: size, height: size },
          }),
        ),
      ),
    ),
  );
}

/** The hover scenario's tree: one row shaped like examples/form.jsx's
 * checkbox row — label, an 18x18 rounded bordered box whose `:hover` block
 * changes its colours, label. The flip damages exactly the box. */
function hoverRowWindow() {
  return React.createElement(
    'window',
    { width: W, height: H, style: { backgroundColor: '#dfe4ea' } },
    React.createElement(
      'box',
      {
        style: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          padding: 16,
        },
      },
      React.createElement('text', { style: { fontSize: 13 } }, 'size'),
      React.createElement('box', {
        style: {
          width: 18,
          height: 18,
          borderRadius: 4,
          borderWidth: 1,
          borderColor: '#7f8c8d',
          backgroundColor: '#ffffff',
          ':hover': { backgroundColor: '#eaf2fb', borderColor: '#2980b9' },
        },
      }),
      React.createElement('text', { style: { fontSize: 13 } }, 'Shout it'),
    ),
  );
}

/** The mount scenario's tree: `count` striped rows with a label each. */
function rowsWindow(count) {
  return React.createElement(
    'window',
    { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
    React.createElement(
      'box',
      { style: { flexGrow: 1, padding: 8, gap: 2 } },
      Array.from({ length: count }, (_, i) =>
        React.createElement(
          'box',
          {
            key: i,
            style: {
              flexDirection: 'row',
              gap: 6,
              padding: 2,
              backgroundColor: i % 2 ? '#ffffff' : '#eef1f5',
            },
          },
          React.createElement('text', { style: { fontSize: 11 } }, `row ${i}`),
        ),
      ),
    ),
  );
}

/** One absolutely-positioned box on a plain background — the smallest tree
 * where "what changed" and "what repainted" can drift apart. */
function absBoxWindow(left, color) {
  return React.createElement(
    'window',
    { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
    React.createElement('box', {
      style: {
        position: 'absolute',
        left,
        top: 40,
        width: 60,
        height: 40,
        backgroundColor: color,
      },
    }),
  );
}

// --- a scene drawn into one node (issue #301) ---------------------------
//
// The shape `@react-x11/components`' <Flow> has: one registered element
// draws a whole graph, so to the damage machinery the scene is a single
// retained node. A "drag step" is a controlled app committing a new array
// and the element invalidating the box that actually moved — which only
// stays scoped because of the two seams. `selfDamagedProps` keeps the
// commit from claiming the pane over the top of it, and `paintDamage()` is
// what the paint culls the other 299 cells against.

const SCENE_COLS = 20;
const SCENE_ROWS = 15;
const SCENE_CELLS = SCENE_COLS * SCENE_ROWS;

const sceneCells = (moved = -1) =>
  Array.from({ length: SCENE_CELLS }, (_, i) =>
    i === moved ? '#e74c3c' : i % 3 ? '#dfe6e9' : '#b2bec3',
  );

class SceneNode extends Node {
  cellRect(i) {
    const box = this.contentBox();
    const w = box.width / SCENE_COLS;
    const h = box.height / SCENE_ROWS;
    return {
      x: box.x + (i % SCENE_COLS) * w,
      y: box.y + Math.floor(i / SCENE_COLS) * h,
      width: w,
      height: h,
    };
  }

  paintContent(ctx) {
    // null on an unbounded pass, which is the "draw everything" answer
    const damage = this.paintDamage();
    const cells = this.props.cells ?? [];
    for (let i = 0; i < cells.length; i++) {
      const r = this.cellRect(i);
      if (
        damage &&
        !(
          r.x < damage.x + damage.width &&
          damage.x < r.x + r.width &&
          r.y < damage.y + damage.height &&
          damage.y < r.y + r.height
        )
      ) {
        continue;
      }
      ctx.fillStyle = cells[i];
      ctx.beginPath();
      ctx.roundRect(r.x + 1, r.y + 1, r.width - 2, r.height - 2, 3);
      ctx.fill();
      ctx.strokeStyle = '#2d343680';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  applyProps(next, prev) {
    const before = prev ?? this.props;
    // claims nothing for `cells`, because the element claims it below
    super.applyProps(next, prev);
    if (next.cells === before.cells) return;
    let box = null;
    for (let i = 0; i < next.cells.length; i++) {
      if (next.cells[i] === before.cells?.[i]) continue;
      const r = this.cellRect(i);
      box = box
        ? {
            x: Math.min(box.x, r.x),
            y: Math.min(box.y, r.y),
            width:
              Math.max(box.x + box.width, r.x + r.width) - Math.min(box.x, r.x),
            height:
              Math.max(box.y + box.height, r.y + r.height) -
              Math.min(box.y, r.y),
          }
        : r;
    }
    if (box) this.invalidate(false, box, 'props');
  }
}

registerElement('scene', {
  create: (props, app) => new SceneNode('scene', props, app),
  semanticNames: ['cells'],
  selfDamagedProps: ['cells'],
});

// --- and panning it (issue #303) ----------------------------------------
//
// The other half of the same pane's cost. A drag step moves one cell and
// claims the box it moved through; a *pan* translates every pixel, so the
// scoped claim the seams above buy is the whole pane by construction — and
// the frame is one CopyArea away from being right. `scrollContents` is that
// call: the surviving band shifts inside the backing store and the claim
// narrows to the strips the shift exposed, which `paintDamage()` then hands
// the paint.
//
// The grid here is a *world* grid, one period wider than the pane on every
// side, so a pan always has cells to bring in — a scene whose content
// stopped at the viewport edge would flatter the exposed strip.

class PanSceneNode extends SceneNode {
  constructor(kind, props, app) {
    super(kind, props, app);
    this.panX = 0;
    this.panY = 0;
  }

  cellRect(i) {
    const box = this.contentBox();
    const w = box.width / SCENE_COLS;
    const h = box.height / SCENE_ROWS;
    return {
      x: box.x + ((i % PAN_COLS) - 1) * w + this.panX,
      y: box.y + (Math.floor(i / PAN_COLS) - 1) * h + this.panY,
      width: w,
      height: h,
    };
  }

  pan(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.scrollContents(this.contentBox(), dx, dy);
  }

  /**
   * The same pan with a HUD along the bottom of the pane (issue #309): a
   * minimap and zoom controls, which have to repaint on a pan frame and
   * whose pixels must not ride the blit. The element carves their strip out
   * of the region it shifts and claims it as ordinary damage, so the two
   * claims sit edge to edge.
   */
  panBeside(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    const box = this.contentBox();
    const hud = {
      x: box.x,
      y: box.y + box.height - HUD_HEIGHT,
      width: box.width,
      height: HUD_HEIGHT,
    };
    this.scrollContents({ ...box, height: box.height - HUD_HEIGHT }, dx, dy);
    this.invalidate(false, hud, 'props');
  }
}

const HUD_HEIGHT = 60;

const PAN_COLS = SCENE_COLS + 2;
const PAN_ROWS = SCENE_ROWS + 2;
const panCells = () =>
  Array.from({ length: PAN_COLS * PAN_ROWS }, (_, i) =>
    i % 3 ? '#dfe6e9' : '#b2bec3',
  );

registerElement('panscene', {
  create: (props, app) => new PanSceneNode('panscene', props, app),
  semanticNames: ['cells'],
  selfDamagedProps: ['cells'],
});

const panSceneWindow = () =>
  React.createElement(
    'window',
    { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
    React.createElement('panscene', {
      cells: panCells(),
      style: { flexGrow: 1, margin: 8 },
    }),
  );

const sceneWindow = (cells) =>
  React.createElement(
    'window',
    { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
    React.createElement('scene', { cells, style: { flexGrow: 1, margin: 8 } }),
  );

/** Mount a tree, settle it, and hand back the root node plus a frame pump.
 * The mount is what `prepare` pays for, so `run` measures only repaints. */
async function mounted(x11Root, element) {
  const instance = await new Promise((resolve) =>
    x11Root.render(element, resolve),
  );
  const root = instance._reactX11Node;
  const frame = () => {
    root._scheduled = false;
    root.flush();
  };
  frame();
  return { root, frame };
}

const SCENARIOS = [
  [
    'text: paragraph, no clip',
    async (app, x11Root) => {
      const ctx = pixmapCtx(app);
      paragraphLayout(app).draw(ctx, 5, 5);
    },
  ],
  [
    'text: paragraph, inside a rect clip',
    async (app, x11Root) => {
      const ctx = pixmapCtx(app);
      const layout = paragraphLayout(app);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, 380, 200);
      ctx.clip();
      layout.draw(ctx, 5, 5);
      ctx.restore();
    },
  ],
  [
    // Nested clips, which every real frame has and no scenario above had: the
    // window clips to the damaged region, a scrolling <box> clips to its
    // viewport, and each cell clips its own content. Intersecting clips used
    // to allocate a full-surface a8 pixmap, rasterize into it and Composite
    // the whole surface *per clip*, so this scenario is where that shows up.
    'clips: 40 nested rect clips with text',
    async (app, x11Root) => {
      const ctx = pixmapCtx(app);
      const layout = paragraphLayout(app);
      ctx.save();
      ctx.beginPath();
      ctx.rect(2, 2, 396, 396);
      ctx.clip(); // the "damage" clip
      for (let i = 0; i < 40; i++) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(4, 4 + i * 9, 380, 8);
        ctx.clip(); // a row, inside the damage clip
        layout.draw(ctx, 5, 4 + i * 9);
        ctx.restore();
      }
      ctx.restore();
    },
  ],
  [
    'shapes: 50 filled rounded boxes',
    async (app, x11Root) => {
      const ctx = pixmapCtx(app);
      for (let i = 0; i < 50; i++) {
        ctx.fillStyle = i % 2 ? '#2980b9' : '#dfe6e9';
        ctx.beginPath();
        ctx.roundRect(
          4 + (i % 10) * 38,
          4 + Math.floor(i / 10) * 38,
          34,
          34,
          4,
        );
        ctx.fill();
      }
    },
  ],
  // The two halves of a card's chrome, split out because ntk 6.7.0 routes
  // them differently for the border width react-x11 defaults to. Both draw
  // the same box; only the stroke's centre-line radius differs, and with it
  // whether the corners go out as cached glyphs or as a rasterized polygon.
  // The gap between these two rows is the cost of one bail-out, in bytes.
  ...[2, 1].map((bw) => [
    `shapes: 24 rounded bordered cards, ${bw}px border`,
    async (app) => {
      const ctx = pixmapCtx(app);
      for (let i = 0; i < 24; i++) {
        const x = 4 + (i % 6) * 62;
        const y = 4 + Math.floor(i / 6) * 46;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.roundRect(x, y, 58, 42, 8);
        ctx.fill();
        ctx.strokeStyle = '#c3ccd8';
        ctx.lineWidth = bw;
        ctx.beginPath();
        ctx.roundRect(
          x + bw / 2,
          y + bw / 2,
          58 - bw,
          42 - bw,
          Math.max(0, 8 - bw / 2),
        );
        ctx.stroke();
      }
    },
  ]),
  [
    // A rectangular clip plus fillRect is every window background under a
    // damage rect — the first draw of every partial repaint. The polygon,
    // glyph and image routes all take ntk's server-side rectangular-clip
    // fast path; `fillRect` was the one that missed it, and each fill under
    // any clip then materialized a window-sized a8 clip mask (CreatePixmap,
    // CreatePicture, a full-surface clear, FreePicture, FreePixmap) and
    // composited through it — ~8 requests and a full surface of server
    // pixel work per fill, for fills the size of a checkbox. Priced here so
    // it cannot come back.
    'fills: 20 fillRects each under a damage clip',
    async (app) => {
      const ctx = pixmapCtx(app);
      for (let i = 0; i < 20; i++) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(8 + i * 4, 8 + i * 9, 40, 24);
        ctx.clip();
        ctx.fillStyle = i % 2 ? '#dfe4ea' : '#2d3436';
        // deliberately larger than the clip, the way a window background is
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    },
  ],
  [
    // The checkbox-hover frame from examples/form.jsx, reduced to the node
    // path it takes: a hover flip marks one rounded, bordered box in a row
    // of labelled widgets, the frame's damage is that box, and the repaint
    // under the damage clip is the window background, the box's fill and
    // its border ring. What this prices is the whole per-frame protocol
    // tail of a pointer interaction: the background fill under the
    // rectangular clip, the picture-clip set/reset churn around the corner
    // glyph runs, and the blit — the frame the protocol trace of issue
    // "hover over a checkbox" is made of.
    'hover: rounded box state flip, on and off',
    (() => {
      let ctl;
      let target;
      return {
        prepare: async (app, x11Root) => {
          ctl = await mounted(x11Root, hoverRowWindow());
          // window -> row box -> [label, hoverable box, label]
          target = ctl.root.children[0].children[1];
        },
        run: async (app) => {
          target.setStyleState(':hover', true);
          ctl.frame();
          await settle(app);
          target.setStyleState(':hover', false);
          ctl.frame();
          await settle(app);
        },
      };
    })(),
  ],
  [
    'mount: window with 40 boxes and labels',
    async (app, x11Root) => {
      await new Promise((resolve) => x11Root.render(rowsWindow(40), resolve));
      await new Promise((r) => setImmediate(r));
    },
  ],
  [
    // Ten wheel notches over a long list, mounted and settled beforehand so
    // only the scrolling is measured. This is the scenario the scroll-blit
    // fast path (issue #138) exists for: the surviving band is CopyArea'd
    // through ntk's Window.scrollRegion and only the exposed strip repaints.
    //
    // Baselined with the blit live, which is the whole point of having it
    // here: --check only fails on an increase, so a change that quietly
    // stopped the fast path firing would sail past a fallback baseline and
    // land squarely on this one (887 requests, 3.28 Mpx, against 437/0.65).
    'scroll: 10 notches over 500 rows',
    (() => {
      let root;
      const frame = () => {
        root._scheduled = false;
        root.flush();
      };
      return {
        prepare: async (app, x11Root) => {
          const instance = await new Promise((resolve) =>
            x11Root.render(
              React.createElement(
                'window',
                { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
                React.createElement(
                  'box',
                  { style: { flexGrow: 1, overflow: 'scroll' } },
                  Array.from({ length: 500 }, (_, i) =>
                    React.createElement(
                      'box',
                      {
                        key: i,
                        style: {
                          flexDirection: 'row',
                          flexShrink: 0,
                          gap: 6,
                          padding: 4,
                          backgroundColor: i % 2 ? '#ffffff' : '#eef1f5',
                        },
                      },
                      React.createElement(
                        'text',
                        { style: { fontSize: 11 } },
                        `row ${i}: the quick brown fox`,
                      ),
                    ),
                  ),
                ),
              ),
              resolve,
            ),
          );
          root = instance._reactX11Node;
          frame();
        },
        run: async (app) => {
          const scroller = root.children[0];
          for (let i = 0; i < 10; i++) {
            scroller.scrollBy(48);
            frame();
            await new Promise((resolve) => app.X.GetInputFocus(resolve));
          }
        },
      };
    })(),
  ],
  [
    // The frame the <svg> rasterization cache (issue #149) exists for: every
    // icon is inside the damage rect and not one of them changed. Damage
    // culling already skips unchanged subtrees *outside* the damage, so this
    // is the case it cannot help with — a theme change, an expose, a resize.
    //
    // `SvgView.draw` re-walks the parsed document every time: Path2D,
    // flatten, stroke extrusion, then FillRectangles + AddTraps + Composite
    // per subpath. So the composite count here is per *subpath*, not per
    // icon, which is what makes 100 unchanged drawings expensive.
    'svg: 100 unchanged icons, full repaint',
    (() => {
      let ctl;
      return {
        prepare: async (app, x11Root) => {
          ctl = await mounted(x11Root, iconWall(100));
        },
        run: async (app) => {
          // what an expose or a theme change does: unbounded damage
          ctl.root.invalidate(true, null, 'expose');
          ctl.frame();
          await settle(app);
        },
      };
    })(),
  ],
  [
    // A sibling's damage covering unchanged icons — hovering one table row
    // repaints every icon in it. Same drawings, ~a tenth of the damage, so
    // the two scenarios together say whether a cache pays in proportion to
    // the icons inside the rect or only on whole-window frames.
    'svg: 10 unchanged icons in a damaged row',
    (() => {
      let ctl;
      return {
        prepare: async (app, x11Root) => {
          ctl = await mounted(x11Root, iconWall(100));
        },
        run: async (app) => {
          // a paint-only change on an ancestor: damage is that node's bounds,
          // and every icon it covers repaints untouched
          const grid = ctl.root.children[0];
          for (let i = 0; i < 10; i++) {
            ctl.root.invalidate(false, grid.children[i], 'style-state');
          }
          ctl.frame();
          await settle(app);
        },
      };
    })(),
  ],
  [
    // A drag under an opaque-move WM (Compiz, KWin, Mutter) is a stream of
    // ConfigureNotify events that change only x/y. The window's own
    // coordinate space is untouched, so the right cost is zero pixels —
    // before the guard in WindowNode's 'resize' listener each step was a
    // full relayout plus a FULL WINDOW repaint. compositePixels is the
    // alarm here: it must stay 0.
    'window: 10 pure moves',
    (() => {
      let ctl;
      return {
        prepare: async (app, x11Root) => {
          ctl = await mounted(x11Root, rowsWindow(40));
          // Pace frames on the round trip alone — deterministic under test,
          // with no wall-clock timer between the event and any (wrong)
          // repaint. `frameClock: 'fence'` as well as the zero interval,
          // since on ntk >= 7 the default clock waits for the display to
          // report each frame, which the in-process server does not model.
          ctl.root.window.frameClock = 'fence';
          ctl.root.window.frameInterval = 0;
        },
        run: async (app) => {
          for (let i = 0; i < 10; i++) {
            app.X.ConfigureWindow(ctl.root.window.id, {
              x: 20 + i * 7,
              y: 30 + (i % 3) * 11,
            });
            // one round trip delivers the ConfigureNotify; two immediates
            // let the paced frame run whatever it (wrongly) scheduled
            await new Promise((resolve) => app.X.GetInputFocus(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
          }
          ctl.frame();
          await settle(app);
        },
      };
    })(),
  ],
  [
    // The interaction from the protocol-efficiency audit: the
    // pointer crosses onto a <Checkbox> row and off again, five times. Real
    // injection through the server (EnterNotify/MotionNotify, hit testing,
    // useControl's hover state, cursor updates), so this window carries
    // everything a hover costs on the wire today: the hover commit's
    // damage-clipped repaint of the well — including ntk's full-window A8
    // clip-mask build/destroy cycle, which is what the `churn` column pins —
    // plus the cursor write and its void-sync round trip, which is what
    // `stalls` pins beyond the bench's own fences.
    'hover: checkbox enter/leave x5',
    (() => {
      let ctl;
      let over;
      let away;
      const findRole = (node, role) => {
        if (node.props?.role === role) return node;
        for (const child of node.children ?? []) {
          const hit = findRole(child, role);
          if (hit) return hit;
        }
        return null;
      };
      // Let the injected events propagate (stream pair delivers on a
      // setImmediate), let React commit the hover state (in Node the
      // scheduler flushes on setImmediate too), then paint and fence. No
      // wall-clock timers: a setTimeout lap would race the deliveries and
      // make the interleaving — and with it the stall count — machine-speed
      // dependent. One settle per pump, so the fence count is fixed.
      const pump = async (app) => {
        for (let i = 0; i < 4; i++) {
          await new Promise((resolve) => setImmediate(resolve));
          await new Promise((resolve) => setImmediate(resolve));
          ctl.frame();
        }
        await settle(app);
      };
      return {
        prepare: async (app, x11Root, server) => {
          ctl = await mounted(
            x11Root,
            React.createElement(
              'window',
              { width: W, height: H, style: { backgroundColor: '#2f3640' } },
              React.createElement(
                'box',
                { style: { flexGrow: 1, padding: 16, gap: 12 } },
                React.createElement(
                  'text',
                  { style: { fontSize: 12, color: '#dcdde1' } },
                  'size',
                ),
                React.createElement(
                  Checkbox,
                  { checked: false, onChange: () => {} },
                  'Shout it',
                ),
              ),
            ),
          );
          // pace on the fence alone, like the pure-moves scenario: the
          // in-process server does not model Present completions
          ctl.root.window.frameClock = 'fence';
          ctl.root.window.frameInterval = 0;
          const row = findRole(ctl.root, 'checkbox');
          if (!row?.abs) throw new Error('checkbox row not laid out');
          const origin = ctl.root.window._screenOrigin ?? {
            x: ctl.root.window.x ?? 0,
            y: ctl.root.window.y ?? 0,
          };
          over = {
            x: Math.round(origin.x + row.abs.x + row.abs.width / 2),
            y: Math.round(origin.y + row.abs.y + row.abs.height / 2),
          };
          away = { x: origin.x + 5, y: origin.y + 5 };
          // start from a known spot so the first crossing is a crossing
          server.injectPointerMove(away.x, away.y);
          await pump(app);
        },
        run: async (app, x11Root, server) => {
          for (let i = 0; i < 5; i++) {
            server.injectPointerMove(over.x, over.y);
            await pump(app);
            server.injectPointerMove(away.x, away.y);
            await pump(app);
          }
        },
      };
    })(),
  ],
  [
    // What the two decorations cost per frame (issue #345): 24 cards, each
    // with a gradient background and a blurred shadow, repainted in full
    // five times. The gradient is a source picture the fill samples, so it
    // is one composite like a colour; the shadow is a blurred a8 coverage
    // surface, and every card's is the same size, so the paint cache should
    // render **one** and composite it 24 times a frame.
    //
    // Baselined with the cache live, like the scroll-blit scenario above and
    // for the same reason: --check only fails on an increase, so a change
    // that quietly stopped the shadow surface being shared would land here
    // rather than sail past a fallback number.
    //
    // The bytes are the interesting number and they are **not** ours: of the
    // 475KB, 471KB is the rounded-rect coverage mask that ntk rasterizes
    // client-side and uploads per fill, because its rounded-rect fast path
    // (cached corner glyphs plus FillRectangles) only takes a solid colour.
    // Measured by parts, same 5 frames over the same 24 cards:
    //
    //   solid colour, radius 6                    251 reqs   14.6 KB
    //   + shadow                                  381 reqs   19.1 KB
    //   gradient, radius 0                        135 reqs    4.6 KB
    //   gradient, radius 6                        257 reqs  471.2 KB
    //
    // So a *square* gradient is a source picture and costs nothing on the
    // wire, and the shadow — the expensive-looking half — is one cached
    // surface composited 24 times. Teaching ntk's fast path to composite a
    // non-solid source through the coverage it already builds would take
    // this scenario back under 25KB; until then it is worth knowing that a
    // rounded gradient is the priciest box in this vocabulary.
    'shapes: 24 gradient+shadow cards, 5 full repaints',
    (() => {
      let ctl;
      const cards = React.createElement(
        'window',
        { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
        React.createElement(
          'box',
          {
            style: {
              flexGrow: 1,
              padding: 10,
              gap: 10,
              flexDirection: 'row',
              flexWrap: 'wrap',
            },
          },
          Array.from({ length: 24 }, (_, i) =>
            React.createElement('box', {
              key: i,
              style: {
                width: 80,
                height: 44,
                borderRadius: 6,
                backgroundImage:
                  'linear-gradient(160deg, #2b5876 20%, #4e4376)',
                boxShadow: '0 2px 6px rgba(0, 0, 0, .45)',
              },
            }),
          ),
        ),
      );
      return {
        prepare: async (app, x11Root) => {
          ctl = await mounted(x11Root, cards);
          // the cache admits a key on its second sighting, so one warm-up
          // frame is what makes this measure the steady state rather than
          // the first two
          for (let i = 0; i < 2; i++) {
            ctl.root.needsPaint = true;
            ctl.root._damage = null;
            ctl.frame();
            await settle(app);
          }
        },
        run: async (app) => {
          for (let i = 0; i < 5; i++) {
            ctl.root.needsPaint = true;
            ctl.root._damage = null;
            ctl.frame();
            await settle(app);
          }
        },
      };
    })(),
  ],
  [
    // A paint-only change: the box flips color in place. The damage tracker
    // bounds this to the box, so compositePixels stays near the box's own
    // area — this is the partial-repaint contract the Damage panel of
    // examples/stress demonstrates, pinned as a number.
    'update: 5 color flips, no layout',
    (() => {
      let ctl;
      return {
        prepare: async (app, x11Root) => {
          ctl = await mounted(x11Root, absBoxWindow(40, '#3498db'));
        },
        run: async (app, x11Root) => {
          for (let i = 0; i < 5; i++) {
            await new Promise((resolve) =>
              x11Root.render(
                absBoxWindow(40, i % 2 ? '#3498db' : '#e74c3c'),
                resolve,
              ),
            );
            ctl.frame();
            await settle(app);
          }
        },
      };
    })(),
  ],
  [
    // The same box moving instead: `left` changes, layout runs, and today
    // any layout pass degrades the frame to FULL damage — the whole window
    // per step instead of two box-sized rects (the old and new positions).
    // Baselined as-is on purpose: this documents the known cost of
    // unbounded layout damage, and the number here should DROP by an order
    // of magnitude when bounded layout damage lands (--check only fails on
    // increases, so an improvement sails through and can be re-saved).
    'update: 5 absolute box moves (layout)',
    (() => {
      let ctl;
      return {
        prepare: async (app, x11Root) => {
          ctl = await mounted(x11Root, absBoxWindow(40, '#3498db'));
        },
        run: async (app, x11Root) => {
          for (let i = 0; i < 5; i++) {
            await new Promise((resolve) =>
              x11Root.render(
                absBoxWindow(40 + (i + 1) * 30, '#3498db'),
                resolve,
              ),
            );
            ctl.frame();
            await settle(app);
          }
        },
      };
    })(),
  ],
  [
    // Issue #301: five drag steps over a 300-cell scene drawn into ONE
    // registered element. Each step is a React commit with a new `cells`
    // array plus the element's own claim on the cell that moved.
    //
    // Baselined with both seams live, the way the scroll-blit scenario is:
    // --check only fails on an increase, so a change that quietly stopped
    // either of them working lands squarely here — and it takes both, which
    // is the part worth writing down. The same five steps measured with one
    // seam at a time, against 239 requests / 0.08 Mpx for the pair:
    //
    //   neither                     9054 reqs, 6005 composites, 4.09 Mpx
    //   selfDamagedProps only       9054 reqs, 6005 composites, 3.35 Mpx
    //   paintDamage() only          9054 reqs, 6005 composites, 4.09 Mpx
    //
    // A scoped commit whose paint cannot read the rect redraws all 300 cells
    // into a clip that keeps four — the wire cost is identical and only the
    // server's rasterization narrows. A paint that culls, in a frame the
    // commit widened to the whole pane, has nothing to cull against.
    'scene: 5 drag steps over 300 cells in one node',
    (() => {
      let ctl;
      return {
        prepare: async (app, x11Root) => {
          ctl = await mounted(x11Root, sceneWindow(sceneCells()));
        },
        run: async (app, x11Root) => {
          for (let i = 0; i < 5; i++) {
            await new Promise((resolve) =>
              x11Root.render(sceneWindow(sceneCells(i)), resolve),
            );
            ctl.frame();
            await settle(app);
          }
        },
      };
    })(),
  ],
  [
    // The pan (issue #303). Five diagonal steps of the same pane: every
    // pixel translates, so the damage seams of #301 have nothing to scope
    // to and the frame is the whole pane by construction. `scrollContents`
    // turns each step into one CopyArea plus the two strips it exposed.
    // The same five steps under REACT_X11_NO_SCROLL_BLIT=1 — every gate
    // here falls back to exactly that — cost 9845 requests / 6533
    // composites / 4.22 Mpx, against 982 / 606 / 0.30 with the blit.
    'scene: 5 pan steps over 374 cells in one node',
    (() => {
      let ctl;
      let pane;
      return {
        prepare: async (app, x11Root) => {
          ctl = await mounted(x11Root, panSceneWindow());
          pane = ctl.root.children.find((n) => n.kind === 'panscene');
        },
        run: async (app, x11Root) => {
          for (let i = 0; i < 5; i++) {
            pane.pan(7, 5);
            ctl.frame();
            await settle(app);
          }
        },
      };
    })(),
  ],
  [
    // The same five steps with furniture up (issue #309). A pane's minimap
    // and zoom controls have to repaint on a pan frame, and their pixels
    // must not ride the blit — so the element carves their strip out of the
    // region it shifts and claims it itself. The claim lands *beside* the
    // blit rect, which is the whole point: the gate is the rect, not the
    // node, so the pan stays a blit and pays for the strip on top.
    'scene: 5 pan steps with a HUD strip beside them',
    (() => {
      let ctl;
      let pane;
      return {
        prepare: async (app, x11Root) => {
          ctl = await mounted(x11Root, panSceneWindow());
          pane = ctl.root.children.find((n) => n.kind === 'panscene');
        },
        run: async (app, x11Root) => {
          for (let i = 0; i < 5; i++) {
            pane.panBeside(7, 5);
            ctl.frame();
            await settle(app);
          }
        },
      };
    })(),
  ],
];

// --- run ---------------------------------------------------------------

const results = {};
for (const [name, fn] of SCENARIOS) {
  // progress to stderr so a hung CI run says which scenario it was in
  process.stderr.write(`· ${name}\n`);
  const [key, value] = await measure(name, fn);
  results[key] = value;
}

if (args.includes('--save')) {
  writeFileSync(baselinePath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`wrote ${baselinePath}`);
}

const pad = (v, n) => String(v).padStart(n);
console.log(
  `${'scenario'.padEnd(38)} ${pad('reqs', 6)} ${pad('bytesOut', 9)} ${pad('replies', 8)} ${pad('composites', 11)} ${pad('Mpx', 8)} ${pad('stalls', 7)} ${pad('dupQ', 5)} ${pad('churn', 6)}`,
);
for (const [name, r] of Object.entries(results)) {
  console.log(
    `${name.padEnd(38)} ${pad(r.requests, 6)} ${pad(r.bytesOut, 9)} ${pad(r.replies, 8)} ${pad(r.composites, 11)} ${pad((r.compositePixels / 1e6).toFixed(2), 8)} ${pad(r.stalls, 7)} ${pad(r.dupQueries, 5)} ${pad(r.churn, 6)}`,
  );
}

if (args.includes('--hotspots')) {
  const list = (entries, limit = 8) =>
    entries
      .slice(0, limit)
      .map(([key, n]) => `${key} ×${n}`)
      .join(', ');
  for (const [name, a] of Object.entries(hotspots)) {
    console.log(`\n${name}`);
    console.log(`  requests   ${list(a.byName)}`);
    if (a.stallsBy.length) console.log(`  stalled on ${list(a.stallsBy)}`);
    if (a.dupsBy.length) console.log(`  repeated   ${list(a.dupsBy)}`);
    if (a.churnBy.length) console.log(`  churned    ${list(a.churnBy)}`);
  }
}

if (args.includes('--check')) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    console.error('\nno baseline — run `npm run bench -- --save` first');
    process.exit(1);
  }
  // A scenario in only one of the two sets means the baseline is stale —
  // and a renamed scenario would otherwise silently lose its gate.
  const missing = [
    ...Object.keys(results).filter((name) => !baseline[name]),
    ...Object.keys(baseline).filter((name) => !results[name]),
  ];
  if (missing.length) {
    console.error('\nbaseline out of date — run `npm run bench -- --save`:');
    for (const name of missing) console.error(`  ${name}`);
    process.exit(1);
  }
  // Per-metric [factor, slack], sized to the noise documented in the file
  // header so the gate catches step changes rather than jitter. The slack
  // also means a zero baseline tolerates a few units before failing — the
  // price of not flaking; a real regression class (a per-frame cycle, a
  // per-step round trip) lands far past it.
  const GATES = {
    requests: [1.15, 8],
    bytesOut: [1.15, 256],
    composites: [1.15, 2],
    compositePixels: [1.15, 2],
    stalls: [1.25, 5],
    dupQueries: [1.15, 2],
    churn: [1.15, 4],
  };
  const regressions = [];
  for (const [name, now] of Object.entries(results)) {
    const was = baseline[name];
    for (const [metric, [factor, slack]] of Object.entries(GATES)) {
      // a baseline from before a metric existed gates nothing for it
      if (was[metric] === undefined) continue;
      const limit = was[metric] * factor + slack;
      if (now[metric] > limit) {
        regressions.push(
          `${name} — ${metric}: ${was[metric]} -> ${now[metric]}`,
        );
      }
    }
  }
  if (regressions.length) {
    console.error('\nprotocol regressions:');
    for (const r of regressions) console.error(`  ${r}`);
    process.exit(1);
  }
  console.log('\nno regressions against the baseline');
}

process.exit(0);
