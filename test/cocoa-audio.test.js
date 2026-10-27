// <audio src> on macOS over the fake bridge (src/nodes/audio.js): the player
// `<video src>` has, told it has no picture. It opens in the commit that
// mounts it, takes no room and offers no part, its events are HTML's, its
// ref steers it, and a bridge without the verbs refuses it as X11 does.
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

const CLIP = '/tmp/voice.mp3';

const audio = (props = {}) => h('audio', { key: 'audio', src: CLIP, ...props });

const box = (key, height) =>
  h('box', { key, style: { height, backgroundColor: '#336699' } });

const find = (node, kind) => {
  if (node.kind === kind) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, kind);
    if (hit) return hit;
  }
  return null;
};

/** The player the bridge made, and its id. */
const playerOf = (native) => {
  const [[url, options]] = native.of('createPlayer');
  const [id, record] = [...native.players].at(-1);
  return { url, options, id, record };
};

test('the bridge’s player plays src, from the commit that mounts it', async () => {
  let supported = null;
  function Probe() {
    supported = useSupports('mediaPlayback');
    return null;
  }
  const { native } = await mountCocoa([
    h(Probe, { key: 'probe' }),
    audio({ autoPlay: true, loop: true, volume: 0.5 }),
  ]);
  assert.equal(supported, true);
  const { url, options } = playerOf(native);
  assert.equal(url, CLIP);
  assert.deepEqual(options, {
    autoPlay: true,
    loop: true,
    muted: false,
    volume: 0.5,
    rate: 1,
  });
});

test('it takes no room, whatever its style, and offers no part', async () => {
  const { native, frame, node, promotion } = await mountCocoa(
    [
      box('a', 20),
      // a style it is not laid out with: there is nothing to see
      h('audio', { key: 'audio', src: CLIP, style: { height: 50 } }),
      box('b', 20),
    ],
    { style: { gap: 10 } },
  );
  const [a, b] = node.children.filter((c) => c.kind === 'box');
  // one gap between the boxes: the audio is not there to have two
  assert.equal(b.abs.y - (a.abs.y + a.abs.height), 20, 'a gap, at 2x');
  const { id } = playerOf(native);
  native.emit({
    type: 'player-metadata',
    id,
    width: 0,
    height: 0,
    duration: 9.72,
  });
  native.emit({ type: 'player-state', id, playing: true, rate: 1 });
  frame();
  assert.equal(promotion.sprites.hosts.size, 0, 'nothing to lift');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(native.of('playerCopyFrame').length, 0, 'no frame asked for');
});

test('HTML’s events, from the player’s', async () => {
  const log = [];
  const { native } = await mountCocoa(
    audio({
      onLoadedMetadata: ({ duration }) => log.push(`metadata ${duration}`),
      onPlay: () => log.push('play'),
      onPause: () => log.push('pause'),
      onTimeUpdate: ({ currentTime }) => log.push(`time ${currentTime}`),
      onEnded: () => log.push('ended'),
      onError: (err) => log.push(`error ${err.message}`),
    }),
  );
  const { id } = playerOf(native);
  native.emit({
    type: 'player-metadata',
    id,
    width: 0,
    height: 0,
    duration: 9.72,
  });
  native.emit({ type: 'player-state', id, playing: true, rate: 1 });
  native.emit({ type: 'player-time', id, currentTime: 0.25 });
  native.emit({ type: 'player-state', id, playing: false, rate: 0 });
  native.emit({ type: 'player-ended', id });
  native.emit({ type: 'player-error', id, message: 'no such file' });
  assert.deepEqual(log, [
    'metadata 9.72',
    'play',
    'time 0.25',
    'pause',
    'ended',
    'error react-x11: <audio src> could not be played: no such file',
  ]);
});

test('the ref plays, pauses and seeks; props change how it plays', async () => {
  let ref = null;
  const { native, render } = await mountCocoa([
    audio({ ref: (n) => (ref = n), muted: true }),
  ]);
  const { id } = playerOf(native);
  assert.equal(ref.kind, 'audio');
  ref.play();
  ref.seek(1.25);
  ref.pause();
  assert.deepEqual(
    native.of('playerSet').map(([, s]) => s),
    [{ paused: false }, { paused: true }],
  );
  assert.deepEqual(native.of('playerSeek'), [[id, 1.25]]);
  assert.equal(ref.currentTime, 1.25);
  assert.ok(Number.isNaN(ref.duration), 'not known yet');
  await render([
    audio({ ref: (n) => (ref = n), muted: false, volume: 0.3, loop: true }),
  ]);
  assert.deepEqual(native.of('playerSet').at(-1)[1], {
    muted: false,
    volume: 0.3,
    loop: true,
  });
  assert.equal(native.of('createPlayer').length, 1, 'the same player');
});

test('a new src is a new player, and an unmount lets it go', async () => {
  const { native, render } = await mountCocoa([audio()]);
  const first = playerOf(native).id;
  await render([audio({ src: '/tmp/next.mp3' })]);
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
  const { node } = await mountCocoa(audio({ onError: (e) => errors.push(e) }), {
    native: bridge,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof NoMediaPlaybackError);
  assert.match(errors[0].message, /<audio src>/);
  assert.equal(find(node, 'audio').paused, true);
});
