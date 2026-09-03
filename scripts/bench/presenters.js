// Cocoa presenter benchmark: the measure-first gate of docs/macos.md, as a
// number — and the stress rig for "state update → pixels" and "interaction
// → pixels" on a live display. One scenario, N presenters/backends, the same
// ticks — and every frame broken into the stages that can be the bottleneck:
//
//   flush     JS building the frame: painters into the surface, or the
//             layer sync (prop diffing + per-visual rasters). The one paint
//             channel, so this is "client cost per frame".
//   damage    what the frame repainted: kpx per painting frame and the share
//             of frames that repainted the whole window. On the surface
//             presenter this is the raster work; on layers it is what the
//             X11 damage model would have painted (still computed, unused).
//   cpu       process CPU over the run, as a percentage of one core — the
//             pump, React, layout, paint, and the bridge's own work. The
//             number to watch for "what does this app cost while it runs".
//   upload    handoffs to Core Animation per frame: surfaceToLayer (CGImage
//             copies) and, on the IOSurface swapchain, flips plus the
//             damage-sized catch-up copy. kpx tells the story.
//   props     setLayerProps calls per frame — the layers presenter's other
//             half. A pure scroll should be ~2; a recolour wall should be
//             ~N with zero uploads (PropBox); a number that scales with the
//             tree on a one-box change is a diffing bug.
//   input     for the input scenarios: event posted → the end of the flush
//             that answered it (the "answer the input" number), and → the
//             end of the present that put it on glass. p50/p95/max.
//
//   npm run bench:presenters                    # every scenario, both
//   npm run bench:presenters -- --scenario=cards --seconds=8
//   npm run bench:presenters -- --columns=surface   # one presenter only
//   npm run bench:presenters -- --x11           # extra column via $DISPLAY
//   npm run bench:presenters -- --cells=2400    # bigger stress trees
//   npm run bench:presenters -- --at=200,200    # the window at a point (on
//                                               # the screen whose rate you
//                                               # mean to measure)
//   npm run bench:presenters -- --prof --scenario=tree --columns=surface
//                                               # a .cpuprofile per cell
//   npm run bench:presenters -- --shots         # snapshot each run's last
//                                               # frame for an eyeball diff
//   npm run bench:presenters -- --check         # the structural gate
//                                               # (presenters-gate.json)
//
// Scenario design: each isolates one shape of change, because the presenters
// differ per shape, not overall — a wall recolour is layer properties on one
// side and full-window paint on the other, while a text change rasters on
// both and measures pure raster throughput. The stress scenarios (`tree`,
// `commit`, `layout`, `multi`, `tiny`, `typing`, `press`, `resize`, `anim`,
// `icons`, `occluded`, `idle`) put the same shapes inside a tree the size of
// a real application screen — `--cells` boxes, each with a label — because a
// path that is cheap on twelve nodes and quadratic on a thousand only shows
// there.
//
// Comparisons hold within a run (same machine, same session); absolute
// numbers travel about as well as any timing does — that is, they don't.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import React from 'react';

const e = React.createElement;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SECONDS = Number(flag('seconds', args.includes('--ci') ? 3 : 6));
const ONLY = flag('scenario', flag('only', null));
const WITH_X11 = args.includes('--x11');
const SHOTS = args.includes('--shots');
const PROF = args.includes('--prof');
const CHILD = args.includes('--child');
const CELLS = Number(flag('cells', 1200));
const COLUMNS = flag('columns', null);
const SIZE = flag('size', '900x700');
const FRAME = flag('frame', null); // cocoa frame interval, ms
// --at=x,y: where to put the window, in points, top-left global — on a
// desk with a 120Hz panel and a 75Hz monitor the default frame interval is
// the display's, so which screen the window lands on is part of the result
const AT = flag('at', null);
// --check: the structural gate (scripts/bench/presenters-gate.json) — counts
// and areas the frame clock and the damage model must keep, judged per
// scenario and never in milliseconds, so the answer is the same on a shared
// runner as on the machine the rules were written on. --ci is --check with
// the short run and the table appended to the job summary.
const CI = args.includes('--ci');
const CHECK = args.includes('--check') || CI;

const [W, H] = SIZE.split('x').map(Number);
const TICK_MS = 16;

// ---------------------------------------------------------------------------
// Scenarios. Each is { tree(tick), drive?, setup?, latency?, input? } —
// `tree` is rendered per tick (the React-state shape of change), `drive`
// instead pushes real events and leaves the tree alone (the input shape).
// `latency: true` marks the ones whose headline number is input→flush
// rather than fps; `input: 'native'` means the events go through the
// NSApp queue and the scenario has no meaning on X11; `cocoaOnly` skips it
// there outright.
// ---------------------------------------------------------------------------

const TINTS = ['#ffffff', '#eef4fb', '#fdf1e7', '#eefaf1'];
const HOT = ['#0984e3', '#00b894', '#e17055', '#6c5ce7', '#fdcb6e'];
const COLD = '#eef2f5';

function windowOf(children, title) {
  return e(
    'window',
    { width: W, height: H, title, style: { backgroundColor: '#e9edf2' } },
    ...children,
  );
}

// --- the stress grid ---------------------------------------------------------

// `--cells` boxes in a grid close to the window's aspect, each with a label.
// A cell is a <box> around a <text>, so a tree of N cells is 2N drawn nodes
// plus N text chunks — the shape of a dashboard, a table body, a tool grid.
const COLS = Math.max(4, Math.round(Math.sqrt((CELLS * W) / H)));
const ROWS = Math.max(2, Math.ceil(CELLS / COLS));

const CELL = {
  flexGrow: 1,
  flexBasis: 0,
  minWidth: 0,
  minHeight: 0,
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 2,
};
const ROW = {
  flexDirection: 'row',
  flexGrow: 1,
  flexBasis: 0,
  minHeight: 0,
  gap: 1,
};

