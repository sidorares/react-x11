// A box that clips its children to a rounded outline — `overflow` with a
// `borderRadius` — clips them to its rectangle and puts its corners back
// (issue #685, src/nodes/roundclip.js).
//
// The outline used to be the clip itself, and a clip that is not a rectangle
// is one ntk builds as a window-sized a8 mask: every fill and glyph run under
// it left the fast paths for composites through the mask, to decide a few
// pixels in each corner. What is held here:
//
//   * the corners come out as the clip drew them — exactly, everywhere but
//     the ring of pixels the arc shades partly, where the children are now
//     clipped as one layer rather than drawing by drawing;
//   * a pass over any part of the box leaves exactly what a full repaint
//     does, the damage model's own invariant;
//   * the drawing under the outline keeps the fast paths — no rounded card
//     falls off ntk's shape route for a mask, and no mask is built;
//   * only the corners a child reaches are kept, so a padded box pays
//     nothing for its radius;
//   * where the corners cannot be kept that way, the outline is still the
//     clip.
//
// Against node-x11's in-process X server, which composites for real.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import { roundedCorners } from '../src/nodes/rects.js';
import {
  analysisMark,
  countStream,
  windowAnalysis,
} from '../scripts/bench/xcount.js';
import { createMockApp } from './helpers/mock-app.js';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

const W = 240;
const H = 200;
const e = React.createElement;

