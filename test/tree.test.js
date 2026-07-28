// Tree: disclosure rows with keyboard navigation, the control a file
// browser or outline pane is built from.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import ReactX11, { Tree } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';
import { TYPE_AHEAD_TIMEOUT } from '../src/components/typeahead.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
};
const root = (app) => app.windows[0]._reactX11Node;

const XK = {
  HOME: 0xff50,
  LEFT: 0xff51,
  UP: 0xff52,
  RIGHT: 0xff53,
  DOWN: 0xff54,
  END: 0xff57,
  RETURN: 0xff0d,
};

function press(app, keysym, key) {
  const codepoint = key ? key.codePointAt(0) : undefined;
  const keycode = ((keysym ?? codepoint) % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym ?? codepoint];
  app.windows[0].emit('keydown', { keycode, codepoint, buttons: 0 });
}

const find = (node, pred) =>
  pred(node)
    ? node
    : node.children.reduce(
        (a, c) => a || (c.isWindow ? null : find(c, pred)),
        null,
      );

/** Every row label the tree is showing, in order. */
const labels = (app) => {
  const out = [];
  const walk = (n) => {
    if (n.kind === 'text') out.push(String(n.props.children));
    n.children.forEach((c) => !c.isWindow && walk(c));
  };
  walk(root(app));
  return out;
};

const rowFor = (app, text) =>
  find(root(app), (n) => n.kind === 'text' && String(n.props.children) === text)
    ?.parent;

const click = (app, node, at) => {
  const x = at?.x ?? node.abs.x + node.abs.width / 2;
  const y = at?.y ?? node.abs.y + node.abs.height / 2;
  app.windows[0].emit('mousedown', { x, y, keycode: 1 });
  app.windows[0].emit('mouseup', { x, y, keycode: 1 });
};

const ITEMS = [
  {
    id: 'src',
    label: 'src',
    children: [
      { id: 'nodes', label: 'nodes.js' },
      {
        id: 'components',
        label: 'components',
        children: [
          { id: 'button', label: 'Button.js' },
          { id: 'tree', label: 'Tree.js' },
        ],
      },
    ],
  },
  { id: 'readme', label: 'README.md' },
  { id: 'locked', label: 'locked.bin', disabled: true },
];

function mount(props) {
  const app = createMockApp();
  ReactX11.render(
    h(
      'window',
      { width: 260, height: 200 },
      h(Tree, { items: ITEMS, ...props }),
    ),
    null,
    app,
  );
  return app;
}

test('only the roots show until a branch is expanded', async () => {
  const app = mount();
  await settle();
  assert.deepStrictEqual(labels(app), ['src', 'README.md', 'locked.bin']);

  ReactX11.unmountComponentAtNode(app);
});

test('defaultExpanded opens branches, nested ones included', async () => {
  const app = mount({ defaultExpanded: ['src', 'components'] });
  await settle();
  assert.deepStrictEqual(labels(app), [
    'src',
    'nodes.js',
    'components',
    'Button.js',
    'Tree.js',
    'README.md',
    'locked.bin',
  ]);

  ReactX11.unmountComponentAtNode(app);
});

test('clicking the twisty expands without selecting the row', async () => {
  const picked = [];
  const app = mount({ onSelect: (id) => picked.push(id) });
  await settle();

  const row = rowFor(app, 'src');
  click(app, row, { x: row.abs.x + 8, y: row.abs.y + row.abs.height / 2 });
  await settle();

  assert.ok(labels(app).includes('nodes.js'), 'the branch opened');
  assert.deepStrictEqual(picked, [], 'and the selection did not move');

  ReactX11.unmountComponentAtNode(app);
});

test('clicking the label selects the row', async () => {
  const picked = [];
  const app = mount({ onSelect: (id) => picked.push(id) });
  await settle();

  click(app, rowFor(app, 'README.md'));
  await settle();
  assert.deepStrictEqual(picked, ['readme']);

  ReactX11.unmountComponentAtNode(app);
});

test('Right opens a branch, then walks into it; Left closes, then walks out', async () => {
  const picked = [];
  const app = mount({
    defaultSelected: 'src',
    onSelect: (id) => picked.push(id),
  });
  await settle();
  rowFor(app, 'src').focus();

  press(app, XK.RIGHT);
  await settle();
  assert.ok(labels(app).includes('nodes.js'), 'first Right expands');
  assert.deepStrictEqual(picked, [], 'and stays put');

  press(app, XK.RIGHT);
  await settle();
  assert.deepStrictEqual(picked, ['nodes'], 'second Right steps inside');

  press(app, XK.LEFT);
  await settle();
  assert.deepStrictEqual(
    picked,
    ['nodes', 'src'],
    'Left on a leaf goes out to the parent',
  );

  press(app, XK.LEFT);
  await settle();
  assert.ok(!labels(app).includes('nodes.js'), 'and Left again collapses it');

  ReactX11.unmountComponentAtNode(app);
});

