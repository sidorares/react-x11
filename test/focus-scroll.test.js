// What focus does to the scroll pane around the node it lands on.
//
// Focus scrolls its node into view (`_scrollIntoView`, src/events.js) so a
// Tab to something below the fold shows it. A press is not that: the node
// is under the pointer, so the part that matters is on screen already —
// and a node taller than its pane, a document, was scrolled to its top by
// every click on it, the drag that followed selecting from there.
//
// And a node taller than its pane has no "fully into view". It is scrolled
// the way CSSOM View's `block: nearest` scrolls it: where it covers the
// viewport it stays, and where it is partly out it comes in by the edge
// that moves it least.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import React from 'react';

import {
  closeEditMenu,
  createRoot,
  editMenuOpen,
  openEditMenu,
} from '../src/index.js';
import { createMockApp, flushFrames, pressButton } from './helpers/mock-app.js';

const h = React.createElement;
const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

/** A 100px pane over a 60px row, a 1000px focusable document, a 60px row. */
async function mount() {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { width: 100, height: 100 },
      h(
        'box',
        { style: { overflow: 'scroll', flexGrow: 1 } },
        h('box', { style: { height: 60 }, focusable: true }),
        h('box', { style: { height: 1000 }, focusable: true }),
        h('box', { style: { height: 60 }, focusable: true }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  flushFrames(wnd);
  const pane = wnd._reactX11Node.children[0];
  return { app, root, wnd, pane, doc: pane.children[1] };
}

test('a press focuses a document taller than its pane where it is, without scrolling it', async () => {
  const { root, wnd, pane, doc } = await mount();
  pane.scrollTo(500);
  await tick();
  flushFrames(wnd);
  assert.equal(pane.scrollY, 500);

  pressButton(wnd, 50, 50);
  await tick();
  flushFrames(wnd);
  assert.equal(
    wnd._reactX11Node.events.focused,
    doc,
    'the press focused the document',
  );
  assert.equal(pane.scrollY, 500, 'the press scrolled the pane');
  await root.unmount();
});

test('scrollIntoView leaves a node that covers the viewport, and brings a taller one in by its nearer edge', async () => {
  const { root, wnd, pane, doc } = await mount();
  // the document covers 500..600 of its 60..1060: nothing more of it fits
  pane.scrollTo(500);
  await tick();
  flushFrames(wnd);
  pane.scrollIntoView(doc);
  await tick();
  flushFrames(wnd);
  assert.equal(pane.scrollY, 500);

  // partly below the viewport and taller than it: its top edge comes in
  pane.scrollTo(0);
  await tick();
  flushFrames(wnd);
  pane.scrollIntoView(doc);
  await tick();
  flushFrames(wnd);
  assert.equal(pane.scrollY, 60);

  pane.scrollIntoView(pane.children[2]);
  await tick();
  flushFrames(wnd);
  assert.equal(
    pane.scrollY,
    1020,
    'a short node below still lands at the bottom',
  );
  pane.scrollIntoView(doc);
  await tick();
  flushFrames(wnd);
  assert.equal(pane.scrollY, 960, 'taller and above: its bottom edge comes in');

  pane.scrollTo(0);
  await tick();
  flushFrames(wnd);
  pane.scrollIntoView(pane.children[0]);
  await tick();
  flushFrames(wnd);
  assert.equal(pane.scrollY, 0);
  await root.unmount();
});

// A `<popup>` hangs off a node of its owner's tree and is a window of its
// own on the screen, so what it focuses is no pane's to bring into view.
// The pane above it measured the popup's content as if it were laid out at
// the popup's parent: the edit menu taking the keyboard scrolled a
// document in a pane to its top on every right-click.
test("the edit menu taking the keyboard leaves the owner's pane where it was", async () => {
  const { root, wnd, pane, doc } = await mount();
  pane.scrollTo(500);
  await tick();
  flushFrames(wnd);

  openEditMenu(doc, { x: 50, y: 50 }, { copy() {}, selectAll() {} });
  await tick();
  flushFrames(wnd);
  assert.equal(editMenuOpen(doc), true, 'no menu opened');
  assert.equal(pane.scrollY, 500, 'the menu scrolled the pane');

  closeEditMenu(doc);
  await tick();
  flushFrames(wnd);
  assert.equal(pane.scrollY, 500, 'closing it scrolled the pane');
  await root.unmount();
});

test("a node a popup focuses is not scrolled into view by the owner's pane", async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  let inner = null;
  root.render(
    h(
      'window',
      { width: 100, height: 100 },
      h(
        'box',
        { style: { overflow: 'scroll', flexGrow: 1 } },
        h(
          'box',
          { style: { height: 1000 } },
          h(
            'popup',
            { x: 0, y: 0, width: 50, height: 20 },
            h('box', {
              ref: (n) => (inner = n),
              style: { height: 20 },
              focusable: true,
            }),
          ),
        ),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  flushFrames(wnd);
  const pane = wnd._reactX11Node.children[0];
  pane.scrollTo(500);
  await tick();
  flushFrames(wnd);

  wnd._reactX11Node.events.focus(inner);
  await tick();
  flushFrames(wnd);
  assert.equal(pane.scrollY, 500, 'the focus scrolled the pane');
  await root.unmount();
});
