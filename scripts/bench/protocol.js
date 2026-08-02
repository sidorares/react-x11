// Protocol-traffic benchmark: how much X11 work does each scenario cost?
//
//   npm run bench            # print the current numbers
//   npm run bench -- --save  # rewrite the committed baseline
//   npm run bench -- --check # fail if a metric regressed past its tolerance
//
// Runs against node-x11's in-process pure-JS X server, so the numbers are
// deterministic and need no $DISPLAY.
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
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { compositePixels, countStream } from './xcount.js';

process.env.REACT_X11_NO_AUTORUN = '1';
const { createRoot } = await import('../../src/index.js');

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
  const { stats } = countStream(clientEnd);
  const source = new StaticFontSource();
  source.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Bench',
  });
  source.alias('sans-serif', 'Bench');
  const app = await createClient({ stream: clientEnd, fontSource: source });
  return { app, stats };
}

const settle = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

/** Run `fn`, measuring only what it causes (setup is drained first). A
 * scenario may be `{ prepare, run }`: `prepare` builds state — a mounted
 * tree, say — whose cost is drained and *not* measured, so `run` can time
 * an interaction rather than a mount. */
async function measure(name, fn) {
  const { app, stats } = await connect();
  const x11Root = await createRoot({ app });
  await settle(app);
  if (typeof fn !== 'function') {
    await fn.prepare(app, x11Root);
    await settle(app);
    fn = fn.run;
  }
  const mark = {
    requests: stats.requests,
    bytesOut: stats.bytesOut,
    bytesIn: stats.bytesIn,
    replies: stats.replies,
    composites: stats.composites.length,
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
    await fn(app, x11Root);
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
  const result = {
    requests: stats.requests - mark.requests,
    bytesOut: stats.bytesOut - mark.bytesOut,
    bytesIn: stats.bytesIn - mark.bytesIn,
    replies: stats.replies - mark.replies,
    composites: after.composites - beforePx.composites,
    compositePixels: after.pixels - beforePx.pixels,
  };
  await app.close();
  return [name, result];
}

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
    // window clips to the damaged region, a <scrollview> clips to its
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
                  'scrollview',
                  { style: { flexGrow: 1 } },
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
          // pace frames on the fence alone — deterministic under test, no
          // 16ms wall-clock timer between the event and any (wrong) repaint
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
];

// --- run ---------------------------------------------------------------

const results = {};
for (const [name, fn] of SCENARIOS) {
  const [key, value] = await measure(name, fn);
  results[key] = value;
}

const args = process.argv.slice(2);
if (args.includes('--save')) {
  writeFileSync(baselinePath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`wrote ${baselinePath}`);
}

const pad = (v, n) => String(v).padStart(n);
console.log(
  `${'scenario'.padEnd(38)} ${pad('reqs', 6)} ${pad('bytesOut', 9)} ${pad('replies', 8)} ${pad('composites', 11)} ${pad('Mpx', 8)}`,
);
for (const [name, r] of Object.entries(results)) {
  console.log(
    `${name.padEnd(38)} ${pad(r.requests, 6)} ${pad(r.bytesOut, 9)} ${pad(r.replies, 8)} ${pad(r.composites, 11)} ${pad((r.compositePixels / 1e6).toFixed(2), 8)}`,
  );
}

if (args.includes('--check')) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    console.error('\nno baseline — run `npm run bench -- --save` first');
    process.exit(1);
  }
  // generous, so this catches step changes rather than noise
  const TOLERANCE = 1.15;
  const regressions = [];
  for (const [name, now] of Object.entries(results)) {
    const was = baseline[name];
    if (!was) continue;
    for (const metric of [
      'requests',
      'bytesOut',
      'composites',
      'compositePixels',
    ]) {
      const limit = was[metric] * TOLERANCE + 2;
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
