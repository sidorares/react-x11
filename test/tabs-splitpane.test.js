// Tabs and SplitPane: the two container controls an application window
// needs before anything else.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot, SplitPane, Tabs } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
// a state update from a key press lands a render *and* a layout flush later
const settle = async () => {
  await tick();
  await tick();
};
const root = (app) => app.windows[0]._reactX11Node;

const XK = {
  LEFT: 0xff51,
  UP: 0xff52,
  RIGHT: 0xff53,
  DOWN: 0xff54,
  HOME: 0xff50,
  END: 0xff57,
};

function press(app, wnd, keysym, codepoint) {
  const keycode = (keysym % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym];
  wnd.emit('keydown', { keycode, codepoint, buttons: 0 });
}

const find = (node, pred) =>
  pred(node)
    ? node
    : node.children.reduce(
        (a, c) => a || (c.isWindow ? null : find(c, pred)),
        null,
      );

const labelled = (node, text) =>
  find(node, (n) => n.kind === 'text' && String(n.props.children) === text)
    ?.parent;

/** A real press, so the update runs at discrete priority and flushes the
 * way it does for a user — calling the handler by hand schedules a
 * concurrent update a single tick would not deliver. */
const click = (wnd, node) => {
  const x = node.abs.x + node.abs.width / 2;
  const y = node.abs.y + node.abs.height / 2;
  wnd.emit('mousedown', { x, y, keycode: 1 });
  wnd.emit('mouseup', { x, y, keycode: 1 });
};

const ITEMS = [
  { id: 'one', label: 'One', content: h('text', null, 'first panel') },
  { id: 'two', label: 'Two', disabled: true, content: h('text', null, 'nope') },
  { id: 'three', label: 'Three', content: h('text', null, 'third panel') },
];

async function mountTabs(props) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 300, height: 200 },
      h(Tabs, { items: ITEMS, ...props }),
    ),
  );
  return app;
}

const panelText = (app) =>
  find(
    root(app),
    (n) => n.kind === 'text' && /panel/.test(String(n.props.children)),
  )?.props.children;

test('Tabs shows one panel, and clicking a tab switches it', async () => {
  const app = await mountTabs();
  const x11Root = await createRoot({ app });
  await tick();
  assert.strictEqual(panelText(app), 'first panel', 'the first enabled tab');

  click(app.windows[0], labelled(root(app), 'Three'));
  await tick();
  assert.strictEqual(panelText(app), 'third panel');

  await x11Root.unmount();
});

test('arrows move and wrap, skipping disabled tabs', async () => {
  const changes = [];
  const app = await mountTabs({ onChange: (id) => changes.push(id) });
  const x11Root = await createRoot({ app });
  await tick();
  const wnd = app.windows[0];
  labelled(root(app), 'One').focus();

  press(app, wnd, XK.RIGHT);
  await tick();
  assert.deepStrictEqual(
    changes,
    ['three'],
    'the disabled tab is stepped over',
  );
  assert.strictEqual(panelText(app), 'third panel');

  press(app, wnd, XK.RIGHT);
  await tick();
  assert.deepStrictEqual(changes, ['three', 'one'], 'and it wraps round');

  press(app, wnd, XK.END);
  await tick();
  assert.strictEqual(changes.at(-1), 'three', 'End goes to the last enabled');
  press(app, wnd, XK.HOME);
  await tick();
  assert.strictEqual(changes.at(-1), 'one');

  await x11Root.unmount();
});

test('a disabled tab is not focusable and cannot be selected', async () => {
  const app = await mountTabs();
  const x11Root = await createRoot({ app });
  await tick();
  const two = labelled(root(app), 'Two');
  assert.strictEqual(two.props.focusable, false);
  click(app.windows[0], two);
  await tick();
  assert.strictEqual(panelText(app), 'first panel', 'the click did nothing');
  await x11Root.unmount();
});

