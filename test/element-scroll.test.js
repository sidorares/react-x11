// The blit an element with a viewport of its own can ask for (issue #303).
//
// `<box overflow="scroll">` has moved its surviving band inside ntk's
// backing store since issue #138, through bookkeeping — `pendingScrolls`,
// the poison-over-disarm of #295, the damage gate — that a custom element
// could not reach. A graph pane's pan is the same shape and none of that
// machinery: the content is unbounded in both directions, there is a zoom,
// and `contentWidth`/`contentHeight` mean nothing, so the `Scrollable` mixin
// is the wrong answer and a raw CopyArea would reintroduce the race #295
// closed. `Node.scrollContents(rect, dx, dy)` is that dance made public.
//
// Every gate here falls back to repainting `rect`, which is the behaviour
// without the call at all — so the worst mistake the fast path can make is
// not firing. The pixel test at the end is the one that asserts the other
// direction: that when it does fire, what lands on the screen is what a full
// repaint would have put there.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import { registerElement, unregisterElement } from '../src/host.js';
import { Node, Scrollable } from '../src/node.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const W = 480;
const H = 480;
const CELL = 40;

// The pane is inset from the window on purpose: a claim that covers the
// window makes the whole frame unbounded (`_clampDamage`), which would hide
// the difference between "declined the blit" and "repainted everything"
// behind the same `null`.
const INSET = 40;
const VP = { x: INSET, y: INSET, width: W - 2 * INSET, height: H - 2 * INSET };
// the furniture strip along the bottom of the pane (issue #309)
const BAND = 80;
const CARVED = { ...VP, height: VP.height - BAND };
const FURNITURE = {
  x: VP.x,
  y: VP.y + VP.height - BAND,
  width: VP.width,
  height: BAND,
};

const overlaps = (a, b) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/**
 * A pane that draws a scene of its own and pans it: a grid of cells at an
 * offset nobody laid out, culled against the pass's rect the way core culls
 * the tree (issue #301). `pan` is the whole point — it moves the offset and
 * tells core the pixels moved with it.
 */
class PanNode extends Node {
  constructor(props, app) {
    super('pan', props, app);
    this.panX = 0;
    this.panY = 0;
    this.passes = [];
    this.drawn = [];
  }

  /** The region the drawing lives in — the whole node here. */
  viewport() {
    return { ...this.abs };
  }

  pan(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    return this.scrollContents(this.viewport(), dx, dy);
  }

  /**
   * The same pan with furniture in the way (issue #309): a strip along the
   * bottom of the pane — a minimap, a zoom control — that has to repaint on
   * a pan frame and whose pixels must *not* ride the blit. The element
   * carves it out of the region it shifts and claims it as ordinary damage,
   * so the two claims sit edge to edge with nothing between them.
   */
  panBeside(dx, dy, band = BAND) {
    this.panX += dx;
    this.panY += dy;
    const vp = this.viewport();
    const armed = this.scrollContents(
      { ...vp, height: vp.height - band },
      dx,
      dy,
    );
    this.invalidate(false, this.furniture(band), 'props');
    return armed;
  }

  /** The strip the pan above leaves to itself. */
  furniture(band = BAND) {
    const vp = this.viewport();
    return {
      x: vp.x,
      y: vp.y + vp.height - band,
      width: vp.width,
      height: band,
    };
  }

  /**
   * A world grid drawn at the pan offset — a *translation* of itself and
   * nothing else, which is exactly the promise `scrollContents` makes. Wide
   * enough that the pane is covered at every offset these tests reach.
   */
  cells() {
    const vp = this.abs;
    const out = [];
    for (let row = -8; row < 20; row++) {
      for (let col = -8; col < 20; col++) {
        out.push({
          x: vp.x + col * CELL + this.panX,
          y: vp.y + row * CELL + this.panY,
          width: CELL - 4,
          height: CELL - 4,
          color: (row + col) % 2 ? '#2ecc71' : '#e74c3c',
        });
      }
    }
    return out;
  }

  paint(ctx) {
    super.paint(ctx);
    const damage = this.paintDamage();
    this.passes.push(damage);
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
    ctx.clip();
    let drawn = 0;
    for (const cell of this.cells()) {
      if (damage && !overlaps(cell, damage)) continue;
      ctx.fillStyle = cell.color;
      ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
      drawn += 1;
    }
    ctx.restore();
    this.drawn.push(drawn);
  }
}