/** A memoized cell: only a cell whose colour or label changed re-renders,
 * so a one-cell tick is a one-node commit — what a well-written app does. */
const Cell = React.memo(function Cell({ color, label, fontSize }) {
  return e(
    'box',
    { style: { ...CELL, backgroundColor: color } },
    label == null
      ? null
      : e('text', { style: { fontSize, color: '#2d3436' } }, label),
  );
});

/**
 * A cell that owns its colour through a store: `useSyncExternalStore` on
 * the store's tick, hot when the tick lands on it. The commit that follows
 * a poke is this one component and nothing above it.
 */
const StoreCell = React.memo(function StoreCell({
  store,
  index,
  label,
  fontSize,
}) {
  // the snapshot is THIS cell's state — the tick while it is the hot one,
  // -1 otherwise — so React re-renders the two cells whose answer moved and
  // bails out of the other twelve hundred at the snapshot compare
  const tick = React.useSyncExternalStore(store.subscribe, () => {
    const t = store.read();
    return t % store.count === index ? t : -1;
  });
  const hot = tick >= 0;
  return e(
    'box',
    {
      style: { ...CELL, backgroundColor: hot ? HOT[tick % HOT.length] : COLD },
    },
    label == null
      ? null
      : e('text', { style: { fontSize, color: '#2d3436' } }, label),
  );
});

function makeStore(count) {
  let tick = 0;
  const listeners = new Set();
  return {
    count,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    read: () => tick,
    poke(next) {
      tick = next;
      for (const fn of listeners) fn();
    },
  };
}

/** The same cell, re-rendered every tick with a rebuilt style of the same
 * contents — what an app without memoization does, and the shape that
 * prices the commit walk (applyProps over every node, NO_DAMAGE from all
 * but one). */
function LiveCell({ color, label, fontSize }) {
  return e(
    'box',
    { style: { ...CELL, backgroundColor: color } },
    label == null
      ? null
      : e('text', { style: { fontSize, color: '#2d3436' } }, label),
  );
}

function grid({
  cols = COLS,
  rows = ROWS,
  hot = new Set(),
  hotColor = HOT[0],
  pad = 8,
  fontSize = 9,
  labels = true,
  live = false,
  store = null,
  key = 'grid',
} = {}) {
  const C = live ? LiveCell : Cell;
  const rowEls = [];
  for (let r = 0; r < rows; r += 1) {
    const cells = [];
    for (let c = 0; c < cols; c += 1) {
      const k = `${r}:${c}`;
      cells.push(
        store
          ? e(StoreCell, {
              key: k,
              store,
              index: r * cols + c,
              label: labels ? `${r}.${c}` : null,
              fontSize,
            })
          : e(C, {
              key: k,
              color: hot.has(k) ? hotColor : COLD,
              label: labels ? `${r}.${c}` : null,
              fontSize,
            }),
      );
    }
    rowEls.push(e('box', { key: r, style: ROW }, ...cells));
  }
  return e(
    'box',
    { key, style: { flexGrow: 1, minHeight: 0, gap: 1, padding: pad } },
    ...rowEls,
  );
}

const hotOne = (tick, cols = COLS, rows = ROWS) =>
  new Set([`${tick % rows}:${(tick * 7) % cols}`]);

const hotMany = (tick, n, cols = COLS, rows = ROWS) => {
  const hot = new Set();
  for (let i = 0; i < n; i += 1) {
    const idx = (i * 7919 + tick * 104729) % (cols * rows);
    hot.add(`${Math.floor(idx / cols)}:${idx % cols}`);
  }
  return hot;
};

const header = (text) =>
  e(
    'text',
    { key: 'head', style: { margin: 8, fontSize: 14, color: '#2d3436' } },
    text,
  );

