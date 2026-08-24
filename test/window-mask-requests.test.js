// ntk grows a window's server-side event mask lazily — one
// ChangeWindowAttributes per first listener of each kind — so a value known
// before the window exists is worth declaring at CreateWindow, which
// `WINDOW_EVENT_MASK` does. These are the two places a request still gets
// issued for a value that was knowable, and the cursor attribute that gets
// set to the value it already had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import {
  renderX11,
  cleanup,
  settle,
  act,
  fireEvent,
} from '../src/testing/index.js';

const h = React.createElement;

/** Every ChangeWindowAttributes this connection sends, by window. */
function recordAttributeWrites(app) {
  const writes = [];
  const original = app.X.ChangeWindowAttributes;
  app.X.ChangeWindowAttributes = function (wid, values, ...rest) {
    writes.push({ wid, values });
    return original.call(this, wid, values, ...rest);
  };
  return writes;
}

test('hovering a subtree that names no cursor sets no cursor', async (t) => {
  t.after(cleanup);
  // A window starts out wearing X cursor None — "inherit the parent's" —
  // which is exactly what a subtree declaring no cursor resolves to. The
  // first hover has nothing to change, and `_appliedCursor` starting as
  // `undefined` rather than `null` is what used to make it look otherwise.
  const { app, getByText } = await renderX11(
    h(
      'window',
      { width: 320, height: 240 },
      h('box', { style: { width: 200, height: 60 } }, h('text', null, 'plain')),
    ),
  );
  await settle(app, 3);

  const writes = recordAttributeWrites(app);
  const plain = getByText('plain');
  await act(async () => {
    for (let i = 0; i < 4; i++) fireEvent.mouseMove(plain, { dx: i });
  });
  await settle(app, 2);

  assert.deepStrictEqual(
    writes.filter((w) => 'cursor' in w.values),
    [],
    'the window was told to wear the cursor it was already wearing',
  );
});

test('a window state session selects once, not twice', async (t) => {
  t.after(cleanup);
  // An `animation` arms `watchWindowState` so the loop can stop while the
  // window is obscured, and that session needs two masks: PropertyChange for
  // `_NET_WM_STATE`, VisibilityChange for the obscured watch. Asked for
  // separately they are two requests, on a window that is already mapped and
  // on screen.
  //
  // Mounted still and animated afterwards, so the arming happens where it
  // can be counted rather than inside the first paint.
  const { app, windowNode, rerender } = await renderX11(
    h(
      'window',
      { width: 300, height: 120 },
      h('box', { style: { width: 40, height: 40 } }),
    ),
  );
  await settle(app, 4);

  const writes = recordAttributeWrites(app);
  // a whole <window>: the mounted element is one, so `rerender` renders what
  // it is given as the root rather than wrapping it
  await rerender(
    h(
      'window',
      { width: 300, height: 120 },
      h('box', {
        style: {
          width: 40,
          height: 40,
          backgroundColor: '#48f',
          animation: {
            left: { from: 0, to: 100, duration: 1200, alternate: true },
          },
        },
      }),
    ),
  );
  await settle(app, 4);

  const id = windowNode.window.id;
  const masks = writes.filter((w) => w.wid === id && 'eventMask' in w.values);
  assert.strictEqual(
    masks.length,
    1,
    `expected one late event-mask selection, got ${masks.length}: ` +
      masks.map((m) => `0x${m.values.eventMask.toString(16)}`).join(', '),
  );
  const PROPERTY_CHANGE = 1 << 22;
  const VISIBILITY_CHANGE = 1 << 16;
  assert.ok(
    masks[0].values.eventMask & PROPERTY_CHANGE &&
      masks[0].values.eventMask & VISIBILITY_CHANGE,
    'the one selection has to carry both bits the session needs',
  );
});
