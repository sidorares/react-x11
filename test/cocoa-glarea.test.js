// <glarea> on the Cocoa backend (src/cocoa/glarea.js) over the fake bridge:
// the real CocoaApp, window and node tree, and a GL runtime with nothing
// behind it, so what a test pins is the layer calls that went out.
//
// The surface is a sublayer of the window's root layer, placed outside
// either presenter's frame. Core Animation animates every animatable key a
// standalone layer is handed outside a disabled-actions transaction — a
// quarter of a second, from wherever the layer was — so each of those sets
// has to open its own. Without one the surface grew into place at mount
// and trailed every step of a live resize.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { createRoot } from '../src/index.js';
import { fakeCocoaApp, tick } from './helpers/cocoa-bridge.js';

const h = React.createElement;

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

/** A GL runtime with nothing behind it: targets are ids, draws are no-ops. */
function fakeGLRuntime() {
  let seq = 1000;
  const noop = () => {};
  return {
    gl: {
      viewport: noop,
      clearColor: noop,
      clear: noop,
      flush: noop,
      bindFramebuffer: noop,
      COLOR_BUFFER_BIT: 0x4000,
      DEPTH_BUFFER_BIT: 0x100,
    },
    glVersion: '4.1',
    frameInterval: 16,
    ctx: {
      createTarget: () => {
        const id = ++seq;
        return { iosurfaceId: id, fbo: id, destroy: noop };
      },
      bindTarget: noop,
    },
  };
}

const findGLArea = (node) =>
  node.isGlArea ? node : (node.children ?? []).map(findGLArea).find(Boolean);

/**
 * A `<glarea>` inset 10px in a 200x120 `<window>` at scale 2, mounted, its
 * surface created and a frame run.
 */
async function mountGLArea() {
  const { native, app } = fakeCocoaApp();
  // the runtime chooseGLConfig resolves, settled before anything asks: no
  // x11-dri and no CGL context, so this runs on any OS
  const runtime = fakeGLRuntime();
  app._cocoaGL = runtime;
  app._cocoaGLPromise = Promise.resolve(runtime);
  const root = await createRoot({ app });
  roots.push(root);
  root.render(
    h(
      'window',
      { width: 200, height: 120 },
      h(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        h('glarea', { style: { flexGrow: 1 } }),
      ),
    ),
  );
  await tick();
  const wnd = [...app._windows.values()][0];
  const node = findGLArea(wnd._reactX11Node);
  for (let i = 0; i < 10 && !node.window; i++) await tick();
  assert.ok(node.window, 'the surface was created');
  const frame = () => {
    app._tickFrames();
    app._presentAll();
  };
  frame();
  return { native, wnd, node, frame };
}

/**
 * Every `setLayerProps` on `layer`, in order, each with whether a
 * disabled-actions transaction was open around it.
 */
function layerSets(native, layer) {
  const open = [];
  const sets = [];
  for (const { name, args } of native.calls) {
    if (name === 'txBegin') open.push(args[0]?.disableActions === true);
    else if (name === 'txCommit') open.pop();
    else if (name === 'setLayerProps' && args[0] === layer) {
      sets.push({ props: args[1], still: open.includes(true) });
    }
  }
  return sets;
}

test('the surface is placed at mount without an implicit animation', async () => {
  const { native, node } = await mountGLArea();
  const layer = node.window.layer;
  const sets = layerSets(native, layer);
  assert.ok(sets.length > 0);
  assert.deepEqual(
    sets.filter((s) => !s.still).map((s) => s.props),
    [],
    'every set went out with actions off',
  );
  // in points: the 10px inset of the 200x120 window, flipped for GL's rows
  assert.deepEqual(layer.props.frame, [10, 10, 180, 100]);
  assert.deepEqual(layer.props.transform, { scaleY: -1 });
  assert.equal(layer.props.hidden, false);
});

test('a window resize moves the surface without an implicit animation', async () => {
  const { native, wnd, node, frame } = await mountGLArea();
  const layer = node.window.layer;
  const mounted = layerSets(native, layer).length;
  // device px, the unit CocoaWindow.resize takes: 300x180 points
  wnd.resize(600, 360);
  frame();
  const sets = layerSets(native, layer).slice(mounted);
  assert.ok(sets.length > 0, 'the resize reached the layer');
  assert.deepEqual(
    sets.filter((s) => !s.still).map((s) => s.props),
    [],
    'every set went out with actions off',
  );
  assert.deepEqual(layer.props.frame, [10, 10, 280, 160]);
});