/** The same pane, but a scroll container too: the one element that could
 * arm both halves of the blit in one frame. */
class ScrollPanNode extends Scrollable(PanNode) {
  isScroller() {
    return true;
  }

  measureScrollContent() {
    return { width: 2000, height: 2000 };
  }
}

const registered = new Set();
function register(type = 'pan', definition = {}) {
  registerElement(type, {
    create: (p, a) => new PanNode(p, a),
    override: registered.has(type),
    ...definition,
  });
  registered.add(type);
}

const blits = (wnd) => wnd.calls.filter(([name]) => name === 'scrollRegion');

const area = (rects) => rects.reduce((sum, r) => sum + r.width * r.height, 0);

async function mount({
  paneProps = {},
  extra = null,
  definition,
  wrapStyle = null,
} = {}) {
  register('pan', definition);
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  // `wrapStyle` puts the pane inside a box carrying that style — the shape
  // a widget takes when the app's own style (a border, a radius) goes on a
  // box around the drawn element
  const pane = wrapStyle
    ? h(
        'box',
        { style: { flexGrow: 1, margin: INSET, ...wrapStyle } },
        h('pan', { ref, style: { flexGrow: 1 }, ...paneProps }),
      )
    : h('pan', { ref, style: { flexGrow: 1, margin: INSET }, ...paneProps });
  x11Root.render(
    h(
      'window',
      { width: W, height: H, style: { backgroundColor: '#101820' } },
      pane,
      extra,
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const node = ref.current;
  wnd.calls.length = 0;
  node.passes.length = 0;
  node.drawn.length = 0;
  return { app, wnd, node, root: node.root, x11Root };
}

test.afterEach(() => {
  for (const type of registered) unregisterElement(type);
  registered.clear();
});

test('a pan blits the region and repaints only the band it exposed', async () => {
  const { wnd, node, root } = await mount();

  // dragging the scene down: the pixels move down, and what comes in is a
  // strip along the top
  assert.strictEqual(node.pan(0, 40), true, 'the frame is a blit candidate');
  await tick();

  assert.deepStrictEqual(blits(wnd), [['scrollRegion', { ...VP }, 0, 40]]);
  const rects = root._lastDamageRects;
  assert.ok(rects, 'the frame stayed bounded');
  assert.deepStrictEqual(
    rects,
    [{ x: VP.x, y: VP.y, width: VP.width, height: 40 }],
    'the exposed strip and nothing else',
  );
  // and the element is told the band, so it culls to it
  assert.deepStrictEqual(node.passes, [
    { x: VP.x, y: VP.y, width: VP.width, height: 40 },
  ]);
  assert.ok(
    node.drawn[0] < 30,
    `drew ${node.drawn[0]} cells for a one-row strip`,
  );
});

test('the band is on the side the pixels came from, on either axis', async () => {
  const { wnd, node, root } = await mount();

  node.pan(0, -40);
  await tick();
  assert.deepStrictEqual(blits(wnd).at(-1), [
    'scrollRegion',
    { ...VP },
    0,
    -40,
  ]);
  assert.deepStrictEqual(root._lastDamageRects, [
    { x: VP.x, y: VP.y + VP.height - 40, width: VP.width, height: 40 },
  ]);

  node.pan(-24, 0);
  await tick();
  assert.deepStrictEqual(blits(wnd).at(-1), [
    'scrollRegion',
    { ...VP },
    -24,
    0,
  ]);
  assert.deepStrictEqual(root._lastDamageRects, [
    { x: VP.x + VP.width - 24, y: VP.y, width: 24, height: VP.height },
  ]);
});

test('a diagonal pan is one blit and two disjoint strips', async () => {
  // The scroll path takes one axis at a time, because the L of exposed
  // strips overlaps the scrollbar rects and the merges balloon back towards
  // the whole viewport. There are no bars here, and a drag-pan is diagonal
  // almost every frame.
  const { wnd, node, root } = await mount();

  node.pan(20, 30);
  await tick();

  assert.deepStrictEqual(blits(wnd), [['scrollRegion', { ...VP }, 20, 30]]);
  const rects = root._lastDamageRects;
  assert.deepStrictEqual(rects, [
    { x: VP.x, y: VP.y, width: VP.width, height: 30 },
    { x: VP.x, y: VP.y + 30, width: 20, height: VP.height - 30 },
  ]);
  assert.ok(
    area(rects) < VP.width * VP.height * 0.25,
    `repainted ${area(rects)}px² of ${VP.width * VP.height}`,
  );
});

test('several pans in one frame blit once, by the net shift', async () => {
  const { wnd, node } = await mount();

  node.pan(0, 24);
  node.pan(0, 24);
  node.pan(0, -8);
  await tick();

  assert.deepStrictEqual(blits(wnd), [['scrollRegion', { ...VP }, 0, 40]]);
});

test('pans that cancel out claim the region and blit nothing', async () => {
  const { wnd, node, root } = await mount();

  node.pan(0, 24);
  node.pan(0, -24);
  await tick();

  assert.deepStrictEqual(blits(wnd), [], 'no pixels moved');
  assert.deepStrictEqual(
    root._lastDamageRects,
    [{ ...VP }],
    'but the region was claimed, because the drawing may have changed',
  );
});

test('a pan of nothing claims nothing at all', async () => {
  const { wnd, node, root } = await mount();

  assert.strictEqual(node.pan(0, 0), true);
  await tick();

  assert.deepStrictEqual(blits(wnd), []);
  assert.strictEqual(root.needsPaint, false, 'no frame is owed');
});

test('other damage inside the region keeps the full repaint', async () => {
  const { wnd, node, root } = await mount();

  node.pan(0, 40);
  // a hover restyle, a badge, a tooltip — changed pixels, which must not be
  // blitted around
  node.invalidate(false, { x: 100, y: 100, width: 20, height: 20 }, 'props');
  await tick();

  assert.deepStrictEqual(blits(wnd), [], 'not a pure shift: no blit');
  assert.deepStrictEqual(node.passes, [{ ...VP }]);
  assert.ok(root._lastDamageRects, 'still bounded, just not narrowed');
});

// --- furniture beside the rect (issue #309) ------------------------------
//
// The gate above is the blit *rect*, not the node it lives in. An element
// whose pane has a minimap or zoom controls pinned to a corner has to
// repaint them on a pan frame — their pixels must not ride the blit — so it
// carves them out of the region it shifts and claims them itself. Those
// claims land beside the rect, edge to edge with it, and a node-granular
// gate would cancel every pan frame that had the HUD up.

test('furniture beside the blit rect coexists with it', async () => {
  const { wnd, node, root } = await mount();

  assert.strictEqual(node.panBeside(0, 40), true, 'still a blit candidate');
  await tick();

  assert.deepStrictEqual(blits(wnd), [['scrollRegion', { ...CARVED }, 0, 40]]);
  assert.deepStrictEqual(
    root._lastDamageRects,
    [
      { ...FURNITURE },
      { x: CARVED.x, y: CARVED.y, width: CARVED.width, height: 40 },
    ],
    'the furniture and the strip the shift exposed — not the pane',
  );
  assert.ok(
    area(root._lastDamageRects) < VP.width * VP.height * 0.6,
    `repainted ${area(root._lastDamageRects)}px² of ${VP.width * VP.height}`,
  );
});

test('furniture claimed before the pan lets it arm too', async () => {
  // the arming gate reads the claims already recorded, and it reads them
  // against the rect for the same reason
  const { wnd, node } = await mount();

  node.invalidate(false, node.furniture(), 'props');
  assert.strictEqual(node.scrollContents({ ...CARVED }, 0, 40), true);
  await tick();

  assert.deepStrictEqual(blits(wnd), [['scrollRegion', { ...CARVED }, 0, 40]]);
});

test('a claim one pixel inside the blit rect still poisons it', async () => {
  // the line the gate draws: beside is beside, over is over. Both orders,
  // because arming and claiming are two different checks.
  const over = {
    ...FURNITURE,
    y: FURNITURE.y - 1,
    height: FURNITURE.height + 1,
  };

  const after = await mount();
  after.node.scrollContents({ ...CARVED }, 0, 40);
  after.node.invalidate(false, over, 'props');
  await tick();
  assert.deepStrictEqual(blits(after.wnd), [], 'claimed after arming');

  const before = await mount();
  before.node.invalidate(false, over, 'props');
  assert.strictEqual(
    before.node.scrollContents({ ...CARVED }, 0, 40),
    false,
    'claimed before arming, and the call says so',
  );
  await tick();
  assert.deepStrictEqual(blits(before.wnd), []);
});

test('a claim the damage cap merged into the blit claim keeps the repaint', async () => {
  // The other half of the narrowed gate. A claim beside the rect is let
  // through, and the cap (four rects) merges the pair that wastes least —
  // which is exactly a claim flush against the rect. The frame gets the
  // claim back bigger than the rect it armed for: the blit would drop that
  // claim in favour of the exposed strip, taking the merged furniture with
  // it, so the whole thing falls back.
  const { wnd, node, root } = await mount();

  node.scrollContents({ ...CARVED }, 0, 40);
  // flush against the claim, and two pixels tall: a merge of the two is
  // still within the tolerance the scroll path recognises its claim by
  node.invalidate(false, { ...FURNITURE, height: 2 }, 'props');
  for (let i = 0; i < 4; i++) {
    node.invalidate(
      false,
      { x: VP.x + i * 90, y: FURNITURE.y + 40, width: 20, height: 20 },
      'props',
    );
  }
  await tick();

  assert.deepStrictEqual(
    blits(wnd),
    [],
    'the claim came back a different rect',
  );
  assert.ok(
    root._lastDamageRects.some(
      (r) => r.height > CARVED.height && r.y === CARVED.y,
    ),
    'and the merged claim is repainted whole, furniture included',
  );
});

test('damage claimed before the frame’s first pan poisons it (#295)', async () => {
  const { wnd, node } = await mount();

  // The race the scroll path closes by poisoning at arming time: the claim
  // lands while nothing is pending, so the claim-time check never tests it,
  // and the region claim that follows coalesces the rect away.
  node.invalidate(false, { x: 100, y: 100, width: 20, height: 20 }, 'props');
  assert.strictEqual(node.pan(0, 40), false, 'and the call says so');
  await tick();

  assert.deepStrictEqual(blits(wnd), []);
});

test('a claim between two pans cannot re-arm the blit mid-frame (#295)', async () => {
  const { wnd, node } = await mount();

  node.pan(0, 40); // arms
  node.invalidate(false, { x: 100, y: 100, width: 20, height: 20 }, 'props');
  assert.strictEqual(node.pan(0, 40), false, 'poisoned, not disarmed');
  await tick();

  assert.deepStrictEqual(
    blits(wnd),
    [],
    'a band displaced by the first delta is not a band anybody repainted',
  );
});

test('two regions of one node in a frame is not one CopyArea', async () => {
  const { wnd, node } = await mount();

  node.scrollContents({ ...VP }, 0, 40);
  node.scrollContents({ ...VP, height: 200 }, 0, 40);
  await tick();

  assert.deepStrictEqual(blits(wnd), []);
});

test('a child laid out over the region keeps the full repaint', async () => {
  // A scroll container's children *are* the scrolled content. An element's
  // are not: it draws the region itself and they sit on top, so one reaching
  // in would have its pixels dragged along.
  const { wnd, node } = await mount({
    paneProps: {
      children: h('box', {
        style: {
          position: 'absolute',
          left: 300,
          top: 300,
          width: 40,
          height: 40,
          backgroundColor: '#ffffff',
        },
      }),
    },
  });

  node.pan(0, 40);
  await tick();
  assert.deepStrictEqual(blits(wnd), []);
});

test('an overlapping sibling above the region keeps the full repaint', async () => {
  const { wnd, node } = await mount({
    extra: h('box', {
      style: {
        position: 'absolute',
        left: 200,
        top: 200,
        width: 60,
        height: 60,
        backgroundColor: '#ffffff',
      },
    }),
  });

  node.pan(0, 40);
  await tick();
  assert.deepStrictEqual(blits(wnd), []);
});

test('a rounded corner on the element itself keeps the full repaint', async () => {
  // the ring and the corners are `Node.paint`'s, not the element's drawing,
  // and they do not translate
  const { wnd, node } = await mount({
    paneProps: { style: { flexGrow: 1, margin: INSET, borderRadius: 8 } },
  });

  node.pan(0, 40);
  await tick();
  assert.deepStrictEqual(blits(wnd), []);
});

test('a rounded ancestor leaves its corner rows behind and blits the rest', async () => {
  // The arc of a rounded corner does not translate, but it lives in the
  // four radius-sized squares at the corners and nowhere else: the rows
  // they reach into come out of the blit as bands the element repaints,
  // and the band between them shifts. A graph pane inside a rounded card
  // panned at 3fps before this, on every backend.
  const RADIUS = 8;
  const { wnd, node, root } = await mount({ wrapStyle: { borderRadius: 8 } });
  assert.deepStrictEqual(node.abs, VP, 'the pane fills the rounded box');

  assert.strictEqual(node.pan(0, 40), true);
  await tick();
  const shifted = {
    x: VP.x,
    y: VP.y + RADIUS,
    width: VP.width,
    height: VP.height - 2 * RADIUS,
  };
  assert.deepStrictEqual(blits(wnd), [['scrollRegion', shifted, 0, 40]]);
  const rects = root._lastDamageRects;
  assert.ok(rects, 'the frame stayed bounded');
  const byY = [...rects].sort((a, b) => a.y - b.y);
  assert.deepStrictEqual(byY, [
    { x: VP.x, y: VP.y, width: VP.width, height: RADIUS },
    { x: VP.x, y: shifted.y, width: VP.width, height: 40 },
    {
      x: VP.x,
      y: shifted.y + shifted.height,
      width: VP.width,
      height: RADIUS,
    },
  ]);
  assert.ok(
    area(rects) < VP.width * VP.height * 0.25,
    `repainted ${area(rects)}px² of ${VP.width * VP.height}`,
  );
});

test('a rounded ancestor whose corners stay clear of the region blits it whole', async () => {
  const { wnd, node } = await mount({
    wrapStyle: { borderRadius: 8, padding: 12 },
  });
  const inner = { ...node.abs };
  assert.ok(inner.x > VP.x && inner.y > VP.y, 'the pane sits inside the box');

  node.pan(0, 40);
  await tick();
  assert.deepStrictEqual(blits(wnd), [['scrollRegion', inner, 0, 40]]);
});

test('a region outside the element is refused', async () => {
  const { wnd, node } = await mount({
    paneProps: { style: { flexGrow: 1, margin: INSET } },
  });

  // the whole window, from a node that owns the inset box inside it
  node.scrollContents({ x: 0, y: 0, width: W, height: H }, 0, 40);
  await tick();
  assert.deepStrictEqual(blits(wnd), []);
});

test('a fractional shift or region keeps the full repaint', async () => {
  const { wnd, node, root } = await mount();

  node.pan(0, 12.5);
  await tick();
  assert.deepStrictEqual(blits(wnd), [], 'only a whole-pixel shift is a copy');
  assert.deepStrictEqual(root._lastDamageRects, [{ ...VP }]);

  node.scrollContents({ ...VP, y: VP.y + 0.5 }, 0, 40);
  await tick();
  assert.deepStrictEqual(blits(wnd), []);
});

test('the worth-it gates: a small region, and a shift that keeps too little', async () => {
  const { wnd, node } = await mount();

  // 120x120 is 14400px², below the area a repaint is one cheap pass at
  node.scrollContents({ x: VP.x, y: VP.y, width: 120, height: 120 }, 0, 20);
  await tick();
  assert.deepStrictEqual(blits(wnd), [], 'not worth the bookkeeping');

  node.pan(0, 260); // 35% of the region survives
  await tick();
  assert.deepStrictEqual(blits(wnd), [], 'the exposed band is most of it');

  node.pan(0, H); // nothing survives at all
  await tick();
  assert.deepStrictEqual(blits(wnd), []);
});

test('an ntk without scrollRegion gets the old behaviour untouched', async () => {
  const { wnd, node, root } = await mount();
  delete wnd.scrollRegion;

  node.pan(0, 40);
  await tick();

  assert.deepStrictEqual(node.passes, [{ ...VP }]);
  assert.ok(root._lastDamageRects, 'the region claim stands');
});

test('a refused blit falls back to the full repaint', async () => {
  const { wnd, node } = await mount();
  wnd.scrollRegion = () => false;

  node.pan(0, 40);
  await tick();
  assert.deepStrictEqual(node.passes, [{ ...VP }]);
});

test('REACT_X11_DEBUG_PAINT is on the whole window, so it blits nothing', async () => {
  // the overlay draws over the pane; a blit would drag a shifted copy along
  const { wnd, node, root } = await mount();
  root._highlight = { abs: { x: 0, y: 0, width: 10, height: 10 } };

  node.pan(0, 40);
  await tick();
  assert.deepStrictEqual(blits(wnd), []);
});

test('a Scrollable that also shifts its own drawing does neither', async () => {
  // Two shifts of the same pixels in one frame, and a frame can only have
  // one — whichever armed first. Both orders, because the arming is a `??=`
  // in two different places.
  const scrollable = { create: (p, a) => new ScrollPanNode(p, a) };

  const first = await mount({ definition: scrollable });
  first.node.pan(0, 40);
  first.node.scrollTo(20);
  await tick();
  assert.deepStrictEqual(blits(first.wnd), [], 'contents armed, then scrollTo');

  const second = await mount({ definition: scrollable });
  second.node.scrollTo(20);
  second.node.pan(0, 40);
  await tick();
  assert.deepStrictEqual(
    blits(second.wnd),
    [],
    'scrollTo armed, then contents',
  );
});

// --- and that the pixels are right ---------------------------------------

async function headlessApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({ stream: clientEnd });
}

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

test('a blitted pan is byte-identical to the repaint it replaced', async (t) => {
  register();
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const instance = await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: W, height: H, style: { backgroundColor: '#101820' } },
          h('pan', { ref, style: { flexGrow: 1, margin: INSET } }),
        ),
        resolve,
      ),
    );
    if (typeof instance.scrollRegion !== 'function') {
      t.skip('installed ntk has no Window.scrollRegion yet');
      return;
    }
    const node = ref.current;
    const root = node.root;
    const frame = () => {
      root._scheduled = false;
      root.flush();
    };
    frame();
    await settle(app);

    let blitCalls = 0;
    const real = instance.scrollRegion.bind(instance);
    instance.scrollRegion = (...args) => {
      blitCalls += 1;
      return real(...args);
    };

    // the diagonal case, which is the one a drag-pan actually produces
    node.drawn.length = 0;
    node.pan(20, 30);
    frame();
    await settle(app);
    assert.strictEqual(blitCalls, 1, 'the fast path fired');
    assert.ok(root._lastDamageRects, 'and the frame stayed bounded');
    assert.ok(
      node.drawn[0] < 60,
      `drew ${node.drawn[0]} cells for two strips, out of ${node.cells().length}`,
    );
    const blitted = await readPixels(
      root._ctx ?? (root._ctx = root.window.getContext('2d')),
    );

    // the same scene again with no bound: the ground truth
    root.invalidate(false);
    frame();
    await settle(app);
    const repainted = await readPixels(root._ctx);

    assert.ok(
      blitted.equals(repainted),
      'blitted pixels differ from a full repaint of the same scene',
    );
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});

