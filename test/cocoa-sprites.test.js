// Sprites (issue #819, src/cocoa/sprites.js) over the fake bridge: the real
// CocoaApp, its surface window and promotion, the node tree and its frame
// clock — only Core Animation and CoreGraphics are faked, so what a test
// pins is the call that went out and the frame it went out in. The contract:
// a part an element offers goes on a layer of its own where nothing is
// painted over it, its content painted once by the element's own paint and
// its animations run by the render server, with the element told before the
// frame paints so it leaves a hole; anything that stops allowing it gives
// the part back in the frame that finds it; and wherever nothing asks, the
// element draws everything as it always did.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { BoxNode } from '../src/nodes/box.js';
import { registerElement, unregisterElement } from '../src/registry.js';
import { cleanup, renderX11 } from '../src/testing/index.js';
import {
  cleanupCocoa,
  fakeCocoaBridge,
  mountCocoa,
} from './helpers/cocoa-bridge.js';

const h = React.createElement;

afterEach(async () => {
  await cleanupCocoa();
  await cleanup();
});

/**
 * A drawn element whose parts are whatever the test says: it draws its
 * `parts` but the lifted ones, offers its `offer`, and keeps a record of
 * everything it was told.
 */
class Stage extends BoxNode {
  constructor(props, app) {
    super(props, app);
    this.kind = 'stage';
    this.parts = []; // what paint() draws, but for what is lifted
    this.offer = null; // what sprites() answers
    this.asked = 0;
    this.lifted = new Set();
    this.liftedCalls = [];
    this.ended = [];
    this.paints = []; // the keys each paint drew
  }
  sprites() {
    this.asked++;
    return this.offer;
  }
  spritesLifted(keys) {
    this.lifted = keys;
    this.liftedCalls.push([...keys]);
  }
  spriteAnimationEnded(key, id, finished) {
    this.ended.push([key, id, finished]);
  }
  paint(ctx) {
    super.paint(ctx);
    const drawn = [];
    for (const part of this.parts) {
      if (this.lifted.has(part.key)) continue;
      part.paint(ctx);
      drawn.push(part.key);
    }
    this.paints.push(drawn);
  }
}

const staged = new WeakSet();
function withStage(t) {
  if (staged.has(t)) return;
  staged.add(t);
  registerElement('stage', { create: (props, app) => new Stage(props, app) });
  t.after(() => unregisterElement('stage'));
}

const stage = (style = {}) =>
  h('stage', {
    key: 'stage',
    style: {
      position: 'absolute',
      left: 0,
      top: 0,
      width: 200,
      height: 120,
      ...style,
    },
  });
const box = (style, ...children) => h('box', { style }, ...children);
const at = (left, top, width, height, more = {}) => ({
  position: 'absolute',
  left,
  top,
  width,
  height,
  ...more,
});

/** A part in device pixels — the window is at scale 2 — that fills its box
 *  in one colour. */
function part(key, rect, more = {}) {
  return {
    key,
    rect,
    paint(ctx) {
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    },
    ...more,
  };
}

const A = { x: 40, y: 40, width: 80, height: 40 };
const B = { x: 240, y: 40, width: 40, height: 40 };
const fade = {
  id: 'fade',
  property: 'opacity',
  values: [0, 1],
  timings: [[0.25, 0.1, 0.25, 1]],
  duration: 300,
};

function findStage(n) {
  if (n.kind === 'stage') return n;
  for (const c of n.children) {
    const hit = findStage(c);
    if (hit) return hit;
  }
  return null;
}

/** What the stage draws, all of it offered unless said otherwise, and the
 *  claim an element makes when what it draws changes — a frame with it. */
function show(node, parts, offer = parts) {
  node.parts = parts;
  node.offer = offer;
  node.invalidate(false, node, 'props');
}

/** Only the offer changed: the element asks for the frame that asks. */
function reoffer(node, offer) {
  node.offer = offer;
  node.spritesChanged();
}

/** Mount `children` around the stage and show `parts`, one frame in. */
async function shown(t, children, parts, opts) {
  withStage(t);
  const m = await mountCocoa(children, opts);
  const node = findStage(m.node);
  show(node, parts);
  m.frame();
  return { m, node };
}

