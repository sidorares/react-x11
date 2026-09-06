// Layer promotion (src/cocoa/promotion.js) over a fake bridge: the real
// CocoaApp, its surface window and swapchain, the node tree and its frame
// clock — only Core Animation and CoreGraphics are faked, so what a test
// pins is the call that went out and the frame it went out in. What the
// file is about is the contract issue #483 sets: a node with an animation a
// layer can express gets a layer above the bitmap and costs no frames; the
// paint walk leaves a hole under it in the same frame; anything painted
// over it, clipping it, or ringing it keeps it on the clock; and every way
// off a layer lands back in the bitmap in the frame that finds it.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { CocoaApp } from '../src/cocoa/app.js';
import { withFrameClock } from '../src/testing/index.js';
import {
  cleanupCocoa,
  fakeCocoaBridge,
  mountCocoa,
  tick,
} from './helpers/cocoa-bridge.js';

const h = React.createElement;

afterEach(cleanupCocoa);

// device pixels: the window is scale 2
const px = (v) => v * 2;

/** The `ctxFillRect` calls that painted exactly `rect` (device pixels),
 *  on any surface, or on `surface` when given. */
const fillsOf = (native, rect, surface = null) =>
  native
    .of('ctxFillRect')
    .filter(
      ([s, x, y, w, hh]) =>
        (surface === null || s.id === surface.id) &&
        x === rect.x &&
        y === rect.y &&
        w === rect.width &&
        hh === rect.height,
    ).length;

const rootLayer = (m) => m.wnd._layer;
const layerOf = (m, node) => m.promotion.promoted.get(node)?.visual.layer;
const box = (style, ...children) => h('box', { style }, ...children);
/** …with a key, for the tests that render a list of them. */
const kbox = (key, style, ...children) => h('box', { key, style }, ...children);
const at = (left, top, width, height, more = {}) => ({
  position: 'absolute',
  left,
  top,
  width,
  height,
  ...more,
});

const fade = at(10, 10, 40, 20, {
  backgroundColor: '#ff0000',
  transition: { backgroundColor: 120 },
});
const pulse = at(10, 10, 40, 20, {
  backgroundColor: '#ff0000',
  animation: {
    backgroundColor: { to: '#00ff00', duration: 900, alternate: true },
  },
});

test('a transition on a plain box: a layer above the bitmap, the animation in the render server, a hole under it, no frames', async () => {
  const m = await mountCocoa(box(fade));
  const node = m.node.children[0];
  const rect = { x: px(10), y: px(10), width: px(40), height: px(20) };
  assert.equal(fillsOf(m.native, rect), 1, 'the mount painted it');
  assert.equal(m.wnd.animateNode !== undefined, true, 'the seam is there');

  await m.render(box({ ...fade, backgroundColor: '#0000ff' }));
  const entry = node._anim.get('backgroundColor');
  assert.ok(entry?.offloaded, 'taken off the clock at the swap');
  assert.equal(m.node._animating.size, 0);
  assert.equal(node.style.backgroundColor, '#0000ff', 'the model');
  assert.equal(node._promoted, false, 'decided by the frame, not the swap');

  const before = m.frames.count;
  m.frame();
  assert.equal(m.frames.count, before + 1, 'the one frame that sends it');
  assert.equal(node._promoted, true);
  const layer = layerOf(m, node);
  assert.equal(layer.parent, rootLayer(m), 'a sublayer of the window root');
  assert.deepEqual(layer.props.frame, [10, 10, 40, 20], 'in points');
  assert.deepEqual(layer.props.backgroundColor, [0, 0, 1, 1]);
  const anims = m.native.of('addAnimation');
  assert.equal(anims.length, 1);
  const [animLayer, keyPath, opts] = anims[0];
  assert.equal(animLayer, layer);
  assert.equal(keyPath, 'backgroundColor');
  assert.deepEqual(
    [opts.from, opts.to],
    [
      [1, 0, 0, 1],
      [0, 0, 1, 1],
    ],
  );
  // the hole: this frame repainted the bitmap under the node, without it
  const damage = m.node._lastDamageRects;
  assert.ok(
    damage?.some(
      (r) =>
        r.x <= rect.x &&
        r.y <= rect.y &&
        r.x + r.width >= rect.x + rect.width &&
        r.y + r.height >= rect.y + rect.height,
    ),
    `the frame's damage covers the node: ${JSON.stringify(damage)}`,
  );
  assert.equal(fillsOf(m.native, rect), 1, 'and the walk did not paint it');
  assert.equal(m.node._animating.size, 0, 'nothing for the clock');

  // more frames change nothing about it
  m.frame();
  assert.equal(m.native.of('addAnimation').length, 1, 'attached once');
  assert.equal(m.native.of('createLayer').length, 1);

  // a retarget while it is up there is answered on the layer: the frame
  // paints nothing into the bitmap
  await m.render(box({ ...fade, backgroundColor: '#00ff00' }));
  m.frame();
  assert.deepEqual(m.node._lastDamageRects, [], 'nothing for the bitmap');
  assert.equal(fillsOf(m.native, rect), 1);
  assert.equal(m.native.of('addAnimation').length, 2);
  assert.deepEqual(layer.props.backgroundColor, [0, 1, 0, 1]);
});

