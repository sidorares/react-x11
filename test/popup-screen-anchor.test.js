// A popup that hangs off a rect on the screen, and one that takes the
// keyboard (#590) — the two things a tray popover needs that neither
// top-level element had.
//
// A tray click reports the item's frame on the screen, with no node behind
// it, so `anchor={{ to }}` could not place against it: `rect` is the same
// flip and clamp against a rect in screen coordinates. And a menu-bar app has
// no window of its own for keys to reach, so a popup's keys, which normally
// arrive at its owner window, arrived nowhere: `grabKeyboard` is a keyboard
// grab on X while the popup is up, and on Cocoa a window AppKit can make key,
// shown activating the app.
//
// The geometry is pure; the element is headless over the mock; the keyboard
// is the in-process X server's own grab routing, and the Cocoa window kind is
// what reaches the fake bridge.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';

import { anchorScreenRect, createRoot } from '../src/index.js';
import { XK_SPACE } from '../src/keysyms.js';
import { setScreensForTests } from '../src/screens.js';
import { cleanup, fireEvent, renderX11 } from '../src/testing/index.js';
import { cleanupCocoa, fakeCocoaApp } from './helpers/cocoa-bridge.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(async () => {
  await cleanup();
  await cleanupCocoa();
});

/** An app with these monitors and nothing else — all the placement asks. */
const screens = (...monitors) => {
  const app = {};
  setScreensForTests(app, { monitors });
  return app;
};

// A menu-bar item near the right-hand end of a 1440x900 display.
const ITEM = { x: 1380, y: 0, width: 30, height: 22 };
const POPOVER = { width: 280, height: 400 };

// --- the geometry -----------------------------------------------------------

test('under a tray item, centred, and pulled back from the screen edge', () => {
  const app = screens({ x: 0, y: 0, width: 1440, height: 900 });
  const at = anchorScreenRect(app, ITEM, {
    ...POPOVER,
    placement: 'bottom',
    align: 'center',
    offset: 6,
  });
  // centred would be 1395 − 140 = 1255, which runs 95px off the screen
  assert.deepEqual(at, {
    x: 1440 - 280,
    y: 22 + 6,
    width: 280,
    height: 400,
    placement: 'bottom',
  });
  // …and where there is room it is centred under the item
  const middle = anchorScreenRect(
    app,
    { ...ITEM, x: 700 },
    { ...POPOVER, align: 'center', offset: 6 },
  );
  assert.equal(middle.x, 715 - 140);
});

test('it flips above a rect near the bottom, as a taskbar tray is', () => {
  const app = screens({ x: 0, y: 0, width: 1440, height: 900 });
  const at = anchorScreenRect(
    app,
    { x: 700, y: 870, width: 24, height: 30 },
    { ...POPOVER, offset: 6 },
  );
  assert.equal(at.placement, 'top');
  assert.equal(at.y, 870 - 400 - 6);
});

test('it keeps to the monitor the rect is on, not the biggest one', () => {
  const app = screens(
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 1440, height: 900 },
  );
  const at = anchorScreenRect(
    app,
    { x: 1930, y: 0, width: 20, height: 22 },
    { ...POPOVER, align: 'center' },
  );
  // centred it would start at 1800, across the seam on the other display
  assert.equal(at.x, 1920);
});

test('the monitor comes from the whole rect, not the corner above it', () => {
  // #618. A menu-bar item's frame starts a few *points above* the top of the
  // display it is on — `convertRectToScreen:` reports 33x30 at y = −1443 on a
  // display whose top edge is −1440 — so the rect's top-left corner is on no
  // monitor at all, and on this desk the externals reach down to y = 0 and so
  // contain points just above the built-in's top edge. Picking the monitor
  // from that corner opened the popover on a display the user was not
  // looking at. Three 2x displays, the traced arrangement, device pixels
  // here and logical points in the clicks below.
  const app = screens(
    { x: 0, y: 0, width: 3456, height: 2234 }, // built-in, 1728x1117 points
    { x: -3246, y: -2880, width: 5120, height: 2880 }, // left external
    { x: 1874, y: -2880, width: 5120, height: 2880 }, // right external
  );
  const click = (x, y) =>
    anchorScreenRect(
      app,
      { x, y, width: 33, height: 30 },
      { ...POPOVER, align: 'center', offset: 6, scale: 2 },
    );
  /** Which display a placed popover is on, in the points the clicks are in. */
  const display = ({ x, y }) =>
    y >= 0 ? 'built-in' : x < 937 ? 'left external' : 'right external';

  // the item on the left external: right by luck before, since the largest
  // monitor the fallback reached for happened to be this one
  assert.equal(display(click(435, -1443)), 'left external');
  // the item on the right external: the corner is off every monitor, and the
  // fallback put the popover on the *left* one, clamped to its right edge
  assert.deepEqual(click(2995, -1443), {
    x: 2871.5,
    y: -1407,
    width: 280,
    height: 400,
    placement: 'bottom',
  });
  // and the item on the built-in, whose corner at y = −3 is inside the right
  // external — a monitor that contains it and is still the wrong one
  assert.deepEqual(click(1500, -3), {
    x: 1376.5,
    y: 33,
    width: 280,
    height: 400,
    placement: 'bottom',
  });
});

