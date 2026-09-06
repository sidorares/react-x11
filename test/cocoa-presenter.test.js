// The retained layer presenter (src/cocoa/presenter.js) over a recording
// bridge: what it rasters, and when. The node tree, its layout and the
// invalidate channel are the real ones — the mock harness mounts the tree —
// and only the Core Animation bridge is faked, so this runs on every
// platform and says nothing about pixels. What it does pin is the contract
// docs/macos.md §"Custom drawing on a layer tree" makes: a registered
// element that overrides `paint` works unchanged through the raster visual,
// a damage claim — a node or a bare rect — is what re-rasters it, and a
// bare rect repaints only that part of the raster, with `paintDamage()`
// naming the pass the way the X11 path does.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { cssColorStraight } from 'ntk';

import { registerElement, unregisterElement } from '../src/host.js';
import { Node } from '../src/node.js';
import {
  renderX11,
  cleanup,
  screen,
  withFrameClock,
} from '../src/testing/index.js';
import { CocoaContext2D } from '../src/cocoa/context2d.js';
import {
  animatingPresenterFor,
  presenterFor,
} from './helpers/layer-presenter.js';

const h = React.createElement;

/**
 * A scene element the way @react-x11/components draws one: `super.paint`
 * for the box, then its own content — in `paint`, not `paintContent`, which
 * is the shape the presenter has to replay. Counts the two paths apart: a
 * paint into the presenter's CG context is a raster, anything else is the
 * mock window's own frame — and records what `paintDamage()` answered on
 * each raster, which is what a scene culls against.
 */
class SceneNode extends Node {
  constructor(props, app) {
    super('scene', props, app);
    this.rasters = 0;
    this.painted = 0;
    this.damages = [];
    this._claimedFromPaint = false;
  }

  paint(ctx) {
    super.paint(ctx);
    if (ctx instanceof CocoaContext2D) {
      this.rasters++;
      this.damages.push(this.paintDamage());
    } else {
      this.painted++;
    }
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(this.abs.x, this.abs.y, 10, 10);
    // an element that discovers mid-raster that it owes another pass — the
    // claim is made while the presenter is inside its frame
    if (
      this.props.claimOnPaint &&
      ctx instanceof CocoaContext2D &&
      !this._claimedFromPaint
    ) {
      this._claimedFromPaint = true;
      this.invalidate(false, this.abs, 'props');
    }
  }
}

const registered = new Set();
function register(type, definition) {
  registerElement(type, definition);
  registered.add(type);
}

afterEach(async () => {
  await cleanup();
  for (const type of registered) unregisterElement(type);
  registered.clear();
});

async function mountScene(props = {}) {
  register('scene', {
    create: (p, app) => new SceneNode(p, app),
    semanticNames: ['name', 'claimOnPaint'],
  });
  const mounted = await renderX11(
    h(
      'box',
      { style: { flexGrow: 1 } },
      h(
        'scene',
        { name: 'outer', style: { width: 200, height: 100 }, ...props },
        h('scene', { name: 'inner', style: { width: 50, height: 20 } }),
      ),
    ),
    { backend: 'mock' },
  );
  const byName = (name) =>
    screen.all((n) => n.kind === 'scene' && n.props.name === name)[0];
  return { ...mounted, outer: byName('outer'), inner: byName('inner') };
}

/** A rect inside `node`, offset from its corner — window coordinates. */
const within = (node, x, y, width, height) => ({
  x: node.abs.x + x,
  y: node.abs.y + y,
  width,
  height,
});