test('the render server reporting the end leaves the layer for the grace, then one frame takes the node back into the bitmap', async () => {
  const m = await mountCocoa(box(fade));
  const node = m.node.children[0];
  const rect = { x: px(10), y: px(10), width: px(40), height: px(20) };
  await m.render(box({ ...fade, backgroundColor: '#0000ff' }));
  m.frame();
  const layer = layerOf(m, node);
  const [, , opts] = m.native.of('addAnimation')[0];

  const frames = m.frames.count;
  m.native.emit({ type: 'animation-end', id: opts.id, finished: true });
  assert.ok(!node._anim?.size, 'the entry is gone');
  assert.equal(node._promoted, true, 'the layer stays for the grace');
  assert.equal(m.promotion.idle.size, 1);
  await tick();
  m.frame();
  assert.equal(m.frames.count, frames, 'and no frame was asked for');

  // a new transition inside the grace keeps it, with no layer churn
  await m.render(box({ ...fade, backgroundColor: '#00ff00' }));
  assert.equal(m.promotion.idle.size, 0);
  m.frame();
  assert.equal(m.native.of('createLayer').length, 1);
  assert.equal(m.native.of('addAnimation').length, 2);
  const [, , second] = m.native.of('addAnimation')[1];
  m.native.emit({ type: 'animation-end', id: second.id, finished: true });

  // the grace runs out
  m.promotion.releaseIdle();
  await tick();
  m.frame();
  assert.equal(m.frames.count, frames + 2, 'one frame for the release');
  assert.equal(node._promoted, false);
  assert.equal(layer.parent, null, 'the layer is off the root');
  assert.equal(m.promotion.promoted.size, 0);
  assert.equal(fillsOf(m.native, rect), 2, 'painted back in, at the model');
  assert.equal(m.node._animating.size, 0);
});

test('a pan under a promoted toast keeps its blit', async () => {
  const rows = () =>
    box(
      { flexGrow: 1, overflow: 'scroll' },
      ...Array.from({ length: 60 }, (_, i) =>
        h('box', {
          key: i,
          style: { height: 28, backgroundColor: i % 2 ? '#f6f8fb' : '#ffffff' },
        }),
      ),
    );
  const toast = at(120, 90, 60, 20, {
    right: 10,
    bottom: 10,
    borderRadius: 6,
    backgroundColor: '#2d3436',
    animation: {
      backgroundColor: { to: '#6c5ce7', duration: 900, alternate: true },
    },
  });
  for (const promote of [false, true]) {
    // big enough for the blit's worth-it heuristics: a notch is 48px of a
    // 600px viewport
    const m = await mountCocoa(
      [
        kbox('rows', rows().props.style, ...rows().props.children),
        kbox('toast', toast),
      ],
      {
        promote,
        width: 400,
        height: 300,
      },
    );
    const scroller = m.node.children[0];
    const s = m.wnd.scale;
    const x = (scroller.abs.x + scroller.abs.width / 2) / s;
    const y = (scroller.abs.y + scroller.abs.height / 2) / s;
    assert.equal(m.node.children[1]._promoted, promote);
    const blits = m.native.of('scrollSurface').length;
    m.app._routeWheel({
      type: 'wheel',
      windowNumber: m.wnd.windowNumber,
      x,
      y,
      gx: x,
      gy: y,
      dx: 0,
      dy: -1,
      precise: false,
      time: performance.now(),
    });
    await tick();
    m.frame();
    assert.equal(
      m.native.of('scrollSurface').length - blits,
      promote ? 1 : 0,
      `promote ${promote}: a toast in the bitmap is dragged by a blit, one on a layer is not`,
    );
    await cleanupCocoa();
  }
});

