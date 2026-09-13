// wlr-layer-shell: which windows become layer surfaces and what they ask
// for (pure), and the handshake against the in-process compositor — the
// configure that carries a size, the ack through the layer surface, the
// stretched axis the compositor owns, a popup adopted by its layer parent,
// and the compositor taking the surface down.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { WaylandWindow } from '../../src/wayland/window.js';
import {
  ANCHOR,
  KEYBOARD,
  LAYER,
  ALL_EDGES,
  anchorValue,
  exclusiveZoneFor,
  layerRoleFor,
} from '../../src/wayland/layershell.js';
import {
  MockCompositor,
  until,
  waylandClientAvailable,
} from './mock-compositor.js';

const SKIP = waylandClientAvailable
  ? false
  : 'wayland-client (the fork) is not installed';

// ---- the mapping, no compositor needed ------------------------------------

test('layerRoleFor: an ordinary window is not a layer surface', () => {
  assert.equal(layerRoleFor({ width: 300, height: 200 }), null);
  assert.equal(layerRoleFor({ windowType: 'dialog' }), null);
  assert.equal(layerRoleFor({ windowType: ['normal', 'dock'] }), null);
  assert.equal(
    layerRoleFor({ windowType: 'dock', layerShell: false }),
    null,
    'layerShell: false keeps a dock an xdg_toplevel',
  );
});

test('layerRoleFor: a dock reads its edge off its shape and position', () => {
  const bottom = layerRoleFor({ windowType: 'dock', width: 800, height: 40 });
  assert.equal(bottom.layer, LAYER.TOP);
  assert.equal(
    bottom.anchor,
    ANCHOR.BOTTOM,
    'wide, not at y 0: a bottom panel',
  );
  assert.equal(bottom.exclusiveZone, 'auto');
  assert.equal(bottom.keyboardInteractivity, KEYBOARD.NONE);
  assert.equal(bottom.namespace, 'react-x11-dock');
  assert.equal(bottom.output, null);

  const top = layerRoleFor({
    windowType: 'dock',
    width: 800,
    height: 40,
    y: 0,
  });
  assert.equal(top.anchor, ANCHOR.TOP);
  const left = layerRoleFor({
    windowType: 'dock',
    width: 60,
    height: 900,
    x: 0,
  });
  assert.equal(left.anchor, ANCHOR.LEFT);
  const right = layerRoleFor({ windowType: 'dock', width: 60, height: 900 });
  assert.equal(right.anchor, ANCHOR.RIGHT);
});

test('layerRoleFor: the other window types', () => {
  const desktop = layerRoleFor({ windowType: 'desktop' });
  assert.equal(desktop.layer, LAYER.BACKGROUND);
  assert.equal(desktop.anchor, ALL_EDGES);
  assert.equal(desktop.exclusiveZone, -1, 'a wallpaper ignores every strut');

  const note = layerRoleFor({
    windowType: 'notification',
    width: 300,
    height: 80,
  });
  assert.equal(note.layer, LAYER.TOP);
  assert.equal(note.anchor, ANCHOR.TOP | ANCHOR.RIGHT);
  assert.deepEqual(note.margin, { top: 12, right: 12, bottom: 12, left: 12 });

  const splash = layerRoleFor({
    windowType: 'splash',
    width: 400,
    height: 300,
  });
  assert.equal(splash.layer, LAYER.OVERLAY);
  assert.equal(splash.anchor, 0, 'unanchored: the compositor centres it');
});

