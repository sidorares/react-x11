// <video>, VideoFrames and objectFit (docs/architecture/video.md §6).
//
// The sink's contract is pure and is tested as such; the element's drawn
// presentation — the one every backend has, and the one a lifted video falls
// back to whenever something is painted over it — runs against node-x11's
// in-process X server: a real surface, a real PutImage of the converted
// frame, a real composite scaled into the box, read back. The lifted half is
// macOS's and is test/cocoa-video.test.js's.
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { PNG } from 'pngjs';
import React from 'react';

import {
  createVideoFrames,
  NoMediaPlaybackError,
  useSupports,
  VideoFrames,
} from '../src/index.js';
import { fitRect, objectFitOf } from '../src/nodes/fit.js';
import { frameToRGBA, planeLayout } from '../src/videoframes.js';
import {
  act,
  cleanup,
  isNear,
  pixelAt,
  renderX11,
  screen,
  settle,
} from '../src/testing/index.js';

const h = React.createElement;

afterEach(async () => {
  await cleanup();
});

// --- the sink ------------------------------------------------------------------

test('a sink checks its size, format, colour and range where it is made', () => {
  assert.throws(
    () => createVideoFrames(null, { width: 0, height: 10 }),
    /width and height are the frame size in whole pixels/,
  );
  assert.throws(
    () => createVideoFrames(null, { width: 10.5, height: 10 }),
    /whole pixels/,
  );
  assert.throws(
    () => createVideoFrames(null, { width: 8, height: 8, format: 'YUY2' }),
    /format "YUY2" — expected one of NV12, I420, BGRA/,
  );
  assert.throws(
    () => createVideoFrames(null, { width: 8, height: 8, colorSpace: 'srgb' }),
    /expected one of bt709, bt601, bt2020/,
  );
  assert.throws(
    () => createVideoFrames(null, { width: 8, height: 8, range: 'limited' }),
    /expected 'video' or 'full'/,
  );
  const sink = createVideoFrames(null, { width: 8, height: 6 });
  assert.ok(sink instanceof VideoFrames);
  assert.deepStrictEqual(
    [sink.format, sink.colorSpace, sink.range, sink.version, sink.frame],
    ['BGRA', 'bt709', 'video', 0, null],
  );
});

test('planes: one 4:2:0 chroma plane is half each way, rounded up', () => {
  assert.deepStrictEqual(planeLayout('NV12', 5, 3), [
    { rowBytes: 5, rows: 3 },
    { rowBytes: 6, rows: 2 },
  ]);
  assert.deepStrictEqual(planeLayout('I420', 5, 3), [
    { rowBytes: 5, rows: 3 },
    { rowBytes: 3, rows: 2 },
    { rowBytes: 3, rows: 2 },
  ]);
  assert.deepStrictEqual(planeLayout('BGRA', 5, 3), [
    { rowBytes: 20, rows: 3 },
  ]);
});

test('push takes planes, or one buffer of them back to back, and replaces the frame', () => {
  const sink = createVideoFrames(null, { width: 4, height: 2, format: 'NV12' });
  const seen = [];
  const off = sink._subscribe((frame) => seen.push(frame));
  const y = Buffer.alloc(8, 1);
  const uv = Buffer.alloc(4, 2);
  sink.push([y, uv], { time: 0.5 });
  assert.strictEqual(sink.version, 1);
  assert.strictEqual(sink.frame.time, 0.5);
  assert.strictEqual(sink.frame.planes[0].buffer, y.buffer, 'not copied');
  assert.deepStrictEqual(sink.frame.strides, [4, 4]);
  // one buffer, as an ffmpeg rawvideo pipe delivers a frame
  const both = Buffer.concat([Buffer.alloc(8, 3), Buffer.alloc(4, 4)]);
  sink.push(both);
  assert.strictEqual(sink.version, 2);
  assert.deepStrictEqual([...sink.frame.planes[0]], [3, 3, 3, 3, 3, 3, 3, 3]);
  assert.deepStrictEqual([...sink.frame.planes[1]], [4, 4, 4, 4]);
  // padded rows
  sink.push([Buffer.alloc(16), Buffer.alloc(12)], { strides: [8, 8] });
  assert.deepStrictEqual(sink.frame.strides, [8, 8]);
  assert.strictEqual(seen.length, 3);
  off();
  sink.push([y, uv]);
  assert.strictEqual(seen.length, 3, 'unsubscribed');
});

