// Tablets against the in-process compositor: the tablet seat, tools
// announced and described, proximity as an enter with the tool's cursor,
// the axes on the emulated events, down/up and the barrel buttons as button
// presses with the right serials, proximity-out releasing what is held, a
// React tree pressed by a pen and a titlebar moved by one, the puck, the
// wheel, and a tool that goes away mid-stroke. Real protocol, no display,
// no GPU.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';
import React from 'react';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { WaylandWindow } from '../../src/wayland/window.js';
import { WaylandSeat, BTN, BUTTON_MASK } from '../../src/wayland/seat.js';
import {
  WaylandTablet,
  TOOL_TYPE,
  TOOL_CAP,
  BTN_STYLUS,
  BTN_STYLUS2,
} from '../../src/wayland/tablet.js';
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
} from './harness.js';

const SKIP = waylandClientAvailable
  ? false
  : 'wayland-client (the fork) is not installed';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const BUTTON1 = BUTTON_MASK[1];
const BUTTON2 = BUTTON_MASK[2];
/** content point (x, y) in surface-local logical coordinates */
const at = (x, y) => [BORDER + x, TITLEBAR_HEIGHT + BORDER + y];
const near = (a, b) => Math.abs(a - b) < 1e-4;

let mock;
let conn;
let compositor;
let wmBase;
let seat;
let tablet;
let tabletId;
let penId;
let wl;
let win;
let app;
let router;

/** The tool's own cursor-shape device, and the shapes set on it so far. */
function toolShapes(toolId) {
  const dev = mock
    .sent('wp_cursor_shape_manager_v1', 'get_tablet_tool_v2')
    .find((r) => r.args[1] === toolId)?.args[0];
  return mock
    .sent('wp_cursor_shape_device_v1', 'set_shape')
    .filter((r) => r.id === dev)
    .map((r) => r.args);
}

