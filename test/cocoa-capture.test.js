// Media capture on macOS (src/cocoa/capture.js) over the fake bridge, with
// the capture verbs the bridge's release C is to ship: devices translated
// into the web's shape, a camera opened at the settings the constraints
// chose and answered by the bridge's `camera-started`, a `<video srcObject>`
// that lifts the camera's own layer without a frame crossing into
// JavaScript, frames on request, a microphone's chunks, the audio out and a
// screenshot — and a bridge without the verbs that answers unavailable.
// Other applications' sound over the process taps of appkit 0.32: the
// processes the bridge lists as the sources a person would pick, opened as a
// microphone is, and a bridge from before them that lists none. A display or
// a window as ScreenCaptureKit's stream over appkit 0.33's verbs: shown on
// its own layer, frames on request, changed without stopping, muted while
// minimized, paired with the taps' sound — and a bridge from before them
// that streams nothing.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import {
  captureScreenshot,
  createAudioFrames,
  desktopCapability,
  displaySources,
  enumerateDevices,
  getDisplayMedia,
  getUserMedia,
  NoPermissionServiceError,
  permissionStatus,
  requestPermission,
} from '../src/index.js';
import { createRoot } from '../src/index.js';
import { liveApps } from '../src/trace-registry.js';
import {
  cleanupCocoa,
  fakeCocoaApp,
  fakeCocoaBridge,
  mountCocoa,
  tick,
} from './helpers/cocoa-bridge.js';

const h = React.createElement;

afterEach(async () => {
  // a source a test left open holds the process, as it would a script's
  for (const app of liveApps()) app.mediaCapture?.close?.();
  await cleanupCocoa();
});

/** What the bridge's `audioProcesses` answers on a desk with a browser
 *  playing through a helper, a daemon that never plays, a tool playing and
 *  this process: in systemaudio.mm's shapes. */
const PROCESSES = [
  { pid: process.pid, bundleId: '', name: 'node', playing: false },
  {
    pid: 501,
    bundleId: 'com.google.Chrome',
    name: 'Google Chrome',
    playing: false,
    app: {
      bundleId: 'com.google.Chrome',
      name: 'Google Chrome',
      regular: true,
    },
  },
  {
    pid: 502,
    bundleId: 'com.google.Chrome.helper',
    name: 'Google Chrome Helper',
    playing: true,
    app: {
      bundleId: 'com.google.Chrome',
      name: 'Google Chrome',
      regular: true,
    },
  },
  {
    pid: 503,
    bundleId: 'com.tinyspeck.slackmacgap',
    name: 'Slack',
    playing: false,
    app: {
      bundleId: 'com.tinyspeck.slackmacgap',
      name: 'Slack',
      regular: true,
    },
  },
  {
    pid: 600,
    bundleId: 'com.apple.loginwindow',
    name: 'loginwindow',
    playing: false,
    app: {
      bundleId: 'com.apple.loginwindow',
      name: 'loginwindow',
      regular: false,
    },
  },
  {
    pid: 601,
    bundleId: 'com.apple.mediaremoted',
    name: 'mediaremoted',
    playing: false,
  },
  { pid: 700, bundleId: '', name: 'afplay', playing: true },
];

/** The fake bridge with the capture verbs, recording as the rest do, in
 *  the shapes @windowkit/appkit's capture.mm answers in. */
