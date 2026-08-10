// Calendar and DatePicker: picking a day, picking a span, and the days an
// application has taken off the board.
//
// The grid is pinned to August 2026 throughout, which starts on a Saturday.
// With the week starting on Monday that leaves five days of July in the first
// row, so August's 1st is cell 5 and its Nth is cell N + 4 — worked out here
// rather than read back out of `monthGrid`, so a broken grid cannot agree with
// the test about where it put things.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { Calendar, DatePicker, createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';
import {
  addDays,
  formatDayRange,
  monthGrid,
  toDay,
  weekdayLabels,
} from '../src/components/dates.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
};

const MONTH = '2026-08';
/** Cell index of the Nth of August 2026 in a Monday-first grid. */
const cellOf = (n) => n + 4;

const XK = {
  LEFT: 0xff51,
  UP: 0xff52,
  RIGHT: 0xff53,
  DOWN: 0xff54,
  PAGE_UP: 0xff55,
  PAGE_DOWN: 0xff56,
  RETURN: 0xff0d,
};

/** Every node under `from`, popups included — a `<popup>` is its own X window
 *  but still a child in the tree, which is where the calendar a picker opens
 *  lives. */
function nodes(from, pred) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (pred(node)) out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(from);
  return out;
}

const treeOf = (app) => app.windows[0]._reactX11Node;
const cells = (app) => nodes(treeOf(app), (n) => n.props?.role === 'gridcell');
const texts = (node) =>
  nodes(node, (n) => n.kind === 'text').map((n) => String(n.props.children));
const labelOf = (cell) => texts(cell)[0];

function click(app, node) {
  const window = node.root.window;
  const x = node.abs.x + node.abs.width / 2;
  const y = node.abs.y + node.abs.height / 2;
  window.emit('mousedown', { x, y, keycode: 1 });
  window.emit('mouseup', { x, y, keycode: 1 });
}

function hover(app, node) {
  const window = node.root.window;
  window.emit('mousemove', {
    x: node.abs.x + node.abs.width / 2,
    y: node.abs.y + node.abs.height / 2,
    buttons: 0,
  });
}

function press(app, keysym, { shift = false } = {}) {
  const keycode = (keysym % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym];
  app.windows[0].emit('keydown', { keycode, buttons: shift ? 1 : 0 });
}

async function mount(props, { component = Calendar } = {}) {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { width: 420, height: 460 },
      h(component, { defaultMonth: MONTH, locale: 'en-GB', ...props }),
    ),
  );
  await settle();
  return { app, root };
}

test('the grid is six weeks, Monday first, with the neighbouring days on it', async () => {
  const { app, root } = await mount({});

  const grid = cells(app);
  assert.strictEqual(grid.length, 42, 'six weeks of seven days, always');
  assert.strictEqual(labelOf(grid[0]), '27', 'the Monday before the 1st');
  assert.strictEqual(labelOf(grid[cellOf(1)]), '1');
  assert.strictEqual(labelOf(grid[cellOf(31)]), '31');
  assert.strictEqual(labelOf(grid[41]), '6', 'and on into September');

  await root.unmount();
});

test('clicking a day reports it as a YYYY-MM-DD string', async () => {
  const picked = [];
  const { app, root } = await mount({
    onChange: (ev) => picked.push(ev.value),
  });

  click(app, cells(app)[cellOf(12)]);
  await settle();
  assert.deepStrictEqual(picked, ['2026-08-12']);

  await root.unmount();
});

test('clicking a day of the next month turns the page with it', async () => {
  const months = [];
  const { app, root } = await mount({ onMonthChange: (m) => months.push(m) });

  click(app, cells(app)[41]);
  await settle();
  assert.deepStrictEqual(months, ['2026-09']);
  // September 2026 starts on a Tuesday, so a Monday-first grid opens on
  // August the 31st and the 1st is the cell after it
  assert.strictEqual(labelOf(cells(app)[0]), '31');
  assert.strictEqual(labelOf(cells(app)[1]), '1', 'September the 1st');

  await root.unmount();
});

test('a blocked day answers nothing, and so do the days past min/max', async () => {
  const picked = [];
  const { app, root } = await mount({
    onChange: (ev) => picked.push(ev.value),
    min: '2026-08-05',
    max: '2026-08-20',
    // every Saturday and Sunday
    isDateBlocked: (_day, { weekday }) => weekday === 0 || weekday === 6,
  });

  click(app, cells(app)[cellOf(15)]); // a Saturday
  click(app, cells(app)[cellOf(3)]); // before min
  click(app, cells(app)[cellOf(25)]); // after max
  await settle();
  assert.deepStrictEqual(picked, [], 'none of the three was selectable');

  click(app, cells(app)[cellOf(12)]);
  await settle();
  assert.deepStrictEqual(picked, ['2026-08-12'], 'and a free day still is');

  await root.unmount();
});

