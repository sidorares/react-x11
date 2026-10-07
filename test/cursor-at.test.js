// An element's cursor for a point inside it (`cursorAt`, src/events.js).
//
// `defaultCursor` and the `cursor` style are one cursor per node, and core
// applied them only as the pointer crossed from node to node — so an element
// that draws what is inside it, a document with links in it, could not show
// a pointer over a link and a text cursor beside it. The element answers for
// the point now, on every motion, in device pixels.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import React from 'react';

import { createRoot } from '../src/index.js';
import {
  createMockApp,
  flushFrames,
  moveMouse,
  pressButton,
} from './helpers/mock-app.js';

const h = React.createElement;
const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

async function mount(style = {}, props = {}) {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { width: 200, height: 100 },
      h('box', { style: { flexGrow: 1, ...style }, ...props }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  flushFrames(wnd);
  const pane = wnd._reactX11Node.children[0];
  const asked = [];
  // a "document" whose left half is a link
  pane.cursorAt = (x, y) => {
    asked.push([x, y]);
    return x < 100 ? 'pointer' : null;
  };
  return { root, wnd, pane, asked };
}

test('an element names the cursor for the point, as the pointer moves inside it', async () => {
  const { root, wnd, asked } = await mount();
  moveMouse(wnd, 40, 50);
  assert.equal(wnd.cursor, 'pointer');
  // the same node under the pointer: only the point changed
  moveMouse(wnd, 150, 50);
  assert.equal(wnd.cursor, null, 'nothing in particular: the default');
  moveMouse(wnd, 60, 20);
  assert.equal(wnd.cursor, 'pointer');
  assert.deepEqual(asked.at(-1), [60, 20]);
  await root.unmount();
});

test('a cursor style on the element wins over its point cursor', async () => {
  const { root, wnd } = await mount({ cursor: 'crosshair' });
  moveMouse(wnd, 40, 50);
  assert.equal(wnd.cursor, 'crosshair');
  await root.unmount();
});

test('a null point cursor falls through to defaultCursor', async () => {
  const { root, wnd, pane } = await mount();
  pane.defaultCursor = 'text';
  moveMouse(wnd, 150, 50);
  assert.equal(wnd.cursor, 'text');
  moveMouse(wnd, 40, 50);
  assert.equal(wnd.cursor, 'pointer');
  await root.unmount();
});

test('while a capture holds the pointer, the cursor stays as it was', async () => {
  const { root, wnd, asked } = await mount(
    {},
    { onMouseDown: (ev) => ev.capturePointer() },
  );
  moveMouse(wnd, 40, 50);
  assert.equal(wnd.cursor, 'pointer');
  pressButton(wnd, 40, 50, { release: false });
  assert.ok(wnd._reactX11Node.events.capturedNode, 'the press captured');
  const before = asked.length;
  moveMouse(wnd, 150, 50);
  assert.equal(asked.length, before, 'asked while captured');
  assert.equal(wnd.cursor, 'pointer');
  pressButton(wnd, 150, 50, { press: false });
  moveMouse(wnd, 151, 50);
  assert.equal(wnd.cursor, null, 'asked again once it let go');
  await root.unmount();
});

test('a cursor style changed by the press still shows while the capture holds', async () => {
  // a handle that grabs: `grab`, and `grabbing` for as long as it is held
  const app = createMockApp();
  const root = await createRoot({ app });
  function Handle() {
    const [held, setHeld] = React.useState(false);
    return h('box', {
      style: { flexGrow: 1, cursor: held ? 'grabbing' : 'grab' },
      onMouseDown: (ev) => {
        ev.capturePointer();
        setHeld(true);
      },
      onMouseUp: () => setHeld(false),
    });
  }
  root.render(h('window', { width: 200, height: 100 }, h(Handle)));
  await tick();
  const wnd = app.windows[0];
  flushFrames(wnd);
  moveMouse(wnd, 40, 50);
  assert.equal(wnd.cursor, 'grab');
  pressButton(wnd, 40, 50, { release: false });
  await tick();
  flushFrames(wnd);
  moveMouse(wnd, 60, 50);
  assert.equal(wnd.cursor, 'grabbing');
  pressButton(wnd, 60, 50, { press: false });
  await root.unmount();
});
