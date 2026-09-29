// A box that starts clipping what it holds hides whatever its children drew
// past it, and nothing moves for the layout diff to see. Its own claims are
// made once its new style is in, when its bounds already stop at its box,
// so what its children drew past it stayed on the screen.
//
// Held to pixels: the frame as it was painted against the same state painted
// again from scratch. Found by a random differential of exactly that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';

const h = React.createElement;
const W = 200;
const H = 160;

const settle = (app) =>
  new Promise((resolve, reject) =>
    app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
  );

const readPixels = (ctx) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, data) =>
      err ? reject(err) : resolve(Buffer.from(data.data)),
    ),
  );

/** A box of a set height whose children reach past it: one taller than
 *  it, one with a shadow, one placed outside it. */
const overflowing = (overflow) =>
  h(
    'window',
    { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
    h(
      'box',
      { style: { margin: 20, height: 40, overflow } },
      h('box', { style: { height: 70, backgroundColor: '#26a269' } }),
      h('box', {
        style: {
          position: 'absolute',
          left: 60,
          top: 50,
          width: 30,
          height: 30,
          backgroundColor: '#1c71d8',
          boxShadow: '0 0 0 4px #20304a',
        },
      }),
    ),
  );

async function changeMatchesRepaint(t, from, to) {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await x11Root.unmount();
    await app.close();
  });
  const render = (overflow) =>
    new Promise((resolve) => x11Root.render(overflowing(overflow), resolve));
  const root = (await render(from))._reactX11Node;
  const frame = async () => {
    root._scheduled = false;
    root.flush();
    await settle(app);
  };
  await frame();
  await frame();
  await render(to);
  await frame();
  const painted = await readPixels(root._ctx);
  root.invalidate(false);
  await frame();
  const repainted = await readPixels(root._ctx);
  return painted.equals(repainted);
}

test('a box that starts clipping hides what its children drew past it', async (t) => {
  assert.ok(await changeMatchesRepaint(t, undefined, 'hidden'));
  assert.ok(await changeMatchesRepaint(t, undefined, 'scroll'));
});

test('a box that stops clipping shows what its children draw past it', async (t) => {
  assert.ok(await changeMatchesRepaint(t, 'hidden', undefined));
  assert.ok(await changeMatchesRepaint(t, 'scroll', undefined));
});
