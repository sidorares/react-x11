// The outputs as screens: `wl_output` (+ xdg_output) into `src/screens.js` —
// names, logical rects at the app's scale, refresh and physical size, a
// primary, hot-plug, `configure_bounds` as the work area, and a surface's
// own output. Real protocol against the in-process compositor; no display,
// no GPU.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { WaylandApp } from '../../src/wayland/app.js';
import {
  WaylandOutputs,
  monitorOf,
  layoutOf,
  refreshHz,
  degreesOf,
  effectiveScaleOf,
} from '../../src/wayland/outputs.js';
import { WaylandWindow } from '../../src/wayland/window.js';
import {
  screensSnapshot,
  availableArea,
  watchScreens,
} from '../../src/screens.js';
import { scaleOf, monitorScalesOf, setScaleForTests } from '../../src/scale.js';
import {
  MockCompositor,
  until,
  waylandClientAvailable,
} from './mock-compositor.js';

const SKIP = waylandClientAvailable
  ? false
  : 'wayland-client (the fork) is not installed';

/**
 * A mock with these outputs, a connection to it, and an app around the
 * connection the way `WaylandApp.open()` builds one — minus the GPU and
 * the seat, which the outputs do not need.
 */
async function open(opts) {
  const mock = new MockCompositor({ width: 640, height: 480, ...opts });
  const p = await mock.listen();
  const sock = net.createConnection(p);
  await new Promise((r) => sock.once('connect', r));
  const conn = await WaylandConnection.open({ socket: sock });
  const app = new WaylandApp(conn, {});
  app.compositor = await conn.require('wl_compositor');
  app.wmBase = await conn.require('xdg_wm_base');
  setScaleForTests(app, app.scale, 'wayland');
  app.outputs = new WaylandOutputs(conn, app);
  await app.outputs.open();
  const rect = (r) => [r.x, r.y, r.width, r.height];
  return {
    mock,
    conn,
    app,
    rect,
    toplevel(extra = {}) {
      const win = WaylandWindow.createSync({
        conn,
        compositor: app.compositor,
        wmBase: app.wmBase,
        title: 'O',
        width: 100,
        height: 100,
        ...extra,
      });
      app.outputs.watchWindow(win);
      return win;
    },
    close() {
      app.outputs.destroy();
      conn.destroy();
      mock.close();
    },
  };
}

test(
  'two outputs are two monitors: names, logical rects at the seeded scale, physical size, refresh, rotation, a primary',
  { skip: SKIP },
  async () => {
    const t = await open({
      outputs: [
        {
          name: 'eDP-1',
          description: 'Built-in display',
          width: 2560,
          height: 1440,
          refresh: 59997,
          scale: 2,
          mm: [344, 194],
          make: 'AUO',
          model: 'B140QAN',
        },
        {
          // to the right of the lid, in logical pixels; a 4K panel turned
          // portrait at 1x, so its logical rect is the mode swapped
          name: 'DP-1',
          description: 'Dell U2720Q',
          x: 1280,
          y: 0,
          width: 3840,
          height: 2160,
          refresh: 60000,
          scale: 1,
          transform: 1,
          mm: [597, 336],
        },
      ],
    });
    try {
      assert.equal(
        (await t.conn.registry()).of('wl_output').length,
        2,
        'the registry view keeps every wl_output, not one per interface',
      );
      assert.equal(
        t.app.scale,
        2,
        'the densest output seeds the app scale before any window exists',
      );
      assert.equal(scaleOf(t.app), 2);

      const snap = screensSnapshot(t.app);
      assert.equal(snap.screens.length, 2);
      const [lid, ext] = snap.screens;
      assert.equal(lid.name, 'eDP-1');
      assert.deepEqual(lid.outputs, ['eDP-1']);
      // logical 1280x720 at the app's 2x: device pixels, as cocoa publishes
      assert.deepEqual(t.rect(lid), [0, 0, 2560, 1440]);
      assert.equal(lid.primary, true, 'the output at the origin');
      assert.equal(snap.primary, lid);
      assert.equal(lid.widthMM, 344);
      assert.equal(lid.heightMM, 194);
      assert.equal(lid.refreshRate, 60, '59997 mHz reads as 60Hz');
      assert.equal(lid.rotation, 0);

      assert.equal(ext.name, 'DP-1');
      assert.deepEqual(
        t.rect(ext),
        [2560, 0, 4320, 7680],
        'xdg_output logical 2160x3840 at x=1280, times the app scale',
      );
      assert.equal(ext.rotation, 90);
      assert.equal(ext.refreshRate, 60);
      assert.equal(ext.primary, false);

      assert.deepEqual(
        t.rect(snap.virtual),
        [0, 0, 6880, 7680],
        'the virtual screen is the union — the X stand-in has no screen size',
      );
      assert.deepEqual(
        t.rect(snap.workArea),
        [0, 0, 2560, 1440],
        "no window has been given bounds yet: the primary's full rect",
      );
      // The seam is `setScreensForTests`, which stamps this — the cocoa
      // backend's `source` reads the same. A `source` the backends could
      // name is a one-line change to screens.js, not made from here.
      assert.equal(snap.source, 'test');

      const scales = monitorScalesOf(t.app);
      assert.equal(scales.get('eDP-1').scale, 2, 'mode over logical: 2');
      assert.equal(scales.get('DP-1').scale, 1);
      assert.equal(scales.get('eDP-1').primary, true);

      const list = t.app.outputs.list();
      assert.equal(list[1].description, 'Dell U2720Q');
      assert.equal(list[0].make, 'AUO');
      assert.equal(list[0].model, 'B140QAN');
      assert.equal(
        'id' in list[0],
        false,
        'the proxy id stays inside the tracker',
      );

      const binds = t.mock.sent('wl_registry', 'bind');
      assert.equal(
        binds.filter((b) => b.args[1] === 'wl_output').length,
        2,
        'each output is bound once',
      );
      assert.equal(
        t.mock.sent('zxdg_output_manager_v1', 'get_xdg_output').length,
        2,
      );
    } finally {
      t.close();
    }
  },
);