test('a loop keeps its layer for as long as it runs, and gives it back when it stops', async () => {
  const m = await mountCocoa(box(pulse));
  const node = m.node.children[0];
  // declared at mount the loop started on the clock, before the window had
  // a presenter; the window's first frame re-asks every loop (`_watchLoops`)
  assert.ok(node._anim.get('backgroundColor')?.offloaded);
  assert.equal(node._promoted, true, 'from the first frame');
  assert.equal(m.node._animating.size, 0);
  const [, keyPath, opts, key] = m.native.of('addAnimation')[0];
  assert.equal(keyPath, 'backgroundColor');
  assert.equal(opts.repeat, Infinity);
  assert.equal(opts.autoreverse, true);
  m.frame();
  assert.equal(m.native.of('addAnimation').length, 1, 'phase kept');

  await m.render(box({ ...pulse, display: 'none' }));
  assert.deepEqual(
    m.native.of('removeAnimation').map(([, k]) => k),
    [key],
  );
  m.frame();
  assert.equal(node._promoted, false, 'hidden: off its layer');
  assert.equal(m.promotion.promoted.size, 0);
  assert.equal(m.node._animating.size, 0);
});

test('a later sibling reaching into the node keeps it on the clock, until the layout changes', async () => {
  const clock = withFrameClock();
  try {
    const over = at(30, 15, 40, 20, { backgroundColor: '#00ff00' });
    const m = await mountCocoa([kbox('a', fade), kbox('b', over)]);
    const node = m.node.children[0];
    await m.render([
      kbox('a', { ...fade, backgroundColor: '#0000ff' }),
      kbox('b', over),
    ]);
    assert.ok(node._anim.get('backgroundColor').offloaded, 'taken at the swap');
    m.frame();
    // …and declined by the frame, from the top: the clock has it
    const entry = node._anim.get('backgroundColor');
    assert.ok(entry && !entry.offloaded);
    assert.ok(m.node._animating.has(node));
    assert.equal(node._promoted, false);
    assert.equal(m.native.of('createLayer').length, 0);
    assert.equal(m.native.of('addAnimation').length, 0);
    assert.equal(
      node.style.backgroundColor,
      '#ff0000',
      'painted from the declared start, never at the target',
    );
    clock.advance(200);
    m.frame();
    assert.equal(node.style.backgroundColor, '#0000ff');

    // the same scene answers at the swap, with no frame spent on it
    await m.render([
      kbox('a', { ...fade, backgroundColor: '#00ffff' }),
      kbox('b', over),
    ]);
    assert.ok(!node._anim.get('backgroundColor').offloaded);
    assert.equal(m.promotion.candidates.size, 0);
    clock.advance(200);
    m.frame();

    // the sibling moves away: a layout, and the next swap is promoted
    const away = { ...over, left: 120 };
    await m.render([
      kbox('a', { ...fade, backgroundColor: '#00ffff' }),
      kbox('b', away),
    ]);
    m.frame();
    await m.render([
      kbox('a', { ...fade, backgroundColor: '#ff00ff' }),
      kbox('b', away),
    ]);
    assert.ok(node._anim.get('backgroundColor').offloaded);
    m.frame();
    assert.equal(node._promoted, true);
    assert.equal(m.native.of('addAnimation').length, 1);
  } finally {
    clock.restore();
  }
});

test('a later subtree only counts where it puts ink: a layout-only box over the node is no overlap', async () => {
  const m = await mountCocoa([
    kbox('a', fade),
    // a container laid over the node with nothing painted in it, and a
    // child of its own well clear of the node
    kbox(
      'b',
      at(0, 0, 200, 120),
      box(at(150, 80, 20, 20, { backgroundColor: '#00ff00' })),
    ),
  ]);
  const node = m.node.children[0];
  await m.render([
    kbox('a', { ...fade, backgroundColor: '#0000ff' }),
    kbox(
      'b',
      at(0, 0, 200, 120),
      box(at(150, 80, 20, 20, { backgroundColor: '#00ff00' })),
    ),
  ]);
  m.frame();
  assert.equal(node._promoted, true);
});

test("an ancestor's border ring is painted after the node: promoted only clear of it", async () => {
  const card = at(10, 10, 100, 60, { borderWidth: 4, borderColor: '#000000' });
  // a chip over the ring, and one inside the padding box
  for (const [left, promoted] of [
    [-2, false],
    [10, true],
  ]) {
    const chip = at(left, 10, 40, 20, {
      backgroundColor: '#ff0000',
      transition: { backgroundColor: 120 },
    });
    const m = await mountCocoa(box(card, box(chip)));
    const node = m.node.children[0].children[0];
    await m.render(box(card, box({ ...chip, backgroundColor: '#0000ff' })));
    m.frame();
    assert.equal(node._promoted, promoted, `left ${left}`);
    await cleanupCocoa();
  }
});

