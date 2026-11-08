// Media capture in a <Frame> pane on the Cocoa backend. A pane has no layers
// for a camera's preview, and an output on an engine of its own would be one
// the host's echo canceller never hears. So the host captures for it
// (`HostedCapture`,
// src/cocoa/panecapture.js): the pane's rung sends its verbs up, the host's
// tracks run them on its own pool of sources, and their news, frames,
// pictures and clocks come back down (`PaneMediaCapture`).
//
// Both ends are real CocoaApps over fake bridges that share one table of
// IOSurfaces, joined by the loopback transport, so what crosses is a
// structured clone (test/helpers/pane-bridges.js).
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { HostedCapture, PaneMediaCapture } from '../src/cocoa/panecapture.js';
import { Frame } from '../src/frame/index.js';
import { createRoot, getUserMedia } from '../src/index.js';
import { fakeMediaDevices } from '../src/testing/index.js';
import { loopbackFrameFactory } from './helpers/frame-loopback.js';
import {
  appOver,
  fakeBridge,
  find,
  settle,
  surfaceTable,
  until,
} from './helpers/pane-bridges.js';

process.env.NO_AT_BRIDGE ??= '1';

const h = React.createElement;
const PANE = new URL('./fixtures/capture-pane.js', import.meta.url);

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

/** A host window with a <Frame> showing the capture fixture, both apps
 *  running. `hostCaptures: false` gives the host a bridge with no capture
 *  verbs; `hostFake` puts `fakeMediaDevices` on the host instead. */
async function mount(
  paneProps = {},
  { hostCaptures = true, hostFake = false } = {},
) {
  const iosurfaces = surfaceTable();
  const hostNative = fakeBridge(iosurfaces, {
    players: false,
    capture: hostCaptures,
    tag: 1,
  });
  const host = appOver(hostNative);
  const fake = hostFake ? fakeMediaDevices(host) : null;
  // a pane's bridge has the verbs too: the question is whether a pane may
  const paneNative = fakeBridge(iosurfaces, {
    players: false,
    capture: true,
    tag: 2,
  });
  const pane = appOver(paneNative, { pane: true });
  const factory = loopbackFrameFactory({ childApp: pane });
  const heard = {
    capability: [],
    devices: [],
    status: [],
    frames: [],
    clocks: [],
    shots: [],
    errors: [],
  };
  let props = {
    onCapability: (v) => heard.capability.push(v),
    onDevices: (v) => heard.devices.push(v),
    onStatus: (v) => heard.status.push(v),
    onFrame: (v) => heard.frames.push(v),
    onClock: (v) => heard.clocks.push(v),
    onShot: (v) => heard.shots.push(v),
    onError: (v) => heard.errors.push(v),
    ...paneProps,
  };
  const tree = (withFrame = true) =>
    h(
      'window',
      { width: 400, height: 300 },
      withFrame
        ? h(Frame, {
            src: PANE,
            transport: factory,
            props,
            style: { width: 300, height: 200 },
          })
        : null,
    );
  const root = await createRoot({ app: host });
  roots.push(root);
  root.render(tree());
  const apps = [host, pane];
  await until(
    apps,
    () => Boolean(pane._paneWindow?._reactX11Node && pane._paneOutbox === null),
    'the pane to mount and be laid out in the host',
  );
  await settle(...apps);
  const status = () => heard.status.at(-1)?.status;
  return {
    host,
    pane,
    hostNative,
    paneNative,
    fake,
    heard,
    apps,
    status,
    video: () =>
      find(pane._paneWindow._reactX11Node, (n) => n.kind === 'video'),
    /** The host's open camera: its bridge id and record. */
    camera: () => [...hostNative.cameras].at(-1),
    microphone: () => [...hostNative.microphones].at(-1),
    rerender: async (next) => {
      props = { ...props, ...next };
      root.render(tree());
      await settle(...apps);
    },
    unmountFrame: async () => {
      root.render(tree(false));
      await settle(...apps);
    },
  };
}

/** The capture verbs a bridge was asked, by name. */
const captureCalls = (native) =>
  native.calls
    .map((c) => c[0])
    .filter((name) =>
      /^(captureDevices|openCamera|cameraFrames|cameraCopyFrame|openMicrophone|openAudioOutput|audioOutputWrite|captureScreenshot|screenCaptureDisplays)$/.test(
        name,
      ),
    );

test('a pane’s capture is its host’s: the features it offers, the devices it lists, and nothing asked of the pane’s own bridge', async () => {
  const m = await mount();
  assert.ok(m.pane.mediaCapture instanceof PaneMediaCapture);
  await until(m.apps, () => m.heard.devices.length > 0, 'the devices');
  assert.deepStrictEqual(m.heard.capability.at(-1), {
    camera: true,
    backend: 'cocoa',
    // a pane has no layer to lift a camera onto: it copies a frame
    nativePreview: false,
    audioOutput: true,
  });
  assert.deepStrictEqual(m.heard.devices.at(-1), [
    { kind: 'videoinput', label: 'FaceTime HD Camera' },
    { kind: 'audioinput', label: 'MacBook Pro Microphone' },
    { kind: 'audiooutput', label: 'MacBook Pro Speakers' },
  ]);
  assert.deepStrictEqual(captureCalls(m.paneNative), []);
  assert.ok(m.hostNative.of('captureDevices').length > 0);
});

