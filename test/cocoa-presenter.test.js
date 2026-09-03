// The retained layer presenter (src/cocoa/presenter.js) over a recording
// bridge: what it rasters, and when. The node tree, its layout and the
// invalidate channel are the real ones — the mock harness mounts the tree —
// and only the Core Animation bridge is faked, so this runs on every
// platform and says nothing about pixels. What it does pin is the contract
// docs/macos.md §"Custom drawing on a layer tree" makes: a registered
// element that overrides `paint` works unchanged through the raster visual,
// and a damage claim — a node or a bare rect — is what re-rasters it.
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
 * mock window's own frame.
 */
class SceneNode extends Node {
  constructor(props, app) {
    super('scene', props, app);
    this.rasters = 0;
    this.painted = 0;
    this._claimedFromPaint = false;
  }

  paint(ctx) {
    super.paint(ctx);
    if (ctx instanceof CocoaContext2D) this.rasters++;
    else this.painted++;
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
          calls.push(name);
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
    uploads: () => calls.filter((name) => name === 'surfaceToLayer').length,
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
  outer.invalidate(
    false,
    { x: outer.abs.x + 150, y: outer.abs.y + 60, width: 8, height: 8 },
    'props',
  );
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