test(
  'without xdg_output the rect is the mode over the integer scale, turned by the transform; an old wl_output has no name',
  { skip: SKIP },
  async () => {
    const t = await open({
      xdgOutput: false,
      outputVersion: 3,
      outputs: [
        {
          name: 'HDMI-A-1',
          width: 1920,
          height: 1080,
          scale: 1,
          transform: 3,
          refresh: 0,
        },
        { name: 'DP-2', x: 1080, y: 0, width: 3840, height: 2160, scale: 2 },
      ],
    });
    try {
      assert.equal(t.app.scale, 2);
      const { screens, primary } = screensSnapshot(t.app);
      assert.equal(screens.length, 2);
      const [turned, dense] = screens;
      assert.equal(turned.name, null, 'wl_output 3 has no name event');
      assert.deepEqual(turned.outputs, []);
      assert.deepEqual(
        t.rect(turned),
        [0, 0, 2160, 3840],
        '1920x1080 turned 270 degrees is 1080x1920 logical, at 2x',
      );
      assert.equal(turned.rotation, 270);
      assert.equal(turned.refreshRate, null, 'a 0 mHz mode is "unknown"');
      assert.deepEqual(
        t.rect(dense),
        [2160, 0, 3840, 2160],
        '3840x2160 at scale 2 is 1920x1080 logical, at 2x',
      );
      assert.equal(primary, turned);
      assert.equal(
        t.mock
          .sent('wl_registry', 'bind')
          .find((b) => b.args[1] === 'wl_output').args[2],
        3,
        'bound at the version the compositor has',
      );
      assert.equal(t.mock.sent('zxdg_output_manager_v1').length, 0);
    } finally {
      t.close();
    }
  },
);

