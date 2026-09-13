// The layout scale on Wayland: the compositor's, unless pinned —
// `REACT_X11_SCALE`, then `createRoot({ scale })`, absolute as on X11 — or
// unless the compositor says 1 over a retina-class grid it has no real
// millimetres for. That last one is a VM window over a retina panel: QEMU
// describes the guest's screen as a ~100dpi monitor, mutter believes it and
// runs at 100%, and an app laid out at the compositor's word came up half
// the size it is on the host. Real protocol against the in-process
// compositor, run through the same `_beginOutputs` as `WaylandApp.open()`;
// no display, no GPU.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { WaylandApp } from '../../src/wayland/app.js';
import { scaleOf, scaleSourceOf } from '../../src/scale.js';
import { MockCompositor, waylandClientAvailable } from './mock-compositor.js';

const SKIP = waylandClientAvailable
  ? false
  : 'wayland-client (the fork) is not installed';

/** what mutter reports for a UTM guest's screen: QEMU's EDID, at 100% */
const QEMU_SCREEN = {
  name: 'Virtual-1',
  make: 'RHT',
  model: 'QEMU Monitor',
  width: 2488,
  height: 1668,
  mm: [630, 420],
  scale: 1,
};
/** an ordinary 1x laptop panel with millimetres that add up */
const LAPTOP = {
  name: 'eDP-1',
  make: 'BOE',
  model: '0x0bca',
  width: 1920,
  height: 1080,
  mm: [344, 194],
  scale: 1,
};

async function appOver(outputs, options = {}) {
  const mock = new MockCompositor({ width: 640, height: 480, outputs });
  const p = await mock.listen();
  const sock = net.createConnection(p);
  await new Promise((r) => sock.once('connect', r));
  const conn = await WaylandConnection.open({ socket: sock });
  const app = new WaylandApp(conn, options);
  app.compositor = await conn.require('wl_compositor');
  app.wmBase = await conn.require('xdg_wm_base');
  await app._beginOutputs(conn, options);
  return {
    app,
    close() {
      app.outputs?.destroy?.();
      conn.destroy();
      mock.close();
    },
  };
}

/** `REACT_X11_SCALE` set (or unset) for the length of `fn` */
async function withEnvScale(value, fn) {
  const was = process.env.REACT_X11_SCALE;
  if (value == null) delete process.env.REACT_X11_SCALE;
  else process.env.REACT_X11_SCALE = String(value);
  try {
    return await fn();
  } finally {
    if (was === undefined) delete process.env.REACT_X11_SCALE;
    else process.env.REACT_X11_SCALE = was;
  }
}

test(
  'a VM screen the compositor runs at 100% lays out at 2x, drawn at full resolution',
  { skip: SKIP },
  () =>
    withEnvScale(null, async () => {
      const t = await appOver([QEMU_SCREEN]);
      try {
        assert.equal(t.app.scale, 1, 'the compositor still says 1');
        assert.equal(scaleOf(t.app), 2, 'the renderer lays out at 2');
        assert.equal(scaleSourceOf(t.app), 'resolution');
      } finally {
        t.close();
      }
    }),
);

test("a real panel at 100% keeps the compositor's word", { skip: SKIP }, () =>
  withEnvScale(null, async () => {
    const t = await appOver([LAPTOP]);
    try {
      assert.equal(scaleOf(t.app), 1);
      assert.equal(scaleSourceOf(t.app), 'wayland');
    } finally {
      t.close();
    }
  }),
);

test(
  'REACT_X11_SCALE outranks everything, the zoom included',
  { skip: SKIP },
  () =>
    withEnvScale(1, async () => {
      const t = await appOver([QEMU_SCREEN], { scale: 3 });
      try {
        assert.equal(scaleOf(t.app), 1);
        assert.equal(scaleSourceOf(t.app), 'REACT_X11_SCALE');
      } finally {
        t.close();
      }
    }),
);

test(
  "createRoot({ scale }) pins the layout over the compositor's scale",
  { skip: SKIP },
  () =>
    withEnvScale(null, async () => {
      const t = await appOver([LAPTOP], { scale: 1.5 });
      try {
        assert.equal(t.app.scale, 1, "the buffers stay at the compositor's");
        assert.equal(scaleOf(t.app), 1.5);
        assert.equal(scaleSourceOf(t.app), 'option');
      } finally {
        t.close();
      }
    }),
);

test(
  'a compositor that scales has decided: the same VM screen at 200% is 2x, not 4x',
  { skip: SKIP },
  () =>
    withEnvScale(null, async () => {
      const t = await appOver([{ ...QEMU_SCREEN, scale: 2 }]);
      try {
        assert.equal(t.app.scale, 2);
        assert.equal(scaleOf(t.app), 2);
        assert.equal(scaleSourceOf(t.app), 'wayland');
      } finally {
        t.close();
      }
    }),
);