test('a rect off every monitor takes the nearest, not the biggest', () => {
  // The other half of #618: a rect that is on no monitor is nearly always
  // just outside one of them — menu-bar furniture, a pointer at the very
  // edge — and the largest display can be anywhere on the desk.
  const app = screens(
    { x: 0, y: 0, width: 800, height: 600 },
    { x: 2000, y: 0, width: 3840, height: 2160 },
  );
  const at = anchorScreenRect(
    app,
    { x: 300, y: -60, width: 30, height: 20 },
    { ...POPOVER, offset: 6 },
  );
  // 40px above the small display and 1670 to the left of the big one: the
  // popover belongs on the small one, pulled down to its top edge. Against
  // the largest it was pushed out to x = 2000, the big display's left edge.
  assert.deepEqual([at.x, at.y], [300, 0]);
});

test('logical in and out, against a monitor in device pixels', () => {
  // the monitor is device pixels, as the server reports it; the rect and the
  // answer are logical, like a popup's x and y
  const app = screens({ x: 0, y: 0, width: 2880, height: 1800 });
  const options = { ...POPOVER, align: 'center', offset: 6, scale: 2 };
  const at = anchorScreenRect(app, ITEM, options);
  assert.deepEqual([at.x, at.y], [1440 - 280, 28], 'the 1440-point edge');
  // a half-point centre lands on a device pixel rather than between two
  const odd = anchorScreenRect(
    app,
    { x: 700, y: 0, width: 31, height: 22 },
    { ...options, width: 280.5 },
  );
  // centred at device 1400 + 31 − 280.5 = 1150.5, rounded there to 1151:
  // a whole device pixel, and so a half point
  assert.equal(odd.x, 575.5);
});

test('a point is a rect with no size, and `start` mirrors with the direction', () => {
  const app = screens({ x: 0, y: 0, width: 1440, height: 900 });
  const point = anchorScreenRect(app, { x: 400, y: 300 }, { width: 100 });
  assert.deepEqual([point.x, point.y], [400, 302]);
  const rtl = anchorScreenRect(app, ITEM, {
    ...POPOVER,
    direction: 'rtl',
    offset: 0,
  });
  assert.equal(rtl.x, 1380 + 30 - 280, "an RTL start is the rect's right");
  assert.equal(anchorScreenRect(app, { y: 3 }, POPOVER), null);
});

// --- the element ------------------------------------------------------------

async function renderMock(app, element) {
  const root = await createRoot({ app });
  await new Promise((resolve) => root.render(element, resolve));
  await tick();
  return root;
}

/** A popover the size of its content, anchored to `rect`, at the root with
 *  no window around it — how a menu-bar app writes one. */
const popover = (rect, props = {}) =>
  h(
    'popup',
    {
      anchor: { rect, placement: 'bottom', align: 'center', offset: 6 },
      ...props,
    },
    h('box', { style: { width: 200, height: 100 } }),
  );

test('a popup anchored to a rect is born there, at its content’s size', async () => {
  const app = createMockApp(); // one 1280x800 monitor
  const root = await renderMock(
    app,
    popover({ x: 1200, y: 0, width: 30, height: 22 }),
  );
  const [wnd] = app.windows;
  assert.deepEqual([wnd.width, wnd.height], [200, 100]);
  assert.deepEqual([wnd.x, wnd.y], [1280 - 200, 28], 'clamped at the edge');
  assert.equal(wnd.mapped, true, 'there is no node to wait for');
  assert.deepEqual(
    wnd.calls.filter(([op]) => op === 'move'),
    [],
    'born there, not moved there',
  );

  // a click on another item is a new rect, and the popup follows it
  await new Promise((resolve) =>
    root.render(popover({ x: 600, y: 0, width: 30, height: 22 }), resolve),
  );
  await tick();
  assert.deepEqual([wnd.x, wnd.y], [615 - 100, 28]);
  await root.unmount();
});

test('a popup set right to left starts at the right of the rect', async () => {
  const app = createMockApp();
  const rect = { x: 600, y: 0, width: 30, height: 22 };
  const at = async (direction) => {
    const root = await renderMock(
      app,
      h(
        'popup',
        { anchor: { rect, offset: 6 }, style: { direction } },
        h('box', { style: { width: 200, height: 100 } }),
      ),
    );
    const wnd = app.windows.at(-1);
    const x = wnd.x;
    await root.unmount();
    return x;
  };
  assert.equal(await at('ltr'), 600);
  assert.equal(await at('rtl'), 630 - 200);
});