test(
  'hot-plug: a new global adds a monitor, a mode change republishes, global_remove takes it away and releases it',
  { skip: SKIP },
  async () => {
    const t = await open({
      outputs: [{ name: 'eDP-1', width: 1920, height: 1080 }],
    });
    try {
      let changes = 0;
      const stop = watchScreens(t.app, () => changes++);
      assert.equal(screensSnapshot(t.app).screens.length, 1);

      t.mock.addOutput({
        name: 'HDMI-A-1',
        x: 1920,
        y: 0,
        width: 1920,
        height: 1200,
      });
      await until(() => screensSnapshot(t.app).screens.length === 2, {
        what: 'the second monitor',
      });
      let snap = screensSnapshot(t.app);
      assert.deepEqual(
        snap.screens.map((s) => s.name),
        ['eDP-1', 'HDMI-A-1'],
      );
      assert.deepEqual(t.rect(snap.screens[1]), [1920, 0, 1920, 1200]);
      assert.equal(snap.primary.name, 'eDP-1', 'still the one at the origin');
      assert.equal(
        changes,
        1,
        'one publish for the arrival, not one per event',
      );

      t.mock.updateOutput('HDMI-A-1', { width: 2560, height: 1440 });
      await until(() => screensSnapshot(t.app).screens[1]?.width === 2560, {
        what: 'the new mode',
      });
      assert.equal(changes, 2);
      assert.deepEqual(
        t.rect(screensSnapshot(t.app).virtual),
        [0, 0, 4480, 1440],
      );

      t.mock.removeOutput('HDMI-A-1');
      await until(() => screensSnapshot(t.app).screens.length === 1, {
        what: 'the monitor to go',
      });
      assert.equal(changes, 3);
      await t.conn.roundtrip();
      assert.equal(
        t.mock.sent('wl_output', 'release').length,
        1,
        'the proxy of a departed global is released (wl_output >= 3)',
      );
      assert.equal(t.mock.sent('zxdg_output_v1', 'destroy').length, 1);
      snap = screensSnapshot(t.app);
      assert.equal(snap.primary.name, 'eDP-1');
      stop();
    } finally {
      t.close();
    }
  },
);

test(
  'configure_bounds is the usable area: a per-axis bound before the window has an output, an exact rect on its output after',
  { skip: SKIP },
  async () => {
    const t = await open({
      bounds: { width: 1920, height: 1040 },
      outputs: [
        { name: 'eDP-1', width: 1920, height: 1080 },
        { name: 'DP-1', x: 1920, y: 0, width: 2560, height: 1440 },
      ],
    });
    try {
      const win = t.toplevel();
      await win.whenConfigured;
      assert.deepEqual(win.bounds, { width: 1920, height: 1040 });
      await until(() => screensSnapshot(t.app).workArea?.height === 1040, {
        what: 'the bounds to become the work area',
      });
      let { screens, workArea } = screensSnapshot(t.app);
      assert.deepEqual(t.rect(workArea), [0, 0, 1920, 1040]);
      assert.deepEqual(
        t.rect(screens[0].available),
        [0, 0, 1920, 1040],
        'exact on the primary',
      );
      assert.deepEqual(
        t.rect(screens[1].available),
        [1920, 0, 2560, 1440],
        'the bounds fit the primary, so they are its: the other head stays whole rather than clamped per axis (#453)',
      );
      assert.equal(t.app.outputs.monitorFor(win.outputs), null);

      // The compositor shows the window on the second head and tells it the
      // bounds there: that head gets an exact usable rect, and the first is
      // whole again.
      t.mock.enterOutput(win.surface.id, 'DP-1');
      t.mock.configure(win.surface.id, {
        bounds: { width: 2560, height: 1400 },
      });
      await until(
        () => screensSnapshot(t.app).screens[1]?.available.height === 1400,
        { what: "the second head's usable rect" },
      );
      ({ screens, workArea } = screensSnapshot(t.app));
      assert.deepEqual(t.rect(screens[1].available), [1920, 0, 2560, 1400]);
      assert.deepEqual(t.rect(screens[0].available), [0, 0, 1920, 1080]);
      assert.deepEqual(
        t.rect(workArea),
        [0, 0, 1920, 1080],
        "the desktop-wide one is the primary's usable rect, which nothing constrains now",
      );
      assert.equal(t.app.outputs.monitorFor(win.outputs).name, 'DP-1');
      assert.deepEqual(
        t.rect(availableArea(t.app)),
        [1920, 0, 2560, 1400],
        'an auto-sized window with no anchor clamps to the largest monitor, and that is its usable rect',
      );

      // A repeat of the same bounds must not wake every useScreens()
      let changes = 0;
      const stop = watchScreens(t.app, () => changes++);
      t.mock.configure(win.surface.id, {
        bounds: { width: 2560, height: 1400 },
      });
      await t.conn.roundtrip();
      await new Promise((r) => setImmediate(r));
      assert.equal(changes, 0);
      stop();

      // and the window going takes its bounds with it
      win.destroy();
      await until(
        () => screensSnapshot(t.app).screens[1]?.available.height === 1440,
        {
          what: 'the bounds to be forgotten',
        },
      );
    } finally {
      t.close();
    }
  },
);

