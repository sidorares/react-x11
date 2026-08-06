// ntk's rounded-rect fast path (ntk >= 6.7.0, issue #219), seen from
// react-x11: a box's background and border go out as cached corner glyphs
// plus FillRectangles instead of polygon rasterization.
//
// react-x11 does not implement the route — ntk recognizes `roundRect()` +
// `fill()`/`stroke()` below the drawing API, and `_paintBackground` /
// `_paintBorder` already draw exactly that. What is this repo's to hold is
// the other half of ntk#211's validation:
//
//   * the boxes react-x11 actually paints take the route (a bail-out is a
//     silent perf cliff, so "it still renders" is not enough);
//   * they render identically either way, so a box that bails sits
//     pixel-identical next to one that did not;
//   * the tracer reports both, because that is how anyone finds a cliff.
//
// Against node-x11's in-process X server, which implements Render
// compositing for real, so parity is a pixel assertion.
import { test } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { createRoot } from '../src/index.js';
import { startTrace } from '../src/debug.js';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

const W = 240;
const H = 180;

async function headlessApp({ shapePolicy } = {}) {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  // ntk's documented off switch, and the A/B this file is built on
  if (shapePolicy) app.shapePolicy = shapePolicy;
  return app;
}

const settle = (app) =>
  new Promise((resolve, reject) =>
    app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
  );

async function mount(app, element) {
  const x11Root = await createRoot({ app });
  const instance = await new Promise((resolve) =>
    x11Root.render(element, resolve),
  );
  const root = instance._reactX11Node;
  root._scheduled = false;
  root.flush();
  await settle(app);
  return root;
}

/** The whole window as raw RGBA, for an exact comparison. */
async function image(root) {
  const ctx = root._ctx;
  const data = await new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, d) => (err ? reject(err) : resolve(d))),
  );
  return Buffer.from(data.data);
}

const e = React.createElement;

// One box, at a fixed integer position, so a parity failure can be located
// against known geometry rather than just counted.
const BOX = { x: 20, y: 20, w: 100, h: 46 };

function single(style) {
  return e(
    'window',
    { width: W, height: H, style: { backgroundColor: '#e9edf2' } },
    e('box', {
      style: {
        position: 'absolute',
        left: BOX.x,
        top: BOX.y,
        width: BOX.w,
        height: BOX.h,
        ...style,
      },
    }),
  );
}

/** One box per style, at integer positions so geometry is never the reason
 * a draw bails. */
function wall(boxes) {
  return e(
    'window',
    { width: W, height: H, style: { backgroundColor: '#e9edf2' } },
    ...boxes.map((style, i) =>
      e('box', {
        key: i,
        style: {
          position: 'absolute',
          left: 10 + (i % 2) * 120,
          top: 10 + Math.floor(i / 2) * 56,
          width: 100,
          height: 46,
          ...style,
        },
      }),
    ),
  );
}

/**
 * Compare two shots of the same box: how many pixels differ, by how much,
 * and — the assertion that carries the weight — how many differ anywhere
 * other than the four corner boxes a glyph owns.
 *
 * The corner box is `ceil(r + bw/2)` on a side, the integer cut ntk makes
 * between the glyphs and the `FillRectangles` between them. A difference
 * outside it means the two routes disagree about a straight run: a seam, a
 * gap, or a pixel painted twice.
 */
function compare(fast, slow, { borderRadius = 0, borderWidth = 0 }) {
  const K = borderRadius ? Math.ceil(borderRadius + borderWidth / 2) : 0;
  const bw = borderWidth;
  const corners = [
    [BOX.x - bw, BOX.y - bw],
    [BOX.x + BOX.w - K, BOX.y - bw],
    [BOX.x - bw, BOX.y + BOX.h - K],
    [BOX.x + BOX.w - K, BOX.y + BOX.h - K],
  ];
  let differing = 0;
  let worst = 0;
  let outside = 0;
  for (let i = 0; i < fast.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c += 1) {
      d = Math.max(d, Math.abs(fast[i + c] - slow[i + c]));
    }
    if (!d) continue;
    differing += 1;
    worst = Math.max(worst, d);
    const p = i / 4;
    const px = p % W;
    const py = Math.floor(p / W);
    const inCorner = corners.some(
      ([cx, cy]) =>
        px >= cx && px < cx + K + bw && py >= cy && py < cy + K + bw,
    );
    if (!inCorner) outside += 1;
  }
  return { differing, worst, outside };
}

// Radii, border widths, opaque and translucent colours — the matrix
// ntk#211 asks for, restricted to what react-x11 itself can express.
const MATRIX = [
  { backgroundColor: '#ffffff', borderRadius: 8 },
  { backgroundColor: '#3498db', borderRadius: 0 },
  {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#c0392b',
  },
  {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#c0392b',
  },
  {
    backgroundColor: '#ffffff',
    borderRadius: 23,
    borderWidth: 4,
    borderColor: '#27ae60',
  },
  { backgroundColor: 'rgba(52, 152, 219, 0.45)', borderRadius: 12 },
  {
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    borderRadius: 10,
    borderWidth: 2,
    borderColor: 'rgba(192, 57, 43, 0.5)',
  },
  {
    backgroundColor: '#ffffff',
    borderRadius: 6,
    borderWidth: 3,
    borderColor: '#8e44ad',
  },
];