test('so is one that carved furniture out of the region (#309)', async (t) => {
  // The pixels behind the claim-time gate: the pane shifts everything but a
  // strip along its bottom, which is claimed as ordinary damage and repaints
  // at the new offset. A blit that dragged the strip's pixels along, or a
  // frame that dropped its claim, shows up here as a difference.
  register();
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const instance = await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: W, height: H, style: { backgroundColor: '#101820' } },
          h('pan', { ref, style: { flexGrow: 1, margin: INSET } }),
        ),
        resolve,
      ),
    );
    if (typeof instance.scrollRegion !== 'function') {
      t.skip('installed ntk has no Window.scrollRegion yet');
      return;
    }
    const node = ref.current;
    const root = node.root;
    const frame = () => {
      root._scheduled = false;
      root.flush();
    };
    frame();
    await settle(app);

    let blitCalls = 0;
    const real = instance.scrollRegion.bind(instance);
    instance.scrollRegion = (...args) => {
      blitCalls += 1;
      return real(...args);
    };

    node.panBeside(20, 30);
    frame();
    await settle(app);
    assert.strictEqual(blitCalls, 1, 'the fast path fired beside the strip');
    assert.ok(root._lastDamageRects, 'and the frame stayed bounded');
    const blitted = await readPixels(
      root._ctx ?? (root._ctx = root.window.getContext('2d')),
    );

    root.invalidate(false);
    frame();
    await settle(app);
    const repainted = await readPixels(root._ctx);

    assert.ok(
      blitted.equals(repainted),
      'the carved pan differs from a full repaint of the same scene',
    );
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});
