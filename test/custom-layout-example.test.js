// examples/custom-layout.jsx — a pinboard arranged by the built-in
// `masonry`, by a `justified` layout the example registers, and by
// flex-wrap for comparison.
//
// What these pin is what the example is for: the masonry drops each pin
// into the shortest column and a featured pin spans two, the justified rows
// each fill the width at one height, the segmented controls are equal-width
// and squeeze to their floor and no further, and right to left mirrors all
// of it without either algorithm knowing.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  waitFor,
  userEvent,
  XK_SPACE,
} from '../src/testing/index.js';

process.env.REACT_X11_NO_AUTORUN = '1';

const { PinboardPanel, buildPins } =
  await import('../examples/custom-layout.jsx');

const require = createRequire(import.meta.url);
const FONT = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
  'KaTeX_Main-Regular.ttf',
);
const fonts = { 'sans-serif': FONT };

afterEach(cleanup);

const h = React.createElement;

const COUNT = 12;
const GAP = 12; // the board's padding, and the masonry's gap
const PIN = 200;
const SEGMENT_INSET = 2 * 10 + 2 * 1; // a segment's padding and border

async function mount({ width = 700, height = 480, direction } = {}) {
  const panel = h(PinboardPanel, { pins: buildPins(COUNT) });
  await renderX11(
    direction ? h('box', { style: { flexGrow: 1, direction } }, panel) : panel,
    { fonts, width, height },
  );
  await waitFor(() => {
    assert.ok(byName('board').abs.height > 0, 'not laid out yet');
  });
}

const byName = (name) => screen.getByTestName(name);
const near = (a, b, within = 1) => Math.abs(a - b) <= within;

/** The board's content width: the room the layout arranges in. */
const inner = () => byName('board').abs.width - 2 * GAP;

/** Every pin's rect, from the corner of the board's content box. */
function pinRects() {
  const board = byName('board').abs;
  return Array.from({ length: COUNT }, (_, i) => {
    const { abs } = byName(`pin-p${i}`);
    return {
      x: abs.x - board.x - GAP,
      y: abs.y - board.y - GAP,
      w: abs.width,
      h: abs.height,
    };
  });
}

function assertApart(rects) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      assert.ok(
        a.x + a.w <= b.x ||
          b.x + b.w <= a.x ||
          a.y + a.h <= b.y ||
          b.y + b.h <= a.y,
        `pins ${i} and ${j} overlap: ${JSON.stringify([a, b])}`,
      );
    }
  }
}

/** No holes: every pin below the top edge sits a gap under one it overlaps. */
function assertPacked(rects) {
  rects.forEach((r, i) => {
    if (r.y === 0) return;
    const under = rects.some(
      (o) => near(o.y + o.h + GAP, r.y) && o.x < r.x + r.w && r.x < o.x + o.w,
    );
    assert.ok(under, `pin ${i} at y=${r.y} rests on nothing`);
  });
}

/** Rows, top to bottom, each a list of pin indices. */
function rowsOf(rects) {
  const rows = new Map();
  rects.forEach((r, i) => {
    if (!rows.has(r.y)) rows.set(r.y, []);
    rows.get(r.y).push(i);
  });
  return [...rows.keys()].sort((a, b) => a - b).map((y) => rows.get(y));
}

test('masonry drops each pin into the shortest column, as many columns as fit', async () => {
  await mount();
  const width = inner();
  const cols = Math.floor((width + GAP) / (PIN + GAP));
  assert.equal(cols, 3, `a board ${width} wide holds three columns`);
  const column = (width - GAP * (cols - 1)) / cols;
  const rects = pinRects();
  rects.forEach((r, i) => {
    assert.ok(near(r.w, column), `pin ${i} is ${r.w} wide, a column ${column}`);
    const k = Math.round(r.x / (column + GAP));
    assert.ok(near(r.x, k * (column + GAP)), `pin ${i} is in a column`);
  });
  // the first three open the columns, left to right…
  assert.deepEqual(
    rects.slice(0, 3).map((r) => r.y),
    [0, 0, 0],
  );
  assert.ok(rects[0].x < rects[1].x && rects[1].x < rects[2].x);
  // …and the fourth goes under whichever of them is shortest
  const bottoms = rects.slice(0, 3).map((r) => r.y + r.h);
  const shortest = bottoms.indexOf(Math.min(...bottoms));
  assert.equal(rects[3].x, rects[shortest].x);
  assertPacked(rects);
  assertApart(rects);
});

test('a featured pin spans two columns, and the rest pack around it', async () => {
  await mount();
  const column = (inner() - 2 * GAP) / 3;
  await userEvent.click(byName('pin-p1'));
  assert.equal(byName('pin-p1').props['aria-pressed'], true);
  let rects = pinRects();
  assert.ok(near(rects[1].w, 2 * column + GAP), `spans two: ${rects[1].w}`);
  assertPacked(rects);
  assertApart(rects);

  // Space on the focused pin takes it back
  await userEvent.key(XK_SPACE);
  assert.equal(byName('pin-p1').props['aria-pressed'], false);
  rects = pinRects();
  assert.ok(near(rects[1].w, column), 'one column again');
  assertPacked(rects);
});

