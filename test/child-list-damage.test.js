// What a child-list change inside a scroll box claims (`Node._childListFine`)
// and what a box that only grew or shrank claims (`_edgeBands`): the child
// that leaves, where an entering child lands, what either displaced, and the
// edge that moved — not the box, which for a column taller than its scroll
// box is the whole viewport. Every case is held to a full repaint of the
// same state, byte for byte, and the cheap ones to what they claimed.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const W = 400;
const H = 300;

/** A document: a column of blocks inside a scroll box, taller than it. */
function Doc({ blocks, extra = null, column = {}, paneRef = null }) {
  return h(
    'box',
    { ref: paneRef, style: { overflow: 'scroll', flexGrow: 1 } },
    h(
      'box',
      {
        style: {
          flexShrink: 0,
          padding: 6,
          gap: 4,
          backgroundColor: '#ffffff',
          ...column,
        },
      },
      ...blocks.map((b) =>
        h(
          'box',
          {
            key: b.key,
            style: {
              height: b.height,
              flexShrink: 0,
              backgroundColor: b.color,
              ...b.style,
            },
          },
          b.text
            ? h('text', { style: { fontSize: 12, color: '#20304a' } }, b.text)
            : null,
        ),
      ),
      extra,
    ),
  );
}

const block = (key, height = 40, extra = {}) => ({
  key,
  height,
  color: key % 2 ? '#dbe4ee' : '#f0e0c8',
  text: `block ${key}`,
  ...extra,
});

/** The damage the last frame painted, inside the viewport. */
function paintedInView(root) {
  const rects = root._lastDamageRects;
  if (!rects) return W * H;
  let sum = 0;
  for (const r of rects) {
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(W, r.x + r.width);
    const y1 = Math.min(H, r.y + r.height);
    if (x1 > x0 && y1 > y0) sum += (x1 - x0) * (y1 - y0);
  }
  return sum;
}

test('a block that arrives below the fold claims nothing on screen', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const blocks = Array.from({ length: 30 }, (_, i) => block(i));
  const render = (list) =>
    x11Root.render(
      h('window', { width: W, height: H }, h(Doc, { blocks: list })),
    );
  render(blocks);
  const root = app.windows[0]._reactX11Node;
  for (let i = 0; i < 3; i++) await tick();

  render([...blocks, block(30)]);
  await tick();
  assert.ok(root._lastDamageRects, 'the frame stayed bounded');
  // the scroll box's thumb, which the longer content shortened — and not
  // the column, clipped to the view
  assert.ok(
    paintedInView(root) < W * H * 0.02,
    `painted ${JSON.stringify(root._lastDamageRects)}`,
  );
  await x11Root.unmount();
});

test('a re-slice that swaps the first block for a spacer claims nothing on screen', async () => {
  // what a virtualized list does as a block scrolls out above the view:
  // the block goes and a spacer as tall as it, gap included, takes its
  // place — nothing on screen moves
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const blocks = Array.from({ length: 30 }, (_, i) => block(i));
  const spacer = (height) => ({ key: 'spacer', height, color: '#ffffff' });
  const pane = React.createRef();
  const render = (list) =>
    x11Root.render(
      h(
        'window',
        { width: W, height: H },
        h(Doc, { blocks: list, paneRef: pane }),
      ),
    );
  render([spacer(0), ...blocks]);
  const root = app.windows[0]._reactX11Node;
  for (let i = 0; i < 3; i++) await tick();
  // past the first blocks, as a list is when it drops them
  pane.current.scrollTo(200);
  for (let i = 0; i < 2; i++) await tick();

  render([spacer(40 + 4), ...blocks.slice(1)]);
  await tick();
  assert.ok(root._lastDamageRects, 'the frame stayed bounded');
  assert.ok(
    paintedInView(root) < W * H * 0.05,
    `painted ${JSON.stringify(root._lastDamageRects)}`,
  );
  await x11Root.unmount();
});

// --- against the real server ---------------------------------------------------

const require = createRequire(import.meta.url);

async function createHeadlessApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(
    readFileSync(
      join(
        dirname(require.resolve('katex/package.json')),
        'dist',
        'fonts',
        'KaTeX_Main-Regular.ttf',
      ),
    ),
    { family: 'Test Main' },
  );
  fontSource.alias('sans-serif', 'Test Main');
  return await createClient({ stream: clientEnd, fontSource });
}

const settle = (app) =>
  new Promise((resolve, reject) =>
    app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
  );

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );

test('what a child-list change inside a scroll box repaints is what a full repaint draws', async () => {
  const app = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const overlay = (at, color, key = 'overlay') =>
      h('box', {
        key,
        style: {
          position: 'absolute',
          left: at,
          top: 30,
          width: 120,
          height: 70,
          backgroundColor: color,
          borderRadius: 8,
        },
      });
    const base = Array.from({ length: 12 }, (_, i) => block(i, 36));
    const states = [
      ['a block below the fold', { blocks: [...base, block(12)] }],
      [
        'a block in view, displacing the ones after it',
        { blocks: [base[0], block(20, 50), ...base.slice(1), block(12)] },
      ],
      [
        'a block in view taken away',
        { blocks: [base[0], ...base.slice(2), block(12)] },
      ],
      [
        'an overlay over the blocks',
        {
          blocks: [base[0], ...base.slice(2), block(12)],
          extra: [overlay(60, '#c05030')],
        },
      ],
      [
        'a second overlay, painted under the first',
        {
          blocks: [base[0], ...base.slice(2), block(12)],
          extra: [overlay(120, '#3050c0', 'under'), overlay(60, '#c05030')],
        },
      ],
      [
        'the two overlays in the other order',
        {
          blocks: [base[0], ...base.slice(2), block(12)],
          extra: [overlay(60, '#c05030'), overlay(120, '#3050c0', 'under')],
        },
      ],
      ['the overlays gone', { blocks: [base[0], ...base.slice(2), block(12)] }],
    ];
    // a rounded, bordered column short enough that its bottom edge is in
    // view: growing moves its lower border and corners on screen
    const card = {
      borderRadius: 14,
      borderWidth: 2,
      borderColor: '#5070a0',
      backgroundColor: '#fffaf0',
    };
    const short = base.slice(0, 3);
    states.push(
      ['a short card', { blocks: short, column: card }],
      [
        'the card one block taller',
        { blocks: [...short, block(3)], column: card },
      ],
      ['and back', { blocks: short, column: card }],
    );

    let instance = null;
    for (const [what, props] of states) {
      const rendered = await new Promise((resolve) =>
        x11Root.render(
          h(
            'window',
            { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
            h(Doc, props),
          ),
          resolve,
        ),
      );
      instance ??= rendered;
      const root = instance._reactX11Node;
      const frame = () => {
        root._scheduled = false;
        root.flush();
      };
      for (let i = 0; i < 3; i++) {
        await tick();
        frame();
      }
      await settle(app);
      const drawn = await readPixels(root._ctx, W, H);
      root.invalidate(false);
      frame();
      await settle(app);
      const repainted = await readPixels(root._ctx, W, H);
      assert.ok(
        Buffer.from(drawn.data).equals(Buffer.from(repainted.data)),
        `${what}: the frame differs from a full repaint`,
      );
    }
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});