test('layerRoleFor: a layerShell object overrides, and works without a type', () => {
  const panel = layerRoleFor({
    windowType: 'dock',
    width: 300,
    height: 40,
    layerShell: { anchor: ['bottom', 'left', 'right'], layer: 'bottom' },
  });
  assert.equal(panel.anchor, ANCHOR.BOTTOM | ANCHOR.LEFT | ANCHOR.RIGHT);
  assert.equal(panel.layer, LAYER.BOTTOM);
  assert.equal(panel.exclusiveZone, 'auto', 'the dock default survives');

  const osd = layerRoleFor({
    width: 200,
    height: 60,
    layerShell: {
      layer: 'overlay',
      anchor: 'bottom',
      margin: { bottom: 40 },
      exclusiveZone: 0,
      keyboardInteractivity: 'on-demand',
      namespace: 'volume-osd',
    },
  });
  assert.equal(osd.layer, LAYER.OVERLAY);
  assert.equal(osd.anchor, ANCHOR.BOTTOM);
  assert.deepEqual(osd.margin, { top: 0, right: 0, bottom: 40, left: 0 });
  assert.equal(osd.keyboardInteractivity, KEYBOARD.ON_DEMAND);
  assert.equal(osd.namespace, 'volume-osd');

  assert.throws(
    () => layerRoleFor({ layerShell: { layer: 'sideways' } }),
    /unknown layer/,
  );
  assert.throws(() => anchorValue(['top', 'middle']), /unknown anchor edge/);
});

test('exclusiveZoneFor: the thickness across the one anchored axis', () => {
  assert.equal(exclusiveZoneFor(ANCHOR.BOTTOM, 800, 40), 40);
  assert.equal(
    exclusiveZoneFor(ANCHOR.BOTTOM | ANCHOR.LEFT | ANCHOR.RIGHT, 800, 40),
    40,
  );
  assert.equal(exclusiveZoneFor(ANCHOR.LEFT, 60, 900), 60);
  assert.equal(
    exclusiveZoneFor(ANCHOR.TOP | ANCHOR.LEFT, 60, 60),
    0,
    'a corner reserves nothing',
  );
  assert.equal(exclusiveZoneFor(0, 60, 60), 0);
  assert.equal(exclusiveZoneFor(ALL_EDGES, 60, 60), 0);
});

// ---- against the compositor -------------------------------------------------

let mock;
let conn;
let compositor;
let wmBase;
let layerShell;

before(async () => {
  if (SKIP) return;
  mock = new MockCompositor({ width: 640, height: 480 });
  const p = await mock.listen();
  const sock = net.createConnection(p);
  await new Promise((r) => sock.once('connect', r));
  conn = await WaylandConnection.open({
    socket: sock,
    protocols: ['xdg-shell', 'wlr-layer-shell-unstable-v1'],
  });
  compositor = await conn.require('wl_compositor');
  wmBase = await conn.require('xdg_wm_base');
  layerShell = await conn.require('zwlr_layer_shell_v1');
});

after(() => {
  conn?.destroy();
  mock?.close();
});

test(
  'a bottom dock: the requests, the configure with a size, the ack through the layer surface',
  { skip: SKIP },
  async () => {
    const win = WaylandWindow.createLayerSync({
      conn,
      compositor,
      layerShell,
      width: 300,
      height: 40,
      layer: 'top',
      anchor: 'bottom',
      exclusiveZone: 'auto',
      namespace: 'react-x11-dock',
    });
    assert.equal(win.kind, 'layer');
    assert.equal(win.xdgSurface, null);
    assert.equal(win.toplevel, null);
    assert.ok(win.layer, 'the role object');
    assert.equal(win.layer.stretchX, false);
    await win.whenConfigured;

    const made = mock.sent('zwlr_layer_shell_v1', 'get_layer_surface')[0];
    assert.equal(made.args[1], win.surface.id);
    assert.equal(made.args[2], 0, 'a null output: the compositor picks');
    assert.equal(made.args[3], LAYER.TOP);
    assert.equal(made.args[4], 'react-x11-dock');
    const ls = (name) => mock.sent('zwlr_layer_surface_v1', name).pop().args;
    assert.deepEqual(ls('set_size'), [300, 40]);
    assert.deepEqual(ls('set_anchor'), [ANCHOR.BOTTOM]);
    assert.deepEqual(ls('set_exclusive_zone'), [40], "'auto' is the thickness");
    assert.deepEqual(ls('set_margin'), [0, 0, 0, 0]);
    assert.deepEqual(ls('set_keyboard_interactivity'), [KEYBOARD.NONE]);

    assert.equal(win.width, 300, 'the compositor echoed the size');
    assert.equal(win.height, 40);
    assert.equal(win.configurePending, true);
    win.ackPending();
    await conn.roundtrip();
    assert.equal(mock.sent('zwlr_layer_surface_v1', 'ack_configure').length, 1);
    assert.equal(
      mock.sent('xdg_surface', 'set_window_geometry').length,
      0,
      'a layer surface has no window geometry',
    );

    // a resize on a measured strut moves the strut too
    win.layer.resize(300, 56);
    await conn.roundtrip();
    assert.deepEqual(ls('set_size'), [300, 56]);
    assert.deepEqual(ls('set_exclusive_zone'), [56]);

    win.destroy();
    await conn.roundtrip();
    assert.equal(mock.sent('zwlr_layer_surface_v1', 'destroy').length, 1);
  },
);