const rootLayer = (m) => m.wnd._layer;
const stateOf = (m, node, key) => m.promotion.sprites.hosts.get(node)?.get(key);
const fillsOn = (m, surface, rect) =>
  m.native
    .of('ctxFillRect')
    .filter(
      ([s, x, y, w, hh]) =>
        s.id === surface.id &&
        x === rect.x &&
        y === rect.y &&
        w === rect.width &&
        hh === rect.height,
    ).length;

test("an offered part goes on a layer of its own: painted once by the element's paint, its animation in the render server, a hole in the bitmap", async (t) => {
  // drawn by the element first, and offered in a frame of its own, so that
  // what that frame repaints is the lift's alone
  const parts = [part('a', A, { animations: [fade] })];
  const { m, node } = await shown(t, stage(), parts);
  reoffer(node, null);
  m.frame();
  assert.deepEqual(node.liftedCalls, [['a'], []]);
  node.liftedCalls = [];
  const paints = node.paints.length;
  reoffer(node, parts);
  m.frame();
  const state = stateOf(m, node, 'a');
  assert.ok(state, 'lifted');
  assert.equal(state.layer.parent, rootLayer(m), 'a sublayer of the root');
  // the raster: the part's reach out to whole pixels and padded, painted by
  // the part's own paint in window coordinates
  assert.deepEqual(state.rect, { x: 38, y: 38, width: 84, height: 44 });
  assert.equal(fillsOn(m, state.raster.surface, A), 1, 'by its paint()');
  assert.equal(state.layer.contents, state.raster.surface.id, 'uploaded');
  // in points, its anchor at the origin — the centre of its box
  const p = state.layer.props;
  assert.deepEqual(p.bounds, [0, 0, 42, 22]);
  assert.deepEqual(p.anchorPoint, [0.5, 0.5]);
  assert.deepEqual(p.position, [40, 30]);
  assert.equal(p.opacity, 1);
  const anims = m.native.of('addAnimation');
  assert.equal(anims.length, 2, 'once a lift');
  const [layer, keyPath, opts] = anims[1];
  assert.equal(layer, state.layer);
  assert.equal(keyPath, 'opacity');
  assert.deepEqual(opts.values, [0, 1]);
  assert.deepEqual(opts.timings, [[0.25, 0.1, 0.25, 1]]);
  assert.equal(opts.duration, 0.3);
  assert.equal(typeof opts.id, 'string');
  // told before the frame painted, and that frame's paint left the hole
  assert.deepEqual(node.liftedCalls, [['a']]);
  assert.equal(node.paints.length, paints + 1, 'the frame painted it');
  assert.deepEqual(node.paints.at(-1), [], 'the element did not draw it');
  const damage = m.node._lastDamageRects;
  assert.ok(
    damage?.some(
      (r) =>
        r.x <= 38 && r.y <= 38 && r.x + r.width >= 122 && r.y + r.height >= 82,
    ),
    `the bitmap under it was repainted: ${JSON.stringify(damage)}`,
  );

  // nothing more for the frame clock: the render server runs the fade
  const frames = m.frames.count;
  m.frame();
  m.frame();
  assert.equal(m.frames.count, frames);
  assert.equal(m.native.of('addAnimation').length, 2, 'attached once');
  const uploads = m.native
    .of('surfaceToLayer')
    .filter(([, l]) => l === state.layer).length;
  assert.equal(uploads, 1);
});

test("the render server's end goes to the element, and an end it has not caught up with does not start the animation again", async (t) => {
  const { m, node } = await shown(t, stage(), [
    part('a', A, { animations: [fade] }),
  ]);
  const [, , opts] = m.native.of('addAnimation')[0];
  m.native.emit({ type: 'animation-end', id: opts.id, finished: true });
  assert.deepEqual(node.ended, [['a', 'fade', true]]);
  // the element still lists it in the next frame
  reoffer(node, node.offer);
  m.frame();
  assert.equal(m.native.of('addAnimation').length, 1, 'not added again');
  // a new id is a new animation
  reoffer(node, [part('a', A, { animations: [{ ...fade, id: 'fade-2' }] })]);
  m.frame();
  assert.equal(m.native.of('addAnimation').length, 2);
  // and one the element stops listing comes off the layer
  const [, , second, key] = m.native.of('addAnimation')[1];
  reoffer(node, [part('a', A)]);
  m.frame();
  assert.deepEqual(
    m.native.of('removeAnimation').map(([, k]) => k),
    [key],
  );
  assert.equal(m.app._animationEnds.has(second.id), false, 'forgotten');
});