function captureBridge({ processes = PROCESSES } = {}) {
  const native = fakeCocoaBridge();
  let seq = 5000;
  const cameras = new Map();
  const streams = new Map();
  const taps = new Map();
  const listed = [
    {
      id: 'cam-builtin',
      kind: 'camera',
      name: 'FaceTime HD Camera',
      isDefault: true,
      position: 'front',
      formats: [
        { width: 640, height: 480, minFrameRate: 1, maxFrameRate: 30 },
        { width: 1280, height: 720, minFrameRate: 1, maxFrameRate: 30 },
        { width: 1920, height: 1080, minFrameRate: 1, maxFrameRate: 30 },
      ],
    },
    {
      id: 'mic-builtin',
      kind: 'microphone',
      name: 'MacBook Pro Microphone',
      isDefault: true,
    },
    {
      id: 'spk-builtin',
      kind: 'speaker',
      name: 'MacBook Pro Speakers',
      isDefault: true,
    },
  ];
  const displays = [
    {
      id: 1,
      name: 'Built-in Retina Display',
      x: 0,
      y: 0,
      width: 1512,
      height: 982,
      scale: 2,
    },
  ];
  // listed through a callback, a tick later, where one is given — as the
  // bridge does, its first listing loading AVFoundation's plug-ins
  const later = (list, cb) => {
    if (typeof cb !== 'function') return list;
    setImmediate(() => cb(list));
    return undefined;
  };
  Object.assign(native, {
    captureDevices: (cb) => later(listed, cb),
    audioProcesses: (cb) => later(processes, cb),
    screenCaptureDisplays: (cb) => later(displays, cb),
    openCamera(deviceId, opts) {
      const id = ++seq;
      const layer = { layer: ++seq, props: {}, sublayers: [], parent: null };
      cameras.set(id, { deviceId, opts, layer, fresh: false });
      return {
        id,
        layer,
        width: opts.width,
        height: opts.height,
        frameRate: opts.frameRate,
        format: 'NV12',
        range: 'video',
        colorSpace: 'bt709',
      };
    },
    cameraFrames() {},
    cameraCopyFrame: () => null,
    closeCamera(id) {
      cameras.delete(id);
    },
    // what was asked; `microphone-started` says what the engine did
    openMicrophone: (deviceId, opts) => ({ id: ++seq, ...opts }),
    closeMicrophone() {},
    // what was asked; `system-audio-started` says the tap is running
    openSystemAudio(opts) {
      const id = ++seq;
      taps.set(id, opts);
      return {
        id,
        sampleRate: opts.sampleRate ?? 48000,
        channels: opts.channels ?? 2,
      };
    },
    closeSystemAudio() {},
    openAudioOutput: (opts) => ({ id: ++seq, ...opts, latency: 0 }),
    audioOutputWrite: (id, channels) => channels[0].length,
    audioOutputState: () => ({ currentTime: 0.5, queued: 480, latency: 0.012 }),
    closeAudioOutput() {},
    // one answer: a picture, or `{ error, name }`
    captureScreenshot(ask, cb) {
      if (ask.display === 99) {
        cb({ error: 'Screen Recording is off', name: 'NotAllowedError' });
        return;
      }
      const data = new Uint8Array(4 * 4 * 4).fill(200);
      setImmediate(() => cb({ width: 4, height: 4, scale: 2, data }));
    },
    setWindowSharing() {},
    screenCaptureWindows: (cb) =>
      later(
        [
          {
            id: 42,
            title: 'Quarterly plan',
            app: {
              name: 'Keynote',
              bundleId: 'com.apple.iWork.Keynote',
              pid: 900,
            },
            x: 100,
            y: 50,
            width: 800,
            height: 600,
            active: true,
          },
        ],
        cb,
      ),
    // what was asked; `display-started` says the size the frames come at
    openDisplayStream(opts) {
      const id = ++seq;
      const layer = { layer: ++seq, props: {}, sublayers: [], parent: null };
      streams.set(id, { opts, layer });
      return { id, layer };
    },
    displayStreamFrames() {},
    displayStreamCopyFrame: () => null,
    displayStreamConfigure() {},
    closeDisplayStream(id) {
      streams.delete(id);
    },
  });
  native.cameras = cameras;
  native.streams = streams;
  native.taps = taps;
  return native;
}

/** The display-stream verbs, which a bridge before 0.33 has not got. */
const STREAM_VERBS = [
  'screenCaptureWindows',
  'openDisplayStream',
  'displayStreamFrames',
  'displayStreamCopyFrame',
  'displayStreamConfigure',
  'closeDisplayStream',
];

