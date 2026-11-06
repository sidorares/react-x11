// Media capture over the fake devices (src/media/, src/testing/media.js):
// constraints and the device they choose, permissions asked before a device
// opens, one session per device and settings, frames off a track, the
// hooks, and the audio sink. The elements that show a stream are
// test/media-elements.test.js's; the X11 screen rung is
// test/media-x11.test.js's.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';

import {
  createAudioFrames,
  desktopCapability,
  enumerateDevices,
  getDisplayMedia,
  getUserMedia,
  MediaStream,
  NoAudioOutputError,
  OverconstrainedError,
  useDesktopCapability,
  useDisplayMedia,
  useMediaDevices,
  usePermission,
  useUserMedia,
} from '../src/index.js';
import {
  normalizeTrackConstraints,
  selectDevice,
} from '../src/media/constraints.js';
import {
  act,
  cleanup,
  createMockApp,
  fakeMediaDevices,
  renderX11,
} from '../src/testing/index.js';

const h = React.createElement;

afterEach(async () => {
  await cleanup();
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

// --- constraints -----------------------------------------------------------------

const camera = (deviceId, max, extra = {}) => ({
  deviceId,
  groupId: deviceId,
  kind: 'videoinput',
  label: deviceId,
  capabilities: {
    width: { min: 1, max: max[0] },
    height: { min: 1, max: max[1] },
    frameRate: { min: 1, max: 30 },
    facingMode: [extra.facing ?? 'user'],
  },
  defaults: {
    width: 640,
    height: 480,
    frameRate: 30,
    facingMode: extra.facing ?? 'user',
  },
  ...extra,
});

test('a preference picks the nearest device and never fails; a requirement names what it could not meet', () => {
  const small = camera('small', [1280, 720], { isDefault: true });
  const big = camera('big', [3840, 2160]);
  const c = (o) => normalizeTrackConstraints('video', o);

  // the default device, at its defaults, for `true`
  assert.equal(selectDevice([big, small], c(true)).device.deviceId, 'small');
  // a preference for 4K: the big one, at exactly that
  let pick = selectDevice([small, big], c({ width: 3840 }));
  assert.equal(pick.device.deviceId, 'big');
  assert.equal(pick.settings.width, 3840);
  // a preference nobody meets is met as nearly as it can be
  pick = selectDevice([small], c({ width: 8000 }));
  assert.equal(pick.settings.width, 1280);
  // a requirement nobody meets rejects, naming it
  assert.throws(
    () => selectDevice([small, big], c({ width: { min: 5000 } })),
    (err) =>
      err instanceof OverconstrainedError &&
      err.name === 'OverconstrainedError' &&
      err.constraint === 'width',
  );
  // an exact device is that device or nothing
  assert.equal(
    selectDevice([small, big], c({ deviceId: { exact: 'big' } })).device
      .deviceId,
    'big',
  );
  assert.throws(
    () => selectDevice([small], c({ deviceId: { exact: 'gone' } })),
    (err) => err.constraint === 'deviceId',
  );
  // a bare deviceId is a preference: another device stands in for a gone one
  assert.equal(
    selectDevice([small], c({ deviceId: 'gone' })).device.deviceId,
    'small',
  );
  // a facing mode the device does not have
  const back = camera('back', [1920, 1080], { facing: 'environment' });
  assert.equal(
    selectDevice([small, back], c({ facingMode: 'environment' })).device
      .deviceId,
    'back',
  );
  assert.throws(
    () => selectDevice([small], c({ facingMode: { exact: 'environment' } })),
    (err) => err.constraint === 'facingMode',
  );
  // a value no constraint can be is a TypeError where it was written
  assert.throws(() => c({ width: '1280px' }), TypeError);
});

// --- getUserMedia ------------------------------------------------------------------

test('getUserMedia: tracks from the devices the constraints choose, labelled, with their settings', async () => {
  const app = createMockApp();
  const fake = fakeMediaDevices(app);
  const stream = await getUserMedia(
    {
      video: { width: 1280, height: 720 },
      audio: { sampleRate: 16000, channelCount: 1 },
    },
    { app },
  );
  assert.ok(stream instanceof MediaStream);
  assert.equal(stream.active, true);
  const [video] = stream.getVideoTracks();
  const [audio] = stream.getAudioTracks();
  assert.equal(video.kind, 'video');
  assert.equal(video.label, 'Fake camera');
  assert.equal(video.readyState, 'live');
  assert.deepEqual(
    [
      video.getSettings().width,
      video.getSettings().height,
      video.getSettings().deviceId,
    ],
    [1280, 720, 'fake-camera'],
  );
  assert.equal(audio.getSettings().sampleRate, 16000);
  assert.deepEqual(video.getConstraints(), { width: 1280, height: 720 });
  assert.equal(video.getCapabilities().width.max, 1920);
  assert.equal(fake.sources.length, 2);
  for (const t of stream.getTracks()) t.stop();
  assert.equal(stream.active, false);
  assert.ok(
    fake.sources.every((s) => s.stopped),
    'the last track out stops the source',
  );
});

test('one device at one setting is one session; the last track out stops it', async () => {
  const app = createMockApp();
  const fake = fakeMediaDevices(app);
  const [a, b] = await Promise.all([
    getUserMedia({ video: true }, { app }),
    getUserMedia({ video: true }, { app }),
  ]);
  assert.equal(
    fake.sources.length,
    1,
    'two requests in flight wait for one open',
  );
  const clone = a.getVideoTracks()[0].clone();
  a.getVideoTracks()[0].stop();
  b.getVideoTracks()[0].stop();
  assert.equal(fake.sources[0].stopped, false, 'the clone keeps it running');
  clone.stop();
  assert.equal(fake.sources[0].stopped, true);
  // and the next request opens it again
  const c = await getUserMedia({ video: true }, { app });
  assert.equal(fake.sources.length, 2);
  c.getVideoTracks()[0].stop();
});

test('getUserMedia rejects as a browser does', async () => {
  const app = createMockApp();
  // nothing installed: nothing can open a device
  await assert.rejects(getUserMedia({ video: true }, { app }), (err) => {
    assert.equal(err.name, 'NotFoundError');
    assert.match(err.message, /fakeMediaDevices/);
    return true;
  });
  await assert.rejects(getUserMedia({}, { app }), TypeError);

  const fake = fakeMediaDevices(app, { cameras: 0 });
  await assert.rejects(getUserMedia({ video: true }, { app }), {
    name: 'NotFoundError',
  });
  // no partial success: a camera that cannot be had takes the microphone with it
  assert.equal(fake.sources.length, 0);
  await assert.rejects(
    getUserMedia({ audio: { sampleRate: { exact: 96000 } } }, { app }),
    { name: 'OverconstrainedError', constraint: 'sampleRate' },
  );
  fake.failNextOpen = Object.assign(new Error('the camera is in use'), {
    name: 'NotReadableError',
  });
  fake.plug({
    deviceId: 'usb-camera',
    kind: 'videoinput',
    label: 'USB camera',
  });
  await assert.rejects(getUserMedia({ video: true }, { app }), (err) => {
    assert.equal(err.name, 'NotReadableError');
    assert.match(err.message, /in use/);
    return true;
  });
});

test('permission is asked just before a device opens, and a decided no never prompts', async () => {
  const app = createMockApp();
  const fake = fakeMediaDevices(app, { permission: 'denied' });
  await assert.rejects(getUserMedia({ video: true }, { app }), (err) => {
    assert.equal(err.name, 'NotAllowedError');
    assert.match(err.message, /openPrivacySettings\('camera'\)/);
    return true;
  });
  assert.deepEqual(fake.requests, [], 'denied: not asked again');
  assert.equal(fake.sources.length, 0, 'and nothing opened');

  fake.setPermission('camera', 'prompt');
  const prompted = [];
  const stream = await getUserMedia(
    { video: true },
    { app, onPrompt: (kind) => prompted.push(kind) },
  );
  assert.deepEqual(prompted, ['camera']);
  assert.deepEqual(fake.requests, ['camera']);
  stream.getTracks()[0].stop();

  // a refusal that never asked is told apart from the user saying no
  const unasked = createMockApp();
  fakeMediaDevices(unasked, { permission: 'prompt', promptAnswer: 'prompt' });
  await assert.rejects(
    getUserMedia({ audio: true }, { app: unasked }),
    (err) => {
      assert.equal(err.name, 'NotAllowedError');
      assert.match(err.message, /without the user being asked/);
      assert.match(err.message, /NSMicrophoneUsageDescription/);
      return true;
    },
  );
});

// --- tracks -------------------------------------------------------------------------

test('frames come off a track while it is wanted, enabled and not muted', async () => {
  const app = createMockApp();
  const fake = fakeMediaDevices(app);
  const stream = await getUserMedia(
    { video: { width: 64, height: 48 } },
    { app },
  );
  const [track] = stream.getVideoTracks();
  const source = fake.last('video');
  assert.equal(source.wanted, false, 'nobody reads frames: none are made');
  const frames = [];
  const off = track.onFrame((f) => frames.push(f));
  assert.equal(source.wanted, true);
  source.tick();
  assert.equal(frames.length, 1);
  const [f] = frames;
  assert.deepEqual(
    [f.format, f.width, f.height, f.strides],
    ['I420', 64, 48, [64, 32, 32]],
  );
  assert.equal(typeof f.time, 'number');
  // white bar at the left, black at the right
  assert.equal(f.planes[0][0], 235);
  assert.equal(f.planes[0][63 + 64 * 10], 16);

  track.enabled = false;
  source.tick();
  assert.equal(frames.length, 1, 'disabled: nothing');
  track.enabled = true;
  const changes = [];
  stream.onChange(() => changes.push(track.muted));
  source.mute(true);
  assert.equal(track.muted, true);
  source.tick();
  assert.equal(frames.length, 1, 'muted: nothing');
  source.mute(false);
  source.tick();
  assert.equal(frames.length, 2);
  assert.deepEqual(changes, [true, false]);

  off();
  assert.equal(source.wanted, false, 'the last reader gone: frames stop');
  track.stop();
});

test('an unplugged camera ends its tracks and says so', async () => {
  const app = createMockApp();
  const fake = fakeMediaDevices(app);
  const stream = await getUserMedia({ video: true }, { app });
  const [track] = stream.getVideoTracks();
  let told = 0;
  track.onChange(() => told++);
  fake.unplug('fake-camera');
  assert.equal(track.readyState, 'ended');
  assert.equal(stream.active, false);
  assert.equal(told, 1);
  assert.deepEqual(
    await enumerateDevices({ app }).then((d) => d.map((x) => x.kind)),
    ['audioinput', 'audiooutput'],
  );
});

test('applyConstraints moves a track to the source at the new settings, or changes nothing', async () => {
  const app = createMockApp();
  const fake = fakeMediaDevices(app);
  const stream = await getUserMedia(
    { video: { width: 640, height: 480 } },
    { app },
  );
  const [track] = stream.getVideoTracks();
  const frames = [];
  track.onFrame((f) => frames.push(f.width));
  const first = fake.last('video');
  await track.applyConstraints({ width: 320, height: 240 });
  assert.equal(
    first.stopped,
    true,
    'alone on the device: let go before reopening',
  );
  const second = fake.last('video');
  assert.notEqual(second, first);
  assert.equal(track.getSettings().width, 320);
  assert.deepEqual(track.getConstraints(), { width: 320, height: 240 });
  second.tick();
  assert.deepEqual(frames, [320], 'frames follow it');
  await assert.rejects(track.applyConstraints({ width: { exact: 5000 } }), {
    name: 'OverconstrainedError',
    constraint: 'width',
  });
  assert.equal(track.getSettings().width, 320);
  assert.equal(second.stopped, false);
  track.stop();
});

// --- hooks --------------------------------------------------------------------------

test('useUserMedia: pending, then live; denied; and the tracks stop when it unmounts', async () => {
  const app = createMockApp();
  const fake = fakeMediaDevices(app);
  const seen = [];
  let last = null;
  function Call({ video }) {
    last = useUserMedia({ video });
    seen.push(last.status);
    return null;
  }
  const { rerender, unmount } = await renderX11(
    h(Call, { video: { width: 320 } }),
    {
      app,
      backend: 'mock',
    },
  );
  await act(async () => {
    await tick();
  });
  assert.equal(last.status, 'live');
  assert.ok(seen.includes('pending'));
  assert.equal(last.stream.getVideoTracks()[0].getSettings().width, 320);
  const firstSource = fake.last('video');

  // other constraints: the old tracks stop, new ones open
  await rerender(h(Call, { video: { width: 160 } }));
  await act(async () => {
    await tick();
  });
  assert.equal(last.status, 'live');
  assert.equal(firstSource.stopped, true);
  assert.equal(last.stream.getVideoTracks()[0].getSettings().width, 160);

  // the same constraints written anew: nothing restarts
  const opened = fake.sources.length;
  await rerender(h(Call, { video: { width: 160 } }));
  await act(async () => {
    await tick();
  });
  assert.equal(fake.sources.length, opened);

  // stop() is idle, start() is live again
  await act(async () => last.stop());
  assert.equal(last.status, 'idle');
  assert.equal(last.stream, null);
  await act(async () => {
    last.start();
    await tick();
  });
  assert.equal(last.status, 'live');
  const running = fake.last('video');
  await unmount();
  assert.equal(running.stopped, true);

  // denied, as render state
  fake.setPermission('camera', 'denied');
  await renderX11(h(Call, { video: true }), { app, backend: 'mock' });
  await act(async () => {
    await tick();
  });
  assert.equal(last.status, 'denied');
  assert.equal(last.error.name, 'NotAllowedError');
});

test('useUserMedia says prompt while the system asks, and ended when the camera goes', async () => {
  const app = createMockApp();
  const fake = fakeMediaDevices(app, { permission: 'prompt' });
  const seen = [];
  let last = null;
  function Call() {
    last = useUserMedia({ video: true });
    seen.push(last.status);
    return null;
  }
  await renderX11(h(Call), { app, backend: 'mock' });
  await act(async () => {
    await tick();
    await tick();
  });
  assert.ok(seen.includes('prompt'), seen.join());
  assert.equal(last.status, 'live');
  await act(async () => fake.unplug('fake-camera'));
  assert.equal(last.status, 'ended');
});

test('useMediaDevices: empty and unsettled first, then the list, then what is plugged in', async () => {
  const app = createMockApp();
  const fake = fakeMediaDevices(app, { cameras: 2 });
  const seen = [];
  function Picker() {
    const d = useMediaDevices();
    seen.push(d);
    return null;
  }
  await renderX11(h(Picker), { app, backend: 'mock' });
  assert.equal(seen[0].settled, false);
  assert.deepEqual(seen[0].devices, []);
  await act(async () => {
    await tick();
  });
  let now = seen.at(-1);
  assert.equal(now.settled, true);
  assert.deepEqual(
    now.cameras.map((d) => [d.label, d.isDefault]),
    [
      ['Fake camera', true],
      ['Fake camera 2', false],
    ],
  );
  assert.equal(now.microphones.length, 1);
  assert.equal(now.speakers.length, 1);
  await act(async () => {
    fake.plug({ deviceId: 'usb', kind: 'videoinput', label: 'USB camera' });
    await tick();
  });
  now = seen.at(-1);
  assert.deepEqual(
    now.cameras.map((d) => d.label),
    ['Fake camera', 'Fake camera 2', 'USB camera'],
  );
});

test('useDisplayMedia waits to be asked; a picker answered with nothing is NotAllowedError', async () => {
  const app = createMockApp();
  const fake = fakeMediaDevices(app);
  let last = null;
  function Share() {
    last = useDisplayMedia({ video: { frameRate: 15 } });
    return null;
  }
  await renderX11(h(Share), { app, backend: 'mock' });
  await act(async () => {
    await tick();
  });
  assert.equal(last.status, 'idle', 'a picker nobody asked for is not opened');
  await act(async () => {
    last.start();
    await tick();
  });
  assert.equal(last.status, 'live');
  const [track] = last.stream.getVideoTracks();
  assert.equal(track.label, 'Fake screen');
  assert.equal(track.getSettings().frameRate, 15);
  assert.equal(track.getSettings().displaySurface, 'monitor');

  fake.pickerAnswer = null;
  await assert.rejects(getDisplayMedia({}, { app }), {
    name: 'NotAllowedError',
  });
});

// --- capability ------------------------------------------------------------------------

test('camera, audioInput, audioOutput and screenCapture are settled on the first frame', async () => {
  const bare = createMockApp();
  for (const name of ['camera', 'audioInput', 'audioOutput', 'screenCapture']) {
    const none = await desktopCapability(name, { app: bare });
    assert.equal(none.available, false, name);
  }
  const app = createMockApp();
  fakeMediaDevices(app);
  const camera = await desktopCapability('camera', { app });
  assert.equal(camera.available, true);
  assert.equal(camera.backend, 'fake');
  assert.equal(camera.features.labelsBeforePermission, true);

  const seen = [];
  function Probe() {
    seen.push(useDesktopCapability('screenCapture'));
    usePermission('camera');
    return null;
  }
  await renderX11(h(Probe), { app, backend: 'mock' });
  assert.equal(seen[0].settled, true);
  assert.equal(seen[0].available, true);
  assert.equal(seen[0].features.enumerate, true);
});

// --- the audio sink -------------------------------------------------------------------------

test('createAudioFrames: planar floats queued in order, on the device clock', async () => {
  const bare = createMockApp();
  assert.throws(() => createAudioFrames(bare, {}), NoAudioOutputError);

  const app = createMockApp();
  const fake = fakeMediaDevices(app);
  const sink = createAudioFrames(app, { sampleRate: 16000, channels: 1 });
  const out = fake.outputs[0];
  assert.deepEqual([out.sampleRate, out.channels], [16000, 1]);
  sink.push([Float32Array.from([0.1, 0.2, 0.3])]);
  sink.push({
    channels: [Float32Array.from([0.4, 0.5, 9])],
    frames: 2,
    sampleRate: 16000,
  });
  assert.deepEqual(
    [...out.samples()].map((v) => Math.round(v * 10) / 10),
    [0.1, 0.2, 0.3, 0.4, 0.5],
  );
  assert.equal(sink.queued, 5 / 16000);
  out.advance(3 / 16000);
  assert.equal(sink.currentTime, 3 / 16000);
  assert.equal(sink.queued, 2 / 16000);
  assert.equal(sink.latency, 0.02);
  assert.throws(
    () => sink.push([new Float32Array(4), new Float32Array(4)]),
    /1 Float32Array/,
  );
  assert.throws(
    () => sink.push({ channels: [new Float32Array(4)], sampleRate: 48000 }),
    /does not resample/,
  );
  sink.close();
  assert.equal(out.closed, true);
  sink.push([new Float32Array(4)]);
});