test('an element that overrides paint() is replayed by its raster, without its children', async () => {
  const mounted = await mountScene();
  const { outer, inner, windowNode } = mounted;
  // the surface path is what it was: the parent's walk painted the child
  assert.ok(
    inner.painted > 0,
    'the mock frame painted the child through its parent',
  );
  assert.strictEqual(outer._ownPaintOnly, undefined);

  const { presenter, bridge } = presenterFor(mounted);
  presenter.frame(windowNode);

  assert.strictEqual(
    outer.rasters,
    1,
    'the override is what the raster replays',
  );
  // once for its own visual — a second paint would be the parent's walk
  assert.strictEqual(
    inner.rasters,
    1,
    'the child paints only into its own visual',
  );
  assert.ok(
    presenter.visuals.get(inner)?.isRaster,
    'the child is a raster of its own',
  );
  assert.strictEqual(bridge.uploads(), 2, 'one upload per raster visual');
  assert.strictEqual(
    outer._ownPaintOnly,
    false,
    'the flag is only up during the replay',
  );
  assert.strictEqual(inner._ownPaintOnly, false);
  assert.deepStrictEqual(
    outer.damages,
    [null],
    'the first frame is an unbounded pass',
  );

  // nothing claimed since: nothing re-rasters
  presenter.frame(windowNode);
  assert.strictEqual(outer.rasters, 1);
  assert.strictEqual(inner.rasters, 1);
  assert.strictEqual(bridge.uploads(), 2);
});

test('a bare-rect claim re-rasters the visuals its ink touches, and nothing else', async () => {
  const mounted = await mountScene();
  const { outer, inner, windowNode } = mounted;
  const { presenter } = presenterFor(mounted);
  presenter.frame(windowNode);
  assert.deepStrictEqual([outer.rasters, inner.rasters], [1, 1]);

  // the box a dragged node moved through, well away from the inner element
  outer.invalidate(false, within(outer, 150, 60, 8, 8), 'props');
  presenter.frame(windowNode);
  assert.deepStrictEqual([outer.rasters, inner.rasters], [2, 1]);

  // a pan: the region scrollContents shifts is a claim on that rect — the
  // inner pane re-rasters, and so does the outer one under it, because a
  // rect cannot say whose pixels changed and everything drawing there does
  inner.scrollContents(inner.contentBox(), 3, 0);
  presenter.frame(windowNode);
  assert.deepStrictEqual([outer.rasters, inner.rasters], [3, 2]);

  // a claim that touches neither
  outer.invalidate(false, { x: 600, y: 500, width: 20, height: 20 }, 'props');
  presenter.frame(windowNode);
  assert.deepStrictEqual([outer.rasters, inner.rasters], [3, 2]);

  // an empty rect claims nothing
  outer.invalidate(false, { ...outer.abs, width: 0 }, 'props');
  presenter.frame(windowNode);
  assert.deepStrictEqual([outer.rasters, inner.rasters], [3, 2]);

  // a rect with a layout change behind it is still everything
  presenter.noteInvalidate({ x: 600, y: 500, width: 20, height: 20 }, true);
  presenter.frame(windowNode);
  assert.deepStrictEqual([outer.rasters, inner.rasters], [4, 3]);
});

test('a bare-rect claim repaints only that part of the raster, and the element sees the pass', async () => {
  const mounted = await mountScene();
  const { outer, inner, windowNode } = mounted;
  const { presenter, bridge } = presenterFor(mounted);
  presenter.frame(windowNode);
  bridge.calls.length = 0;

  const box = within(outer, 150, 60, 8, 8);
  outer.invalidate(false, box, 'props');
  presenter.frame(windowNode);
  assert.strictEqual(outer.rasters, 2);
  assert.deepStrictEqual(
    outer.damages.at(-1),
    box,
    'paintDamage() names the pass, in window coordinates',
  );
  assert.strictEqual(
    windowNode._paintDamage,
    null,
    'the damage belongs to the pass alone',
  );
  // the bitmap keeps everything outside the claim: only the claim is
  // cleared, and the replay is clipped to it — under the raster's own
  // translate, so the coordinates are the window's
  const rect = [box.x, box.y, box.width, box.height];
  assert.deepStrictEqual(bridge.argsOf('ctxClearRect'), [rect]);
  assert.ok(
    bridge.argsOf('ctxRect').some((a) => a.every((v, i) => v === rect[i])),
    'the clip path is the claim',
  );
  assert.ok(bridge.argsOf('ctxClip').length >= 1, 'and it is applied');
  assert.strictEqual(bridge.uploads(), 1, 'the bitmap is handed back once');
  assert.strictEqual(inner.rasters, 1, 'the inner visual was never touched');

  // a claim that names the node is the whole raster again
  outer.invalidate(false, outer, 'props');
  presenter.frame(windowNode);
  assert.strictEqual(outer.rasters, 3);
  assert.strictEqual(outer.damages.at(-1), null);

  // a fractional claim is grown to whole pixels, the way the X11 path snaps
  // its damage: a clip on a fractional edge antialiases into a seam
  outer.invalidate(false, within(outer, 100.4, 30.6, 8.2, 8.2), 'props');
  presenter.frame(windowNode);
  assert.deepStrictEqual(outer.damages.at(-1), within(outer, 100, 30, 9, 9));
});

