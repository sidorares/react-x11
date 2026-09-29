// An element that draws past its box, and says how far (`paintOverhang`).
// Claimed and culled by its box alone, a change to it left the old ink's
// edge outside the box on the screen and drew none of the new one's. A
// code chip padded past the run at the start of a line is the real case.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import { registerElement, unregisterElement } from '../src/host.js';
import { Node } from '../src/node.js';

const h = React.createElement;
const W = 120;
const H = 60;
const PAD = 3;

// a block that paints PAD device pixels past its box on the left
class OverhangNode extends Node {
  paintOverhang() {
    return PAD;
  }
  paintContent(ctx) {
    ctx.fillStyle = this.props.tone;
    const { x, y, width, height } = this.abs;
    ctx.fillRect(x - PAD, y, width + PAD, height);
  }
  applyProps(next, prev) {
    super.applyProps(next, prev);
    if (prev && next.tone !== prev.tone)
      this.invalidate(false, this, 'content');
  }
}

registerElement('overhangblock', {
  create: (props, app) => new OverhangNode('overhangblock', props, app),
  childrenAllowed: false,
  override: true,
});
after(() => unregisterElement('overhangblock'));

async function mount(t) {
  const server = xserver.createServer({ width: 400, height: 300 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await x11Root.unmount();
    await app.close();
  });
  const scene = (tone) =>
    h(
      'window',
      { width: W, height: H, style: { backgroundColor: '#ffffff' } },
      h('overhangblock', {
        tone,
        style: {
          position: 'absolute',
          left: 40,
          top: 10,
          width: 30,
          height: 20,
        },
      }),
    );
  const render = (tone) =>
    new Promise((resolve) => x11Root.render(scene(tone), resolve));
  const root = (await render('#e01b24'))._reactX11Node;
  const frame = async () => {
    root._scheduled = false;
    root.flush();
    await new Promise((resolve) => app.X.GetInputFocus(() => resolve()));
  };
  await frame();
  await frame();
  const read = () =>
    new Promise((resolve, reject) =>
      root._ctx.getImageData(0, 0, W, H, (err, data) =>
        err ? reject(err) : resolve(Buffer.from(data.data)),
      ),
    );
  return { root, render, frame, read };
}

test('an element is claimed by its box grown by what it says it draws past it', async (t) => {
  const { root, render, frame, read } = await mount(t);
  const block = root.children[0];
  const bounds = block.paintBounds();
  assert.ok(
    bounds.x <= block.abs.x - PAD,
    `paintBounds reaches ${block.abs.x - bounds.x}px left`,
  );
  await render('#1c71d8');
  await frame();
  const frameAfter = await read();
  // the column PAD - 1 left of the box is the overhang's, and blue now
  const at = (x, y) => [
    ...frameAfter.subarray((y * W + x) * 4, (y * W + x) * 4 + 3),
  ];
  const [r, g, b] = at(40 - PAD + 1, 20);
  assert.ok(
    b > 180 && r < 80,
    `the overhang took the new colour: ${[r, g, b]}`,
  );
  root.invalidate(false);
  await frame();
  assert.ok(
    frameAfter.equals(await read()),
    'the frame is what a full repaint draws',
  );
});
