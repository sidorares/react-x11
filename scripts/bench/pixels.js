// Pixel-identity gate: did the picture change?
//
//   npm run bench:pixels            # print the hashes
//   npm run bench:pixels -- --save  # rewrite the committed baseline
//   npm run bench:pixels -- --check # fail if any scenario's pixels moved
//
// The protocol bench answers "how much work did that cost". This answers the
// question that makes an answer to the first one *safe*: a protocol change is
// only an optimization if the surface it produces is the same surface. Every
// finding in the audit that motivated this lane was argued pixel-identical on
// paper — that argument deserves a machine that checks it.
//
// So each scenario mounts a tree into a real window on node-x11's in-process
// server, settles, reads the window back through its 2d context, and hashes
// the bytes. `getImageData` is the canvas contract — straight, unpremultiplied
// RGBA off the backing pixmap, so the read is valid under occlusion and needs
// no channel swapping (scripts/capture.js says more about why that sentence
// has to be written down).
//
// A hash is a blunt instrument on purpose: it cannot say *what* moved, only
// that something did. When it fails, render the scenario and look — and if
// the change is intended (a rasterizer bump in ntk shifts antialiased edges
// everywhere, legitimately), re-save the baseline in the same commit that
// explains it. What must not happen is a baseline re-saved silently in a
// commit whose message says "no visual change".
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { captureWindow } from '../capture.js';

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
  'pixels-baseline.json',
);

const W = 400;
const H = 400;
const h = React.createElement;

async function connect() {
  const server = xserver.createServer({ width: W, height: H });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const source = new StaticFontSource();
  // the same pinned face the protocol bench uses, so neither lane depends on
  // what fontconfig happens to find on the machine running it
  source.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Bench',
  });
  source.alias('sans-serif', 'Bench');
  return createClient({ stream: clientEnd, fontSource: source });
}

