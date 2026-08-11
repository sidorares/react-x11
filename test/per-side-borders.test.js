// Per-side borders (issue #262): borderLeftWidth and friends resolve the
// way padding resolves — the side overrides the shorthand — with the widths
// going to yoga per edge and the colours falling back to `borderColor`.
//
// The acceptance criteria, verified as pixels against node-x11's in-process
// X server:
//
//   * `borderLeftWidth: 3` draws a left bar with no extra nodes, and the
//     content is inset on the left only — the bar is layout, not an overlay;
//   * a uniform `borderWidth` behaves exactly as before: four equal
//     per-side widths resolve onto the same single-stroke path and come out
//     byte-identical to the shorthand.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

const W = 240;
const H = 180;

async function headlessApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({ stream: clientEnd });
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

/** The whole window as raw image bytes (BGRA), for exact comparisons. */
async function image(root) {
  const ctx = root._ctx;
  const data = await new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, d) => (err ? reject(err) : resolve(d))),
  );
  return Buffer.from(data.data);
}

/** One pixel as [r, g, b]. */
const px = (img, x, y) => {
  const i = (y * W + x) * 4;
  return [img[i], img[i + 1], img[i + 2]];
};

const RED = [192, 57, 43]; // '#c0392b'
const BLACK = [0, 0, 0];
const GREEN = [39, 174, 96]; // '#27ae60'

const e = React.createElement;

// One box at fixed integer geometry, so every assertion below is an exact
// pixel at a coordinate worked out by hand.
const BOX = { x: 20, y: 20, w: 100, h: 46 };

function single(style, children) {
  return e(
    'window',
    { width: W, height: H, style: { backgroundColor: '#e9edf2' } },
    e(
      'box',
      {
        style: {
          position: 'absolute',
          left: BOX.x,
          top: BOX.y,
          width: BOX.w,
          height: BOX.h,
          ...style,
        },
      },
      children,
    ),
  );
}

// A child that fills the content box, so where the green starts *is* where
// yoga put the content edge.
const filler = e('box', {
  style: { flexGrow: 1, backgroundColor: '#27ae60' },
});

test('borderLeftWidth: 3 draws a left bar and insets content on the left only', async () => {
  const app = await headlessApp();
  const root = await mount(
    app,
    single({ borderLeftWidth: 3, borderLeftColor: '#c0392b' }, filler),
  );
  const img = await image(root);

  const midY = BOX.y + Math.floor(BOX.h / 2);
  // the bar: 3px, flush with the box's left edge, full height
  assert.deepStrictEqual(px(img, BOX.x, BOX.y), RED, 'bar reaches the top');
  assert.deepStrictEqual(px(img, BOX.x + 1, midY), RED, 'bar at mid height');
  assert.deepStrictEqual(
    px(img, BOX.x + 2, BOX.y + BOX.h - 1),
    RED,
    'bar reaches the bottom',
  );
  // content starts right after it — the 3px came out of yoga, not paint
  assert.deepStrictEqual(
    px(img, BOX.x + 3, midY),
    GREEN,
    'content is inset by exactly the bar',
  );
  // and the other three edges got neither border nor inset
  assert.deepStrictEqual(px(img, BOX.x + BOX.w - 1, midY), GREEN, 'right');
  assert.deepStrictEqual(px(img, BOX.x + 50, BOX.y), GREEN, 'top');
  assert.deepStrictEqual(
    px(img, BOX.x + 50, BOX.y + BOX.h - 1),
    GREEN,
    'bottom',
  );
});

test('four equal per-side widths are byte-identical to the uniform shorthand', async () => {
  const shorthand = await mount(
    await headlessApp(),
    single({ borderWidth: 2, borderColor: '#c0392b' }),
  );
  const perSide = await mount(
    await headlessApp(),
    single({
      borderTopWidth: 2,
      borderRightWidth: 2,
      borderBottomWidth: 2,
      borderLeftWidth: 2,
      borderColor: '#c0392b',
    }),
  );
  const a = await image(shorthand);
  const b = await image(perSide);
  assert.ok(
    a.equals(b),
    'equal sides must resolve onto the same uniform stroke path',
  );
});

test('a side colour falls back to borderColor and overrides it per side', async () => {
  const app = await headlessApp();
  const root = await mount(
    app,
    single({
      borderWidth: 1,
      borderColor: '#000000',
      borderTopColor: '#c0392b',
    }),
  );
  const img = await image(root);

  const midY = BOX.y + Math.floor(BOX.h / 2);
  const midX = BOX.x + Math.floor(BOX.w / 2);
  assert.deepStrictEqual(px(img, midX, BOX.y), RED, 'top uses its own colour');
  assert.deepStrictEqual(px(img, BOX.x, midY), BLACK, 'left falls back');
  assert.deepStrictEqual(
    px(img, BOX.x + BOX.w - 1, midY),
    BLACK,
    'right falls back',
  );
  assert.deepStrictEqual(
    px(img, midX, BOX.y + BOX.h - 1),
    BLACK,
    'bottom falls back',
  );
  // the deterministic corner rule: top and bottom span the box's full width
  assert.deepStrictEqual(px(img, BOX.x, BOX.y), RED, 'top owns its corners');
});

test('a side width overrides the shorthand the way paddingLeft overrides padding', async () => {
  const app = await headlessApp();
  const root = await mount(
    app,
    single(
      { borderWidth: 1, borderColor: '#000000', borderLeftWidth: 5 },
      filler,
    ),
  );
  const img = await image(root);

  const midY = BOX.y + Math.floor(BOX.h / 2);
  assert.deepStrictEqual(px(img, BOX.x + 4, midY), BLACK, 'left is 5px wide');
  assert.deepStrictEqual(
    px(img, BOX.x + 5, midY),
    GREEN,
    'content starts after the 5px',
  );
  assert.deepStrictEqual(
    px(img, BOX.x + BOX.w - 1, midY),
    BLACK,
    'right keeps the shorthand 1px',
  );
  assert.deepStrictEqual(
    px(img, BOX.x + BOX.w - 2, midY),
    GREEN,
    'and only 1px of it',
  );
});

test('borderRadius on a non-uniform border paints square and warns once', async () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const app = await headlessApp();
    const root = await mount(
      app,
      single({
        borderRadius: 8,
        borderLeftWidth: 3,
        borderLeftColor: '#c0392b',
      }),
    );
    const img = await image(root);
    // square: the bar still owns its top-left corner pixel, which a rounded
    // stroke would have vacated
    assert.deepStrictEqual(px(img, BOX.x, BOX.y), RED);
    const radiusWarnings = warnings.filter((w) =>
      /borderRadius needs uniform borders/.test(w),
    );
    assert.strictEqual(radiusWarnings.length, 1, 'said so, and said so once');
  } finally {
    console.warn = realWarn;
  }
});