/** The id the newest `openCamera` answered. */
const lastCamera = (native) => [...native.cameras.keys()].at(-1) ?? null;

test('devices: the bridge’s list in the web’s shape, before any permission', async () => {
  const native = captureBridge();
  const { app } = await mountCocoa(null, { native });
  const devices = await enumerateDevices({ app });
  assert.deepEqual(
    devices.map((d) => [d.kind, d.label, d.isDefault]),
    [
      ['videoinput', 'FaceTime HD Camera', true],
      ['audioinput', 'MacBook Pro Microphone', true],
      ['audiooutput', 'MacBook Pro Speakers', true],
      ['systemaudio', 'System audio', true],
      ['systemaudio', 'Google Chrome', false],
      ['systemaudio', 'Slack', false],
      ['systemaudio', 'afplay', false],
    ],
  );
  const [camera] = devices;
  assert.deepEqual(camera.capabilities.width, { min: 640, max: 1920 });
  assert.deepEqual(camera.capabilities.facingMode, ['user']);
  const cap = await desktopCapability('camera', { app });
  assert.equal(cap.available, true);
  assert.equal(cap.backend, 'cocoa');
  assert.equal(cap.features.nativePreview, true);

  // a device plugged in: watchers are told
  let told = 0;
  const off = app.mediaCapture.watch(() => told++);
  native.emit({ type: 'capture-devices' });
  assert.equal(told, 1);
  off();
});

test('a camera opens at the chosen settings, once the bridge says it started', async () => {
  const native = captureBridge();
  const { app } = await mountCocoa(null, { native });
  let settled = false;
  const pending = getUserMedia({ video: true }, { app }).then((s) => {
    settled = true;
    return s;
  });
  await tick();
  await tick();
  const [[deviceId, opts]] = native.of('openCamera');
  assert.equal(deviceId, 'cam-builtin');
  // the browser's default on this camera: the largest format within 720p
  assert.deepEqual(opts, { width: 1280, height: 720, frameRate: 30 });
  assert.equal(settled, false, 'not before the session is running');
  const id = lastCamera(native);
  native.emit({ type: 'camera-started', id });
  const stream = await pending;
  const [track] = stream.getVideoTracks();
  assert.equal(track.label, 'FaceTime HD Camera');
  assert.equal(track.getSettings().width, 1280);
  assert.equal(track.getSettings().facingMode, 'user');

  // frames reach JavaScript only on request, and stop with the last reader
  const frames = [];
  const off = track.onFrame((f) => frames.push(f));
  assert.deepEqual(native.of('cameraFrames').at(-1), [id, true]);
  const planes = [Buffer.alloc(16), Buffer.alloc(8)];
  native.emit({
    type: 'camera-frame',
    id,
    width: 4,
    height: 4,
    format: 'NV12',
    planes,
    strides: [4, 4],
    time: 1.5,
  });
  assert.equal(frames.length, 1);
  assert.deepEqual(
    [frames[0].format, frames[0].colorSpace, frames[0].range, frames[0].time],
    ['NV12', 'bt709', 'video', 1.5],
  );
  off();
  assert.deepEqual(native.of('cameraFrames').at(-1), [id, false]);

  // another app takes it: muted; given back: not
  native.emit({ type: 'camera-muted', id, muted: true });
  assert.equal(track.muted, true);
  native.emit({ type: 'camera-muted', id, muted: false });
  // unplugged: ended
  native.emit({ type: 'camera-ended', id });
  assert.equal(track.readyState, 'ended');
});

test('a camera that will not start rejects with the name the bridge gave', async () => {
  const native = captureBridge();
  const { app } = await mountCocoa(null, { native });
  const pending = getUserMedia({ video: true }, { app });
  await tick();
  await tick();
  native.emit({
    type: 'camera-error',
    id: lastCamera(native),
    name: 'NotReadableError',
    message: 'the camera is in use by another application',
  });
  await assert.rejects(pending, (err) => {
    assert.equal(err.name, 'NotReadableError');
    assert.match(err.message, /FaceTime HD Camera: the camera is in use/);
    return true;
  });
});

