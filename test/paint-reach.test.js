// The two frame-cost rules a large tree lives by, on the headless mock:
//
//   - a subtree's paint reach (`_subtreeBounds`) is computed once and kept
//     until something that moves it says so, because a bounded frame asks
//     every subtree on the way to its rect and walking each one made a
//     one-cell repaint cost the whole tree (1.25ms at 3,600 nodes, 0.37ms
//     cached — scripts/bench/presenters.js, `tree`);
//   - how many damage rects a frame keeps is the backend's call
//     (`window.damageRectCap`): four where a pass costs the X server a clip
//     mask, more where a pass is a client-side clip and a culled walk.
import assert from 'node:assert';
import { test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { Node } from '../src/node.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function mount(children, props = {}) {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h('window', { width: 300, height: 200, ...props }, children));
  await tick();
  const wnd = app.windows[0];
  const node = wnd._reactX11Node;
  const frame = () => {
    node._scheduled = false;
    node.flush();
  };
  frame();
  return { app, root, wnd, node, frame };
}

const cell = (i) =>
  h('box', {
    key: i,
    style: { flexGrow: 1, flexBasis: 0, backgroundColor: '#dddddd' },
  });
// gaps between the cells, so two claims never touch: adjacent claims merge
// on their slop, and a diagonal of touching cells would coalesce into one
const row = (r, cols) =>
  h(
    'box',
    {
      key: r,
      style: { flexDirection: 'row', flexGrow: 1, flexBasis: 0, gap: 6 },
    },
    ...Array.from({ length: cols }, (_, c) => cell(`${r}:${c}`)),
  );

const grid = (rows, cols) =>
  h(
    'box',
    { style: { flexGrow: 1, gap: 6 } },
    ...Array.from({ length: rows }, (_, r) => row(r, cols)),
  );

// --- the paint reach ------------------------------------------------------------

test('a frame of several rects computes each subtree reach once, not once per pass', async () => {
  const { node, frame, root } = await mount(grid(6, 8));
  const container = node.children[0];
  const rows = container.children;
  // two cells in two rows, far apart: two passes over the tree
  const a = rows[0].children[1];
  const b = rows[5].children[6];
  let computed = 0;
  const own = Node.prototype._ownPaintBounds;
  Node.prototype._ownPaintBounds = function (...args) {
    computed += 1;
    return own.apply(this, args);
  };
  try {
    a.invalidate(false, a, 'props');
    b.invalidate(false, b, 'props');
    assert.equal(node._damage.length, 2, 'two rects');
    frame();
    assert.equal(node._lastDamageRects.length, 2, 'two passes');
    const nodes = 1 + 6 + 6 * 8; // container, rows, cells
    assert.ok(
      computed <= nodes + 2,
      `${computed} reaches computed for ${nodes} nodes over two passes`,
    );
    // the same frame without the cache walks every subtree per pass — the
    // count this test exists to keep from coming back
    const cached = computed;
    computed = 0;
    for (const n of [container, ...rows]) n._paintBoundsCache = null;
    const sub = Node.prototype._subtreeBounds;
    Node.prototype._subtreeBounds = function () {
      this._paintBoundsCache = null;
      return sub.call(this);
    };
    try {
      a.invalidate(false, a, 'props');
      b.invalidate(false, b, 'props');
      frame();
    } finally {
      Node.prototype._subtreeBounds = sub;
    }
    assert.ok(
      computed > cached * 1.5,
      `uncached: ${computed} against ${cached} — the cache is not engaged`,
    );
  } finally {
    Node.prototype._ownPaintBounds = own;
  }
  await root.unmount();
});