test('push says what a frame needs when it is not given it', () => {
  const sink = createVideoFrames(null, { width: 4, height: 2, format: 'I420' });
  assert.throws(
    () => sink.push([Buffer.alloc(8), Buffer.alloc(2)]),
    /an array of 3 planes \(Y, Cb, Cr\), or one buffer holding them back to back/,
  );
  assert.throws(
    () => sink.push([Buffer.alloc(8), Buffer.alloc(1), Buffer.alloc(2)]),
    /plane 1 of a 4x2 I420 frame needs 2 bytes, and has 1/,
  );
  assert.throws(
    () => sink.push(Buffer.alloc(10)),
    /in one buffer needs 12 bytes, and this one has 10/,
  );
  assert.throws(
    () =>
      sink.push([Buffer.alloc(8), Buffer.alloc(2), Buffer.alloc(2)], {
        strides: [3, 2, 2],
      }),
    /strides must be 3 whole numbers of bytes, at least \[4, 2, 2\]/,
  );
  assert.throws(
    () => sink.push(['nope', Buffer.alloc(2), Buffer.alloc(2)]),
    /plane 0 is not a Buffer or a typed array/,
  );
  assert.strictEqual(sink.version, 0, 'nothing pushed');
});

test('close drops the frame, tells what shows it, and ignores what comes after', () => {
  const sink = createVideoFrames(null, { width: 2, height: 2 });
  const seen = [];
  sink._subscribe((frame) => seen.push(frame));
  sink.push(Buffer.alloc(16));
  sink.close();
  assert.strictEqual(sink.frame, null);
  assert.deepStrictEqual(seen.at(-1), null);
  sink.push(Buffer.alloc(16));
  assert.strictEqual(
    sink.frame,
    null,
    'a decoder racing the close loses quietly',
  );
  assert.strictEqual(seen.length, 2);
});

test('preferredFormats is the app’s answer, and BGRA where it has none', () => {
  assert.deepStrictEqual(
    createVideoFrames(null, { width: 2, height: 2 }).preferredFormats,
    ['BGRA'],
  );
  const app = { videoFormats: () => ['NV12', 'I420', 'BGRA'] };
  assert.deepStrictEqual(
    createVideoFrames(app, { width: 2, height: 2 }).preferredFormats,
    ['NV12', 'I420', 'BGRA'],
  );
});

// --- converting a frame where nothing native will ----------------------------

const rgbaOf = (sink, planes) => {
  sink.push(planes);
  return frameToRGBA(
    sink,
    sink.frame,
    new Uint8ClampedArray(sink.width * sink.height * 4),
  );
};

test('frameToRGBA: the matrix and the range, for NV12 and I420 alike', () => {
  const nv12 = (y, cb, cr) => [
    Buffer.alloc(4, y),
    Buffer.from([cb, cr, cb, cr]),
  ];
  const i420 = (y, cb, cr) => [
    Buffer.alloc(4, y),
    Buffer.from([cb]),
    Buffer.from([cr]),
  ];
  const video = createVideoFrames(null, {
    width: 2,
    height: 2,
    format: 'NV12',
  });
  assert.deepStrictEqual(
    [...rgbaOf(video, nv12(16, 128, 128)).slice(0, 4)],
    [0, 0, 0, 255],
  );
  assert.deepStrictEqual(
    [...rgbaOf(video, nv12(235, 128, 128)).slice(0, 4)],
    [255, 255, 255, 255],
  );
  // BT.709's red, in video range
  const red = [...rgbaOf(video, nv12(63, 102, 240)).slice(0, 3)];
  assert.ok(isNear(red, [255, 0, 0], 2), `709 red: ${red}`);
  // the same numbers under 601 are another colour
  const sd = createVideoFrames(null, {
    width: 2,
    height: 2,
    format: 'NV12',
    colorSpace: 'bt601',
  });
  assert.ok(!isNear([...rgbaOf(sd, nv12(63, 102, 240)).slice(0, 3)], red, 4));
  const full = createVideoFrames(null, {
    width: 2,
    height: 2,
    format: 'NV12',
    range: 'full',
  });
  assert.deepStrictEqual(
    [...rgbaOf(full, nv12(255, 128, 128)).slice(0, 4)],
    [255, 255, 255, 255],
  );
  const planar = createVideoFrames(null, {
    width: 2,
    height: 2,
    format: 'I420',
  });
  assert.deepStrictEqual(
    [...rgbaOf(planar, i420(63, 102, 240))],
    [...rgbaOf(video, nv12(63, 102, 240))],
    'I420 is NV12 with its chroma in two planes',
  );
});

