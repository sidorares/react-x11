// <video src> on macOS (src/cocoa/player.js, the player `contents` kind in
// src/cocoa/sprites.js) over the fake bridge, whose `player-*` events the
// test emits the way AVFoundation's KVO would. The contract
// (docs/architecture/video.md §6, §7): a `<video src>` is played by the
// platform's player where the bridge has one, laid out at the clip's size
// once the item is ready, and its picture is the player's own layer lifted
// into the part — or, painted over, the frame showing copied into the
// element's surface for as long as it plays; HTML's props steer it and its
// events are HTML's; and a bridge without the verbs refuses `src` as X11
// does.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { NoMediaPlaybackError, useSupports } from '../src/index.js';
import {
  cleanupCocoa,
  fakeCocoaBridge,
  mountCocoa,
} from './helpers/cocoa-bridge.js';

const h = React.createElement;

afterEach(async () => {
  await cleanupCocoa();
});

const CLIP = '/tmp/clip.mp4';

const video = (props = {}, style = {}) =>
  h('video', {
    key: 'video',
    src: CLIP,
    ...props,
    style: {
      position: 'absolute',
      left: 10,
      top: 10,
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

const find = (node, kind) => {
  if (node.kind === kind) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, kind);
    if (hit) return hit;
  }
  return null;
};

const liftedState = (promotion) => {
  const host = [...promotion.sprites.hosts.values()][0];
  return host ? [...host.values()][0] : undefined;
};

/** The player the bridge made, and its id. */
const playerOf = (native) => {
  const [[url, options]] = native.of('createPlayer');
  const [id, record] = [...native.players].at(-1);
  return { url, options, id, record };
};

const ready = (native, id, width = 160, height = 90, duration = 1.5) =>
  native.emit({ type: 'player-metadata', id, width, height, duration });

test('a bridge that plays: mediaPlayback is true, and src goes to its player', async () => {
  let supported = null;
  function Probe() {
    supported = useSupports('mediaPlayback');
    return null;
  }
  const { native } = await mountCocoa([
    h(Probe, { key: 'probe' }),
    video({ autoPlay: true, muted: true, loop: true, volume: 0.5 }),
  ]);
  assert.equal(supported, true);
  const { url, options } = playerOf(native);
  assert.equal(url, CLIP);
  assert.deepEqual(options, {
    autoPlay: true,
    loop: true,
    muted: true,
    volume: 0.5,
    rate: 1,
  });
});

test('a controlled paused={false} plays from the start, and paused={true} does not', async () => {
  const { native, render } = await mountCocoa([video({ paused: false })]);
  assert.equal(playerOf(native).options.autoPlay, true);
  await render([video({ paused: true, autoPlay: true })]);
  // the same player, told to pause
  assert.equal(native.of('createPlayer').length, 1);
  assert.deepEqual(native.of('playerSet').at(-1)[1], { paused: true });
});

test('laid out at the clip’s size once it is ready, and told so', async () => {
  const seen = [];
  const { native, frame, node } = await mountCocoa(
    video({ onLoadedMetadata: (ev) => seen.push(ev) }),
    { width: 400, height: 300 },
  );
  const v = find(node, 'video');
  assert.deepEqual([v.abs.width, v.abs.height], [600, 300], '300x150 at 2x');
  ready(native, playerOf(native).id);
  frame();
  assert.deepEqual([v.abs.width, v.abs.height], [320, 180], 'the clip, at 2x');
  assert.equal(seen.length, 1);
  assert.deepEqual(
    [seen[0].width, seen[0].height, seen[0].duration],
    [160, 90, 1.5],
  );
});

test('lifted, the player’s own layer fills the part', async () => {
  const { native, frame, promotion, node } = await mountCocoa(video());
  const { id, record } = playerOf(native);
  frame();
  assert.equal(promotion.sprites.hosts.size, 0, 'no size yet, no part');
  ready(native, id);
  frame();
  const state = liftedState(promotion);
  assert.ok(state, 'lifted');
  assert.equal(find(node, 'video')._lifted, true);
  // the AVPlayerLayer inside the part's layer, the part's size
  assert.equal(record.layer.parent, state.layer);
  assert.deepEqual(state.layer.props.bounds, [0, 0, 160, 90]);
  assert.deepEqual(record.layer.props.frame, [0, 0, 160, 90]);
  // and nothing pulled frames: the layer is AVFoundation's
  native.emit({ type: 'player-state', id, playing: true, rate: 1 });
  native.playerFrame(id, 160, 90);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(native.of('playerCopyFrame').length, 0);
});

test('painted over, the frame showing is copied in while it plays, and not after', async () => {
  const { native, frame, frames, promotion, render, node } = await mountCocoa([
    video(),
  ]);
  const { id, record } = playerOf(native);
  ready(native, id);
  frame();
  assert.ok(liftedState(promotion));
  await render([video(), cover()]);
  native.playerFrame(id, 160, 90);
  frame();
  assert.equal(promotion.sprites.hosts.size, 0, 'declined');
  assert.equal(record.layer.parent, null, 'the player’s layer came down');
  // the frame showing, into a 2D surface of the clip's size, drawn
  const [[, target]] = native.of('playerCopyFrame');
  assert.deepEqual([target.width, target.height], [160, 90]);
  assert.ok(native.of('ctxDrawSurface').some(([, src]) => src === target));
  // playing: a new frame is a claim of the picture, and a frame
  native.emit({ type: 'player-state', id, playing: true, rate: 1 });
  const before = frames.count;
  native.playerFrame(id, 160, 90);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(find(node, 'video').needsPaint ?? node.needsPaint, true);
  frame();
  assert.equal(frames.count, before + 1);
  // paused: nothing is asked for
  native.emit({ type: 'player-state', id, playing: false, rate: 0 });
  const asked = native.of('playerCopyFrame').length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(native.of('playerCopyFrame').length, asked);
  // uncovered, it goes back up
  await render([video()]);
  frame();
  assert.ok(liftedState(promotion));
  assert.equal(record.layer.parent, liftedState(promotion).layer);
});

test('HTML’s events, from the player’s', async () => {
  const log = [];
  const { native } = await mountCocoa(
    video({
      onPlay: () => log.push('play'),
      onPause: () => log.push('pause'),
      onTimeUpdate: ({ currentTime }) => log.push(`time ${currentTime}`),
      onEnded: () => log.push('ended'),
      onError: (err) => log.push(`error ${err.message}`),
    }),
  );
  const { id } = playerOf(native);
  native.emit({ type: 'player-state', id, playing: true, rate: 1 });
  // waiting, a loop's restart: still playing, and no second play
  native.emit({ type: 'player-state', id, playing: true, rate: 1 });
  native.emit({ type: 'player-time', id, currentTime: 0.25 });
  native.emit({ type: 'player-state', id, playing: false, rate: 0 });
  native.emit({ type: 'player-ended', id });
  native.emit({ type: 'player-error', id, message: 'no such file' });
  // another player's events are not this one's
  native.emit({ type: 'player-ended', id: id + 1000 });
  assert.deepEqual(log, [
    'play',
    'time 0.25',
    'pause',
    'ended',
    'error react-x11: <video src> could not be played: no such file',
  ]);
});

test('the ref plays, pauses and seeks; props change how it plays', async () => {
  let ref = null;
  const { native, render } = await mountCocoa([
    video({ ref: (n) => (ref = n), muted: true }),
  ]);
  const { id } = playerOf(native);
  ref.play();
  ref.seek(1.25);
  ref.pause();
  assert.deepEqual(
    native.of('playerSet').map(([, s]) => s),
    [{ paused: false }, { paused: true }],
  );
  assert.deepEqual(native.of('playerSeek'), [[id, 1.25]]);
  assert.equal(ref.currentTime, 1.25);
  await render([
    video({ ref: (n) => (ref = n), muted: false, volume: 0.3, loop: true }),
  ]);
  assert.deepEqual(native.of('playerSet').at(-1)[1], {
    muted: false,
    volume: 0.3,
    loop: true,
  });
});

test('a new src is a new player, and an unmount lets it go', async () => {
  const { native, render } = await mountCocoa([video()]);
  const first = playerOf(native).id;
  await render([video({ src: '/tmp/other.mp4' })]);
  assert.deepEqual(native.of('releasePlayer'), [[first]]);
  assert.equal(native.of('createPlayer').length, 2);
  const second = playerOf(native).id;
  await render([]);
  assert.deepEqual(native.of('releasePlayer').at(-1), [second]);
  assert.equal(native.players.size, 0);
});

test('a bridge with no player refuses src, as X11 does', async () => {
  const PLAYER_VERBS = new Set([
    'createPlayer',
    'playerSet',
    'playerSeek',
    'playerCopyFrame',
    'releasePlayer',
  ]);
  const fake = fakeCocoaBridge();
  const bridge = new Proxy(fake, {
    get: (target, name) => (PLAYER_VERBS.has(name) ? undefined : target[name]),
  });
  const errors = [];
  const { app } = await mountCocoa(video({ onError: (e) => errors.push(e) }), {
    native: bridge,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(typeof app.createPlayer, 'undefined');
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof NoMediaPlaybackError);
});
