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
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createStyles } from '../src/styles.js';
import { registerElement, unregisterElement } from '../src/host.js';
import { Node } from '../src/node.js';
import { createMockApp, spinWheel } from './helpers/mock-app.js';
import { renderX11, screen, cleanup } from '../src/testing/index.js';

const require = createRequire(import.meta.url);
const fontsDir = path.join(
  path.dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

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

// --- the width the heights are measured for ---------------------------------

// A paragraph, as layout sees one: `LINE` pixels of text that can be squeezed
// down to its longest word and takes another line every time it is. There are
// no fonts here (see the top of this file), and a `<text>` is nothing more
// than this to yoga — a leaf whose height is a function of its width.
const WORD = 50;
const LINE = 100;
const LINE_HEIGHT = 20;

class ParagraphNode extends Node {
  constructor(props, app) {
    super('paragraph', props, app);
  }

  measureContent({ width }) {
    const w = Math.max(WORD, Math.min(LINE, width));
    return { width: w, height: LINE_HEIGHT * Math.ceil(LINE / w) };
  }
}

/**
 * The arrangement of issue #311: a horizontally scrolling row, a column with
 * no width of its own, a row that aligns to `flex-start`, and inside that a
 * row that centres one paragraph. `scroll` and `center` are the two of those
 * four that dropping either used to fix it.
 */
const scrollerTree = (scroll, center, refs) =>
  box(
    {
      flexDirection: 'row',
      flexGrow: 1,
      ...(scroll ? { overflow: 'scroll' } : {}),
    },
    h(
      'box',
      null,
      box(
        { flexDirection: 'row', alignItems: 'flex-start' },
        box({ width: 20, height: 20 }), // the gutter
        h(
          'box',
          { style: { flexDirection: 'column' } },
          h(
            'box',
            {
              ref: refs.row,
              style: {
                flexDirection: 'row',
                ...(center ? { alignItems: 'center' } : {}),
              },
            },
            h('paragraph', { ref: refs.label }),
          ),
        ),
      ),
    ),
  );

test('a scroller measures the heights inside it at their real width', async () => {
  // The heights the floors are written from come from a pass that collapses
  // the tree to nothing, and that pass has no business re-deciding the
  // widths on the way — a minimum height is always a height *for a width*.
  // It did anyway: a box measured against a zero cross size is answered from
  // its bounds without its children being laid out, and where the width was
  // undefined too — which is what a *horizontally* scrolling box hands its
  // content — that bound was the min-content floor written a moment earlier.
  // The paragraph was measured at its longest word, took two lines, and the
  // row around it kept the two-line height while the paragraph itself, laid
  // out for real at its full width, took one (#311).
  registerElement('paragraph', {
    create: (props, app) => new ParagraphNode(props, app),
  });
  try {
    for (const [scroll, center] of [
      [false, true],
      [true, false],
      [true, true],
    ]) {
      const refs = { row: React.createRef(), label: React.createRef() };
      const { root } = await mount(scrollerTree(scroll, center, refs));
      assert.deepStrictEqual(
        [refs.row.current.abs.height, refs.label.current.abs.height],
        [LINE_HEIGHT, LINE_HEIGHT],
        `one line tall, with scroll=${scroll} center=${center}`,
      );
      await root.unmount();
    }
  } finally {
    unregisterElement('paragraph');
  }
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
  const measured = node._floorsMeasured;
  const passes = node._layoutPasses;
  assert.ok(measured > 0, 'the rows were measured');

  spinWheel(app.windows[0], 50, 50, 1);
  app.windows[0].flushFrame?.();
  await tick();
  assert.strictEqual(node._floorsDirty, false, 'still the same answer');
  assert.strictEqual(node._floorsMeasured, measured, 'nothing re-measured');
  assert.strictEqual(node._layoutPasses, passes + 1, 'one layout pass');
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

// --- a floor is only exact if the content is whole pixels --------------------
//
// The one place in this file with real faces loaded, because the bug needs a
// content size with a fraction in it and headless text measures 0x0.
//
// A floor is written unrounded and measured with the pixel grid off, on
// purpose (`measuringExactly`): rounding one grows the tree a pixel per
// level. What that costs is exactness — `contentSpan` adds the pieces up in
// doubles and yoga keeps the floor as a float, so a fractional content size
// comes back as a floor one ulp *under* the size it was measured from. Yoga's
// shrink pass then has a line of items each a hair over their floor, freezes
// all of them, and divides by a total shrink factor that should have
// cancelled to zero and is instead the rounding residue. Three items in a
// column are enough; the answer comes back in the billions of pixels
// (issue #411).
//
// So the rule the measure functions keep is that a content size is a whole
// number of pixels — `textBoxTrim: 'cap-alphabetic'` was the one that did
// not, since the cap band it measures to is a fraction of the em.
const trimFonts = {
  // cap height 9.562 at 14px: the fraction that used to reach yoga
  'sans-serif': path.join(fontsDir, 'KaTeX_Main-Regular.ttf'),
};

const trimmedSection = (i) =>
  h(
    'box',
    { key: i, style: { flexDirection: 'column', gap: 14 } },
    h('text', { style: { textBoxTrim: 'cap-alphabetic' } }, 'Room to think.'),
    box({ height: 60 }),
    box({ height: 60 }),
    box({ height: 60 }),
  );

test('a trimmed label measures to a whole pixel', async () => {
  const label = React.createRef();
  await renderX11(
    h(
      'text',
      { ref: label, style: { textBoxTrim: 'cap-alphabetic' } },
      'Room to think.',
    ),
    { width: 300, height: 120, fonts: trimFonts },
  );
  const measured = label.current.measureContent({ width: 300 });
  assert.strictEqual(
    measured.height,
    Math.round(measured.height),
    `the trimmed cap band reached layout as ${measured.height}`,
  );
  assert.ok(measured.height > 0, 'and it is still the cap band');
  await cleanup();
});

test('a scroll pane of trimmed titles lays out in pixels, not billions', async () => {
  // The issue's own tree: a column that overflows its viewport, so every
  // section is squeezed against the floor its content just wrote.
  await renderX11(
    h(
      'box',
      {
        'data-testname': 'pane',
        style: {
          width: 500,
          overflow: 'scroll',
          flexDirection: 'column',
          gap: 30,
          padding: 36,
        },
      },
      ...Array.from({ length: 4 }, (_, i) => trimmedSection(i)),
    ),
    { width: 600, height: 400, fonts: trimFonts },
  );
  const pane = screen.getByTestName('pane');
  for (const section of pane.children) {
    assert.ok(
      section.abs.height > 0 && section.abs.height < 1000,
      `section laid out at ${section.abs.height}px`,
    );
  }
  // and the ones past the fold are still where the ones above put them
  const tops = pane.children.map((section) => section.abs.y);
  assert.deepStrictEqual(
    tops,
    [...tops].sort((a, b) => a - b),
    'sections stack in order',
  );
  assert.ok(
    tops[3] - tops[0] < 1000,
    `the fourth section sits at ${tops[3]}, ${tops[3] - tops[0]} below the first`,
  );
  await cleanup();
});

// --- what a change measures ---------------------------------------------------
//
// Every node keeps the extent it was last measured at, and a measurement
// re-reads only the nodes whose subtree changed (`collectFloorStale`); the
// height passes run only when a floor is going to be written from what they
// find. `_floorsMeasured` counts the nodes a measurement read,
// `_layoutPasses` the passes over the root — the real one included.

const WINDOW = { title: 'floors', width: 300, height: 200 };

async function rerender(app, root, children, windowProps = {}) {
  root.render(h('window', { ...WINDOW, ...windowProps }, children));
  await tick();
  app.windows[0].flushFrame?.();
  await tick();
}

/** A label of a width its prop names: content that can change. */
class LabelNode extends Node {
  constructor(props, app) {
    super('label', props, app);
  }

  measureContent({ width }) {
    return { width: Math.min(this.props.length, width), height: 20 };
  }

  applyProps(next, prev) {
    const out = super.applyProps(next, prev);
    if (next.length !== prev?.length) this.invalidateMeasure('props');
    return out;
  }
}

test('a padding change on a container measures the container and nothing below it', async () => {
  const rows = () => [
    box({ height: 20 }),
    box({ height: 30 }),
    box({ height: 40 }),
  ];
  const container = (pad) =>
    h('box', { key: 'c', style: { padding: pad } }, ...rows());
  const { app, root, node } = await mount(container(8));
  const measured = node._floorsMeasured;
  const passes = node._layoutPasses;
  const scoped = node._scopedFloorPasses;
  await rerender(app, root, container(12));
  assert.strictEqual(node._floorsMeasured - measured, 1, 'the container alone');
  // laid out alone to measure it — it is stretched across the window, which
  // is where its change stops mattering (spine.js) — and the tree once
  assert.ok(node._scopedFloorPasses > scoped, 'measured alone');
  assert.strictEqual(node._layoutPasses - passes, 1, 'and the layout');
  await root.unmount();
});

test('a row that mounts measures itself alone', async () => {
  const container = (n) =>
    h(
      'box',
      { key: 'c', style: { padding: 8 } },
      ...Array.from({ length: n }, (_, i) =>
        h('box', { key: i, style: { height: 20 + i } }),
      ),
    );
  const { app, root, node } = await mount(container(3));
  const measured = node._floorsMeasured;
  await rerender(app, root, container(4));
  assert.strictEqual(
    node._floorsMeasured - measured,
    2,
    'the row and the container it joined',
  );
  await root.unmount();
});

test('a colour change measures nothing and lays out nothing', async () => {
  const tree = (color) =>
    h(
      'box',
      { key: 'c', style: { padding: 8 } },
      box({ height: 20, backgroundColor: color }),
      box({ height: 30 }),
    );
  const { app, root, node } = await mount(tree('#ff0000'));
  const measured = node._floorsMeasured;
  const passes = node._layoutPasses;
  await rerender(app, root, tree('#00ff00'));
  assert.strictEqual(node._floorsMeasured, measured);
  assert.strictEqual(node._layoutPasses, passes);
  await root.unmount();
});

test('a label that shrinks in a row takes its floor with it', async () => {
  registerElement('label', {
    create: (props, app) => new LabelNode(props, app),
  });
  try {
    const label = React.createRef();
    const tree = (length) =>
      box(
        { flexDirection: 'row' },
        h('label', { ref: label, length }),
        box({ flexGrow: 1 }),
      );
    const { app, root, node } = await mount(tree(100));
    assert.strictEqual(label.current.abs.width, 100);
    const passes = node._layoutPasses;
    const scoped = node._scopedFloorPasses;
    await rerender(app, root, tree(60));
    assert.strictEqual(label.current.abs.width, 60, 'the floor followed');
    // the row measured alone — it is stretched across the window, where the
    // change stops mattering (spine.js) — and the tree laid out once
    assert.ok(node._scopedFloorPasses > scoped, 'the row, alone');
    assert.strictEqual(node._layoutPasses - passes, 1, 'and the layout');
    await root.unmount();
  } finally {
    unregisterElement('label');
  }
});

test('a resize that wraps nothing is one layout pass; one that wraps a paragraph measures the heights', async () => {
  registerElement('paragraph', {
    create: (props, app) => new ParagraphNode(props, app),
  });
  try {
    const para = React.createRef();
    const tree = () =>
      h(
        'box',
        { key: 'c' },
        h('paragraph', { ref: para }),
        box({ height: 20 }),
      );
    const { app, root, node } = await mount(tree());
    assert.strictEqual(para.current.abs.height, LINE_HEIGHT);
    let passes = node._layoutPasses;
    let measured = node._floorsMeasured;
    await rerender(app, root, tree(), { width: 250 });
    assert.strictEqual(node.abs.width, 250, 'resized');
    assert.strictEqual(para.current.abs.height, LINE_HEIGHT, 'still one line');
    assert.strictEqual(node._layoutPasses - passes, 1, 'one pass');
    assert.strictEqual(node._floorsMeasured, measured, 'nothing measured');
    passes = node._layoutPasses;
    measured = node._floorsMeasured;
    await rerender(app, root, tree(), { width: 80 });
    assert.strictEqual(node.abs.width, 80);
    assert.strictEqual(para.current.abs.height, 2 * LINE_HEIGHT, 'two lines');
    assert.strictEqual(
      node._layoutPasses - passes,
      4,
      'the layout, then the two height passes and the layout again',
    );
    assert.ok(node._floorsMeasured > measured, 'the paragraph measured');
    await root.unmount();
  } finally {
    unregisterElement('paragraph');
  }
});

test('a column that turns into a row moves the floor to the other axis', async () => {
  const child = React.createRef();
  const tree = (direction) =>
    h(
      'box',
      { key: 'c', style: { flexDirection: direction } },
      h('box', { ref: child }, box({ width: 40, height: 20 })),
      box({ width: 10, height: 10 }),
    );
  const { app, root } = await mount(tree('column'));
  assert.strictEqual(child.current._floorMinH, 20, 'a floor down the column');
  assert.strictEqual(child.current._floorMinW, undefined);
  await rerender(app, root, tree('row'));
  assert.strictEqual(child.current._floorMinW, 40, 'a floor along the row');
  assert.strictEqual(child.current._floorMinH, undefined, 'and none down it');
  assert.strictEqual(child.current.yoga.getMinWidth().value, 40);
  await root.unmount();
});

test('a change under a hidden subtree is measured when it is shown', async () => {
  const wrapper = React.createRef();
  const tree = (inner, shown) =>
    h(
      'box',
      { key: 'c', style: { height: 60 } },
      h(
        'box',
        { ref: wrapper, style: { display: shown ? 'flex' : 'none' } },
        box({ height: inner }),
      ),
      box({ height: 40 }),
    );
  const { app, root } = await mount(tree(20, true));
  await rerender(app, root, tree(20, false));
  // the row grows while nobody can see it, then is shown: the floor it is
  // shown with is the one for the content it has now
  await rerender(app, root, tree(50, false));
  await rerender(app, root, tree(50, true));
  assert.strictEqual(
    wrapper.current.abs.height,
    50,
    'not squeezed into the 60px column',
  );
  await root.unmount();
});

test('an absolutely positioned box of a set size that only moved measures no floors', async () => {
  // A card dragged across a graph pane, or a thousand of them panned: every
  // step moved a box that is out of its ancestors' flow and sized by its
  // own width and height, and every step measured the content floors of
  // the tree again — half of the layout a drag step cost.
  const tree = (left, width = 60) =>
    box(
      { flexDirection: 'row', flexGrow: 1 },
      box({ width: 100 }, h('text', null, 'a label that has a floor')),
      h('box', {
        style: { position: 'absolute', left, top: 10, width, height: 30 },
      }),
    );
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    h('window', { title: 'moves', width: 300, height: 200 }, tree(10)),
  );
  await tick();
  app.windows[0].flushFrame?.();
  await tick();
  const win = app.windows[0]._reactX11Node;
  let measured = 0;
  const own = win._applyContentFloors.bind(win);
  win._applyContentFloors = (...args) => {
    measured++;
    return own(...args);
  };
  for (const left of [20, 35, 50]) {
    root.render(
      h('window', { title: 'moves', width: 300, height: 200 }, tree(left)),
    );
    await tick();
    app.windows[0].flushFrame?.();
    await tick();
  }
  assert.strictEqual(measured, 0, 'three moves, no floors measured');
  const moved = win.children[0].children[1];
  assert.strictEqual(moved.abs.x, 50, 'and the box is where it was sent');

  // …while a change to its size is a change to what it holds
  root.render(
    h('window', { title: 'moves', width: 300, height: 200 }, tree(50, 80)),
  );
  await tick();
  app.windows[0].flushFrame?.();
  await tick();
  assert.strictEqual(measured, 1, 'a new size measures them');
});

// --- a change inside a box that sizes itself ----------------------------------
//
// Every node above a change is dirty in yoga for it, so a label that changed
// inside a card took every extent from the card up to the window with it, and
// the measurement that followed laid the whole tree out three times to read
// them back — at 955 nodes, half of a frame that changed forty cards. A box
// that is absolutely positioned and names its own width and height holds the
// change in (`isFloorBoundary`): it is measured laid out alone, and the
// window's one real pass is all the tree pays. The differential test holds
// every such frame to what measuring the whole tree from nothing gives.

/** Two cards laid out absolutely over a column, one inside the other's. */
const cardsTree = ({ a = 50, l1 = 40, l2 = 30, l4 = 20, width1 = 120 } = {}) =>
  box(
    { padding: 6, flexGrow: 1 },
    box(
      { flexDirection: 'row' },
      h('label', { length: a }),
      box({ flexGrow: 1, height: 10 }),
    ),
    box(
      { flexGrow: 1 },
      box(
        {
          position: 'absolute',
          left: 10,
          top: 10,
          width: width1,
          height: 90,
          padding: 4,
        },
        box(
          { flexDirection: 'row' },
          h('label', { length: l1 }),
          box({ flexGrow: 1, height: 10 }),
        ),
        h('paragraph'),
        box(
          { flexDirection: 'row', flexWrap: 'wrap' },
          box({ width: 30, height: 10 }),
          box({ width: 30, height: 10 }),
          box({ width: 30, height: 10 }),
        ),
      ),
      box(
        { position: 'absolute', left: 150, top: 10, width: 120, height: 90 },
        box(
          { flexDirection: 'row' },
          h('label', { length: l2 }),
          h('label', { length: 25 }),
        ),
        box(
          { position: 'absolute', left: 5, top: 50, width: 60, height: 30 },
          box({ flexDirection: 'row' }, h('label', { length: l4 })),
        ),
      ),
    ),
  );

/** Every node's box and extents, in tree order. */
function layoutOf(win) {
  const out = [];
  const walk = (n) => {
    if (n.yoga) {
      out.push({
        kind: n.kind,
        abs: n.abs && { ...n.abs },
        floorW: n._floorW,
        floorH: n._floorH,
      });
    }
    for (const child of n.children) walk(child);
  };
  walk(win);
  return out;
}

async function withTestElements(body) {
  registerElement('label', { create: (p, a) => new LabelNode(p, a) });
  registerElement('paragraph', { create: (p, a) => new ParagraphNode(p, a) });
  try {
    await body();
  } finally {
    unregisterElement('label');
    unregisterElement('paragraph');
  }
}

test('a change inside a card measures the card alone, and lays the tree out once', async () => {
  await withTestElements(async () => {
    const { app, root, node } = await mount(cardsTree());
    const passes = node._layoutPasses;
    const scoped = node._scopedFloorPasses;
    await rerender(app, root, cardsTree({ l1: 70 }));
    assert.strictEqual(node._layoutPasses - passes, 1, 'the real pass alone');
    assert.ok(node._scopedFloorPasses > scoped, 'the card was measured');
    await root.unmount();
  });
});

test('a label in a row is measured with its row; a change to a card’s own size, with the tree', async () => {
  await withTestElements(async () => {
    const { app, root, node } = await mount(cardsTree());
    let passes = node._layoutPasses;
    await rerender(app, root, cardsTree({ a: 80 }));
    assert.strictEqual(node._layoutPasses - passes, 1, 'the row, alone');
    passes = node._layoutPasses;
    await rerender(app, root, cardsTree({ a: 80, width1: 110 }));
    assert.ok(node._layoutPasses - passes > 1, 'a card that changed its width');
    await root.unmount();
  });
});

// --- column spines ----------------------------------------------------------

/**
 * A document, as the floors see one: a scroll pane, one column in it, and
 * blocks down the column — paragraphs, labels, a padded box with margins
 * round a paragraph, a row of labels (a width floor to write), a box of a
 * fixed height, a box that clips and one that holds one. Each block is
 * `[kind, key, n]`, so a step can append, remove, insert and edit.
 */
const docTree = ({ blocks, pad = 6, gap = 4 }) =>
  box(
    { overflow: 'scroll', flexGrow: 1 },
    box(
      { padding: pad, gap },
      ...blocks.map(([kind, key, n]) => {
        if (kind === 'p') return h('paragraph', { key });
        if (kind === 'l') return h('label', { key, length: n });
        if (kind === 'fixed') return h('box', { key, style: { height: n } });
        // a box that clips, which names its own floor: squashed by any pass
        // that offers it no room, which down this column none does
        if (kind === 'clip') {
          return h(
            'box',
            { key, style: { overflow: 'hidden' } },
            h('paragraph'),
          );
        }
        // a row with a box that names a width and still grows: its extent
        // is what it was laid out at, so it is only right if the width pass
        // offered the row what the pass over the whole tree does
        if (kind === 'grow-row') {
          return h(
            'box',
            { key, style: { flexDirection: 'row' } },
            h('box', { style: { width: 20, flexGrow: 1, height: 5 } }),
            h('label', { length: n }),
          );
        }
        if (kind === 'holds-clip') {
          return h(
            'box',
            { key, style: { padding: n } },
            h('box', { style: { overflow: 'hidden' } }, h('paragraph')),
          );
        }
        if (kind === 'row') {
          return h(
            'box',
            { key, style: { flexDirection: 'row', gap: 2 } },
            h('label', { length: n }),
            h('label', { length: 30 }),
          );
        }
        return h(
          'box',
          { key, style: { padding: 3, marginTop: 2, marginBottom: n } },
          h('paragraph'),
          h('label', { length: n * 4 }),
        );
      }),
    ),
  );

/**
 * Every box and every height extent the same, and every width extent where
 * both windows have one. Neither measures a width nobody reads: a spine
 * leaves the columns it sums unmeasured across (spine.js), and the whole
 * tree forgets the width of every box above a change when no width floor
 * is owed, where a spine keeps the stop's, which did not move. Both are
 * the floors' way with an extent nobody reads (`collectFloorStale`).
 */
function assertSameMeasurement(scoped, whole, message) {
  const a = layoutOf(scoped);
  const b = layoutOf(whole);
  assert.strictEqual(a.length, b.length, message);
  for (let i = 0; i < a.length; i++) {
    const { floorW, ...rest } = a[i];
    const { floorW: wholeW, ...wholeRest } = b[i];
    assert.deepStrictEqual(rest, wholeRest, `${message}: node ${i}`);
    if (floorW !== undefined && wholeW !== undefined) {
      assert.strictEqual(floorW, wholeW, `${message}: node ${i} across`);
    }
  }
}

test('every spine measurement is the one the whole tree gives', async () => {
  // The column spine (spine.js) measures a block that changed alone and sums
  // the column it sits in. Two windows, the same frames: one measures what
  // each change is confined to, the other the whole tree, and every box and
  // every height has to come out the same.
  await withTestElements(async () => {
    const start = [
      ['p', 'a'],
      ['l', 'b', 40],
      ['box', 'c', 5],
      ['row', 'd', 60],
      ['fixed', 'e', 30],
    ];
    const steps = [
      { blocks: [...start, ['l', 'f', 20]] }, // a label joins
      { blocks: [...start, ['l', 'f', 20], ['p', 'g'], ['box', 'h', 9]] },
      { blocks: [...start, ['l', 'f', 150], ['p', 'g'], ['box', 'h', 9]] },
      { blocks: [...start, ['p', 'g'], ['box', 'h', 1]] }, // one leaves
      {
        blocks: [
          ['p', 'a'],
          ['fixed', 'x', 12], // one arrives in the middle
          ['l', 'b', 40],
          ['box', 'c', 5],
          ['row', 'd', 60],
          ['fixed', 'e', 30],
          ['box', 'h', 1],
        ],
      },
      { blocks: [...start, ['grow-row', 'g', 15]] }, // grows in the pass
      { blocks: [...start, ['grow-row', 'g', 35]] },
      { blocks: [...start, ['clip', 'k'], ['holds-clip', 'm', 3]] }, // clips
      { blocks: [...start, ['clip', 'k'], ['holds-clip', 'm', 7]] },
      { blocks: [...start, ['row', 'r', 90]] }, // a row, and its floors
      { blocks: [...start, ['row', 'r', 12]] }, // inside a row: the tree's
      { blocks: [...start, ['row', 'r', 12]], pad: 10 }, // the column's own
      { blocks: [...start, ['row', 'r', 12]], pad: 10, gap: 9 },
      { blocks: start.slice(0, 2), pad: 10, gap: 9 }, // most of it leaves
    ];
    const windowProps = { width: 120, height: 200 };
    const scoped = await mount(docTree({ blocks: start }), windowProps);
    const whole = await mount(docTree({ blocks: start }), windowProps);
    let took = 0;
    for (const step of steps) {
      const before = scoped.node._layoutPasses;
      await rerender(scoped.app, scoped.root, docTree(step), windowProps);
      if (scoped.node._layoutPasses - before === 1) took++;
      whole.node._floorsUnscoped = true;
      await rerender(whole.app, whole.root, docTree(step), windowProps);
      assertSameMeasurement(
        scoped.node,
        whole.node,
        `the frame after ${JSON.stringify(step)}`,
      );
    }
    assert.ok(took >= 8, `${took} of the frames were on a spine`);
    await scoped.root.unmount();
    await whole.root.unmount();
  });
});

test('a block that joins a long column is measured alone, and the tree laid out once', async () => {
  await withTestElements(async () => {
    const blocks = (n) =>
      Array.from({ length: n }, (_, i) =>
        i % 3 === 0
          ? ['p', `p${i}`]
          : i % 3 === 1
            ? ['l', `l${i}`, 20 + i]
            : ['box', `b${i}`, 2],
      );
    const { app, root, node } = await mount(docTree({ blocks: blocks(300) }));
    const measured = node._floorsMeasured;
    const passes = node._layoutPasses;
    await rerender(app, root, docTree({ blocks: blocks(301) }));
    assert.strictEqual(node._layoutPasses - passes, 1, 'the real pass alone');
    assert.ok(
      node._floorsMeasured - measured <= 3,
      `${node._floorsMeasured - measured} extents measured`,
    );
    await root.unmount();
  });
});

test('a change nobody announced keeps the whole tree’s measurement', async () => {
  // Yoga's record is the ground truth: a box dirty outside every card, with
  // no node saying why, is a change a measurement of the cards would miss.
  await withTestElements(async () => {
    const { app, root, node } = await mount(cardsTree());
    const column = node.children[0].children[0];
    column.yoga.setPadding(0, 3); // behind invalidate's back
    const passes = node._layoutPasses;
    await rerender(app, root, cardsTree({ l1: 70 }));
    assert.ok(node._layoutPasses - passes > 1, 'measured the tree');
    await root.unmount();
  });
});

test('every scoped measurement is the one the whole tree gives', async () => {
  // Two windows, the same frames: one measures what each change is confined
  // to, the other is made to measure the whole tree (`_floorsUnscoped`, the
  // flag a change with no node to name sets), and every box and every
  // extent has to come out the same.
  await withTestElements(async () => {
    const steps = [
      { l1: 70 }, // one card
      { l1: 70, l2: 90, l4: 55 }, // two, one inside the other's
      { l1: 10, l2: 5, l4: 58 }, // everything shrinks
      { l1: 200, l2: 150 }, // past the card's own width
      { l1: 200, l2: 150, a: 20 }, // and one outside, in the same frame
      { l1: 30, l2: 150, a: 20 },
    ];
    const scoped = await mount(cardsTree());
    const whole = await mount(cardsTree());
    let took = 0;
    for (const step of steps) {
      const before = scoped.node._scopedFloorPasses;
      await rerender(scoped.app, scoped.root, cardsTree(step));
      if (scoped.node._scopedFloorPasses > before) took++;
      whole.node._floorsUnscoped = true;
      await rerender(whole.app, whole.root, cardsTree(step));
      assertSameMeasurement(
        scoped.node,
        whole.node,
        `the frame after ${JSON.stringify(step)}`,
      );
    }
    assert.ok(took >= 3, `${took} of the frames were scoped`);
    await scoped.root.unmount();
    await whole.root.unmount();
  });
});
