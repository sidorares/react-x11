// <audio> on a backend with no platform player, and over the player a test
// gives one (`fakeMediaPlayers`, src/testing/media.js). The Cocoa player
// behind it is test/cocoa-audio.test.js's.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { NoMediaPlaybackError, useSupports } from '../src/index.js';
import {
  cleanup,
  createMockApp,
  fakeMediaPlayers,
  renderX11,
  settle,
} from '../src/testing/index.js';

const h = React.createElement;

afterEach(async () => {
  await cleanup();
});

const find = (node, kind) => {
  if (node.kind === kind) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, kind);
    if (hit) return hit;
  }
  return null;
};

test('where there is no player it says so once, takes no room and draws nothing', async () => {
  const errors = [];
  const { windowNode, app } = await renderX11(
    h(
      'box',
      { style: { flexDirection: 'column', gap: 10 } },
      h('box', { style: { height: 20 } }),
      h('audio', {
        src: '/tmp/voice.mp3',
        autoPlay: true,
        onError: (e) => errors.push(e),
      }),
      h('box', { style: { height: 20 } }),
    ),
  );
  await settle(app);
  assert.strictEqual(errors.length, 1);
  assert.ok(errors[0] instanceof NoMediaPlaybackError);
  assert.match(errors[0].message, /<audio src>/);
  const column = windowNode.children[0];
  const [a, b] = column.children.filter((n) => n.kind === 'box');
  assert.strictEqual(b.abs.y - (a.abs.y + a.abs.height), 10, 'one gap');
  const audio = find(windowNode, 'audio');
  assert.strictEqual(audio.paused, true);
  assert.ok(Number.isNaN(audio.duration));
});

test('a test’s player: mediaPlayback is true, src and how it plays go to it', async () => {
  const app = createMockApp();
  const fake = fakeMediaPlayers(app);
  let supported = null;
  function Probe() {
    supported = useSupports('mediaPlayback');
    return null;
  }
  const log = [];
  let ref = null;
  const props = {
    ref: (n) => (ref = n),
    src: '/tmp/voice.mp3',
    paused: false,
    volume: 0.5,
    onLoadedMetadata: ({ duration }) => log.push(`metadata ${duration}`),
    onPlay: () => log.push('play'),
    onTimeUpdate: ({ currentTime }) => log.push(`time ${currentTime}`),
    onEnded: () => log.push('ended'),
  };
  const { rerender } = await renderX11(
    h('box', null, h(Probe), h('audio', props)),
    { app, backend: 'mock' },
  );
  assert.strictEqual(supported, true);
  const player = fake.last;
  assert.strictEqual(player.src, '/tmp/voice.mp3');
  assert.strictEqual(player.options.element, 'audio');
  assert.strictEqual(player.options.autoPlay, true);
  assert.strictEqual(player.options.volume, 0.5);
  player.ready({ duration: 9.72 });
  player.state(true);
  player.time(2.5);
  player.end();
  assert.deepStrictEqual(log, ['metadata 9.72', 'play', 'time 2.5', 'ended']);
  assert.strictEqual(ref.duration, 9.72);
  assert.strictEqual(ref.currentTime, 2.5);
  ref.seek(1);
  await rerender(
    h('box', null, h(Probe), h('audio', { ...props, paused: true })),
  );
  assert.deepStrictEqual(player.calls, [
    ['seek', 1],
    ['set', { paused: true }],
  ]);
  await rerender(h('box', null, h(Probe)));
  assert.strictEqual(player.released, true);
  assert.strictEqual(fake.players.length, 1);
});

test('a test’s player plays a <video src> too, and says it was a video', async () => {
  const app = createMockApp();
  const fake = fakeMediaPlayers(app);
  await renderX11(h('video', { src: '/tmp/clip.mp4' }), {
    app,
    backend: 'mock',
  });
  assert.strictEqual(fake.last.src, '/tmp/clip.mp4');
  assert.notStrictEqual(fake.last.options.element, 'audio');
  fake.last.fail('no such file');
  assert.match(fake.last.error.message, /<video src> could not be played/);
});