test(
  'a surface takes its buffer scale from the output it enters when neither fractional-scale nor preferred_buffer_scale has spoken',
  { skip: SKIP },
  async () => {
    const t = await open({
      outputs: [
        { name: 'eDP-1', width: 1920, height: 1080, scale: 1 },
        {
          name: 'HDMI-A-1',
          x: 1920,
          y: 0,
          width: 3840,
          height: 2160,
          scale: 2,
        },
      ],
    });
    try {
      // the app seeds 2 (its densest output); this window starts at 1 as a
      // compositor without either protocol would leave it
      const win = t.toplevel();
      win.scale = 1;
      win.useScaling({ fractionalScaleManager: null, viewporter: null });
      await win.whenConfigured;
      win.ackPending();

      t.mock.enterOutput(win.surface.id, 'HDMI-A-1');
      await until(() => win.scale === 2, { what: 'the output scale' });
      await t.conn.roundtrip();
      assert.deepEqual(
        t.mock.sent('wl_surface', 'set_buffer_scale').at(-1).args,
        [2],
      );
      assert.equal(t.app.outputs.monitorFor(win.outputs).name, 'HDMI-A-1');

      // straddling both heads: the densest wins, as every toolkit picks it
      t.mock.enterOutput(win.surface.id, 'eDP-1');
      await until(() => win.outputs.size === 2, { what: 'both outputs' });
      assert.equal(win.scale, 2);
      assert.equal(t.app.outputs.monitorFor(win.outputs).name, 'HDMI-A-1');
      t.mock.leaveOutput(win.surface.id, 'HDMI-A-1');
      await until(() => win.scale === 1, { what: 'the lid scale' });
      assert.equal(t.app.outputs.monitorFor(win.outputs).name, 'eDP-1');

      // fractional-scale in play: the output's integer is not the word
      const fractional = await t.conn.bind('wp_fractional_scale_manager_v1');
      const frac = t.toplevel();
      frac.scale = 1;
      frac.useScaling({ fractionalScaleManager: fractional, viewporter: null });
      await frac.whenConfigured;
      t.mock.enterOutput(frac.surface.id, 'HDMI-A-1');
      await until(() => frac.outputs.size === 1, { what: 'enter' });
      await t.conn.roundtrip();
      assert.equal(frac.scale, 1, 'fractional-scale-v1 owns the scale');

      // and so is preferred_buffer_scale (wl_surface 6)
      const pref = t.toplevel();
      pref.scale = 1;
      pref.useScaling({ fractionalScaleManager: null, viewporter: null });
      await pref.whenConfigured;
      t.mock.send(pref.surface.id, 'preferred_buffer_scale', 1);
      t.mock.enterOutput(pref.surface.id, 'HDMI-A-1');
      await until(() => pref.outputs.size === 1, { what: 'enter' });
      await t.conn.roundtrip();
      assert.equal(
        pref.scale,
        1,
        'the compositor named a scale for this surface',
      );

      win.destroy();
      frac.destroy();
      pref.destroy();
    } finally {
      t.close();
    }
  },
);

