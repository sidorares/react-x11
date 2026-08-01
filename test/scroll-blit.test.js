// The scroll-blit fast path (issue #138): a pure scroll asks ntk to
// CopyArea the surviving band (Window.scrollRegion, sidorares/ntk#139) and
// repaints only the exposed strip plus the scrollbar repair rects. Every
// gate must fall back to the full-viewport repaint scrollTo always claimed.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import ReactX11 from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// 20 rows of 40px in a 400x400 window: content 800, plenty to scroll, and
// a viewport comfortably above the worth-it area gate.
function mount({ windowProps = {}, scrollProps = {}, extra = null } = {}) {
  const app = createMockApp();
  const ref = React.createRef();
  ReactX11.render(
    h(
      'window',
      { width: 400, height: 400, ...windowProps },
      h(
        'scrollview',
        { ref, style: { flexGrow: 1 }, ...scrollProps },
        ...Array.from({ length: 20 }, (_, i) =>
          h('box', {
            key: i,
            style: {
              height: 40,
              flexShrink: 0,
              backgroundColor: i % 2 ? '#ffffff' : '#eef1f5',
            },
          }),
        ),
      ),
      extra,
    ),
    null,
    app,
  );
  const wnd = app.windows[0];
  return { app, wnd, root: wnd._reactX11Node, ref };
}

const blits = (wnd) => wnd.calls.filter(([name]) => name === 'scrollRegion');

test('a pure scroll blits the viewport and claims only the strip and thumb', async () => {
  const { wnd, root, ref } = mount();
  await tick();
  wnd.calls.length = 0;

  ref.current.scrollTo(48);
  await tick();

  assert.deepStrictEqual(blits(wnd), [
    ['scrollRegion', { x: 0, y: 0, width: 400, height: 400 }, 0, -48],
  ]);
  const rects = root._lastDamageRects;
  assert.ok(rects, 'the frame stayed bounded');
  const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
  assert.ok(
    area < 400 * 400 * 0.25,
    `repainted ${area}px² — the strip and thumb rects, not the viewport ` +
      JSON.stringify(rects),
  );
  // the exposed strip is the bottom 48 rows
  const strip = rects.find((r) => r.width === 400);
  assert.ok(strip, `a full-width strip in ${JSON.stringify(rects)}`);
  assert.strictEqual(strip.y + strip.height, 400);
  assert.ok(strip.height >= 48);
});

test('scrolling back up exposes a strip at the top', async () => {
  const { wnd, root, ref } = mount();
  await tick();
  ref.current.scrollTo(96);
  await tick();
  wnd.calls.length = 0;

  ref.current.scrollTo(48);
  await tick();
  assert.deepStrictEqual(blits(wnd), [
    ['scrollRegion', { x: 0, y: 0, width: 400, height: 400 }, 0, 48],
  ]);
  const strip = root._lastDamageRects.find((r) => r.width === 400);
  assert.strictEqual(strip.y, 0);
  assert.ok(strip.height >= 48);
});

test('several scrollTo calls in one frame blit once, by the net delta', async () => {
  const { wnd, ref } = mount();
  await tick();
  wnd.calls.length = 0;
  ref.current.scrollBy(48);
  ref.current.scrollBy(48);
  ref.current.scrollBy(-16);
  await tick();
  assert.deepStrictEqual(blits(wnd), [
    ['scrollRegion', { x: 0, y: 0, width: 400, height: 400 }, 0, -80],
  ]);
});

test('other damage inside the viewport keeps the full repaint', async () => {
  const { wnd, root, ref } = mount();
  await tick();
  const row = root.children[0].children[2];
  wnd.calls.length = 0;
  ref.current.scrollTo(48);
  // a second change lands in the same frame, inside the viewport
  root.invalidate(false, row);
  await tick();
  assert.strictEqual(blits(wnd).length, 0, 'not a pure scroll: no blit');
});

test('a fractional target keeps the full repaint', async () => {
  const { wnd, ref } = mount();
  await tick();
  wnd.calls.length = 0;
  ref.current.scrollTo(48.5);
  await tick();
  assert.strictEqual(blits(wnd).length, 0);
});

test('a small viewport is not worth the bookkeeping', async () => {
  const app = createMockApp();
  const ref = React.createRef();
  ReactX11.render(
    h(
      'window',
      { width: 200, height: 100 },
      h(
        'scrollview',
        { ref, style: { flexGrow: 1 } },
        ...Array.from({ length: 10 }, (_, i) =>
          h('box', { key: i, style: { height: 40, flexShrink: 0 } }),
        ),
      ),
    ),
    null,
    app,
  );
  await tick();
  const wnd = app.windows[0];
  wnd.calls.length = 0;
  ref.current.scrollTo(40);
  await tick();
  assert.strictEqual(blits(wnd).length, 0);
});

test('a page-sized jump repaints instead of blitting a sliver', async () => {
  const { wnd, ref } = mount();
  await tick();
  wnd.calls.length = 0;
  ref.current.scrollTo(240); // 60% of the viewport: less than half survives
  await tick();
  assert.strictEqual(blits(wnd).length, 0);
});