test('a clipping ancestor has to hold the whole of it', async () => {
  const clip = at(10, 10, 100, 60, { overflow: 'hidden' });
  for (const [left, promoted] of [
    [80, false],
    [20, true],
  ]) {
    const chip = at(left, 10, 40, 20, {
      backgroundColor: '#ff0000',
      transition: { backgroundColor: 120 },
    });
    const m = await mountCocoa(box(clip, box(chip)));
    const node = m.node.children[0].children[0];
    await m.render(box(clip, box({ ...chip, backgroundColor: '#0000ff' })));
    m.frame();
    assert.equal(node._promoted, promoted, `left ${left}`);
    await cleanupCocoa();
  }
});

test('what the layer cannot express takes the node back to the bitmap, the loop to the clock', async () => {
  const m = await mountCocoa(box(pulse));
  const node = m.node.children[0];
  assert.equal(node._promoted, true);
  const layer = layerOf(m, node);
  await m.render(box({ ...pulse, boxShadow: '0 2px 4px #00000080' }));
  m.frame();
  assert.equal(node._promoted, false);
  assert.equal(layer.parent, null);
  const entry = node._anim.get('backgroundColor');
  assert.ok(entry?.loop && !entry.offloaded, 'the clock has the loop');
  assert.ok(m.node._animating.has(node));
});

test('the frame that finds a later sibling over the node takes it off its layer and paints it back', async () => {
  const m = await mountCocoa([
    kbox('a', pulse),
    kbox('b', at(120, 80, 20, 20, { backgroundColor: '#00ff00' })),
  ]);
  const node = m.node.children[0];
  const rect = { x: px(10), y: px(10), width: px(40), height: px(20) };
  assert.equal(node._promoted, true);
  const layer = layerOf(m, node);
  const fills = fillsOf(m.native, rect);
  await m.render([
    kbox('a', pulse),
    kbox('b', at(30, 15, 20, 20, { backgroundColor: '#00ff00' })),
  ]);
  m.frame();
  assert.equal(node._promoted, false);
  assert.equal(layer.parent, null);
  assert.equal(fillsOf(m.native, rect), fills + 1, 'in the same frame');
  assert.ok(m.node._animating.has(node), 'the loop runs on the clock');
});

test('children ride the layer as one raster, repainted for their own claims only', async () => {
  const card = at(10, 10, 120, 40, {
    padding: 8,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cccccc',
    transition: { backgroundColor: 120 },
  });
  const label = (text) => h('text', { style: { color: '#333333' } }, text);
  const m = await mountCocoa(box(card, label('hello')));
  const node = m.node.children[0];
  await m.render(box({ ...card, backgroundColor: '#eeeeee' }, label('hello')));
  m.frame();
  assert.equal(node._promoted, true);
  const layer = layerOf(m, node);
  const content = m.promotion.promoted.get(node).content;
  assert.ok(content, 'a raster for the text');
  assert.equal(content.layer.parent, layer, "inside the node's layer");
  assert.equal(content.layer.contents, content.raster.surface.id);
  const uploads = () =>
    m.native.of('surfaceToLayer').filter(([, l]) => l === content.layer).length;
  assert.equal(uploads(), 1);

  // a retarget of the box itself: the layer's model moves, the raster does not
  await m.render(box({ ...card, backgroundColor: '#dddddd' }, label('hello')));
  m.frame();
  assert.equal(uploads(), 1);
  assert.equal(m.native.of('addAnimation').length, 2);

  // the text changes: its claim reaches the raster
  await m.render(
    box({ ...card, backgroundColor: '#dddddd' }, label('changed')),
  );
  m.frame();
  assert.equal(uploads(), 2);
});

