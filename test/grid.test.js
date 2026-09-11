// `display: 'grid'` — CSS grid, built in (src/grid.js; docs/styling.md
// "Grid"). test/grid-conformance.test.js lays out a corpus of grids Chrome
// laid out first, which is where the algorithm is checked broadly; these are
// the cases worth a name, and the renderer's side of it: the style, its
// validation, the reports, and a grid following its style frame to frame.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { createRoot, createStyles } from '../src/index.js';
import { registerLayout, unregisterLayout } from '../src/host.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = () => tick().then(tick);

async function mount(tree, { width = 400, height = 300, scale } = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app, ...(scale && { scale }) });
  const render = async (next) => {
    x11Root.render(h('window', { width, height }, next));
    await frame();
  };
  await render(tree);
  return { app, render };
}

/** An item: a box with this style — and, for `content: [w, h]`, a box of
 *  that size inside it, which is what gives an item a content size. */
function item(spec, ref, key) {
  const { content, ...style } = spec;
  return h(
    'box',
    { key, ref, style },
    content
      ? h('box', {
          style: { width: content[0], height: content[1] ?? 10, flexShrink: 0 },
        })
      : null,
  );
}

const rectOf = (node, from) => [
  node.abs.x - from.abs.x,
  node.abs.y - from.abs.y,
  node.abs.width,
  node.abs.height,
];

/** A grid of boxes: the grid's style and one spec per item. `rects()` is each
 *  item's [x, y, width, height] from the grid's corner. */
async function grid(style, specs, options) {
  const box = React.createRef();
  const refs = specs.map(() => React.createRef());
  const tree = (s, sp) =>
    h(
      'box',
      { ref: box, style: { flexShrink: 0, ...s } },
      sp.map((spec, i) => item(spec, refs[i], i)),
    );
  const env = await mount(tree(style, specs), options);
  const rects = () => refs.map((r) => rectOf(r.current, box.current));
  return {
    ...env,
    rects,
    size: () => [box.current.abs.width, box.current.abs.height],
    update: (s, sp = specs) => env.render(tree(s, sp)),
  };
}

/** console.error, captured. A reported problem also marks the process
 *  failed, which a test that provokes one on purpose has to put back. */
async function capturingErrors(fn) {
  const lines = [];
  const original = console.error;
  const code = process.exitCode;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn(lines);
  } finally {
    console.error = original;
    process.exitCode = code;
  }
  return lines;
}

const defined = [];
afterEach(() => {
  for (const name of defined.splice(0)) unregisterLayout(name);
});

// --- the tracks ---------------------------------------------------------------

test("display: 'grid' lays out columns: a fixed track, then fr sharing the rest by factor", async () => {
  const g = await grid(
    { display: 'grid', gridTemplateColumns: '100px 1fr 2fr' },
    [{ height: 20 }, { height: 20 }, { height: 20 }],
  );
  assert.deepStrictEqual(g.rects(), [
    [0, 0, 100, 20],
    [100, 0, 100, 20],
    [200, 0, 200, 20],
  ]);
  assert.deepStrictEqual(g.size(), [400, 20]);
});

