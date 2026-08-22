// <canvas onDraw> and the raw-pixel write (#366).
//
// `putImageData` ignores the context's transform and clip — the HTML canvas
// rule, kept by ntk — so inside `onDraw`, whose contract is "you are at the
// node's origin", an un-offset call lands at the *window* origin instead of
// in the node, and nothing errors on the way. Two answers live here:
// `DrawInfo.x`/`.y` carry the node's origin so the write is expressible,
// and development warns once when a write escapes the node's box.
//
// The pixel tests run against node-x11's in-process X server: a real
// translate, a real PutImage, a real readback. A mock cannot demonstrate
// this bug — the whole point is that the coordinates *look* right.
import assert from 'node:assert';
import { test, afterEach } from 'node:test';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  settle,
  pixelAt,
  isNear,
} from '../src/testing/index.js';
import { resetPutImageDataWarningForTests } from '../src/nodes.js';

const h = React.createElement;

afterEach(async () => {
  await cleanup();
  resetPutImageDataWarningForTests();
});

/** Run `fn` with console.warn captured. */
async function withWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

const W = 200;
const H = 120;
// where the padding below puts the canvas
const NODE_X = 60;
const NODE_Y = 40;

/** Solid red, shaped like ImageData. */
function redBlock(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/** A window with one canvas at a known offset — far enough from the origin
 *  that "landed in the node" and "landed at the window corner" are
 *  different pixels. */
function pane(onDraw, props = {}) {
  return h(
    'window',
    {
      width: W,
      height: H,
      style: {
        backgroundColor: '#101820',
        paddingLeft: NODE_X,
        paddingTop: NODE_Y,
      },
    },
    h('canvas', { onDraw, style: { width: 100, height: 60 }, ...props }),
  );
}

test("onDraw is told where it is: DrawInfo carries the node's origin", async () => {
  const infos = [];
  const { app } = await renderX11(
    pane((ctx, info) => infos.push(info)),
    {},
  );
  await settle(app);

  const node = screen.all((n) => n.kind === 'canvas')[0];
  assert.ok(infos.length > 0, 'painted at least once');
  const info = infos.at(-1);
  assert.equal(info.x, node.abs.x);
  assert.equal(info.y, node.abs.y);
  assert.equal(info.x, NODE_X);
  assert.equal(info.y, NODE_Y);
  assert.equal(info.width, node.abs.width);
  assert.equal(info.height, node.abs.height);
});

test('an un-offset putImageData lands at the window origin, and dev says so once', async () => {
  const block = redBlock(16, 8);
  let paints = 0;
  const warnings = await withWarnings(async () => {
    const { ctx, app } = await renderX11(
      pane((c) => {
        paints++;
        // node-local habits, drawable coordinates: the trap from the issue
        c.putImageData(block, 0, 0);
      }),
    );
    await settle(app);

    // spec behaviour, end to end: the pixels are at the window corner…
    assert.ok(
      isNear(await pixelAt(ctx, 4, 3), [255, 0, 0]),
      'red at the window origin',
    );
    // …and the node itself shows background
    assert.ok(
      !isNear(await pixelAt(ctx, NODE_X + 4, NODE_Y + 3), [255, 0, 0]),
      'nothing landed in the node',
    );

    // a second frame runs the same write and does not warn again
    const node = screen.all((n) => n.kind === 'canvas')[0];
    node.root.invalidate(false, node, 'props');
    node.root.flush();
    await settle(app);
    assert.ok(paints >= 2, 'painted again');
  });

  assert.equal(
    warnings.length,
    1,
    `one warning, got ${warnings.length}: ${warnings.join('\n---\n')}`,
  );
  // the message carries both ways out, and where the rule is written down
  assert.match(warnings[0], /putImageData/);
  assert.match(warnings[0], /info\.x \+ x/);
  assert.match(warnings[0], /drawImage/);
  assert.match(warnings[0], /react-x11\/ntk/);
  assert.match(warnings[0], /docs\/elements\.md/);
});

test('offset by info.x/info.y the pixels land in the node, and nothing warns', async () => {
  const block = redBlock(16, 8);
  const warnings = await withWarnings(async () => {
    const { ctx, app } = await renderX11(
      pane((c, info) => c.putImageData(block, info.x + 4, info.y + 2)),
    );
    await settle(app);

    assert.ok(
      isNear(await pixelAt(ctx, NODE_X + 4 + 2, NODE_Y + 2 + 2), [255, 0, 0]),
      'red inside the node',
    );
    assert.ok(
      !isNear(await pixelAt(ctx, 4, 2), [255, 0, 0]),
      'window origin untouched',
    );
  });
  assert.deepEqual(warnings, []);
});

test('the watch judges the write, not the source image', async () => {
  // a dirty-rect window of an atlas bigger than the node: the destination
  // is 10x10 inside the node, so a warning here would be judging the
  // atlas's extent instead of the spec's normalised write
  const atlas = redBlock(300, 300);
  const warnings = await withWarnings(async () => {
    const { app } = await renderX11(
      pane((c, info) =>
        c.putImageData(atlas, info.x - 50, info.y - 60, 50, 60, 10, 10),
      ),
    );
    await settle(app);
  });
  assert.deepEqual(warnings, []);
});

test('under a cacheKey the origin is the surface’s own, so the same offset stays correct', async () => {
  const infos = [];
  const block = redBlock(16, 8);
  const { ctx, app } = await renderX11(
    pane(
      (c, info) => {
        infos.push({ x: info.x, y: info.y });
        c.putImageData(block, info.x + 4, info.y + 2);
      },
      { cacheKey: 'raw-pixels' },
    ),
  );
  await settle(app);

  // the cache renders a key on its second sighting (the pending gate), so
  // the first frame paints live — with the node's real origin
  assert.deepEqual(infos.at(0), { x: NODE_X, y: NODE_Y });
  const node = screen.all((n) => n.kind === 'canvas')[0];
  node.root.invalidate(false, node, 'props');
  node.root.flush();
  await settle(app);

  assert.deepEqual(
    infos.at(-1),
    { x: 0, y: 0 },
    'the cache surface is a drawable of its own',
  );
  assert.ok(
    isNear(await pixelAt(ctx, NODE_X + 4 + 2, NODE_Y + 2 + 2), [255, 0, 0]),
    'composited back into the node',
  );
});

test('the mock context records putImageData, so a headless app test can assert on it', async () => {
  const block = redBlock(2, 2);
  const { ctx } = await renderX11(
    pane((c, info) => c.putImageData(block, info.x, info.y)),
    { backend: 'mock' },
  );
  const op = ctx.ops.find((o) => o[0] === 'putImageData');
  assert.deepEqual(op, ['putImageData', 2, 2, NODE_X, NODE_Y]);
});