test('a column count shares the width between that many', async () => {
  await mount();
  await userEvent.click(byName('columns-2'));
  const column = (inner() - GAP) / 2;
  const rects = pinRects();
  assert.equal(new Set(rects.map((r) => r.x)).size, 2);
  rects.forEach((r, i) => assert.ok(near(r.w, column), `pin ${i}`));
  assertPacked(rects);
  assertApart(rects);
});

test('justified rows each fill the width at one height, each photo as wide as its aspect', async () => {
  await mount();
  await userEvent.click(byName('arrangement-justified'));
  const width = inner();
  const pins = buildPins(COUNT);
  const check = (rowHeight) => {
    const rects = pinRects();
    const rows = rowsOf(rects);
    assert.ok(rows.length > 1, 'more than one row');
    rows.forEach((row, n) => {
      const first = rects[row[0]];
      const last = rects[row.at(-1)];
      assert.equal(first.x, 0, `row ${n} starts at the edge`);
      for (const i of row) {
        assert.equal(rects[i].h, first.h, `row ${n} is one height`);
        assert.ok(
          near(rects[i].w, pins[i].aspect * rects[i].h, 2),
          `pin ${i} keeps its aspect: ${rects[i].w}×${rects[i].h}`,
        );
      }
      assert.ok(first.h <= rowHeight, `row ${n} is no taller than the rows`);
      const full = near(last.x + last.w, width, 2);
      if (n < rows.length - 1) {
        assert.ok(full, `row ${n} fills the width`);
      } else {
        assert.ok(
          full || first.h === rowHeight,
          'the last row is not blown up',
        );
      }
    });
    assertApart(rects);
    return rects;
  };
  const medium = check(160);
  await userEvent.click(byName('row-height-large'));
  const large = check(220);
  assert.ok(large[0].h > medium[0].h, 'a taller row height makes taller rows');

  // featured, a photo takes twice its share of the row
  await userEvent.click(byName('pin-p0'));
  const featured = pinRects()[0];
  assert.ok(
    near(featured.w, 2 * pins[0].aspect * featured.h, 2),
    `twice as wide: ${featured.w}×${featured.h}`,
  );
});

test('flex-wrap lines the pins up in rows; back to masonry they pack again', async () => {
  await mount();
  await userEvent.click(byName('arrangement-wrap'));
  const perRow = Math.floor((inner() + GAP) / (PIN + GAP));
  const wrapped = pinRects();
  wrapped.forEach((r, i) => assert.equal(r.w, PIN, `pin ${i}`));
  const first = wrapped.slice(0, perRow);
  for (const r of first) assert.equal(r.y, 0);
  const tallest = Math.max(...first.map((r) => r.y + r.h));
  assert.equal(
    wrapped[perRow].y,
    tallest + GAP,
    'the second row starts under the tallest of the first',
  );

  await userEvent.click(byName('arrangement-masonry'));
  const packed = pinRects();
  assertPacked(packed);
  assertApart(packed);
  assert.ok(
    packed[perRow].y < wrapped[perRow].y,
    'the masonry fills the hole the row left',
  );
});

test('a segmented control is equal-row: squeezed to its longest word and no further', async () => {
  const segments = () =>
    ['masonry', 'justified', 'wrap'].map((v) => byName(`arrangement-${v}`).abs);
  const labels = () =>
    ['Masonry', 'Justified rows', 'Flex wrap'].map(
      (t) => screen.getByText(t).abs.width,
    );

  await mount({ width: 900 });
  const wide = segments();
  assert.ok(
    wide.every((a) => a.width === wide[0].width),
    `equal: ${wide.map((a) => a.width)}`,
  );
  // every label on one line, and the widest sets the width
  assert.ok(near(wide[0].width, Math.max(...labels()) + SEGMENT_INSET));
  cleanup();

  await mount({ width: 300 });
  const narrow = segments();
  assert.ok(
    narrow.every((a) => a.width === narrow[0].width),
    `still equal: ${narrow.map((a) => a.width)}`,
  );
  assert.ok(narrow[0].width < wide[0].width, 'squeezed');
  // at the floor: the widest line of any label — its longest word — fits
  // with nothing to spare
  const room = narrow[0].width - SEGMENT_INSET;
  const lines = labels();
  assert.ok(
    lines.every((w) => w <= room),
    `no label is cut: ${lines} in ${room}`,
  );
  assert.ok(near(Math.max(...lines), room), 'and no room to spare');
  // the labels that wrapped made their segments taller, and stretch made
  // all three as tall
  assert.ok(narrow.every((a) => a.height === narrow[0].height));
  assert.ok(narrow[0].height > wide[0].height, 'the labels wrapped');
});

test('right to left the board and the controls mirror, and neither algorithm knew', async () => {
  await mount({ direction: 'rtl' });
  const width = inner();
  let rects = pinRects();
  assert.ok(
    near(rects[0].x + rects[0].w, width),
    'the first column is at the right',
  );
  assert.ok(rects[0].x > rects[1].x && rects[1].x > rects[2].x);
  assertPacked(rects);
  assertApart(rects);
  assert.ok(
    byName('arrangement-masonry').abs.x > byName('arrangement-wrap').abs.x,
    'the segments run right to left',
  );

  await userEvent.click(byName('arrangement-justified'));
  rects = pinRects();
  assert.ok(
    near(rects[0].x + rects[0].w, width, 2),
    'the first row starts at the right',
  );
  assert.ok(rects[1].x < rects[0].x);
});
