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
const ReactX11 = (await import('../../src/index.js')).default;

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

/** Run `fn`, measuring only what it causes (setup is drained first). */
async function measure(name, fn) {
  const { app, stats } = await connect();
  await settle(app);
  const mark = {
    requests: stats.requests,
    bytesOut: stats.bytesOut,
    bytesIn: stats.bytesIn,
    replies: stats.replies,
    composites: stats.composites.length,
  };
  await fn(app);
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

const SCENARIOS = [
  [
    'text: paragraph, no clip',
    async (app) => {
      const ctx = pixmapCtx(app);
      paragraphLayout(app).draw(ctx, 5, 5);
    },
  ],
  [
    'text: paragraph, inside a rect clip',
    async (app) => {
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
    'shapes: 50 filled rounded boxes',
    async (app) => {
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
    async (app) => {
      await new Promise((resolve) =>
        ReactX11.render(
          React.createElement(
            'window',
            { width: W, height: H, backgroundColor: '#f5f6fa' },
            React.createElement(
              'box',
              { flexGrow: 1, padding: 8, gap: 2 },
              Array.from({ length: 40 }, (_, i) =>
                React.createElement(
                  'box',
                  {
                    key: i,
                    flexDirection: 'row',
                    gap: 6,
                    padding: 2,
                    backgroundColor: i % 2 ? '#ffffff' : '#eef1f5',
                  },
                  React.createElement('text', { fontSize: 11 }, `row ${i}`),
                ),
              ),
            ),
          ),
          resolve,
          app,
        ),
      );
      await new Promise((r) => setImmediate(r));
    },
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
