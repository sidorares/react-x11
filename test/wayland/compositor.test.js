// The client against the in-process compositor (mock-compositor.js): the
// registry and the configure handshake, the deferred ack, the frame clock,
// popups and their positioner, and seat events arriving as the shaped input
// the renderer consumes. Real protocol, no display, no GPU.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import {
  WaylandWindow,
  TOPLEVEL_STATE,
  RESIZE_EDGE,
} from '../../src/wayland/window.js';
import { WaylandSeat, BTN } from '../../src/wayland/seat.js';
import { MockCompositor, until } from './mock-compositor.js';

let mock;
let conn;
let compositor;
let wmBase;

async function connectPlain() {
  const p = await mock.listen();
  const sock = net.createConnection(p);
  await new Promise((r) => sock.once('connect', r));
  return WaylandConnection.open({
    socket: sock,
    protocols: [
      'xdg-shell',
      'cursor-shape-v1',
      'viewporter',
      'fractional-scale-v1',
    ],
  });
}

before(async () => {
  mock = new MockCompositor({ width: 640, height: 480 });
  conn = await connectPlain();
  compositor = await conn.require('wl_compositor');
  wmBase = await conn.require('xdg_wm_base');
});

after(() => {
  conn?.destroy();
  mock?.close();
});

test('the registry: globals are listed and binding works', async () => {
  assert.ok(conn.has('wl_compositor'));
  assert.ok(conn.has('xdg_wm_base'));
  assert.equal(
    conn.has('zwp_linux_dmabuf_v1'),
    false,
    'the mock offers no GPU buffers',
  );
  assert.equal(
    await conn.bind('zwp_linux_dmabuf_v1'),
    null,
    'an absent global binds to null, not an error',
  );
  await assert.rejects(
    conn.require('zwp_linux_dmabuf_v1'),
    /does not advertise/,
  );
  assert.equal(
    await conn.bind('wl_compositor'),
    compositor,
    'singletons are bound once',
  );
});

test('a toplevel: created without awaiting, configured by the compositor, acked lazily', async () => {
  const win = WaylandWindow.createSync({
    conn,
    compositor,
    wmBase,
    title: 'T',
    appId: 'test',
    width: 300,
    height: 200,
  });
  assert.equal(win.configured, false, 'nothing has come back yet');
  assert.equal(
    win.width,
    300,
    'the size we asked for stands until the compositor says otherwise',
  );
  await win.whenConfigured;
  assert.equal(win.width, 640, 'the compositor imposed its own size');
  assert.equal(win.height, 480);
  assert.ok(win.states.has(TOPLEVEL_STATE.ACTIVATED));
  assert.equal(
    win.configurePending,
    true,
    'the serial is held for the frame that adopts it',
  );
  assert.equal(
    mock.sent('xdg_surface', 'ack_configure').length,
    0,
    'not acked yet',
  );
  win.ackPending();
  await conn.roundtrip();
  assert.equal(mock.sent('xdg_surface', 'ack_configure').length, 1);
  assert.equal(
    mock.sent('xdg_surface', 'set_window_geometry').length,
    1,
    'geometry is told once per size',
  );
  assert.equal(win.configurePending, false);
  const titles = mock.sent('xdg_toplevel', 'set_title');
  assert.deepEqual(titles[titles.length - 1].args, ['T']);
  win.destroy();
  await conn.roundtrip();
  assert.equal(mock.sent('xdg_toplevel', 'destroy').length, 1);
});

test('a reconfigure changes the size and states and is acked with the next frame', async () => {
  const win = WaylandWindow.createSync({
    conn,
    compositor,
    wmBase,
    title: 'R',
    width: 100,
    height: 100,
  });
  await win.whenConfigured;
  win.ackPending();
  const resized = new Promise((r) => win.once('resize', r));
  const stated = new Promise((r) => win.once('statechange', r));
  mock.configure(win.surface.id, {
    width: 800,
    height: 600,
    states: [TOPLEVEL_STATE.MAXIMIZED, TOPLEVEL_STATE.ACTIVATED],
  });
  assert.deepEqual(await resized, { width: 800, height: 600 });
  assert.ok((await stated).includes(TOPLEVEL_STATE.MAXIMIZED));
  assert.equal(win.configurePending, true);
  win.ackPending();
  await conn.roundtrip();
  assert.equal(
    mock.sent('xdg_surface', 'ack_configure').length,
    3,
    'one per adopted configure across the tests so far',
  );
  win.destroy();
});

