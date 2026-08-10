// A menu bar narrower than its titles: what is painted, what moves into the
// chevron, and what the keyboard is allowed to reach.
//
// Before this, the titles that did not fit were laid out past the window's
// edge — never painted, unreachable by pointer, and still in the keyboard's
// cycle, so walking the bar opened a menu anchored to an item nobody could
// see (#241). The rule these tests hold to is that the bar's cycle and the
// bar's paint are the same list.
//
// Widths here are the mock's own: with no font stack, `measureLabel` falls
// back to `length * size * 0.55`, which is what makes an expected split
// something a test can state rather than approximate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { createRoot, MenuBar } from '../src/index.js';
import { createMockApp, pressButton } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Long enough for the measurement to come back round.
 *
 * The bar cannot know its own width during the render that mounts it:
 * layout runs on the frame clock after that commit, `onViewport` is
 * deferred out of the layout pass itself, and the cut it feeds is a state
 * change that renders again. Three hops, so this waits rather than counting
 * them.
 */
async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

const TITLES = [
  'File',
  'Edit',
  'Selection',
  'View',
  'Go',
  'Run',
  'Terminal',
  'Window',
  'Help',
];
const MENUS = TITLES.map((label) => ({
  label,
  items: [{ label: `${label} one` }, { label: `${label} two` }],
}));

const findNode = (node, pred) => {
  if (pred(node)) return node;
  for (const child of node.children ?? []) {
    if (child.isWindow) continue;
    const found = findNode(child, pred);
    if (found) return found;
  }
  return null;
};

const textOf = (node) => {
  const chunk = findNode(node, (n) => n.kind === 'textchunk');
  return chunk?.text ?? null;
};

/** The chevron draws a system icon and no text — that is how it is spotted. */
const isChevron = (node) =>
  Boolean(
    findNode(
      node,
      (n) => n.kind === 'canvas' && n.props?.cacheKey === 'moreVertical',
    ),
  );

const barOf = (wnd) => wnd._reactX11Node.children[0];

/** What the bar actually paints, with the chevron as `'…'`. */
const painted = (wnd) =>
  barOf(wnd).children.map((item) => (isChevron(item) ? '…' : textOf(item)));

/** The rows of the popup that is currently open. */
const rowsOf = (app) => {
  const popup = app.windows.at(-1);
  const list = popup?._reactX11Node.children[0];
  return (list?.children ?? []).map(textOf);
};

async function mount(width, menus = MENUS) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width, height: 200 },
      // `globalMenu: false` because this is a test about the bar we draw: on
      // a machine running a panel that takes application menus, `MenuBar`
      // would correctly render nothing at all.
      h(MenuBar, { menus, fontSize: 13, globalMenu: false }),
    ),
  );
  await settle();
  return { app, x11Root, wnd: app.windows[0] };
}

/** Click a bar item by its painted index. */
async function clickItem(wnd, index) {
  const item = barOf(wnd).children[index];
  pressButton(wnd, item.abs.x + 4, item.abs.y + 4);
  await settle();
}

function press(app, wnd, keysym) {
  const keycode = (keysym % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym];
  wnd.emit('keydown', { keycode, buttons: 0 });
}

const XK_LEFT = 0xff51;
const XK_RIGHT = 0xff53;

test('a bar too narrow paints what fits and pockets the rest', async () => {
  const { app, x11Root, wnd } = await mount(300);

  assert.deepEqual(
    painted(wnd),
    ['File', 'Edit', 'Selection', 'View', '…'],
    'the four that fit, then the chevron',
  );

  // and the pocket holds exactly the ones that went missing, in order
  await clickItem(wnd, 4);
  assert.deepEqual(rowsOf(app), ['Go', 'Run', 'Terminal', 'Window', 'Help']);

  await x11Root.unmount();
});

test('a bar wide enough for its titles has no chevron at all', async () => {
  const { x11Root, wnd } = await mount(900);
  assert.deepEqual(painted(wnd), TITLES, 'all nine, nothing pocketed');
  await x11Root.unmount();
});

