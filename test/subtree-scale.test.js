// `scale` on an element: CSS `zoom` for one subtree, on top of the display
// scale everything else in the renderer already runs at (src/scale.js,
// docs/scale.md "A subtree of its own").
//
// The contract in one line: a node's effective scale is its parent's times
// its own `scale` prop, and its *own* style scales with it — so a zoomed
// card is a bigger card with bigger text and bigger checkboxes in it, not a
// bigger card with the same 14px form spilling out of the clip.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { renderX11 } from '../src/testing/index.js';
import { createMockApp, spinWheel } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function mount(element, { scale = 1 } = {}) {
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
const box = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height });

test('the scaled node lays out at its own zoomed style, and so do its children', async () => {
  const { root, node } = await mount(
    h(
      'window',
      { title: 't', width: 400, height: 300 },
      h(
        'box',
        { scale: 2, style: { margin: 10, padding: 8, width: 100, height: 50 } },
        h('box', { style: { width: 20, height: 20 } }),
      ),
    ),
  );
  const zoomed = child(node);
  // CSS `zoom`: the node's own margin, padding and size are doubled too
  assert.deepStrictEqual(box(zoomed.abs), {
    x: 20,
    y: 20,
    width: 200,
    height: 100,
  });
  assert.deepStrictEqual(box(child(zoomed).abs), {
    x: 36,
    y: 36,
    width: 40,
    height: 40,
  });
  assert.strictEqual(zoomed.scale, 2);
  assert.strictEqual(child(zoomed).scale, 2);
  await root.unmount();
});

test('nested scales multiply, and a sibling outside is untouched', async () => {
  const { root, node } = await mount(
    h(
      'window',
      { title: 't', width: 400, height: 300 },
      h(
        'box',
        { scale: 2, style: { width: 100, height: 100 } },
        h('box', { scale: 1.5, style: { width: 10, height: 10 } }),
      ),
      h('box', { style: { width: 10, height: 10 } }),
    ),
  );
  const outer = child(node, 0);
  const inner = child(outer);
  assert.strictEqual(inner.scale, 3);
  assert.strictEqual(inner.abs.width, 30);
  const plain = child(node, 1);
  assert.strictEqual(plain.scale, 1);
  assert.strictEqual(plain.abs.width, 10);
  await root.unmount();
});

test('the display scale is the floor the prop multiplies', async () => {
  const { root, node } = await mount(
    h(
      'window',
      { title: 't', width: 400, height: 300 },
      h('box', { scale: 1.5, style: { width: 100, height: 20 } }),
    ),
    { scale: 2 },
  );
  const zoomed = child(node);
  assert.strictEqual(zoomed.scale, 3);
  assert.strictEqual(zoomed.abs.width, 300);
  await root.unmount();
});

test('text sizes follow the zoom — the theme font size and an explicit one', async () => {
  const { root, node } = await mount(
    h(
      'window',
      { title: 't', width: 400, height: 300 },
      h(
        'box',
        { scale: 2 },
        h('text', null, 'themed'),
        h('text', { style: { fontSize: 10 } }, 'sized'),
        // an element two deep inherits the already-device size and must not
        // multiply it a second time
        h('box', null, h('text', null, 'deep')),
      ),
      h('text', null, 'outside'),
    ),
  );
  const zoomed = child(node, 0);
  // DefaultTheme.fontSize is 14 logical
  assert.strictEqual(child(zoomed, 0).resolvedTextStyle().size, 28);
  assert.strictEqual(child(zoomed, 1).resolvedTextStyle().size, 20);
  assert.strictEqual(child(child(zoomed, 2)).resolvedTextStyle().size, 28);
  assert.strictEqual(child(node, 1).resolvedTextStyle().size, 14);
  await root.unmount();
});

test('re-zooming a mounted subtree lands exactly where a fresh mount at that zoom does', async () => {
  const tree = (zoom) =>
    h(
      'window',
      { title: 't', width: 400, height: 300 },
      h(
        'box',
        { scale: zoom, style: { padding: 6, alignSelf: 'flex-start' } },
        h('box', { style: { width: 40, height: 12, margin: 3 } }),
        h('text', { style: { fontSize: 11 } }, 'label'),
      ),
    );
  const live = await mount(tree(1));
  live.root.render(tree(1.6));
  await tick();
  live.wnd.flushFrame?.();
  await tick();
  const fresh = await mount(tree(1.6));

  const shape = (node) => ({
    scale: node.scale,
    abs: box(node.abs),
    size: node.resolvedTextStyle().size,
    kids: node.children.map(shape),
  });
  assert.deepStrictEqual(shape(child(live.node)), shape(child(fresh.node)));
  await live.root.unmount();
  await fresh.root.unmount();
});

