// `Node.opaqueRect()` — an element that covers its box with opaque pixels
// on every paint tells the window so, and a pass inside that rect is
// painted without the fills that would be under it: the window's
// background, the element's own, its ancestors'. Two halves here. On the
// mock app, which records every drawing call, that the fills are the
// exact ones skipped and nothing else. On the in-process X server, the
// invariant that makes the skip safe: a covered pass leaves the pixels a
// full repaint of the same tree leaves, byte for byte — the same test
// dirty-rect.test.js makes of every partial repaint.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { registerElement, unregisterElement } from '../src/host.js';
import { createRoot } from '../src/index.js';
import { Node } from '../src/node.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A pane that fills its whole box, opaquely, every paint — a terminal's
 * shape — and says so. `translucent` makes it a pane that must not. */
class PaneNode extends Node {
  constructor(props, app) {
    super('opaquepane', props, app);
  }

  opaqueRect() {
    return this.props.translucent ? null : this.abs;
  }

  paintContent(ctx) {
    const { x, y, width, height } = this.abs;
    ctx.fillStyle = this.props.translucent
      ? 'rgba(0, 0, 255, 0.5)'
      : (this.props.ink ?? '#123456');
    ctx.fillRect(x, y, width, height);
  }
}

registerElement('opaquepane', {
  create: (props, app) => new PaneNode(props, app),
});
process.on('exit', () => unregisterElement('opaquepane'));

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

/** The colours filled, in order: a `fillRect`, or a rounded box's `fill`. */
const fillsOf = (ctx) =>
  ctx.ops
    .filter((op) => op[0] === 'fillRect' || op[0] === 'fill')
    .map((op) => (op[0] === 'fillRect' ? op[5] : op[1]));

