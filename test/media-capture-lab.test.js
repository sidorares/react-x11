// examples/labs/media-capture.jsx against the fake devices
// (src/testing/media.js): the rig mounts, says what the display can do,
// lists the devices, and its buttons reach a camera, a microphone, the audio
// out, a screenshot and other applications' sound. What a real camera and microphone do is the lab's
// own job on a real machine; this keeps it from rotting while core moves.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import React from 'react';

import {
  act,
  cleanup,
  createMockApp,
  fakeMediaDevices,
  pressButton,
  renderX11,
  roleOf,
  screen,
  textOf,
} from '../src/testing/index.js';

process.env.REACT_X11_NO_AUTORUN = '1';
const { App } = await import('../examples/labs/media-capture.jsx');

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  await cleanup();
});

/** The buttons labelled `label`, in tree order: the left column first. */
const buttons = (label) =>
  screen.all((n) => roleOf(n) === 'button' && textOf(n) === label);

async function press(windowNode, node) {
  const { x, y, width, height } = node.abs;
  await act(async () => {
    pressButton(windowNode.window, x + width / 2, y + height / 2);
    await tick();
    await tick();
  });
}

const logged = () =>
  screen
    .all((n) => n.kind === 'text')
    .map(textOf)
    .filter((t) => /^\d\d:\d\d:\d\d {2}/.test(t));

test('the lab mounts over fake devices, and its buttons reach them', async () => {
  const app = createMockApp();
  const fake = fakeMediaDevices(app);
  const { windowNode } = await renderX11(h(App), {
    app,
    backend: 'mock',
    wrap: false,
  });
  await act(async () => {
    await tick();
    await tick();
  });

  // what the display can do, and the devices, named before any permission
  screen.getByText('camera: fake — hotplug, labelsBeforePermission');
  screen.getByText('camera: Fake camera (default)');
  screen.getByText('mic: Fake microphone (default)');
  assert.ok(
    logged().some((l) =>
      l.includes('displaySources: 2 — fake-screen, fake-window'),
    ),
    logged().join('\n'),
  );

  // the camera: Start is the second one, the microphone's comes first
  const [, cameraStart] = buttons('Start');
  await press(windowNode, cameraStart);
  const camera = fake.last('video');
  assert.ok(camera, 'a camera was opened');
  assert.equal(camera.settings().width, 1280);
  const video = screen.all((n) => n.kind === 'video')[0];
  assert.equal(video.props.srcObject.getVideoTracks()[0].label, 'Fake camera');
  assert.ok(logged().some((l) => l.endsWith('camera: live')));

  // the microphone: its meter reads the tone, a tenth of full scale
  const [micStart] = buttons('Start');
  await press(windowNode, micStart);
  const mic = fake.last('audio');
  assert.equal(mic.settings().sampleRate, 48000);
  await act(async () => {
    for (let i = 0; i < 5; i++) mic.tick();
    await wait(150);
  });
  screen.getByText('-20 dBFS');
  // and the bar shows it: two thirds of a 60 dB scale, laid out with a height
  const fill = screen.all(
    (n) => n.kind === 'box' && n.props.style?.width === '67%',
  )[0];
  assert.ok(fill, 'the meter is filled to -20 dBFS');
  assert.ok(fill.abs.height > 0, 'the fill has a height to show it in');
  screen.getByText('480 frames at 48000 Hz, 1 ch');

  // the audio out: a second of tone, both channels
  await press(windowNode, buttons('Play a tone')[0]);
  const [out] = fake.outputs;
  assert.deepEqual([out.sampleRate, out.channels], [48000, 2]);
  assert.equal(out.samples(0).length, 48000);

  // a screenshot, saved where the log says
  await press(windowNode, buttons('Screenshot')[0]);
  await act(async () => {
    await wait(20);
  });
  assert.equal(fake.screenshots.length, 1);
  const saved = logged().find((l) => l.includes('screenshot of source'));
  assert.match(saved, /1280x720 → .*react-x11-source-\d+\.png$/);
  rmSync(saved.split('→ ')[1]);
  assert.ok(screen.all((n) => n.kind === 'image').length === 1, 'shown');

  // stopping lets the camera go
  await press(windowNode, buttons('Stop')[1]);
  assert.equal(camera.stopped, true);
});

test('the lab records other applications’ sound, and saves what it heard', async () => {
  const app = createMockApp();
  const fake = fakeMediaDevices(app);
  const { windowNode } = await renderX11(h(App), {
    app,
    backend: 'mock',
    wrap: false,
  });
  await act(async () => {
    await tick();
    await tick();
  });
  screen.getByText(
    'systemAudio: fake — applications, excludesSelf, resample, hotplug, playing',
  );
  screen.getByText('sound: Fake player');
  screen.getByText('system-audio-recording: granted');

  await press(windowNode, buttons('Record')[0]);
  const tap = fake.last('audio');
  assert.equal(tap.label, 'System audio', 'everything, not the microphone');
  assert.deepEqual(
    [tap.settings().sampleRate, tap.settings().channelCount],
    [48000, 2],
  );
  await act(async () => {
    for (let i = 0; i < 10; i++) tap.tick();
    await wait(150);
  });
  screen.getByText('480 frames at 48000 Hz, 2 ch');
  assert.ok(logged().some((l) => l.endsWith('system audio: live')));

  await press(windowNode, buttons('Save WAV')[0]);
  const saved = logged().find((l) => /system audio: [\d.]+ s saved/.test(l));
  assert.ok(saved, logged().join('\n'));
  const path = saved.split('→ ')[1];
  // stereo at 48 kHz, 16 bits a sample, in whole 10 ms chunks — the fake
  // keeps making them while it is read, so how many is the timer's
  const file = readFileSync(path);
  assert.deepEqual(
    [
      file.toString('ascii', 0, 4),
      file.readUInt16LE(22),
      file.readUInt32LE(24),
    ],
    ['RIFF', 2, 48000],
  );
  const data = file.readUInt32LE(40);
  assert.ok(data >= 10 * 480 * 4 && data % (480 * 4) === 0, `${data} bytes`);
  rmSync(path);

  await press(windowNode, buttons('Stop recording')[0]);
  assert.equal(tap.stopped, true);
});

test('the lab’s pane module is the lab with no window of its own, and no row for one', async () => {
  const { default: MediaCapturePane } =
    await import('../examples/labs/media-capture-pane.jsx');
  const app = createMockApp();
  fakeMediaDevices(app);
  await renderX11(h(MediaCapturePane), { app, backend: 'mock' });
  await act(async () => {
    await tick();
    await tick();
  });
  screen.getByText('camera: Fake camera (default)');
  assert.equal(buttons('Screenshot').length, 1);
  // a pane has no window of its own to capture or keep out
  assert.equal(buttons('This window').length, 0);
  assert.equal(
    screen.all((n) => textOf(n) === 'keep this window out of captures').length,
    0,
  );
});