test('manual mode moves focus without selecting until Enter', async () => {
  const app = await mountTabs({ manual: true });
  const x11Root = await createRoot({ app });
  await tick();
  const wnd = app.windows[0];
  labelled(root(app), 'One').focus();

  press(app, wnd, XK.RIGHT);
  await tick();
  assert.strictEqual(
    panelText(app),
    'first panel',
    'still showing the old panel',
  );

  press(app, wnd, 0xff0d); // Return
  await tick();
  assert.strictEqual(panelText(app), 'third panel', 'Enter commits it');

  await x11Root.unmount();
});

test('vertical Tabs use Up/Down instead', async () => {
  const app = await mountTabs({ orientation: 'vertical' });
  const x11Root = await createRoot({ app });
  await tick();
  const wnd = app.windows[0];
  labelled(root(app), 'One').focus();

  press(app, wnd, XK.RIGHT);
  await tick();
  assert.strictEqual(panelText(app), 'first panel', 'Right does nothing');
  press(app, wnd, XK.DOWN);
  await tick();
  assert.strictEqual(panelText(app), 'third panel');

  await x11Root.unmount();
});

test('content given as a function is only built while selected', async () => {
  let built = 0;
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 300, height: 200 },
      h(Tabs, {
        items: [
          { id: 'a', label: 'A', content: h('text', null, 'a panel') },
          {
            id: 'b',
            label: 'B',
            content: () => {
              built++;
              return h('text', null, 'b panel');
            },
          },
        ],
      }),
    ),
  );
  await tick();
  assert.strictEqual(built, 0, 'the hidden panel was never built');

  click(app.windows[0], labelled(root(app), 'B'));
  await tick();
  assert.ok(built > 0, 'and is built once shown');

  await x11Root.unmount();
});

// --- SplitPane -------------------------------------------------------------

async function mountSplit(props) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 400, height: 200 },
      h(
        SplitPane,
        { defaultSize: 100, ...props },
        h('box', { style: { flexGrow: 1, backgroundColor: 'red' } }),
        h('box', { style: { flexGrow: 1, backgroundColor: 'blue' } }),
      ),
    ),
  );
  return app;
}

const divider = (app) =>
  find(root(app), (n) => /resize$/.test(n.style.cursor ?? ''));

test('SplitPane sizes the first pane and gives the rest to the second', async () => {
  const app = await mountSplit();
  const x11Root = await createRoot({ app });
  await tick();
  const [first, , second] = root(app).children[0].children;
  assert.strictEqual(first.abs.width, 100);
  assert.strictEqual(second.abs.width, 400 - 100 - 6, 'the divider takes 6');
  assert.strictEqual(first.abs.height, 200, 'panes fill across the other axis');

  await x11Root.unmount();
});

test('the second pane does not grow to fit content wider than it', async () => {
  // Yoga defaults flexShrink to 0 where CSS defaults it to 1, so a pane left
  // at `flexBasis: auto` takes its content's max-content width as a base and
  // then cannot shrink back to the space actually available. The symptom is a
  // wrapping row that never wraps and overflows the window instead, which is
  // invisible in the empty-pane test above: with no content there is no
  // natural width for the basis to pick up.
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 400, height: 200 },
      h(
        SplitPane,
        { defaultSize: 100 },
        h('box', null),
        // three 100px cards: 300 of content in the 294 the pane actually has,
        // so two fit on a line and the third has to wrap
        h(
          'box',
          { style: { flexDirection: 'row', flexWrap: 'wrap' } },
          [0, 1, 2].map((i) =>
            h('box', { key: i, style: { width: 100, height: 30 } }),
          ),
        ),
      ),
    ),
  );
  await tick();

  const [, , second] = root(app).children[0].children;
  assert.strictEqual(
    second.abs.width,
    400 - 100 - 6,
    'the pane is the space left over, not its content width',
  );

  const cards = [];
  find(root(app), (n) => {
    if (n.abs?.width === 100 && n.abs?.height === 30) cards.push(n.abs);
    return false;
  });
  assert.strictEqual(cards.length, 3);
  const lines = new Set(cards.map((c) => c.y));
  assert.strictEqual(lines.size, 2, 'the third card wrapped to a second line');
  for (const card of cards) {
    assert.ok(
      card.x + card.width <= 400,
      `card at x=${card.x} stays inside the 400px window`,
    );
  }

  await x11Root.unmount();
});