/** A window with a padded, coloured box around the pane, on the mock. */
async function mountMock(paneProps = {}, boxStyle = {}) {
  const app = createMockApp();
  const root = await createRoot({ app });
  roots.push(root);
  root.render(
    h(
      'window',
      { width: 200, height: 120, style: { backgroundColor: '#ffffff' } },
      h(
        'box',
        {
          style: {
            flexGrow: 1,
            padding: 10,
            backgroundColor: '#dddddd',
            ...boxStyle,
          },
        },
        h('opaquepane', { style: { flexGrow: 1 }, ...paneProps }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const node = wnd._reactX11Node;
  const ctx = wnd.getContext('2d');
  const pane = node.children[0].children[0];
  return { app, root, node, ctx, box: node.children[0], pane };
}

test('a pass inside the opaque rect skips the fills under it', async () => {
  const { node, ctx, box, pane } = await mountMock();
  assert.ok(node._opaqueNodes.has(pane), 'registered on attach');
  // the mount frame: the pane is inside the box's padding, so the full
  // pass is not covered — the window and the box both fill
  const mount = fillsOf(ctx);
  assert.deepEqual(mount, ['#ffffff', '#dddddd', '#123456']);
  ctx.ops.length = 0;
  // a claim inside the pane, as a rect: only the pane paints
  pane.invalidate(false, pane.contentBox(), 'content');
  node.flush();
  assert.deepEqual(
    fillsOf(ctx),
    ['#123456'],
    'no window background, no box background',
  );
  assert.deepEqual(node._lastDamageRects, [pane.abs]);
  ctx.ops.length = 0;
  // a claim of the pane as a node is a pixel wider than the pane — that
  // pixel is the box's, and the box paints it
  pane.invalidate(false, pane, 'content');
  node.flush();
  assert.deepEqual(fillsOf(ctx), ['#ffffff', '#dddddd', '#123456']);
  ctx.ops.length = 0;
  // a claim on the box reaches outside the pane: every fill again
  box.invalidate(false, box, 'content');
  node.flush();
  assert.deepEqual(fillsOf(ctx), ['#ffffff', '#dddddd', '#123456']);
  assert.equal(node._coverChain, null, 'cleared after the pass');
});

test('an element that answers null, or is hidden, covers nothing', async () => {
  const { node, ctx, pane } = await mountMock({ translucent: true });
  assert.ok(node._opaqueNodes.has(pane), 'it overrides, so it is asked');
  ctx.ops.length = 0;
  pane.invalidate(false, pane.contentBox(), 'content');
  node.flush();
  assert.deepEqual(fillsOf(ctx), [
    '#ffffff',
    '#dddddd',
    'rgba(0, 0, 255, 0.5)',
  ]);
});

test('a clipping ancestor shrinks the cover to what reaches the surface', async () => {
  // a rounded, clipping box: its corner squares are given up by the clip,
  // so a pass in a corner is not covered while one in the middle is
  const { node, ctx, pane } = await mountMock(
    {},
    { overflow: 'hidden', borderRadius: 8, padding: 0 },
  );
  ctx.ops.length = 0;
  const { x, y, width, height } = pane.abs;
  pane.invalidate(
    false,
    { x: x + 20, y: y + 20, width: 40, height: 40 },
    'content',
  );
  node.flush();
  assert.deepEqual(fillsOf(ctx), ['#123456'], 'the middle');
  ctx.ops.length = 0;
  pane.invalidate(false, { x, y, width: 4, height: 4 }, 'content');
  node.flush();
  assert.deepEqual(
    fillsOf(ctx),
    ['#ffffff', '#dddddd', '#123456'],
    'the corner',
  );
  // and the whole pane, which reaches every corner
  ctx.ops.length = 0;
  pane.invalidate(false, { x, y, width, height }, 'content');
  node.flush();
  assert.equal(fillsOf(ctx).length, 3);
});

test('unmounting the element takes it out of the set', async () => {
  const { node, root, pane } = await mountMock();
  assert.ok(node._opaqueNodes.has(pane));
  root.render(h('window', { width: 200, height: 120 }));
  await tick();
  assert.equal(node._opaqueNodes.size, 0);
});

// --- pixels ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

async function headlessApp() {
  const server = xserver.createServer({ width: 300, height: 300 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');
  return createClient({ stream: clientEnd, fontSource });
}

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );

const settled = (app) =>
  new Promise((resolve, reject) =>
    app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
  );

test('a covered pass leaves the pixels a full repaint leaves', async () => {
  const W = 160;
  const H = 120;
  const app = await headlessApp();
  const root = await createRoot({ app });
  const tree = (ink) =>
    h(
      'window',
      { width: W, height: H, style: { backgroundColor: '#ffffff' } },
      h(
        'box',
        { style: { flexGrow: 1, padding: 12, backgroundColor: '#dddddd' } },
        h('opaquepane', { style: { flexGrow: 1 }, ink }),
      ),
    );
  // the render callback hands back the root child's public instance — the
  // live ntk window, which knows its node (the way react-x11/test finds it)
  const windowNode = await new Promise((resolve) =>
    root.render(tree('#123456'), (inst) => resolve(inst._reactX11Node)),
  );
  windowNode.flush();
  await settled(app);
  const ctx = windowNode.window.getContext('2d');
  const pane = windowNode.children[0].children[0];
  // change the ink and repaint through the covered pass
  pane.props = { ...pane.props, ink: '#654321' };
  pane.invalidate(false, pane.contentBox(), 'content');
  windowNode.flush();
  assert.deepEqual(windowNode._lastDamageRects, [pane.abs], 'a bounded pass');
  await settled(app);
  const partial = await readPixels(ctx, W, H);
  // the same tree painted whole
  windowNode.invalidate(false, null, 'content');
  windowNode.flush();
  await settled(app);
  const full = await readPixels(ctx, W, H);
  assert.ok(Buffer.from(partial.data).equals(Buffer.from(full.data)));
  // and it is the new ink that is there, not the old
  const at = (data, x, y) => [
    ...data.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 3),
  ];
  assert.deepEqual(at(full, W / 2, H / 2), [0x65, 0x43, 0x21]);
  assert.deepEqual(at(full, 4, 4), [0xdd, 0xdd, 0xdd]);
  await root.unmount();
});