/** The centre of a node, in points — where postMouseEvent aims. */
function centreOf(node, scale) {
  return [
    (node.abs.x + node.abs.width / 2) / scale,
    (node.abs.y + node.abs.height / 2) / scale,
  ];
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
      const { win, stamp } = ctx;
      const scroller = ctx.find((n) => n.isScroller?.());
      if (!scroller) return;
      const x = scroller.abs.x + scroller.abs.width / 2;
      const y = scroller.abs.y + scroller.abs.height / 2;
      const down = ctx.tick % 120 < 60; // sweep down, then back up
      stamp();
      if (ctx.app._routeWheel && ctx.wnd) {
        // the bridge's event shape, in points: the same route a real notch
        // takes, so what the app does with a wheel is in the number
        const s = ctx.wnd.scale;
        ctx.app._routeWheel({
          type: 'wheel',
          windowNumber: ctx.wnd.windowNumber,
          x: x / s,
          y: y / s,
          gx: (ctx.wnd.x + x) / s,
          gy: (ctx.wnd.y + y) / s,
          dx: 0,
          dy: down ? -3 : 3,
          precise: false,
          time: performance.now(),
        });
        return;
      }
      win.emit('wheel', {
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
      ctx.stamp();
      ctx.native.postMouseEvent(
        ctx.wnd._h,
        'move',
        ...centreOf(target, ctx.wnd.scale),
      );
    },
  },

  // --- the stress scenarios -------------------------------------------------

  /** A large component tree, one cell recolouring per tick: the plain
   *  "state update → pixels" case at application size. The commit is one
   *  node (the cells are memoized), the damage one cell; what is left is
   *  the fixed cost of a frame over a big tree — the walks that are not
   *  bounded by the damage. Compare `flush` here against `color`. */
  tree: {
    tree: (tick) =>
      windowOf(
        [header(`tree — ${COLS}x${ROWS} cells`), grid({ hot: hotOne(tick) })],
        'bench tree',
      ),
  },

  /** The same tree, but the update arrives the way an app's does: one cell
   *  subscribes to a store and re-renders alone when it is poked. No root
   *  re-render, no element tree rebuilt, no memo compares — what is left in
   *  `cpu` is the renderer's own cost of one commit and one frame over a
   *  large tree, which is the number `tree` cannot separate from React's. */
  leaf: {
    tree: (tick, { store }) =>
      windowOf(
        [
          header(`leaf — one cell of ${COLS}x${ROWS} through a store`),
          grid({ store, hot: hotOne(0) }),
        ],
        'bench leaf',
      ),
    drive(ctx) {
      ctx.store.poke(ctx.tick);
    },
  },

  /** The same tree, every cell re-rendered every tick with an equal style —
   *  the commit walk itself. Every applyProps runs and all but one answer
   *  NO_DAMAGE; `flush` should match `tree`, and the difference in `cpu` is
   *  React plus the per-node diff — the price of not memoizing. */
  commit: {
    tree: (tick) =>
      windowOf(
        [
          header(`commit — ${COLS}x${ROWS} live cells`),
          grid({ hot: hotOne(tick), live: true }),
        ],
        'bench commit',
      ),
  },

  /** A large layout: the container's padding toggles every tick, so every
   *  cell moves by a pixel or two. A full yoga pass over the tree, every
   *  text re-measured at its new width, and an unbounded repaint — the
   *  worst frame a resize or a panel toggle produces, at 60Hz. */
  layout: {
    tree: (tick) =>
      windowOf(
        [
          header(`layout — ${COLS}x${ROWS} cells reflowing`),
          grid({ hot: hotOne(tick), pad: tick % 2 ? 8 : 12 }),
        ],
        'bench layout',
      ),
  },

  /** Many components updating in the same commit: 12 cells scattered over
   *  the grid recolour per tick. Damage is a list capped at four rects, so
   *  the paint area is what the cap costs — `damage` against twelve cells'
   *  worth — and the frame is what several independent widgets ticking at
   *  once (a clock, a graph, a status row) actually pay. */
  multi: {
    tree: (tick) =>
      windowOf(
        [
          header(`multi — 12 of ${COLS * ROWS} cells per tick`),
          grid({ hot: hotMany(tick, 12), hotColor: HOT[tick % HOT.length] }),
        ],
        'bench multi',
      ),
  },

  /** A zoomed-out view: thousands of tiny cells with 5px labels, one
   *  changing per tick and the whole grid reflowing every 40th. Nothing in
   *  the labels can be read, and the question is whether the renderer still
   *  shapes and rasters every one of them — the "if we cannot see the
   *  detail we should not pay for it" case. */
  tiny: {
    tree: (tick) => {
      const cols = 100;
      const rows = Math.ceil((CELLS * 4) / cols);
      return windowOf(
        [
          header(`tiny — ${cols}x${rows} cells, 5px labels`),
          grid({
            cols,
            rows,
            hot: hotOne(tick, cols, rows),
            fontSize: 5,
            pad: Math.floor(tick / 40) % 2 ? 6 : 8,
          }),
        ],
        'bench tiny',
      );
    },
  },

  /** Typing into a field above the big tree, through the NSApp queue: a
   *  key down and up per tick. The answer is one caret and one glyph; the
   *  cost that must not be there is anything proportional to the tree. */
  typing: {
    latency: true,
    input: 'native',
    tree: () =>
      windowOf(
        [
          e(
            'box',
            { key: 'bar', style: { padding: 8, flexDirection: 'row' } },
            e('textinput', {
              placeholder: 'type here',
              style: {
                width: 320,
                height: 30,
                paddingLeft: 8,
                backgroundColor: '#ffffff',
                borderWidth: 1,
                borderColor: '#c3ccd8',
                borderRadius: 4,
              },
            }),
          ),
          grid({ rows: Math.floor(ROWS / 2) }),
        ],
        'bench typing',
      ),
    setup(ctx) {
      const input = ctx.find((n) => n.kind === 'textinput');
      if (!input) return;
      const [x, y] = centreOf(input, ctx.wnd.scale);
      ctx.native.postMouseEvent(ctx.wnd._h, 'down', x, y);
      ctx.native.postMouseEvent(ctx.wnd._h, 'up', x, y);
    },
    drive(ctx) {
      // kVK_ANSI_A is 0; every 24th key a backspace (51) keeps the field short
      const erase = ctx.tick % 24 === 0;
      ctx.stamp();
      ctx.native.postKeyEvent(
        ctx.wnd._h,
        true,
        erase ? 51 : 0,
        erase ? '' : 'a',
      );
      ctx.native.postKeyEvent(
        ctx.wnd._h,
        false,
        erase ? 51 : 0,
        erase ? '' : 'a',
      );
    },
  },

  /** A press and release on a button above the big tree, through the NSApp
   *  queue: `:active` on the down, back on the up. The press state is the
   *  renderer's own repaint of one node; both halves are stamped, so the
   *  latency column is the whole "answer the input" promise. */
  press: {
    latency: true,
    input: 'native',
    tree: () =>
      windowOf(
        [
          e(
            'box',
            {
              key: 'bar',
              style: { padding: 8, flexDirection: 'row', gap: 8 },
            },
            ...Array.from({ length: 6 }, (_, i) =>
              e(
                'box',
                {
                  key: i,
                  style: {
                    width: 110,
                    height: 32,
                    borderRadius: 6,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: '#ffffff',
                    borderWidth: 1,
                    borderColor: '#c3ccd8',
                    ':hover': { backgroundColor: '#eef4fb' },
                    ':active': { backgroundColor: '#b9c9dc' },
                  },
                },
                e('text', { style: { color: '#2d3436' } }, `button ${i}`),
              ),
            ),
          ),
          grid({ rows: Math.floor(ROWS / 2) }),
        ],
        'bench press',
      ),
    drive(ctx) {
      const button = ctx.find((n) => n.style?.[':active'] !== undefined);
      if (!button) return;
      const [x, y] = centreOf(button, ctx.wnd.scale);
      ctx.stamp();
      ctx.native.postMouseEvent(ctx.wnd._h, ctx.tick % 2 ? 'down' : 'up', x, y);
    },
  },

  /** A live resize of a window holding the big tree, then a press the
   *  moment it ends. Forty size changes through the window delegate (the
   *  route a drag takes, minus AppKit's modal loop), each answered
   *  synchronously: relayout, repaint, swapchain. Then a mouse down and up.
   *  Reported: ms per resize, flushes per resize, backing surfaces made,
   *  the settle after the last resize, and the press latency after it —
   *  which is where a freeze or a stale frame would show. */
  resize: {
    latency: true,
    input: 'native',
    seconds: 4,
    tree: () =>
      windowOf(
        [header(`resize — ${COLS}x${ROWS} cells`), grid()],
        'bench resize',
      ),
    setup(ctx) {
      // A drag, not a script: the delegate reports every tick as live, and
      // no pump runs between them (AppKit's modal loop owns the thread) —
      // so the end-of-drag reset the pump performs is held off until the
      // burst is over, when `drive` puts it back.
      const app = ctx.app;
      const route = app._routeGeometry.bind(app);
      app._routeGeometry = (ev) => route({ ...ev, live: true });
      ctx.extra.endLiveResizes = app._endLiveResizes.bind(app);
      app._endLiveResizes = () => {};
    },
    drive(ctx) {
      const { tick, native, wnd, extra } = ctx;
      const steps = 40;
      if (tick === steps + 1 && extra.endLiveResizes) {
        // the mouse release: the modal loop ends, the pump runs again
        ctx.app._endLiveResizes = extra.endLiveResizes;
        extra.endLiveResizes = null;
      }
      if (tick <= steps) {
        // a sawtooth: mostly growing, with a shrink every few steps, the way
        // a hand on a corner wobbles
        const dw = ((tick * 11) % 60) - 10;
        const dh = ((tick * 7) % 40) - 8;
        extra.flushesAtFirstResize ??= ctx.stats.flushes;
        const t0 = performance.now();
        native.setWindowFrame(wnd._h, null, null, W + dw, H + dh);
        const t1 = performance.now();
        extra.resizes = (extra.resizes ?? 0) + 1;
        extra.resizeMs = (extra.resizeMs ?? 0) + (t1 - t0);
        extra.resizeMax = Math.max(extra.resizeMax ?? 0, t1 - t0);
        // snapshotted synchronously: what lands after this tick's microtasks
        // (a queued full frame, a React commit) is the resize's cost too
        extra.flushesAtLastResize = ctx.stats.flushes;
        extra.lastResizeEnd = t1;
        return;
      }
      if (tick === steps + 1) {
        // frames per resize, counted a tick later so the ones a resize
        // leaves behind on the microtask queue are attributed to it
        extra.resizeFlushes =
          ctx.stats.flushes - (extra.flushesAtFirstResize ?? 0);
      }
      if (tick === steps + 3 || tick === steps + 4) {
        const head = ctx.find((n) => n.kind === 'text');
        if (!head) return;
        if (tick === steps + 3) {
          // how long the tree kept painting after the last size landed, and
          // how many frames that took — a burst here is the backlog a drag
          // leaves behind
          extra.settleMs = Math.max(
            0,
            (ctx.stats.lastFlushEnd ?? extra.lastResizeEnd) -
              extra.lastResizeEnd,
          );
          extra.settleFlushes =
            ctx.stats.flushes - (extra.flushesAtLastResize ?? 0);
        }
        const [x, y] = centreOf(head, wnd.scale);
        ctx.stamp();
        native.postMouseEvent(wnd._h, tick === steps + 3 ? 'down' : 'up', x, y);
      }
    },
  },

  /** Transitions: 48 cards with a 240ms backgroundColor transition, the
   *  palette rotating every 15 ticks. Between commits the renderer's own
   *  animation frames run — fps and damage are the animation path's, and
   *  cpu is what a screen of gentle fades costs. */
  anim: {
    tree: (tick) => {
      const CARD_W = 130;
      const CARD_H = 70;
      const GAP = 12;
      const PAD = 16;
      const step = Math.floor(tick / 15);
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
              backgroundColor: HOT[(i + step) % HOT.length],
              borderRadius: 8,
              transition: { backgroundColor: 240 },
            },
          }),
        );
      }
      return windowOf(
        [e('box', { style: { flexGrow: 1 } }, ...cards)],
        'bench anim',
      );
    },
  },

  /** 300 system icons (`<Icon>`, a mono <canvas> each) re-tinted every
   *  tick. On X11 a mono icon is an a8 coverage entry in the paint cache and
   *  a tint is a composite; wherever the cache is not engaged every tick is
   *  300 live canvas paints. The `damage` column stays the same either way,
   *  which is why `flush` and `cpu` are the columns to read. */
  icons: {
    tree: (tick, { Icon }) => {
      const names = ['check', 'chevronDown', 'close', 'chevronRight'];
      const icons = [];
      for (let i = 0; i < 300; i += 1) {
        icons.push(
          e(Icon, {
            key: i,
            name: names[i % names.length],
            size: 16,
            color: HOT[(i + tick) % HOT.length],
          }),
        );
      }
      return windowOf(
        [
          e(
            'box',
            {
              style: {
                flexGrow: 1,
                padding: 12,
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 6,
                alignContent: 'flex-start',
              },
            },
            ...icons,
          ),
        ],
        'bench icons',
      );
    },
  },

  /** The big tree with a cell changing per tick — in a window nobody can
   *  see (ordered out after the mount). The right answer is no frames and
   *  no presents: "if it is not visible it should cost nothing". */
  occluded: {
    cocoaOnly: true,
    tree: (tick) =>
      windowOf(
        [header('occluded'), grid({ hot: hotOne(tick) })],
        'bench occluded',
      ),
    setup(ctx) {
      ctx.native.hideWindow(ctx.wnd._h);
    },
  },

  /** The same tree and tick, in a window that is on screen but entirely
   *  behind another window — one of our own, opened over it in setup, the
   *  way another application's would sit. AppKit reports the difference
   *  (`windowDidChangeOcclusionState`, bridge 0.4) and a covered window
   *  owes what a hidden one does: no frames, no presents. */
  covered: {
    cocoaOnly: true,
    tree: (tick) =>
      windowOf(
        [header('covered'), grid({ hot: hotOne(tick) })],
        'bench covered',
      ),
    setup(ctx) {
      // points, top-left global; padded so the cover takes the title bar
      // and the shadow with it, whatever AppKit added around the content
      const f = ctx.native.getWindowFrame(ctx.wnd._h);
      const pad = 80;
      const cover = ctx.native.createWindow2({
        x: f.x - pad,
        y: f.y - pad,
        width: f.width + 2 * pad,
        height: f.height + 2 * pad,
        title: 'bench cover',
        kind: 'normal',
        resizable: false,
        backgroundColor: [0.25, 0.25, 0.25, 1],
      });
      ctx.native.showWindow(cover, true);
      ctx.cover = cover; // kept so it is not collected out from over us
    },
  },

  /** Nothing happens: the big tree on screen, no ticks. What the app costs
   *  at rest is the pump and nothing else — `cpu` and `pump` are the
   *  columns, and `frames` must be zero. */
  idle: {
    tree: () =>
      windowOf([header('idle'), grid({ hot: hotOne(0) })], 'bench idle'),
    drive() {},
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
  const { Icon } = await import('../../src/components/Icon.js');
  const store = makeStore(COLS * ROWS);
  const deps = { Icon, store };
  const root = await createRoot(
    FRAME ? { cocoa: { frameInterval: Number(FRAME) } } : {},
  );
  const app = root.app;
  const cocoa = Boolean(app._native);

  // --- instrumentation: wrap the native bridge, count per current frame
  const stats = {
    flushes: 0,
    flushMs: [],
    damagePx: 0,
    fullFrames: 0,
    uploads: 0,
    uploadMs: 0,
    uploadPx: 0,
    props: 0,
    layersMade: 0,
    presents: 0,
    presentMs: 0,
    surfaces: 0,
    surfaceBytes: 0,
    surfaceMs: 0,
    pumpMs: 0,
    pumps: 0,
    pumpAfterPresentMs: 0,
    pumpsAfterPresent: 0,
    presentedSincePump: 0,
    latency: [],
    presentLatency: [],
    lastFlushEnd: null,
  };
  let inFlight = []; // input stamps waiting for the flush that answers them
  let answered = []; // …and then for the present that shows the answer
  const native = app._native;
  if (cocoa) {
    const wrap = (key, fn) => {
      const orig = native[key]?.bind(native);
      if (!orig) return;
      native[key] = (...a) => fn(orig, ...a);
    };
    const sizeOf = native.surfaceSize.bind(native);
    wrap('surfaceToLayer', (orig, surface, layer) => {
      const t0 = performance.now();
      orig(surface, layer);
      stats.uploadMs += performance.now() - t0;
      stats.uploads += 1;
      const size = sizeOf(surface);
      stats.uploadPx += size.width * size.height;
    });
    wrap('setLayerProps', (orig, layer, props) => {
      stats.props += 1;
      return orig(layer, props);
    });
    wrap('createLayer', (orig, ...a) => {
      stats.layersMade += 1;
      return orig(...a);
    });
    // the IOSurface swapchain's present path: a flip plus a damage-sized
    // catch-up copy — counted into the same columns so the table reads the
    // same either way (uploads = handoffs, kpx = pixels actually moved)
    wrap('copySurfaceRegion', (orig, src, dst, rects) => {
      const t0 = performance.now();
      orig(src, dst, rects);
      stats.uploadMs += performance.now() - t0;
      if (rects && rects.length) {
        for (let i = 0; i + 3 < rects.length; i += 4) {
          stats.uploadPx += rects[i + 2] * rects[i + 3];
        }
      } else {
        const size = sizeOf(src);
        stats.uploadPx += size.width * size.height;
      }
    });
    wrap('setLayerContentsIOSurface', (orig, layer, id) => {
      stats.uploads += 1;
      return orig(layer, id);
    });
    for (const key of ['createSurface', 'createSurfaceIOSurface']) {
      wrap(key, (orig, w, h, ...rest) => {
        const t0 = performance.now();
        const out = orig(w, h, ...rest);
        stats.surfaceMs += performance.now() - t0;
        stats.surfaces += 1;
        stats.surfaceBytes += w * h * 4;
        return out;
      });
    }
    // pump2 ends with [CATransaction flush]. A present whose commit was
    // deferred into an implicit transaction is paid for HERE, on the next
    // tick — so a pump that follows a present costing more than a pump that
    // follows nothing is that deferral, measured.
    wrap('pump2', (orig) => {
      const t0 = performance.now();
      orig();
      const dt = performance.now() - t0;
      stats.pumpMs += dt;
      stats.pumps += 1;
      if (stats.presentedSincePump) {
        stats.pumpAfterPresentMs += dt;
        stats.pumpsAfterPresent += 1;
        stats.presentedSincePump = 0;
      }
    });
  }

  let tick = 0;
  const treeAt = (t) => scenario.tree(t, deps);
  root.render(treeAt(0));
  let node = null;
  for (let i = 0; i < 100 && !node; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    node = app._rootChildren?.[0] ?? null;
  }
  if (!node) throw new Error('the window never mounted');

  const wnd = cocoa ? [...app._windows.values()][0] : null;
  const win = node.window;
  if (AT && wnd) {
    const [x, y] = AT.split(',').map(Number);
    wnd.move(x * wnd.scale, y * wnd.scale);
  }
  {
    const flush = node.flush.bind(node);
    node.flush = (...a) => {
      const willPaint =
        node.needsPaint || node.needsLayout || node._animating?.size > 0;
      if (!willPaint) return flush(...a);
      const t0 = performance.now();
      const out = flush(...a);
      const t1 = performance.now();
      stats.flushes += 1;
      stats.flushMs.push(t1 - t0);
      stats.lastFlushEnd = t1;
      const rects = node._lastDamageRects;
      if (rects) {
        for (const r of rects) stats.damagePx += r.width * r.height;
      } else {
        stats.fullFrames += 1;
        stats.damagePx += (win.width ?? 0) * (win.height ?? 0);
      }
      for (const sent of inFlight) {
        stats.latency.push(t1 - sent);
        answered.push(sent);
      }
      inFlight = [];
      return out;
    };
  }
  if (wnd) {
    const present = wnd.present.bind(wnd);
    wnd.present = (...a) => {
      const dirty = wnd._dirty;
      const t0 = performance.now();
      const out = present(...a);
      if (dirty) {
        const t1 = performance.now();
        stats.presents += 1;
        stats.presentMs += t1 - t0;
        stats.presentedSincePump = 1;
        for (const sent of answered) stats.presentLatency.push(t1 - sent);
        answered = [];
      }
      return out;
    };
  }

  function* walk(n) {
    yield n;
    for (const c of n?.children ?? []) yield* walk(c);
  }
  const extra = {};
  const ctx = {
    get tick() {
      return tick;
    },
    app,
    wnd,
    win,
    node,
    native,
    stats,
    extra,
    store,
    stamp: () => inFlight.push(performance.now()),
    find: (pred) => [...walk(node)].find(pred) ?? null,
    findAll: (pred) => [...walk(node)].filter(pred),
  };

  // settle: a tree of a few thousand nodes mounts over more than one frame,
  // and the first frame of a scenario is not its steady state
  const settled = async (quietMs, maxMs) => {
    const start = performance.now();
    let last = stats.flushes;
    let lastAt = performance.now();
    while (performance.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 25));
      if (stats.flushes !== last) {
        last = stats.flushes;
        lastAt = performance.now();
      } else if (performance.now() - lastAt > quietMs) break;
    }
  };
  await settled(300, 8000);
  if (scenario.setup) {
    scenario.setup(ctx);
    await settled(300, 3000);
  }
  const nodeCount = [...walk(node)].length;

  // steady state is the measurement
  for (const key of Object.keys(stats)) {
    if (Array.isArray(stats[key])) stats[key] = [];
    else if (typeof stats[key] === 'number') stats[key] = 0;
  }
  inFlight = [];
  answered = [];

  const seconds = scenario.seconds ?? SECONDS;
  const cpu0 = process.cpuUsage();
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const timer = setInterval(() => {
    tick += 1;
    if (scenario.drive) scenario.drive(ctx);
    else root.render(treeAt(tick));
  }, TICK_MS);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  clearInterval(timer);
  await new Promise((r) => setTimeout(r, 120));
  const elapsed = (performance.now() - t0) / 1000;
  const cpu = process.cpuUsage(cpu0);
  const rss1 = process.memoryUsage().rss;

  if (SHOTS && wnd) {
    wnd.snapshot(
      `/tmp/bench-${name}-${process.env.REACT_X11_COCOA_PRESENTER ?? 'surface'}.png`,
    );
  }

  const sorted = [...stats.flushMs].sort((a, b) => a - b);
  const lat = [...stats.latency].sort((a, b) => a - b);
  const plat = [...stats.presentLatency].sort((a, b) => a - b);
  const q = (a, p) =>
    a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null;
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const frames = stats.flushes;
  const out = {
    nodes: nodeCount,
    scale: win?.scale ?? 1,
    frames,
    fps: frames / elapsed,
    ticks: tick,
    flushAvg: sorted.length ? sum(sorted) / sorted.length : null,
    flushP95: q(sorted, 0.95),
    flushMax: sorted.at(-1) ?? null,
    damageKpxPerFrame: frames ? stats.damagePx / frames / 1000 : 0,
    fullPct: frames ? (100 * stats.fullFrames) / frames : 0,
    cpuPct: (100 * (cpu.user + cpu.system)) / 1000 / (elapsed * 1000),
    rssMb: (rss1 - rss0) / (1 << 20),
    pumpMsPerSec: stats.pumpMs / elapsed,
    pumpUs: stats.pumps ? (1000 * stats.pumpMs) / stats.pumps : 0,
    pumpAfterPresentUs: stats.pumpsAfterPresent
      ? (1000 * stats.pumpAfterPresentMs) / stats.pumpsAfterPresent
      : 0,
    presents: stats.presents,
    presentMsPerFrame: stats.presents ? stats.presentMs / stats.presents : 0,
    surfaces: stats.surfaces,
    surfaceMb: stats.surfaceBytes / (1 << 20),
    surfaceMs: stats.surfaceMs,
    uploadsPerFrame: frames ? stats.uploads / frames : 0,
    uploadKpxPerFrame: frames ? stats.uploadPx / frames / 1000 : 0,
    uploadMsPerFrame: frames ? stats.uploadMs / frames : 0,
    propsPerFrame: frames ? stats.props / frames : 0,
    layersMade: stats.layersMade,
    latP50: q(lat, 0.5),
    latP95: q(lat, 0.95),
    latMax: lat.at(-1) ?? null,
    latN: lat.length,
    platP50: q(plat, 0.5),
    platP95: q(plat, 0.95),
    platMax: plat.at(-1) ?? null,
    extra,
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
  const seconds = SCENARIOS[name].seconds ?? SECONDS;
  const res = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      ...(PROF
        ? [
            '--cpu-prof',
            `--cpu-prof-dir=${process.env.PROF_DIR ?? '/tmp'}`,
            `--cpu-prof-name=${name}-${env.REACT_X11_COCOA_PRESENTER ?? env.REACT_X11_BACKEND ?? 'cell'}.cpuprofile`,
          ]
        : []),
      new URL(import.meta.url).pathname,
      '--child',
      `--run=${name}`,
      `--seconds=${SECONDS}`,
      `--cells=${CELLS}`,
      `--size=${SIZE}`,
      ...(FRAME ? [`--frame=${FRAME}`] : []),
      ...(AT ? [`--at=${AT}`] : []),
      ...(SHOTS ? ['--shots'] : []),
    ],
    {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: (seconds + 40) * 1000,
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

// ---------------------------------------------------------------------------
// The gate. A rule is a bound on something a frame either does or does not
// do — repaint the whole window, paint more than a share of it for one
// cell, flush twice for one resize tick, paint a window nobody can see —
// which is what regresses when the frame clock or the damage model is
// touched, and what a timing on someone else's machine cannot say.
// ---------------------------------------------------------------------------

const GATE_PATH = new URL('./presenters-gate.json', import.meta.url);

function loadGate() {
  return JSON.parse(readFileSync(GATE_PATH, 'utf8'));
}

/** The verdicts one cell's numbers earn against its rules. */
function judge(name, r, rules) {
  const out = [];
  const windowPx = W * H * r.scale * r.scale;
  const share = (r.damageKpxPerFrame * 1000) / windowPx;
  const x = r.extra ?? {};
  const rule = (ok, what) => out.push({ ok, what });
  if (rules.maxFullPct !== undefined) {
    rule(
      r.fullPct <= rules.maxFullPct,
      `full-window frames ${r.fullPct.toFixed(0)}% (max ${rules.maxFullPct}%)`,
    );
  }
  if (rules.maxDamageShare !== undefined) {
    rule(
      share <= rules.maxDamageShare,
      `repainted ${(100 * share).toFixed(2)}% of the window per frame (max ${(100 * rules.maxDamageShare).toFixed(1)}%)`,
    );
  }
  if (rules.minFrames !== undefined) {
    rule(
      r.frames >= rules.minFrames,
      `${r.frames} frames (min ${rules.minFrames})`,
    );
  }
  if (rules.maxFrames !== undefined) {
    rule(
      r.frames <= rules.maxFrames,
      `${r.frames} frames (max ${rules.maxFrames})`,
    );
  }
  if (rules.minInputs !== undefined) {
    rule(
      r.latN >= rules.minInputs,
      `${r.latN} inputs answered (min ${rules.minInputs})`,
    );
  }
  if (rules.maxUploadsPerFrame !== undefined) {
    rule(
      r.uploadsPerFrame <= rules.maxUploadsPerFrame,
      `${r.uploadsPerFrame.toFixed(2)} uploads per frame (max ${rules.maxUploadsPerFrame})`,
    );
  }
  if (rules.maxFlushesPerResize !== undefined) {
    const per = x.resizes ? x.resizeFlushes / x.resizes : Infinity;
    rule(
      per <= rules.maxFlushesPerResize,
      `${per.toFixed(2)} frames per resize tick (max ${rules.maxFlushesPerResize})`,
    );
  }
  if (rules.maxSettleFlushes !== undefined) {
    rule(
      (x.settleFlushes ?? Infinity) <= rules.maxSettleFlushes,
      `${x.settleFlushes ?? '?'} frames after the last tick (max ${rules.maxSettleFlushes})`,
    );
  }
  if (rules.maxSurfacesPerResize !== undefined) {
    const per = x.resizes ? r.surfaces / x.resizes : Infinity;
    rule(
      per <= rules.maxSurfacesPerResize,
      `${per.toFixed(1)} backing surfaces per resize tick (max ${rules.maxSurfacesPerResize})`,
    );
  }
  return out;
}

const ms = (v) => (v == null ? '    -' : v.toFixed(2).padStart(5));
const n1 = (v) => (v == null ? '    -' : v.toFixed(1).padStart(5));
const n0 = (v) => (v == null ? '   -' : Math.round(v).toString().padStart(4));

if (CHILD) {
  await runChild();
} else {
  const gate = CHECK ? loadGate() : null;
  // the gate judges the default presenter over the scenarios it has rules
  // for; the timing table still prints, for the human reading the log
  const names = ONLY
    ? ONLY.split(',')
    : gate
      ? Object.keys(gate.rules)
      : Object.keys(SCENARIOS);
  const columnNames = COLUMNS
    ? COLUMNS.split(',')
    : gate
      ? ['surface']
      : ['surface', 'layers', ...(WITH_X11 ? ['x11'] : [])];
  const verdicts = [];
  const summary = [];
  const envOf = {
    surface: { REACT_X11_COCOA_PRESENTER: 'surface' },
    layers: { REACT_X11_COCOA_PRESENTER: 'layers' },
    x11: { REACT_X11_BACKEND: 'x11' },
  };
  console.log(
    `presenter bench — ${W}x${H} window, ${SECONDS}s per cell, tick ${TICK_MS}ms, ` +
      `${COLS}x${ROWS} stress cells`,
  );
  for (const name of names) {
    if (!SCENARIOS[name]) {
      console.error(
        `unknown scenario ${name} — ${Object.keys(SCENARIOS).join(', ')}`,
      );
      process.exit(1);
    }
    const scenario = SCENARIOS[name];
    console.log(`\n${name}`);
    console.log(
      '            fps   flush avg/p95/max    damage/frame   cpu   upload/frame          props  input→flush p50/p95/max  →present p50/p95',
    );
    for (const label of columnNames) {
      const env = envOf[label];
      if (!env) {
        console.log(`  ${label.padEnd(9)} unknown column`);
        continue;
      }
      if (
        label === 'x11' &&
        (scenario.cocoaOnly || scenario.input === 'native')
      ) {
        console.log(`  ${label.padEnd(9)} n/a (native input / cocoa only)`);
        continue;
      }
      const r = runCell(name, env);
      if (r.error) {
        console.log(`  ${label.padEnd(9)} FAILED: ${r.error}`);
        if (gate?.rules[name] && label === 'surface') {
          verdicts.push({ name, ok: false, what: `did not run: ${r.error}` });
        }
        continue;
      }
      if (gate?.rules[name] && label === 'surface') {
        for (const v of judge(name, r, gate.rules[name])) {
          verdicts.push({ name, ...v });
        }
      }
      const upload =
        r.uploadsPerFrame > 0
          ? `${r.uploadsPerFrame.toFixed(1)}x ${Math.round(r.uploadKpxPerFrame).toString().padStart(4)}kpx ${ms(r.uploadMsPerFrame)}ms`
          : '        none         ';
      const input =
        r.latN > 0
          ? `${ms(r.latP50)}/${ms(r.latP95)}/${ms(r.latMax)}`
          : '        -          ';
      const present =
        r.platP50 != null ? `${ms(r.platP50)}/${ms(r.platP95)}` : '      -';
      console.log(
        `  ${label.padEnd(9)}${n1(r.fps)}  ${ms(r.flushAvg)}/${ms(r.flushP95)}/${ms(r.flushMax)}ms  ` +
          `${n0(r.damageKpxPerFrame)}kpx ${n0(r.fullPct)}%full  ${n0(r.cpuPct)}%  ${upload}  ` +
          `${r.propsPerFrame.toFixed(1).padStart(5)}  ${input}  ${present}`,
      );
      const notes = [];
      if (r.nodes) notes.push(`${r.nodes} nodes`);
      if (r.frames === 0) notes.push('no frames');
      if (r.presents) notes.push(`${r.presents} presents`);
      if (r.surfaces) {
        notes.push(
          `${r.surfaces} surfaces made (${r.surfaceMb.toFixed(0)}MB, ${(r.surfaceMs / r.surfaces).toFixed(2)}ms each)`,
        );
      }
      if (r.pumpMsPerSec) {
        notes.push(
          `pump ${r.pumpMsPerSec.toFixed(1)}ms/s (${Math.round(r.pumpUs)}us, ${Math.round(r.pumpAfterPresentUs)}us after a present)`,
        );
      }
      if (Math.abs(r.rssMb) >= 8)
        notes.push(`rss ${r.rssMb > 0 ? '+' : ''}${r.rssMb.toFixed(0)}MB`);
      const x = r.extra ?? {};
      if (x.resizes) {
        notes.push(
          `${x.resizes} resizes: ${(x.resizeMs / x.resizes).toFixed(1)}ms avg, ${x.resizeMax.toFixed(1)}ms max, ` +
            `${(x.resizeFlushes / x.resizes).toFixed(1)} flushes each; settle ${Math.round(x.settleMs ?? 0)}ms / ${x.settleFlushes ?? 0} frames`,
        );
      }
      if (notes.length) console.log(`            ${notes.join(' · ')}`);
      summary.push(
        `| ${name} | ${label} | ${n1(r.fps).trim()} | ${ms(r.flushAvg).trim()} / ${ms(r.flushP95).trim()} / ${ms(r.flushMax).trim()} | ` +
          `${Math.round(r.damageKpxPerFrame)}kpx, ${Math.round(r.fullPct)}% full | ${Math.round(r.cpuPct)}% | ` +
          `${r.latN > 0 ? `${ms(r.latP50).trim()} / ${ms(r.latP95).trim()}` : '-'} |`,
      );
    }
  }
  if (gate) {
    console.log('\ngate');
    for (const v of verdicts) {
      console.log(`  ${v.ok ? 'ok  ' : 'FAIL'} ${v.name.padEnd(9)} ${v.what}`);
    }
    const failed = verdicts.filter((v) => !v.ok);
    console.log(
      failed.length
        ? `\n${failed.length} rule${failed.length === 1 ? '' : 's'} failed — scripts/bench/presenters-gate.json says what each one keeps`
        : `\nall ${verdicts.length} rules hold`,
    );
    // the table, where the run's page can show it
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## presenter bench — ${W}x${H}, ${SECONDS}s per cell\n\n` +
          '| scenario | presenter | fps | flush avg / p95 / max ms | damage per frame | cpu | input→flush p50 / p95 ms |\n' +
          '| --- | --- | --- | --- | --- | --- | --- |\n' +
          summary.join('\n') +
          '\n\n' +
          verdicts
            .map((v) => `- ${v.ok ? '✅' : '❌'} \`${v.name}\` ${v.what}`)
            .join('\n') +
          '\n',
      );
    }
    process.exit(failed.length ? 1 : 0);
  }
  console.log(
    '\nnotes: damage = the repainted area per painting frame and the share of' +
      '\nfull-window frames; cpu = process CPU as % of one core; upload = CA' +
      '\nhandoffs (surfaceToLayer, swapchain flips + catch-up copies); props =' +
      '\nsetLayerProps per frame; input = event sent → end of the flush that' +
      '\nanswered it, and → end of the present that showed it, through the' +
      '\npump. Compare within this run only.',
  );
}
