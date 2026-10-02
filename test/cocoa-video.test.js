// <video frames> on the macOS surface presenter (src/cocoa/video.js, the
// `contents` kind in src/cocoa/sprites.js) over the fake bridge: the real
// CocoaApp, its window and promotion, the node tree and its frame clock —
// only the natives are faked, so what a test pins is the call that went out
// and the frame it went out in. The contract (docs/architecture/video.md
// §7): a video with a frame to show is one sprite part whose content is its
// sink, lifted onto a layer where nothing is painted over it; from then on
// every push writes a video surface and repoints the layer with no frame of
// the window's own; anything that stops allowing the lift gives the picture
// back to the element, which draws the newest frame through the bridge's own
// conversion; and over a bridge with no video surfaces nothing is lifted and
// the frame is converted in JavaScript.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { createVideoFrames } from '../src/index.js';
import {
  cleanupCocoa,
  fakeCocoaBridge,
  mountCocoa,
} from './helpers/cocoa-bridge.js';

const h = React.createElement;

afterEach(async () => {
  await cleanupCocoa();
});

const W = 64;
const H = 36;
const nv12 = (y = 100) => [
  Buffer.alloc(W * H, y),
  Buffer.alloc(W * (H / 2), 128),
];

const video = (sink, style = {}, props = {}) =>
  h('video', {
    key: 'video',
    frames: sink,
    ...props,
    style: {
      position: 'absolute',
      left: 10,
      top: 10,
      width: 160,
      height: 90,
      backgroundColor: '#000000',
      ...style,
    },
  });

const cover = () =>
  h('box', {
    key: 'cover',
    style: {
      position: 'absolute',
      left: 20,
      top: 20,
      width: 30,
      height: 30,
      backgroundColor: '#ff0000',
    },
  });

/** The lifted part's state, or undefined. */
const liftedState = (promotion) => {
  const host = [...promotion.sprites.hosts.values()][0];
  return host ? [...host.values()][0] : undefined;
};

