// Table: a header that stays put, resizable columns, and only the rows in
// view actually built.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot, Table } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
// layout, then the deferred onViewport, then the render it causes
const settle = async () => {
  for (let i = 0; i < 4; i++) await tick();
};
const root = (app) => app.windows[0]._reactX11Node;

const XK = { HOME: 0xff50, UP: 0xff52, DOWN: 0xff54, END: 0xff57 };

/** The table holds the focus itself — see the note in Table.js. */
const focusTable = (app) =>
  find(app.windows[0]._reactX11Node, (n) => n.props.focusable)?.focus();

function press(app, keysym) {
  const keycode = (keysym % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym];
  app.windows[0].emit('keydown', { keycode, buttons: 0 });
}

const find = (node, pred) =>
  pred(node)
    ? node
    : node.children.reduce(
        (a, c) => a || (c.isWindow ? null : find(c, pred)),
        null,
      );

const texts = (app) => {
  const out = [];
  const walk = (n) => {
    if (n.kind === 'text') out.push(String(n.props.children));
    n.children.forEach((c) => !c.isWindow && walk(c));
  };
  walk(root(app));
  return out;
};

const COLUMNS = [
  { id: 'name', label: 'Name', width: 120 },
  { id: 'size', label: 'Size', width: 80, align: 'right' },
];

const makeRows = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `file-${String(i).padStart(4, '0')}.js`,
    size: (i * 37) % 1000,
  }));

async function mount(props, rowCount = 8, height = 200) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 300, height },
      h(Table, { columns: COLUMNS, rows: makeRows(rowCount), ...props }),
    ),
  );
  return app;
}

test('renders a header and the rows under it', async () => {
  const app = await mount({}, 3);
  const x11Root = await createRoot({ app });
  await settle();
  const shown = texts(app);
  assert.ok(shown.includes('Name') && shown.includes('Size'), 'header labels');
  assert.ok(shown.includes('file-0000.js'));
  assert.ok(shown.includes('file-0002.js'));

  await x11Root.unmount();
});

test('only the rows in view are built', async () => {
  // 10k rows in a 200px window: about eight fit, plus the overscan
  const app = await mount({}, 10_000);
  const x11Root = await createRoot({ app });
  await settle();

  const built = texts(app).filter((t) => t.endsWith('.js')).length;
  assert.ok(built > 0, 'something rendered');
  assert.ok(
    built < 40,
    `only the visible slice is built, got ${built} rows for 10,000`,
  );
  assert.ok(texts(app).includes('file-0000.js'), 'starting at the top');

  await x11Root.unmount();
});

test('the first render, before anything is measured, is still bounded', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  // no awaits: this is the tree as the very first commit leaves it, before
  // layout has run and onViewport could have said how tall the viewport is.
  // Rendering "all of them" here put 130,000 nodes in the tree and froze the
  // window for the best part of a second.
  x11Root.render(
    h(
      'window',
      { width: 300, height: 200 },
      h(Table, { columns: COLUMNS, rows: makeRows(10_000) }),
    ),
  );

  let nodes = 0;
  const walk = (n) => {
    nodes++;
    n.children.forEach((c) => !c.isWindow && walk(c));
  };
  walk(root(app));
  assert.ok(nodes < 1000, `first commit built ${nodes} nodes for 10,000 rows`);

  await x11Root.unmount();
});

test('the scrollbar still measures the whole list', async () => {
  const app = await mount({}, 10_000);
  const x11Root = await createRoot({ app });
  await settle();
  const body = find(root(app), (n) => n.isScroller?.());

  assert.strictEqual(
    body.contentHeight,
    10_000 * 24,
    'the spacers stand in for the rows that were not built',
  );

  await x11Root.unmount();
});

test('scrolling swaps which rows exist', async () => {
  const app = await mount({}, 10_000);
  const x11Root = await createRoot({ app });
  await settle();
  const body = find(root(app), (n) => n.isScroller?.());

  body.scrollTo({ y: 24 * 500 });
  await settle();

  const shown = texts(app);
  assert.ok(shown.includes('file-0500.js'), 'the rows at that offset exist');
  assert.ok(!shown.includes('file-0000.js'), 'and the ones at the top do not');

  await x11Root.unmount();
});

