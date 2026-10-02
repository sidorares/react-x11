// What a `scrollIntoView` claims (issue #813).
//
// Focus asks the nearest scroll pane to show the node it lands on, and the
// request waits for the next layout pass, since the node may not be laid
// out yet. It used to claim the pane's whole viewport when it was made —
// before anyone knew whether the pass would move anything, and most of the
// time it does not: a Tab to the next field of a form is a Tab to a field
// already on screen. So every Tab inside a pane repainted every visible row.
//
// Now the request claims nothing, a pass that finds the node in view leaves
// the frame to the focus rings, and one that does move the pane moves it the
// way a scroll does — through the blit, which copies what stays on screen.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

const XK_TAB = 0xff09;
function pressTab(app, wnd) {
  const keycode = (XK_TAB % 248) + 8;
  app.X.keycode2keysyms[keycode] = [XK_TAB];
  wnd.emit('keydown', { keycode, buttons: 0 });
}

// A field is a focusable box, which draws the focus ring a `<textinput>`
// does, without the caret: that blinks on a timer of its own, and a pixel
// comparison would race it.
const field = (name) =>
  h('box', {
    key: name,
    focusable: true,
    style: {
      height: 24,
      flexShrink: 0,
      backgroundColor: '#ffffff',
      borderWidth: 1,
      borderColor: '#8a96a8',
    },
  });
const rows = (from, count) =>
  Array.from({ length: count }, (_, i) =>
    h(
      'box',
      {
        key: `row${from + i}`,
        style: {
          height: 20,
          flexShrink: 0,
          backgroundColor: (from + i) % 2 ? '#ffffff' : '#e6ebf2',
        },
      },
      h('text', null, `row ${from + i}`),
    ),
  );

/**
 * A 300px pane: fields `a` and `b` at its top, twelve rows, field `c` just
 * below the fold (288..312), and rows enough after it to scroll.
 */
const form = (ref) =>
  h(
    'window',
    { width: 320, height: 320, style: { backgroundColor: '#f5f6fa' } },
    h(
      'box',
      { ref, style: { width: 300, height: 300, overflow: 'scroll' } },
      field('a'),
      field('b'),
      ...rows(0, 12),
      field('c'),
      ...rows(12, 28),
    ),
  );

async function mountForm() {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  x11Root.render(form(ref));
  await tick();
  const wnd = app.windows[0];
  const root = wnd._reactX11Node;
  const pane = ref.current;
  const [a, b, c] = [0, 1, 14].map((i) => pane.children[i]);
  return { app, x11Root, wnd, root, pane, a, b, c };
}

const blits = (wnd) => wnd.calls.filter(([name]) => name === 'scrollRegion');
const area = (rects) => rects.reduce((sum, r) => sum + r.width * r.height, 0);

test('a Tab to a field already in view repaints the two fields, not the pane', async () => {
  const { app, x11Root, wnd, root, pane, a, b } = await mountForm();
  root.events.focus(a, 'key');
  await tick();
  wnd.calls.length = 0;

  pressTab(app, wnd);
  await tick();
  assert.ok(root.events.focused === b, 'Tab reached b');
  assert.equal(pane.scrollY, 0, 'nothing scrolled');
  const rects = root._lastDamageRects;
  assert.ok(rects, 'the frame stayed bounded');
  // `a` and `b` are 0..48; their rings reach a few pixels past that, and
  // the rows under them start at 48 — the viewport is 300 tall
  for (const r of rects) {
    assert.ok(
      r.y + r.height < 64,
      `the frame reached ${JSON.stringify(r)}: the pane's rows, not just ` +
        `the two fields (${JSON.stringify(rects)})`,
    );
  }
  assert.deepEqual(blits(wnd), [], 'and moved nothing');
  await x11Root.unmount();
});

test('a Tab to a field below the fold scrolls by the blit', async () => {
  const { app, x11Root, wnd, root, pane, a, b, c } = await mountForm();
  root.events.focus(a, 'key');
  await tick();
  pressTab(app, wnd);
  await tick();
  assert.ok(root.events.focused === b, 'Tab reached b');
  wnd.calls.length = 0;

  pressTab(app, wnd);
  await tick();
  assert.ok(root.events.focused === c, 'Tab reached c');
  assert.equal(pane.scrollY, 12, "c's bottom edge came into view");
  assert.deepEqual(blits(wnd), [
    ['scrollRegion', { x: 0, y: 0, width: 300, height: 300 }, 0, -12],
  ]);
  const rects = root._lastDamageRects;
  assert.ok(rects, 'the frame stayed bounded');
  assert.ok(
    area(rects) < 300 * 300 * 0.5,
    `repainted ${area(rects)}px²: the strip, the thumb and the two rings, ` +
      `not the viewport (${JSON.stringify(rects)})`,
  );
  await x11Root.unmount();
});

