// A box of no area has no pixels of its own, and the layout diff claimed
// nothing for one — but an outline or a shadow is drawn round it all the
// same. A box of no height arriving in a scroll pane, where an arriving child
// is claimed where it lands, was never drawn; one that moved left its ring
// behind.
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
const H = 140;

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

async function frameMatchesRepaint(t, scene, a, b) {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await x11Root.unmount();
    await app.close();
  });
  const render = (state) =>
    new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
          scene(state),
        ),
        resolve,
      ),
    );
  const root = (await render(a))._reactX11Node;
  const frame = async () => {
    root._scheduled = false;
    root.flush();
    await settle(app);
  };
  await frame();
  await frame();
  await render(b);
  await frame();
  const painted = await readPixels(root._ctx);
  root.invalidate(false);
  await frame();
  const repainted = await readPixels(root._ctx);
  return painted.equals(repainted);
}

// a box of no height: stretched across, with nothing in it
const ringed = {
  outlineWidth: 2,
  outlineColor: '#e01b24',
  outlineOffset: 2,
};
const shadowed = { boxShadow: '0 0 0 3px #1c71d8' };

for (const [name, style] of [
  ['a ring', ringed],
  ['a shadow', shadowed],
]) {
  test(`a box of no height with ${name}, arriving in a scroll pane, is drawn`, async (t) => {
    const pane = ({ inside }) =>
      h(
        'box',
        { style: { overflow: 'scroll', height: 90, margin: 10 } },
        ...Array.from({ length: 6 }, (_, i) =>
          h(
            'box',
            {
              key: i,
              style: {
                height: 24,
                flexShrink: 0,
                backgroundColor: '#20304a',
              },
            },
            i === 1 && inside ? h('box', { key: 'x', style }) : null,
          ),
        ),
      );
    assert.ok(await frameMatchesRepaint(t, pane, {}, { inside: true }));
  });

  test(`a box of no height with ${name}, moved, leaves nothing behind`, async (t) => {
    const column = ({ above = 10 }) =>
      h(
        'box',
        { style: { margin: 10 } },
        h('box', { style: { height: above, backgroundColor: '#dbe4ee' } }),
        h('box', { style }),
        h('box', { style: { height: 30, backgroundColor: '#dbe4ee' } }),
      );
    assert.ok(await frameMatchesRepaint(t, column, {}, { above: 40 }));
  });
}
