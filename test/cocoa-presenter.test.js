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
import { renderX11, cleanup, screen } from '../src/testing/index.js';
import { CocoaLayerPresenter } from '../src/cocoa/presenter.js';
import { CocoaContext2D } from '../src/cocoa/context2d.js';

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

/** A bridge that records every call and answers the few that need a handle. */
function fakeBridge() {
  const calls = [];
  let surfaces = 0;
  const native = new Proxy(
    {},
    {
      get(_, name) {
        if (typeof name !== 'string') return undefined;
        return (...args) => {
          calls.push({ name, args });
          if (name.startsWith('create') && name.endsWith('Layer')) {
            return { layer: calls.length };
          }
          if (name === 'createSurface') {
            return { surface: ++surfaces, width: args[0], height: args[1] };
          }
          if (name === 'surfaceSize') {
            return { width: args[0].width, height: args[0].height };
          }
          return undefined;
        };
      },
    },
  );
  return {
    native,
    calls,
    /** The arguments after the surface handle, per call of `name`. */
    argsOf: (name) =>
      calls.filter((c) => c.name === name).map((c) => c.args.slice(1)),
    uploads: () => calls.filter((c) => c.name === 'surfaceToLayer').length,
  };
}

/** The presenter over a fake cocoa window, wired to the mounted tree's
 * invalidate channel the way src/cocoa/window.js wires it in layers mode. */
function presenterFor({ windowNode, app }) {
  const bridge = fakeBridge();
  const presenter = new CocoaLayerPresenter({
    _native: bridge.native,
    scale: 1,
    app: { fonts: app.fonts, _parseColor: (c) => cssColorStraight(String(c)) },
    _layer: { layer: 'root' },
  });
  windowNode.window.noteInvalidate = (damage, layoutChanged) =>
    presenter.noteInvalidate(damage, layoutChanged);
  return { presenter, bridge };
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
