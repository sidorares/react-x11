// `Node.viewportFixedRects()` — an element that draws part of itself fixed
// to the viewport of the scroll pane it is in, a document's fixed header or
// background, says where, and a scroll of that pane that blits repairs those
// rects where they are and where the copy dragged their image, as it does a
// rounded ancestor's corners. Without it the blit dragged the header along
// with the text under it. On the mock app, which records the damage, what is
// repaired; on the in-process X server, that a blitted scroll leaves the
// pixels a full repaint of the same state leaves, byte for byte.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { registerElement, unregisterElement } from '../src/host.js';
import { createRoot } from '../src/index.js';
import { Node } from '../src/node.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A document 1600px tall, in 40px bands that scroll with it, and a banner
 *  `banner` pixels tall at the top of its scroll pane's viewport that does
 *  not — which it says, unless `silent`. */
class FixedDocNode extends Node {
  constructor(props, app) {
    super('fixeddoc', props, app);
  }

  _banner() {
    let pane = this.parent;
    while (pane && !pane.isWindow && !pane.isScroller?.()) pane = pane.parent;
    if (!pane || pane.isWindow) return null;
    const viewport = pane.contentBox();
    return {
      x: viewport.x,
      y: viewport.y,
      width: viewport.width,
      height: this.props.banner ?? 40,
    };
  }

  viewportFixedRects() {
    if (this.props.silent) return null;
    const banner = this._banner();
    return banner && [banner];
  }

  paintContent(ctx) {
    const { x, y, width, height } = this.abs;
    for (let i = 0; i * 40 < height; i += 1) {
      ctx.fillStyle = i % 2 ? '#ffffff' : '#dbe4ee';
      ctx.fillRect(x, y + i * 40, width, 40);
    }
    const banner = this._banner();
    if (!banner) return;
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(banner.x, banner.y, banner.width, banner.height);
  }
}

registerElement('fixeddoc', {
  create: (props, app) => new FixedDocNode(props, app),
});
process.on('exit', () => unregisterElement('fixeddoc'));

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

async function mount(doc = {}, { nested = false } = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  roots.push(x11Root);
  const ref = React.createRef();
  const inner = React.createRef();
  const document = h('fixeddoc', {
    style: { height: 1600, flexShrink: 0 },
    ...doc,
  });
  x11Root.render(
    h(
      'window',
      { width: 400, height: 400 },
      h(
        'box',
        { ref, style: { overflow: 'scroll', flexGrow: 1 } },
        nested ? h('box', { style: { height: 100, flexShrink: 0 } }) : null,
        nested
          ? h(
              'box',
              {
                ref: inner,
                style: { overflow: 'scroll', height: 200, flexShrink: 0 },
              },
              document,
            )
          : document,
        nested ? h('box', { style: { height: 1600, flexShrink: 0 } }) : null,
      ),
    ),
  );
  const wnd = app.windows[0];
  await tick();
  wnd.calls.length = 0;
  return { wnd, root: wnd._reactX11Node, ref, inner };
}

const blits = (wnd) => wnd.calls.filter(([name]) => name === 'scrollRegion');

/** Whether every pixel of `r` is in one of the frame's damage rects. */
function covered(rects, r) {
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      const hit = rects.some(
        (d) => x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height,
      );
      if (!hit) return false;
    }
  }
  return true;
}

test('a scroll blits, and repaints what an element draws fixed to the viewport where it is', async () => {
  const { wnd, root, ref } = await mount();
  ref.current.scrollTo(48);
  await tick();
  const vp = { x: 0, y: 0, width: 400, height: 400 };
  assert.deepStrictEqual(blits(wnd), [['scrollRegion', vp, 0, -48]]);
  const rects = root._lastDamageRects;
  assert.ok(rects, 'the frame stayed bounded');
  // where the banner is: the copy put the bands under it there, and dragged
  // its own image above the viewport
  assert.ok(
    covered(rects, { x: 0, y: 0, width: 400, height: 40 }),
    `the banner is repainted where it is: ${JSON.stringify(rects)}`,
  );
  const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
  assert.ok(
    area < 400 * 400 * 0.4,
    `and not much else: ${JSON.stringify(rects)}`,
  );
});

