// Two processes of the Cocoa backend in one test: a `<Frame>` host and its
// pane, each a real CocoaApp over a fake @windowkit/appkit, the two fakes
// sharing one table of IOSurfaces by id, as two processes share the
// kernel's. What the pane-player and pane-capture tests run on.
import assert from 'node:assert';

import { CocoaApp } from '../../src/cocoa/app.js';
import { setCompositingForTests } from '../../src/compositing.js';
import { setScaleForTests } from '../../src/scale.js';
import { setScreensForTests } from '../../src/screens.js';

const PLAYER_VERBS = new Set([
  'createPlayer',
  'playerSet',
  'playerSeek',
  'playerCopyFrame',
  'releasePlayer',
]);

const CAPTURE_VERBS = new Set([
  'captureDevices',
  'audioProcesses',
  'openCamera',
  'cameraFrames',
  'cameraCopyFrame',
  'closeCamera',
  'openMicrophone',
  'closeMicrophone',
  'openSystemAudio',
  'closeSystemAudio',
  'openAudioOutput',
  'audioOutputWrite',
  'audioOutputState',
  'closeAudioOutput',
  'screenCaptureDisplays',
  'captureScreenshot',
  'setWindowSharing',
  'openDisplayStream',
  'displayStreamFrames',
  'displayStreamCopyFrame',
  'closeDisplayStream',
]);

/**
 * The capture verbs, in the shapes @windowkit/appkit's capture.mm answers
 * in: a camera, a microphone and a speaker listed a tick later, a camera
 * and a microphone that start a tick after they open, a camera whose newest
 * frame `cameraFrame(id, w, h)` sets for `cameraCopyFrame` to
 * convert, a microphone that says what it opened, an output with a queue
 * and a clock, one display, its screenshot and its stream (`cameras` holds
 * the streams too, `display: true`). `cameras`, `microphones` and
 * `outputs` hold what is open.
 */
function captureVerbs(base) {
  let seq = 7000;
  const cameras = new Map();
  const microphones = new Map();
  const outputs = new Map();
  const later = (value, cb) => {
    if (typeof cb !== 'function') return value;
    setImmediate(() => cb(value));
    return undefined;
  };
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
  return {
    cameras,
    microphones,
    outputs,
    listed,
    captureDevices: (cb) => later(listed, cb),
    screenCaptureDisplays: (cb) =>
      later(
        [
          {
            id: 1,
            name: 'Built-in Retina Display',
            x: 0,
            y: 0,
            width: 1512,
            height: 982,
            scale: 2,
          },
        ],
        cb,
      ),
    openCamera(deviceId, opts) {
      const id = ++seq;
      cameras.set(id, { deviceId, opts, frames: false, frame: null, n: 0 });
      // the session starts on the bridge's queue, and says so
      setImmediate(() => base.emit?.({ type: 'camera-started', id }));
      return {
        id,
        layer: { layer: ++seq, props: {}, sublayers: [], parent: null },
        width: opts.width,
        height: opts.height,
        frameRate: opts.frameRate,
        format: 'NV12',
        range: 'video',
        colorSpace: 'bt709',
      };
    },
    cameraFrames(id, on) {
      const camera = cameras.get(id);
      if (camera) camera.frames = on;
    },
    /** A new frame of `width` x `height` is the newest of camera `id`. */
    cameraFrame(id, width, height) {
      const camera = cameras.get(id);
      camera.n += 1;
      camera.frame = { width, height, pixels: `camera-${camera.n}` };
    },
    cameraCopyFrame(id, target) {
      const camera = cameras.get(id);
      if (!camera?.frame) return null;
      const { width, height, pixels } = camera.frame;
      camera.frame = null;
      const written = target.width === width && target.height === height;
      if (written) target.pixels = pixels;
      return { width, height, time: camera.n / 30, written };
    },
    closeCamera(id) {
      cameras.delete(id);
    },
    openMicrophone(deviceId, opts) {
      const id = ++seq;
      microphones.set(id, { deviceId, opts });
      setImmediate(() => base.emit?.({ type: 'microphone-started', id }));
      return { id, ...opts };
    },
    closeMicrophone(id) {
      microphones.delete(id);
    },
    openAudioOutput(opts) {
      const id = ++seq;
      outputs.set(id, { opts, written: [], queued: 0, currentTime: 0 });
      return { id, latency: 0.01 };
    },
    audioOutputWrite(id, channels) {
      const out = outputs.get(id);
      out.written.push(channels.map((c) => Array.from(c)));
      out.queued += channels[0].length;
      return channels[0].length;
    },
    audioOutputState(id) {
      const out = outputs.get(id);
      return {
        currentTime: out?.currentTime ?? 0,
        queued: out?.queued ?? 0,
        latency: 0.01,
      };
    },
    closeAudioOutput(id) {
      outputs.delete(id);
    },
    captureScreenshot(ask, cb) {
      base.shots = [...(base.shots ?? []), ask];
      const data = new Uint8Array(2 * 2 * 4).fill(77);
      setImmediate(() => cb({ width: 2, height: 2, scale: 2, data }));
    },
    setWindowSharing() {},
    // a display's stream, started a tick later at the width asked (1280 x
    // 800 the display), its newest frame set by `displayFrame(id, w, h)`
    openDisplayStream(opts) {
      const id = ++seq;
      const width = opts.width ?? 1280;
      const height = Math.round((width * 800) / 1280);
      cameras.set(id, {
        opts,
        frames: false,
        frame: null,
        n: 0,
        display: true,
      });
      setImmediate(() =>
        base.emit?.({
          type: 'display-started',
          id,
          width,
          height,
          frameRate: opts.frameRate,
        }),
      );
      return {
        id,
        layer: { layer: ++seq, props: {}, sublayers: [], parent: null },
      };
    },
    displayStreamFrames(id, on) {
      const stream = cameras.get(id);
      if (stream) stream.frames = on;
    },
    displayFrame(id, width, height) {
      const stream = cameras.get(id);
      stream.n += 1;
      stream.frame = { width, height, pixels: `screen-${stream.n}` };
    },
    displayStreamCopyFrame(id, target) {
      const stream = cameras.get(id);
      if (!stream?.frame) return null;
      const { width, height, pixels } = stream.frame;
      stream.frame = null;
      const written = target.width === width && target.height === height;
      if (written) target.pixels = pixels;
      return { width, height, time: stream.n / 30, written };
    },
    closeDisplayStream(id) {
      cameras.delete(id);
    },
  };
}