test('a range takes two clicks, and reports the half-picked state in between', async () => {
  const picked = [];
  const { app, root } = await mount({
    mode: 'range',
    onChange: (ev) => picked.push(ev.value),
  });

  click(app, cells(app)[cellOf(10)]);
  await settle();
  click(app, cells(app)[cellOf(14)]);
  await settle();

  assert.deepStrictEqual(picked, [
    { start: '2026-08-10', end: null },
    { start: '2026-08-10', end: '2026-08-14' },
  ]);

  await root.unmount();
});

test('clicking before the start re-anchors the range instead of selecting backwards', async () => {
  const picked = [];
  const { app, root } = await mount({
    mode: 'range',
    onChange: (ev) => picked.push(ev.value),
  });

  click(app, cells(app)[cellOf(10)]);
  await settle();
  click(app, cells(app)[cellOf(4)]);
  await settle();

  assert.deepStrictEqual(picked.at(-1), { start: '2026-08-04', end: null });

  await root.unmount();
});

test('a range stops at a blocked day, and spanBlocked lets it across', async () => {
  const blockedWednesday = (day) => day === '2026-08-12';

  const picked = [];
  const { app, root } = await mount({
    mode: 'range',
    onChange: (ev) => picked.push(ev.value),
    isDateBlocked: blockedWednesday,
  });

  click(app, cells(app)[cellOf(10)]);
  await settle();
  click(app, cells(app)[cellOf(14)]); // past the blocked day
  await settle();
  assert.deepStrictEqual(
    picked.at(-1),
    { start: '2026-08-10', end: null },
    'the end past a blocked day was refused',
  );

  click(app, cells(app)[cellOf(11)]); // short of it
  await settle();
  assert.deepStrictEqual(picked.at(-1), {
    start: '2026-08-10',
    end: '2026-08-11',
  });

  await root.unmount();

  const spanned = [];
  const across = await mount({
    mode: 'range',
    spanBlocked: true,
    onChange: (ev) => spanned.push(ev.value),
    isDateBlocked: blockedWednesday,
  });
  click(across.app, cells(across.app)[cellOf(10)]);
  await settle();
  click(across.app, cells(across.app)[cellOf(14)]);
  await settle();
  assert.deepStrictEqual(spanned.at(-1), {
    start: '2026-08-10',
    end: '2026-08-14',
  });

  await across.root.unmount();
});

test('the pointer previews the other end of a half-picked range', async () => {
  const { app, root } = await mount({ mode: 'range' });

  click(app, cells(app)[cellOf(10)]);
  await settle();
  hover(app, cells(app)[cellOf(13)]);
  await settle();

  // the band is an extra box in the cells the range would cover, and in
  // nothing else
  const banded = (n) => cells(app)[n].children.length > 1;
  assert.ok(banded(cellOf(11)), 'a day inside the preview is banded');
  assert.ok(banded(cellOf(13)), 'and so is the end under the pointer');
  assert.ok(!banded(cellOf(14)), 'but nothing past it');
  assert.ok(!banded(cellOf(9)), 'and nothing before the start');

  await root.unmount();
});

test('arrows move a day and a week, and Enter takes the one they land on', async () => {
  const picked = [];
  const { app, root } = await mount({
    defaultValue: '2026-08-10',
    onChange: (ev) => picked.push(ev.value),
  });

  treeOf(app).children[0].focus();
  press(app, XK.RIGHT);
  press(app, XK.DOWN);
  await settle();
  press(app, XK.RETURN);
  await settle();
  assert.deepStrictEqual(picked, ['2026-08-18'], 'one day on, then one week');

  press(app, XK.LEFT);
  press(app, XK.UP);
  await settle();
  press(app, XK.RETURN);
  await settle();
  assert.deepStrictEqual(picked.at(-1), '2026-08-10', 'and back again');

  await root.unmount();
});

test('PageUp/PageDown change the month, with Shift the year', async () => {
  const months = [];
  const { app, root } = await mount({ onMonthChange: (m) => months.push(m) });

  treeOf(app).children[0].focus();
  press(app, XK.PAGE_DOWN);
  await settle();
  press(app, XK.PAGE_UP, { shift: true });
  await settle();

  assert.deepStrictEqual(months, ['2026-09', '2025-09']);

  await root.unmount();
});

test('dayContent draws under the number, and hears what the day is', async () => {
  const seen = new Map();
  const { app, root } = await mount({
    defaultValue: '2026-08-12',
    dayContent: (day, state) => {
      seen.set(day, state);
      return day === '2026-08-12' ? h('text', null, '•') : null;
    },
  });

  assert.strictEqual(seen.size, 42, 'asked once per cell on the grid');
  assert.strictEqual(seen.get('2026-08-12').selected, true);
  assert.strictEqual(seen.get('2026-07-27').outside, true);
  assert.ok(
    texts(cells(app)[cellOf(12)]).includes('•'),
    'and what it returned is in the cell',
  );

  await root.unmount();
});

