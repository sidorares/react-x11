// xdg-decoration against the in-process compositor: the request goes out
// before the first commit, the answer is adopted with the configure it rode
// in on (and heard before it), and a later change of heart by the
// compositor arrives the same way. Plus the nullable-object requests the
// fork of wayland-client cannot encode on its own.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { WaylandWindow } from '../../src/wayland/window.js';
import { DECORATION_MODE, decorationPolicy } from '../../src/wayland/ssd.js';
import {
  MockCompositor,
  until,
  waylandClientAvailable,
} from './mock-compositor.js';

const SKIP = waylandClientAvailable
  ? false
  : 'wayland-client (the fork) is not installed';

let mock;
let conn;
let compositor;
let wmBase;
let manager;

before(async () => {
  if (SKIP) return;
  mock = new MockCompositor({ width: 640, height: 480 });
  const p = await mock.listen();
  const sock = net.createConnection(p);
  await new Promise((r) => sock.once('connect', r));
  conn = await WaylandConnection.open({
    socket: sock,
    protocols: ['xdg-shell', 'xdg-decoration-unstable-v1'],
  });
  compositor = await conn.require('wl_compositor');
  wmBase = await conn.require('xdg_wm_base');
  manager = await conn.require('zxdg_decoration_manager_v1');
});

after(() => {
  conn?.destroy();
  mock?.close();
});

test('decorationPolicy: what `decorations` means at the app and the window', () => {
  assert.deepEqual(decorationPolicy(undefined, undefined), {
    draw: true,
    prefer: 'server',
  });
  assert.deepEqual(decorationPolicy(true, undefined), {
    draw: true,
    prefer: 'server',
  });
  assert.deepEqual(decorationPolicy('server', undefined), {
    draw: true,
    prefer: 'server',
  });
  assert.deepEqual(decorationPolicy('client', undefined), {
    draw: true,
    prefer: 'client',
  });
  assert.deepEqual(
    decorationPolicy(false, undefined),
    { draw: false, prefer: 'client' },
    'no frame at all still declines server-side, or sway would draw one',
  );
  assert.deepEqual(
    decorationPolicy(undefined, false),
    { draw: false, prefer: 'client' },
    'the per-window false wins',
  );
});

test(
  'a toplevel asks for server-side before its first commit and adopts the answer with the configure',
  { skip: SKIP },
  async () => {
    const win = WaylandWindow.createSync({
      conn,
      compositor,
      wmBase,
      title: 'D',
      width: 300,
      height: 200,
      decorations: { manager, prefer: 'server' },
    });
    const heard = [];
    win.on('decorationmode', (m) => heard.push(`decorationmode:${m}`));
    win.on('configure', () => heard.push('configure'));
    assert.equal(win.decorationMode, 'client', 'nothing agreed yet');
    await win.whenConfigured;

    // the ask came before the commit that asked for the first configure
    const names = mock.requests.map((r) => `${r.iface}.${r.name}`);
    const asked = names.indexOf(
      'zxdg_decoration_manager_v1.get_toplevel_decoration',
    );
    const preferred = names.indexOf('zxdg_toplevel_decoration_v1.set_mode');
    const committed = names.indexOf('wl_surface.commit');
    assert.ok(
      asked >= 0 && asked < committed,
      'decoration object before the commit',
    );
    assert.ok(
      preferred > asked && preferred < committed,
      'mode stated before the commit',
    );
    assert.deepEqual(
      mock.sent('zxdg_toplevel_decoration_v1', 'set_mode')[0].args,
      [DECORATION_MODE.SERVER_SIDE],
    );

    assert.equal(win.decorationMode, 'server', 'the compositor granted it');
    assert.deepEqual(
      heard,
      ['decorationmode:server', 'configure'],
      'the mode is heard before the configure that carries it',
    );

    // the compositor changes its mind: the same sequence, the other way
    mock.setDecorationMode(win.surface.id, DECORATION_MODE.CLIENT_SIDE);
    await until(() => win.decorationMode === 'client', {
      what: 'the client-side mode to be adopted',
    });
    assert.deepEqual(heard.slice(2), ['decorationmode:client', 'configure']);
    assert.equal(
      win.configurePending,
      true,
      'and it is acked like any configure',
    );
    win.ackPending();

    // a configure that repeats the mode is not a change
    mock.setDecorationMode(win.surface.id, DECORATION_MODE.CLIENT_SIDE);
    await until(() => heard.length === 5, { what: 'the repeat configure' });
    assert.equal(heard[4], 'configure', 'no decorationmode for a repeat');

    win.destroy();
    await conn.roundtrip();
    const order = mock.requests.map((r) => `${r.iface}.${r.name}`);
    assert.ok(
      order.lastIndexOf('zxdg_toplevel_decoration_v1.destroy') <
        order.lastIndexOf('xdg_toplevel.destroy'),
      'the decoration goes before the toplevel it decorates',
    );
  },
);

test('prefer client: the ask is client_side', { skip: SKIP }, async () => {
  const before = mock.sent('zxdg_toplevel_decoration_v1', 'set_mode').length;
  const win = WaylandWindow.createSync({
    conn,
    compositor,
    wmBase,
    title: 'C',
    width: 100,
    height: 100,
    decorations: { manager, prefer: 'client' },
  });
  await win.whenConfigured;
  const modes = mock.sent('zxdg_toplevel_decoration_v1', 'set_mode');
  assert.equal(modes.length, before + 1);
  assert.deepEqual(modes[modes.length - 1].args, [DECORATION_MODE.CLIENT_SIDE]);
  assert.equal(win.decorationMode, 'client', 'the mock echoes the ask');
  win.destroy();
});

test(
  'without a manager nothing is asked and the mode stays client',
  { skip: SKIP },
  async () => {
    const before = mock.sent('zxdg_decoration_manager_v1').length;
    const win = WaylandWindow.createSync({
      conn,
      compositor,
      wmBase,
      title: 'N',
      width: 100,
      height: 100,
    });
    await win.whenConfigured;
    assert.equal(win.decoration, null);
    assert.equal(win.decorationMode, 'client');
    assert.equal(mock.sent('zxdg_decoration_manager_v1').length, before);
    win.destroy();
  },
);

test(
  'nullable objects: set_parent(null) and set_fullscreen(null) reach the compositor as 0',
  { skip: SKIP },
  async () => {
    const win = WaylandWindow.createSync({
      conn,
      compositor,
      wmBase,
      title: 'Z',
      width: 100,
      height: 100,
    });
    await win.whenConfigured;
    win.setParent(null);
    win.fullscreen(true);
    await conn.roundtrip();
    assert.deepEqual(mock.sent('xdg_toplevel', 'set_parent').pop().args, [0]);
    assert.deepEqual(
      mock.sent('xdg_toplevel', 'set_fullscreen').pop().args,
      [0],
    );
    // and a real parent still goes through as itself
    const other = WaylandWindow.createSync({
      conn,
      compositor,
      wmBase,
      title: 'Y',
      width: 100,
      height: 100,
    });
    win.setParent(other);
    await conn.roundtrip();
    assert.deepEqual(mock.sent('xdg_toplevel', 'set_parent').pop().args, [
      other.toplevel.id,
    ]);
    other.destroy();
    win.destroy();
  },
);
