// A `ContextMenu` whose items come from the right-click itself (#934).
//
// The usual shape: a row says which thing was right-clicked, in its own
// `onContextMenu`, and the menu's items are derived from that. The row's
// handler runs first and the wrapper's after it, on the same event — and both
// before React renders the state the row just set. The wrapper used to decide
// there and then, from the items of the render before, whether there was a
// menu to show and how big it was. So a menu whose previous items were empty
// opened on the *second* right-click, and one that grew was drawn with the
// new rows in a popup sized for the old ones.
//
// The rows are focusable on purpose: a press focuses the nearest focusable
// node, and with the wrapper the nearest, "a right-click with nothing to show
// leaves the focus alone" would pass whatever the menu did.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import React, { useState } from 'react';

import {
  act,
  cleanup,
  renderX11,
  screen,
  screenPointOf,
  settle,
  textOf,
  userEvent,
} from '../src/testing/index.js';
import { ContextMenu } from '../src/index.js';
import { XK_DOWN, XK_ESCAPE, XK_RETURN } from '../src/keysyms.js';

const require = createRequire(import.meta.url);
const FONTS = {
  'sans-serif': path.join(
    path.dirname(require.resolve('katex/package.json')),
    'dist',
    'fonts',
    'KaTeX_Main-Regular.ttf',
  ),
};
const WINDOW = { width: 400, height: 300 };

const h = React.createElement;

afterEach(cleanup);

const ROWS = [
  { id: 'a', name: 'alpha' },
  { id: 'b', name: 'bravo' },
];

/** What a right-clicked row offers: three rows, one of them long. */
const rowItems = (row, picked = []) => [
  {
    label: `Open ${row} in a new window`,
    onSelect: () => picked.push(`open ${row}`),
  },
  { label: 'Delete', onSelect: () => picked.push(`delete ${row}`) },
  { label: 'Rename', onSelect: () => picked.push(`rename ${row}`) },
];

/**
 * The rows sit in the window's bottom-right corner, so a menu opened on one
 * has to be clamped back onto the screen — by its real size, or it hangs off
 * the edge.
 */
function App({ before, after = rowItems, picked }) {
  const [row, setRow] = useState(null);
  const items = row ? after(row, picked) : before;
  return h(
    ContextMenu,
    {
      items,
      style: {
        flexGrow: 1,
        justifyContent: 'flex-end',
        alignItems: 'flex-end',
      },
    },
    ROWS.map(({ id, name }) =>
      h(
        'box',
        {
          key: id,
          focusable: true,
          onContextMenu: () => setRow(id),
          style: { padding: 4 },
        },
        h('text', null, name),
      ),
    ),
  );
}

const render = (element) =>
  renderX11(element, { ...WINDOW, screen: WINDOW, fonts: FONTS });

const rightClick = (text) =>
  userEvent.click(screen.getByText(text), { button: 3 });

/** The open menu's popup, or null. */
function menuPopup() {
  const [list] = screen.queryAllByRole('menu');
  let node = list;
  while (node && node.props?.windowType !== 'popup_menu') node = node.parent;
  return node ?? null;
}

const labels = () => screen.queryAllByRole('menuitem').map(textOf);

function geometry(popup) {
  const { x, y, width, height } = popup.props;
  return { x, y, width, height };
}

/** Where a menu holding `items` from the start opens on a right-click. */
async function staticGeometry(items) {
  await render(h(App, { before: items, after: () => items }));
  await rightClick('bravo');
  const popup = menuPopup();
  assert.ok(popup, 'the reference menu opened');
  const answer = geometry(popup);
  await cleanup();
  return answer;
}

test('the first right-click opens the items it set, when the ones before were empty', async () => {
  const picked = [];
  const view = await render(h(App, { before: [], picked }));
  await rightClick('alpha');

  assert.deepEqual(
    labels(),
    ['Open a in a new window', 'Delete', 'Rename'],
    'the menu opened on the first right-click, with the row it was opened on',
  );
  assert.ok(menuPopup(), 'in a popup');
  await settle(view.app);
  assert.ok(view.server.grabs.pointer, 'holding the pointer grab');
  const wrapper = screen.getByText('alpha').parent.parent;
  assert.equal(
    view.windowNode.events.focused,
    wrapper,
    'and the wrapper has the keys, not the row the press focused',
  );

  // the keys reach it: the first row, chosen from the keyboard
  await userEvent.key(XK_DOWN);
  await userEvent.key(XK_RETURN);
  assert.deepEqual(picked, ['open a']);
  assert.equal(menuPopup(), null, 'and choosing closed it');
});

