// A frame whose every claim lies outside the window: a node moved about
// past its edge — a card dragged off the side of a graph, a pane that
// claims the far side of a pan. There is nothing on screen to repaint, and
// the frame repainted the whole window, because the clamped list came out
// empty and an empty list read as "unbounded".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';

const h = React.createElement;
const W = 320;
const H = 160;

async function mount(t, left) {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await x11Root.unmount();
    await app.close();
  });
  const scene = (at) =>
    h(
      'window',
      { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
      h('box', {
        style: {
          position: 'absolute',
          left: at,
          top: 20,
          width: 40,
          height: 40,
          backgroundColor: '#e01b24',
        },
      }),
    );
  const render = (at) =>
    new Promise((resolve) => x11Root.render(scene(at), resolve));
  const root = (await render(left))._reactX11Node;
  const frame = () => {
    root._scheduled = false;
    root.flush();
  };
  frame();
  frame();
  // every pass the frame paints, by the rect it was handed
  const passes = [];
  const paintRegion = root._paintRegion;
  root._paintRegion = function (ctx, rect, ...rest) {
    passes.push(rect);
    return paintRegion.call(this, ctx, rect, ...rest);
  };
  return { root, render, frame, passes };
}

test('a node that moves outside the window repaints nothing', async (t) => {
  const { root, render, frame, passes } = await mount(t, W + 60);
  await render(W + 120);
  frame();
  assert.deepEqual(passes, [], 'no pass at all, and not one over everything');
  assert.deepEqual(root._lastDamageRects, []);
});

test('a node that moves out of the window repaints only where it was', async (t) => {
  const { render, frame, passes } = await mount(t, W - 60);
  await render(W + 60);
  frame();
  assert.equal(passes.length, 1);
  assert.ok(passes[0] !== null, 'a rect, not the whole window');
  assert.ok(
    passes[0].x >= W - 70 && passes[0].width <= 80,
    JSON.stringify(passes[0]),
  );
});
