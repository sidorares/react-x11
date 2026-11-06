// `<video srcObject>` and `<audio srcObject>` (src/nodes/video.js,
// src/nodes/audio.js) over the fake devices: a camera's frames drawn into
// the box against node-x11's in-process X server and read back, the stream
// followed as its tracks change, and a microphone's chunks played through
// the audio sink. The Cocoa presentation, where a camera shows itself on a
// layer, is test/cocoa-capture.test.js's.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';

import { getUserMedia, MediaStream, NoAudioOutputError } from '../src/index.js';
import {
  act,
  cleanup,
  createMockApp,
  fakeMediaDevices,
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

const BG = '#203040';

function pane(props) {
  return h(
    'window',
    { width: 200, height: 100, style: { backgroundColor: '#ffffff' } },
    h('video', {
      ...props,
      style: { width: 200, height: 100, backgroundColor: BG },
    }),
  );
}

const videoNode = () => screen.all((n) => n.kind === 'video')[0];

test('<video srcObject> draws the camera’s frames, and follows the track', async () => {
  const meta = [];
  const { ctx, app, rerender } = await renderX11(pane({}));
  const fake = fakeMediaDevices(app);
  const stream = await getUserMedia(
    { video: { width: 64, height: 48 } },
    { app },
  );
  const [track] = stream.getVideoTracks();
  await rerender(
    pane({ srcObject: stream, onLoadedMetadata: (m) => meta.push(m) }),
  );
  await settle(app);
  const source = fake.last('video');
  assert.equal(source.wanted, true, 'the element reads frames off the track');
  assert.ok(isNear(await pixelAt(ctx, 100, 50), BG), 'nothing before a frame');
  assert.equal(videoNode().paused, false, 'a stream plays');

  await act(() => source.tick());
  // 64x48 contained in 200x100: 133 wide from x=33; the bars run white to
  // black from left to right
  assert.ok(isNear(await pixelAt(ctx, 38, 50), [255, 255, 255], 6), 'white');
  assert.ok(isNear(await pixelAt(ctx, 162, 50), [0, 0, 0], 6), 'black');
  assert.ok(isNear(await pixelAt(ctx, 10, 50), BG), 'the bar beside it');
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
  assert.deepEqual(
    meta.map((m) => [m.width, m.height, m.duration]),
    [[64, 48, Infinity]],
  );

  // disabled: the background again, and back on the next frame
  await act(() => {
    track.enabled = false;
  });
  assert.ok(isNear(await pixelAt(ctx, 38, 50), BG), 'disabled shows nothing');
  await act(() => {
    track.enabled = true;
  });
  await act(() => source.tick());
  assert.ok(isNear(await pixelAt(ctx, 38, 50), [255, 255, 255], 6));

  // a new size is a new picture
  await act(() => track.applyConstraints({ width: 32, height: 32 }));
  await act(() => fake.last('video').tick());
  await settle(app);
  assert.ok(isNear(await pixelAt(ctx, 10, 50), BG), 'a square in the middle');
  assert.ok(isNear(await pixelAt(ctx, 56, 50), [255, 255, 255], 6));

  // stopped: nothing shown, nothing read
  await act(() => track.stop());
  assert.ok(isNear(await pixelAt(ctx, 56, 50), BG));
  assert.equal(videoNode().paused, true);
});

test('<video> takes one of frames, src and srcObject, and srcObject is a MediaStream', async () => {
  const app = createMockApp();
  fakeMediaDevices(app);
  const stream = await getUserMedia({ video: true }, { app });
  await assert.rejects(
    renderX11(h('video', { srcObject: stream, src: '/tmp/a.mp4' }), {
      app,
      backend: 'mock',
    }),
    /takes one of frames, src and srcObject, and was given src and srcObject/,
  );
  await assert.rejects(
    renderX11(h('video', { srcObject: {} }), { app, backend: 'mock' }),
    /must be a MediaStream/,
  );
  // a stream an app put together itself is a stream
  const own = new MediaStream(stream.getVideoTracks());
  await renderX11(h('video', { srcObject: own }), { app, backend: 'mock' });
  for (const t of stream.getTracks()) t.stop();
});

test('<audio srcObject> plays a microphone through the sink, as loud as it says', async () => {
  const app = createMockApp();
  const fake = fakeMediaDevices(app);
  const stream = await getUserMedia(
    { audio: { sampleRate: 16000, channelCount: 1 } },
    { app },
  );
  const props = { srcObject: stream };
  const { rerender } = await renderX11(h('audio', props), {
    app,
    backend: 'mock',
  });
  const mic = fake.last('audio');
  assert.equal(mic.wanted, true);
  mic.tick();
  mic.tick();
  const [out] = fake.outputs;
  assert.deepEqual([out.sampleRate, out.channels], [16000, 1]);
  const heard = out.samples();
  assert.equal(heard.length, 320, 'two 10 ms chunks at 16 kHz');
  const peak = Math.max(...heard.map(Math.abs));
  assert.ok(Math.abs(peak - 0.1) < 0.001, `a tenth of full scale, got ${peak}`);

  await rerender(h('audio', { ...props, volume: 0.5 }));
  mic.tick();
  const half = out.pushed.at(-1)[0];
  assert.ok(Math.abs(Math.max(...half.map(Math.abs)) - 0.05) < 0.001);
  assert.notEqual(half, mic, 'scaled into a copy');

  await rerender(h('audio', { ...props, muted: true }));
  const before = out.pushed.length;
  mic.tick();
  assert.equal(out.pushed.length, before, 'muted: nothing pushed');

  await rerender(h('audio', null));
  assert.equal(out.closed, true, 'the sink closes with the stream');
  assert.equal(mic.wanted, false);
  for (const t of stream.getTracks()) t.stop();
});

test('<audio srcObject> where nothing plays: one NoAudioOutputError', async () => {
  const app = createMockApp();
  const fake = fakeMediaDevices(app);
  delete fake.openAudioOutput;
  const stream = await getUserMedia({ audio: true }, { app });
  const errors = [];
  await renderX11(
    h('audio', { srcObject: stream, onError: (e) => errors.push(e) }),
    { app, backend: 'mock' },
  );
  fake.last('audio').tick();
  fake.last('audio').tick();
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof NoAudioOutputError);
  for (const t of stream.getTracks()) t.stop();
});