test('Up/Down walk the visible rows and skip disabled ones', async () => {
  const picked = [];
  const app = mount({
    defaultExpanded: ['src'],
    defaultSelected: 'src',
    onSelect: (id) => picked.push(id),
  });
  await settle();
  rowFor(app, 'src').focus();

  press(app, XK.DOWN);
  press(app, XK.DOWN);
  press(app, XK.DOWN);
  await settle();
  assert.deepStrictEqual(picked, ['nodes', 'components', 'readme']);

  press(app, XK.DOWN);
  await settle();
  assert.deepStrictEqual(
    picked.at(-1),
    'readme',
    'the disabled row is not landed on, and there is nothing past it',
  );

  press(app, XK.HOME);
  await settle();
  assert.strictEqual(picked.at(-1), 'src');

  ReactX11.unmountComponentAtNode(app);
});

test('type-ahead jumps to a row by prefix', async () => {
  const picked = [];
  const app = mount({
    defaultExpanded: ['src', 'components'],
    defaultSelected: 'src',
    onSelect: (id) => picked.push(id),
  });
  await settle();
  rowFor(app, 'src').focus();

  press(app, null, 'B');
  await settle();
  assert.strictEqual(picked.at(-1), 'button', 'B found Button.js');

  // keystrokes inside the timeout accumulate into one query, so this is
  // "bu" refining onto the row it is already on rather than a fresh jump
  press(app, null, 'u');
  await settle();
  assert.strictEqual(picked.at(-1), 'button');

  // past the timeout it starts a new query
  await new Promise((resolve) => setTimeout(resolve, TYPE_AHEAD_TIMEOUT + 60));
  press(app, null, 'R');
  await settle();
  assert.strictEqual(picked.at(-1), 'readme');

  ReactX11.unmountComponentAtNode(app);
});

test('Enter toggles a branch and reports the activation', async () => {
  const activated = [];
  const app = mount({
    defaultSelected: 'src',
    onActivate: (id) => activated.push(id),
  });
  await settle();
  rowFor(app, 'src').focus();

  press(app, XK.RETURN);
  await settle();
  assert.ok(labels(app).includes('nodes.js'), 'Enter opened it');
  assert.deepStrictEqual(activated, ['src']);

  press(app, XK.RETURN);
  await settle();
  assert.ok(!labels(app).includes('nodes.js'), 'and Enter again closed it');

  ReactX11.unmountComponentAtNode(app);
});

test('controlled expansion reports changes and follows the prop', async () => {
  const app = createMockApp();
  const changes = [];
  const render = (open) =>
    ReactX11.render(
      h(
        'window',
        { width: 260, height: 200 },
        h(Tree, {
          items: ITEMS,
          expanded: open,
          onExpandedChange: (next) => changes.push(next),
        }),
      ),
      null,
      app,
    );

  render([]);
  await settle();
  assert.ok(!labels(app).includes('nodes.js'));

  const row = rowFor(app, 'src');
  click(app, row, { x: row.abs.x + 8, y: row.abs.y + row.abs.height / 2 });
  await settle();
  assert.deepStrictEqual(changes, [['src']], 'it asked, rather than deciding');
  assert.ok(!labels(app).includes('nodes.js'), 'and did not open itself');

  render(['src']);
  await settle();
  assert.ok(labels(app).includes('nodes.js'), 'the prop opens it');

  ReactX11.unmountComponentAtNode(app);
});

test('a branch with no children still shows a twisty', async () => {
  const app = createMockApp();
  ReactX11.render(
    h(
      'window',
      { width: 260, height: 200 },
      h(Tree, { items: [{ id: 'empty', label: 'empty', children: [] }] }),
    ),
    null,
    app,
  );
  await settle();

  // an unexpanded directory has to look openable before its contents are
  // known — that is how lazy loading is signalled
  const row = rowFor(app, 'empty');
  assert.ok(
    find(row, (n) => n.kind === 'canvas'),
    'the twisty is drawn even with an empty children array',
  );

  ReactX11.unmountComponentAtNode(app);
});