test('the frame clock: a frame request rides the next commit and comes back with a time', async () => {
  const win = WaylandWindow.createSync({
    conn,
    compositor,
    wmBase,
    title: 'F',
    width: 100,
    height: 100,
  });
  await win.whenConfigured;
  const vsync = win.scheduleFrame();
  win.ackPending();
  win.surface.$.commit();
  const t = await vsync;
  assert.ok(t > 0, `a compositor timestamp: ${t}`);
  win.destroy();
});

test('a popup: positioner, parent and grab', async () => {
  const parent = WaylandWindow.createSync({
    conn,
    compositor,
    wmBase,
    title: 'P',
    width: 100,
    height: 100,
  });
  await parent.whenConfigured;
  const seatProxy = await conn.require('wl_seat');
  const popup = WaylandWindow.createPopupSync({
    conn,
    compositor,
    wmBase,
    parent,
    x: 40,
    y: 60,
    width: 120,
    height: 80,
    grab: { seat: seatProxy, serial: 7 },
  });
  await popup.whenConfigured;
  assert.equal(popup.kind, 'popup');
  assert.equal(popup.width, 120);
  assert.equal(popup.x, 40, 'the compositor placed it where the anchor asked');
  const pos = mock.sent('xdg_positioner');
  assert.deepEqual(pos.find((r) => r.name === 'set_size').args, [120, 80]);
  assert.deepEqual(
    pos.find((r) => r.name === 'set_anchor_rect').args,
    [40, 60, 1, 1],
  );
  assert.ok(
    pos.some((r) => r.name === 'set_constraint_adjustment'),
    "slide/flip policy is the positioner's",
  );
  const getPopup = mock.sent('xdg_surface', 'get_popup')[0];
  assert.equal(
    getPopup.args[1],
    parent.xdgSurface.id,
    "parented to the toplevel's xdg_surface",
  );
  assert.deepEqual(mock.sent('xdg_popup', 'grab')[0].args, [seatProxy.id, 7]);
  const done = new Promise((r) => popup.once('close', r));
  mock.send(popup.popup.id, 'popup_done');
  await done;
  popup.destroy();
  parent.destroy();
});

test('the seat: pointer events come out shaped, with X button numbers and a state mask', async () => {
  const win = WaylandWindow.createSync({
    conn,
    compositor,
    wmBase,
    title: 'S',
    width: 100,
    height: 100,
  });
  await win.whenConfigured;
  // a seat of this test's own: wait for *its* pointer and keyboard, not the
  // ones an earlier test's seat left behind on the mock
  const seenPointer = mock.pointer;
  const seenKeyboard = mock.keyboard;
  const seat = await WaylandSeat.bind(conn);
  await until(
    () => mock.pointer !== seenPointer && mock.keyboard !== seenKeyboard,
    { what: 'the seat to hand out a pointer and keyboard' },
  );
  const got = [];
  for (const n of [
    'enter',
    'motion',
    'buttonpress',
    'buttonrelease',
    'wheel',
    'leave',
  ])
    seat.on(n, (ev) => got.push({ n, ev }));

  mock.pointerEnter(win.surface.id, 10.5, 20.25);
  mock.pointerMotion(30, 40);
  mock.pointerButton(BTN.LEFT, true);
  mock.pointerButton(BTN.LEFT, false);
  mock.pointerButton(BTN.RIGHT, true);
  mock.pointerAxis({ axis: 0, value: 30, v120: 360, source: 0 });
  mock.pointerAxis({ axis: 0, value: 12.5, source: 1 });
  mock.pointerLeave(win.surface.id);
  await until(() => got.filter((g) => g.n === 'leave').length === 1, {
    what: 'the pointer to leave',
  });

  const names = got.map((g) => g.n);
  assert.deepEqual(names, [
    'enter',
    'motion',
    'buttonpress',
    'buttonrelease',
    'buttonpress',
    'wheel',
    'wheel',
    'leave',
  ]);
  assert.equal(
    got[0].ev.x,
    10.5,
    'fixed-point coordinates decode to fractions',
  );
  assert.equal(got[1].ev.surface, win.surface.id);
  const press = got[2].ev;
  assert.equal(press.button, 1, 'BTN_LEFT is button 1');
  assert.equal(press.state, 0, 'no button was held before the press');
  assert.equal(got[3].ev.button, 1);
  assert.equal(got[4].ev.button, 3, 'BTN_RIGHT is button 3');
  assert.ok(seat.lastPressSerial > 0);
  const wheel = got[5].ev;
  assert.equal(wheel.deltaY, 3, 'axis_value120 gives notches: 360/120');
  assert.equal(wheel.smooth, false, 'a wheel source is discrete');
  const finger = got[6].ev;
  assert.equal(finger.smooth, true, 'a finger source is smooth');
  assert.equal(finger.deltaY, 1.25, 'continuous distance in notches of 10');
  assert.equal(
    seat.pointerSurface,
    null,
    'after leave nothing is under the pointer',
  );
  assert.ok(
    mock.sent('wp_cursor_shape_device_v1', 'set_shape').length >= 1,
    'a cursor was set on enter',
  );
  win.destroy();
});