test('a delay is counted from the frame that asks: ahead, or that far in already', async (t) => {
  const { m } = await shown(t, stage(), [
    part('a', A, {
      animations: [
        { ...fade, id: 'later', delay: 200 },
        {
          ...fade,
          id: 'joined',
          delay: -120,
          repeat: Infinity,
          autoreverse: true,
        },
      ],
    }),
  ]);
  const added = m.native.of('addAnimation').map(([, , o]) => o);
  assert.deepEqual(
    added.map((o) => o.delay),
    [0.2, -0.12],
  );
  assert.equal(added[1].repeat, Infinity);
  assert.equal(added[1].autoreverse, true);
});

test('a transform is a matrix in points, about the origin, and so is every keyframe', async (t) => {
  const { m, node } = await shown(t, stage(), [
    part('a', A, {
      origin: { x: 40, y: 40 },
      transform: [0, 1, -1, 0, 10, 0],
      animations: [
        {
          id: 'slide',
          property: 'transform',
          values: [
            [1, 0, 0, 1, 0, 0],
            [1, 0, 0, 1, 20, 8],
          ],
          duration: 500,
        },
      ],
    }),
  ]);
  const state = stateOf(m, node, 'a');
  assert.ok(state);
  assert.deepEqual(state.layer.props.transform, {
    matrix: [0, 1, -1, 0, 5, 0],
  });
  // the anchor at the origin: the raster's corner is (38, 38)
  assert.deepEqual(state.layer.props.anchorPoint, [2 / 84, 2 / 44]);
  assert.deepEqual(state.layer.props.position, [20, 20]);
  const [, keyPath, opts] = m.native.of('addAnimation')[0];
  assert.equal(keyPath, 'transform');
  assert.deepEqual(opts.values, [
    { matrix: [1, 0, 0, 1, 0, 0] },
    { matrix: [1, 0, 0, 1, 10, 4] },
  ]);
});

test('a new version paints the part again; the same one, or a move by whole pixels, does not', async (t) => {
  const { m, node } = await shown(t, stage(), [part('a', A, { version: 1 })]);
  const state = stateOf(m, node, 'a');
  const uploads = () =>
    m.native.of('surfaceToLayer').filter(([, l]) => l === state.layer).length;
  assert.equal(uploads(), 1);
  reoffer(node, node.offer);
  m.frame();
  assert.equal(uploads(), 1, 'the same version');
  reoffer(node, [part('a', A, { version: 2 })]);
  m.frame();
  assert.equal(uploads(), 2, 'a new one');
  // moved by whole pixels: the layer moves, the raster is the same picture
  const moved = { ...A, x: A.x + 6 };
  reoffer(node, [part('a', moved, { version: 2 })]);
  m.frame();
  assert.equal(uploads(), 2);
  assert.deepEqual(state.layer.props.position, [43, 30]);
  // …and by half of one, which the picture itself has to show: the raster
  // is the same size, and the part starts at another fraction of a pixel
  reoffer(node, [
    part(
      'a',
      { ...moved, x: moved.x + 0.5, width: moved.width - 0.5 },
      { version: 2 },
    ),
  ]);
  m.frame();
  assert.deepEqual(stateOf(m, node, 'a').rect, {
    x: 44,
    y: 38,
    width: 84,
    height: 44,
  });
  assert.equal(uploads(), 3);
});

test("a later sibling over the part keeps it the element's, until it moves away", async (t) => {
  const over = (left) =>
    h('box', {
      key: 'over',
      style: at(left, 25, 30, 10, { backgroundColor: '#00ff00' }),
    });
  const { m, node } = await shown(t, [stage(), over(30)], [part('a', A)]);
  assert.ok(stateOf(m, node, 'a') === undefined, 'not lifted');
  assert.deepEqual(node.liftedCalls, []);
  assert.deepEqual(node.paints.at(-1), ['a'], 'the element draws it');
  await m.render([stage(), over(150)]);
  m.frame();
  assert.ok(stateOf(m, node, 'a'), 'lifted once nothing is over it');
});