test('frameToRGBA: BGRA swaps red and blue and is opaque whatever its fourth byte', () => {
  const sink = createVideoFrames(null, { width: 1, height: 1, format: 'BGRA' });
  assert.deepStrictEqual(
    [...rgbaOf(sink, Buffer.from([10, 20, 30, 0]))],
    [30, 20, 10, 255],
  );
});

// --- objectFit ------------------------------------------------------------------

test('fitRect: fill, contain, cover, none and scale-down, centred, on whole pixels', () => {
  const box = { x: 10, y: 20, width: 200, height: 100 };
  assert.deepStrictEqual(fitRect(box, 400, 100, 'fill'), box);
  assert.deepStrictEqual(fitRect(box, 400, 100, 'contain'), {
    x: 10,
    y: 45,
    width: 200,
    height: 50,
  });
  assert.deepStrictEqual(fitRect(box, 400, 100, 'cover'), {
    x: -90,
    y: 20,
    width: 400,
    height: 100,
  });
  assert.deepStrictEqual(fitRect(box, 40, 30, 'none'), {
    x: 90,
    y: 55,
    width: 40,
    height: 30,
  });
  assert.deepStrictEqual(fitRect(box, 40, 30, 'scale-down'), {
    x: 90,
    y: 55,
    width: 40,
    height: 30,
  });
  assert.deepStrictEqual(
    fitRect(box, 400, 100, 'scale-down'),
    fitRect(box, 400, 100, 'contain'),
  );
  // a 16:9 picture in a box that is neither: snapped, not fractional
  const r = fitRect({ x: 0, y: 0, width: 101, height: 101 }, 16, 9, 'contain');
  assert.ok(
    [r.x, r.y, r.width, r.height].every(Number.isInteger),
    JSON.stringify(r),
  );
  assert.strictEqual(objectFitOf({ objectFit: 'cover' }, 'fill'), 'cover');
  assert.strictEqual(objectFitOf({}, 'contain'), 'contain');
});

test('objectFit is checked where it is written', async () => {
  await assert.rejects(
    renderX11(
      h(
        'window',
        { width: 50, height: 50 },
        h('video', { style: { objectFit: 'stretch' } }),
      ),
    ),
    /invalid objectFit "stretch".*'fill', 'contain', 'cover', 'none', 'scale-down'/s,
  );
});

// --- the element, drawn -----------------------------------------------------------

const BG = '#203040';
const solidBGRA = (w, h, [r, g, b]) => {
  const p = Buffer.alloc(w * h * 4);
  for (let i = 0; i < p.length; i += 4) {
    p[i] = b;
    p[i + 1] = g;
    p[i + 2] = r;
    p[i + 3] = 255;
  }
  return p;
};

/** A 200x100 window holding one video of `style` and `props`, at its top
 *  left. */
function pane(props, style = { width: 200, height: 100 }) {
  return h(
    'window',
    { width: 200, height: 100, style: { backgroundColor: '#ffffff' } },
    h('video', { ...props, style: { backgroundColor: BG, ...style } }),
  );
}

const videoNode = () => screen.all((n) => n.kind === 'video')[0];

test('<video frames> draws the newest frame, contained, with the background in the bars', async () => {
  const sink = createVideoFrames(null, { width: 40, height: 10 });
  const { ctx, app } = await renderX11(pane({ frames: sink }));
  await settle(app);
  // before the first push: the background, and nothing else
  assert.ok(isNear(await pixelAt(ctx, 100, 50), BG), 'no frame yet');
  await act(() => sink.push(solidBGRA(40, 10, [220, 40, 30])));
  // 40x10 into 200x100: 200x50, centred
  assert.ok(isNear(await pixelAt(ctx, 100, 50), [220, 40, 30]), 'the frame');
  assert.ok(isNear(await pixelAt(ctx, 100, 10), BG), 'the bar above');
  assert.ok(isNear(await pixelAt(ctx, 100, 90), BG), 'the bar below');
  // a new frame replaces it
  await act(() => sink.push(solidBGRA(40, 10, [30, 200, 60])));
  assert.ok(
    isNear(await pixelAt(ctx, 100, 50), [30, 200, 60]),
    'the next frame',
  );
});