test('a DatePicker opens its calendar on the press and closes on the pick', async () => {
  const picked = [];
  const { app, root } = await mount(
    { onChange: (ev) => picked.push(ev.value) },
    { component: DatePicker },
  );

  const trigger = treeOf(app).children[0];
  assert.strictEqual(cells(app).length, 0, 'nothing is open yet');

  app.windows[0].emit('mousedown', {
    x: trigger.abs.x + 4,
    y: trigger.abs.y + 4,
    keycode: 1,
  });
  await settle();
  assert.strictEqual(cells(app).length, 42, 'the press alone opened it');

  click(app, cells(app)[cellOf(12)]);
  await settle();
  assert.deepStrictEqual(picked, ['2026-08-12']);
  assert.strictEqual(cells(app).length, 0, 'and picking closed it');

  await root.unmount();
});

test('a range picker stays open until both ends are in', async () => {
  const { app, root } = await mount(
    { mode: 'range' },
    { component: DatePicker },
  );

  const trigger = treeOf(app).children[0];
  app.windows[0].emit('mousedown', {
    x: trigger.abs.x + 4,
    y: trigger.abs.y + 4,
    keycode: 1,
  });
  await settle();

  click(app, cells(app)[cellOf(10)]);
  await settle();
  assert.strictEqual(cells(app).length, 42, 'still up for the other end');

  click(app, cells(app)[cellOf(14)]);
  await settle();
  assert.strictEqual(cells(app).length, 0);
  assert.strictEqual(
    texts(treeOf(app))[0],
    formatDayRange('2026-08-10', '2026-08-14', 'en-GB'),
    'and the trigger says so',
  );

  await root.unmount();
});

test('a day is a string, a Date is read as its local day, and rubbish throws', () => {
  assert.strictEqual(toDay('2026-08-07'), '2026-08-07');
  assert.strictEqual(toDay(new Date(2026, 7, 7)), '2026-08-07');
  assert.strictEqual(toDay(null), null);
  assert.throws(() => toDay('7/8/2026'), /YYYY-MM-DD/);
  assert.throws(() => toDay('2026-02-30'), /not a real calendar date/);
  assert.strictEqual(addDays('2026-02-28', 1), '2026-03-01');
  assert.strictEqual(addDays('2024-02-28', 1), '2024-02-29', 'a leap year');
});

test('the week starts where the caller says, and the labels follow', () => {
  const [first] = monthGrid(MONTH, 0);
  assert.strictEqual(first[0], '2026-07-26', 'a Sunday-first grid');
  assert.strictEqual(monthGrid(MONTH, 1)[0][0], '2026-07-27');
  assert.deepStrictEqual(weekdayLabels('en-GB', 1).slice(0, 2), ['Mon', 'Tue']);
  assert.strictEqual(weekdayLabels('en-GB', 0)[0], 'Sun');
});

test('the month nav points, announces and steps the same way', async () => {
  // Three things that have to agree and had drifted apart: `direction` was
  // `'left'`/`'right'` while `NavButton` tested `direction < 0`, so both
  // buttons announced "Next month" — and once the icon set took the same
  // test over from `direction === 'left'`, both drew a right-pointing
  // chevron too. Only the click was ever right.
  const { app, root } = await mount({});

  const buttons = nodes(
    treeOf(app),
    (n) =>
      n.props?.role === 'button' && n.props['aria-label']?.endsWith(' month'),
  );
  assert.deepStrictEqual(
    buttons.map((b) => b.props['aria-label']),
    ['Previous month', 'Next month'],
    'one of each, in reading order',
  );

  // The glyph, read off the node rather than off the source: the icon set
  // keys its cache by name, which is the drawing it is about to paint.
  const glyphOf = (button) =>
    nodes(button, (n) => n.kind === 'canvas')[0]?.props.cacheKey;
  assert.strictEqual(glyphOf(buttons[0]), 'chevronLeft', 'back points back');
  assert.strictEqual(glyphOf(buttons[1]), 'chevronRight', 'on points on');

  // and the press goes the way the arrow does
  click(app, buttons[0]);
  await settle();
  assert.ok(
    texts(treeOf(app)).some((t) => t.includes('July')),
    `back should reach July: ${texts(treeOf(app)).slice(0, 3).join(' ')}`,
  );

  click(app, buttons[1]);
  click(app, buttons[1]);
  await settle();
  assert.ok(
    texts(treeOf(app)).some((t) => t.includes('September')),
    'and on should reach September',
  );

  await root.unmount();
});