test('<video srcObject> lifts the camera’s own layer, and reads no frames', async () => {
  const native = captureBridge();
  const { app, frame, render, promotion } = await mountCocoa(null, { native });
  const pending = getUserMedia({ video: true }, { app });
  await tick();
  await tick();
  const id = lastCamera(native);
  native.emit({ type: 'camera-started', id });
  const stream = await pending;
  await render(
    h('video', {
      srcObject: stream,
      style: {
        position: 'absolute',
        left: 10,
        top: 10,
        width: 160,
        height: 90,
      },
    }),
  );
  await tick();
  frame();
  frame();
  const host = [...promotion.sprites.hosts.values()][0];
  const state = host && [...host.values()][0];
  assert.ok(state, 'lifted');
  const camera = native.cameras.get(id);
  assert.equal(
    camera.layer.parent,
    state.layer,
    'the camera’s layer, in the part',
  );
  assert.deepEqual(
    native.of('cameraFrames'),
    [],
    'not a frame crossed into JavaScript',
  );
  stream.getVideoTracks()[0].stop();
  assert.ok(native.of('closeCamera').some(([closed]) => closed === id));
});

test('a microphone at the rate asked, an output on the same engine, a screenshot', async () => {
  const native = captureBridge();
  const { app } = await mountCocoa(null, { native });
  const pending = getUserMedia(
    { audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true } },
    { app },
  );
  await tick();
  await tick();
  const [[deviceId, opts]] = native.of('openMicrophone');
  assert.equal(deviceId, 'mic-builtin');
  assert.deepEqual(opts, {
    sampleRate: 16000,
    channels: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
  const micId = [...app.mediaCapture._sources.keys()].at(-1);
  // voice processing did not engage: the settings say so, as a browser's do
  native.emit({
    type: 'microphone-started',
    id: micId,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    latency: 0.004,
  });
  const stream = await pending;
  const [track] = stream.getAudioTracks();
  assert.equal(track.getSettings().echoCancellation, false);
  assert.equal(track.getSettings().latency, 0.004);
  const chunks = [];
  track.onFrame((d) => chunks.push(d));
  native.emit({
    type: 'audio-input',
    id: micId,
    sampleRate: 16000,
    channels: [new Float32Array(160)],
    frames: 160,
    time: 0,
  });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].frames, 160);
  track.stop();

  const sink = createAudioFrames(app, { sampleRate: 48000, channels: 1 });
  sink.push([new Float32Array(480)]);
  assert.equal(native.of('audioOutputWrite').length, 1);
  assert.equal(sink.currentTime, 0.5);
  assert.equal(sink.queued, 0.01);
  assert.equal(sink.latency, 0.012);
  sink.close();
  assert.equal(native.of('closeAudioOutput').length, 1);

  const shot = await captureScreenshot({ app, source: 'display:1' });
  assert.deepEqual([shot.width, shot.height], [4, 4]);
  assert.equal(native.of('captureScreenshot')[0][0].display, 1);
  // a region in the display's pixels is the bridge's rect in points
  await captureScreenshot({
    app,
    source: 'display:1',
    region: { x: 20, y: 10, width: 40, height: 20 },
  });
  assert.deepEqual(native.of('captureScreenshot')[1][0].rect, {
    x: 10,
    y: 5,
    width: 20,
    height: 10,
  });
  await assert.rejects(captureScreenshot({ app, source: 'display:99' }), {
    name: 'NotAllowedError',
  });
});