/**
 * The kernel's table of IOSurfaces, which both processes make shared
 * buffers in and look them up from by id. A surface is found while
 * something holds it — the bridge that made it, or a lookup's mapping of
 * it — and with `recycleIds` a freed id goes to the next surface made, in
 * either process, the lowest first: what the system does, as measured for
 * the pane's own ring (test/cocoa-frames.test.js).
 */
export function surfaceTable({ recycleIds = false } = {}) {
  const byId = new Map();
  const freeIds = [];
  return {
    /** `surface`, made by the process `tag` names: its id. */
    add(surface, tag) {
      freeIds.sort((a, b) => a - b);
      // ids are the kernel's, so two processes' never collide
      const id =
        recycleIds && freeIds.length
          ? freeIds.shift()
          : tag * 100000 + surface.id;
      surface.iosurfaceId = id;
      surface.holds = 1;
      byId.set(id, surface);
      return id;
    },
    lookup(id) {
      const surface = byId.get(id);
      if (surface) surface.holds += 1;
      return surface;
    },
    /** One hold on `surface` let go: the last frees its id. */
    drop(surface) {
      surface.holds -= 1;
      if (surface.holds > 0) return;
      byId.delete(surface.iosurfaceId);
      freeIds.push(surface.iosurfaceId);
    },
  };
}

/** Enough of @windowkit/appkit for a window, shared surfaces and a player,
 * recording every call. `iosurfaces` is the table both processes look a
 * shared buffer up in (`surfaceTable`); a surface's `pixels` is a stand-in
 * for what is in it, and `looked` every surface a lookup found. With
 * `players: false` the bridge has none of the player verbs, and with
 * `capture: true` it has the capture verbs (`captureVerbs`). */
