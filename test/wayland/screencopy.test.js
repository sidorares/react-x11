// Screen capture end to end, in-process: the mock compositor over a
// socketpair (so the wl_shm pool's descriptor really crosses), a scripted
// frame copied into it, read back as RGBA — and the eyedropper on top: the
// frozen frame goes up as a layer-shell overlay, a click on it names the
// pixel, an abort takes it down. Skips where the native socket is not there,
// as fdpair.test.js does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

import { WaylandConnection } from '../../src/wayland/connection.js';
import { WaylandSeat, BTN } from '../../src/wayland/seat.js';
import {
  createScreenCapture,
  ScreenCapture,
} from '../../src/wayland/screencopy.js';
import {
  SHM_FORMAT,
  flipRows,
  openSharedMemory,
  shmPixel,
  shmToRGBA,
} from '../../src/wayland/shm.js';
import {
  MockCompositor,
  until,
  waylandClientAvailable,
} from './mock-compositor.js';

const require = createRequire(import.meta.url);

function nativeSocketAvailable() {
  if (typeof Bun !== 'undefined') return false;
  try {
    return typeof require('x11-dri').UnixSocket === 'function';
  } catch {
    return false;
  }
}

const SKIP = !waylandClientAvailable
  ? 'wayland-client (the fork) is not installed'
  : !nativeSocketAvailable() &&
    'x11-dri UnixSocket not available on this runtime';

// ---- the pure parts ---------------------------------------------------------

test('shmToRGBA: XRGB8888 is B,G,R,X in memory; XBGR8888 is R,G,B,X; y_invert flips', () => {
  const bgrx = Buffer.from([
    // row 0: one pixel, blue 1 green 2 red 3
    1, 2, 3, 0,
    // row 1: blue 10 green 20 red 30
    10, 20, 30, 0,
  ]);
  const out = shmToRGBA({
    bytes: bgrx,
    width: 1,
    height: 2,
    stride: 4,
    format: SHM_FORMAT.XRGB8888,
  });
  assert.deepEqual([...out.data], [3, 2, 1, 255, 30, 20, 10, 255]);
  const inv = shmToRGBA({
    bytes: bgrx,
    width: 1,
    height: 2,
    stride: 4,
    format: SHM_FORMAT.XRGB8888,
    yInvert: true,
  });
  assert.deepEqual([...inv.data], [30, 20, 10, 255, 3, 2, 1, 255]);
  const rgbx = shmToRGBA({
    bytes: Buffer.from([3, 2, 1, 9]),
    width: 1,
    height: 1,
    stride: 4,
    format: SHM_FORMAT.ABGR8888,
  });
  assert.deepEqual([...rgbx.data], [3, 2, 1, 9], 'straight copy, alpha kept');
  assert.throws(
    () =>
      shmToRGBA({
        bytes: Buffer.alloc(4),
        width: 1,
        height: 1,
        stride: 4,
        format: 0x36314752, // RG16
      }),
    /unsupported wl_shm format/,
  );
  assert.deepEqual(
    shmPixel(bgrx, { stride: 4, format: SHM_FORMAT.XRGB8888 }, 0, 1),
    {
      r: 30,
      g: 20,
      b: 10,
    },
  );
  // a stride wider than the row: the padding is skipped
  const padded = Buffer.from([
    1, 2, 3, 0, 99, 99, 99, 99, 4, 5, 6, 0, 99, 99, 99, 99,
  ]);
  const p = shmToRGBA({
    bytes: padded,
    width: 1,
    height: 2,
    stride: 8,
    format: SHM_FORMAT.XRGB8888,
  });
  assert.deepEqual([...p.data], [3, 2, 1, 255, 6, 5, 4, 255]);
  assert.deepEqual(
    [...flipRows(Buffer.from([1, 2, 3, 4, 5, 6]), 2, 3)],
    [5, 6, 3, 4, 1, 2],
  );
});

test('openSharedMemory: two descriptors on the same pages', () => {
  const mem = openSharedMemory(4096, 'react-x11-test');
  try {
    assert.notEqual(mem.fd, mem.wire);
    fs.writeSync(mem.wire, Buffer.from('hello'), 0, 5, 0);
    const back = Buffer.alloc(5);
    fs.readSync(mem.fd, back, 0, 5, 0);
    assert.equal(back.toString(), 'hello');
  } finally {
    fs.closeSync(mem.fd);
    fs.closeSync(mem.wire);
  }
});

// ---- against the compositor -------------------------------------------------

let mock;
let conn;
let app;
let capture;

before(async () => {
  if (SKIP) return;
  mock = new MockCompositor({ width: 64, height: 32 });
  const client = mock.pair();
  assert.ok(client, 'a socketpair transport');
  conn = await WaylandConnection.open({
    socket: client,
    // 'wayland' first: the vendored core has wl_output at v4 (the `name`
    // event); the library's own copy stops at v3
    protocols: [
      'wayland',
      'xdg-shell',
      'cursor-shape-v1',
      'viewporter',
      'wlr-layer-shell-unstable-v1',
      'wlr-screencopy-unstable-v1',
    ],
  });
  app = {
    conn,
    compositor: await conn.require('wl_compositor'),
    viewporter: await conn.bind('wp_viewporter'),
    layerShell: await conn.bind('zwlr_layer_shell_v1'),
    seat: null,
  };
  capture = await createScreenCapture(app);
});

after(() => {
  capture?.destroy();
  conn?.destroy();
  mock?.close();
});

