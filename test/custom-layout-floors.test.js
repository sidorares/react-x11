// The content floors (#249, nodes.js `contentSpan`) inside a layout host's
// children. A child a layout arranges is a yoga tree of its own, which the
// window's measuring pass does not reach — it stops at the host and asks it
// for its minimum as a leaf. So the floors of what is inside each child are
// measured tree by tree (`WindowNode._measureHostChildWidths`,
// `Node._measureHostChildHeights`), and each child's min-content width is
// what its layout reads (`LayoutChild.intrinsicSizes`).
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { createRoot } from '../src/index.js';
import { registerLayout, unregisterLayout } from '../src/host.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = () => tick().then(tick);

async function mount(children, { width = 300, height = 240 } = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (kids) => x11Root.render(h('window', { width, height }, kids));
  render(children);
  await frame();
  const wnd = app.windows[0];
  return { app, wnd, root: wnd._reactX11Node, x11Root, render };
}

async function resize(app, width, height) {
  const wnd = app.windows[0];
  wnd.width = width;
  wnd.height = height;
  wnd.emit('resize', { width, height });
  await frame();
}

/** `count` 20-wide items in a wrapping row: as wide as all of them would
 *  like, as narrow as one. */
const wrapping = (count, ref) =>
  h(
    'box',
    { ref, style: { flexDirection: 'row', flexWrap: 'wrap' } },
    Array.from({ length: count }, (_, i) =>
      h('box', { key: i, style: { width: 20, height: 10, flexShrink: 0 } }),
    ),
  );

/** A button round a wrapping row of three: 76 wide by nature (60 and 16 of
 *  padding), 36 at the narrowest. */
const button = (ref) => h('box', { ref, style: { padding: 8 } }, wrapping(3));

test('a row inside a laid-out card squeezes to its floor, not to nothing', async () => {
  const flexible = React.createRef();
  const tree = (inner) =>
    h(
      'box',
      { style: { layout: { name: 'masonry', columns: 3 } } },
      h(
        'box',
        { key: 0, style: { flexDirection: 'row' } },
        h('box', { style: { width: 40, height: 10, flexShrink: 0 } }),
        h(
          'box',
          { ref: flexible },
          h('box', { style: { width: inner, height: 10 } }),
        ),
      ),
      h('box', { key: 1, style: { height: 20 } }),
    );
  const { render } = await mount(tree(80));
  // a 100-wide column, and a row that wants 40 + 80: the flexible part is
  // held at what it holds, and overflows, as it would anywhere else
  assert.strictEqual(flexible.current.abs.width, 80);
  // a floor is content, and follows it
  render(tree(90));
  await frame();
  assert.strictEqual(flexible.current.abs.width, 90);
});

test('equal-row squeezes its cells to the widest child’s floor and no further', async () => {
  const refs = [React.createRef(), React.createRef(), React.createRef()];
  const row = () =>
    h(
      'box',
      { style: { layout: 'equal-row' } },
      button(refs[0]),
      button(refs[1]),
      button(refs[2]),
    );
  const { app } = await mount(row(), { width: 150 });
  // 150 for three: 50 each, between the floor of 36 and the 76 they'd like
  assert.deepStrictEqual(
    refs.map((r) => r.current.abs.width),
    [50, 50, 50],
  );
  await resize(app, 90, 240);
  // 30 each would be below what a button can be drawn at: they overflow at 36
  assert.deepStrictEqual(
    refs.map((r) => r.current.abs.width),
    [36, 36, 36],
  );
});

test('a child whose floor moves takes its equal-row cells with it', async () => {
  const refs = [React.createRef(), React.createRef(), React.createRef()];
  // 90 wide by its own say, so the row itself is owed no floor
  const row = (padding) =>
    h(
      'box',
      { style: { layout: 'equal-row', width: 90 } },
      h('box', { ref: refs[0], style: { padding } }, wrapping(3)),
      button(refs[1]),
      button(refs[2]),
    );
  const { render } = await mount(row(8));
  // 30 each would be below the floor of 36: they overflow at it
  assert.deepStrictEqual(
    refs.map((r) => r.current.abs.width),
    [36, 36, 36],
  );
  // The first button's own padding grows, which moves its floor to 46 and
  // changes nothing inside it. Nothing writes a floor on that button — its
  // layout reads the floor rather than yoga — nor on the row, so the width
  // pass is owed for the child alone.
  render(row(13));
  await frame();
  assert.deepStrictEqual(
    refs.map((r) => r.current.abs.width),
    [46, 46, 46],
  );
});

test('a layout host’s own floor is what its algorithm answers with no room', async () => {
  const host = React.createRef();
  await mount(
    h(
      'box',
      { style: { flexDirection: 'row', width: 100 } },
      h('box', { style: { width: 60, height: 10, flexShrink: 0 } }),
      h(
        'box',
        { ref: host, style: { layout: { name: 'masonry', columns: 1 } } },
        h('box', { key: 0 }, wrapping(4)),
      ),
    ),
  );
  // the column's content wraps down to one item, so the masonry can be
  // squeezed into the 40 left beside the fixed box
  assert.strictEqual(host.current.abs.width, 40);
});

test('a card whose height is its own holds its rows at their floors', async () => {
  const rows = [React.createRef(), React.createRef()];
  await mount(
    h(
      'box',
      { style: { layout: { name: 'masonry', columns: 1 } } },
      h(
        'box',
        { key: 0, style: { height: 30 } },
        h('box', { ref: rows[0] }, h('box', { style: { height: 20 } })),
        h('box', { ref: rows[1] }, h('box', { style: { height: 20 } })),
      ),
    ),
  );
  // 40 of rows in a 30-high card: they overflow it rather than squash
  assert.deepStrictEqual(
    rows.map((r) => r.current.abs.height),
    [20, 20],
  );
});

test('a rect shorter than its child’s content holds the child’s rows at their floors', async () => {
  // a layout that puts its one child in a 30-high slot, whatever it holds
  registerLayout('slot', {
    layout: (children, c) => ({
      width: c.widthMode === 'exactly' ? c.width : 100,
      height: c.heightMode === 'exactly' ? c.height : 30,
      children: children.map(() => ({ x: 0, y: 0, width: 100, height: 30 })),
    }),
  });
  try {
    const rows = [React.createRef(), React.createRef()];
    await mount(
      h(
        'box',
        { style: { layout: 'slot' } },
        h(
          'box',
          { key: 0 },
          h('box', { ref: rows[0] }, h('box', { style: { height: 20 } })),
          h('box', { ref: rows[1] }, h('box', { style: { height: 20 } })),
        ),
      ),
    );
    // the child names no height, the rect does: 40 of rows in 30, and they
    // overflow it rather than squash
    assert.deepStrictEqual(
      rows.map((r) => r.current.abs.height),
      [20, 20],
    );
  } finally {
    unregisterLayout('slot');
  }
});

test('a card’s height floors follow the width it is placed at', async () => {
  const inner = React.createRef();
  const { app } = await mount(
    h(
      'box',
      { style: { layout: { name: 'masonry', columns: 1 } } },
      h('box', { key: 0, style: { height: 5 } }, wrapping(4, inner)),
    ),
    { width: 100 },
  );
  // four 20-wide items fit one line at 100
  assert.strictEqual(inner.current.abs.height, 10);
  await resize(app, 50, 240);
  // …and take two at 50: the floor held the row at its wrapped height
  assert.strictEqual(inner.current.abs.height, 20);
});
