// Pointer motion and the wheel on the Windows backend are held for the next
// frame and merged — ntk's coalescing on X11, which src/events.js paces
// motion on (src/win32/window.js, `_queueInput`).
//
// The bridge posts every WM_MOUSEMOVE to the loop from a UI thread of its
// own, so Windows' own merging never applied: a thousand-hertz mouse was a
// thousand events a second, and a handler that took longer than the gap
// between two fell behind the pointer and then replayed every position it
// had missed, long after the pointer stopped.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import React from 'react';

import { createRoot } from '../../src/index.js';
import { Win32App } from '../../src/win32/app.js';
import { Win32Window } from '../../src/win32/window.js';
import { createFakeBridge } from './fake-bridge.js';

const h = React.createElement;

function setup() {
  const bridge = createFakeBridge();
  const app = new Win32App(bridge, {});
  const wnd = new Win32Window(app, { width: 300, height: 200, title: 'w' });
  wnd._onReady(0, 0);
  const seen = [];
  for (const name of ['mousemove', 'wheel', 'mousedown', 'mouseup']) {
    wnd.on(name, (ev) => seen.push({ name, ev }));
  }
  const route = (type, a = 0, b = 0, c = 0, d = 0) =>
    app._route({ type, id: wnd.id, a, b, c, d });
  const frame = () => app._route({ type: 'frame-clock' });
  return { app, wnd, seen, route, frame };
}

async function waitFor(check, what, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('win32 input pacing', () => {
  it('a burst of motion is one event at the next frame, at the newest position', () => {
    const { app, seen, route, frame } = setup();
    for (let i = 1; i <= 5; i++) route('mousemove', i * 10, i);
    assert.deepEqual(seen, [], 'nothing is delivered before the frame');
    assert.equal(app._framePending, true, 'and holding it asked for one');
    frame();
    assert.equal(seen.length, 1, 'one motion for the frame');
    const [{ name, ev }] = seen;
    assert.equal(name, 'mousemove');
    assert.deepEqual([ev.x, ev.y], [50, 5], 'at the newest position');
    assert.deepEqual(
      ev.coalesced.map((e) => e.x),
      [10, 20, 30, 40, 50],
      'with the rest riding along',
    );
    frame();
    assert.equal(seen.length, 1, 'and the next frame has nothing to deliver');
  });

  it('a press delivers the motion before it, so a drag sees its last move first', () => {
    const { seen, route, frame } = setup();
    route('mousemove', 10, 10);
    route('mousemove', 40, 30);
    route('mousedown', 40, 30, 1, 0);
    assert.deepEqual(
      seen.map(({ name, ev }) => [name, ev.x, ev.y]),
      [
        ['mousemove', 40, 30],
        ['mousedown', 40, 30],
      ],
    );
    route('mousemove', 60, 30);
    route('mouseup', 60, 30, 1, 0);
    assert.deepEqual(
      seen.slice(2).map(({ name, ev }) => [name, ev.x]),
      [
        ['mousemove', 60],
        ['mouseup', 60],
      ],
    );
    frame();
    assert.equal(seen.length, 4, 'nothing was left over for the frame');
  });

  it('the wheel adds its deltas up, at its last position', () => {
    const { seen, route, frame } = setup();
    route('wheel', 10, 10, 0, 1);
    route('wheel', 12, 10, 0, 1);
    route('wheel', 14, 11, 0, 0.5);
    frame();
    assert.equal(seen.length, 1);
    const { ev } = seen[0];
    assert.equal(ev.deltaY, 2.5, 'every notch of a fast scroll counts');
    assert.deepEqual([ev.x, ev.y], [14, 11]);
    assert.equal(ev.smooth, true, 'a fraction anywhere in it is a touchpad');
    assert.equal(ev.coalesced.length, 3);
  });

  it('a window destroyed while holding input delivers none of it', () => {
    const { wnd, seen, route, frame } = setup();
    route('mousemove', 10, 10);
    wnd.destroy();
    frame();
    assert.deepEqual(seen, []);
  });
});

describe('win32 input pacing: in a tree', () => {
  it('a handler slower than the pointer sees the newest position, once a frame', async () => {
    const bridge = createFakeBridge();
    // what realizing a window reaches that the fake leaves out
    Object.assign(bridge, {
      dropTargetEnable() {},
      systemAppearance: () => null,
      windowAppId() {},
      windowRelaunch() {},
    });
    const app = new Win32App(bridge, {});
    const root = await createRoot({ app });
    const moves = [];
    try {
      root.render(
        h(
          'window',
          { width: 300, height: 200 },
          h('box', {
            style: { flexGrow: 1 },
            onMouseMove: (ev) => moves.push(ev.x),
          }),
        ),
      );
      await waitFor(() => bridge.windows.size > 0, 'the window');
      const [id] = bridge.windows.keys();
      app._route({ type: 'window-ready', id, a: 0, b: 0 });
      // laid out: a frame has painted
      await new Promise((resolve) => setTimeout(resolve, 100));
      // a burst the loop had queued up while it was busy
      for (let x = 10; x <= 200; x += 10) {
        app._route({ type: 'mousemove', id, a: x, b: 50, c: 0, d: 0 });
      }
      assert.deepEqual(moves, [], 'none of it before the frame');
      app._route({ type: 'frame-clock' });
      assert.deepEqual(moves, [200], 'the frame delivers the newest, once');
    } finally {
      await root.unmount();
    }
  });
});
