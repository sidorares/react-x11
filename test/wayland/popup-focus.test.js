// Mutter gives the keyboard to a popup that grabs: `wl_keyboard` leaves the
// window and enters the popup as the popup's setup finishes, and comes back
// when the popup goes. X never focuses an override-redirect window, and the
// tree's focus model is X's. A Select closes its list when its trigger
// blurs, so while the window heard that move as a blur, every dropdown on
// GNOME closed the moment it was configured — before it ever showed. The
// mock moves the keyboard the way mutter does.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { WaylandWindow } from '../../src/wayland/window.js';
import { WaylandSeat } from '../../src/wayland/seat.js';
import { InputRouter } from '../../src/wayland/input.js';
import {
  MockCompositor,
  until,
  waylandClientAvailable,
} from './mock-compositor.js';
import { record, routedWindow, routerApp } from './harness.js';

const SKIP = waylandClientAvailable
  ? false
  : '@windowkit/wayland is not installed';

const FOCUS_EVENTS = ['focus', 'blur', 'keydown', 'keyup'];
/** past the moment a keyboard leave is held for */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let mock;
let conn;
let compositor;
let wmBase;
let seat;
let wl;
let win;
let app;
let router;

before(async () => {
  if (SKIP) return;
  mock = new MockCompositor({ width: 640, height: 480 });
  const p = await mock.listen();
  const sock = net.createConnection(p);
  await new Promise((r) => sock.once('connect', r));
  conn = await WaylandConnection.open({ socket: sock });
  compositor = await conn.require('wl_compositor');
  wmBase = await conn.require('xdg_wm_base');
  seat = await WaylandSeat.bind(conn);
  await until(() => mock.keyboard, { what: 'the keyboard' });
  wl = WaylandWindow.createSync({
    conn,
    compositor,
    wmBase,
    title: 'focus',
    width: 640,
    height: 480,
  });
  await wl.whenConfigured;
  win = routedWindow(wl);
  app = routerApp(seat, [win]);
  router = new InputRouter(app);
});

after(() => {
  conn?.destroy();
  mock?.close();
});

/** A popup over `parent`, made and shown the way the backend shows a menu. */
function openPopup(parent, { grab = true } = {}) {
  const pw = WaylandWindow.createPopupSync({
    conn,
    compositor,
    wmBase,
    parent: parent.wl,
    x: 10,
    y: 20,
    width: 80,
    height: 40,
    commit: false,
  });
  const popup = routedWindow(pw, { decorations: false });
  Object.assign(popup, { isPopup: true, parentWindow: parent });
  app.windows.set(pw.surface.id, popup);
  if (grab) pw.takeGrab(seat.seat, seat.lastPressSerial || 1);
  pw.commitInitial();
  return popup;
}

/** Gone from the app first, as a destroyed backend window is. */
function closePopup(popup) {
  app.windows.delete(popup.wl.surface.id);
  popup.wl.destroy();
}

const keyboardOn = (surfaceId, what) =>
  until(() => mock.keyboardFocus === surfaceId && seat.focus === surfaceId, {
    what,
  });

test(
  'the keyboard moving onto a grabbing popup and back is no focus change, and the keys stay the window’s',
  { skip: SKIP },
  async () => {
    const got = record(win, FOCUS_EVENTS);
    mock.keyboardEnter(wl.surface.id);
    await until(() => got.count('focus') === 1, { what: 'the focus' });
    assert.equal(router.focusWindow, win);

    const menu = openPopup(win);
    const onMenu = record(menu, FOCUS_EVENTS);
    await keyboardOn(menu.wl.surface.id, 'the keyboard on the menu');
    await settle();
    assert.equal(got.count('blur'), 0, 'the window never blurred');
    assert.equal(got.count('focus'), 1, 'nor was it focused again');
    assert.equal(router.focusWindow, win);

    mock.key(30, true);
    mock.key(30, false);
    await until(() => got.count('keyup') === 1, { what: 'the key' });
    assert.equal(got.count('keydown'), 1, 'the key went to the window');
    assert.equal(onMenu.length, 0, 'the popup itself heard nothing');

    closePopup(menu);
    await keyboardOn(wl.surface.id, 'the keyboard back on the window');
    await settle();
    assert.equal(got.count('blur'), 0);
    assert.equal(got.count('focus'), 1);
    assert.equal(router.focusWindow, win);
  },
);

test(
  'a submenu is the same family: the keyboard down the chain and back up',
  { skip: SKIP },
  async () => {
    const got = record(win, FOCUS_EVENTS);
    const menu = openPopup(win);
    await keyboardOn(menu.wl.surface.id, 'the menu');
    const sub = openPopup(menu);
    await keyboardOn(sub.wl.surface.id, 'the submenu');
    mock.key(31, true);
    mock.key(31, false);
    await until(() => got.count('keyup') === 1, { what: 'the key' });
    closePopup(sub);
    await keyboardOn(menu.wl.surface.id, 'back on the menu');
    closePopup(menu);
    await keyboardOn(wl.surface.id, 'back on the window');
    await settle();
    assert.equal(got.count('blur') + got.count('focus'), 0);
    assert.equal(got.count('keydown'), 1);
    assert.equal(router.focusWindow, win);
  },
);

test(
  'a popup that does not grab never takes the keyboard',
  { skip: SKIP },
  async () => {
    const tip = openPopup(win, { grab: false });
    await tip.wl.whenConfigured;
    await conn.roundtrip();
    assert.equal(mock.keyboardFocus, wl.surface.id);
    closePopup(tip);
    await conn.roundtrip();
    assert.equal(mock.keyboardFocus, wl.surface.id);
  },
);

test(
  'the keyboard leaving for another client is a blur, once the held moment is over',
  { skip: SKIP },
  async () => {
    const got = record(win, FOCUS_EVENTS);
    const menu = openPopup(win);
    await keyboardOn(menu.wl.surface.id, 'the menu');
    // another client takes the keyboard while the menu has it
    mock.keyboardLeave(menu.wl.surface.id);
    await until(() => got.count('blur') === 1, { what: 'the blur' });
    assert.equal(router.focusWindow, null);
    closePopup(menu);
    mock.keyboardEnter(wl.surface.id);
    await until(() => got.count('focus') === 1, { what: 'focus again' });
    assert.equal(router.focusWindow, win);
  },
);
