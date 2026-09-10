// Does the grid prototype lay out what CSS Grid would? Cases worked by hand
// (docs/architecture/grid-layout.md).
//   node --import tsx scripts/bench/grid/probe.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderX11, cleanup, screen } =
  await import('../../../src/testing/index.js');
const { registerLayout } = await import('../../../src/host.js');
const { registerGrid } = await import('./grid-layout.js');
registerGrid(registerLayout);

const FONT = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
  'KaTeX_Main-Regular.ttf',
);
const h = React.createElement;

async function rects(grid, children, { width = 400, height = 300, wrap } = {}) {
  const host = h(
    'box',
    { style: grid, 'data-testname': 'grid' },
    children.map((child, i) =>
      h(
        'box',
        {
          key: i,
          'data-testname': `c${i}`,
          style: { ...child.style },
        },
        child.text ? h('text', { style: { fontSize: 12 } }, child.text) : null,
      ),
    ),
  );
  await renderX11(wrap ? wrap(host) : host, {
    fonts: { 'sans-serif': FONT },
    width,
    height,
  });
  const g = screen.getByTestName('grid').abs;
  const out = children.map((_, i) => {
    const { abs } = screen.getByTestName(`c${i}`);
    return [abs.x - g.x, abs.y - g.y, abs.width, abs.height];
  });
  const size = [g.width, g.height];
  cleanup();
  return { out, size };
}

const box = (w, hgt, extra = {}) => ({
  style: { width: w, height: hgt, ...extra },
});
const item = (layoutItem, style = {}) => ({
  style: { layoutItem, ...style },
});
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failures++;
    console.log(
      `FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`,
    );
  }
}

await check('fixed and fr columns share the rest by factor', async () => {
  const { out } = await rects(
    { layout: { name: 'grid', columns: '100px 1fr 2fr' } },
    [
      item({}, { height: 20 }),
      item({}, { height: 20 }),
      item({}, { height: 20 }),
    ],
  );
  assert.deepEqual(out, [
    [0, 0, 100, 20],
    [100, 0, 100, 20],
    [200, 0, 200, 20],
  ]);
});

await check('gaps, and the second row where the third item lands', async () => {
  const { out, size } = await rects(
    { layout: { name: 'grid', columns: '1fr 1fr' }, gap: 10 },
    [box(undefined, 20), box(undefined, 30), box(undefined, 40)],
  );
  // an item with a height of its own keeps it: stretch is for auto heights
  assert.deepEqual(out, [
    [0, 0, 195, 20],
    [205, 0, 195, 30],
    [0, 40, 195, 40],
  ]);
  assert.deepEqual(size, [400, 80]);
});

await check('an auto column is as wide as its widest item', async () => {
  const { out } = await rects(
    { layout: { name: 'grid', columns: 'auto 1fr' }, columnGap: 8 },
    [
      { text: 'Name' },
      box(undefined, 10),
      { text: 'Postal address' },
      box(undefined, 10),
    ],
  );
  const label = out[2][2];
  assert.ok(label > out[0][0], 'the long label is wider than nothing');
  assert.equal(out[0][2], label, 'both labels are the column wide');
  assert.equal(out[1][0], label + 8, 'the field starts past the gap');
  assert.equal(out[1][2], 400 - label - 8, 'and takes the rest');
});

await check('repeat(auto-fill) fits as many as the width holds', async () => {
  const { out } = await rects(
    {
      layout: {
        name: 'grid',
        columns: 'repeat(auto-fill, minmax(100px, 1fr))',
      },
      gap: 10,
    },
    Array.from({ length: 4 }, () => box(undefined, 20)),
    { width: 350 },
  );
  // (350 + 10) / 110 → three columns of (350 - 20) / 3 = 110
  assert.deepEqual(
    out.map((r) => r.slice(0, 3)),
    [
      [0, 0, 110],
      [120, 0, 110],
      [240, 0, 110],
      [0, 30, 110],
    ],
  );
});

await check('repeat(auto-fit) collapses the tracks nothing is in', async () => {
  const { out } = await rects(
    {
      layout: { name: 'grid', columns: 'repeat(auto-fit, minmax(100px, 1fr))' },
      gap: 10,
    },
    [box(undefined, 20), box(undefined, 20)],
    { width: 350 },
  );
  // three tracks fit, one is empty and collapses: the two share 350
  assert.deepEqual(
    out.map((r) => r.slice(0, 3)),
    [
      [0, 0, 170],
      [180, 0, 170],
    ],
  );
});