test('a part that comes to be overlapped leaves its layer in the frame that finds it, and the element draws it again in that frame', async (t) => {
  const { m, node } = await shown(
    t,
    [stage()],
    [part('a', A, { animations: [fade] })],
  );
  const state = stateOf(m, node, 'a');
  assert.ok(state);
  const paints = node.paints.length;
  await m.render([
    stage(),
    h('box', {
      key: 'over',
      style: at(30, 25, 30, 10, { backgroundColor: '#00ff00' }),
    }),
  ]);
  m.frame();
  assert.ok(stateOf(m, node, 'a') === undefined, 'not lifted');
  assert.equal(state.layer.parent, null, 'its layer is off the root');
  assert.deepEqual(node.liftedCalls, [['a'], []], 'told before it painted');
  assert.ok(node.paints.length > paints, 'that frame painted the element');
  assert.deepEqual(node.paints.at(-1), ['a'], 'and drew the part');
  assert.equal(m.app._animationEnds.size, 0, 'its animation forgotten');
});

test('an element that fades, or one inside a fade, keeps its parts: a layer would be outside the group', async (t) => {
  {
    const { m, node } = await shown(t, stage({ opacity: 0.5 }), [part('a', A)]);
    assert.ok(stateOf(m, node, 'a') === undefined, 'faded itself');
    await cleanupCocoa();
  }
  {
    const { m, node } = await shown(
      t,
      box(at(0, 0, 200, 120, { opacity: 0.5 }), stage()),
      [part('a', A)],
    );
    assert.ok(stateOf(m, node, 'a') === undefined, 'inside a fade');
  }
});

const slide = (dx) => ({
  id: 'slide',
  property: 'transform',
  values: [
    [1, 0, 0, 1, 0, 0],
    [1, 0, 0, 1, dx, 0],
  ],
  duration: 400,
});

test("a clipping ancestor with square corners cuts the part's layer to its padding box; a rounded one has to hold everywhere the part can be", async (t) => {
  // 100×60 logical at (10, 5): 200×120 device pixels at (20, 10), and the
  // part's slide takes it out past the right edge
  const clip = (more, child) =>
    box(at(10, 5, 100, 60, { overflow: 'hidden', ...more }), child);
  {
    const { m, node } = await shown(t, clip({}, stage()), [
      part('a', A, { animations: [slide(120)] }),
    ]);
    const state = stateOf(m, node, 'a');
    assert.ok(state, 'lifted, cut to the clip');
    assert.deepEqual(state.clip, { x: 20, y: 10, width: 200, height: 120 });
    assert.equal(state.layer.parent, state.box, 'in a box');
    assert.equal(state.box.parent, rootLayer(m), 'the box among the layers');
    assert.deepEqual(state.box.props.frame, [10, 5, 100, 60]);
    assert.equal(state.box.props.masksToBounds, true);
    assert.equal(typeof state.box.props.zPosition, 'number');
    // placed from the clip's corner: its centre, (80, 60), less (20, 10)
    assert.deepEqual(state.layer.props.position, [30, 25]);
    assert.equal(state.layer.props.zPosition, 0);
    // what shows of where it can be is what is claimed and asked about
    assert.ok(
      state.extent.x + state.extent.width <= 220,
      JSON.stringify(state.extent),
    );
    await cleanupCocoa();
  }
  {
    // a border is drawn over what the box holds: the clip is inside it
    const { m, node } = await shown(
      t,
      clip({ borderWidth: 2, borderColor: '#000000' }, stage()),
      [part('a', A, { animations: [slide(120)] })],
    );
    assert.deepEqual(stateOf(m, node, 'a')?.clip, {
      x: 24,
      y: 14,
      width: 192,
      height: 112,
    });
    await cleanupCocoa();
  }
  {
    const { m, node } = await shown(t, clip({ borderRadius: 8 }, stage()), [
      part('a', A, { animations: [slide(20)] }),
    ]);
    const state = stateOf(m, node, 'a');
    assert.ok(state, 'clear of the corners all the way');
    assert.equal(state.box, null, 'and not cut');
    await cleanupCocoa();
  }
  {
    const { m, node } = await shown(t, clip({ borderRadius: 8 }, stage()), [
      part('a', A, { animations: [slide(120)] }),
    ]);
    assert.ok(stateOf(m, node, 'a') === undefined, 'out past the rounded one');
  }
});