// The straight runs are where the two routes must agree exactly. That is
// the claim the decomposition rests on — corner glyphs own their integer-cut
// boxes, `FillRectangles` own the strips between, no pixel is painted twice
// — and it is what makes translucent colours safe with no mask format. A
// difference outside a corner box is a seam, a gap or a double-paint.
//
// Inside the corner boxes the two routes rasterize the same arc by
// different means (a quarter-ring glyph against an extruded, flattened
// polygon), so they differ by antialiasing. Measured on ntk 6.7.0 against
// node-x11's server: fills stay within 4/255, stroked corners reach 48/255.
// The bounds below are those measurements plus headroom — tight enough that
// a geometry regression trips them, loose enough not to fail on a
// flattener change.
const PARITY = [
  { style: { backgroundColor: '#ffffff', borderRadius: 8 }, arc: 8 },
  { style: { backgroundColor: '#3498db', borderRadius: 23 }, arc: 8 },
  {
    style: { backgroundColor: 'rgba(52, 152, 219, 0.45)', borderRadius: 12 },
    arc: 8,
  },
  {
    style: {
      backgroundColor: '#ffffff',
      borderRadius: 8,
      borderWidth: 2,
      borderColor: '#c0392b',
    },
    arc: 64,
  },
  {
    style: {
      backgroundColor: '#ffffff',
      borderRadius: 23,
      borderWidth: 4,
      borderColor: '#27ae60',
    },
    arc: 64,
  },
  {
    style: {
      backgroundColor: 'rgba(255, 255, 255, 0.6)',
      borderRadius: 10,
      borderWidth: 2,
      borderColor: 'rgba(192, 57, 43, 0.5)',
    },
    arc: 64,
  },
  {
    style: {
      backgroundColor: '#ffffff',
      borderRadius: 0,
      borderWidth: 2,
      borderColor: '#c0392b',
    },
    arc: 0,
  },
];

for (const { style, arc } of PARITY) {
  const name =
    `r${style.borderRadius}` +
    (style.borderWidth ? ` bw${style.borderWidth}` : '') +
    (String(style.backgroundColor).startsWith('rgba') ? ' translucent' : '');

  test(`${name}: the straight runs are pixel-exact either way`, async () => {
    const fast = await headlessApp();
    const slow = await headlessApp({ shapePolicy: { maxRadius: 0 } });

    const onGlyphs = await image(await mount(fast, single(style)));
    const onPolygons = await image(await mount(slow, single(style)));
    const { differing, worst, outside } = compare(onGlyphs, onPolygons, style);

    assert.equal(
      outside,
      0,
      `${outside} pixels differ outside the corner boxes — the glyphs and ` +
        'the rects between them do not partition the box',
    );
    assert.ok(
      worst <= arc,
      `corner antialiasing drifted to ${worst}/255 (bound ${arc}), ` +
        `${differing} pixels differing`,
    );
  });
}

test('the boxes react-x11 paints take the fast path', async () => {
  const app = await headlessApp();
  const root = await mount(app, wall(MATRIX));
  const stats = root._ctx.shapeStats;

  assert.ok(stats.hits > 0, 'expected fast-path draws, got none');
  // every background fill in the matrix is integer geometry under the cap
  assert.equal(
    stats.misses.gradient ?? 0,
    0,
    'a solid backgroundColor must not read as a gradient',
  );
  assert.equal(
    stats.misses['clip-mask'] ?? 0,
    0,
    'a plain box must not need a mask clip',
  );
});

test('maxRadius: 0 turns the route off without changing what is drawn', async () => {
  const app = await headlessApp({ shapePolicy: { maxRadius: 0 } });
  const root = await mount(app, wall(MATRIX));
  const stats = root._ctx.shapeStats;

  assert.equal(stats.hits, 0, 'nothing should take the route when it is off');
  assert.ok(
    (stats.misses['radius-cap'] ?? 0) > 0,
    'the off switch should report itself as radius-cap misses',
  );
});

// The cliff this repo found on ntk 6.7.0, pinned so it cannot regress
// silently — and so that relaxing it upstream fails here loudly rather than
// passing unnoticed. `_paintBorder` strokes the box inset by half the
// border width, which is right; the centre-line radius that follows from it
// is `borderRadius - borderWidth/2`, half-integer whenever the border width
// is odd, and ntk's stroke path requires an integer radius even though the
// band it covers, `r ± bw/2`, lands on whole pixels either way.
// See docs/debugging.md.
test('an odd border width keeps the stroke on the polygon route', async () => {
  const app = await headlessApp();
  const odd = await mount(
    app,
    wall([
      {
        backgroundColor: '#ffffff',
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#c0392b',
      },
    ]),
  );
  const oddStats = { ...odd._ctx.shapeStats.misses };

  const even = await headlessApp();
  const evenRoot = await mount(
    even,
    wall([
      {
        backgroundColor: '#ffffff',
        borderRadius: 8,
        borderWidth: 2,
        borderColor: '#c0392b',
      },
    ]),
  );

  assert.equal(
    oddStats.fractional ?? 0,
    1,
    'a 1px rounded border still bails as fractional',
  );
  assert.equal(
    evenRoot._ctx.shapeStats.misses.fractional ?? 0,
    0,
    'a 2px rounded border does not',
  );
});

test('the tracer reports fast-path draws and bail-outs', async () => {
  const app = await headlessApp();
  const path = join(tmpdir(), `react-x11-shapes-${process.pid}.json`);
  const trace = startTrace({ app, sink: 'chrome', path });
  await mount(app, wall(MATRIX));
  const stats = trace.stop();
  rmSync(path, { force: true });

  assert.ok(stats.shapes.hits > 0, 'summary should count fast-path draws');
  assert.equal(
    typeof stats.shapes.misses,
    'object',
    'and carry the reasons any bail-out gave',
  );
});