test('the chevron opens the hidden menu as a submenu of its own', async () => {
  const { app, x11Root, wnd } = await mount(300);

  await clickItem(wnd, 4);
  const popup = app.windows.at(-1);
  const rows = popup._reactX11Node.children[0].children;
  const terminal = rows[2];
  assert.equal(textOf(terminal), 'Terminal');
  assert.equal(
    terminal.props['aria-haspopup'],
    'menu',
    'a hidden menu is a row that opens its own menu, not a leaf',
  );

  await x11Root.unmount();
});

test('Left/Right walk the painted titles and the chevron, and nothing else', async () => {
  const { app, x11Root, wnd } = await mount(300);

  await clickItem(wnd, 0);
  assert.deepEqual(rowsOf(app), ['File one', 'File two']);

  // four steps right: Edit, Selection, View, then the chevron — which is the
  // last stop rather than `Go`, the first title that is not painted
  for (const expected of [
    ['Edit one', 'Edit two'],
    ['Selection one', 'Selection two'],
    ['View one', 'View two'],
    ['Go', 'Run', 'Terminal', 'Window', 'Help'],
  ]) {
    press(app, wnd, XK_RIGHT);
    await settle();
    assert.deepEqual(rowsOf(app), expected);
  }

  // and one more wraps to the first title, not into the hidden ones
  press(app, wnd, XK_RIGHT);
  await settle();
  assert.deepEqual(rowsOf(app), ['File one', 'File two']);

  // the same backwards: Left off the first title lands on the chevron
  press(app, wnd, XK_LEFT);
  await settle();
  assert.deepEqual(rowsOf(app), ['Go', 'Run', 'Terminal', 'Window', 'Help']);

  await x11Root.unmount();
});

test('widening the window puts a title back on the bar', async () => {
  const { x11Root, wnd } = await mount(300);
  assert.deepEqual(painted(wnd).at(-1), '…');

  wnd.width = 900;
  wnd.emit('resize', { width: 900, height: 200 });
  await settle();
  assert.deepEqual(painted(wnd), TITLES, 'all of them, chevron gone');

  // and back: the cut is recomputed from the width, not accumulated
  wnd.width = 300;
  wnd.emit('resize', { width: 300, height: 200 });
  await settle();
  assert.deepEqual(painted(wnd), ['File', 'Edit', 'Selection', 'View', '…']);

  await x11Root.unmount();
});

test('a single title that does not fit still leaves a usable bar', async () => {
  const { app, x11Root, wnd } = await mount(60);

  assert.deepEqual(painted(wnd), ['…'], 'the bar is one button');

  await clickItem(wnd, 0);
  assert.deepEqual(rowsOf(app), TITLES, 'and it holds everything');

  await x11Root.unmount();
});

test('the chevron says how many menus are behind it', async () => {
  const { x11Root, wnd } = await mount(300);

  const chevron = barOf(wnd).children.at(-1);
  assert.equal(chevron.props.role, 'menuitem');
  assert.equal(chevron.props['aria-haspopup'], 'menu');
  assert.equal(chevron.props['aria-label'], 'More menus (5)');

  // the hidden titles are not in the tree at all: AT-SPI has no notion of
  // "laid out past the edge", so a menu item nobody can reach would be a
  // lie told to a screen reader rather than a fallback
  for (const hidden of ['Go', 'Run', 'Terminal', 'Window', 'Help']) {
    assert.equal(
      findNode(barOf(wnd), (n) => n.kind === 'textchunk' && n.text === hidden),
      null,
      `${hidden} is pocketed, not merely unpainted`,
    );
  }

  await x11Root.unmount();
});

test('the menus prop is never rewritten by the cut', async () => {
  const menus = MENUS.map((menu) => ({ ...menu }));
  const before = JSON.stringify(menus);
  const { x11Root, wnd } = await mount(300, menus);

  assert.deepEqual(painted(wnd).at(-1), '…', 'it did overflow');
  assert.equal(
    JSON.stringify(menus),
    before,
    'what the panel would export is the array the app passed, untouched',
  );

  await x11Root.unmount();
});
