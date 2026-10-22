// `<video frames>` on a real X server with an XVideo adaptor: the frame goes
// through the port (src/xvideo.js) rather than through `frameToRGBA`, lands in
// the paint order like any drawn picture, and is the same picture the
// JavaScript conversion makes of it.
//
// Only a server with an image adaptor can say any of this — Xorg or Xwayland
// with glamor. The in-process server and Xvfb have none, and there every
// frame goes the JavaScript way, which test/video.test.js covers. Skipped
// where there is no DISPLAY, no adaptor, or an ntk without ntk/xv.
import assert from 'node:assert';
import { after, afterEach, before, test } from 'node:test';
import React from 'react';

import { createVideoFrames } from '../src/index.js';
import {
  act,
  cleanup,
  isNear,
  pixelAt,
  renderX11,
  screen,
} from '../src/testing/index.js';
import { frameToRGBA } from '../src/videoframes.js';
import { xvVideoFor } from '../src/xvideo.js';

const h = React.createElement;

let app = null;
let skip = false;

before(async () => {
  if (!process.env.DISPLAY) {
    skip = 'no DISPLAY set';
    return;
  }
  let xv;
  try {
    xv = await import('ntk/xv');
  } catch {
    skip = 'this ntk has no ntk/xv';
    return;
  }
  const { createClient } = await import('ntk');
  try {
    app = await createClient();
  } catch (err) {
    skip = `cannot connect to X server: ${err.message}`;
    return;
  }
  const probe = await xv.openVideoPort(app);
  if (!probe?.targets)
    skip = 'no Xv image adaptor with Composite on this server';
  probe?.close();
});

afterEach(async () => {
  await cleanup();
});

after(async () => {
  await app?.close();
});

