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
// processes share the kernel's (`surfaceTable`, test/helpers/pane-bridges.js).
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { HostedPlayer } from '../src/cocoa/paneplayer.js';
import { Frame } from '../src/frame/index.js';
import { createRoot } from '../src/index.js';
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
const PANE = new URL('./fixtures/video-pane.js', import.meta.url);
const CLIP = '/tmp/clip.mp4';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

/** A host window with a <Frame> showing the fixture, both apps running. */
async function mount(
  paneProps = {},
  { hostPlays = true, recycleIds = false } = {},
) {
  const iosurfaces = surfaceTable({ recycleIds });
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

test('a pane’s <audio src> is played by the host, which copies no frames for it', async () => {
  const m = await mount({ autoPlay: true, element: 'audio' });
  await until(m.apps, () => m.hostNative.live.size === 1, 'the host’s player');
  assert.deepStrictEqual(m.heard.supports, [true]);
  const [id, record] = m.player();
  assert.strictEqual(record.url, CLIP);
  assert.strictEqual(record.options.autoPlay, true);
  // what the host made for the pane itself, before any frame of a player's
  const made = m.hostNative.of('createSurfaceIOSurface').length;
  // a video file is a source an `<audio>` may play, heard and not seen:
  // the item has a size, and frames, and none of them is copied
  m.emit({
    type: 'player-metadata',
    id,
    width: 64,
    height: 36,
    duration: 9.72,
  });
  m.hostNative.playerFrame(id, 64, 36);
  m.emit({ type: 'player-state', id, playing: true });
  m.emit({ type: 'player-time', id, currentTime: 0.5 });
  await until(m.apps, () => m.heard.times.includes(0.5), 'the time');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(m.heard.meta, [
    { width: undefined, height: undefined, duration: 9.72 },
  ]);
  assert.strictEqual(m.heard.plays, 1);
  assert.strictEqual(m.hostNative.of('playerCopyFrame').length, 0);
  assert.strictEqual(
    m.hostNative.of('createSurfaceIOSurface').length,
    made,
    'no ring',
  );
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

test('a frame a new size crossed is looked up as the buffer it named, not one of the next ring', async () => {
  // A frame names its buffer by IOSurface id, and the pane looks it up when
  // it reads the message. A stream that switches renditions has the host
  // make a ring of the new size, and the system gives a freed id to the
  // next surface made — here that ring, made in the call that freed the
  // old one. Freed at once, the buffer a paused frame named was a buffer of
  // the next ring by the time the pane looked: unwritten, and drawn until
  // the next seek. So the host keeps it until the pane has looked it up.
  const m = await mount({}, { recycleIds: true });
  await until(m.apps, () => m.hostNative.live.size === 1, 'the host’s player');
  const [id] = m.player();
  m.emit({ type: 'player-metadata', id, width: 64, height: 36, duration: 2 });
  await settle(...m.apps);
  // paused: the frame a seek landed on goes out, and before the pane reads
  // it the stream's next frame is another size, and the ring follows it
  m.hostNative.playerFrame(id, 64, 36);
  m.emit({ type: 'player-time', id, currentTime: 1 });
  m.hostNative.playerFrame(id, 128, 72);
  m.emit({ type: 'player-time', id, currentTime: 1 });
  m.emit({ type: 'player-time', id, currentTime: 1 });
  const rings = m.hostNative.of('createSurfaceIOSurface');
  assert.deepStrictEqual(rings.at(-1).slice(0, 2), [128, 72], 'a new ring');
  await until(
    m.apps,
    () => m.paneNative.looked.length > 0,
    'the pane to look the frame up',
  );
  await settle(...m.apps);
  const found = m.paneNative.looked[0];
  assert.deepStrictEqual(
    [found.width, found.height, found.pixels],
    [64, 36, 'frame-1'],
    'the buffer the frame named, not a buffer of the next ring',
  );
  assert.strictEqual(m.video()._surface._surfaceHandle.pixels, 'frame-1');
  // and once the pane has looked it up, the host lets it go
  await until(m.apps, () => found.holds === 1, 'the host to free it');
  assert.ok(m.hostNative.of('releaseSurface').some(([s]) => s === found));
});

test('a buffer looked up at another size than its frame is neither kept nor copied', async () => {
  // Whatever the host keeps, an id can still find some other surface — one
  // a pane that stopped answering had freed for it, one of another
  // process's — and a copy out of it is a picture of something else.
  const m = await mount({}, { recycleIds: true });
  await until(m.apps, () => m.hostNative.live.size === 1, 'the host’s player');
  const [id] = m.player();
  m.emit({ type: 'player-metadata', id, width: 64, height: 36, duration: 2 });
  m.hostNative.playerFrame(id, 64, 36);
  m.emit({ type: 'player-time', id, currentTime: 1 });
  await until(
    m.apps,
    () => m.video()._surface?._surfaceHandle?.pixels === 'frame-1',
    'the first frame',
  );
  const player = [...m.pane._players.values()][0];
  const other = m.hostNative.createSurfaceIOSurface(32, 18, 1, true);
  other.handle.pixels = 'someone else';
  const looked = m.paneNative.looked.length;
  player._frame({
    surface: other.iosurfaceId,
    width: 64,
    height: 36,
    time: 2,
    seq: 99,
  });
  assert.strictEqual(m.paneNative.looked.length, looked + 1, 'it looked');
  assert.ok(!player._ring._buffers.has(other.iosurfaceId), 'and kept nothing');
  assert.strictEqual(other.handle.holds, 1, 'nor held it');
  m.emit({ type: 'player-time', id, currentTime: 2 });
  await settle(...m.apps);
  assert.strictEqual(m.video()._surface._surfaceHandle.pixels, 'frame-1');
});

test('a pane that stops answering has the host keep no more than a ring of retired buffers', () => {
  const native = fakeBridge(surfaceTable());
  const app = appOver(native);
  const sent = [];
  const hosted = new HostedPlayer(app, (msg) => sent.push(msg), {
    player: 'pane-player-1',
    src: CLIP,
    options: {},
  });
  const { id } = hosted.player;
  // paused, a frame at each of six sizes, and not one of them answered
  for (let i = 1; i <= 6; i += 1) {
    native.playerFrame(id, 16 * i, 9 * i);
    native.emit({
      type: 'player-metadata',
      id,
      width: 16 * i,
      height: 9 * i,
      duration: 2,
    });
    assert.ok(
      hosted._ring._retired.length <= 3,
      `${hosted._ring._retired.length} kept`,
    );
  }
  const frames = sent.filter((m) => m.type === 'pane-player-frame');
  assert.deepStrictEqual(
    frames.map((m) => m.seq),
    [1, 2, 3, 4, 5, 6],
  );
  // the newest three of the five retired rings' frames: the oldest went
  // first, the one the pane is likeliest to have looked up
  assert.deepStrictEqual(
    hosted._ring._retired.map((b) => b.namedSeq),
    [3, 4, 5],
  );
  const made = native.of('createSurfaceIOSurface').length;
  assert.strictEqual(native.of('releaseSurface').length, made - 3 - 3);
  // an answer that comes after all frees what it covers
  hosted.handle({ op: 'seen', seq: 4 });
  assert.deepStrictEqual(
    hosted._ring._retired.map((b) => b.namedSeq),
    [5],
  );
  hosted.release();
  assert.strictEqual(native.of('releaseSurface').length, made, 'the rest');
  assert.deepStrictEqual(hosted._ring._retired, []);
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