test('a pane’s camera opens on the host and is shown in the pane through the shared ring, copied only while shown', async () => {
  const m = await mount({ video: true });
  await until(m.apps, () => m.status() === 'live', 'the camera to start');
  const [id, record] = m.camera();
  assert.strictEqual(record.deviceId, 'cam-builtin');
  // the default a browser comes to: the largest format up to 1280x720
  assert.deepStrictEqual(m.heard.status.at(-1).settings[0], {
    kind: 'video',
    width: 1280,
    height: 720,
    frameRate: 30,
    resizeMode: 'none',
    facingMode: 'user',
    aspectRatio: 1280 / 720,
    deviceId: 'cam-builtin',
  });
  await until(m.apps, () => Boolean(m.video()), 'the pane’s <video>');
  m.hostNative.cameraFrame(id, 1280, 720);
  await until(
    m.apps,
    () => m.video()?._surface?._surfaceHandle?.pixels === 'camera-1',
    'the first frame in the pane’s <video>',
  );
  // the frame crossed as a buffer the pane looked up, not as pixels
  assert.ok(m.paneNative.looked.some((s) => s.pixels === 'camera-1'));
  assert.deepStrictEqual(captureCalls(m.paneNative), []);
  m.hostNative.cameraFrame(id, 1280, 720);
  await until(
    m.apps,
    () => m.video()?._surface?._surfaceHandle?.pixels === 'camera-2',
    'the next frame',
  );

  // hidden: the host stops copying, and frees what it copied into
  await m.rerender({ show: false });
  await settle(...m.apps);
  const copies = m.hostNative.of('cameraCopyFrame').length;
  const made = m.hostNative
    .of('createSurfaceIOSurface')
    .filter(([, , , shared]) => shared).length;
  await new Promise((r) => setTimeout(r, 60));
  await settle(...m.apps);
  assert.strictEqual(m.hostNative.of('cameraCopyFrame').length, copies);
  const freed = m.hostNative
    .of('releaseSurface')
    .filter(([handle]) => handle.shared).length;
  assert.ok(freed >= made - 3, `${freed} of ${made} shared buffers freed`);
  // and the camera is still on, for the track the pane still holds
  assert.ok(m.hostNative.cameras.has(id));
});

test('frames a pane reads come down the channel, the planes as the host’s camera gave them', async () => {
  const m = await mount({ video: true, frames: true });
  await until(m.apps, () => m.status() === 'live', 'the camera to start');
  const [id] = m.camera();
  await until(
    m.apps,
    () => m.hostNative.of('cameraFrames').some(([cam, on]) => cam === id && on),
    'the host’s camera asked for frames',
  );
  const y = new Uint8Array(1280 * 720).fill(42);
  const uv = new Uint8Array(1280 * 360).fill(128);
  m.hostNative.emit({
    type: 'camera-frame',
    id,
    format: 'NV12',
    width: 1280,
    height: 720,
    planes: [y, uv],
    strides: [1280, 1280],
    time: 1,
  });
  await until(m.apps, () => m.heard.frames.length === 1, 'the frame');
  assert.deepStrictEqual(m.heard.frames[0], {
    kind: 'video',
    format: 'NV12',
    width: 1280,
    height: 720,
    first: 42,
  });
});

test('the host sends a camera’s frames to a pane two ahead of its answers, and the newest after', async () => {
  const native = fakeBridge(surfaceTable(), { players: false, capture: true });
  const app = appOver(native);
  const sent = [];
  const hosted = new HostedCapture(app, (msg) => sent.push(msg));
  const answer = (req) =>
    until([app], () => sent.some((m) => m.req === req), `answer ${req}`);
  hosted.handle({ op: 'devices', req: 1 });
  await answer(1);
  const device = sent.find((m) => m.req === 1).value[0];
  hosted.handle({
    op: 'open',
    req: 2,
    source: 'pane-source-1',
    deviceId: device.deviceId,
    settings: device.defaults,
    device,
  });
  await answer(2);
  assert.strictEqual(sent.find((m) => m.req === 2).value.picture, true);
  const [id] = [...native.cameras.keys()];
  hosted.handle({ op: 'want', source: 'pane-source-1', on: true });
  assert.deepStrictEqual(native.of('cameraFrames').at(-1), [id, true]);
  const frame = (n) =>
    native.emit({
      type: 'camera-frame',
      id,
      format: 'BGRA',
      width: 2,
      height: 1,
      planes: [new Uint8Array(8).fill(n)],
      strides: [8],
      time: n,
    });
  for (let n = 1; n <= 5; n += 1) frame(n);
  const frames = () =>
    sent
      .filter((m) => m.type === 'pane-capture-frame')
      .map((m) => m.frame.time);
  assert.deepStrictEqual(frames(), [1, 2]);
  hosted.handle({ op: 'seen', source: 'pane-source-1', seq: 1 });
  frame(6);
  frame(7);
  assert.deepStrictEqual(frames(), [1, 2, 6]);
  // let go: the camera's frames stop, and it closes with the last track
  hosted.handle({ op: 'close', source: 'pane-source-1' });
  assert.ok(!native.cameras.has(id));
  hosted.release();
});