test('dragging the divider resizes, and clamps at both minimums', async () => {
  const sizes = [];
  const app = await mountSplit({
    onResize: (n) => sizes.push(n),
    min: 50,
    minSecond: 80,
  });
  const x11Root = await createRoot({ app });
  await tick();
  const wnd = app.windows[0];
  const d = divider(app);

  // settle(), not tick(): a drag's moves are continuous priority, so the
  // render lands from a scheduler task and the layout flush after it — the
  // same "render *and* a layout flush later" the helper was written for
  wnd.emit('mousedown', { x: d.abs.x + 3, y: 100, keycode: 1 });
  wnd.emit('mousemove', { x: 250, y: 100 });
  await settle();
  const [first] = root(app).children[0].children;
  assert.ok(
    Math.abs(first.abs.width - 247) <= 3,
    `dragged to ~247, got ${first.abs.width}`,
  );

  wnd.emit('mousemove', { x: 5, y: 100 });
  await settle();
  assert.strictEqual(root(app).children[0].children[0].abs.width, 50, 'min');

  wnd.emit('mousemove', { x: 395, y: 100 });
  await settle();
  assert.strictEqual(
    root(app).children[0].children[0].abs.width,
    400 - 6 - 80,
    'the second pane keeps its minimum',
  );
  wnd.emit('mouseup', { x: 395, y: 100, keycode: 1 });

  await x11Root.unmount();
});

test('the divider takes the grab point with it, without jumping', async () => {
  const app = await mountSplit();
  const x11Root = await createRoot({ app });
  await tick();
  const wnd = app.windows[0];
  const d = divider(app);

  // press at the right-hand edge of the divider and do not move
  wnd.emit('mousedown', { x: d.abs.x + 5, y: 100, keycode: 1 });
  wnd.emit('mousemove', { x: d.abs.x + 5, y: 100 });
  await tick();
  assert.strictEqual(
    root(app).children[0].children[0].abs.width,
    100,
    'no jump on press',
  );
  wnd.emit('mouseup', { x: d.abs.x + 5, y: 100, keycode: 1 });

  await x11Root.unmount();
});

test('the divider is focusable and moves with the arrow keys', async () => {
  const app = await mountSplit();
  const x11Root = await createRoot({ app });
  await tick();
  const wnd = app.windows[0];
  divider(app).focus();

  press(app, wnd, XK.RIGHT);
  await settle();
  assert.strictEqual(root(app).children[0].children[0].abs.width, 116);
  press(app, wnd, XK.LEFT);
  press(app, wnd, XK.LEFT);
  await settle();
  assert.strictEqual(
    root(app).children[0].children[0].abs.width,
    84,
    'each press steps from the last, not from the last render',
  );

  press(app, wnd, XK.HOME);
  await settle();
  assert.strictEqual(root(app).children[0].children[0].abs.width, 40, 'to min');

  await x11Root.unmount();
});

test('a column split divides the other way', async () => {
  const app = await mountSplit({ direction: 'column', defaultSize: 60 });
  const x11Root = await createRoot({ app });
  await tick();
  const [first, d, second] = root(app).children[0].children;
  assert.strictEqual(first.abs.height, 60);
  assert.strictEqual(second.abs.height, 200 - 60 - 6);
  assert.strictEqual(d.style.cursor, 'row-resize');

  await x11Root.unmount();
});