test('a YCbCr frame is converted on its way to the screen', async () => {
  const sink = createVideoFrames(null, { width: 4, height: 4, format: 'NV12' });
  const { ctx } = await renderX11(
    pane({ frames: sink }, { width: 100, height: 100 }),
  );
  const uv = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 2) {
    uv[i] = 102;
    uv[i + 1] = 240;
  }
  await act(() => sink.push([Buffer.alloc(16, 63), uv]));
  const got = await pixelAt(ctx, 50, 50);
  assert.ok(isNear(got, [255, 0, 0], 4), `BT.709 red, got ${got}`);
});

test('a push claims the picture, not the window', async () => {
  const sink = createVideoFrames(null, { width: 8, height: 8 });
  const { app } = await renderX11(pane({ frames: sink }));
  await settle(app);
  const node = videoNode();
  const claims = [];
  const invalidate = node.root.invalidate.bind(node.root);
  node.root.invalidate = (layoutChanged, damage, reason) => {
    claims.push({ layoutChanged, damage, reason });
    return invalidate(layoutChanged, damage, reason);
  };
  sink.push(solidBGRA(8, 8, [1, 2, 3]));
  assert.deepStrictEqual(
    claims.map((c) => [c.layoutChanged, c.damage === node, c.reason]),
    [[false, true, 'content']],
  );
});

test('objectFit: cover fills the box and cuts the rest; a change of fit repaints', async () => {
  const sink = createVideoFrames(null, { width: 20, height: 20 });
  const tree = (objectFit) =>
    h(
      'window',
      {
        width: 200,
        height: 100,
        style: { backgroundColor: '#ffffff', padding: 20 },
      },
      h('video', {
        frames: sink,
        style: { width: 160, height: 40, objectFit, backgroundColor: BG },
      }),
    );
  const { ctx, app, rerender } = await renderX11(tree('cover'));
  await act(() => sink.push(solidBGRA(20, 20, [200, 100, 0])));
  assert.ok(
    isNear(await pixelAt(ctx, 25, 40), [200, 100, 0]),
    'covers the box edge to edge',
  );
  // the whole window painted again, so a picture drawn past its box would
  // show: a push's frame is bounded to the box and could not
  await act(() => videoNode().root.invalidate(false, undefined, 'test'));
  assert.ok(
    isNear(await pixelAt(ctx, 100, 15), '#ffffff'),
    'cut above the box',
  );
  assert.ok(
    isNear(await pixelAt(ctx, 100, 65), '#ffffff'),
    'cut below the box',
  );
  // a square in a 160x40 box, contained: 40x40 in the middle, bars beside
  await rerender(tree('contain'));
  await act();
  await settle(app);
  assert.ok(isNear(await pixelAt(ctx, 25, 40), BG), 'a bar, after the change');
  assert.ok(
    isNear(await pixelAt(ctx, 100, 40), [200, 100, 0]),
    'the picture in the middle',
  );
  await rerender(tree('fill'));
  await act();
  await settle(app);
  assert.ok(
    isNear(await pixelAt(ctx, 25, 40), [200, 100, 0]),
    'stretched over where the bar was',
  );
});

test('the poster stands in until a frame, and again after close', async () => {
  const poster = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 255, 255]),
  };
  const sink = createVideoFrames(null, { width: 2, height: 1 });
  const { ctx, app } = await renderX11(pane({ frames: sink, poster }));
  await settle(app);
  assert.ok(isNear(await pixelAt(ctx, 100, 50), [0, 0, 255]), 'the poster');
  await act(() => sink.push(solidBGRA(2, 1, [0, 255, 0])));
  assert.ok(isNear(await pixelAt(ctx, 100, 50), [0, 255, 0]), 'the frame');
  await act(() => sink.close());
  assert.ok(
    isNear(await pixelAt(ctx, 100, 50), [0, 0, 255]),
    'the poster again',
  );
});