test('a popup can trade a node anchor for a rect and back', async () => {
  const app = createMockApp();
  const trigger = React.createRef();
  const scene = (anchor) =>
    h(
      'window',
      { width: 300, height: 200 },
      h('box', { ref: trigger, style: { margin: 20, width: 40, height: 20 } }),
      h('popup', { anchor }, h('box', { style: { width: 50, height: 30 } })),
    );
  const root = await renderMock(app, scene({ to: trigger }));
  await tick();
  const popup = app.windows[1];
  assert.deepEqual([popup.x, popup.y], [20, 42]);

  await new Promise((resolve) =>
    root.render(scene({ rect: { x: 500, y: 400 } }), resolve),
  );
  await tick();
  assert.deepEqual([popup.x, popup.y], [500, 402]);
  assert.equal(popup.mapped, true);
  // nothing in the window can move a rect on the screen, so the popup stops
  // re-placing itself on every layout pass there
  const owner = app.windows[0]._reactX11Node;
  assert.equal(owner._anchorListeners.size, 0);

  await new Promise((resolve) => root.render(scene({ to: trigger }), resolve));
  await tick();
  assert.deepEqual([popup.x, popup.y], [20, 42]);
  await root.unmount();
});

// --- the keyboard -----------------------------------------------------------

test('grabKeyboard holds a keyboard grab while the popup is up', async () => {
  const app = createMockApp();
  const scroller = React.createRef();
  const line = React.createRef();
  const scene = (open = true) =>
    h(
      'window',
      { width: 300, height: 200 },
      h(
        'box',
        { ref: scroller, style: { overflow: 'scroll', height: 100 } },
        h('box', { ref: line, style: { height: 600 } }),
      ),
      open &&
        h(
          'popup',
          {
            anchor: { to: line, at: { x: 10, y: 30, width: 1, height: 16 } },
            grabKeyboard: true,
          },
          h('box', { style: { width: 50, height: 30 } }),
        ),
    );
  const root = await renderMock(app, scene());
  await tick();
  const popup = app.windows[1];
  assert.equal(popup.keyboardGrabbed, true);

  // out of view, the popup unmaps, and X drops a grab whose window stops
  // being viewable — so it is let go of, and taken again with the map
  scroller.current.scrollTo({ y: 260 });
  await tick();
  await tick();
  assert.equal(popup.mapped, false);
  assert.equal(popup.keyboardGrabbed, false);
  scroller.current.scrollTo({ y: 0 });
  await tick();
  await tick();
  assert.equal(popup.mapped, true);
  assert.equal(popup.keyboardGrabbed, true);

  await new Promise((resolve) => root.render(scene(false), resolve));
  await tick();
  assert.equal(popup.keyboardGrabbed, false, 'and let go of when it closes');
  await root.unmount();
});

test('with the grab a popup hears keys that no window of the app has focus for', async () => {
  for (const grabKeyboard of [false, true]) {
    const keys = [];
    const api = await renderX11(
      h(
        'popup',
        {
          x: 300,
          y: 300,
          grabKeyboard,
          onKeyDown: (ev) => keys.push(ev.key),
        },
        h('box', { style: { width: 60, height: 40 } }),
      ),
      { wrap: false },
    );
    const target = api.windowNode;
    // The harness gives the window it mounted the input focus; a menu-bar
    // app's popover has no such luck — the focus is another application's,
    // which to this client is the same as none at all.
    const { X } = target.app;
    X.SetInputFocus(0, 0);
    await new Promise((resolve) => X.GetInputFocus(() => resolve()));
    fireEvent.key(XK_SPACE, { target });
    await tick();
    await tick();
    assert.deepEqual(
      keys,
      grabKeyboard ? [' '] : [],
      grabKeyboard ? 'the grab brings the key' : 'the control: nowhere to go',
    );
    await cleanup();
  }
});

test('on Cocoa it is a window AppKit can make key, shown activating the app', async () => {
  const { native, app } = fakeCocoaApp();
  const root = await createRoot({ app });
  const scene = (grabKeyboard) =>
    popover({ x: 1200, y: 0, width: 30, height: 22 }, { grabKeyboard });

  root.render(scene(false));
  await tick();
  let [call] = native.of('createWindow2');
  assert.equal(call[0].kind, 'popup', 'a plain popup is the non-key panel');
  assert.equal(native.of('showWindow').at(-1)[1], false);
  root.render(null);
  await tick();

  native.calls.length = 0;
  root.render(scene(true));
  await tick();
  [call] = native.of('createWindow2');
  assert.equal(call[0].kind, 'borderless');
  assert.equal(call[0].level, 'popup');
  assert.equal(native.of('showWindow').at(-1)[1], true, 'and it activates');

  // Keys go to the key window, and to the last one with none. A popover
  // that took the keyboard and closed is not that window any more.
  const wnd = [...app._windows.values()][0];
  app._route({ type: 'window-focus', windowNumber: wnd.windowNumber });
  assert.equal(app._lastKeyWindow, wnd);
  root.render(null);
  await tick();
  assert.equal(app._lastKeyWindow, null);
  await root.unmount();
});