test('other applications’ sound: the processes as sources a person picks, each opened as a microphone is', async () => {
  const native = captureBridge();
  const { app } = await mountCocoa(null, { native });
  const sources = (await enumerateDevices({ app })).filter(
    (d) => d.kind === 'systemaudio',
  );
  // everything first; an application once, its helpers under it and playing
  // through them; a daemon that never plays, never; a tool while it plays;
  // and not this process
  assert.deepEqual(
    sources.map((d) => [d.deviceId, d.label, d.appId, d.playing]),
    [
      ['system-audio', 'System audio', undefined, true],
      [
        'system-audio:com.google.Chrome',
        'Google Chrome',
        'com.google.Chrome',
        true,
      ],
      [
        'system-audio:com.tinyspeck.slackmacgap',
        'Slack',
        'com.tinyspeck.slackmacgap',
        false,
      ],
      ['system-audio:pid:700', 'afplay', undefined, true],
    ],
  );
  assert.deepEqual(sources[0].capabilities.channelCount, { min: 1, max: 2 });
  const cap = await desktopCapability('systemAudio', { app });
  assert.equal(cap.available, true);
  assert.equal(cap.backend, 'cocoa');
  assert.equal(cap.features.applications, true);
  assert.equal(cap.features.excludesSelf, true);
  // a stream of the screen comes with it, through getDisplayMedia's pairing
  const screen = await desktopCapability('screenCapture', { app });
  assert.equal(screen.features.systemAudio, true);

  // one application, at the rate a speech model wants
  const pending = getUserMedia(
    {
      audio: {
        deviceId: 'system-audio:com.google.Chrome',
        sampleRate: 16000,
        channelCount: 1,
      },
    },
    { app },
  );
  await tick();
  await tick();
  assert.deepEqual(native.of('openSystemAudio').at(-1), [
    { bundleId: 'com.google.Chrome', sampleRate: 16000, channels: 1 },
  ]);
  assert.deepEqual(native.of('openMicrophone'), [], 'never a microphone');
  const id = [...app.mediaCapture._sources.keys()].at(-1);
  native.emit({ type: 'system-audio-started', id, latency: 0.011 });
  const stream = await pending;
  const [track] = stream.getAudioTracks();
  assert.equal(track.label, 'Google Chrome');
  assert.deepEqual(track.getSettings(), {
    sampleRate: 16000,
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    latency: 0.011,
    deviceId: 'system-audio:com.google.Chrome',
  });
  const chunks = [];
  track.onFrame((d) => chunks.push(d));
  native.emit({
    type: 'audio-input',
    id,
    sampleRate: 16000,
    channels: [new Float32Array(160)],
    frames: 160,
    time: 0.01,
  });
  assert.deepEqual(
    chunks.map((c) => [c.frames, c.time]),
    [[160, 0.01]],
  );
  track.stop();
  assert.deepEqual(native.of('closeSystemAudio').at(-1), [id]);

  // everything, at its defaults; a tool by its pid; an application that is
  // not running, by its id, which the tap waits for
  for (const [deviceId, target] of [
    ['system-audio', {}],
    ['system-audio:pid:700', { pid: 700 }],
    ['system-audio:us.zoom.xos', { bundleId: 'us.zoom.xos' }],
  ]) {
    const opening = getUserMedia({ audio: { deviceId } }, { app });
    await tick();
    await tick();
    assert.deepEqual(native.of('openSystemAudio').at(-1), [
      { ...target, sampleRate: 48000, channels: 2 },
    ]);
    const tap = [...app.mediaCapture._sources.keys()].at(-1);
    native.emit({ type: 'system-audio-started', id: tap });
    const [t] = (await opening).getAudioTracks();
    // the process tapped quit: its track ends
    native.emit({ type: 'system-audio-ended', id: tap });
    assert.equal(t.readyState, 'ended', deviceId);
  }

  // refused by the system, by name
  const refused = getUserMedia(
    { audio: { deviceId: 'system-audio' } },
    { app },
  );
  await tick();
  await tick();
  native.emit({
    type: 'system-audio-error',
    id: [...app.mediaCapture._sources.keys()].at(-1),
    name: 'NotAllowedError',
    message: 'System Audio Recording is not allowed for this app',
  });
  await assert.rejects(refused, { name: 'NotAllowedError' });

  // an application starting to play: watchers are told
  let told = 0;
  const off = app.mediaCapture.watch(() => told++);
  native.emit({ type: 'audio-processes' });
  assert.equal(told, 1);
  off();
});

