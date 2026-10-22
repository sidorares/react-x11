// What wrapping content in a `ContextMenu` does to the keyboard and to a
// screen reader: nothing, until the menu opens.
//
// The wrapper takes the focus while its menu is open, because the popup is
// override-redirect and never gets it. It used to be `focusable` to do that,
// which made it a Tab stop as well — a box with no role and no name, so Tab
// landed on a "filler" a screen reader announced as "(no accessible name)",
// in front of the list it wrapped, in every app with a context menu.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

import { cleanup, renderX11, screen, userEvent } from '../src/testing/index.js';
import { Button, ContextMenu } from '../src/index.js';
import { XK_DOWN, XK_RETURN } from '../src/keysyms.js';

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

/** A context menu around a focusable, named list — the usual shape. */
function App({ picked = [], ...menuProps }) {
  return h(
    'box',
    { style: { flexGrow: 1 } },
    h(Button, null, 'New file'),
    h(
      ContextMenu,
      {
        items: [
          { label: 'Open', onSelect: () => picked.push('open') },
          { label: 'Delete', onSelect: () => picked.push('delete') },
        ],
        style: { flexGrow: 1 },
        ...menuProps,
      },
      h(
        'box',
        {
          role: 'list',
          'aria-label': 'Files',
          focusable: true,
          style: { flexGrow: 1 },
        },
        h('text', { role: 'listitem' }, 'notes.txt'),
        h('text', { role: 'listitem' }, 'todo.txt'),
      ),
    ),
  );
}

const render = (element) =>
  renderX11(element, { ...WINDOW, screen: WINDOW, fonts: FONTS, a11y: true });

const wrapperOf = () => screen.getByText('notes.txt').parent.parent;

test('a ContextMenu adds no nameless Tab stop', async () => {
  const { at } = await render(h(App));
  const stops = at.focusables();
  for (const stop of stops) {
    assert.notEqual(
      stop.utterance,
      '(no accessible name)',
      `Tab reaches an unnamed <${stop.node.kind}> (${stop.role})`,
    );
    assert.notEqual(stop.name, '', `unnamed ${stop.role}`);
  }
  assert.deepEqual(
    stops.map((s) => s.name),
    ['New file', 'Files'],
    'the button, then the list — the wrapper is not a stop',
  );
  assert.ok(!stops.some((s) => s.node === wrapperOf()));

  // and Tab itself agrees: two presses from the button wrap back to it
  await userEvent.tab();
  assert.equal(at.focused().name, 'New file');
  await userEvent.tab();
  assert.equal(at.focused().name, 'Files');
  await userEvent.tab();
  assert.equal(at.focused().name, 'New file');
});

test('the wrapper still takes the keys while its menu is open', async () => {
  const picked = [];
  const { at } = await render(h(App, { picked }));
  await userEvent.click(screen.getByText('todo.txt'), { button: 3 });
  assert.equal(screen.queryAllByRole('menuitem').length, 2, 'the menu opened');
  assert.equal(at.focused().node, wrapperOf(), 'the wrapper has the focus');

  await userEvent.key(XK_DOWN);
  await userEvent.key(XK_RETURN);
  assert.deepEqual(picked, ['open'], 'the keys reached the open menu');
  assert.equal(screen.queryAllByRole('menuitem').length, 0, 'and it closed');
});

test('an aria-label on a ContextMenu still names the wrapper', async () => {
  const { at } = await render(h(App, { 'aria-label': 'Project files' }));
  await userEvent.click(screen.getByText('notes.txt'), { button: 3 });
  const focused = at.focused();
  assert.equal(focused.node, wrapperOf());
  assert.equal(focused.name, 'Project files', 'what a screen reader hears');
  assert.ok(
    !at.focusables().some((s) => s.node === wrapperOf()),
    'and naming it does not make it a Tab stop',
  );
});
