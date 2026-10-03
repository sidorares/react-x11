// `<video src>` in a <Frame> pane on the Cocoa backend. A pane process runs
// no AppKit, so a player it made would never hear AVFoundation: the host
// plays for it (`HostedPlayer`, src/cocoa/paneplayer.js), sends its events
// down, and copies its frames into shared buffers the pane copies out of
// (`PanePlayer`).
//
// Both ends are real CocoaApps — the host over one fake bridge, the pane in
// pane mode over another — joined by the loopback transport the frame tests
// run panes through, so what crosses is a structured clone, as over the
// fork. The two fakes share one table of IOSurfaces, by id, as two
// processes share the kernel's.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { CocoaApp } from '../src/cocoa/app.js';
import { setCompositingForTests } from '../src/compositing.js';
import { Frame } from '../src/frame/index.js';
import { createRoot } from '../src/index.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';
import { loopbackFrameFactory } from './helpers/frame-loopback.js';

process.env.NO_AT_BRIDGE ??= '1';

const h = React.createElement;
const PANE = new URL('./fixtures/video-pane.js', import.meta.url);
const CLIP = '/tmp/clip.mp4';

const PLAYER_VERBS = new Set([
  'createPlayer',
  'playerSet',
  'playerSeek',
  'playerCopyFrame',
  'releasePlayer',
]);

/** Enough of @windowkit/appkit for a window, shared surfaces and a player,
 * recording every call. `iosurfaces` is the table both processes look a
 * shared buffer up in; a surface's `pixels` is a stand-in for what is in
 * it. With `players: false` the bridge has none of the player verbs. */
