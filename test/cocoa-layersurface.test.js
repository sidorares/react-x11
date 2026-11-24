// A `LayerSurface` on the macOS surface presenter (src/layersurface.js,
// src/cocoa/surfacelift.js, the `contents` kind in src/cocoa/sprites.js)
// over the fake bridge: a part whose content is a surface the element draws
// into goes on a layer of its own, and every `draw()` after that repoints the
// layer at the frame it made with no frame of the window's own; where the
// part is not lifted the element draws the newest frame itself.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { BoxNode } from '../src/nodes/box.js';
import { createLayerSurface } from '../src/index.js';
import { registerElement, unregisterElement } from '../src/registry.js';
import {
  cleanupCocoa,
  fakeCocoaBridge,
  mountCocoa,
} from './helpers/cocoa-bridge.js';

const h = React.createElement;

afterEach(async () => {
  await cleanupCocoa();
});

class Canvas extends BoxNode {
  constructor(props, app) {
    super(props, app);
    this.kind = 'layercanvas';
    this.source = null;
    this.lifted = new Set();
    this.drawn = 0;
  }
  sprites() {
    if (!this.source?.surface) return null;
    return [
      {
        key: 'canvas',
        rect: { x: 20, y: 20, width: 160, height: 90 },
        contents: this.source,
      },
    ];
  }
  spritesLifted(keys) {
    this.lifted = keys;
  }
  paint(ctx) {
    super.paint(ctx);
    if (this.lifted.has('canvas') || !this.source?.surface) return;
    this.drawn += 1;
    ctx.drawImage(this.source.surface, 20, 20);
  }
}

function withCanvas(t) {
  registerElement('layercanvas', {
    create: (props, app) => new Canvas(props, app),
  });
  t.after(() => unregisterElement('layercanvas'));
}

const el = () =>
  h('layercanvas', {
    key: 'c',
    style: { position: 'absolute', left: 0, top: 0, width: 200, height: 120 },
  });

const find = (n) => {
  if (n.kind === 'layercanvas') return n;
  for (const c of n.children ?? []) {
    const hit = find(c);
    if (hit) return hit;
  }
  return null;
};

const liftedState = (promotion) => {
  const host = [...promotion.sprites.hosts.values()][0];
  return host ? [...host.values()][0] : undefined;
};

test('a layer surface is offered once it has a frame, and shown by each draw with no frame of the window', async (t) => {
  withCanvas(t);
  const { native, app, frame, frames, promotion, node } =
    await mountCocoa(el());
  const layer = createLayerSurface(app, { width: 160, height: 90 });
  const canvas = find(node);
  canvas.source = layer;
  frame();
  assert.equal(promotion.sprites.hosts.size, 0, 'nothing to show yet');

  layer.draw((ctx) => ctx.fillRect(0, 0, 160, 90), { full: true });
  canvas.spritesChanged();
  frame();
  const state = liftedState(promotion);
  assert.ok(state, 'lifted');
  assert.equal(state.contents, layer);
  assert.ok(canvas.lifted.has('canvas'), 'told, so it leaves a hole');
  const first = layer.surface;
  assert.ok(first.iosurfaceId > 0, 'an IOSurface-backed frame');
  assert.equal(state.layer.ioSurface, first.iosurfaceId);

  // a draw is a layer change and no frame
  const before = frames.count;
  layer.draw((ctx) => ctx.fillRect(0, 0, 10, 10));
  assert.notEqual(layer.surface, first, 'drawn into the other one');
  assert.equal(state.layer.ioSurface, layer.surface.iosurfaceId);
  assert.equal(frames.count, before, 'no frame of the window');
  assert.equal(canvas.drawn, 0, 'the element drew none of it');
  // and a frame that follows paints nothing of it either
  frame();
  assert.equal(canvas.drawn, 0);
  void native;
});

test('a frame starts as the one before it, unless it says it draws every pixel', async (t) => {
  withCanvas(t);
  const { native, app } = await mountCocoa(el());
  const layer = createLayerSurface(app, { width: 160, height: 90 });
  layer.draw(() => {}, { full: true });
  const copies = () => native.of('blitSurface').length;
  const none = copies();
  layer.draw(() => {});
  assert.equal(copies(), none + 1, 'the last frame carried over');
  layer.draw(() => {}, { full: true });
  assert.equal(copies(), none + 1, 'nothing carried over');
});

test('a surface the render server still reads is not drawn into, and a ring is as long as it has to be', async (t) => {
  withCanvas(t);
  const native = fakeCocoaBridge();
  native.surfaceIsInUse = (handle) => handle.busy === true;
  const { app } = await mountCocoa(el(), { native });
  const layer = createLayerSurface(app, { width: 64, height: 64 });
  layer.draw(() => {}, { full: true });
  const a = layer.surface;
  a._surfaceHandle.busy = true;
  layer.draw(() => {}, { full: true });
  const b = layer.surface;
  assert.notEqual(a, b);
  b._surfaceHandle.busy = true;
  layer.draw(() => {}, { full: true });
  const c = layer.surface;
  assert.ok(c !== a && c !== b, 'a third, with both held');
  a._surfaceHandle.busy = false;
  layer.draw(() => {}, { full: true });
  assert.equal(layer.surface, a, 'one let go of is drawn into again');
});

test('over a bridge that cannot show an IOSurface nothing is lifted, and the element draws the newest frame', async (t) => {
  withCanvas(t);
  const native = fakeCocoaBridge();
  native.createSurfaceIOSurface = undefined;
  const { app, frame, promotion, node } = await mountCocoa(el(), { native });
  const layer = createLayerSurface(app, { width: 160, height: 90 });
  find(node).source = layer;
  layer.draw((ctx) => ctx.fillRect(0, 0, 160, 90), { full: true });
  find(node).spritesChanged();
  frame();
  assert.equal(promotion?.sprites.hosts.size ?? 0, 0, 'declined');
  assert.ok(layer.surface, 'a surface to draw from');
});

test('closing the surface takes the part off its layer', async (t) => {
  withCanvas(t);
  const { app, frame, promotion, node } = await mountCocoa(el());
  const layer = createLayerSurface(app, { width: 160, height: 90 });
  find(node).source = layer;
  layer.draw(() => {}, { full: true });
  find(node).spritesChanged();
  frame();
  assert.ok(liftedState(promotion));
  layer.close();
  find(node).source = null;
  find(node).spritesChanged();
  frame();
  assert.equal(promotion.sprites.hosts.size, 0);
  assert.equal(layer.surface, null);
});
