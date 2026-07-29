// Window size queries: the X11 analogue of @media. What a style can usefully
// ask about here is the window it is laid out in, not the screen.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import ReactX11 from '../src/index.js';
import { createStyles } from '../src/styles.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const nodeOf = (app) => app.windows[0]._reactX11Node;

const responsive = createStyles({
  bar: {
    flexDirection: 'column',
    gap: 4,
    '@width >= 600': { flexDirection: 'row', gap: 16 },
  },
});

function mount(width) {
  const app = createMockApp();
  ReactX11.render(
    h(
      'window',
      { width, height: 300 },
      h(
        'box',
        { style: responsive.bar },
        h('box', { key: 'a', style: { width: 10, height: 10 } }),
        h('box', { key: 'b', style: { width: 10, height: 10 } }),
      ),
    ),
    null,
    app,
  );
  return app;
}

test('a size query matches against the window it is laid out in', async () => {
  const narrow = mount(400);
  await tick();
  assert.strictEqual(nodeOf(narrow).children[0].style.flexDirection, 'column');
  assert.strictEqual(nodeOf(narrow).children[0].style.gap, 4);
  ReactX11.unmountComponentAtNode(narrow);

  const wide = mount(800);
  await tick();
  assert.strictEqual(nodeOf(wide).children[0].style.flexDirection, 'row');
  assert.strictEqual(nodeOf(wide).children[0].style.gap, 16);
  ReactX11.unmountComponentAtNode(wide);
});

test('resizing the window re-evaluates, and relays out', async () => {
  const app = mount(400);
  await tick();
  const box = nodeOf(app).children[0];
  assert.strictEqual(box.style.flexDirection, 'column');

  // what a real ConfigureNotify does
  const wnd = app.windows[0];
  wnd.width = 800;
  wnd.emit('resize', { width: 800, height: 300 });
  await tick();

  assert.strictEqual(box.style.flexDirection, 'row', 'the query now matches');
  assert.strictEqual(box.style.gap, 16);
  // and the change reached yoga, not just the style bag: side by side with
  // the wide gap, rather than stacked with the narrow one
  const [a, b] = box.children;
  assert.strictEqual(a.abs.y, b.abs.y, 'the two boxes share a row');
  assert.strictEqual(b.abs.x - a.abs.x, 26, '10 wide plus the 16 gap');

  wnd.width = 400;
  wnd.emit('resize', { width: 400, height: 300 });
  await tick();
  assert.strictEqual(box.style.flexDirection, 'column', 'and back again');
  assert.strictEqual(
    box.children[1].abs.y - box.children[0].abs.y,
    14,
    'stacked again, with the narrow gap',
  );

  ReactX11.unmountComponentAtNode(app);
});

test('size queries may carry layout properties, unlike state blocks', () => {
  // the rule: a pointer state must never reflow the tree, but a size query
  // is only re-evaluated inside a layout pass the resize already required
  createStyles({ a: { '@width >= 600': { padding: 20, flexGrow: 2 } } });
  assert.throws(
    () => createStyles({ b: { ':hover': { padding: 20 } } }),
    /not allowed inside ":hover"/,
  );
});

test('a bad query is an error that shows the shape', () => {
  assert.throws(
    () => createStyles({ a: { '@width => 600': {} } }),
    /bad size query "@width => 600"/,
  );
  assert.throws(
    () => createStyles({ a: { '@depth >= 600': {} } }),
    /bad size query/,
  );
});

test('a state block inside the matched size still wins', async () => {
  const app = createMockApp();
  ReactX11.render(
    h(
      'window',
      { width: 800, height: 300 },
      h('box', {
        style: {
          backgroundColor: 'white',
          '@width >= 600': { backgroundColor: 'grey' },
          ':hover': { backgroundColor: 'red' },
        },
        focusable: true,
      }),
    ),
    null,
    app,
  );
  await tick();
  const box = nodeOf(app).children[0];
  assert.strictEqual(box.style.backgroundColor, 'grey');

  box.setStyleState(':hover', true);
  assert.strictEqual(
    box.style.backgroundColor,
    'red',
    'state blocks fold in after the size, so hover wins',
  );

  ReactX11.unmountComponentAtNode(app);
});

test('a node mounted after a resize matches the size the window is now', async () => {
  const app = createMockApp();
  const render = (extra) =>
    ReactX11.render(
      h(
        'window',
        { width: 800, height: 300 },
        h(
          'box',
          { style: { flexGrow: 1 } },
          ...(extra ? [h('box', { style: responsive.bar })] : []),
        ),
      ),
      null,
      app,
    );

  render(false);
  await tick();
  render(true);
  await tick();

  const late = nodeOf(app).children[0].children[0];
  assert.strictEqual(
    late.style.flexDirection,
    'row',
    'it did not miss the query just because it arrived late',
  );

  ReactX11.unmountComponentAtNode(app);
});

test('a query that hides a node takes it out of the paint too', async () => {
  const app = createMockApp();
  ReactX11.render(
    h(
      'window',
      { width: 400, height: 200 },
      h(
        'box',
        { style: { flexDirection: 'row', flexGrow: 1 } },
        h('box', { style: { width: 20, height: 20, backgroundColor: 'red' } }),
        h('box', {
          style: {
            width: 20,
            height: 20,
            backgroundColor: 'blue',
            '@width < 520': { display: 'none' },
          },
        }),
      ),
    ),
    null,
    app,
  );
  await tick();

  const row = nodeOf(app).children[0];
  const hidden = row.children[1];
  assert.strictEqual(hidden.style.display, 'none', 'the query matched');
  assert.strictEqual(
    row.paintOrder().length,
    1,
    'display:none leaves the paint as well as the layout — it used to keep ' +
      'painting at the position it no longer had',
  );
  assert.strictEqual(hidden.hitTest(5, 5), null, 'and takes no pointer input');

  ReactX11.unmountComponentAtNode(app);
});
