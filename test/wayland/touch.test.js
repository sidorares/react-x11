// Touch against the in-process compositor: the first finger as the pointer
// (a press carrying the down's serial, the titlebar move, the edge resize),
// a second finger that emulates nothing, the raw touchstart/touchmove/
// touchend/touchcancel with every point in content pixels, cancel, a React
// tree clicked by a finger, and a touchscreen that comes and goes. Real
// protocol, no display, no GPU.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';
import React from 'react';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { WaylandWindow, RESIZE_EDGE } from '../../src/wayland/window.js';
import { WaylandSeat, BUTTON_MASK } from '../../src/wayland/seat.js';
import { WaylandTouch } from '../../src/wayland/touch.js';
import { InputRouter } from '../../src/wayland/input.js';
import { TITLEBAR_HEIGHT, BORDER } from '../../src/wayland/decorations.js';
import { createRoot } from '../../src/index.js';
import { createMockApp } from '../helpers/mock-app.js';
import {
  MockCompositor,
  until,
  waylandClientAvailable,
} from './mock-compositor.js';
import {
  asBackendWindow,
  routedWindow,
  routerApp,
  record,
  POINTER_EVENTS,
  TOUCH_EVENTS,
} from './harness.js';

const SKIP = waylandClientAvailable
  ? false
  : 'wayland-client (the fork) is not installed';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const BUTTON1 = BUTTON_MASK[1];
/** content point (x, y) in surface-local logical coordinates */
const at = (x, y) => [BORDER + x, TITLEBAR_HEIGHT + BORDER + y];

let mock;
let conn;
let compositor;
let wmBase;
let seat;
let touch;
let wl;
let win;
let app;
let router;

before(async () => {
  if (SKIP) return;
  mock = new MockCompositor({ width: 640, height: 480, capabilities: 7 });
  const p = await mock.listen();
  const sock = net.createConnection(p);
  await new Promise((r) => sock.once('connect', r));
  conn = await WaylandConnection.open({
    socket: sock,
    protocols: [
      'xdg-shell',
      'cursor-shape-v1',
      'viewporter',
      'fractional-scale-v1',
      'tablet-v2',
    ],
  });
  compositor = await conn.require('wl_compositor');
  wmBase = await conn.require('xdg_wm_base');
  seat = await WaylandSeat.bind(conn);
  touch = WaylandTouch.attach(seat);
  await until(() => mock.touch, { what: 'the seat to hand out a touch' });
  wl = WaylandWindow.createSync({
    conn,
    compositor,
    wmBase,
    title: 'touch',
    width: 640,
    height: 480,
  });
  await wl.whenConfigured;
  // a 2x output, so the device-pixel conversion is visible in every number
  wl.scale = 2;
  win = routedWindow(wl);
  app = routerApp(seat, [win]);
  router = new InputRouter(app);
});

after(() => {
  conn?.destroy();
  mock?.close();
});

const EVENTS = [...POINTER_EVENTS, ...TOUCH_EVENTS];

test(
  'the seat with a touchscreen asks for a touch; the capability is what decides',
  { skip: SKIP },
  () => {
    assert.equal(mock.sent('wl_seat', 'get_touch').length, 1);
    assert.equal(seat.touch, touch);
    assert.ok(touch.touch, 'the wl_touch proxy');
  },
);

test(
  'a tap is the pointer: enter, a button-1 press with the down serial, release, leave — and the raw points alongside',
  { skip: SKIP },
  async () => {
    win.removeAllListeners();
    const got = record(win, EVENTS);
    const sid = wl.surface.id;
    const down = mock.touchDown(sid, 0, ...at(60, 80));
    mock.touchFrame();
    mock.touchMotion(0, ...at(65, 85));
    mock.touchFrame();
    mock.touchUp(0);
    mock.touchFrame();
    await until(() => got.count('mouseout') === 1, {
      what: 'the finger to lift',
    });

    assert.deepEqual(
      got.map((g) => g.n),
      [
        'touchstart',
        'mouseover',
        'mousedown',
        'touchmove',
        'mousemove',
        'touchend',
        'mouseup',
        'mouseout',
      ],
      'the raw event first, then the pointer it stands in for',
    );
    const press = got.of('mousedown')[0];
    assert.equal(press.x, 120, 'content-relative, times the scale');
    assert.equal(press.y, 160);
    assert.equal(press.keycode, 1, 'a finger is button 1');
    assert.equal(press.buttons & BUTTON1, 0, 'nothing held before the press');
    assert.equal(press.serial, down, "the down's serial, for move/resize");
    assert.equal(press.pointerType, 'touch');
    assert.equal(press.touchId, 0);
    assert.equal(press.pressure, 0.5);
    const move = got.of('mousemove')[0];
    assert.ok(move.buttons & BUTTON1, 'the drag carries the held button');
    assert.deepEqual([move.x, move.y], [130, 170]);
    const release = got.of('mouseup')[0];
    assert.ok(release.buttons & BUTTON1, 'held before the release, as X says');
    assert.equal(release.pressure, 0);
    const start = got.of('touchstart')[0];
    assert.equal(start.id, 0);
    assert.equal(start.touchId, 0, "ntk's XI2 name for it");
    assert.equal(start.pointerType, 'touch');
    assert.deepEqual(start.touches, [{ id: 0, x: 120, y: 160 }]);
    assert.equal(start.serial, down);
    assert.equal(
      start.buttons & BUTTON1,
      0,
      'the buttons before it, like a press: not yet the finger itself',
    );
    const end = got.of('touchend')[0];
    assert.deepEqual(end.touches, [], 'gone from the list');
    assert.ok(end.buttons & BUTTON1, 'held before the lift, like a release');
    assert.equal(seat.buttonMask, 0);
    assert.equal(touch.points.size, 0);
    assert.equal(touch.emulated, null);
  },
);