test(
  'a full-width panel: the stretched axis is the compositor’s',
  { skip: SKIP },
  async () => {
    const win = WaylandWindow.createLayerSync({
      conn,
      compositor,
      layerShell,
      width: 300,
      height: 40,
      anchor: ['bottom', 'left', 'right'],
      exclusiveZone: 'auto',
    });
    assert.equal(win.layer.stretchX, true);
    assert.equal(win.layer.stretchY, false);
    const resized = new Promise((r) => win.once('resize', r));
    await win.whenConfigured;
    assert.deepEqual(
      mock.sent('zwlr_layer_surface_v1', 'set_size').pop().args,
      [0, 40],
      '0 on the stretched axis',
    );
    assert.deepEqual(await resized, { width: 640, height: 40 });
    assert.equal(win.width, 640, "the output's width");
    assert.equal(win.layer.exclusiveZone, 40);

    // a later configure at another size is adopted the same way
    const again = new Promise((r) => win.once('resize', r));
    mock.configureLayer(win.surface.id, { width: 1024, height: 40 });
    assert.deepEqual(await again, { width: 1024, height: 40 });
    win.destroy();
  },
);

test(
  'a popup from a layer parent: no xdg parent, adopted by the layer surface before its commit',
  { skip: SKIP },
  async () => {
    const dock = WaylandWindow.createLayerSync({
      conn,
      compositor,
      layerShell,
      width: 300,
      height: 40,
      anchor: 'bottom',
    });
    await dock.whenConfigured;
    const popup = WaylandWindow.createPopupSync({
      conn,
      compositor,
      wmBase,
      parent: dock,
      x: 20,
      y: 0,
      width: 120,
      height: 80,
    });
    await popup.whenConfigured;
    const got = mock.sent('xdg_surface', 'get_popup').pop();
    assert.equal(got.args[1], 0, 'a null parent');
    const adopted = mock.sent('zwlr_layer_surface_v1', 'get_popup').pop();
    assert.deepEqual(adopted.args, [popup.popup.id]);
    const names = mock.requests.map((r) => `${r.iface}.${r.name}`);
    assert.ok(
      names.lastIndexOf('zwlr_layer_surface_v1.get_popup') <
        names.lastIndexOf('wl_surface.commit'),
      "before the popup's first commit",
    );
    popup.destroy();
    dock.destroy();
  },
);

test(
  'the compositor closing a layer surface is a close',
  { skip: SKIP },
  async () => {
    const win = WaylandWindow.createLayerSync({
      conn,
      compositor,
      layerShell,
      width: 100,
      height: 100,
      layer: LAYER.OVERLAY,
    });
    await win.whenConfigured;
    const closed = new Promise((r) => win.once('close', r));
    mock.closeLayer(win.surface.id);
    await closed;
    win.destroy();
    await until(
      () => mock.sent('zwlr_layer_surface_v1', 'destroy').length >= 1,
      {
        what: 'the destroy',
      },
    );
  },
);