test("a part's own clip cuts its layer, and what is painted over it outside the clip keeps nothing from it", async (t) => {
  // a box after the stage over the part's right half, x 100 to 140 device
  const over = box(at(50, 20, 20, 20, { backgroundColor: '#00ff00' }));
  const left = { x: 0, y: 0, width: 100, height: 240 };
  const { m, node } = await shown(
    t,
    [stage(), h('box', { key: 'over', style: over.props.style })],
    [part('a', A, { clip: left })],
  );
  const state = stateOf(m, node, 'a');
  assert.ok(state, 'what shows of it is clear');
  assert.deepEqual(state.clip, left);
  assert.deepEqual(state.box.props.frame, [0, 0, 50, 120]);
  assert.ok(state.extent.x + state.extent.width <= 100);
  // cut wider, the box over it is in what shows: the element draws it
  reoffer(node, [part('a', A, { clip: { ...left, width: 120 } })]);
  m.frame();
  assert.ok(stateOf(m, node, 'a') === undefined, 'under the box');
});

test('a clip with round corners rounds the box the part is cut in, as wide as the box allows; a clipping ancestor with square corners that would cut it again keeps the part with its element', async (t) => {
  // 120×80 device pixels at (20, 20): 60×40 points at (10, 10)
  const cut = { x: 20, y: 20, width: 120, height: 80 };
  {
    const { m, node } = await shown(t, stage(), [
      part('a', A, { clip: cut, clipRadius: 16 }),
    ]);
    const state = stateOf(m, node, 'a');
    assert.ok(state, 'lifted');
    assert.deepEqual(state.box.props.frame, [10, 10, 60, 40]);
    assert.equal(state.box.props.masksToBounds, true);
    assert.equal(state.box.props.cornerRadius, 8, 'in points');
    // past half the box, half of it
    reoffer(node, [part('a', A, { clip: cut, clipRadius: 400 })]);
    m.frame();
    assert.equal(stateOf(m, node, 'a'), state, 'the same layer');
    assert.equal(state.box.props.cornerRadius, 20);
    // square again
    reoffer(node, [part('a', A, { clip: cut })]);
    m.frame();
    assert.equal(state.box.props.cornerRadius, 0);
    await cleanupCocoa();
  }
  {
    // a pane at (20, 10) device pixels, 200×120, that clips the stage: a
    // rounded clip inside it is the box's alone, and one it would cut is
    // no box's shape
    const pane = (child) =>
      box(at(10, 5, 100, 60, { overflow: 'hidden' }), child);
    const inside = { x: 40, y: 30, width: 100, height: 60 };
    const across = { x: 0, y: 0, width: 300, height: 200 };
    const { m, node } = await shown(t, pane(stage()), [
      part('a', A, { clip: inside, clipRadius: 12 }),
    ]);
    assert.deepEqual(stateOf(m, node, 'a')?.clip, inside, 'inside the pane');
    reoffer(node, [part('a', A, { clip: across, clipRadius: 12 })]);
    m.frame();
    assert.ok(stateOf(m, node, 'a') === undefined, 'cut again by the pane');
    reoffer(node, [part('a', A, { clip: across })]);
    m.frame();
    assert.deepEqual(
      stateOf(m, node, 'a')?.clip,
      { x: 20, y: 10, width: 200, height: 120 },
      'square, cut to the pane',
    );
    await cleanupCocoa();
  }
  {
    // a radius that is no length is no part
    const warn = console.warn;
    console.warn = () => {};
    t.after(() => {
      console.warn = warn;
    });
    const { m } = await shown(t, stage(), [
      part('a', A, { clip: cut, clipRadius: -1 }),
    ]);
    assert.equal(m.promotion.sprites.hosts.size, 0);
  }
});

test('a clip that comes or goes lifts the part again, in a box or out of one; one that moves moves the box; one that leaves nothing showing keeps the part with its element', async (t) => {
  const cut = { x: 0, y: 0, width: 100, height: 240 };
  const { m, node } = await shown(t, stage(), [part('a', A)]);
  const plain = stateOf(m, node, 'a');
  assert.equal(plain.box, null);
  assert.equal(plain.layer.parent, rootLayer(m));
  reoffer(node, [part('a', A, { clip: cut })]);
  m.frame();
  const boxed = stateOf(m, node, 'a');
  assert.notEqual(boxed, plain, 'lifted again');
  assert.equal(plain.layer.parent, null, 'the old layer went');
  assert.equal(boxed.box.parent, rootLayer(m));
  assert.deepEqual(node.liftedCalls.at(-1), ['a'], 'still lifted all along');
  // the clip moves: the box goes with it, the part stays where it was
  reoffer(node, [part('a', A, { clip: { ...cut, x: 20 } })]);
  m.frame();
  assert.equal(stateOf(m, node, 'a'), boxed, 'the same layer');
  assert.deepEqual(boxed.box.props.frame, [10, 0, 50, 120]);
  assert.deepEqual(boxed.layer.props.position, [30, 30]);
  // out of its box again
  reoffer(node, [part('a', A)]);
  m.frame();
  const again = stateOf(m, node, 'a');
  assert.equal(again.box, null);
  assert.equal(boxed.box.parent, null, 'the box went with its layer');
  // a clip clear of the part: nothing of it shows, and it is not lifted
  reoffer(node, [
    part('a', A, { clip: { x: 300, y: 0, width: 50, height: 50 } }),
  ]);
  m.frame();
  assert.ok(stateOf(m, node, 'a') === undefined, 'nothing shows');
  assert.deepEqual(node.liftedCalls.at(-1), [], 'drawn by its element');
});