/** Until `predicate` holds, or fail naming what it waited for. */
async function until(predicate, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const BG = '#203040';

const videoNode = () => screen.all((n) => n.kind === 'video')[0];

/** A window with one video filling `style`, and `over` drawn on top of it. */
function pane(sink, { style = { width: 160, height: 90 }, over = null } = {}) {
  return h(
    'window',
    { width: 200, height: 120, style: { backgroundColor: '#ffffff' } },
    h('video', { frames: sink, style: { backgroundColor: BG, ...style } }),
    over,
  );
}

const solidNV12 = (w, hgt, [Y, Cb, Cr]) => {
  const uv = Buffer.alloc(Math.ceil(w / 2) * 2 * Math.ceil(hgt / 2));
  for (let i = 0; i < uv.length; i += 2) {
    uv[i] = Cb;
    uv[i + 1] = Cr;
  }
  return [Buffer.alloc(w * hgt, Y), uv];
};

/** Mount, wait for the window to be on screen and the port to answer. */
async function mount(sink, options) {
  const rendered = await renderX11(pane(sink, options), { app });
  const window = rendered.windowNode?.window ?? null;
  await until(() => xvVideoFor(app).port !== undefined, 'the Xv port');
  if (window) await until(() => window._mapped === true, 'the window to map');
  return rendered;
}

/** Count what goes through the port, and what through the JS conversion. */
function spy(t) {
  const writer = xvVideoFor(app);
  const counts = { xv: 0 };
  const put = writer.port.putImage.bind(writer.port);
  writer.port.putImage = (...args) => {
    const sent = put(...args);
    if (sent) counts.xv++;
    return sent;
  };
  t.after(() => {
    writer.port.putImage = put;
  });
  return counts;
}

test('the port is asked for once a sink is made, and its formats lead', async (t) => {
  if (skip) return t.skip(skip);
  const sink = createVideoFrames(app, {
    width: 64,
    height: 36,
    format: 'NV12',
  });
  await until(() => xvVideoFor(app).port !== undefined, 'the Xv port');
  const port = xvVideoFor(app).port;
  const expected = [
    ...(port.formats.includes('NV12') ? ['NV12'] : []),
    ...(port.formats.includes('I420') || port.formats.includes('YV12')
      ? ['I420']
      : []),
    'BGRA',
  ];
  assert.deepStrictEqual(sink.preferredFormats, expected);
});

test('an NV12 frame goes through the port and shows the picture the JS conversion makes', async (t) => {
  if (skip) return t.skip(skip);
  const sink = createVideoFrames(app, {
    width: 64,
    height: 36,
    format: 'NV12',
  });
  const { ctx } = await mount(sink);
  const counts = spy(t);
  // BT.709 video-range: a saturated orange, where the matrix shows
  const ycc = [120, 70, 200];
  await act(() => sink.push(solidNV12(64, 36, ycc)));
  await until(() => counts.xv > 0, 'a frame through the port');
  const want = frameToRGBA(
    sink,
    sink.frame,
    new Uint8ClampedArray(64 * 36 * 4),
  ).subarray(0, 3);
  const got = await pixelAt(ctx, 80, 45);
  assert.ok(
    isNear(got, [...want], 3),
    `the port's ${got} against JavaScript's ${[...want]}`,
  );
  assert.strictEqual(counts.xv, 1, 'one frame, one put');
  assert.strictEqual(
    videoNode()._rgba,
    null,
    'and no frame converted in JavaScript',
  );
});

test('the picture is in the paint order: a box drawn after it covers it', async (t) => {
  if (skip) return t.skip(skip);
  const sink = createVideoFrames(app, {
    width: 64,
    height: 36,
    format: 'I420',
  });
  const over = h('box', {
    style: {
      position: 'absolute',
      left: 60,
      top: 30,
      width: 40,
      height: 30,
      backgroundColor: '#00ff00',
    },
  });
  const { ctx } = await mount(sink, { over });
  const counts = spy(t);
  const cw = 32 * 18;
  await act(() =>
    sink.push([
      Buffer.alloc(64 * 36, 63),
      Buffer.alloc(cw, 102),
      Buffer.alloc(cw, 240),
    ]),
  );
  await until(() => counts.xv > 0, 'a frame through the port');
  assert.ok(
    isNear(await pixelAt(ctx, 20, 20), [255, 0, 0], 4),
    'BT.709 red where nothing covers it',
  );
  assert.ok(
    isNear(await pixelAt(ctx, 80, 45), [0, 255, 0], 2),
    'the box over it, not the video',
  );
});

test('a full-range frame is not one for the port, and is drawn the JavaScript way', async (t) => {
  if (skip) return t.skip(skip);
  const sink = createVideoFrames(app, {
    width: 64,
    height: 36,
    format: 'NV12',
    range: 'full',
  });
  const { ctx } = await mount(sink);
  const counts = spy(t);
  await act(() => sink.push(solidNV12(64, 36, [128, 128, 128])));
  // full range: 128 is 128
  assert.ok(isNear(await pixelAt(ctx, 80, 45), [128, 128, 128], 2));
  assert.strictEqual(counts.xv, 0);
  assert.notStrictEqual(videoNode()._rgba, null, 'converted in JavaScript');
});

test('BGRA goes through the port too, where it takes AR24', async (t) => {
  if (skip) return t.skip(skip);
  if (!xvVideoFor(app).port?.formats.includes('AR24')) {
    await until(() => xvVideoFor(app).port !== undefined, 'the Xv port');
    if (!xvVideoFor(app).port?.formats.includes('AR24'))
      return t.skip('no AR24 on this port');
  }
  const sink = createVideoFrames(app, { width: 64, height: 36 });
  const { ctx } = await mount(sink);
  const counts = spy(t);
  const bgra = Buffer.alloc(64 * 36 * 4);
  for (let i = 0; i < bgra.length; i += 4) bgra.set([30, 120, 220, 0], i);
  await act(() => sink.push(bgra));
  await until(() => counts.xv > 0, 'a frame through the port');
  assert.ok(
    isNear(await pixelAt(ctx, 80, 45), [220, 120, 30], 2),
    'opaque, whatever its fourth byte',
  );
});