test('a border on the scrollview keeps the full repaint', async () => {
  const { wnd, ref } = mount({
    scrollProps: {
      style: { flexGrow: 1, borderWidth: 2, borderColor: '#333333' },
    },
  });
  await tick();
  wnd.calls.length = 0;
  ref.current.scrollTo(48);
  await tick();
  assert.strictEqual(blits(wnd).length, 0);
});

test('an overlapping sibling above the viewport keeps the full repaint', async () => {
  const { wnd, ref } = mount({
    extra: h('box', {
      style: {
        position: 'absolute',
        left: 150,
        top: 150,
        width: 100,
        height: 40,
        backgroundColor: '#ffcc00',
      },
    }),
  });
  await tick();
  wnd.calls.length = 0;
  ref.current.scrollTo(48);
  await tick();
  assert.strictEqual(blits(wnd).length, 0, 'its pixels must not be dragged');
});

test('an ntk without scrollRegion gets the old behavior untouched', async () => {
  const { wnd, root, ref } = mount();
  await tick();
  delete wnd.scrollRegion;
  wnd.calls.length = 0;
  ref.current.scrollTo(48);
  await tick();
  assert.strictEqual(blits(wnd).length, 0);
  // the claim stays the viewport — which fills this window, so the frame
  // reports the old full repaint
  assert.strictEqual(root._lastDamage, null);
});

test('a refused blit falls back to the full repaint', async () => {
  const { wnd, root, ref } = mount();
  await tick();
  wnd.scrollRegion = () => false; // e.g. ntk with no valid backing store
  ref.current.scrollTo(48);
  await tick();
  assert.strictEqual(root._lastDamage, null);
});

test('the scrolled thumb is repainted at both its old and new place', async () => {
  const { wnd, root, ref } = mount();
  await tick();
  // start mid-list, so the dragged copy of the old thumb stays on screen
  ref.current.scrollTo(96);
  await tick();
  const sv = root.children[0];
  const before = sv._scrollbar('y');
  wnd.calls.length = 0;
  ref.current.scrollTo(144);
  await tick();
  const after = sv._scrollbar('y');
  assert.notStrictEqual(before.thumbStart, after.thumbStart);
  const rects = root._lastDamageRects;
  const covers = (r, x, y) =>
    x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
  // the new thumb, and the blit-dragged copy of the old one (shifted up)
  for (const point of [
    [after.x + 3, after.y + 3],
    [before.x + 3, before.y + 3 - 48],
  ]) {
    assert.ok(
      rects.some((r) => covers(r, point[0], point[1])),
      `damage misses thumb pixel at ${point}: ${JSON.stringify(rects)}`,
    );
  }
});

// --- pixel truth against the real ntk + in-process X server --------------
//
// The whole optimisation stands on one invariant: a blitted scroll frame is
// byte-identical to the full repaint it replaced. Skipped when the
// installed ntk has no scrollRegion yet (the fast path never fires there,
// which the mock tests above already cover).

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

test('a blitted scroll is byte-identical to the repaint it replaced', async (t) => {
  const app = await createHeadlessApp();
  try {
    const ref = React.createRef();
    const instance = await new Promise((resolve) =>
      ReactX11.render(
        h(
          'window',
          { width: 400, height: 300, style: { backgroundColor: '#f5f6fa' } },
          h(
            'scrollview',
            { ref, style: { flexGrow: 1 } },
            ...Array.from({ length: 40 }, (_, i) =>
              h(
                'box',
                {
                  key: i,
                  style: {
                    height: 40,
                    flexShrink: 0,
                    padding: 6,
                    backgroundColor: i % 2 ? '#ffffff' : '#dbe4ee',
                  },
                },
                h(
                  'text',
                  { style: { fontSize: 12, color: '#20304a' } },
                  `row ${i} — some content`,
                ),
              ),
            ),
          ),
        ),
        resolve,
        app,
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

    // scroll through the fast path, and prove it really took it
    let blitCalls = 0;
    const realScrollRegion = instance.scrollRegion.bind(instance);
    instance.scrollRegion = (...args) => {
      blitCalls += 1;
      return realScrollRegion(...args);
    };
    ref.current.scrollTo(48);
    frame();
    await settle(app);
    assert.strictEqual(blitCalls, 1, 'the fast path fired');
    assert.ok(root._lastDamageRects, 'and the frame stayed bounded');
    const blitted = await readPixels(root._ctx, 400, 300);

    // repaint the same state from scratch: the ground truth
    root.invalidate(false);
    frame();
    await settle(app);
    const repainted = await readPixels(root._ctx, 400, 300);
    assert.ok(
      Buffer.from(blitted.data).equals(Buffer.from(repainted.data)),
      'blitted pixels differ from a full repaint of the same state',
    );
  } finally {
    ReactX11.unmountComponentAtNode(app);
    await app.close();
  }
});