test(
  'a second finger emulates nothing: raw events for both, one pointer',
  { skip: SKIP },
  async () => {
    win.removeAllListeners();
    const got = record(win, EVENTS);
    const sid = wl.surface.id;
    mock.touchDown(sid, 0, ...at(10, 10));
    mock.touchFrame();
    mock.touchDown(sid, 1, ...at(100, 10));
    mock.touchFrame();
    mock.touchMotion(1, ...at(110, 20));
    mock.touchFrame();
    mock.touchUp(0);
    mock.touchFrame();
    mock.touchUp(1);
    mock.touchFrame();
    await until(() => got.count('touchend') === 2, { what: 'both to lift' });

    assert.equal(got.count('mousedown'), 1);
    assert.equal(got.count('mouseup'), 1);
    assert.equal(got.of('mouseup')[0].touchId, 0, 'the first finger was it');
    assert.equal(
      got.count('mousemove'),
      0,
      "the second finger's motion is not the pointer's",
    );
    assert.equal(got.count('touchmove'), 1);
    const second = got.of('touchstart')[1];
    assert.equal(second.id, 1);
    assert.equal(second.touches.length, 2, 'both points, in order');
    assert.deepEqual(second.touches[1], { id: 1, x: 200, y: 20 });
    assert.equal(
      got.of('touchend')[0].touches.length,
      1,
      'the other finger is still down',
    );
    assert.equal(seat.buttonMask, 0);
  },
);

test(
  "a finger on the titlebar moves the window with the down's serial; on an edge it resizes; the tree sees neither",
  { skip: SKIP },
  async () => {
    win.removeAllListeners();
    const got = record(win, EVENTS);
    const sid = wl.surface.id;
    const move = mock.touchDown(sid, 2, 200, 10);
    mock.touchFrame();
    await until(() => mock.sent('xdg_toplevel', 'move').length === 1, {
      what: 'the move request',
    });
    assert.deepEqual(mock.sent('xdg_toplevel', 'move')[0].args, [
      seat.seat.id,
      move,
    ]);
    // the compositor has the gesture now, and says so the way mutter does:
    // the sequence is cancelled, and nothing more arrives for it
    mock.touchCancel();
    await until(() => seat.buttonMask === 0, { what: 'the cancel' });
    const resize = mock.touchDown(sid, 3, 2, 200);
    mock.touchFrame();
    await until(() => mock.sent('xdg_toplevel', 'resize').length === 1, {
      what: 'the resize request',
    });
    assert.deepEqual(mock.sent('xdg_toplevel', 'resize')[0].args, [
      seat.seat.id,
      resize,
      RESIZE_EDGE.LEFT,
    ]);
    mock.touchCancel();
    await until(() => seat.buttonMask === 0, { what: 'the cancel' });
    assert.equal(got.count('mousedown'), 0);
    assert.equal(got.count('mousemove'), 0);
    assert.equal(got.count('mouseup'), 0);
    assert.equal(
      got.count('touchstart') +
        got.count('touchmove') +
        got.count('touchend') +
        got.count('touchcancel'),
      0,
      "a point that began on the frame is the frame's for its whole life",
    );
    assert.equal(touch.points.size, 0);
  },
);

test(
  'cancel finalises every point: touchcancel for each, a release for the one that was the pointer',
  { skip: SKIP },
  async () => {
    win.removeAllListeners();
    const got = record(win, EVENTS);
    const sid = wl.surface.id;
    mock.touchDown(sid, 0, ...at(20, 20));
    mock.touchDown(sid, 1, ...at(80, 20));
    mock.touchFrame();
    await until(() => got.count('mousedown') === 1, { what: 'the press' });
    mock.touchCancel();
    await until(() => got.count('touchcancel') === 2, { what: 'the cancel' });
    assert.equal(got.count('mouseup'), 1);
    assert.equal(got.count('mouseout'), 1);
    assert.equal(seat.buttonMask, 0);
    assert.equal(touch.points.size, 0);
    assert.equal(touch.emulated, null);
    // and the ids are free again
    mock.touchDown(sid, 0, ...at(20, 20));
    mock.touchFrame();
    mock.touchUp(0);
    mock.touchFrame();
    await until(() => got.count('mouseup') === 2, { what: 'a fresh tap' });
  },
);