test('scrolled back up, it is repaired where the copy dragged it too', async () => {
  const { wnd, root, ref } = await mount();
  ref.current.scrollTo(200);
  await tick();
  wnd.calls.length = 0;
  ref.current.scrollTo(152);
  await tick();
  assert.strictEqual(blits(wnd).length, 1, 'the fast path fired');
  const rects = root._lastDamageRects;
  assert.ok(
    covered(rects, { x: 0, y: 0, width: 400, height: 40 + 48 }),
    `where it is, and 48px down where its image went: ${JSON.stringify(rects)}`,
  );
});

test('an element that says nothing is copied with the content', async () => {
  // what the hook changes, and nothing else: the same scroll, and the
  // banner's rect is owed nothing but the strip
  const { wnd, root, ref } = await mount({ silent: true });
  ref.current.scrollTo(48);
  await tick();
  assert.strictEqual(blits(wnd).length, 1, 'the fast path fired');
  assert.ok(
    !covered(root._lastDamageRects, { x: 0, y: 0, width: 400, height: 40 }),
    'nothing asked for the banner',
  );
});

test('a fixed rect that covers most of the viewport makes the scroll a repaint', async () => {
  // a fixed background, fixed to the whole viewport: nothing the copy moves
  // is right, so it is not made
  const { wnd, ref } = await mount({ banner: 400 });
  ref.current.scrollTo(48);
  await tick();
  assert.deepStrictEqual(blits(wnd), [], 'no blit');
});

test('only the nearest scroll pane pins it', async () => {
  // the outer pane moves the inner one, and what is fixed to that, with its
  // content: its scroll blits as though nothing were fixed
  const { wnd, root, ref } = await mount({}, { nested: true });
  ref.current.scrollTo(48);
  await tick();
  assert.strictEqual(blits(wnd).length, 1, 'the outer pane blits');
  // the inner pane 100px down the content, now 52px down the window
  assert.ok(
    !covered(root._lastDamageRects, { x: 0, y: 52, width: 400, height: 40 }),
    `the inner pane's banner rode the copy: ${JSON.stringify(root._lastDamageRects)}`,
  );
});

// --- pixel truth against the real ntk + in-process X server --------------

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

test('a blitted scroll with a fixed banner is byte-identical to its repaint', async (t) => {
  const app = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const instance = await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: 400, height: 300, style: { backgroundColor: '#f5f6fa' } },
          h(
            'box',
            { ref, style: { overflow: 'scroll', flexGrow: 1 } },
            h('fixeddoc', { style: { height: 1600, flexShrink: 0 } }),
          ),
        ),
        resolve,
      ),
    );
    if (typeof instance.scrollRegion !== 'function') {
      t.skip('installed ntk has no Window.scrollRegion yet');
      return;
    }
    const root = instance._reactX11Node;
    const frame = () => {
      root._scheduled = false;
      root.flush();
    };
    frame();
    await settle(app);
    let blitCalls = 0;
    const realScrollRegion = instance.scrollRegion.bind(instance);
    instance.scrollRegion = (...args) => {
      blitCalls += 1;
      return realScrollRegion(...args);
    };
    for (const to of [48, 96, 60]) {
      ref.current.scrollTo(to);
      frame();
      await settle(app);
    }
    assert.strictEqual(blitCalls, 3, 'every scroll took the fast path');
    const blitted = await readPixels(root._ctx, 400, 300);
    root.invalidate(false);
    frame();
    await settle(app);
    const repainted = await readPixels(root._ctx, 400, 300);
    assert.ok(
      Buffer.from(blitted.data).equals(Buffer.from(repainted.data)),
      'blitted pixels differ from a full repaint of the same state',
    );
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});