before(async () => {
  if (SKIP) return;
  mock = new MockCompositor({ width: 640, height: 480 });
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
  tablet = await WaylandTablet.bind(conn, seat);
  await until(() => mock.tabletSeat, { what: 'the tablet seat' });
  tabletId = mock.tabletAdded();
  penId = mock.toolAdded({
    type: TOOL_TYPE.PEN,
    capabilities: [TOOL_CAP.PRESSURE, TOOL_CAP.TILT],
  });
  await until(() => tablet.tools.has(penId), { what: 'the pen' });
  wl = WaylandWindow.createSync({
    conn,
    compositor,
    wmBase,
    title: 'tablet',
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

test(
  'the tablet seat: bound on the seat, tablets and tools announced and described before use',
  { skip: SKIP },
  async () => {
    assert.ok(tablet, 'the compositor advertises the manager');
    assert.equal(seat.tablet, tablet);
    assert.deepEqual(
      mock.sent('zwp_tablet_manager_v2', 'get_tablet_seat')[0].args[1],
      seat.seat.id,
    );
    const t = tablet.tablets.get(tabletId);
    assert.equal(t.name, 'Mock Tablet');
    assert.equal(t.vid, 0x056a);
    assert.equal(t.path, '/dev/input/event9');
    const pen = tablet.tools.get(penId);
    assert.equal(pen.typeName, 'pen');
    assert.equal(pen.pointerType, 'pen');
    assert.deepEqual([...pen.capabilities].sort(), ['pressure', 'tilt']);
    assert.equal(pen.hardwareSerial, '2a');
    assert.equal(pen.surface, null, 'not over anything yet');
    assert.ok(
      mock
        .sent('wp_cursor_shape_manager_v1', 'get_tablet_tool_v2')
        .some((r) => r.args[1] === penId),
      'the tool got a cursor device of its own',
    );
    assert.equal(
      await WaylandTablet.bind({ bind: async () => null }, seat),
      null,
      'no manager, no tablet — not an error',
    );
  },
);

test(
  "proximity is an enter with the tool's cursor; motion carries the axes in DOM ranges",
  { skip: SKIP },
  async () => {
    win.removeAllListeners();
    const got = record(win, POINTER_EVENTS);
    const sid = wl.surface.id;
    const prox = mock.toolProximityIn(penId, tabletId, sid);
    mock.toolMotion(penId, ...at(50, 60));
    mock.toolAxis(penId, 'pressure', 32768);
    mock.toolAxis(penId, 'tilt', 10.5, -5);
    mock.toolFrame(penId);
    await until(() => got.count('mousemove') === 1, { what: 'the hover' });

    assert.deepEqual(
      got.map((g) => g.n),
      ['mouseover', 'mousemove'],
    );
    const move = got.of('mousemove')[0];
    assert.deepEqual([move.x, move.y], [50, 60], 'content-relative');
    assert.equal(move.pointerType, 'pen');
    assert.equal(move.toolType, 'pen');
    assert.ok(near(move.pressure, 32768 / 65535), `pressure ${move.pressure}`);
    assert.equal(move.tiltX, 10.5);
    assert.equal(move.tiltY, -5);
    assert.equal(move.buttons & BUTTON1, 0, 'hovering, not pressing');
    assert.equal(router.pointerWindow, win, 'the pen is the pointer now');
    assert.equal(tablet.tools.get(penId).surface, sid);

    await until(() => toolShapes(penId).length >= 1, { what: 'the cursor' });
    assert.deepEqual(
      toolShapes(penId).pop(),
      [prox, 1],
      'the default arrow, with the proximity serial',
    );
    seat.setCursor('text');
    await until(() => toolShapes(penId).pop()[1] === 9, { what: 'an I-beam' });
    assert.deepEqual(toolShapes(penId).pop(), [prox, 9]);
    seat.setCursor('default');
  },
);

test(
  "down and up are button 1 with the down's serial; the barrel buttons are 3 and 2",
  { skip: SKIP },
  async () => {
    win.removeAllListeners();
    const got = record(win, POINTER_EVENTS);
    const down = mock.toolDown(penId);
    mock.toolFrame(penId);
    const side = mock.toolButton(penId, BTN_STYLUS, true);
    mock.toolFrame(penId);
    mock.toolButton(penId, BTN_STYLUS, false);
    mock.toolFrame(penId);
    mock.toolButton(penId, BTN_STYLUS2, true);
    mock.toolFrame(penId);
    mock.toolUp(penId);
    mock.toolFrame(penId);
    await until(() => got.count('mouseup') === 2, { what: 'the releases' });

    const downs = got.of('mousedown');
    assert.deepEqual(
      downs.map((e) => e.keycode),
      [1, 3, 2],
    );
    assert.equal(downs[0].serial, down, "the down's serial");
    assert.equal(downs[0].buttons & BUTTON1, 0);
    assert.equal(downs[0].pointerType, 'pen');
    assert.ok(near(downs[0].pressure, 32768 / 65535), 'the last pressure');
    assert.equal(downs[1].serial, side);
    assert.ok(downs[1].buttons & BUTTON1, 'the tip was down already');
    const ups = got.of('mouseup');
    assert.deepEqual(
      ups.map((e) => e.keycode),
      [3, 1],
    );
    assert.ok(ups[1].buttons & BUTTON2, 'the second barrel button is held');
    assert.equal(seat.buttonMask, BUTTON2, 'still held, as the seat sees it');
    assert.equal(tablet.tools.get(penId).down, false);
  },
);

test(
  'proximity out releases what is held, then leaves',
  { skip: SKIP },
  async () => {
    win.removeAllListeners();
    const got = record(win, POINTER_EVENTS);
    mock.toolProximityOut(penId);
    mock.toolFrame(penId);
    await until(() => got.count('mouseout') === 1, { what: 'the leave' });
    assert.deepEqual(
      got.map((g) => g.n),
      ['mouseup', 'mouseout'],
    );
    assert.equal(got.of('mouseup')[0].keycode, 2);
    assert.equal(seat.buttonMask, 0);
    assert.equal(tablet.tools.get(penId).surface, null);
    assert.equal(router.pointerWindow, null);
  },
);

test(
  "a React tree: a pen press is a mousedown with its axes; on the titlebar it moves the window with the down's serial",
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
            seen.push([
              'down',
              e.nativeEvent.pointerType,
              e.x,
              e.y,
              e.nativeEvent.pressure,
            ]),
          onClick: (e) => seen.push(['click', e.nativeEvent.pointerType]),
        }),
      ),
    );
    await tick();
    const wnd = mockApp.windows[0];
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

    mock.toolProximityIn(penId, tabletId, wl2.surface.id);
    mock.toolMotion(penId, ...at(10, 10));
    mock.toolAxis(penId, 'pressure', 65535);
    mock.toolFrame(penId);
    mock.toolDown(penId);
    mock.toolFrame(penId);
    mock.toolUp(penId);
    mock.toolFrame(penId);
    await until(() => seen.some((s) => s[0] === 'click'), {
      what: 'the click',
    });
    assert.deepEqual(seen, [
      ['down', 'pen', 10, 10, 1],
      ['click', 'pen'],
    ]);

    // the titlebar: the compositor's move, with the serial of this down
    mock.toolMotion(penId, 200, 10);
    mock.toolFrame(penId);
    const down = mock.toolDown(penId);
    mock.toolFrame(penId);
    await until(() => mock.sent('xdg_toplevel', 'move').length === 1, {
      what: 'the move request',
    });
    assert.deepEqual(mock.sent('xdg_toplevel', 'move')[0].args, [
      seat.seat.id,
      down,
    ]);
    assert.equal(seen.length, 2, 'the tree saw nothing of it');
    mock.toolUp(penId);
    mock.toolProximityOut(penId);
    mock.toolFrame(penId);
    await until(() => seat.buttonMask === 0, { what: 'the pen to lift' });
    app.windows.delete(wl2.surface.id);
    wl2.destroy();
    await root.unmount();
  },
);