test('a bridge from before the process taps lists no sound of other applications, and has no permission to ask', async () => {
  const native = captureBridge();
  const missing = ['audioProcesses', 'openSystemAudio', 'closeSystemAudio'];
  const older = new Proxy(native, {
    get: (target, name) => (missing.includes(name) ? undefined : target[name]),
  });
  const { app } = await mountCocoa(null, { native: older });
  const devices = await enumerateDevices({ app });
  assert.deepEqual(
    devices.filter((d) => d.kind === 'systemaudio'),
    [],
  );
  assert.equal(
    (await desktopCapability('systemAudio', { app })).available,
    false,
  );
  await assert.rejects(
    getUserMedia({ audio: { deviceId: 'system-audio' } }, { app }),
    (err) => {
      assert.equal(err.name, 'NotFoundError');
      assert.match(err.message, /macOS 14\.2 and @windowkit\/appkit 0\.32/);
      return true;
    },
  );
  assert.deepEqual(native.of('openMicrophone'), [], 'no microphone stands in');
  // the kind is unknown to such a bridge: asked of it, it would throw
  assert.equal(
    await permissionStatus('system-audio-recording', { app }),
    'unknown',
  );
  await assert.rejects(
    requestPermission('system-audio-recording', { app }),
    NoPermissionServiceError,
  );
  assert.ok(
    !native
      .of('authorizationStatus')
      .some(([kind]) => kind === 'system-audio-recording'),
    'never asked of the bridge',
  );
  // and the rung leaves its Settings pane to the deep link, which
  // openPrivacySettings opens with `open` (not run here: it would put System
  // Settings on the screen)
  assert.equal(app.permissions.openSettings('system-audio-recording'), null);
  assert.deepEqual(native.of('openPrivacySettings'), []);
});

/** The id the newest `openDisplayStream` answered. */
const lastStream = (native) => [...native.streams.keys()].at(-1) ?? null;

/** `getDisplayMedia(request)`, answered by the bridge's `display-started` at
 *  `width` x `height`. */
async function shareScreen(native, app, request = {}, size = [3024, 1964]) {
  const pending = getDisplayMedia(request, { app });
  for (let i = 0; i < 4 && lastStream(native) === null; i++) await tick();
  const id = lastStream(native);
  native.emit({
    type: 'display-started',
    id,
    width: size[0],
    height: size[1],
    frameRate: native.streams.get(id).opts.frameRate,
  });
  return { stream: await pending, id };
}

test('getDisplayMedia streams the main display through ScreenCaptureKit, at the size the bridge started it', async () => {
  const native = captureBridge();
  const { app } = await mountCocoa(null, { native });
  const cap = await desktopCapability('screenCapture', { app });
  assert.equal(cap.features.streams, true);
  assert.equal(cap.features.windows, true);
  // the taps' sound comes with a stream
  assert.equal(cap.features.systemAudio, true);

  const { stream, id } = await shareScreen(native, app);
  assert.deepEqual(native.streams.get(id).opts, {
    frameRate: 30,
    cursor: true,
  });
  const [track] = stream.getVideoTracks();
  assert.equal(track.label, 'Built-in Retina Display');
  assert.equal(track.readyState, 'live');
  assert.deepEqual(track.getSettings(), {
    width: 3024,
    height: 1964,
    frameRate: 30,
    displaySurface: 'monitor',
    cursor: 'always',
    resizeMode: 'crop-and-scale',
    aspectRatio: 3024 / 1964,
  });
  assert.equal(stream.getAudioTracks().length, 0, 'no sound asked, none');

  // frames on request: BGRA, the bridge's planes
  const frames = [];
  const off = track.onFrame((f) => frames.push(f));
  assert.deepEqual(native.of('displayStreamFrames').at(-1), [id, true]);
  const plane = new Uint8Array(4 * 4 * 2);
  native.emit({
    type: 'display-frame',
    id,
    width: 4,
    height: 2,
    format: 'BGRA',
    planes: [plane],
    strides: [16],
    time: 1.5,
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].format, 'BGRA');
  assert.equal(frames[0].planes[0], plane);
  off();
  assert.deepEqual(native.of('displayStreamFrames').at(-1), [id, false]);

  // the window minimized mutes it; the window back, it is live again
  native.emit({ type: 'display-muted', id, muted: true });
  assert.equal(track.muted, true);
  native.emit({ type: 'display-muted', id, muted: false });
  assert.equal(track.muted, false);

  // live, it holds the process open — a script with no window awaits it —
  // and stopped, it does not
  assert.ok(app.mediaCapture._keepAlive !== null);
  track.stop();
  assert.ok(native.of('closeDisplayStream').some(([closed]) => closed === id));
  assert.equal(app.mediaCapture._keepAlive, null);
});