test('a request that finds its node in view claims nothing on its own', async () => {
  const { x11Root, wnd, root, pane, b } = await mountForm();
  wnd.calls.length = 0;
  pane.scrollIntoView(b);
  await tick();
  assert.equal(pane.scrollY, 0);
  assert.deepEqual(
    root._lastDamageRects ?? 'unbounded',
    [],
    'the frame painted nothing',
  );
  await x11Root.unmount();
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

/** Mount `element` on a real server, with the frame and the readback the
 * tests drive by hand, and the blits the window makes counted. */
async function mountReal(t, element) {
  const app = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  const instance = await new Promise((resolve) =>
    x11Root.render(element, resolve),
  );
  if (typeof instance.scrollRegion !== 'function') {
    t.skip('installed ntk has no Window.scrollRegion yet');
    await x11Root.unmount();
    await app.close();
    return null;
  }
  const root = instance._reactX11Node;
  const frame = async () => {
    root._scheduled = false;
    root.flush();
    await settle(app);
  };
  const counted = { blits: 0 };
  const scrollRegion = instance.scrollRegion.bind(instance);
  instance.scrollRegion = (...args) => {
    counted.blits += 1;
    return scrollRegion(...args);
  };
  // what the frame just painted, against the same state repainted whole
  const matchesRepaint = async (message) => {
    const painted = await readPixels(root._ctx, 320, 320);
    root.invalidate(false);
    await frame();
    const repainted = await readPixels(root._ctx, 320, 320);
    assert.ok(
      Buffer.from(painted.data).equals(Buffer.from(repainted.data)),
      message,
    );
  };
  const close = async () => {
    await x11Root.unmount();
    await app.close();
  };
  return { app, x11Root, root, frame, counted, matchesRepaint, close };
}

test('focus moving inside a pane paints what a full repaint would, scrolling or not', async (t) => {
  const ref = React.createRef();
  const mounted = await mountReal(t, form(ref));
  if (!mounted) return;
  const { root, frame, counted, matchesRepaint, close } = mounted;
  try {
    await frame();
    const pane = ref.current;
    const [a, b, c] = [0, 1, 14].map((i) => pane.children[i]);
    root.events.focus(a, 'key');
    await frame();

    root.events.focus(b, 'key');
    await frame();
    assert.equal(pane.scrollY, 0);
    assert.ok(root._lastDamageRects, 'the frame stayed bounded');
    await matchesRepaint('a Tab that scrolls nothing left stale pixels');

    root.events.focus(c, 'key');
    await frame();
    assert.equal(pane.scrollY, 12);
    assert.equal(counted.blits, 1, 'the scroll took the blit');
    await matchesRepaint('a Tab that scrolls by the blit left stale pixels');
  } finally {
    await close();
  }
});

test('a pass that pulls the offset back under an armed request repaints what moved', async (t) => {
  // The request arms the blit and claims nothing, and in the same frame the
  // content shrinks under a pane scrolled to its end: the clamp moves every
  // row, and the viewport claim is the pass's to make — no scrollTo made it.
  const ref = React.createRef();
  const list = (count) =>
    h(
      'window',
      { width: 320, height: 320, style: { backgroundColor: '#f5f6fa' } },
      h(
        'box',
        { ref, style: { width: 300, height: 300, overflow: 'scroll' } },
        ...rows(0, count),
      ),
    );
  const mounted = await mountReal(t, list(40));
  if (!mounted) return;
  const { x11Root, frame, matchesRepaint, close } = mounted;
  try {
    await frame();
    const pane = ref.current;
    pane.scrollTo(Infinity);
    await frame();
    assert.equal(pane.scrollY, 500);
    // a row on screen before the clamp and after it
    pane.scrollIntoView(pane.children[35]);
    x11Root.render(list(36));
    await frame();
    assert.equal(pane.scrollY, 420, 'the clamp pulled the offset back');
    await matchesRepaint('the rows the clamp moved were left where they were');
  } finally {
    await close();
  }
});
