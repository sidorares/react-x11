// `flexShrink` defaults to CSS's `1`, and the automatic minimum size that
// makes that safe (#249).
//
// The pair is the whole feature: everything may shrink, and nothing shrinks
// below what it needs. So most of this file is about where "what it needs"
// stops — a size that was named, a `minWidth: 0` that gives it up, an
// `overflow` that clips — and about the axis the rule applies on, which is
// the container's main one, as in CSS.
//
// Headless, so there are no fonts and text measures 0x0 (see AGENTS.md): the
// content is sized boxes throughout, and "content that can compress" is a
// wrapping row rather than a paragraph.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createStyles } from '../src/styles.js';
import { Node } from '../src/node.js';
import { createMockApp, spinWheel } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Render `children` in a window of a fixed size, settled through a frame. */
async function mount(children, windowProps = {}) {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { title: 'floors', width: 300, height: 200, ...windowProps },
      children,
    ),
  );
  await tick();
  app.windows[0].flushFrame?.();
  await tick();
  return { app, root, node: app.windows[0]._reactX11Node };
}

const box = (style, ...children) => h('box', { style }, ...children);
const size = (node) => [node.current.abs.width, node.current.abs.height];

// --- everything shrinks -----------------------------------------------------

test('a style that never mentions flexShrink still gets CSS’s 1', async () => {
  // A node on its own, before anything has laid it out, because that is
  // where the bug was: `applyLayoutStyle` only calls a setter for a property
  // that *changed*, so the `?? 1` in the applier was only ever reached by a
  // style that had already said something about shrinking, and yoga's own
  // `0` stood for every style that had not.
  const app = createMockApp();
  assert.strictEqual(new Node('box', {}, app).yoga.getFlexShrink(), 1);
  assert.strictEqual(
    new Node('box', { style: { flexShrink: 0 } }, app).yoga.getFlexShrink(),
    0,
    'still opt-out-able',
  );
});

test('a row too narrow for its content squeezes it instead of overflowing', async () => {
  // The headline of the issue. The item's own width comes from its content —
  // three 40px chips that can wrap — so 120 of content has to fit in 100,
  // and with yoga's `flexShrink: 0` it simply did not: the row ran off the
  // end of the box that contained it.
  const item = React.createRef();
  const { root } = await mount(
    box(
      { flexDirection: 'row', width: 100 },
      h(
        'box',
        { ref: item, style: { flexDirection: 'row', flexWrap: 'wrap' } },
        ...[0, 1, 2].map((i) =>
          h('box', { key: i, style: { width: 40, height: 10 } }),
        ),
      ),
    ),
  );
  assert.deepStrictEqual(size(item), [100, 20], 'squeezed, and so wrapped');
  await root.unmount();
});

test('a box does not shrink past what is inside it', async () => {
  // The other half, and the reason flipping the default alone was worse than
  // leaving it: yoga shrinks to nothing, CSS floors every flex item at its
  // min-content size. Nothing here can compress, so nothing gives.
  const giving = React.createRef();
  const { root } = await mount(
    box(
      { flexDirection: 'row', width: 50 },
      h(
        'box',
        { ref: giving, style: { flexShrink: 1 } },
        box({ width: 100, height: 20 }),
      ),
    ),
  );
  assert.deepStrictEqual(
    size(giving),
    [100, 20],
    'the 100px inside is a floor',
  );
  await root.unmount();
});

test('a column keeps the heights its rows were given', async () => {
  // CSS would floor a `height: 40` item at `min(40, its content)` — which is
  // 0 for an empty box — because on the web the box around it is usually a
  // *block* container and its children are not flex items at all. Here every
  // box lays its children out with flex, so that rule would apply to the
  // whole tree: 10 rows of 40 in a 100px pane, each silently 10 tall.
  const rows = Array.from({ length: 10 }, () => React.createRef());
  const { root } = await mount(
    box(
      { overflow: 'scroll', height: 100 },
      ...rows.map((ref, i) => h('box', { key: i, ref, style: { height: 40 } })),
    ),
  );
  assert.deepStrictEqual(
    rows.map((ref) => ref.current.abs.height),
    Array(10).fill(40),
    'a size that was named is a size that is kept',
  );
  await root.unmount();
});

// --- how a node gives it up -------------------------------------------------

test('minWidth: 0 is how a style says "down to nothing"', async () => {
  const giving = React.createRef();
  const { root } = await mount(
    box(
      { flexDirection: 'row', width: 120 },
      h(
        'box',
        { ref: giving, style: { minWidth: 0 } },
        box({ width: 40, height: 10 }),
      ),
      box({ width: 100, height: 10 }),
    ),
  );
  assert.strictEqual(giving.current.abs.width, 20, 'gave up 20 of its 40');
  await root.unmount();
});

test('a clipping box gives it up too, without being asked', async () => {
  // CSS's own exemption — `min-*: auto` computes to `0` on anything whose
  // overflow is not `visible` — and the reason a scroll pane can be smaller
  // than what is inside it.
  for (const overflow of ['scroll', 'hidden']) {
    const giving = React.createRef();
    const { root } = await mount(
      box(
        { flexDirection: 'row', width: 120 },
        h(
          'box',
          { ref: giving, style: { overflow } },
          box({ width: 40, height: 10 }),
        ),
        box({ width: 100, height: 10 }),
      ),
    );
    assert.strictEqual(giving.current.abs.width, 20, `overflow: ${overflow}`);
    await root.unmount();
  }
});