test('<video srcObject> of a screen lifts the stream’s own layer, and reads no frames', async () => {
  const native = captureBridge();
  const { app, frame, render, promotion } = await mountCocoa(null, { native });
  const { stream, id } = await shareScreen(native, app, {}, [1600, 1000]);
  await render(
    h('video', {
      srcObject: stream,
      style: {
        position: 'absolute',
        left: 10,
        top: 10,
        width: 160,
        height: 100,
      },
    }),
  );
  await tick();
  frame();
  frame();
  const host = [...promotion.sprites.hosts.values()][0];
  const state = host && [...host.values()][0];
  assert.ok(state, 'lifted');
  assert.equal(native.streams.get(id).layer.parent, state.layer);
  assert.deepEqual(native.of('displayStreamFrames'), [], 'no frame crossed');
  stream.getVideoTracks()[0].stop();
});

test('a window by its source id, at the size and rate asked, changed without stopping, ended when it closes', async () => {
  const native = captureBridge();
  const { app } = await mountCocoa(null, { native });
  const sources = await displaySources({ app });
  const win = sources.find((one) => one.kind === 'window');
  assert.deepEqual(win, {
    id: 'window:42',
    kind: 'window',
    name: 'Keynote — Quarterly plan',
    title: 'Quarterly plan',
    appId: 'com.apple.iWork.Keynote',
    pid: 900,
    // this app's pixels, as a region is read
    x: 200,
    y: 100,
    width: 1600,
    height: 1200,
  });
  const { stream, id } = await shareScreen(
    native,
    app,
    {
      source: win.id,
      video: { width: 1280, frameRate: { ideal: 15 }, cursor: 'never' },
    },
    [1280, 960],
  );
  assert.deepEqual(native.streams.get(id).opts, {
    window: 42,
    width: 1280,
    frameRate: 15,
    cursor: false,
  });
  const [track] = stream.getVideoTracks();
  assert.equal(track.label, 'Quarterly plan');
  assert.equal(track.getSettings().displaySurface, 'window');

  // applyConstraints: the bridge configures the running stream
  const applied = track.applyConstraints({ frameRate: 5 });
  await tick();
  assert.deepEqual(native.of('displayStreamConfigure').at(-1), [
    id,
    { frameRate: 5 },
  ]);
  native.emit({
    type: 'display-configured',
    id,
    width: 1280,
    height: 960,
    frameRate: 5,
  });
  await applied;
  assert.equal(track.getSettings().frameRate, 5);
  // one the bridge refuses is OverconstrainedError, and nothing changed
  const refused = track.applyConstraints({ frameRate: 500 });
  await tick();
  native.emit({
    type: 'display-configured',
    id,
    error: 'no',
    name: 'NotReadableError',
  });
  await assert.rejects(refused, { name: 'OverconstrainedError' });
  assert.equal(track.getSettings().frameRate, 5);

  // the window closed: the track ends, of its own accord
  let changed = 0;
  track.onChange(() => changed++);
  native.emit({ type: 'display-ended', id });
  assert.equal(track.readyState, 'ended');
  assert.ok(changed > 0);
});