test('a pane’s microphone opens on the host, and every chunk comes down', async () => {
  const m = await mount({ audio: true, frames: true });
  await until(m.apps, () => m.status() === 'live', 'the microphone');
  const [id, record] = m.microphone();
  assert.strictEqual(record.deviceId, 'mic-builtin');
  assert.strictEqual(record.opts.echoCancellation, true);
  for (let n = 1; n <= 4; n += 1) {
    m.hostNative.emit({
      type: 'audio-input',
      id,
      sampleRate: 48000,
      channels: [new Float32Array(480).fill(n / 10)],
      frames: 480,
      time: n / 100,
    });
  }
  await until(m.apps, () => m.heard.frames.length === 4, 'four chunks');
  assert.deepStrictEqual(
    m.heard.frames.map((f) => [f.kind, f.frames, f.sampleRate, f.first]),
    [1, 2, 3, 4].map((n) => ['audio', 480, 48000, Math.fround(n / 10)]),
  );
});

test('a pane’s sink plays on the host’s engine, and its clock runs on from the host’s word', async () => {
  const m = await mount();
  await m.rerender({ play: { n: 1, samples: [0.25, 0.5, -0.5] } });
  await until(m.apps, () => m.hostNative.outputs.size === 1, 'the output');
  const [, out] = [...m.hostNative.outputs].at(-1);
  assert.deepStrictEqual(out.opts, { sampleRate: 48000, channels: 1 });
  await until(m.apps, () => out.written.length === 1, 'the write');
  assert.deepStrictEqual(out.written[0], [[0.25, 0.5, -0.5]]);
  // pushed before the host had it: queued here all the same
  assert.strictEqual(m.heard.clocks[0].queued, 3 / 48000);
  assert.deepStrictEqual(captureCalls(m.paneNative), []);
  // the pane goes, and its output with it
  await m.unmountFrame();
  await until(m.apps, () => m.hostNative.outputs.size === 0, 'the close');
});

test('a screenshot in a pane is taken by the host', async () => {
  const m = await mount();
  await m.rerender({ shoot: 1 });
  await until(m.apps, () => m.heard.shots.length === 1, 'the screenshot');
  assert.deepStrictEqual(m.heard.shots[0], { width: 2, height: 2, first: 77 });
  assert.strictEqual(m.hostNative.shots.length, 1);
  assert.deepStrictEqual(captureCalls(m.paneNative), []);
});

test('a pane that goes leaves no camera on', async () => {
  const m = await mount({ video: true });
  await until(m.apps, () => m.status() === 'live', 'the camera to start');
  const [id] = m.camera();
  await m.unmountFrame();
  await until(m.apps, () => !m.hostNative.cameras.has(id), 'the close');
});

test('the host and a pane showing one camera share its session', async () => {
  const m = await mount({ video: true });
  await until(m.apps, () => m.status() === 'live', 'the pane’s camera');
  const stream = await getUserMedia({ video: true }, { app: m.host });
  assert.strictEqual(m.hostNative.of('openCamera').length, 1);
  stream.getTracks().forEach((t) => t.stop());
  // still on, for the pane
  assert.strictEqual(m.hostNative.cameras.size, 1);
});

test('a host that captures nothing offers nothing: in its pane a camera is unavailable', async () => {
  const m = await mount({ video: true }, { hostCaptures: false });
  assert.strictEqual(m.pane.mediaCapture, undefined);
  await until(m.apps, () => m.status() === 'unavailable', 'the refusal');
  assert.strictEqual(m.heard.capability.at(-1).camera, false);
  assert.deepStrictEqual(captureCalls(m.paneNative), []);
});

test('a host with fakeMediaDevices serves its pane: a fake camera’s frames reach a reader there', async () => {
  const m = await mount({ video: true, frames: true }, { hostFake: true });
  await until(m.apps, () => m.status() === 'live', 'the fake camera');
  await until(m.apps, () => m.heard.frames.length > 0, 'a frame');
  assert.strictEqual(m.heard.frames[0].kind, 'video');
  assert.strictEqual(m.fake.live().length, 1);
});