test('a poster from a file lands later, and the box takes its size then', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'react-x11-poster-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const png = new PNG({ width: 40, height: 20 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 0;
    png.data[i + 1] = 160;
    png.data[i + 2] = 80;
    png.data[i + 3] = 255;
  }
  const file = join(dir, 'poster.png');
  writeFileSync(file, PNG.sync.write(png));
  const { ctx, app } = await renderX11(
    h(
      'window',
      { width: 200, height: 100, style: { backgroundColor: '#ffffff' } },
      h(
        'box',
        { style: { alignItems: 'flex-start' } },
        h('video', { poster: file }),
      ),
    ),
  );
  const node = videoNode();
  // the load is a file read away: 300x150 until then, the poster's after
  for (let i = 0; i < 50 && node.abs.width !== 40; i++) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  assert.deepStrictEqual([node.abs.width, node.abs.height], [40, 20]);
  await settle(app);
  assert.ok(isNear(await pixelAt(ctx, 20, 10), [0, 160, 80]), 'the poster');
});

test('the natural size: the stream in logical pixels, then the poster, then 300x150', async () => {
  const sink = createVideoFrames(null, { width: 64, height: 36 });
  const { app } = await renderX11(
    h(
      'window',
      { width: 400, height: 400 },
      h(
        'box',
        { style: { alignItems: 'flex-start' } },
        h('video', { frames: sink }),
        h('video', {
          poster: { width: 10, height: 20, data: new Uint8ClampedArray(800) },
        }),
        h('video', {}),
        h('video', { frames: sink, style: { width: 128 } }),
      ),
    ),
  );
  await settle(app);
  const [stream, poster, bare, half] = screen.all((n) => n.kind === 'video');
  assert.deepStrictEqual([stream.abs.width, stream.abs.height], [64, 36]);
  assert.deepStrictEqual([poster.abs.width, poster.abs.height], [10, 20]);
  assert.deepStrictEqual([bare.abs.width, bare.abs.height], [300, 150]);
  assert.deepStrictEqual(
    [half.abs.width, half.abs.height],
    [128, 72],
    'kept to its ratio',
  );
});

test('onLoadedMetadata: the sink’s size, after the commit, a live source', async () => {
  const sink = createVideoFrames(null, { width: 64, height: 36 });
  const seen = [];
  const { app } = await renderX11(
    pane({ frames: sink, onLoadedMetadata: (ev) => seen.push(ev) }),
  );
  await settle(app);
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(
    [seen[0].width, seen[0].height, seen[0].duration],
    [64, 36, Infinity],
  );
});

test('<video src> with no player: one NoMediaPlaybackError, and the poster', async () => {
  const errors = [];
  let supported = null;
  function Probe() {
    supported = useSupports('mediaPlayback');
    return null;
  }
  const poster = {
    width: 1,
    height: 1,
    data: new Uint8ClampedArray([255, 0, 255, 255]),
  };
  const { ctx, app } = await renderX11(
    h(
      'window',
      { width: 200, height: 100 },
      h(Probe),
      h('video', {
        src: '/tmp/clip.mp4',
        poster,
        onError: (e) => errors.push(e),
        style: { width: 200, height: 100 },
      }),
    ),
  );
  await settle(app);
  assert.strictEqual(supported, false);
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0] instanceof NoMediaPlaybackError);
  assert.strictEqual(errors[0].code, 'ENOMEDIAPLAYBACK');
  assert.match(errors[0].message, /useSupports\('mediaPlayback'\)/);
  assert.ok(
    isNear(await pixelAt(ctx, 100, 50), [255, 0, 255]),
    'the poster, not a black box',
  );
});

test('frames and src together, or frames that are not a sink, throw', async () => {
  const sink = createVideoFrames(null, { width: 2, height: 2 });
  await assert.rejects(
    renderX11(pane({ frames: sink, src: 'clip.mp4' })),
    /takes frames or src, not both/,
  );
  await assert.rejects(
    renderX11(pane({ frames: { push() {} } })),
    /must be a VideoFrames sink/,
  );
});

test('<image objectFit="contain"> keeps the picture’s shape', async () => {
  const src = {
    width: 4,
    height: 1,
    data: new Uint8ClampedArray(16)
      .fill(255)
      .map((v, i) => (i % 4 === 1 ? 0 : v)),
  };
  const { ctx, app } = await renderX11(
    h(
      'window',
      { width: 200, height: 100, style: { backgroundColor: '#000000' } },
      h('image', {
        src,
        style: { width: 200, height: 100, objectFit: 'contain' },
      }),
    ),
  );
  await settle(app);
  // 4x1 into 200x100: 200x50, centred
  assert.ok(isNear(await pixelAt(ctx, 100, 50), [255, 0, 255]), 'the picture');
  assert.ok(isNear(await pixelAt(ctx, 100, 10), [0, 0, 0]), 'nothing above it');
});