test('a menu that grows on the right-click is sized for the items it shows', async () => {
  const reference = await staticGeometry(rowItems('a'));

  const view = await render(h(App, { before: [{ label: 'x' }] }));
  await rightClick('bravo');
  assert.deepEqual(labels(), ['Open b in a new window', 'Delete', 'Rename']);
  const popup = menuPopup();
  const { width, height } = geometry(popup);
  // `rowItems('a')` and `rowItems('b')` are the same width in any face that
  // gives `a` and `b` one advance — not this one, so compare the height
  // exactly and the width against the one-row menu it used to be
  assert.equal(height, reference.height, 'as tall as its three rows');
  assert.ok(
    Math.abs(width - reference.width) <= 2,
    `as wide as its longest label: ${width} against ${reference.width}`,
  );

  // and clamped onto the screen by that size: the row is in the corner
  const { x, y } = geometry(popup);
  assert.ok(x + width <= WINDOW.width, `inside the right edge: ${x}+${width}`);
  assert.ok(
    y + height <= WINDOW.height,
    `inside the bottom edge: ${y}+${height}`,
  );
  await settle(view.app);
});

test('items that were there all along still open at the pointer, clamped to the screen', async () => {
  const items = rowItems('a');
  const view = await render(
    h(
      ContextMenu,
      { items, style: { flexGrow: 1 } },
      h('box', { style: { padding: 4 } }, h('text', null, 'top')),
      h('box', { style: { flexGrow: 1 } }),
      h(
        'box',
        { style: { alignSelf: 'flex-end', padding: 4 } },
        h('text', null, 'corner'),
      ),
    ),
  );

  // well inside the screen: at the pointer, exactly
  const top = screen.getByText('top');
  const at = screenPointOf(top);
  await userEvent.click(top, { button: 3 });
  let popup = menuPopup();
  assert.ok(popup, 'opened');
  assert.deepEqual([popup.props.x, popup.props.y], [at.x, at.y]);
  await userEvent.key(XK_ESCAPE);
  assert.equal(menuPopup(), null, 'Escape closed it');

  // in the corner: pulled back onto the screen
  await userEvent.click(screen.getByText('corner'), { button: 3 });
  popup = menuPopup();
  const { x, y, width, height } = geometry(popup);
  assert.equal(x + width, WINDOW.width, 'against the right edge');
  assert.equal(y + height, WINDOW.height, 'against the bottom edge');
  await settle(view.app);
});

test('a right-click that leaves the items empty opens nothing, grabs nothing and keeps the focus', async () => {
  const view = await render(h(App, { before: [], after: () => [] }));
  await rightClick('alpha');
  await settle(view.app);

  assert.equal(menuPopup(), null, 'no popup');
  assert.deepEqual(labels(), []);
  assert.equal(view.server.grabs.pointer, null, 'no pointer grab');
  assert.equal(
    view.windowNode.events.focused,
    screen.getByText('alpha').parent,
    'the row the press focused still has the focus',
  );

  // and the next press is an ordinary one: nothing left waiting to open
  await userEvent.click(screen.getByText('bravo'));
  assert.equal(menuPopup(), null);
  assert.equal(
    view.windowNode.events.focused,
    screen.getByText('bravo').parent,
  );
});

test('items emptied while the menu is open close it, and do not bring it back', async () => {
  let setItems;
  function Live() {
    const [items, set] = useState(rowItems('a'));
    setItems = set;
    return h(
      ContextMenu,
      { items, style: { flexGrow: 1 } },
      h('box', { style: { padding: 4 } }, h('text', null, 'body')),
    );
  }
  const view = await render(h(Live));
  await userEvent.click(screen.getByText('body'), { button: 3 });
  assert.ok(menuPopup(), 'opened');

  await act(() => setItems([]));
  await settle(view.app);
  assert.equal(menuPopup(), null, 'closed with nothing in it');
  assert.equal(view.server.grabs.pointer, null, 'and let the pointer go');

  await act(() => setItems(rowItems('b')));
  assert.equal(menuPopup(), null, 'items coming back do not reopen it');
});