test(
  'the contact shape rides on the raw event, even when it arrives after the point',
  { skip: SKIP },
  async () => {
    win.removeAllListeners();
    const got = record(win, TOUCH_EVENTS);
    const sid = wl.surface.id;
    mock.touchDown(sid, 0, ...at(20, 20));
    mock.touchShape(0, 10, 6);
    mock.touchFrame();
    mock.touchUp(0);
    mock.touchFrame();
    await until(() => got.count('touchend') === 1, { what: 'the tap' });
    const start = got.of('touchstart')[0];
    assert.equal(start.radiusX, 10, 'half the major axis, in device pixels');
    assert.equal(start.radiusY, 6);
  },
);

test(
  'the pointer is the pointer again once the finger lifts',
  { skip: SKIP },
  async () => {
    win.removeAllListeners();
    const got = record(win, EVENTS);
    const sid = wl.surface.id;
    mock.pointerEnter(sid, ...at(5, 50));
    await until(() => got.count('mouseover') === 1, { what: 'the pointer' });
    assert.equal(router.pointerWindow, win);
    mock.touchDown(sid, 0, ...at(20, 20));
    mock.touchFrame();
    mock.touchUp(0);
    mock.touchFrame();
    await until(() => got.count('mouseup') === 1, { what: 'the tap' });
    assert.equal(router.pointerWindow, win, 'the window under the mouse');
    const last = got[got.length - 1];
    assert.equal(last.n, 'mouseover', 'the pointer re-entered');
    assert.deepEqual([last.ev.x, last.ev.y], [10, 100], 'where the mouse is');
    assert.equal(last.ev.pointerType, undefined, 'a mouse says nothing');
    mock.pointerLeave(sid);
    await until(() => router.pointerWindow === null, { what: 'the leave' });
  },
);

test(
  'a React tree: a tap is a mousedown, mouseup and click, and the handler can tell it was a finger',
  { skip: SKIP },
  async () => {
    const mockApp = createMockApp();
    const root = await createRoot({ app: mockApp });
    const seen = [];
    root.render(
      h(
        'window',
        { width: 200, height: 100 },
        h('box', {
          style: { width: 100, height: 50 },
          onMouseDown: (e) =>
            seen.push(['down', e.nativeEvent.pointerType, e.x, e.y]),
          onMouseUp: (e) => seen.push(['up', e.nativeEvent.pointerType]),
          onClick: (e) => seen.push(['click', e.nativeEvent.touchId]),
        }),
      ),
    );
    await tick();
    const wnd = mockApp.windows[0];
    assert.ok(wnd, 'the tree made a window');
    const wl2 = WaylandWindow.createSync({
      conn,
      compositor,
      wmBase,
      title: 'tree',
      width: 640,
      height: 480,
    });
    await wl2.whenConfigured;
    asBackendWindow(wnd, wl2);
    app.windows.set(wl2.surface.id, wnd);
    const raw = record(wnd, TOUCH_EVENTS);

    mock.touchDown(wl2.surface.id, 0, ...at(10, 10));
    mock.touchFrame();
    mock.touchUp(0);
    mock.touchFrame();
    await until(() => seen.some((s) => s[0] === 'click'), {
      what: 'the click',
    });
    assert.deepEqual(seen, [
      ['down', 'touch', 10, 10],
      ['up', 'touch'],
      ['click', 0],
    ]);
    assert.equal(raw.count('touchstart'), 1, 'the raw event is there too');
    assert.equal(raw.count('touchend'), 1);
    app.windows.delete(wl2.surface.id);
    wl2.destroy();
    await root.unmount();
  },
);

test(
  'a touchscreen that goes away is released, and asked for again when it returns',
  { skip: SKIP },
  async () => {
    win.removeAllListeners();
    const got = record(win, EVENTS);
    mock.capabilities(3);
    await until(() => touch.touch === null, { what: 'the touch to go' });
    await until(() => mock.sent('wl_touch', 'release').length === 1, {
      what: 'the release request',
    });
    const before = mock.touch;
    mock.capabilities(7);
    await until(() => mock.touch !== before, { what: 'a new touch' });
    assert.equal(mock.sent('wl_seat', 'get_touch').length, 2);
    // and it works
    mock.touchDown(wl.surface.id, 0, ...at(30, 30));
    mock.touchFrame();
    mock.touchUp(0);
    mock.touchFrame();
    await until(() => got.count('mouseup') === 1, { what: 'a tap' });
  },
);