test('overlapping claims merge into one pass, disjoint ones stay apart', async () => {
  const mounted = await mountScene();
  const { outer, windowNode } = mounted;
  const { presenter } = presenterFor(mounted);
  presenter.frame(windowNode);

  // two overlapping rects: one pass over their union, because a node
  // painted twice over the same pixels blends translucent ink over itself
  const a = within(outer, 20, 40, 30, 30);
  outer.invalidate(false, a, 'props');
  outer.invalidate(false, within(outer, 30, 50, 30, 30), 'props');
  presenter.frame(windowNode);
  assert.strictEqual(outer.rasters, 2, 'one pass');
  assert.deepStrictEqual(outer.damages.at(-1), { ...a, width: 40, height: 40 });

  // two disjoint rects: two passes, each its own claim
  const c = within(outer, 120, 70, 10, 10);
  outer.invalidate(false, a, 'props');
  outer.invalidate(false, c, 'props');
  presenter.frame(windowNode);
  assert.strictEqual(outer.rasters, 4, 'two passes');
  assert.deepStrictEqual(outer.damages.slice(-2), [a, c]);

  // a pan's shape — the shifted region and the strip beside it, edge to
  // edge — fills its box, and is one pass the way it is on X11
  outer.invalidate(false, within(outer, 10, 30, 100, 40), 'props');
  outer.invalidate(false, within(outer, 10, 70, 100, 10), 'props');
  presenter.frame(windowNode);
  assert.strictEqual(outer.rasters, 5, 'one pass');
  assert.deepStrictEqual(outer.damages.at(-1), within(outer, 10, 30, 100, 50));
});

test('a claim made from inside a frame lands in the next one', async () => {
  const mounted = await mountScene({ claimOnPaint: true });
  const { outer, inner, windowNode } = mounted;
  const { presenter } = presenterFor(mounted);
  presenter.frame(windowNode);
  assert.deepStrictEqual([outer.rasters, inner.rasters], [1, 1]);
  // the outer element claimed its own box while the first frame replayed it
  presenter.frame(windowNode);
  assert.strictEqual(
    outer.rasters,
    2,
    'the mid-frame claim was not cleared with the frame',
  );
  presenter.frame(windowNode);
  assert.strictEqual(outer.rasters, 2);
});

// --- animations the render server runs --------------------------------------
//
// The presenter's half of docs/architecture/animation.md §4: a transition or
// a loop on a property the node's own layer expresses goes to the bridge as
// an explicit animation — control points for the curve, additive for a
// length, from the presentation value for a colour — and schedules no
// frames; what the layer cannot express stays on the frame clock, exactly as
// before. The bridge is the recording fake, so what is pinned is the call
// that goes out and the node model's bookkeeping around it.

const plainBox = (style) =>
  h('box', {
    style: { width: 120, height: 60, backgroundColor: '#ff0000', ...style },
  });

/** A plain box over the presenter, its window wired the way layers mode
 *  wires it (src/cocoa/window.js), one frame in. */
async function mountAnimated(style) {
  const mounted = await renderX11(plainBox(style), { backend: 'mock' });
  const { presenter, bridge } = animatingPresenterFor(mounted);
  presenter.frame(mounted.windowNode);
  bridge.calls.length = 0; // mount traffic
  return {
    ...mounted,
    presenter,
    bridge,
    node: mounted.windowNode.children[0],
    ends: presenter.window.app._animationEnds,
    rerender: (next) => mounted.rerender(plainBox(next)),
  };
}