const window_ = (...children) =>
  h(
    'window',
    { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
    ...children,
  );

/**
 * Scenarios chosen to cover the drawing vocabulary the audit's findings
 * touch, not to be exhaustive: a rectangular clip and a solid fill (the
 * `_fillRect` mask path), rounded fills and borders (the corner-glyph fast
 * path and its clip bracket), text (glyph runs and the shared glyph cache),
 * translucency and gradients (the non-trivial composite ops), and a partial
 * repaint (the damage path, whose whole contract is that it leaves the
 * surface a full repaint would have left).
 */
const SCENARIOS = [
  [
    'solid fills under a clip',
    () =>
      window_(
        h('box', {
          style: {
            position: 'absolute',
            left: 20,
            top: 20,
            width: 160,
            height: 90,
            backgroundColor: '#2980b9',
          },
        }),
        h('box', {
          style: {
            position: 'absolute',
            left: 60,
            top: 70,
            width: 200,
            height: 120,
            backgroundColor: '#e74c3c',
          },
        }),
      ),
  ],
  [
    'rounded boxes and borders',
    () =>
      window_(
        h(
          'box',
          {
            style: {
              flexGrow: 1,
              padding: 12,
              gap: 10,
              flexDirection: 'row',
              flexWrap: 'wrap',
            },
          },
          ...Array.from({ length: 12 }, (_, i) =>
            h('box', {
              key: i,
              style: {
                width: 80,
                height: 44,
                borderRadius: 2 + i,
                borderWidth: (i % 3) + 1,
                borderColor: '#2d3436',
                backgroundColor: i % 2 ? '#ffffff' : '#dfe6e9',
              },
            }),
          ),
        ),
      ),
  ],
  [
    'text runs',
    () =>
      window_(
        h(
          'box',
          { style: { flexGrow: 1, padding: 10, gap: 4 } },
          ...Array.from({ length: 10 }, (_, i) =>
            h(
              'text',
              { key: i, style: { fontSize: 11 + (i % 4), color: '#2d3436' } },
              `Line ${i}: the quick brown fox jumps over the lazy dog`,
            ),
          ),
        ),
      ),
  ],
  [
    'gradient and shadow',
    () =>
      window_(
        h(
          'box',
          {
            style: {
              flexGrow: 1,
              padding: 14,
              gap: 12,
              flexDirection: 'row',
              flexWrap: 'wrap',
            },
          },
          ...Array.from({ length: 6 }, (_, i) =>
            h('box', {
              key: i,
              style: {
                width: 100,
                height: 60,
                borderRadius: 6,
                backgroundImage:
                  'linear-gradient(160deg, #2b5876 20%, #4e4376)',
                boxShadow: '0 2px 6px rgba(0, 0, 0, .45)',
              },
            }),
          ),
        ),
      ),
  ],
];

/**
 * The damage path's own contract — checked *within a run*, not against the
 * committed baseline.
 *
 * The first version of this hashed the partial repaint like any other
 * scenario, and it was the one scenario whose hash differed between macOS and
 * Linux while the other four matched byte for byte. The difference is not the
 * rasterizer: it is that this scenario is the only one whose result depends on
 * *when* the capture happens relative to asynchronous work (a glyph handoff
 * behind the label, a paint the damage path has not flushed yet). Pinning a
 * timing-sensitive image in a committed file makes the file wrong on some
 * machine somewhere.
 *
 * What is worth checking here is not the picture but the invariant: a partial
 * repaint must leave the surface exactly as a full repaint of the same tree
 * would. Both halves are painted in the same process, moments apart, so the
 * comparison is immune to anything that shifts both equally — which is exactly
 * what a platform difference does.
 */
async function partialRepaint(app, x11Root) {
  const tree = (color) =>
    window_(
      h('box', {
        style: {
          position: 'absolute',
          left: 40,
          top: 40,
          width: 120,
          height: 70,
          borderRadius: 8,
          borderWidth: 2,
          borderColor: '#2d3436',
          backgroundColor: color,
        },
      }),
      h(
        'text',
        { style: { position: 'absolute', left: 40, top: 140, fontSize: 13 } },
        'unchanged label',
      ),
    );
  const instance = await new Promise((resolve) =>
    x11Root.render(tree('#3498db'), resolve),
  );
  const root = instance._reactX11Node;
  root._scheduled = false;
  root.flush();
  await settle(app);
  await new Promise((resolve) =>
    x11Root.render(tree('#e74c3c'), () => resolve()),
  );
  root._scheduled = false;
  root.flush();
  await settle(app);
  const partial = await captureWindow(root.window);

  // The same tree again with the damage discarded: everything repaints.
  root.needsPaint = true;
  root._damage = null;
  root.flush();
  await settle(app);
  const full = await captureWindow(root.window);

  let differing = 0;
  for (let i = 0; i < full.data.length; i += 4) {
    if (
      partial.data[i] !== full.data[i] ||
      partial.data[i + 1] !== full.data[i + 1] ||
      partial.data[i + 2] !== full.data[i + 2] ||
      partial.data[i + 3] !== full.data[i + 3]
    ) {
      differing += 1;
    }
  }
  return differing;
}

const settle = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

async function hashOf(name, build) {
  const app = await connect();
  const x11Root = await createRoot({ app });
  let root;
  if (typeof build === 'function' && build.length === 2) {
    root = await build(app, x11Root);
  } else {
    const instance = await new Promise((resolve) =>
      x11Root.render(build(), resolve),
    );
    root = instance._reactX11Node;
    root._scheduled = false;
    root.flush();
    await settle(app);
  }
  const shot = await captureWindow(root.window);
  const digest = createHash('sha256')
    .update(`${shot.width}x${shot.height}:`)
    .update(
      Buffer.from(shot.data.buffer, shot.data.byteOffset, shot.data.length),
    )
    .digest('hex')
    .slice(0, 16);
  await app.close();
  return [name, digest];
}

const results = {};
for (const [name, build] of SCENARIOS) {
  process.stderr.write(`· ${name}\n`);
  const [key, digest] = await hashOf(name, build);
  results[key] = digest;
}

// Not hashed, and not in the baseline: an invariant checked inside this run.
process.stderr.write('· partial repaint vs full\n');
const damageApp = await connect();
const damageRoot = await createRoot({ app: damageApp });
const differingPixels = await partialRepaint(damageApp, damageRoot);
await damageApp.close();

const args = process.argv.slice(2);
if (args.includes('--save')) {
  writeFileSync(baselinePath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`wrote ${baselinePath}`);
}

for (const [name, digest] of Object.entries(results)) {
  console.log(`${name.padEnd(30)} ${digest}`);
}
console.log(
  `${'partial repaint vs full'.padEnd(30)} ${
    differingPixels === 0 ? 'identical' : `${differingPixels} pixels differ`
  }`,
);

if (args.includes('--check')) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    console.error(
      '\nno pixel baseline — run `npm run bench:pixels -- --save` first',
    );
    process.exit(1);
  }
  const moved = [];
  for (const [name, digest] of Object.entries(results)) {
    if (baseline[name] === undefined) {
      moved.push(`${name} — new scenario, not in the baseline`);
    } else if (baseline[name] !== digest) {
      moved.push(`${name} — ${baseline[name]} -> ${digest}`);
    }
  }
  for (const name of Object.keys(baseline)) {
    if (results[name] === undefined) moved.push(`${name} — gone from this run`);
  }
  if (moved.length) {
    console.error('\nthe picture changed:');
    for (const line of moved) console.error(`  ${line}`);
    console.error(
      '\nIf that was the point, re-save the baseline in the commit that ' +
        'explains why. If it was not, this is the regression.',
    );
    process.exit(1);
  }
  if (differingPixels !== 0) {
    console.error(
      `\na partial repaint left ${differingPixels} pixels a full repaint ` +
        'would not have — the damage path dropped something visible',
    );
    process.exit(1);
  }
  console.log('\npixels unchanged');
}

process.exit(0);