test('the reach follows what moves it: layout, a hidden child, a style that reaches further', async () => {
  const { node, frame, root } = await mount(grid(2, 2));
  const container = node.children[0];
  const [r0] = container.children;
  const leaf = r0.children[0];
  // prime the caches through a bounded frame
  leaf.invalidate(false, leaf, 'props');
  frame();
  assert.ok(r0._paintBoundsCache, 'the row has a cached reach');
  assert.ok(container._paintBoundsCache, 'and so does the container');

  // a rect assigned by layout drops the chain above it, so what the row
  // answers next is the union over the moved leaf
  const wasRow = r0._subtreeBounds();
  // …out below the row's bottom edge (still inside the window, so the
  // frames after stay bounded), where only the leaf can carry the reach
  const below = r0.abs.y + r0.abs.height + 5;
  leaf._assignAbs(leaf.abs.x, below, leaf.abs.width, leaf.abs.height);
  assert.equal(leaf._paintBoundsCache, null);
  const nowRow = r0._subtreeBounds();
  assert.notStrictEqual(nowRow, wasRow, 'the row recomputed');
  assert.equal(
    nowRow.y + nowRow.height,
    below + leaf.abs.height,
    'over the moved leaf',
  );

  leaf.invalidate(false, leaf, 'props');
  frame();
  assert.ok(r0._paintBoundsCache);
  // a node announcing a change of its own drops it too — the chain above
  // stays dropped, and the node's own is re-derived for the claim it makes
  leaf.invalidate(false, leaf, 'props');
  assert.equal(r0._paintBoundsCache, null);
  assert.equal(container._paintBoundsCache, null);

  frame();
  // a state flip reaches the focus ring's extent, stateful or not
  leaf.invalidate(false, leaf, 'props');
  frame();
  assert.ok(r0._paintBoundsCache);
  leaf.setStyleState(':focus-visible', true);
  assert.equal(r0._paintBoundsCache, null);

  // a style swap that reaches further — a shadow — is dropped by the swap
  frame();
  leaf.invalidate(false, leaf, 'props');
  frame();
  assert.ok(r0._paintBoundsCache);
  const before = leaf._subtreeBounds();
  leaf.applyProps(
    {
      ...leaf.props,
      style: { ...leaf.props.style, boxShadow: '0 0 8px #000' },
    },
    leaf.props,
  );
  const after = leaf._subtreeBounds();
  assert.ok(after.width > before.width, 'the shadow widened the reach');
  await root.unmount();
});

test('a pure scroll carries the cached reach along instead of dropping it', async () => {
  const { node, frame, root } = await mount(
    h(
      'box',
      { style: { flexGrow: 1, overflow: 'scroll' } },
      ...Array.from({ length: 30 }, (_, i) =>
        h(
          'box',
          { key: i, style: { height: 20, backgroundColor: '#eeeeee' } },
          h('box', { style: { width: 10, height: 10 } }),
        ),
      ),
    ),
  );
  const scroller = node.children[0];
  const row3 = scroller.children[3];
  row3.invalidate(false, row3, 'props');
  frame();
  const cached = row3._paintBoundsCache;
  assert.ok(cached, 'a row with a child has a union cached');
  const y = cached.y;
  scroller.scrollTo({ y: 15 });
  frame();
  assert.strictEqual(row3._paintBoundsCache, cached, 'the same object');
  assert.equal(cached.y, y - 15, 'moved with the scroll');
  assert.equal(row3.abs.y, y - 15);
  await root.unmount();
});

// --- the damage rect cap ---------------------------------------------------------

test('the backend says how many damage rects a frame keeps; four without a word', async () => {
  const { node, wnd, frame, root } = await mount(grid(6, 8));
  const rows = node.children[0].children;
  const claim = () => {
    for (let r = 0; r < 6; r += 1) {
      const c = rows[r].children[r];
      c.invalidate(false, c, 'props');
    }
  };
  claim();
  assert.equal(node._damage.length, 4, 'an ntk window keeps the X11 cap');
  frame();

  wnd.damageRectCap = 16;
  claim();
  assert.equal(
    node._damage.length,
    6,
    'a backend that can afford a pass a rect keeps them all',
  );
  frame();
  assert.equal(
    node._lastDamageRects.length,
    6,
    'and paints them as six passes',
  );

  // the hint is read as a positive integer, nothing else
  wnd.damageRectCap = 0;
  claim();
  assert.equal(node._damage.length, 4);
  frame();
  wnd.damageRectCap = 'many';
  claim();
  assert.equal(node._damage.length, 4);
  frame();
  await root.unmount();
});