test('a part the element stops offering, and an element that goes, take their layers with them', async (t) => {
  const spare = h('box', { key: 'spare', style: at(150, 100, 10, 10) });
  const parts = [part('a', A), part('b', B)];
  const { m, node } = await shown(t, [stage(), spare], parts);
  const a = stateOf(m, node, 'a');
  const b = stateOf(m, node, 'b');
  assert.ok(a && b);
  reoffer(node, [parts[1]]);
  m.frame();
  assert.equal(a.layer.parent, null);
  assert.equal(b.layer.parent, rootLayer(m), 'the other stays');
  assert.deepEqual(node.liftedCalls.at(-1), ['b']);
  assert.deepEqual(node.paints.at(-1), ['a'], 'drawn by the element again');
  await m.render([spare]);
  m.frame();
  assert.equal(b.layer.parent, null, 'unmounted: off the root');
  assert.equal(m.promotion.sprites.hosts.size, 0);
});

test('one order for every layer above the bitmap: a box promoted after the element is above its part', async (t) => {
  const pulse = at(30, 25, 30, 10, {
    backgroundColor: '#ff0000',
    animation: {
      backgroundColor: { to: '#00ff00', duration: 900, alternate: true },
    },
  });
  const { m, node } = await shown(
    t,
    [stage(), h('box', { key: 'pulse', style: pulse })],
    [part('a', A)],
  );
  const pulseNode = m.node.children[1];
  assert.equal(pulseNode._promoted, true);
  const state = stateOf(m, node, 'a');
  assert.ok(state, 'a promoted box over it is a layer above it, not ink');
  const pulseLayer = m.promotion.promoted.get(pulseNode).visual.layer;
  assert.ok(pulseLayer.props.zPosition > state.layer.props.zPosition);
});

test('a part that is not one, or a sprites() that throws, is drawn by its element', async (t) => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = warn;
  });
  const { m, node } = await shown(t, stage(), [
    part('a', A, { animations: [{ ...fade, values: [0] }] }),
    { key: 'b', rect: A, paint() {}, opacity: 'half' },
  ]);
  assert.equal(m.promotion.sprites.hosts.size, 0);
  assert.equal(warnings.length, 1, 'one warning for the element');
  assert.deepEqual(node.paints.at(-1), ['a', 'b']);
  node.sprites = () => {
    throw new Error('boom');
  };
  reoffer(node, node.offer);
  m.frame();
  assert.equal(m.promotion.sprites.hosts.size, 0);
});

test('a bridge that takes no matrix lifts nothing, and asks for nothing', async (t) => {
  // @windowkit/appkit before 0.19: no `transformForms`, and with it no
  // matrix and no negative delay, which is what a CSS animation needs
  const older = new Proxy(fakeCocoaBridge(), {
    get: (target, k) => (k === 'transformForms' ? undefined : target[k]),
  });
  const { m, node } = await shown(t, stage(), [part('a', A)], {
    native: older,
  });
  assert.equal(m.promotion.sprites.supported, false);
  assert.equal(node.asked, 0, 'never asked');
  assert.deepEqual(node.paints.at(-1), ['a'], 'drawn by the element');
});

test('where nothing lifts parts — the mock backend, as X11 — an element is never asked, and draws everything', async (t) => {
  withStage(t);
  const mounted = await renderX11(stage(), { backend: 'mock' });
  const node = findStage(mounted.windowNode);
  assert.equal(
    mounted.windowNode._spriteNodes.has(node),
    true,
    'registered all the same',
  );
  show(node, [part('a', A)]);
  node.spritesChanged();
  mounted.windowNode.flush();
  assert.equal(node.asked, 0);
  assert.deepEqual(node.liftedCalls, []);
});