const videoNode = (node) => {
  const walk = (n) => {
    if (n.kind === 'video') return n;
    for (const c of n.children ?? []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(node);
};

test('a video is offered once it has a frame, and goes on a layer of its own', async () => {
  const sink = createVideoFrames(null, { width: W, height: H, format: 'NV12' });
  const { native, frame, promotion, node } = await mountCocoa(video(sink));
  frame();
  assert.equal(promotion.sprites.hosts.size, 0, 'nothing to show yet');
  sink.push(nv12());
  frame();
  const state = liftedState(promotion);
  assert.ok(state, 'lifted');
  assert.equal(state.contents, sink);
  assert.equal(videoNode(node)._lifted, true, 'told, so it leaves a hole');
  // the layer is the picture: 160x90 logical, contained exactly
  assert.deepEqual(state.layer.props.bounds, [0, 0, 160, 90]);
  // a video surface made for the sink, written and shown on the layer
  const [made] = native.of('createVideoSurface');
  assert.deepEqual(made, [
    W,
    H,
    { format: 'NV12', colorSpace: 'bt709', range: 'video' },
  ]);
  const [[target, format, planes]] = native.of('writeVideoSurface');
  assert.ok(target.video, 'into the video surface');
  assert.equal(format, 'NV12');
  assert.equal(planes, sink.frame.planes);
  assert.equal(state.layer.ioSurface, state.lift.current.handle.video);
  // nothing painted the picture, so no raster was made for it
  assert.equal(state.raster.surface ?? null, null);
  // and the element left a hole where it is: no frame drawn into a bitmap
  assert.deepEqual(
    native.of('writeVideoSurface').filter(([t]) => !t.video),
    [],
    'the element drew nothing of the picture',
  );
});

test('a push to a lifted video is not a frame', async () => {
  const sink = createVideoFrames(null, { width: W, height: H, format: 'NV12' });
  const { native, frame, frames, promotion, node } = await mountCocoa(
    video(sink),
  );
  sink.push(nv12());
  frame();
  const state = liftedState(promotion);
  assert.ok(state);
  const before = frames.count;
  const writes = native.of('writeVideoSurface').length;
  const flips = native.of('setLayerContentsIOSurface').length;
  for (let i = 0; i < 10; i++) {
    sink.push(nv12(i));
    assert.equal(node.needsPaint, false, `push ${i} asked for no frame`);
    frame();
  }
  assert.equal(frames.count, before, 'the window painted nothing');
  assert.equal(native.of('writeVideoSurface').length - writes, 10);
  const shown = native.of('setLayerContentsIOSurface').slice(flips);
  assert.equal(shown.length, 10);
  assert.ok(
    shown.every(([layer]) => layer === state.layer),
    'every flip on the part’s layer',
  );
});

test('frames go only into surfaces the render server has let go of', async (t) => {
  const sink = createVideoFrames(null, { width: W, height: H, format: 'I420' });
  const { native, frame, promotion } = await mountCocoa(video(sink));
  const i420 = (y) => [
    Buffer.alloc(W * H, y),
    Buffer.alloc((W / 2) * (H / 2), 128),
    Buffer.alloc((W / 2) * (H / 2), 128),
  ];
  sink.push(i420(1));
  frame();
  const lift = liftedState(promotion).lift;
  // an I420 sink is shown from NV12 surfaces, interleaved by the bridge
  assert.equal(native.of('createVideoSurface')[0][2].format, 'NV12');
  // everything busy: the ring grows to four and no further
  for (let i = 2; i <= 5; i++) {
    for (const s of lift.ring) s.handle.inUse = true;
    sink.push(i420(i));
  }
  assert.equal(lift.ring.length, 4);
  const writes = native.of('writeVideoSurface').length;
  for (const s of lift.ring) s.handle.inUse = true;
  sink.push(i420(6));
  assert.equal(
    native.of('writeVideoSurface').length,
    writes,
    'nothing free: nothing written',
  );
  sink.push(i420(7));
  // one comes free, and the newest frame goes into it, not the one it missed
  lift.ring.find((s) => s !== lift.current).handle.inUse = false;
  await new Promise((r) => setTimeout(r, 30));
  const last = native.of('writeVideoSurface').at(-1);
  assert.equal(native.of('writeVideoSurface').length, writes + 1);
  assert.equal(last[2][0][0], 7, 'the newest frame');
  t.diagnostic(`ring of ${lift.ring.length}`);
});

test('painted over, the picture comes back to the element, drawn through the bridge', async () => {
  const sink = createVideoFrames(null, { width: W, height: H, format: 'NV12' });
  const { native, frame, frames, promotion, render, node } = await mountCocoa([
    video(sink),
  ]);
  sink.push(nv12());
  frame();
  assert.ok(liftedState(promotion));
  await render([video(sink), cover()]);
  frame();
  assert.equal(promotion.sprites.hosts.size, 0, 'declined: the box is over it');
  assert.equal(videoNode(node)._lifted, false);
  // drawn: the newest frame into a 2D surface of the element's own, converted
  // by the bridge, composited in paint order
  const into2D = native
    .of('writeVideoSurface')
    .filter(([target]) => !target.video);
  assert.ok(into2D.length >= 1, 'the frame written into a bitmap');
  const [target, format, , options] = into2D.at(-1);
  assert.equal(format, 'NV12');
  assert.deepEqual(
    [options.width, options.height, options.colorSpace, options.range],
    [W, H, 'bt709', 'video'],
  );
  assert.ok(
    native.of('ctxDrawSurface').some(([, src]) => src === target),
    'composited',
  );
  // and a push is a claim now, a frame per push
  const before = frames.count;
  sink.push(nv12(9));
  assert.equal(node.needsPaint, true);
  frame();
  assert.equal(frames.count, before + 1);
  // uncovered, it goes back up
  await render([video(sink)]);
  frame();
  assert.ok(liftedState(promotion), 'lifted again');
});

test('a bridge with no video surfaces lifts nothing, and the frame is converted here', async () => {
  const VIDEO_VERBS = new Set([
    'createVideoSurface',
    'writeVideoSurface',
    'videoSurfaceIsInUse',
    'releaseVideoSurface',
    'videoFormats',
  ]);
  const fake = fakeCocoaBridge();
  const bridge = new Proxy(fake, {
    get: (target, name) => (VIDEO_VERBS.has(name) ? undefined : target[name]),
  });
  const sink = createVideoFrames(null, { width: W, height: H, format: 'NV12' });
  const { app, frame, promotion } = await mountCocoa(video(sink), {
    native: bridge,
  });
  sink.push(nv12());
  frame();
  assert.equal(promotion.sprites.hosts.size, 0, 'declined');
  assert.deepEqual(app.videoFormats(), ['BGRA']);
  const puts = fake.of('ctxPutImageData');
  assert.ok(puts.length >= 1, 'converted in JavaScript and put');
  const [, rgba, w, hh] = puts.at(-1);
  assert.deepEqual([w, hh, rgba.length], [W, H, W * H * 4]);
});

test('the app says NV12 first where it can show NV12 as it is', async () => {
  const { app } = await mountCocoa(h('box', {}));
  assert.deepEqual(app.videoFormats(), ['NV12', 'I420', 'BGRA']);
  assert.deepEqual(
    createVideoFrames(app, { width: 2, height: 2 }).preferredFormats,
    ['NV12', 'I420', 'BGRA'],
  );
});

test('closed, the picture comes down; unmounted, its surfaces are let go', async () => {
  const sink = createVideoFrames(null, { width: W, height: H, format: 'BGRA' });
  const { native, frame, promotion, render } = await mountCocoa([video(sink)]);
  sink.push(Buffer.alloc(W * H * 4, 50));
  frame();
  const state = liftedState(promotion);
  assert.equal(native.of('createVideoSurface')[0][2].format, 'BGRA');
  sink.close();
  frame();
  assert.equal(promotion.sprites.hosts.size, 0, 'nothing to show');
  assert.ok(native.of('removeFromSuperlayer').some(([l]) => l === state.layer));
  const made = native.of('createVideoSurface').length;
  assert.equal(
    native.of('releaseVideoSurface').length,
    made,
    'every surface let go',
  );
  // and again through an unmount
  const next = createVideoFrames(null, { width: W, height: H, format: 'NV12' });
  await render([video(next)]);
  next.push(nv12());
  frame();
  assert.ok(liftedState(promotion));
  await render([]);
  frame();
  assert.equal(promotion.sprites.hosts.size, 0);
  assert.equal(
    native.of('releaseVideoSurface').length,
    native.of('createVideoSurface').length,
  );
});

test('a covering picture is cut to its box by a box that masks', async () => {
  const sink = createVideoFrames(null, { width: W, height: H, format: 'NV12' });
  const { frame, promotion } = await mountCocoa(
    video(sink, { width: 90, height: 90, objectFit: 'cover' }),
  );
  sink.push(nv12());
  frame();
  const state = liftedState(promotion);
  assert.ok(state.box, 'in a box');
  assert.equal(state.box.props.masksToBounds, true);
  // the box is the content box, 90x90 logical; the picture 160x90 inside it
  assert.deepEqual(state.box.props.frame.slice(2), [90, 90]);
  assert.deepEqual(state.layer.props.bounds, [0, 0, 160, 90]);
});