test('a minWidth of its own is never overwritten by a measurement', async () => {
  const floored = React.createRef();
  const { root } = await mount(
    box(
      { flexDirection: 'row', width: 120 },
      h(
        'box',
        { ref: floored, style: { minWidth: 30 } },
        box({ width: 60, height: 10 }),
      ),
      box({ width: 100, height: 10 }),
    ),
  );
  assert.strictEqual(floored.current.abs.width, 30, 'the number it was given');
  await root.unmount();
});

// --- where the floor is not written -----------------------------------------

test('the floor is the main axis only, as in CSS', async () => {
  // Across the row nothing shrinks by flexing, so a cross-axis floor would
  // only ever be a way to make a container overflow itself. This box is
  // taller than the row that holds it and is cut off, not floored.
  const tall = React.createRef();
  const { root } = await mount(
    box(
      { flexDirection: 'row', width: 200, height: 30, overflow: 'hidden' },
      h('box', { ref: tall }, box({ width: 20, height: 90 })),
    ),
  );
  assert.strictEqual(tall.current.abs.height, 30, 'stretched to the row');
  await root.unmount();
});

test('an absolutely positioned child is floored by nothing', async () => {
  const badge = React.createRef();
  const { root } = await mount(
    box(
      { flexDirection: 'row', width: 100 },
      h(
        'box',
        {
          ref: badge,
          style: { position: 'absolute', left: 0, top: 0, width: '50%' },
        },
        box({ width: 400, height: 10 }),
      ),
    ),
  );
  assert.strictEqual(
    badge.current.abs.width,
    50,
    'its own 50%, not its content',
  );
  await root.unmount();
});

// --- what it costs ----------------------------------------------------------

test('scrolling does not re-measure the floors', async () => {
  // The floors are content, and a scroll is the one layout change that moves
  // no yoga node at all — it applies an offset during `absolutize`. It also
  // happens at input rate on the biggest trees in any app, so paying three
  // layout passes for it would be the whole cost of the feature landing in
  // the one place that cannot afford it.
  const { app, root, node } = await mount(
    box(
      { overflow: 'scroll', height: 100 },
      ...Array.from({ length: 10 }, (_, i) =>
        h('box', { key: i, style: { height: 40 } }),
      ),
    ),
  );
  assert.strictEqual(node._floorsDirty, false, 'settled after the first frame');
  const floored = node._floored.size;
  assert.ok(floored > 0, 'the rows carry floors');

  spinWheel(app.windows[0], 50, 50, 1);
  app.windows[0].flushFrame?.();
  await tick();
  assert.strictEqual(node._floorsDirty, false, 'still the same answer');
  assert.strictEqual(node._floored.size, floored);
  await root.unmount();
});

// --- the `flex` shorthand ---------------------------------------------------

test('flex: 1 is grow 1, shrink 1, basis 0', async () => {
  const a = React.createRef();
  const b = React.createRef();
  const { root } = await mount(
    box(
      { flexDirection: 'row', width: 120 },
      h('box', { ref: a, style: { flex: 1 } }, box({ width: 200, height: 10 })),
      h('box', { ref: b, style: { flex: 2 } }),
    ),
  );
  // the basis is 0, so the 200px inside `a` counts for nothing in the share
  // — and the floor is *its* min-content, which is what stops it at 200
  assert.strictEqual(b.current.abs.width, 80, 'two shares of three');
  assert.strictEqual(a.current.style.flexBasis, 0);
  assert.strictEqual(a.current.style.flexShrink, 1);
  await root.unmount();
});

test('a longhand written beside the shorthand wins', async () => {
  const ref = React.createRef();
  const { root } = await mount(
    box(
      { flexDirection: 'row', width: 120 },
      h('box', { ref, style: { flex: 1, flexShrink: 0, flexBasis: 40 } }),
    ),
  );
  assert.strictEqual(ref.current.style.flexShrink, 0);
  assert.strictEqual(ref.current.style.flexBasis, 40);
  assert.strictEqual(
    ref.current.style.flexGrow,
    1,
    'the shorthand still set this',
  );
  assert.strictEqual(
    ref.current.style.flex,
    undefined,
    'expanded, not passed on',
  );
  await root.unmount();
});

test("flex: 'none' and flex: 'auto' are CSS's two keywords", async () => {
  const none = React.createRef();
  const auto = React.createRef();
  const { root } = await mount(
    box(
      { flexDirection: 'row', width: 100 },
      h(
        'box',
        { ref: none, style: { flex: 'none' } },
        box({ width: 60, height: 10 }),
      ),
      h(
        'box',
        { ref: auto, style: { flex: 'auto' } },
        box({ width: 20, height: 10 }),
      ),
    ),
  );
  assert.strictEqual(none.current.style.flexShrink, 0);
  assert.strictEqual(none.current.style.flexBasis, 'auto');
  assert.deepStrictEqual(size(auto), [40, 10], 'grew into what was left');
  await root.unmount();
});

test('an unknown flex value says what the three are', async () => {
  assert.throws(
    () => createStyles({ bad: { flex: 'fill' } }),
    /invalid flex "fill" in styles\.bad .*expected a number/s,
  );
});