test('a number is that many equal columns, whatever is in them — repeat(3, 1fr) is not', async () => {
  const specs = [{ content: [300] }, {}, {}];
  const counted = await grid(
    { display: 'grid', gridTemplateColumns: 3 },
    specs,
  );
  assert.deepStrictEqual(
    counted.rects().map(([x, , w]) => [x, w]),
    [
      [0, 133],
      [133, 134],
      [267, 133],
    ],
  );
  // `1fr` is minmax(auto, 1fr): the first column holds its content, and the
  // other two share what is left
  const shared = await grid(
    { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' },
    specs,
  );
  assert.deepStrictEqual(
    shared.rects().map(([x, , w]) => [x, w]),
    [
      [0, 300],
      [300, 50],
      [350, 50],
    ],
  );
});

test('an auto column is as wide as its widest item, and the fr column takes the rest', async () => {
  const g = await grid(
    { display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 8 },
    [{ content: [50] }, {}, { content: [80] }, {}],
  );
  assert.deepStrictEqual(
    g.rects().map(([x, , w]) => [x, w]),
    [
      [0, 80],
      [88, 312],
      [0, 80],
      [88, 312],
    ],
  );
});

test('a 1fr column is never narrower than what is in it', async () => {
  const g = await grid(
    { display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10 },
    [{ content: [30] }, { content: [120] }],
    { width: 100 },
  );
  // 100 cannot hold 30 + 10 + 120: the fr column keeps its content
  assert.deepStrictEqual(
    g.rects().map(([x, , w]) => [x, w]),
    [
      [0, 30],
      [40, 120],
    ],
  );
});

test('a child with a width of its own holds open the fr columns it spans', async () => {
  const g = await grid(
    { display: 'grid', gridTemplateColumns: '1fr 1fr auto' },
    [{ width: 120, height: 10, gridColumn: 'span 2' }, { content: [250] }],
    { width: 300 },
  );
  // a sized child's minimum contribution is its size (css-grid-2 §6.6),
  // shared by the fr columns — or the auto column takes the room and the
  // child overflows what it was given
  assert.deepStrictEqual(
    g.rects().map(([x, , w]) => [x, w]),
    [
      [0, 120],
      [120, 250],
    ],
  );
});

test('repeat(auto-fill) fits as many tracks as the width holds, and auto-fit collapses the empty ones', async () => {
  const filled = await grid(
    {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
      gap: 10,
    },
    Array.from({ length: 4 }, () => ({ height: 20 })),
    { width: 350 },
  );
  // (350 + 10) / 110 → three columns, (350 - 20) / 3 = 110 wide
  assert.deepStrictEqual(filled.rects(), [
    [0, 0, 110, 20],
    [120, 0, 110, 20],
    [240, 0, 110, 20],
    [0, 30, 110, 20],
  ]);
  const fitted = await grid(
    {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
      gap: 10,
    },
    [{ height: 20 }, { height: 20 }],
    { width: 350 },
  );
  // three fit, one is empty and collapses, gap and all: two share the width
  assert.deepStrictEqual(fitted.rects(), [
    [0, 0, 170, 20],
    [180, 0, 170, 20],
  ]);
});

test('neighbours meet on a shared pixel: the lines are snapped, not each item', async () => {
  const touching = await grid(
    { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' },
    [{ height: 10 }, { height: 10 }, { height: 10 }],
  );
  assert.deepStrictEqual(
    touching.rects().map(([x, , w]) => [x, x + w]),
    [
      [0, 133],
      [133, 267],
      [267, 400],
    ],
  );
  const spaced = await grid(
    { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', columnGap: 7 },
    [{ height: 10 }, { height: 10 }, { height: 10 }],
  );
  // every gap is the 7 it was written as
  assert.deepStrictEqual(
    spaced.rects().map(([x, , w]) => [x, x + w]),
    [
      [0, 129],
      [136, 264],
      [271, 400],
    ],
  );
});

test('a length in a track list is logical pixels at any scale; a count is no length', async () => {
  const g = await grid(
    { display: 'grid', gridTemplateColumns: '100px 1fr', gridAutoRows: 20 },
    [{}, {}],
    { scale: 2 },
  );
  assert.deepStrictEqual(g.rects(), [
    [0, 0, 200, 40],
    [200, 0, 600, 40],
  ]);
  const counted = await grid(
    { display: 'grid', gridTemplateColumns: 2 },
    [{ height: 10 }, { height: 10 }],
    { scale: 2 },
  );
  assert.deepStrictEqual(counted.rects(), [
    [0, 0, 400, 20],
    [400, 0, 400, 20],
  ]);
});

// --- placement ------------------------------------------------------------------

test("negative lines count back from the end: '1 / -1' is the whole width, however many columns", async () => {
  const g = await grid(
    { display: 'grid', gridTemplateColumns: '100px 100px 1fr' },
    [
      { height: 10, gridColumn: '1 / -1' },
      { height: 10, gridColumn: -2 },
      { height: 10, gridColumn: '-3 / span 2' },
    ],
  );
  assert.deepStrictEqual(g.rects(), [
    [0, 0, 400, 10],
    [200, 10, 200, 10],
    [100, 20, 300, 10],
  ]);
});

test('items flow into the first free cells, spans and all; dense packing back-fills a hole', async () => {
  const spans = await grid(
    { display: 'grid', gridTemplateColumns: 'repeat(3, 100px)' },
    [
      { height: 10, gridColumn: 'span 2' },
      { height: 10 },
      { height: 10 },
      { gridColumn: 3, gridRow: '1 / span 3' },
    ],
  );
  // the fourth is definite, so it is placed first and the others flow round
  // it; its third row holds nothing else, so it is 0 tall
  assert.deepStrictEqual(spans.rects(), [
    [0, 0, 200, 10],
    [0, 10, 100, 10],
    [100, 10, 100, 10],
    [200, 0, 100, 20],
  ]);
  const dense = await grid(
    {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 100px)',
      gridAutoFlow: 'row dense',
    },
    [{ height: 10 }, { height: 10, gridColumn: 'span 3' }, { height: 10 }],
  );
  assert.deepStrictEqual(dense.rects(), [
    [0, 0, 100, 10],
    [0, 10, 300, 10],
    [100, 0, 100, 10],
  ]);
});

test("gridAutoFlow: 'column' fills a column before it starts the next", async () => {
  const g = await grid(
    {
      display: 'grid',
      gridTemplateRows: '20px 20px',
      gridAutoColumns: '50px',
      gridAutoFlow: 'column',
    },
    Array.from({ length: 5 }, () => ({})),
  );
  assert.deepStrictEqual(g.rects(), [
    [0, 0, 50, 20],
    [0, 20, 50, 20],
    [50, 0, 50, 20],
    [50, 20, 50, 20],
    [100, 0, 50, 20],
  ]);
});

test('named areas, written as CSS writes them or as an array of rows', async () => {
  const specs = [
    { gridArea: 'main' },
    { gridArea: 'head' },
    { gridArea: 'side' },
  ];
  const base = {
    display: 'grid',
    gridTemplateColumns: '80px 1fr',
    gridTemplateRows: '30px 1fr',
    height: 200,
  };
  const css = await grid(
    { ...base, gridTemplateAreas: '"head head" "side main"' },
    specs,
  );
  assert.deepStrictEqual(css.rects(), [
    [80, 30, 320, 170],
    [0, 0, 400, 30],
    [0, 30, 80, 170],
  ]);
  const rows = await grid(
    { ...base, gridTemplateAreas: ['head head', 'side main'] },
    specs,
  );
  assert.deepStrictEqual(rows.rects(), css.rects());
});

test('gridColumn and gridRow beside gridArea win for their own axis', async () => {
  const g = await grid(
    {
      display: 'grid',
      gridTemplateColumns: '100px 100px',
      gridTemplateRows: '20px 20px',
      gridTemplateAreas: ['a b', 'c d'],
    },
    [{ gridArea: 'd', gridColumn: 1 }],
  );
  assert.deepStrictEqual(g.rects(), [[0, 20, 100, 20]]);
});

// --- alignment ------------------------------------------------------------------

test('a row is as tall as its tallest item, the others stretch — but a size of its own is kept', async () => {
  const g = await grid(
    { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
    [{ height: 20 }, { height: 30 }, { minHeight: 20 }, { content: [10, 50] }],
  );
  assert.deepStrictEqual(g.rects(), [
    [0, 0, 195, 20],
    [205, 0, 195, 30],
    // a minimum is not a height: this one stretches to the tallest
    [0, 40, 195, 50],
    [205, 40, 195, 50],
  ]);
  assert.deepStrictEqual(g.size(), [400, 90]);
});

test('justifySelf and alignSelf place an item inside its area; justifyItems and alignItems place all of them', async () => {
  const g = await grid(
    {
      display: 'grid',
      gridTemplateColumns: '100px 100px',
      gridAutoRows: '50px',
      justifyItems: 'center',
    },
    [
      { content: [40, 10] },
      { content: [40, 10], justifySelf: 'flex-end', alignSelf: 'flex-end' },
      { content: [40, 10], justifySelf: 'stretch', alignSelf: 'center' },
      // its own size: centred across, and at the top of a stretch
      { width: 30, height: 30, justifySelf: 'auto' },
    ],
  );
  assert.deepStrictEqual(g.rects(), [
    [30, 0, 40, 50],
    [160, 40, 40, 10],
    [0, 70, 100, 10],
    [135, 50, 30, 30],
  ]);
});

test('justifyContent and alignContent distribute tracks that leave room', async () => {
  const g = await grid(
    {
      display: 'grid',
      gridTemplateColumns: '100px 100px',
      gridTemplateRows: '40px 40px',
      height: 200,
      justifyContent: 'space-between',
      alignContent: 'center',
    },
    [{}, {}, {}, {}],
  );
  assert.deepStrictEqual(
    g.rects().map(([x, y]) => [x, y]),
    [
      [0, 60],
      [300, 60],
      [0, 100],
      [300, 100],
    ],
  );
});

test('right to left, the columns run from the right', async () => {
  const g = await grid(
    { display: 'grid', gridTemplateColumns: '100px 1fr', direction: 'rtl' },
    [{ height: 10 }, { height: 10 }],
  );
  assert.deepStrictEqual(g.rects(), [
    [300, 0, 100, 10],
    [0, 0, 300, 10],
  ]);
});

// --- display and layout -----------------------------------------------------------

test("layout: 'grid' is the same request as display: 'grid'", async () => {
  const specs = [{ height: 10 }, { height: 10, gridColumn: 'span 2' }];
  const tracks = { gridTemplateColumns: '1fr 1fr 1fr', columnGap: 5 };
  const byDisplay = await grid({ display: 'grid', ...tracks }, specs);
  assert.deepStrictEqual(byDisplay.rects(), [
    [0, 0, 130, 10],
    [135, 0, 265, 10],
  ]);
  const byLayout = await grid({ layout: 'grid', ...tracks }, specs);
  assert.deepStrictEqual(byLayout.rects(), byDisplay.rects());
  const both = await grid(
    { layout: 'grid', display: 'grid', ...tracks },
    specs,
  );
  assert.deepStrictEqual(both.rects(), byDisplay.rects());
});

test('display and layout that disagree are reported, and the box is flexbox until they agree', async () => {
  const lines = await capturingErrors(async () => {
    const g = await grid(
      { display: 'grid', layout: 'masonry', gridTemplateColumns: 2 },
      [{ height: 10 }, { height: 10 }],
    );
    // flexbox's column, one under the other
    assert.deepStrictEqual(g.rects(), [
      [0, 0, 400, 10],
      [0, 10, 400, 10],
    ]);
    await g.update({ display: 'grid', layout: 'grid', gridTemplateColumns: 2 });
    assert.deepStrictEqual(g.rects(), [
      [0, 0, 200, 10],
      [200, 0, 200, 10],
    ]);
  });
  assert.match(
    lines.join('\n'),
    /display: 'grid' and layout: "masonry" disagree/,
  );
  const again = await capturingErrors(() =>
    grid({ display: 'flex', layout: 'grid' }, [{ height: 10 }]),
  );
  assert.match(again.join('\n'), /display: 'flex' and layout: "grid" disagree/);
});

test("display: 'flex' beside another layout is no disagreement: it says the box is shown", async () => {
  const lines = await capturingErrors(async () => {
    const g = await grid(
      { display: 'flex', layout: { name: 'masonry', columns: 2 } },
      [{ height: 10 }, { height: 20 }, { height: 10 }],
    );
    assert.deepStrictEqual(
      g.rects().map(([x, y]) => [x, y]),
      [
        [0, 0],
        [200, 0],
        [0, 10],
      ],
    );
  });
  assert.deepStrictEqual(lines, []);
});

test('a box switched between display flex and grid is laid out by whichever it says now', async () => {
  const specs = [{ height: 10 }, { height: 10 }];
  // a grid's tracks mean nothing to a flex box
  const g = await grid({ display: 'flex', gridTemplateColumns: 2 }, specs);
  assert.deepStrictEqual(g.rects(), [
    [0, 0, 400, 10],
    [0, 10, 400, 10],
  ]);
  await g.update({ display: 'grid', gridTemplateColumns: 2 });
  assert.deepStrictEqual(g.rects(), [
    [0, 0, 200, 10],
    [200, 0, 200, 10],
  ]);
  await g.update({ display: 'flex', gridTemplateColumns: 2 });
  assert.deepStrictEqual(g.rects(), [
    [0, 0, 400, 10],
    [0, 10, 400, 10],
  ]);
});

test('a grid hidden with display: none and shown again is a grid again', async () => {
  const specs = [{ height: 10 }, { height: 10 }];
  const g = await grid({ display: 'grid', gridTemplateColumns: 2 }, specs);
  await g.update({ display: 'none', gridTemplateColumns: 2 });
  await g.update({ display: 'grid', gridTemplateColumns: 2 });
  assert.deepStrictEqual(g.rects(), [
    [0, 0, 200, 10],
    [200, 0, 200, 10],
  ]);
});

// --- following the style ------------------------------------------------------

test("the box's tracks and a child's lines are followed from frame to frame", async () => {
  const g = await grid({ display: 'grid', gridTemplateColumns: '1fr 1fr' }, [
    { height: 10 },
    { height: 10 },
  ]);
  assert.deepStrictEqual(g.rects(), [
    [0, 0, 200, 10],
    [200, 0, 200, 10],
  ]);
  await g.update({ display: 'grid', gridTemplateColumns: '1fr 1fr' }, [
    { height: 10, gridColumn: 'span 2' },
    { height: 10 },
  ]);
  assert.deepStrictEqual(g.rects(), [
    [0, 0, 400, 10],
    [0, 10, 200, 10],
  ]);
  await g.update({ display: 'grid', gridTemplateColumns: 4 }, [
    { height: 10, gridColumn: 'span 2' },
    { height: 10 },
  ]);
  assert.deepStrictEqual(g.rects(), [
    [0, 0, 200, 10],
    [200, 0, 100, 10],
  ]);
  // an inline array of areas is a new array every render, and the same areas
  const areas = (rows) => ({
    display: 'grid',
    gridTemplateColumns: 2,
    gridTemplateAreas: rows,
  });
  const placed = [
    { height: 10, gridArea: 'b' },
    { height: 10, gridArea: 'a' },
  ];
  await g.update(areas(['a b']), placed);
  assert.deepStrictEqual(
    g.rects().map(([x]) => x),
    [200, 0],
  );
  await g.update(areas(['b a']), placed);
  assert.deepStrictEqual(
    g.rects().map(([x]) => x),
    [0, 200],
  );
});

test('a child that grows is measured again, and the row grows with it', async () => {
  const g = await grid({ display: 'grid', gridTemplateColumns: 2 }, [
    { content: [10, 20] },
    {},
    {},
  ]);
  assert.deepStrictEqual(
    g.rects().map(([, y, , hgt]) => [y, hgt]),
    [
      [0, 20],
      [0, 20],
      [20, 0],
    ],
  );
  await g.update({ display: 'grid', gridTemplateColumns: 2 }, [
    { content: [10, 45] },
    {},
    {},
  ]);
  assert.deepStrictEqual(
    g.rects().map(([, y, , hgt]) => [y, hgt]),
    [
      [0, 45],
      [0, 45],
      [45, 0],
    ],
  );
});

test('a window size query switches the columns — and only the columns', async () => {
  const g = await grid(
    {
      display: 'grid',
      gridTemplateColumns: 2,
      columnGap: 10,
      '@width < 300': { gridTemplateColumns: 1 },
    },
    [{ height: 10 }, { height: 10 }],
  );
  assert.deepStrictEqual(g.rects(), [
    [0, 0, 195, 10],
    [205, 0, 195, 10],
  ]);
  const wnd = g.app.windows[0];
  wnd.width = 250;
  wnd.emit('resize', { width: 250, height: 300 });
  await frame();
  assert.deepStrictEqual(g.rects(), [
    [0, 0, 250, 10],
    [0, 10, 250, 10],
  ]);
});

// --- mistakes ---------------------------------------------------------------------

test('a grid value that would not lay out is an error naming the property and the fix', () => {
  const style = (s) => () => createStyles({ s });
  assert.throws(
    style({ gridTemplateColumns: '200 1fr' }),
    /invalid gridTemplateColumns "200 1fr" — a length in a track list is written with its unit, "200px" — a number on its own is a count of equal tracks/,
  );
  assert.throws(
    style({ gridTemplateColumns: 'repeat(auto-fill, 1fr)' }),
    /repeat\(auto-fill, …\) repeats tracks whose size it can count/,
  );
  assert.throws(
    style({ gridTemplateColumns: 2.5 }),
    /a count of equal tracks, a whole number from 1/,
  );
  assert.throws(
    style({ gridTemplateColumns: '[full] 1fr' }),
    /named lines \("\[name\]"\) are not supported/,
  );
  assert.throws(style({ gridColumn: '0 / 2' }), /there is no line 0/);
  assert.throws(style({ gridColumn: 'main' }), /named lines are not supported/);
  assert.throws(
    style({ gridTemplateAreas: ['a a', 'b'] }),
    /every row has as many cells as the first — row 1 has 2, row 2 has 1/,
  );
  assert.throws(
    style({ gridTemplateAreas: ['a b', 'b a'] }),
    /area "a" is not a rectangle/,
  );
  assert.throws(
    style({ justifySelf: 'end' }),
    /invalid justifySelf "end" \(expected one of auto, flex-start, center, flex-end, stretch\)/,
  );
  assert.throws(
    style({ gridAutoFlow: 'columns' }),
    /invalid gridAutoFlow "columns"/,
  );
  // …and what is valid passes
  createStyles({
    ok: {
      display: 'grid',
      gridTemplateColumns: 'fit-content(120px) minmax(0, 1fr) 25% auto',
      gridTemplateRows: 'repeat(2, 40px) repeat(auto-fill, 20px)',
      gridTemplateAreas: '"a . b" "a c c"',
      gridAutoRows: 'minmax(40px, auto) 30px',
      gridAutoFlow: 'dense column',
      justifyItems: 'center',
    },
    child: { gridColumn: '2 / span 3', gridRow: -1, justifySelf: 'auto' },
    area: { gridArea: '1 / 2 / 3 / -1' },
  });
});

test('a gridArea nobody named is reported, and the child is placed automatically', async () => {
  const lines = await capturingErrors(async () => {
    const g = await grid(
      {
        display: 'grid',
        gridTemplateColumns: '100px 100px',
        gridTemplateAreas: ['a b'],
      },
      [
        { height: 10, gridArea: 'b' },
        { height: 10, gridArea: 'c' },
      ],
    );
    assert.deepStrictEqual(
      g.rects().map(([x, y]) => [x, y]),
      [
        [100, 0],
        [0, 0],
      ],
    );
  });
  assert.match(
    lines.join('\n'),
    /gridArea "c" names no area of this grid's gridTemplateAreas \("a", "b"\)/,
  );
});

test('a grid says what it does not read: layoutItem, and options beside its name', async () => {
  const item = await capturingErrors(() =>
    grid({ display: 'grid' }, [{ layoutItem: { span: 2 } }]),
  );
  assert.match(item.join('\n'), /a grid does not read layoutItem/);
  const options = await capturingErrors(() =>
    grid({ layout: { name: 'grid', columns: 3 } }, [{ height: 10 }]),
  );
  assert.match(
    options.join('\n'),
    /layout: \{ name: 'grid' \} takes no options — a grid's tracks are the box's own style/,
  );
});

// --- the seam, which a grid needed and a registered layout now has ----------

test("a registered layout reads a child's style, and reports what it lays out around", async () => {
  let seen = null;
  registerLayout('peek', {
    layout(children, c, _options, { report }) {
      seen = children.map((child) => child.style.alignSelf ?? null);
      if (children.length > 1) report('react-x11: peek sees two', 'Nothing');
      return {
        width: c.widthMode === 'exactly' ? c.width : 0,
        height: c.heightMode === 'exactly' ? c.height : 0,
        children: children.map(() => ({ x: 0, y: 0 })),
      };
    },
  });
  defined.push('peek');
  const lines = await capturingErrors(() =>
    grid({ layout: 'peek' }, [{ alignSelf: 'center' }, {}]),
  );
  assert.deepStrictEqual(seen, ['center', null]);
  assert.match(lines.join('\n'), /peek sees two/);
});