test('the seat: keys carry the modifier state and repeat until released', async () => {
  const win = WaylandWindow.createSync({
    conn,
    compositor,
    wmBase,
    title: 'K',
    width: 100,
    height: 100,
  });
  await win.whenConfigured;
  const seenKeyboard = mock.keyboard;
  const seat = await WaylandSeat.bind(conn);
  await until(() => mock.keyboard && mock.keyboard !== seenKeyboard, {
    what: 'a keyboard',
  });
  const keys = [];
  seat.on('keydown', (ev) => keys.push(ev));
  let focusEv = null;
  seat.once('focus', (ev) => (focusEv = ev));
  mock.keyboardEnter(win.surface.id);
  await until(() => focusEv, { what: 'keyboard focus' });
  assert.equal(focusEv.surface, win.surface.id);
  mock.modifiers(1 /* Shift */, 0, 2 /* Lock */, 0);
  mock.key(16 /* Q */, true);
  await until(() => keys.length >= 3, { what: 'key repeat', timeout: 2000 });
  mock.key(16, false);
  const n = keys.length;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(keys.length, n, 'release stops the repeat');
  assert.equal(keys[0].keycode, 24, 'evdev 16 is X keycode 24');
  assert.equal(
    keys[0].buttons & 0xff,
    3,
    'depressed|latched|locked -> the X state mask',
  );
  assert.equal(keys[0].repeat, false);
  assert.equal(keys[1].repeat, true);
  assert.equal(
    keys[0].keysym,
    0,
    'no keymap arrived over a plain socket, so no keysym',
  );
  assert.deepEqual(seat.repeat, { rate: 30, delay: 400 });
  win.destroy();
});

test('resize edges and a move are requests naming the seat and serial', async () => {
  const win = WaylandWindow.createSync({
    conn,
    compositor,
    wmBase,
    title: 'M',
    width: 100,
    height: 100,
  });
  await win.whenConfigured;
  const seatProxy = await conn.require('wl_seat');
  win.startMove(seatProxy, 99);
  win.startResize(seatProxy, 100, RESIZE_EDGE.BOTTOM_RIGHT);
  win.maximize(true);
  await conn.roundtrip();
  assert.deepEqual(mock.sent('xdg_toplevel', 'move').pop().args, [
    seatProxy.id,
    99,
  ]);
  assert.deepEqual(mock.sent('xdg_toplevel', 'resize').pop().args, [
    seatProxy.id,
    100,
    RESIZE_EDGE.BOTTOM_RIGHT,
  ]);
  assert.equal(mock.sent('xdg_toplevel', 'set_maximized').length, 1);
  win.destroy();
});

test('close is a request the client hears', async () => {
  const win = WaylandWindow.createSync({
    conn,
    compositor,
    wmBase,
    title: 'C',
    width: 100,
    height: 100,
  });
  await win.whenConfigured;
  const closed = new Promise((r) => win.once('close', r));
  mock.requestClose(win.surface.id);
  await closed;
  win.destroy();
});