const fade = { transition: { backgroundColor: 120 } };
const pulse = {
  animation: {
    backgroundColor: { to: '#00ff00', duration: 900, alternate: true },
  },
};
const sentBackgrounds = (bridge) =>
  bridge
    .argsOf('setLayerProps')
    .flatMap(([p]) => (p.backgroundColor ? [p.backgroundColor] : []));

test('a transition on a plain box runs in the render server: the model, one animation, no frames', async () => {
  const m = await mountAnimated(fade);
  await m.rerender({ ...fade, backgroundColor: '#0000ff' });
  const entry = m.node._anim.get('backgroundColor');
  assert.ok(entry?.offloaded, 'the presenter took it');
  assert.strictEqual(m.windowNode._animating.size, 0, 'no frame clock for it');
  assert.strictEqual(
    m.node.style.backgroundColor,
    '#0000ff',
    'the style is the model value, not the start',
  );

  m.presenter.frame(m.windowNode);
  assert.deepStrictEqual(sentBackgrounds(m.bridge).at(-1), [0, 0, 1, 1]);
  const anims = m.bridge.argsOf('addAnimation');
  assert.strictEqual(anims.length, 1);
  const [keyPath, opts, key] = anims[0];
  assert.strictEqual(keyPath, 'backgroundColor');
  assert.deepStrictEqual(opts.from, [1, 0, 0, 1]);
  assert.deepStrictEqual(opts.to, [0, 0, 1, 1]);
  assert.strictEqual(opts.duration, 0.12);
  assert.deepStrictEqual(opts.timing, [0.33, 1, 0.68, 1], 'control points');
  assert.strictEqual(typeof opts.id, 'string');
  assert.ok(key.startsWith('backgroundColor:'));
  m.presenter.frame(m.windowNode);
  assert.strictEqual(
    m.bridge.argsOf('addAnimation').length,
    1,
    'attached once',
  );

  // the bridge reports the end: the entry goes, the model was there all along
  m.ends.get(opts.id)({ type: 'animation-end', id: opts.id, finished: true });
  assert.ok(!m.node._anim?.size);
  assert.strictEqual(m.presenter.liveAnimations.size, 0);
});

test('a length retargets additively: the new delta joins the one still running', async () => {
  const edge = { borderColor: '#000000', transition: { borderWidth: 100 } };
  const m = await mountAnimated({ ...edge, borderWidth: 2 });
  await m.rerender({ ...edge, borderWidth: 6 });
  m.presenter.frame(m.windowNode);
  await m.rerender({ ...edge, borderWidth: 3 });
  m.presenter.frame(m.windowNode);
  const anims = m.bridge.argsOf('addAnimation');
  assert.deepStrictEqual(
    anims.map(([kp, o]) => [kp, o.from, o.to, o.additive]),
    [
      ['borderWidth', -4, 0, true],
      ['borderWidth', 3, 0, true],
    ],
  );
  assert.notStrictEqual(anims[0][2], anims[1][2], 'distinct keys');
  assert.strictEqual(
    m.bridge.argsOf('removeAnimation').length,
    0,
    'the first keeps running and sums with the second',
  );
  m.ends.get(anims[0][1].id)({ finished: true });
  assert.ok(
    m.node._anim.get('borderWidth')?.offloaded,
    'the older one ending leaves the newer in place',
  );
  m.ends.get(anims[1][1].id)({ finished: true });
  assert.ok(!m.node._anim?.size);
});

test('a colour retargets from where the pixels are, replacing the one before it', async () => {
  const m = await mountAnimated(fade);
  await m.rerender({ ...fade, backgroundColor: '#0000ff' });
  m.presenter.frame(m.windowNode);
  const [, , firstKey] = m.bridge.argsOf('addAnimation')[0];
  m.bridge.setPresentation([0.5, 0, 0.5, 1]); // mid-flight, as the bridge reports it
  await m.rerender({ ...fade, backgroundColor: '#00ff00' });
  m.presenter.frame(m.windowNode);
  const anims = m.bridge.argsOf('addAnimation');
  assert.strictEqual(anims.length, 2);
  assert.deepStrictEqual(anims[1][1].from, [0.5, 0, 0.5, 1]);
  assert.deepStrictEqual(anims[1][1].to, [0, 1, 0, 1]);
  assert.deepStrictEqual(m.bridge.argsOf('removeAnimation'), [[firstKey]]);
});