async function headlessApp() {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const { stats } = countStream(clientEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');
  const app = await createClient({ stream: clientEnd, fontSource });
  return { app, stats };
}

const settled = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

async function mount(element) {
  const { app, stats } = await headlessApp();
  const x11Root = await createRoot({ app });
  const instance = await new Promise((resolve) =>
    x11Root.render(element, resolve),
  );
  const root = instance._reactX11Node;
  const frame = async () => {
    root._scheduled = false;
    root.flush();
    await settled(app);
  };
  await frame();
  return { app, stats, root, frame };
}

async function repaintAll(ctl) {
  ctl.root.invalidate(true, null, 'expose');
  await ctl.frame();
}

async function pixels(root) {
  const data = await new Promise((resolve, reject) =>
    root._ctx.getImageData(0, 0, W, H, (err, d) =>
      err ? reject(err) : resolve(d),
    ),
  );
  return Buffer.from(data.data);
}

/** Every context on the connection unable to read its pixels back — the
 *  one thing keeping corners needs — for the length of `fn`: the outline is
 *  then the clip, as it always was, and what this renders is the answer the
 *  kept corners have to match. */
async function withOutlineClip(root, fn) {
  const proto = Object.getPrototypeOf(root._ctx);
  const own = Object.getOwnPropertyDescriptor(proto, 'picture');
  Object.defineProperty(proto, 'picture', {
    configurable: true,
    get: () => null,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(proto, 'picture', own);
  }
}

// --- the box -------------------------------------------------------------

const PANE = { x: 20, y: 20, width: 200, height: 150 };

function pane(radius, children, style = {}) {
  return e(
    'window',
    { width: W, height: H, style: { backgroundColor: '#dfe4ea' } },
    e(
      'box',
      {
        style: {
          position: 'absolute',
          left: PANE.x,
          top: PANE.y,
          width: PANE.width,
          height: PANE.height,
          overflow: 'hidden',
          borderRadius: radius,
          backgroundColor: '#ffffff',
          ...style,
        },
      },
      ...children,
    ),
  );
}

const fill = (key, style) =>
  e('box', { key, style: { position: 'absolute', ...style } });

// Everything a corner can hold: opaque rows flush with every edge, a
// translucent layer over them all, a box poking in from outside, and text
// across the top-left corner.
const layered = () => [
  ...Array.from({ length: 8 }, (_, i) =>
    fill(`row${i}`, {
      left: 0,
      right: 0,
      top: i * 20 - 5,
      height: 20,
      backgroundColor: i % 2 ? '#2d3436' : '#74b9ff',
    }),
  ),
  fill('veil', {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(231, 76, 60, 0.35)',
  }),
  fill('poke', {
    left: -8,
    top: 118,
    width: 40,
    height: 40,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  }),
  e(
    'text',
    { key: 'label', style: { position: 'absolute', left: 0, top: 0 } },
    'Corner',
  ),
];

// One opaque layer over each corner. A clip and a kept corner shade it by
// the same arc, rasterized twice — the clip's over the whole outline, the
// kept corner's over its square — and the two agree to a few levels: the
// clip's is a little lopsided, 224/203/185 along the top edge where it is
// 221/205/187 down the left one, and the kept corner's is not.
const opaque = () => [
  fill('under', {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0984e3',
  }),
];

// a rounded box inside the rounded box, flush with its corner
const nested = () => [
  e(
    'box',
    {
      key: 'inner',
      style: {
        position: 'absolute',
        left: 0,
        top: 0,
        width: 120,
        height: 90,
        overflow: 'hidden',
        borderRadius: 16,
        backgroundColor: '#fdcb6e',
      },
    },
    ...layered(),
  ),
  ...layered().slice(4),
];

const SCENES = [
  { name: 'layers, r4', tree: () => pane(4, layered()) },
  { name: 'layers, r6.5', tree: () => pane(6.5, layered()) },
  { name: 'layers, r23', tree: () => pane(23, layered()) },
  { name: 'opaque, r12', tree: () => pane(12, opaque()), ring: 8 },
  { name: 'nested, r10', tree: () => pane(10, nested()) },
  // faded: the box is drawn into a surface of its own, translated, and its
  // corners are kept on that surface
  {
    name: 'faded, r12',
    tree: () => pane(12, layered(), { opacity: 0.85 }),
  },
  // corner all the way along a side — the squares meet in the middle
  { name: 'pill-sided, r75', tree: () => pane(75, layered()) },
];

/** How far the pixel at (px, py) is from the arc of the corner of `box` it
 *  is in, or Infinity outside every corner square — the pixels a rounded
 *  outline shades in part are the ones within a pixel or so of its arc. */
function arcDistance(px, py, box, radius) {
  const r = Math.min(radius, box.width / 2, box.height / 2);
  const s = Math.ceil(r);
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const cx = px < box.x + s ? box.x + r : px >= right - s ? right - r : null;
  const cy = py < box.y + s ? box.y + r : py >= bottom - s ? bottom - r : null;
  if (cx === null || cy === null || px < box.x || py < box.y) return Infinity;
  if (px >= right || py >= bottom) return Infinity;
  return Math.abs(Math.hypot(px + 0.5 - cx, py + 0.5 - cy) - r);
}

/** Compare two readbacks: the worst difference on the rings of the rounded
 *  boxes in `outlines`, and every pixel off them that differs at all. */
function compareOutline(a, b, outlines) {
  let ring = 0;
  const off = [];
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
    if (!d) continue;
    const px = (i / 4) % W;
    const py = Math.floor(i / 4 / W);
    const near = outlines.some(
      ({ box, radius }) => arcDistance(px, py, box, radius) <= 1.5,
    );
    if (near) ring = Math.max(ring, d);
    else off.push(`${px},${py}:${d}`);
  }
  return { ring, off };
}

/** Every rounded box that clips its children, with its radius. */
function outlinesOf(node, out = []) {
  if (node.clipsChildren?.() && node.style?.borderRadius > 0) {
    out.push({ box: node.abs, radius: node.style.borderRadius });
  }
  for (const child of node.children ?? []) outlinesOf(child, out);
  return out;
}

for (const scene of SCENES) {
  test(`${scene.name}: the corners come out as the outline's clip drew them`, async () => {
    const ctl = await mount(scene.tree());
    const kept = await pixels(ctl.root);
    const clipped = await withOutlineClip(ctl.root, async () => {
      await repaintAll(ctl);
      return pixels(ctl.root);
    });
    const { ring, off } = compareOutline(kept, clipped, outlinesOf(ctl.root));
    assert.deepEqual(
      off,
      [],
      'pixels away from the arc must be exactly what the clip drew',
    );
    // On the ring the clip shaded every drawing by the arc's coverage, and
    // a kept corner shades what they drew together once: the same where one
    // layer covers the pixel, and apart by what a covered layer leaked
    // through the old way where several do.
    assert.ok(
      ring <= (scene.ring ?? 64),
      `the arc's antialiasing moved by ${ring}/255`,
    );
    await ctl.app.close();
  });

  test(`${scene.name}: a pass over any part of the box leaves what a full repaint does`, async () => {
    const ctl = await mount(scene.tree());
    const full = await pixels(ctl.root);
    const passes = [
      // each corner, alone
      { x: PANE.x - 3, y: PANE.y - 3, width: 40, height: 30 },
      { x: PANE.x + PANE.width - 37, y: PANE.y - 3, width: 40, height: 30 },
      {
        x: PANE.x + PANE.width - 37,
        y: PANE.y + PANE.height - 27,
        width: 40,
        height: 30,
      },
      { x: PANE.x - 3, y: PANE.y + PANE.height - 27, width: 40, height: 30 },
      // a band along the bottom, through both of its corners
      {
        x: PANE.x - 5,
        y: PANE.y + PANE.height - 20,
        width: PANE.width + 10,
        height: 30,
      },
      // a column through both left corners
      { x: PANE.x + 2, y: PANE.y - 5, width: 20, height: PANE.height + 10 },
      // the middle, reaching no corner
      { x: PANE.x + 50, y: PANE.y + 50, width: 60, height: 40 },
      // part of a corner square and nothing else
      { x: PANE.x + 1, y: PANE.y + 2, width: 3, height: 3 },
    ];
    for (const rect of passes) {
      // what the pass does not repaint stays magenta, and anything it paints
      // twice over a translucent layer comes out darker
      ctl.root._ctx.fillStyle = '#ff00ff';
      ctl.root._ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctl.root.invalidate(false, rect, 'props');
      await ctl.frame();
      const after = await pixels(ctl.root);
      assert.ok(
        after.equals(full),
        `a pass over ${JSON.stringify(rect)} left pixels a full repaint does not`,
      );
    }
    await ctl.app.close();
  });
}

// --- the cost -----------------------------------------------------------

// A pane of rounded cards the way a graph pane holds them, several across
// its edges and its corners.
const cardPane = () =>
  pane(
    6,
    Array.from({ length: 36 }, (_, i) =>
      fill(i, {
        left: (i % 6) * 38 - 12,
        top: Math.floor(i / 6) * 30 - 10,
        width: 32,
        height: 24,
        borderRadius: 4,
        backgroundColor: i % 2 ? '#dfe6e9' : '#b2bec3',
      }),
    ),
    { borderWidth: 1, borderColor: '#636e72' },
  );

test('the drawing under a rounded outline keeps the fast paths', async () => {
  const ctl = await mount(cardPane());
  const band = {
    x: PANE.x - 4,
    y: PANE.y + PANE.height - 30,
    width: PANE.width + 8,
    height: 34,
  };
  // the first band pass makes the surfaces a corner is kept in; the rest
  // reuse them
  ctl.root.invalidate(false, band, 'props');
  await ctl.frame();
  const mark = analysisMark(ctl.stats);
  for (let i = 0; i < 3; i++) {
    ctl.root.invalidate(false, band, 'props');
    await ctl.frame();
  }
  await repaintAll(ctl);
  const stats = ctl.root._ctx.shapeStats;
  assert.ok(stats.hits > 0, 'the cards should take the rounded-box route');
  assert.equal(
    stats.misses['clip-mask'] ?? 0,
    0,
    'a card under the pane’s outline fell off the fast path for a clip mask',
  );
  // A mask is a pixmap and a picture built per pass, and a context made
  // per kept corner is a picture per corner per pass: once the surfaces
  // exist, repainting the pane creates nothing server-side.
  const { byName } = windowAnalysis(ctl.stats, mark);
  const created = byName.filter(([name]) =>
    ['CreatePixmap', 'RENDER:CreatePicture'].includes(name),
  );
  assert.deepEqual(created, [], 'repainting the pane created resources');
  await ctl.app.close();
});

/** The colour of one pixel of a readback, as `[r, g, b]`. */
const pixelAt = (px, x, y) => [
  ...px.subarray((y * W + x) * 4, (y * W + x) * 4 + 3),
];

const WINDOW = [0xdf, 0xe4, 0xea];
const CHILD = [0x09, 0x84, 0xe3];

// The comparisons above hold a kept corner to the clip's; this holds both
// to the answer, since a change that broke the two alike would pass them.
test('outside the arc the window shows, and inside it the child', async () => {
  for (const radius of [4, 8, 23]) {
    const ctl = await mount(pane(radius, opaque()));
    for (const pass of [null, { x: 0, y: 0, width: W, height: H }]) {
      if (pass) ctl.root.invalidate(false, pass, 'props');
      else ctl.root.invalidate(true, null, 'expose');
      await ctl.frame();
      const px = await pixels(ctl.root);
      const right = PANE.x + PANE.width - 1;
      const bottom = PANE.y + PANE.height - 1;
      // the box's own corner pixels are the farthest from any arc
      for (const [x, y] of [
        [PANE.x, PANE.y],
        [right, PANE.y],
        [right, bottom],
        [PANE.x, bottom],
      ]) {
        assert.deepEqual(pixelAt(px, x, y), WINDOW, `r${radius}: (${x}, ${y})`);
      }
      // a radius in along the diagonal is the arc's own centre
      const c = Math.ceil(radius);
      for (const [x, y] of [
        [PANE.x + c, PANE.y + c],
        [right - c, PANE.y + c],
        [right - c, bottom - c],
        [PANE.x + c, bottom - c],
      ]) {
        assert.deepEqual(pixelAt(px, x, y), CHILD, `r${radius}: (${x}, ${y})`);
      }
    }
    await ctl.app.close();
  }
});

/** How many corners the pass put back: one `lighter` composite each. */
function countKept(ctx) {
  const drawImage = ctx.drawImage;
  const seen = { corners: 0 };
  ctx.drawImage = function (...args) {
    if (this.globalCompositeOperation === 'lighter') seen.corners++;
    return drawImage.apply(this, args);
  };
  return seen;
}

test('only the corners a child reaches are kept', async () => {
  const cases = [
    // padding keeps the child off every corner square
    {
      children: [
        fill('in', {
          left: 12,
          top: 12,
          right: 12,
          bottom: 12,
          backgroundColor: '#0984e3',
        }),
      ],
      kept: 0,
    },
    {
      children: [
        fill('top', {
          left: 0,
          right: 0,
          top: 0,
          height: 20,
          backgroundColor: '#0984e3',
        }),
      ],
      kept: 2,
    },
    { children: opaque(), kept: 4 },
  ];
  for (const { children, kept } of cases) {
    const ctl = await mount(pane(8, children));
    const seen = countKept(ctl.root._ctx);
    await repaintAll(ctl);
    assert.equal(
      seen.corners,
      kept,
      `a full repaint kept ${seen.corners} corners`,
    );
    await ctl.app.close();
  }

  const ctl = await mount(pane(8, opaque()));
  const seen = countKept(ctl.root._ctx);
  ctl.root.invalidate(
    false,
    { x: PANE.x + 40, y: PANE.y + 40, width: 50, height: 40 },
    'props',
  );
  await ctl.frame();
  assert.equal(seen.corners, 0, 'a pass that reaches no corner keeps none');
  ctl.root.invalidate(
    false,
    {
      x: PANE.x - 4,
      y: PANE.y + PANE.height - 20,
      width: PANE.width + 8,
      height: 24,
    },
    'props',
  );
  await ctl.frame();
  assert.equal(seen.corners, 2, 'a band along the bottom keeps the bottom two');
  await ctl.app.close();
});

// --- where the corners are not kept -------------------------------------

test('a box whose corner squares would overlap is clipped to its outline', async () => {
  // 151 tall: a radius of 75.5 is 76 whole pixels, and two of those meet
  const ctl = await mount(pane(80, opaque(), { height: 151 }));
  const seen = countKept(ctl.root._ctx);
  await repaintAll(ctl);
  assert.equal(seen.corners, 0, 'no corner is kept on a pill');
  const px = await pixels(ctl.root);
  // the box's own corner pixel is well outside the arc: the window shows
  assert.deepEqual(pixelAt(px, PANE.x, PANE.y), WINDOW);
  assert.deepEqual(pixelAt(px, PANE.x + 100, PANE.y + 75), CHILD);
  await ctl.app.close();
});

test('a context that cannot read its pixels back clips to the outline, and to the rectangle where no child reaches a corner', async () => {
  const draw = async (children, style) => {
    const app = createMockApp();
    const x11Root = await createRoot({ app });
    x11Root.render(pane(8, children, style));
    await new Promise((resolve) => setImmediate(resolve));
    const ops = app.windows[0].ctx.ops;
    await x11Root.unmount();
    // the clip the box's children were drawn under: what the path held
    // when `clip` was called
    const clips = [];
    for (let i = 1; i < ops.length; i++) {
      if (ops[i][0] === 'clip') clips.push(ops[i - 1]);
    }
    return clips;
  };
  const box = [PANE.x, PANE.y, PANE.width, PANE.height];
  const flush = await draw(opaque());
  assert.ok(
    flush.some(
      (op) => op[0] === 'roundRect' && op.slice(1, 5).join() === box.join(),
    ),
    `a child in the corners is clipped to the outline, got ${JSON.stringify(flush)}`,
  );
  const padded = await draw([
    fill('in', {
      left: 12,
      top: 12,
      right: 12,
      bottom: 12,
      backgroundColor: '#0984e3',
    }),
  ]);
  assert.ok(
    !padded.some((op) => op[0] === 'roundRect'),
    `children clear of the corners need no outline, got ${JSON.stringify(padded)}`,
  );
});

// --- the geometry ---------------------------------------------------------

test('roundedCorners: whole-pixel squares, and none where the cut cannot be made', () => {
  const box = { x: 10, y: 20, width: 100, height: 60 };
  const corners = roundedCorners(box, 6.5);
  assert.equal(corners.radius, 6.5);
  assert.equal(corners.side, 7);
  assert.deepEqual(
    corners.squares.map(({ corner, x, y, width, height }) => [
      corner,
      x,
      y,
      width,
      height,
    ]),
    [
      ['tl', 10, 20, 7, 7],
      ['tr', 103, 20, 7, 7],
      ['br', 103, 73, 7, 7],
      ['bl', 10, 73, 7, 7],
    ],
  );
  // a radius past half the shorter side is drawn at half of it
  assert.equal(roundedCorners(box, 40).radius, 30);
  assert.equal(roundedCorners(box, 40).side, 30);
  // off the pixel grid, and squares that would overlap
  assert.equal(roundedCorners({ ...box, x: 10.5 }, 6), null);
  assert.equal(roundedCorners({ ...box, height: 61 }, 40), null);
  assert.equal(roundedCorners(box, 0), null);
});