test("a promoted node inside a promoted node: a hole in the parent's raster, and a layer above its parent's", async () => {
  const card = at(10, 10, 120, 60, {
    padding: 12,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cccccc',
    transition: { backgroundColor: 120 },
  });
  const chip = {
    width: 30,
    height: 20,
    backgroundColor: '#ff0000',
    transition: { backgroundColor: 120 },
  };
  const m = await mountCocoa(box(card, box(chip)));
  const cardNode = m.node.children[0];
  const chipNode = cardNode.children[0];
  await m.render(
    box(
      { ...card, backgroundColor: '#eeeeee' },
      box({ ...chip, backgroundColor: '#0000ff' }),
    ),
  );
  m.frame();
  assert.equal(cardNode._promoted, true);
  assert.equal(chipNode._promoted, true);
  const cardLayer = layerOf(m, cardNode);
  const chipLayer = layerOf(m, chipNode);
  assert.equal(chipLayer.parent, rootLayer(m), 'flat on the root');
  assert.ok(chipLayer.props.zPosition > cardLayer.props.zPosition);
  assert.equal(
    m.promotion.promoted.get(cardNode).content,
    null,
    'nothing left for the card to raster',
  );
  const chipRect = {
    x: chipNode.abs.x,
    y: chipNode.abs.y,
    width: chipNode.abs.width,
    height: chipNode.abs.height,
  };
  assert.equal(fillsOf(m.native, chipRect), 1, 'painted once, at the mount');
});

test('unmounting a promoted node takes its layer off the root', async () => {
  const m = await mountCocoa([
    kbox('a', pulse),
    kbox('b', at(100, 80, 20, 20)),
  ]);
  const node = m.node.children[0];
  assert.equal(node._promoted, true);
  const layer = layerOf(m, node);
  await m.render([kbox('b', at(100, 80, 20, 20))]);
  assert.ok(node.destroyed);
  m.frame();
  assert.equal(layer.parent, null);
  assert.equal(m.promotion.promoted.size, 0);
  assert.equal(m.promotion.animations.live.size, 0);
});

test('a loop that stops leaves its node on the layer for the grace, then the bitmap takes it back', async () => {
  const m = await mountCocoa(box(pulse));
  const node = m.node.children[0];
  const rect = { x: px(10), y: px(10), width: px(40), height: px(20) };
  // declared at mount, promoted on the first frame: the bitmap never held it
  assert.equal(node._promoted, true);
  assert.equal(fillsOf(m.native, rect), 0);
  await m.render(box({ ...pulse, animation: undefined }));
  assert.equal(m.native.of('removeAnimation').length, 1, 'stopped');
  m.frame();
  assert.equal(node._promoted, true, 'held for the grace');
  assert.equal(m.promotion.idle.size, 1);
  assert.equal(fillsOf(m.native, rect), 0, 'not painted back yet');
  m.promotion.releaseIdle();
  await tick();
  m.frame();
  assert.equal(node._promoted, false);
  assert.equal(fillsOf(m.native, rect), 1, 'painted, at the resting style');
  assert.equal(m.promotion.idle.size, 0);
});

test('the window going takes every layer with it', async () => {
  const m = await mountCocoa(box(pulse));
  const node = m.node.children[0];
  const layer = layerOf(m, node);
  assert.ok(layer.parent);
  await m.root.unmount();
  assert.equal(layer.parent, null);
  assert.equal(node._promoted, false);
});

test('promotion is on by default where the bridge draws layer and raster colours alike, and off before that', () => {
  const env = process.env.REACT_X11_COCOA_PROMOTE;
  delete process.env.REACT_X11_COCOA_PROMOTE;
  try {
    const srgb = fakeCocoaBridge();
    assert.equal(new CocoaApp(srgb)._promote, true);
    // @windowkit/appkit 0.5.0 has no colorSpace verb: a layer's colour was
    // a different shade from the same colour rastered, and a node moving
    // between the two would show it
    const older = new Proxy(srgb, {
      get: (t, k) => (k === 'colorSpace' ? undefined : t[k]),
    });
    assert.equal(new CocoaApp(older)._promote, false);
    assert.equal(
      new CocoaApp(older, { cocoa: { promote: true } })._promote,
      true,
      'asked for, it is on regardless',
    );
    process.env.REACT_X11_COCOA_PROMOTE = '1';
    assert.equal(new CocoaApp(older)._promote, true);
    process.env.REACT_X11_COCOA_PROMOTE = '0';
    assert.equal(new CocoaApp(srgb)._promote, false);
  } finally {
    if (env === undefined) delete process.env.REACT_X11_COCOA_PROMOTE;
    else process.env.REACT_X11_COCOA_PROMOTE = env;
  }
});

test('cocoa.promote: false leaves the surface window with no animation seam', async () => {
  const m = await mountCocoa(box(pulse), { promote: false });
  const node = m.node.children[0];
  assert.equal(m.wnd.animateNode, undefined);
  assert.equal(m.promotion, null);
  assert.ok(m.node._animating.has(node), 'the clock runs it');
  assert.equal(m.native.of('createLayer').length, 0);
});