test('a stream the bridge refused rejects with its name; one with sound asked is paired with the taps', async () => {
  const native = captureBridge();
  const { app } = await mountCocoa(null, { native });
  const pending = getDisplayMedia({}, { app });
  for (let i = 0; i < 4 && lastStream(native) === null; i++) await tick();
  native.emit({
    type: 'display-error',
    id: lastStream(native),
    name: 'NotAllowedError',
    message: 'Screen Recording is not allowed for this app',
  });
  await assert.rejects(pending, { name: 'NotAllowedError' });

  const sharing = getDisplayMedia({ audio: 'system' }, { app });
  for (let i = 0; i < 6; i++) await tick();
  const id = lastStream(native);
  native.emit({ type: 'display-started', id, width: 640, height: 400 });
  // the sound: a tap of everything but this app, opened as a microphone is
  for (let i = 0; i < 8 && native.taps.size === 0; i++) await tick();
  assert.equal(native.taps.size, 1);
  const [[tapId, ask]] = [...native.taps];
  assert.equal(ask.bundleId, undefined, 'every application');
  assert.equal(ask.pid, undefined);
  native.emit({ type: 'system-audio-started', id: tapId });
  const stream = await sharing;
  assert.equal(stream.getVideoTracks().length, 1);
  assert.equal(stream.getAudioTracks().length, 1);
  assert.equal(stream.getAudioTracks()[0].label, 'System audio');
});

test('a bridge from before display streams shares no screen, and says so', async () => {
  const native = captureBridge();
  const before = new Proxy(native, {
    get: (target, name) =>
      STREAM_VERBS.includes(name) ? undefined : target[name],
  });
  const { app } = await mountCocoa(null, { native: before });
  const cap = await desktopCapability('screenCapture', { app });
  assert.equal(cap.available, true, 'screenshots still');
  assert.equal(cap.features.streams, false);
  assert.equal(cap.features.windows, false);
  assert.equal(cap.features.systemAudio, false, 'no stream to pair sound with');
  await assert.rejects(getDisplayMedia({}, { app }), {
    name: 'NotSupportedError',
  });
  assert.ok(!(await displaySources({ app })).some((s) => s.kind === 'window'));
});

test('a bridge without the capture verbs answers unavailable', async () => {
  const native = fakeCocoaBridge();
  // the fake answers every name; this one is a bridge from before release C
  const bare = new Proxy(native, {
    get: (target, name) =>
      [
        'captureDevices',
        'openCamera',
        'openMicrophone',
        'openAudioOutput',
        'captureScreenshot',
      ].includes(name)
        ? undefined
        : target[name],
  });
  const { app } = await mountCocoa(null, { native: bare });
  assert.equal(app.mediaCapture, undefined);
  for (const name of ['camera', 'audioInput', 'audioOutput', 'screenCapture']) {
    assert.equal(
      (await desktopCapability(name, { app })).available,
      false,
      name,
    );
  }
  await assert.rejects(getUserMedia({ video: true }, { app }), {
    name: 'NotFoundError',
  });
});

test('<window excludeFromCapture> keeps the window out of captures, and lets it back', async () => {
  const native = captureBridge();
  const { app } = fakeCocoaApp({}, { native });
  const root = await createRoot({ app });
  const win = (exclude) =>
    h('window', { width: 120, height: 80, excludeFromCapture: exclude });
  root.render(win(true));
  await tick();
  const handle = [...app._windows.values()][0]._h;
  assert.deepEqual(
    native.of('setWindowSharing'),
    [[handle, 'none']],
    'from before it is first shown',
  );
  root.render(win(false));
  await tick();
  assert.deepEqual(native.of('setWindowSharing').at(-1), [handle, 'readOnly']);
  root.render(win(false));
  await tick();
  assert.equal(
    native.of('setWindowSharing').length,
    2,
    'asked again only when it changes',
  );
  const cap = await desktopCapability('screenCapture', { app });
  assert.equal(cap.features.excludeWindows, true);
  assert.equal(cap.features.screenshot, true);
  assert.equal(cap.features.streams, true);
  await root.unmount();
});