export function fakeBridge(
  iosurfaces,
  { players = true, capture = false, tag = 1 } = {},
) {
  const calls = [];
  let seq = 0;
  let pid = 0;
  const live = new Map();
  const surface = (width, height, scale) => ({
    id: ++seq,
    width,
    height,
    scale,
    pixels: null,
  });
  const base = {
    calls,
    live,
    looked: [],
    of: (name) => calls.filter((c) => c[0] === name).map((c) => c.slice(1)),
    setBackendEventCallback(cb) {
      base.emit = cb;
    },
    listScreens: () => [
      {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        scale: 2,
        fps: 60,
        visible: { x: 0, y: 0, width: 1440, height: 875 },
        primary: true,
      },
    ],
    createWindow2: (options) => ({ id: ++seq, options: { ...options } }),
    windowNumber: (handle) => handle.id,
    windowRootLayer: (handle) => ({ root: handle.id }),
    getWindowFrame: (handle) => ({
      x: handle.options.x ?? 0,
      y: handle.options.y ?? 0,
      width: handle.options.width,
      height: handle.options.height,
    }),
    windowIsVisible: () => true,
    createSurface: (width, height, scale) => surface(width, height, scale),
    createSurfaceIOSurface(width, height, scale, shared) {
      const handle = surface(width, height, scale);
      handle.shared = Boolean(shared);
      const iosurfaceId = iosurfaces.add(handle, tag);
      return { handle, iosurfaceId };
    },
    surfaceFromIOSurfaceID(id) {
      const handle = iosurfaces.lookup(id);
      if (!handle) throw new Error('IOSurfaceLookup: no surface with that id');
      base.looked.push(handle);
      // another mapping of the same memory
      return {
        handle: { lookedUp: id, of: handle },
        width: handle.width,
        height: handle.height,
      };
    },
    releaseSurface(handle) {
      // idempotent, as the bridge's is
      if (handle.released) return;
      handle.released = true;
      const held = handle.of ?? handle;
      if (held.iosurfaceId != null) iosurfaces.drop(held);
    },
    blitSurface(src, sx, sy, w, hh, dst) {
      dst.pixels = (src.of ?? src).pixels;
      return [0, 0, w, hh];
    },
    surfaceSize: (s) => ({ width: s.width, height: s.height, scale: s.scale }),
    createLayer: () => ({ layer: ++seq }),
  };
  if (players) {
    Object.assign(base, {
      createPlayer(url, options) {
        const id = ++pid;
        live.set(id, { url, options, frame: null, frames: 0 });
        return { id, layer: { player: id } };
      },
      playerSet() {},
      playerSeek() {},
      /** A new frame of `width` x `height` is showing in player `id`. */
      playerFrame(id, width, height) {
        const p = live.get(id);
        p.frames += 1;
        p.frame = { width, height, pixels: `frame-${p.frames}` };
      },
      playerCopyFrame(id, target) {
        const p = live.get(id);
        if (!p?.frame) return null;
        const { width, height, pixels } = p.frame;
        p.frame = null;
        const written = target.width === width && target.height === height;
        if (written) target.pixels = pixels;
        return { width, height, time: p.frames / 30, written };
      },
      releasePlayer(id) {
        live.delete(id);
      },
    });
  }
  if (capture) Object.assign(base, captureVerbs(base));
  return new Proxy(base, {
    get: (target, key) => {
      if (typeof key !== 'string' || key === 'then') return target[key];
      // a verb this bridge has not got is not there, rather than a no-op
      if (!players && PLAYER_VERBS.has(key)) return undefined;
      // and a capture verb is there only as the fake defines it: a no-op
      // `audioProcesses` would take the bridge for one with taps that never
      // answers a listing
      if (CAPTURE_VERBS.has(key) && !(capture && key in target)) {
        return undefined;
      }
      const value = key in target ? target[key] : () => undefined;
      if (typeof value !== 'function' || key === 'of' || key === 'emit') {
        return value;
      }
      return (...args) => {
        calls.push([key, ...args]);
        return value(...args);
      };
    },
  });
}

export function appOver(native, options) {
  const app = new CocoaApp(native, options);
  setScaleForTests(app, 2, 'cocoa');
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 2880, height: 1800 }],
    workArea: { x: 0, y: 0, width: 2880, height: 1750 },
  });
  setCompositingForTests(app, true);
  app._frameInterval = 0;
  app.fonts = null;
  native.setBackendEventCallback((ev) => app._route(ev));
  return app;
}

export async function settle(...apps) {
  for (let i = 0; i < 16; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    for (const app of apps) {
      app._tickFrames();
      app._presentAll();
    }
  }
}

/** Settle until `predicate` holds: the pane's first mount imports its
 * module from disk, and the host asks its player for frames on a timer. */
export async function until(
  apps,
  predicate,
  what,
  { tries = 400, delay = 2 } = {},
) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await settle(...apps);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  assert.fail(`timed out waiting for ${what}`);
}

export function find(node, test) {
  if (test(node)) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return null;
}