test('what the layer cannot express stays on the frame clock', async () => {
  const clock = withFrameClock();
  try {
    // a per-edge border makes the box a raster: its background is in the bitmap
    const raster = { borderTopWidth: 1, borderColor: '#000000', ...fade };
    const m = await mountAnimated(raster);
    await m.rerender({ ...raster, backgroundColor: '#0000ff' });
    assert.ok(m.windowNode._animating.has(m.node), 'the clock runs it');
    assert.ok(!m.node._anim.get('backgroundColor').offloaded);
    assert.deepStrictEqual(
      cssColorStraight(m.node.style.backgroundColor),
      [1, 0, 0, 1],
      'from the start, as the clock always did',
    );
    m.presenter.frame(m.windowNode);
    assert.strictEqual(m.bridge.argsOf('addAnimation').length, 0);
  } finally {
    clock.restore();
  }
});

test('a loop is one repeating animation in the render server, and stops with the node', async () => {
  const m = await mountAnimated(pulse);
  // declared at mount it started on the clock, before the presenter was
  // wired; the next swap with the same declaration moves it over
  await m.rerender(pulse);
  const entry = m.node._anim.get('backgroundColor');
  assert.ok(entry?.loop && entry.offloaded);
  assert.strictEqual(m.windowNode._animating.size, 0);
  assert.strictEqual(
    m.node.style.backgroundColor,
    '#ff0000',
    'the model rests at the declared value',
  );
  m.presenter.frame(m.windowNode);
  const [[keyPath, opts, key]] = m.bridge.argsOf('addAnimation');
  assert.strictEqual(keyPath, 'backgroundColor');
  assert.deepStrictEqual(
    [
      opts.from,
      opts.to,
      opts.repeat,
      opts.autoreverse,
      opts.timing,
      opts.duration,
    ],
    [[1, 0, 0, 1], [0, 1, 0, 1], Infinity, true, [0, 0, 1, 1], 0.9],
  );
  m.presenter.frame(m.windowNode);
  assert.strictEqual(m.bridge.argsOf('addAnimation').length, 1, 'phase kept');

  await m.rerender({ ...pulse, display: 'none' });
  assert.deepStrictEqual(m.bridge.argsOf('removeAnimation'), [[key]]);
  assert.ok(!m.node._anim?.size);
  m.presenter.frame(m.windowNode);
  assert.strictEqual(m.presenter.liveAnimations.size, 0);
});

test('a layer that turns into a raster hands its loop back to the clock', async () => {
  const m = await mountAnimated(pulse);
  await m.rerender(pulse);
  m.presenter.frame(m.windowNode);
  assert.strictEqual(m.bridge.argsOf('addAnimation').length, 1);
  await m.rerender({ ...pulse, borderTopWidth: 1, borderColor: '#000000' });
  m.presenter.frame(m.windowNode);
  const entry = m.node._anim.get('backgroundColor');
  assert.ok(entry?.loop && !entry.offloaded, 'the clock has it again');
  assert.ok(m.windowNode._animating.has(m.node));
  assert.strictEqual(m.presenter.liveAnimations.size, 0);
});

test('a transition whose layer turns raster before its frame goes to the clock', async () => {
  const clock = withFrameClock();
  try {
    const m = await mountAnimated(fade);
    await m.rerender({ ...fade, backgroundColor: '#0000ff' });
    assert.ok(m.node._anim.get('backgroundColor').offloaded);
    // a second swap before the frame: the target now paints as a raster
    await m.rerender({
      ...fade,
      backgroundColor: '#0000ff',
      borderTopWidth: 1,
      borderColor: '#000000',
    });
    m.presenter.frame(m.windowNode);
    const entry = m.node._anim.get('backgroundColor');
    assert.ok(entry && !entry.offloaded);
    assert.ok(m.windowNode._animating.has(m.node));
    assert.strictEqual(
      m.node.style.backgroundColor,
      '#ff0000',
      'from the declared start',
    );
    assert.strictEqual(m.bridge.argsOf('addAnimation').length, 0);
  } finally {
    clock.restore();
  }
});
