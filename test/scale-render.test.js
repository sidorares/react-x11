// The display scale, end to end through the renderer: logical pixels on
// every application-facing surface, device pixels on every internal one,
// converted exactly once at each boundary (src/scale.js, docs/scale.md).
//
// Everything here runs at `scale: 2` against the headless mock and asserts
// both sides of the boundary at once: the style an app wrote (logical) and
// the geometry the server was told (device). The 1x world needs no tests of
// its own — every suite in this directory is one, since 1x is the identity
// fast path through the same code.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Render one tree at the given scale, hand back the mock window. */
async function mount(element, { scale = 2 } = {}) {
  const app = createMockApp();
  const root = await createRoot({ app, scale });
  root.render(element);
  await tick();
  const wnd = app.windows[0];
  wnd?.flushFrame?.();
  await tick();
  return { app, root, wnd, node: wnd?._reactX11Node };
}

const child = (node, i = 0) => node.children[i];

test('layout: styles are logical, yoga and abs are device', async () => {
  const { root, wnd, node } = await mount(
    h(
      'window',
      { title: 't', width: 300, height: 200 },
      h(
        'box',
        { style: { margin: 10, width: 100, height: 50, padding: 8 } },
        h('box', { style: { width: 20, height: 20 } }),
      ),
    ),
  );
  // the window is created at device size...
  assert.strictEqual(wnd.width, 600);
  assert.strictEqual(wnd.height, 400);
  // ...the outer box lays out at twice its logical style...
  const outer = child(node);
  assert.deepStrictEqual(outer.abs, { x: 20, y: 20, width: 200, height: 100 });
  // ...and padding positions the inner child in device pixels too
  const inner = child(outer);
  assert.deepStrictEqual(inner.abs, { x: 36, y: 36, width: 40, height: 40 });
  await root.unmount();
});

test('the public rect APIs hand the logical numbers back', async () => {
  const { root, node } = await mount(
    h(
      'window',
      { title: 't', width: 300, height: 200 },
      h('box', { style: { margin: 10, width: 100, height: 50 } }),
    ),
  );
  const outer = child(node);
  const [rect] = outer.getClientRects();
  assert.deepStrictEqual(
    { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    { x: 10, y: 10, width: 100, height: 50 },
  );
  let measured;
  outer.measure((...args) => (measured = args));
  assert.deepStrictEqual(measured, [10, 10, 100, 50, 10, 10]);
  await root.unmount();
});

test('an auto-sized window measures its content in device pixels', async () => {
  const { root, wnd } = await mount(
    h(
      'window',
      { title: 'natural' },
      h(
        'box',
        { style: { padding: 10, flexDirection: 'row', gap: 8 } },
        h('box', { style: { width: 120, height: 40 } }),
        h('box', { style: { width: 300, height: 80 } }),
      ),
    ),
  );
  // (10 + 120 + 8 + 300 + 10) x (10 + 80 + 10) logical, times two
  assert.strictEqual(wnd.width, 896);
  assert.strictEqual(wnd.height, 200);
  await root.unmount();
});

test('WM size hints are written in device pixels', async () => {
  const { root, wnd } = await mount(
    h('window', {
      title: 't',
      width: 300,
      height: 200,
      minWidth: 150,
      maxWidth: 500,
      widthInc: 10,
    }),
  );
  const hints = wnd.attributes?.sizeHints ?? wnd.sizeHints;
  assert.strictEqual(hints.minWidth, 300);
  assert.strictEqual(hints.maxWidth, 1000);
  assert.strictEqual(hints.widthInc, 20);
  await root.unmount();
});

test('font sizes resolve at device size, from a logical style and theme', async () => {
  const { root, node } = await mount(
    h(
      'window',
      { title: 't', width: 300, height: 200 },
      h('text', { style: { fontSize: 14 } }, 'sized'),
      h('text', null, 'themed'),
    ),
  );
  const sized = child(node, 0);
  const themed = child(node, 1);
  assert.strictEqual(sized.resolvedTextStyle().size, 28);
  // DefaultTheme.fontSize is 14 logical; the cascade enters device once,
  // at the root (inheritedTextStyle)
  assert.strictEqual(themed.resolvedTextStyle().size, 28);
  await root.unmount();
});

test('pointer events arrive logical, in both x/y and localX/localY', async () => {
  const seen = [];
  const { root, wnd } = await mount(
    h(
      'window',
      { title: 't', width: 300, height: 200 },
      h('box', {
        style: { margin: 10, width: 100, height: 50 },
        onMouseDown: (ev) => seen.push([ev.x, ev.y, ev.localX, ev.localY]),
      }),
    ),
  );
  // a press at device (40, 40) is inside the box (device rect 20..220)
  wnd.emit('mousedown', { x: 40, y: 40, keycode: 1, buttons: 0 });
  assert.deepStrictEqual(seen, [[20, 20, 10, 10]]);
  await root.unmount();
});

test('scroll speaks logical on the ref and in onScroll', async () => {
  const events = [];
  const { root, node } = await mount(
    h(
      'window',
      { title: 't', width: 100, height: 100 },
      h(
        'box',
        {
          style: { width: 80, height: 80, overflow: 'scroll' },
          onScroll: (ev) => events.push(ev),
        },
        h('box', { style: { width: 80, height: 300 } }),
      ),
    ),
  );
  const scroller = child(node);
  scroller.scrollTo({ y: 30 });
  // internal offset is device...
  assert.strictEqual(scroller.scrollY, 60);
  // ...the handler heard logical, including the extents
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].scrollY, 30);
  assert.strictEqual(events[0].contentHeight, 300);
  assert.strictEqual(events[0].viewportHeight, 80);
  // scrollBy accumulates in the same unit and clamps in device
  scroller.scrollBy({ y: 1000 });
  assert.strictEqual(scroller.scrollY, (300 - 80) * 2);
  await root.unmount();
});

test('explicit x/y window positions are logical desktop coordinates', async () => {
  const { root, wnd } = await mount(
    h('window', { title: 't', width: 100, height: 100, x: 50, y: 25 }),
  );
  assert.strictEqual(wnd.x, 100);
  assert.strictEqual(wnd.y, 50);
  await root.unmount();
});

test('an image or svg natural size is logical, the browser rule', async () => {
  const { root, node } = await mount(
    h(
      'window',
      { title: 't', width: 200, height: 100 },
      h('image', {
        // raw RGBA decodes synchronously (test/image-source.test.js), so
        // the natural size is known at first layout: 4x2 *logical* px
        src: { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4) },
        style: { alignSelf: 'flex-start' },
      }),
    ),
  );
  const image = child(node);
  // occupies 4x2 logical like it would at 1x — which is 8x4 on the device
  // grid, upscaled the way an <img> without srcset is
  assert.deepStrictEqual([image.abs.width, image.abs.height], [8, 4]);
  await root.unmount();
});

test('a fractional scale still lands layout on whole device pixels', async () => {
  const { root, wnd, node } = await mount(
    h(
      'window',
      { title: 't', width: 200, height: 100 },
      h('box', { style: { width: 101, height: 33 } }),
    ),
    { scale: 1.5 },
  );
  assert.strictEqual(wnd.width, 300);
  assert.strictEqual(wnd.height, 150);
  const box = child(node);
  // 101 x 1.5 = 151.5 and 33 x 1.5 = 49.5: yoga's grid rounding settles
  // them onto integers, which is what keeps 1-logical-px borders crisp
  assert.strictEqual(box.abs.width, Math.round(box.abs.width));
  assert.strictEqual(box.abs.height, Math.round(box.abs.height));
  await root.unmount();
});
