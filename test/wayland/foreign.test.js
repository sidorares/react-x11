// xdg-foreign: the handle a portal dialog is parented to on Wayland
// (src/wayland/app.js, `exportHandle`; src/portal.js, `portalParentFor`).
//
// Before this, the file dialog sent the portal `x11:<id>` for a Wayland
// window — the backend's own window number dressed as an XID, which names no
// X window at all, or on a desktop running Xwayland somebody else's. These
// pin the replacement over the real protocol: one export per toplevel, the
// same handle every time it is asked, none for a popup (a protocol error
// that would end the connection), the export destroyed with the window, and
// `''` rather than an X handle where the compositor has no xdg-foreign.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { WaylandApp } from '../../src/wayland/app.js';
import { WaylandWindow } from '../../src/wayland/window.js';
import { portalParentFor } from '../../src/portal.js';
import {
  MockCompositor,
  until,
  waylandClientAvailable,
} from './mock-compositor.js';

const SKIP = waylandClientAvailable
  ? false
  : '@windowkit/wayland is not installed';

let mock;
let conn;
let app;

before(async () => {
  if (SKIP) return;
  mock = new MockCompositor({ width: 640, height: 480 });
  const sock = net.createConnection(await mock.listen());
  await new Promise((r) => sock.once('connect', r));
  conn = await WaylandConnection.open({
    socket: sock,
    protocols: ['xdg-shell', 'xdg-foreign-unstable-v2'],
  });
  app = new WaylandApp(conn, {});
  app.compositor = await conn.require('wl_compositor');
  app.wmBase = await conn.require('xdg_wm_base');
  app.exporter = await conn.bind('zxdg_exporter_v2');
});

after(() => {
  conn?.destroy();
  mock?.close();
});

/** A backend window as far as these two functions read one. */
async function toplevel(id) {
  const wl = WaylandWindow.createSync({
    conn,
    compositor: app.compositor,
    wmBase: app.wmBase,
    title: `T${id}`,
    width: 100,
    height: 100,
  });
  await wl.whenConfigured;
  const win = { id, app, wl, isPopup: false, isLayer: false };
  app.windows.set(wl.surface.id, win);
  app.toplevels.push(win);
  return win;
}

test(
  'a toplevel is exported once, and named the same way every time',
  {
    skip: SKIP,
  },
  async () => {
    const win = await toplevel(41);
    assert.equal(await app.exportHandle(win), 'mock-export-1');
    assert.equal(await app.exportHandle(win), 'mock-export-1');
    assert.equal(
      mock.exports.length,
      1,
      'a second dialog from the same window does not export it again',
    );

    // what the portal is handed, from anything that names the window
    assert.equal(await portalParentFor(win), 'wayland:mock-export-1');
    // a bare number is this app's own window id, resolved through the app
    assert.equal(await portalParentFor(41, app), 'wayland:mock-export-1');

    // gone with the window, and before its surface
    app._forgetWindow(win);
    await conn.roundtrip();
    assert.equal(mock.exports[0].destroyed, true);
    win.wl.destroy();
  },
);

test(
  'a popup or a layer surface is not asked for, which would be fatal',
  {
    skip: SKIP,
  },
  async () => {
    const before = mock.exports.length;
    const popup = { id: 50, app, wl: { surface: { id: 999 } }, isPopup: true };
    const layer = { id: 51, app, wl: { surface: { id: 998 } }, isLayer: true };
    assert.equal(await app.exportHandle(popup), null);
    assert.equal(await app.exportHandle(layer), null);
    assert.equal(await portalParentFor(popup), '');
    await conn.roundtrip();
    assert.equal(mock.exports.length, before, 'no export_toplevel went out');
    assert.equal(conn.destroyed, false, 'the connection is still up');
  },
);

test(
  'without xdg-foreign the dialog floats — never an x11: handle',
  {
    skip: SKIP,
  },
  async () => {
    const win = await toplevel(60);
    const exporter = app.exporter;
    app.exporter = null;
    try {
      assert.equal(await portalParentFor(win), '');
      assert.equal(await portalParentFor(60, app), '');
    } finally {
      app.exporter = exporter;
      app._forgetWindow(win);
      win.wl.destroy();
    }
  },
);

test('an X11 window still gets its x11: handle', { skip: SKIP }, async () => {
  const x11 = { id: 0x1a00007, app: { backend: 'x11' } };
  assert.equal(await portalParentFor(x11), 'x11:1a00007');
  assert.equal(await portalParentFor(0x1a00007), 'x11:1a00007');
  assert.equal(await portalParentFor(null), '');
});

test(
  'the handle arrives before the dialog asks for it',
  { skip: SKIP },
  async () => {
    // the export is a round trip; asking twice at once shares the one request
    const win = await toplevel(70);
    const [a, b] = await Promise.all([
      app.exportHandle(win),
      app.exportHandle(win),
    ]);
    assert.equal(a, b);
    await until(() => mock.exports.some((e) => e.handle === a), {
      what: 'the export on the compositor side',
    });
    app._forgetWindow(win);
    win.wl.destroy();
  },
);