test('the layout arithmetic, without a compositor', () => {
  assert.equal(refreshHz(59997), 60);
  assert.equal(refreshHz(74999), 75);
  assert.equal(refreshHz(143981), 143.98);
  assert.equal(refreshHz(0), null, 'a virtual output says 0');
  assert.equal(refreshHz(1000), null, '1Hz is a compositor not knowing');
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7].map(degreesOf),
    [0, 90, 180, 270, 0, 90, 180, 270],
    'the flipped four are reflections, not turns',
  );

  const base = {
    x: 0,
    y: 0,
    physicalWidth: 597,
    physicalHeight: 336,
    make: 'DEL',
    model: 'U2720Q',
    transform: 0,
    mode: { width: 3840, height: 2160, refresh: 60000, current: true },
    scale: 2,
    name: 'DP-1',
    description: 'Dell U2720Q',
    xdgName: null,
    xdgDescription: null,
    logicalPosition: null,
    logicalSize: null,
  };
  // no xdg_output: the mode over the integer scale
  assert.deepEqual(monitorOf(base, 1), {
    name: 'DP-1',
    outputs: ['DP-1'],
    description: 'Dell U2720Q',
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    primary: false,
    widthMM: 597,
    heightMM: 336,
    refreshRate: 60,
    rotation: 0,
    scale: 2,
    make: 'DEL',
    model: 'U2720Q',
  });
  // xdg_output: its logical rect wins, and the ratio is the real scale —
  // 150% reports wl_output.scale 2, and 3840/2560 says 1.5
  const fractional = {
    ...base,
    logicalPosition: { x: 1280, y: 0 },
    logicalSize: { width: 2560, height: 1440 },
  };
  assert.equal(effectiveScaleOf(fractional), 1.5);
  const m = monitorOf(fractional, 1.5);
  assert.deepEqual([m.x, m.y, m.width, m.height], [1920, 0, 3840, 2160]);
  assert.equal(m.scale, 1.5);
  // xdg_output's names stand in for a wl_output too old to have them
  const old = { ...base, name: null, xdgName: 'DP-1', description: null };
  assert.equal(monitorOf(old).name, 'DP-1');
  assert.equal(monitorOf(old).description, null);
  assert.equal(monitorOf({ ...base, mode: null }), null, 'nothing yet');
  assert.equal(
    monitorOf({ ...base, transform: 5 }).width,
    1080,
    'flipped_90 still swaps the axes',
  );

  // sorting, the primary, and the bounds
  const mon = (id, x, y, w, h) => ({
    id,
    x,
    y,
    width: w,
    height: h,
    primary: false,
  });
  let layout = layoutOf([
    mon(2, 1920, 0, 2560, 1440),
    mon(1, 0, 0, 1920, 1080),
  ]);
  assert.deepEqual(
    layout.monitors.map((x) => x.id),
    [1, 2],
    'left to right, whatever order the registry announced',
  );
  assert.equal(layout.monitors[0].primary, true, 'the origin');
  assert.equal(layout.monitors[1].primary, false);
  assert.deepEqual(layout.workArea, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(
    layout.monitors[1].visible,
    { x: 1920, y: 0, width: 2560, height: 1440 },
    'every monitor carries its own rect as visible, so none is clamped by another',
  );

  layout = layoutOf([mon(2, 2560, 0, 1920, 1080), mon(1, 0, 200, 2560, 1440)]);
  assert.equal(layout.monitors[0].id, 1, 'none at the origin: the leftmost');
  assert.equal(layout.monitors[0].primary, true);

  layout = layoutOf([mon(1, 0, 0, 1920, 1080), mon(2, 1920, 0, 2560, 1440)], {
    scale: 2,
    bounds: [
      { outputs: new Set(), bounds: { width: 960, height: 520 } },
      { outputs: new Set([2]), bounds: { width: 1280, height: 700 } },
    ],
  });
  assert.deepEqual(
    layout.monitors[0].visible,
    { x: 0, y: 0, width: 1920, height: 1040 },
    'a window with no output yet: its bounds (1920x1040 device) go to the smallest monitor they fit',
  );
  assert.deepEqual(
    layout.monitors[1].visible,
    { x: 1920, y: 0, width: 2560, height: 1400 },
    'the bounds of the window on it, at its origin, in device pixels',
  );
  assert.deepEqual(
    layout.workArea,
    { x: 0, y: 0, width: 1920, height: 1040 },
    "the desktop's work area is the primary's usable rect",
  );

  // identical monitors: the unplaced bounds fit both, and the primary wins
  layout = layoutOf([mon(2, 1920, 0, 1920, 1080), mon(1, 0, 0, 1920, 1080)], {
    bounds: [{ outputs: new Set(), bounds: { width: 1920, height: 1040 } }],
  });
  assert.equal(layout.monitors[0].visible.height, 1040);
  assert.equal(layout.monitors[1].visible.height, 1080);
  // bounds larger than every monitor belong to none
  layout = layoutOf([mon(1, 0, 0, 1920, 1080)], {
    bounds: [{ outputs: new Set(), bounds: { width: 2560, height: 1400 } }],
  });
  assert.equal(layout.monitors[0].visible.height, 1080);
});