await check('spans, and auto-placement flowing past them', async () => {
  const { out } = await rects(
    { layout: { name: 'grid', columns: 'repeat(3, 100px)' } },
    [
      item({ column: 'span 2' }, { height: 10 }),
      item({}, { height: 10 }),
      item({}, { height: 10 }),
      item({ column: 3, row: '1 / span 3' }, {}),
    ],
  );
  // the fourth is definite (column 3, rows 1–3), so it is placed first and
  // the auto items flow around it; the third row holds nothing of its own,
  // so it is 0 tall and the fourth spans 10 + 10 + 0
  assert.deepEqual(out, [
    [0, 0, 200, 10],
    [0, 10, 100, 10],
    [100, 10, 100, 10],
    [200, 0, 100, 20],
  ]);
});

await check('dense packing back-fills a hole', async () => {
  const { out } = await rects(
    {
      layout: {
        name: 'grid',
        columns: 'repeat(3, 100px)',
        autoFlow: 'row dense',
      },
    },
    [
      item({}, { height: 10 }),
      item({ column: 'span 3' }, { height: 10 }),
      item({}, { height: 10 }),
    ],
  );
  // sparse would leave columns 2–3 of the first row empty; dense puts the
  // third item there
  assert.deepEqual(out, [
    [0, 0, 100, 10],
    [0, 10, 300, 10],
    [100, 0, 100, 10],
  ]);
});

await check('named areas', async () => {
  const { out, size } = await rects(
    {
      layout: {
        name: 'grid',
        columns: '80px 1fr',
        rows: '30px 1fr',
        areas: ['head head', 'side main'],
      },
      height: 200,
    },
    [item({ area: 'main' }), item({ area: 'head' }), item({ area: 'side' })],
  );
  assert.deepEqual(out, [
    [80, 30, 320, 170],
    [0, 0, 400, 30],
    [0, 30, 80, 170],
  ]);
  assert.deepEqual(size, [400, 200]);
});

await check(
  'a row is as tall as its tallest item, and items stretch',
  async () => {
    // stretch, as in CSS, is for an item whose height is auto: a minHeight
    // is not a height
    const { out } = await rects(
      { layout: { name: 'grid', columns: '1fr 1fr' } },
      [
        item({}, { minHeight: 20 }),
        {
          text: 'a paragraph long enough to wrap at two hundred pixels across',
        },
      ],
    );
    assert.ok(out[1][3] > 20, 'the text wrapped');
    assert.equal(out[0][3], out[1][3], 'the short one stretched');
  },
);

await check('a spanning item grows the auto tracks it spans', async () => {
  const { out } = await rects(
    {
      layout: { name: 'grid', columns: 'auto auto', justifyItems: 'start' },
      alignSelf: 'flex-start',
    },
    [
      box(40, 10),
      box(40, 10),
      item({ column: 'span 2' }, { width: 200, height: 10 }),
    ],
  );
  // 200 across two auto tracks of 40: each grows to 100
  assert.deepEqual(
    out.map((r) => r.slice(0, 3)),
    [
      [0, 0, 40],
      [100, 0, 40],
      [0, 10, 200],
    ],
  );
});

await check('shrink to fit: the host is its max-content width', async () => {
  const { size } = await rects(
    {
      layout: { name: 'grid', columns: 'auto auto' },
      gap: 10,
      alignSelf: 'flex-start',
    },
    [box(60, 10), box(90, 10)],
  );
  assert.equal(size[0], 160);
});

await check('right to left the columns run from the right', async () => {
  const { out } = await rects(
    { layout: { name: 'grid', columns: '100px 1fr' }, direction: 'rtl' },
    [box(undefined, 10), box(undefined, 10)],
  );
  assert.deepEqual(out, [
    [300, 0, 100, 10],
    [0, 0, 300, 10],
  ]);
});

await check('its floor is the min-content of its columns', async () => {
  const { out } = await rects(
    { layout: { name: 'grid', columns: 'auto 1fr' }, columnGap: 10 },
    [{ text: 'Label' }, { text: 'supercalifragilistic word' }],
    { width: 60 },
  );
  // 60 cannot hold them; the fr column holds its longest word and no less
  const [label, field] = out;
  assert.ok(field[2] >= 60, `the field kept its longest word: ${field[2]}`);
  assert.ok(label[2] > 0);
});

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