test('clicking a header sorts, and clicking again reverses', async () => {
  const changes = [];
  const app = await mount({ onSortChange: (next) => changes.push(next) }, 4);
  const x11Root = await createRoot({ app });
  await settle();

  const header = find(
    root(app),
    (n) => n.kind === 'text' && String(n.props.children) === 'Size',
  ).parent;
  const click = (node) => {
    const x = node.abs.x + 4;
    const y = node.abs.y + node.abs.height / 2;
    app.windows[0].emit('mousedown', { x, y, keycode: 1 });
    app.windows[0].emit('mouseup', { x, y, keycode: 1 });
  };

  click(header);
  await settle();
  assert.deepStrictEqual(changes.at(-1), { column: 'size', direction: 'asc' });
  const asc = texts(app)
    .filter((t) => /^\d+$/.test(t))
    .map(Number);
  assert.deepStrictEqual(
    [...asc].sort((a, b) => a - b),
    asc,
    'ascending',
  );

  click(header);
  await settle();
  assert.deepStrictEqual(changes.at(-1), { column: 'size', direction: 'desc' });
  const desc = texts(app)
    .filter((t) => /^\d+$/.test(t))
    .map(Number);
  assert.deepStrictEqual(
    [...desc].sort((a, b) => b - a),
    desc,
    'descending',
  );

  await x11Root.unmount();
});

test('Up/Down move the selection, Home/End jump to the ends', async () => {
  const picked = [];
  const app = await mount(
    { onSelect: (id) => picked.push(id), defaultSelected: 0 },
    50,
  );
  const x11Root = await createRoot({ app });
  await settle();
  focusTable(app);

  press(app, XK.DOWN);
  press(app, XK.DOWN);
  await settle();
  assert.deepStrictEqual(picked, [1, 2], 'two presses, two rows');

  press(app, XK.END);
  await settle();
  assert.strictEqual(picked.at(-1), 49);
  press(app, XK.HOME);
  await settle();
  assert.strictEqual(picked.at(-1), 0);

  await x11Root.unmount();
});

test('the selection is kept on screen, even when it is not built yet', async () => {
  const app = await mount({ defaultSelected: 0 }, 10_000);
  const x11Root = await createRoot({ app });
  await settle();
  const body = find(root(app), (n) => n.isScroller?.());
  focusTable(app);

  press(app, XK.END);
  await settle();

  assert.ok(
    body.scrollY > 24 * 9000,
    `scrolled to the end of the list, got ${body.scrollY}`,
  );
  assert.ok(texts(app).includes('file-9999.js'), 'and that row now exists');

  await x11Root.unmount();
});

test('dragging a header grip resizes that column', async () => {
  const resized = [];
  const app = await mount(
    { onColumnResize: (id, w) => resized.push([id, w]) },
    4,
  );
  const x11Root = await createRoot({ app });
  await settle();

  const grip = find(root(app), (n) => n.style.cursor === 'col-resize');
  const y = grip.abs.y + grip.abs.height / 2;
  app.windows[0].emit('mousedown', { x: grip.abs.x + 2, y, keycode: 1 });
  app.windows[0].emit('mousemove', { x: grip.abs.x + 62, y });
  await settle();

  assert.deepStrictEqual(resized.at(-1), ['name', 180], '120 + 60');
  const cell = find(
    root(app),
    (n) => n.kind === 'text' && String(n.props.children) === 'file-0000.js',
  ).parent;
  assert.strictEqual(cell.abs.width, 180, 'the body column followed');

  app.windows[0].emit('mouseup', { x: grip.abs.x + 62, y, keycode: 1 });
  await x11Root.unmount();
});

test('the header scrolls sideways with the body but not down', async () => {
  const app = await mount({}, 40, 120);
  const x11Root = await createRoot({ app });
  await settle();
  const body = find(root(app), (n) => n.isScroller?.());
  const header = find(
    root(app),
    (n) => n.kind === 'text' && String(n.props.children) === 'Name',
  ).parent;
  const headerY = header.abs.y;

  body.scrollTo({ y: 200 });
  await settle();
  assert.strictEqual(header.abs.y, headerY, 'it stayed put vertically');

  await x11Root.unmount();
});

test('clicking a row selects it', async () => {
  const picked = [];
  const app = await mount(
    { onSelect: (id, row) => picked.push([id, row.name]) },
    6,
  );
  const x11Root = await createRoot({ app });
  await settle();

  const cell = find(
    root(app),
    (n) => n.kind === 'text' && String(n.props.children) === 'file-0003.js',
  ).parent;
  const x = cell.abs.x + 10;
  const y = cell.abs.y + cell.abs.height / 2;
  app.windows[0].emit('mousedown', { x, y, keycode: 1 });
  app.windows[0].emit('mouseup', { x, y, keycode: 1 });
  await settle();

  assert.deepStrictEqual(picked, [[3, 'file-0003.js']]);

  await x11Root.unmount();
});