function fakeBridge(iosurfaces, { players = true, tag = 1 } = {}) {
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
      // ids are the kernel's, so two processes' never collide
      const iosurfaceId = tag * 100000 + handle.id;
      iosurfaces.set(iosurfaceId, handle);
      return { handle, iosurfaceId };
    },
    surfaceFromIOSurfaceID(id) {
      const handle = iosurfaces.get(id);
      if (!handle) throw new Error('IOSurfaceLookup: no surface with that id');
      // another mapping of the same memory
      return {
        handle: { lookedUp: id, of: handle },
        width: handle.width,
        height: handle.height,
      };
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
  return new Proxy(base, {
    get: (target, key) => {
      if (typeof key !== 'string' || key === 'then') return target[key];
      // a verb this bridge has not got is not there, rather than a no-op
      if (!players && PLAYER_VERBS.has(key)) return undefined;
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

function appOver(native, options) {
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

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

async function settle(...apps) {
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
async function until(apps, predicate, what, { tries = 400, delay = 2 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await settle(...apps);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function find(node, test) {
  if (test(node)) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return null;
}

/** A host window with a <Frame> showing the fixture, both apps running. */
async function mount(paneProps = {}, { hostPlays = true } = {}) {
  const iosurfaces = new Map();
  const hostNative = fakeBridge(iosurfaces, { players: hostPlays, tag: 1 });
  const host = appOver(hostNative);
  // a pane's bridge has the verbs too: the question is whether a pane may
  const paneNative = fakeBridge(iosurfaces, { players: true, tag: 2 });
  const pane = appOver(paneNative, { pane: true });
  const factory = loopbackFrameFactory({ childApp: pane });
  const heard = {
    supports: [],
    meta: [],
    plays: 0,
    pauses: 0,
    times: [],
    errors: [],
  };
  let props = {
    onSupports: (v) => heard.supports.push(v),
    onMeta: (m) => heard.meta.push(m),
    onPlay: () => (heard.plays += 1),
    onPause: () => (heard.pauses += 1),
    onTime: (t) => heard.times.push(t),
    onError: (name) => heard.errors.push(name),
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
  await until(
    [host, pane],
    () => Boolean(pane._paneWindow?._reactX11Node && pane._paneOutbox === null),
    'the pane to mount and be laid out in the host',
  );
  await settle(host, pane);
  const video = () =>
    find(pane._paneWindow._reactX11Node, (n) => n.kind === 'video');
  let n = 0;
  return {
    host,
    pane,
    hostNative,
    paneNative,
    heard,
    video,
    apps: [host, pane],
    /** The host's player for the pane: its bridge id and record. */
    player: () => [...hostNative.live].at(-1),
    /** The host's bridge says something about player `id`. */
    emit: (ev) => hostNative.emit(ev),
    command: async (op, arg) => {
      props = { ...props, command: { n: ++n, op, arg } };
      root.render(tree());
      await settle(host, pane);
    },
    rerender: async (next) => {
      props = { ...props, ...next };
      root.render(tree());
      await settle(host, pane);
    },
    unmountFrame: async () => {
      root.render(tree(false));
      await settle(host, pane);
    },
  };
}

test('a pane’s <video src> is played by the host: mediaPlayback is true, and src goes to the host’s player', async () => {
  const m = await mount({ autoPlay: true });
  await until(m.apps, () => m.hostNative.live.size === 1, 'the host’s player');
  assert.deepStrictEqual(m.heard.supports, [true]);
  const [, record] = m.player();
  assert.strictEqual(record.url, CLIP);
  assert.deepStrictEqual(record.options, {
    autoPlay: true,
    loop: false,
    muted: false,
    volume: 1,
    rate: 1,
  });
  // nothing was asked of the pane's own bridge
  assert.strictEqual(m.paneNative.of('createPlayer').length, 0);
});

test('the host’s events are the pane’s media events', async () => {
  const m = await mount({ autoPlay: true });
  await until(m.apps, () => m.hostNative.live.size === 1, 'the host’s player');
  const [id] = m.player();
  m.emit({ type: 'player-metadata', id, width: 64, height: 36, duration: 2 });
  m.emit({ type: 'player-state', id, playing: true });
  m.emit({ type: 'player-time', id, currentTime: 0.5 });
  await until(m.apps, () => m.heard.times.includes(0.5), 'the time');
  assert.deepStrictEqual(m.heard.meta, [
    { width: 64, height: 36, duration: 2 },
  ]);
  assert.strictEqual(m.heard.plays, 1);
  const video = m.video();
  assert.strictEqual(video.duration, 2);
  assert.strictEqual(video.paused, false);
  assert.strictEqual(video.currentTime, 0.5);
  m.emit({ type: 'player-error', id, message: 'no such file' });
  await until(m.apps, () => m.heard.errors.length === 1, 'the error');
});

test('a playing frame crosses in a shared buffer and is drawn in the pane', async () => {
  const m = await mount({ autoPlay: true });
  await until(m.apps, () => m.hostNative.live.size === 1, 'the host’s player');
  const [id] = m.player();
  m.emit({ type: 'player-metadata', id, width: 64, height: 36, duration: 2 });
  m.emit({ type: 'player-state', id, playing: true });
  await settle(...m.apps);
  m.hostNative.playerFrame(id, 64, 36);
  await until(
    m.apps,
    () => m.video()._surface?._surfaceHandle?.pixels === 'frame-1',
    'the first frame in the pane’s surface',
  );
  // a ring of shared buffers the frame's size, written by the host's player
  const rings = m.hostNative.of('createSurfaceIOSurface');
  assert.ok(rings.length >= 3);
  for (const [w, hh, scale, shared] of rings.slice(-3)) {
    assert.deepStrictEqual([w, hh, scale, shared], [64, 36, 1, true]);
  }
  // looked up by id in the pane, and copied out once
  const copies = () =>
    m.paneNative.of('blitSurface').filter(([src]) => src?.lookedUp != null);
  assert.strictEqual(m.paneNative.of('surfaceFromIOSurfaceID').length, 1);
  assert.strictEqual(copies().length, 1);
  await settle(...m.apps);
  const drawn = m.paneNative
    .of('ctxDrawSurface')
    .some((args) => args.some((a) => a?.pixels === 'frame-1'));
  assert.ok(drawn, 'the pane drew the frame');
  // the next frame goes into the next buffer
  m.hostNative.playerFrame(id, 64, 36);
  await until(
    m.apps,
    () => m.video()._surface?._surfaceHandle?.pixels === 'frame-2',
    'the second frame',
  );
  assert.strictEqual(m.paneNative.of('surfaceFromIOSurfaceID').length, 2);
});

test('paused, the frame a seek lands on is sent and drawn', async () => {
  const m = await mount();
  await until(m.apps, () => m.hostNative.live.size === 1, 'the host’s player');
  const [id] = m.player();
  m.emit({ type: 'player-metadata', id, width: 64, height: 36, duration: 2 });
  await settle(...m.apps);
  await m.command('seek', 1.25);
  await until(
    m.apps,
    () => m.hostNative.of('playerSeek').length === 1,
    'the seek',
  );
  assert.deepStrictEqual(m.hostNative.of('playerSeek'), [[id, 1.25]]);
  m.emit({ type: 'player-time', id, currentTime: 1.25 });
  m.hostNative.playerFrame(id, 64, 36);
  await until(
    m.apps,
    () => m.video()._surface?._surfaceHandle?.pixels === 'frame-1',
    'the frame the seek landed on',
  );
  assert.strictEqual(m.video().paused, true);
});

test('the pane’s ref steers the host’s player, and letting it go releases it', async () => {
  const m = await mount({ autoPlay: true });
  await until(m.apps, () => m.hostNative.live.size === 1, 'the host’s player');
  const [id] = m.player();
  m.emit({ type: 'player-metadata', id, width: 64, height: 36, duration: 2 });
  m.emit({ type: 'player-state', id, playing: true });
  m.hostNative.playerFrame(id, 64, 36);
  await until(
    m.apps,
    () => m.video()?._surface?._surfaceHandle?.pixels === 'frame-1',
    'a frame',
  );
  await m.command('pause');
  await until(
    m.apps,
    () => m.hostNative.of('playerSet').some(([, s]) => s.paused === true),
    'the pause',
  );
  await m.rerender({ show: false });
  await until(m.apps, () => m.hostNative.live.size === 0, 'the release');
  assert.deepStrictEqual(m.hostNative.of('releasePlayer'), [[id]]);
  // the host's buffers freed, and the pane's mappings of them
  assert.ok(m.hostNative.of('releaseSurface').length >= 3);
  assert.ok(
    m.paneNative.of('releaseSurface').some(([s]) => s?.lookedUp != null),
  );
});

test('a pane that goes takes its players with it', async () => {
  const m = await mount({ autoPlay: true });
  await until(m.apps, () => m.hostNative.live.size === 1, 'the host’s player');
  await m.unmountFrame();
  await until(m.apps, () => m.hostNative.live.size === 0, 'the release');
});

test('a host that plays nothing leaves the pane refusing src', async () => {
  const m = await mount({}, { hostPlays: false });
  await until(m.apps, () => m.heard.errors.length === 1, 'the refusal');
  assert.deepStrictEqual(m.heard.supports, [false]);
  assert.deepStrictEqual(m.heard.errors, ['NoMediaPlaybackError']);
  assert.strictEqual(m.paneNative.of('createPlayer').length, 0);
});