test('a node mounted into a zoomed subtree later resolves against it', async () => {
  const tree = (extra) =>
    h(
      'window',
      { title: 't', width: 400, height: 300 },
      h(
        'box',
        { scale: 2 },
        h('box', { key: 'a', style: { width: 10, height: 10 } }),
        extra ? h('box', { key: 'b', style: { width: 30, height: 10 } }) : null,
      ),
    );
  const { root, node, wnd } = await mount(tree(false));
  root.render(tree(true));
  await tick();
  wnd.flushFrame?.();
  await tick();
  const added = child(child(node), 1);
  assert.strictEqual(added.scale, 2);
  assert.strictEqual(added.abs.width, 60);
  await root.unmount();
});

test('a `<popup>` written inside a zoomed subtree is not zoomed: a window is its own root', async () => {
  const tree = (zoom) =>
    h(
      'window',
      { title: 't', width: 400, height: 300 },
      h(
        'box',
        { scale: zoom },
        h('text', null, 'card'),
        h(
          'popup',
          { width: 100, height: 40 },
          h('box', { style: { width: 20, height: 20 } }),
        ),
      ),
    );
  const { root, node, wnd } = await mount(tree(2));
  const zoomed = child(node);
  const popup = zoomed.children.find((n) => n.isWindow);
  assert.strictEqual(popup.scale, 1);
  assert.strictEqual(child(popup).scale, 1);
  assert.strictEqual(child(popup).abs.width, 20);
  // the menu's text goes back to the app's own size, not the card's
  assert.strictEqual(popup.resolvedTextStyle().size, 14);
  // …and a live re-zoom walks past it rather than through it
  root.render(tree(3));
  await tick();
  wnd.flushFrame?.();
  await tick();
  assert.strictEqual(zoomed.scale, 3);
  assert.strictEqual(popup.scale, 1);
  assert.strictEqual(child(popup).scale, 1);
  assert.strictEqual(child(popup).abs.width, 20);
  await root.unmount();
});

test('the public rects and pointer coordinates are in the target’s own unit', async () => {
  const seen = [];
  const { root, wnd, node } = await mount(
    h(
      'window',
      { title: 't', width: 400, height: 300 },
      h(
        'box',
        { scale: 2, style: { margin: 5 } },
        h('box', {
          style: { width: 50, height: 30 },
          onMouseDown: (ev) => seen.push([ev.x, ev.y, ev.localX, ev.localY]),
        }),
      ),
    ),
  );
  const inner = child(child(node));
  // device rect: margin 5 x 2 = 10, size 50 x 2 = 100
  assert.deepStrictEqual(box(inner.abs), {
    x: 10,
    y: 10,
    width: 100,
    height: 60,
  });
  // …and the same rect, read back through the public API, is the logical
  // one the subtree was written in
  const [rect] = inner.getClientRects();
  assert.deepStrictEqual(box(rect), { x: 5, y: 5, width: 50, height: 30 });
  // a press at device (30, 30) — 15,15 in the subtree's unit, 10,10 into it
  wnd.emit('mousedown', { x: 30, y: 30, keycode: 1, buttons: 0 });
  assert.deepStrictEqual(seen, [[15, 15, 10, 10]]);
  await root.unmount();
});

test('a wheel inside a zoomed scroller moves the zoomed distance', async () => {
  const { root, wnd, node } = await mount(
    h(
      'window',
      { title: 't', width: 200, height: 200 },
      h(
        'box',
        { scale: 2 },
        h(
          'box',
          { style: { width: 50, height: 50, overflow: 'scroll' } },
          h('box', { style: { width: 50, height: 400 } }),
        ),
      ),
    ),
  );
  const scroller = child(child(node));
  spinWheel(wnd, 20, 20, { deltaY: 1 });
  await tick();
  // one notch is WHEEL_NOTCH_PX (48) of the scroller's own logical pixels,
  // which are two device pixels each here
  assert.strictEqual(scroller.scrollY, 48 * 2);
  // and the handler-facing offset is that subtree's logical unit again
  assert.strictEqual(scroller.getClientRects()[0].width, 50);
  await root.unmount();
});

test('a scale that is not a positive number is a mistake, and says so', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    for (const bad of [0, -2, Number.NaN, '2']) {
      await assert.rejects(
        () => renderX11(h('box', { scale: bad }), { backend: 'mock' }),
        /a subtree scale is a positive number/,
        `scale={${JSON.stringify(bad)}} should be rejected`,
      );
    }
  } finally {
    console.error = origError;
  }
});
