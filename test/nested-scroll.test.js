// A scroll pane inside another one moves its content when it scrolls.
//
// The outer pane's fast path (issue #405) returns without walking anything
// when nothing inside it was laid out and its own offset held — which is
// every frame in which only the *inner* pane scrolled. The inner pane's
// children were then never placed again: its thumb moved (it reads the
// offset directly) while its rows stayed where they were, and the scroll
// blit copied those stale rows into the strip it exposed — a list smeared
// into repeats of the same few rows.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp, flushFrames, spinWheel } from './helpers/mock-app.js';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const ROW = 24;

const rows = (n) =>
  Array.from({ length: n }, (_, i) =>
    h(
      'box',
      {
        key: i,
        style: {
          height: ROW,
          flexShrink: 0,
          padding: 4,
          backgroundColor: i % 2 ? '#ffffff' : '#dbe4ee',
        },
      },
      h('text', { style: { fontSize: 12, color: '#20304a' } }, `row ${i}`),
    ),
  );

/** A list pane inside a box that scrolls too, each as tall as the other. */
const tree = (ref, { outerScrolls = true, more = null } = {}) =>
  h(
    'window',
    { width: 300, height: 400, style: { backgroundColor: '#f5f6fa' } },
    h(
      'box',
      {
        style: {
          flexGrow: 1,
          minHeight: 0,
          overflow: outerScrolls ? 'scroll' : 'visible',
        },
      },
      h(
        'box',
        { style: { flexGrow: 1, minHeight: 0 } },
        h(
          'box',
          { ref, style: { flexGrow: 1, minHeight: 0, overflow: 'scroll' } },
          ...rows(400),
        ),
      ),
      more,
    ),
  );

async function mount(options) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  x11Root.render(tree(ref, options));
  await tick();
  const wnd = app.windows[0];
  flushFrames(wnd);
  await tick();
  return { wnd, pane: ref.current };
}

/** The row whose box covers the top edge of the pane's viewport. */
function topRow(pane) {
  const y = pane.abs.y;
  return pane.children.findIndex(
    (row) => row.abs.y <= y && row.abs.y + row.abs.height > y,
  );
}

for (const outerScrolls of [true, false]) {
  const where = outerScrolls ? 'inside a scroll pane' : 'inside a plain box';

  test(`a wheel notch moves a list ${where}`, async () => {
    const { wnd, pane } = await mount({ outerScrolls });
    for (let i = 0; i < 40; i++) {
      spinWheel(wnd, 150, 200, { deltaY: 1 });
      flushFrames(wnd);
      await tick();
    }
    assert.strictEqual(pane.scrollY, 40 * 48);
    assert.strictEqual(topRow(pane), (40 * 48) / ROW);
    assert.strictEqual(pane.children[80].abs.y, pane.abs.y);
  });

  test(`smooth scrolling moves a list ${where}`, async () => {
    const { wnd, pane } = await mount({ outerScrolls });
    for (let i = 0; i < 100; i++) {
      spinWheel(wnd, 150, 200, { deltaY: 0.37, smooth: true });
      flushFrames(wnd);
      await tick();
    }
    assert.ok(pane.scrollY > 1000, `scrolled to ${pane.scrollY}`);
    assert.strictEqual(topRow(pane), Math.floor(pane.scrollY / ROW));
    const first = pane.children[0];
    assert.strictEqual(first.abs.y, pane.abs.y - pane.scrollY);
  });
}

test('scrollTo on a nested pane places its rows in the same frame', async () => {
  const { wnd, pane } = await mount();
  pane.scrollTo(240);
  flushFrames(wnd);
  assert.strictEqual(pane.children[10].abs.y, pane.abs.y);
});

test('a pane two scroll panes down moves too', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  const pane = (child, props = {}) =>
    h(
      'box',
      { ...props, style: { flexGrow: 1, minHeight: 0, overflow: 'scroll' } },
      child,
    );
  x11Root.render(
    h(
      'window',
      { width: 300, height: 400 },
      pane(
        pane(
          h(
            'box',
            { ref, style: { flexGrow: 1, minHeight: 0, overflow: 'scroll' } },
            ...rows(400),
          ),
        ),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  flushFrames(wnd);
  ref.current.scrollTo(480);
  flushFrames(wnd);
  assert.strictEqual(ref.current.children[20].abs.y, ref.current.abs.y);
});

// --- pixel truth --------------------------------------------------------------

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

test('a nested pane blits its scroll, byte-identical to a repaint', async (t) => {
  const app = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const instance = await new Promise((resolve) =>
      x11Root.render(tree(ref), resolve),
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
    for (let i = 1; i <= 6; i++) {
      ref.current.scrollBy(48);
      frame();
      await settle(app);
      assert.strictEqual(blitCalls, i, `step ${i} took the fast path`);
      assert.ok(root._lastDamageRects, `and step ${i} stayed bounded`);
      const blitted = await readPixels(root._ctx, 300, 400);

      root.invalidate(false);
      frame();
      await settle(app);
      const repainted = await readPixels(root._ctx, 300, 400);
      assert.ok(
        Buffer.from(blitted.data).equals(Buffer.from(repainted.data)),
        `step ${i}: blitted pixels differ from a full repaint`,
      );
    }
    assert.strictEqual(ref.current.children[12].abs.y, ref.current.abs.y);
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});

test('an extent change announced inside a nested pane is measured', async () => {
  const { wnd, pane } = await mount();
  const was = pane.contentHeight;
  // what an element that paints its own content does when that content
  // grows: yoga sees nothing, and the announcement is the only signal
  const measure = pane.measureScrollContent.bind(pane);
  pane.measureScrollContent = () => {
    const size = measure();
    return { width: size.width, height: size.height + 500 };
  };
  pane.children[3].invalidate(true, pane.children[3], 'scroll');
  flushFrames(wnd);
  assert.strictEqual(pane.contentHeight, was + 500);
});
