// A box whose `borderRadius` is more than it can hold draws its corners at
// half its shorter side, so a resize that changes that side changes all four
// corners. A box that only grew or shrank claimed a band along the edges
// that moved (`_edgeBands`), and the corners at the edges that held kept
// their old shape — the round of an outline a pixel or two above a box whose
// bottom had moved, or the top corners of a box that grew past its radius.
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
const H = 120;

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

async function grownMatchesRepaint(t, box, from, to) {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await x11Root.unmount();
    await app.close();
  });
  const render = (inner) =>
    new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
          h(
            'box',
            { style: { padding: 10 } },
            // grown by what it holds, so its own style never changes
            h('box', { style: box }, h('box', { style: { height: inner } })),
          ),
        ),
        resolve,
      ),
    );
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

test('a box too short for its radius, grown, redraws the outline round its top corners', async (t) => {
  const box = {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    outlineWidth: 4,
    outlineColor: '#20304a',
  };
  assert.ok(await grownMatchesRepaint(t, box, 10, 16));
  assert.ok(await grownMatchesRepaint(t, box, 16, 10));
});

test('a box that grows past its radius redraws its top corners', async (t) => {
  const box = { backgroundColor: '#20304a', borderRadius: 12 };
  assert.ok(await grownMatchesRepaint(t, box, 20, 30));
  assert.ok(await grownMatchesRepaint(t, box, 30, 20));
});

test('a box whose radius it holds either way still claims only its edge', async (t) => {
  // the band stays: the corners at the edges that held are unchanged
  const box = { backgroundColor: '#20304a', borderRadius: 4 };
  assert.ok(await grownMatchesRepaint(t, box, 20, 30));
});