test(
  'the capture binds what the mock has: wlr-screencopy, shm, an output',
  { skip: SKIP },
  async () => {
    assert.ok(capture instanceof ScreenCapture);
    assert.equal(capture.route, 'wlr');
    assert.equal(
      capture.canPick,
      false,
      'no seat yet, so nothing to click with',
    );
    await until(() => capture.outputInfo.width === 64, {
      what: "the output's mode",
    });
    assert.equal(capture.outputInfo.name, 'MOCK-1');
    assert.equal(capture.outputInfo.scale, 1);
  },
);

test(
  'capture(): the scripted frame comes back as RGBA through a real shm pool',
  { skip: SKIP },
  async () => {
    const img = await capture.capture();
    assert.equal(img.width, 64);
    assert.equal(img.height, 32);
    assert.equal(img.data.length, 64 * 32 * 4);
    const at = (x, y) => [
      ...img.data.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4),
    ];
    assert.deepEqual(at(10, 20), [10, 20, 0x55, 255]);
    assert.deepEqual(at(63, 31), [63, 31, 0x55, 255]);
    const pool = mock.sent('wl_shm', 'create_pool').pop();
    assert.ok(pool.args[1] >= 0, 'the pool descriptor crossed the socket');
    assert.equal(pool.args[2], 64 * 4 * 32);
    assert.deepEqual(mock.sent('zwlr_screencopy_frame_v1', 'copy').length, 1);
    await conn.roundtrip();
    assert.ok(
      mock.sent('wl_buffer', 'destroy').length >= 1 &&
        mock.sent('wl_shm_pool', 'destroy').length >= 1 &&
        mock.sent('zwlr_screencopy_frame_v1', 'destroy').length >= 1,
      'buffer, pool and frame are released after the copy',
    );
  },
);

test('pixelAt(): one pixel, y_invert undone', { skip: SKIP }, async () => {
  assert.deepEqual(await capture.pixelAt(10, 20), { r: 10, g: 20, b: 0x55 });
  mock.opts.yInvert = true;
  try {
    assert.deepEqual(await capture.pixelAt(10, 20), { r: 10, g: 20, b: 0x55 });
    const img = await capture.capture();
    assert.deepEqual(
      [...img.data.subarray((20 * 64 + 10) * 4, (20 * 64 + 10) * 4 + 3)],
      [10, 20, 0x55],
    );
  } finally {
    mock.opts.yInvert = false;
  }
});

test(
  'a refused capture is a rejection, with everything released',
  { skip: SKIP },
  async () => {
    mock.opts.captureFails = true;
    try {
      await assert.rejects(capture.capture(), /refused the screen capture/);
    } finally {
      mock.opts.captureFails = false;
    }
  },
);

test(
  'pickColor(): the frozen frame goes up as an overlay, a click names the pixel, and the overlay comes down',
  { skip: SKIP },
  async () => {
    const seenPointer = mock.pointer;
    const seat = await WaylandSeat.bind(conn);
    await until(() => mock.pointer && mock.pointer !== seenPointer, {
      what: 'a pointer',
    });
    app.seat = seat;
    capture.seat = seat;
    assert.equal(capture.canPick, true);

    const pending = capture.pickColor();
    // the overlay: a layer surface on the overlay layer, anchored all round,
    // exclusive keyboard, showing the captured buffer
    const overlay = await until(
      () =>
        mock
          .layerSurfaces()
          .find((s) => s.role.namespace === 'react-x11-eyedropper'),
      { what: 'the overlay surface' },
    );
    assert.equal(overlay.role.layer, 3, 'overlay');
    assert.deepEqual(overlay.role.props.set_anchor, [15]);
    assert.deepEqual(overlay.role.props.set_exclusive_zone, [-1]);
    assert.deepEqual(overlay.role.props.set_keyboard_interactivity, [1]);
    await until(() => overlay.attached, {
      what: 'the frozen frame to be attached',
    });
    assert.ok(
      overlay.role.acked > 0,
      'the configure was acked before the buffer',
    );
    assert.deepEqual(
      mock.sent('wp_cursor_shape_device_v1', 'set_shape').length,
      0,
      'no cursor until the pointer enters',
    );

    mock.pointerEnter(overlay.id, 10.5, 20.25);
    await until(
      () => mock.sent('wp_cursor_shape_device_v1', 'set_shape').length >= 1,
      {
        what: 'the crosshair',
      },
    );
    assert.deepEqual(
      mock.sent('wp_cursor_shape_device_v1', 'set_shape').pop().args[1],
      8,
      'crosshair',
    );
    mock.pointerButton(BTN.RIGHT, true);
    mock.pointerButton(BTN.RIGHT, false);
    mock.pointerMotion(33, 7);
    mock.pointerButton(BTN.LEFT, true);
    const color = await pending;
    assert.deepEqual(
      color,
      { r: 33 / 255, g: 7 / 255, b: 0x55 / 255 },
      'the pixel under the click, not the right-click',
    );
    await conn.roundtrip();
    assert.ok(
      mock.sent('zwlr_layer_surface_v1', 'destroy').length >= 1,
      'the overlay is gone',
    );
    assert.equal(capture._pick, null);
  },
);

test(
  'pickColor(): an abort takes the overlay down and rejects with the reason',
  { skip: SKIP },
  async () => {
    const before = mock.sent('zwlr_layer_surface_v1', 'destroy').length;
    const ac = new AbortController();
    const pending = capture.pickColor({ signal: ac.signal });
    const second = capture.pickColor();
    assert.equal(second, pending, 'one pick at a time; a second joins it');
    await until(
      () =>
        mock.layerSurfaces().length >= 1 && mock.layerSurfaces().pop().attached,
      {
        what: 'the overlay',
      },
    );
    ac.abort(new Error('changed my mind'));
    await assert.rejects(pending, /changed my mind/);
    await conn.roundtrip();
    assert.equal(
      mock.sent('zwlr_layer_surface_v1', 'destroy').length,
      before + 1,
    );
  },
);