test(
  "an eraser is an eraser; a puck is a mouse whose buttons are its own and whose pressure is the DOM's stand-in; a removed tool is destroyed",
  { skip: SKIP },
  async () => {
    win.removeAllListeners();
    const got = record(win, POINTER_EVENTS);
    const eraserId = mock.toolAdded({
      type: TOOL_TYPE.ERASER,
      capabilities: [TOOL_CAP.PRESSURE],
    });
    const puckId = mock.toolAdded({ type: TOOL_TYPE.MOUSE, capabilities: [] });
    await until(() => tablet.tools.has(eraserId) && tablet.tools.has(puckId), {
      what: 'two more tools',
    });
    assert.equal(tablet.tools.get(eraserId).pointerType, 'eraser');
    assert.equal(tablet.tools.get(eraserId).typeName, 'eraser');
    assert.equal(tablet.tools.get(puckId).pointerType, 'mouse');

    const sid = wl.surface.id;
    mock.toolProximityIn(puckId, tabletId, sid);
    mock.toolMotion(puckId, ...at(30, 30));
    mock.toolButton(puckId, BTN.RIGHT, true);
    mock.toolFrame(puckId);
    await until(() => got.count('mousedown') === 1, { what: 'the press' });
    const press = got.of('mousedown')[0];
    assert.equal(press.keycode, 3, "a puck's right button is the right button");
    assert.equal(press.pointerType, 'mouse');
    assert.equal(press.pressure, 0.5, 'no pressure axis: half while pressed');
    mock.toolButton(puckId, BTN.RIGHT, false);
    mock.toolProximityOut(puckId);
    mock.toolFrame(puckId);
    await until(() => got.count('mouseout') === 1, { what: 'the leave' });
    assert.equal(got.of('mouseup')[0].pressure, 0);

    mock.toolRemoved(eraserId);
    await until(() => !tablet.tools.has(eraserId), { what: 'the removal' });
    await until(
      () =>
        mock
          .sent('zwp_tablet_tool_v2', 'destroy')
          .some((r) => r.id === eraserId),
      { what: 'the destroy request' },
    );
  },
);

test('the wheel on a tool scrolls', { skip: SKIP }, async () => {
  win.removeAllListeners();
  const got = record(win, POINTER_EVENTS);
  const sid = wl.surface.id;
  mock.toolProximityIn(penId, tabletId, sid);
  mock.toolMotion(penId, ...at(30, 30));
  mock.toolFrame(penId);
  mock.toolAxis(penId, 'wheel', 15, 2);
  mock.toolFrame(penId);
  await until(() => got.count('wheel') === 1, { what: 'the wheel' });
  const wheel = got.of('wheel')[0];
  assert.equal(wheel.deltaY, 2, 'clicks are notches');
  assert.equal(wheel.smooth, false);
  assert.equal(wheel.pointerType, 'pen');
  assert.deepEqual([wheel.x, wheel.y], [30, 30]);
});

test(
  'a tool that goes away mid-stroke releases what it held and leaves',
  { skip: SKIP },
  async () => {
    win.removeAllListeners();
    const got = record(win, POINTER_EVENTS);
    mock.toolDown(penId);
    mock.toolFrame(penId);
    await until(() => got.count('mousedown') === 1, { what: 'the press' });
    assert.equal(seat.buttonMask, BUTTON1);
    mock.toolRemoved(penId);
    await until(() => got.count('mouseout') === 1, { what: 'the leave' });
    assert.equal(got.count('mouseup'), 1);
    assert.equal(seat.buttonMask, 0);
    assert.equal(tablet.tools.has(penId), false);
    assert.equal(router.pointerWindow, null);
  },
);
