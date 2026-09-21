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
import { fakeCocoaApp, pointerOver, tick } from './helpers/cocoa-bridge.js';

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
 * surface created and a frame run. `area` and `box` are extra props for the
 * surface and the box around it, `children` the surface's own, `sibling` one
 * more child of the box, after the surface.
 *
 * `period` puts a real display period on both clocks — the runtime's, which
 * the swap gate holds for, and the window's, which paces the frames — where
 * the default leaves the window's off, the way most of these tests want it.
 */
async function mountGLArea({
  area = {},
  box = {},
  children = null,
  sibling = null,
  period = null,
} = {}) {
  const { native, app } = fakeCocoaApp();
  // the runtime chooseGLConfig resolves, settled before anything asks: no
  // x11-dri and no CGL context, so this runs on any OS
  const runtime = fakeGLRuntime();
  if (period != null) {
    runtime.frameInterval = period;
    app._frameInterval = period;
  }
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
        { style: { flexGrow: 1, padding: 10 }, ...box },
        h('glarea', { key: 'gl', style: { flexGrow: 1 }, ...area }, children),
        sibling,
      ),
    ),
  );
  await tick();
  const wnd = [...app._windows.values()][0];
  wnd._refreshFrameInterval();
  const node = findGLArea(wnd._reactX11Node);
  for (let i = 0; i < 10 && !node.window; i++) await tick();
  assert.ok(node.window, 'the surface was created');
  const frame = (now) => {
    app._tickFrames(now);
    app._presentAll();
  };
  frame();
  return { native, app, root, wnd, node, frame, runtime };
}

/** A box at a corner of the surface, 20x10 points, half transparent. */
const legend = (props = {}) =>
  h('box', {
    style: {
      position: 'absolute',
      left: 5,
      top: 5,
      width: 20,
      height: 10,
      backgroundColor: 'rgba(255, 0, 0, 0.5)',
    },
    ...props,
  });

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

/**
 * Every `addSublayer` and `removeFromSuperlayer` of `layer`, in order, each
 * with whether a disabled-actions transaction was open around it. A bare
 * one takes Core Animation's order-in or order-out fade (#638).
 */
function layerMoves(native, layer) {
  const open = [];
  const moves = [];
  for (const { name, args } of native.calls) {
    if (name === 'txBegin') open.push(args[0]?.disableActions === true);
    else if (name === 'txCommit') open.pop();
    else if (
      (name === 'addSublayer' && args[1] === layer) ||
      (name === 'removeFromSuperlayer' && args[0] === layer)
    ) {
      moves.push({ name, still: open.includes(true) });
    }
  }
  return moves;
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

test('the pointer over the surface is dispatched at the <glarea>, and bubbles', async () => {
  // The layer takes no input — pointer events are the NSWindow's — and the
  // window's hit test asks its surfaces before its tree, so a press over the
  // surface lands on the <glarea>: the node X11's event propagation arrives
  // at too. It used to land on the box *behind* the surface, which is all a
  // tree walk can find, and the surface's own handlers never ran.
  const seen = [];
  const log = (who) => (ev) => seen.push([who, ev.type, ev.target]);
  const { native, node } = await mountGLArea({
    area: { onMouseDown: log('area'), onClick: log('area') },
    box: { onMouseDown: log('box') },
  });
  const app = node.app;
  assert.equal(node.forwardsPointer, true);
  pointerOver(app, node, { press: true });
  // targets by identity: a failed deepEqual over nodes util.inspects the
  // whole tree, and hangs the file instead of failing it
  assert.deepEqual(
    seen.map(([who, type, target]) => [who, type, target === node]),
    [
      ['area', 'mouseDown', true],
      ['box', 'mouseDown', true],
      ['area', 'click', true],
    ],
  );
  void native;
});

test('the children are drawn on a transparent layer above the surface', async () => {
  // One pane over the whole surface, because Core Animation composites it:
  // a translucent child blends with the GL frame, which X11 cannot do.
  const { native, wnd, node, frame } = await mountGLArea({
    children: legend(),
  });
  frame();
  const gl = node.window.layer;
  const overlay = wnd._layer.sublayers.find((l) => l.props.zPosition > 1e7);
  assert.ok(overlay, 'a layer over the GL layer');
  assert.ok(overlay !== gl, 'not the GL layer itself');
  assert.equal(gl.props.zPosition, 1e7);
  // exactly over the surface, in points, and on show once painted
  assert.deepEqual(overlay.props.frame, gl.props.frame);
  assert.equal(overlay.props.hidden, false);
  assert.ok(overlay.contents, 'the painted bitmap was pushed to it');
  // the bitmap is the surface's size in device pixels — at scale 2
  const [pane] = node._overlay.panes;
  assert.deepEqual(
    [pane.wnd._surfaceSize.width, pane.wnd._surfaceSize.height],
    [360, 200],
  );
  // transparent: each pass is cleared, never filled with a ground colour
  const surface = pane.wnd._surface;
  const onPane = native.calls.filter((c) => c.args[0] === surface);
  assert.ok(
    onPane.some((c) => c.name === 'ctxClearRect'),
    'cleared',
  );
  // every set on the layer went out with implicit animations off
  const loose = layerSets(native, overlay).filter((s) => !s.still);
  assert.deepEqual(loose, []);
});

test('the pointer over a child of the surface is the child’s', async () => {
  const seen = [];
  const { app, node } = await mountGLArea({
    area: { onMouseDown: (ev) => seen.push(['area', ev.target]) },
    children: legend({ onMouseDown: (ev) => seen.push(['legend', ev.target]) }),
  });
  const [child] = node.children;
  pointerOver(app, child, { press: true });
  assert.deepEqual(
    seen.map(([who, target]) => [who, target === child]),
    [
      ['legend', true],
      ['area', true],
    ],
  );
});

test('a child of the surface is never promoted onto a layer of its own', async () => {
  // A promoted node's layer sits on the root layer at its paint order's
  // zPosition — under the GL layer at 1e7 — so a child of the surface lifted
  // there like any animated box would vanish behind the surface it is drawn
  // over. The control, a sibling of the surface with the same transition, is
  // promoted: the surface presenter promotes by default.
  const fade = (backgroundColor, left) => ({
    position: 'absolute',
    left,
    top: 5,
    width: 20,
    height: 10,
    backgroundColor,
    transition: { backgroundColor: 120 },
  });
  const tree = (color) =>
    h(
      'window',
      { width: 200, height: 120 },
      h(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        h(
          'glarea',
          { key: 'gl', style: { flexGrow: 1 } },
          h('box', { style: fade(color, 5) }),
        ),
        h('box', { key: 'control', style: fade(color, 150) }),
      ),
    );
  const { root, wnd, node, frame } = await mountGLArea({
    children: h('box', { style: fade('#ff0000', 5) }),
    sibling: h('box', { key: 'control', style: fade('#ff0000', 150) }),
  });
  const [child] = node.children;
  const control = node.parent.children[1];
  root.render(tree('#0000ff'));
  await tick();
  assert.ok(wnd._promotion, 'this window promotes');
  // Decided at the swap, not by the frame: the control's animation is taken
  // off the frame clock and offered to a layer, the child's never is. A
  // frame declines a node the paint walk never reaches anyway, so
  // `_promoted` alone could not tell this rule from its absence.
  assert.ok(child._anim?.get('backgroundColor'), 'the child’s is running');
  assert.ok(
    control._anim?.get('backgroundColor')?.offloaded,
    'the control’s is offered to a layer',
  );
  assert.ok(
    !child._anim.get('backgroundColor').offloaded,
    'the child’s stays on the frame clock',
  );
  frame();
  assert.equal(control._promoted, true, 'the control was promoted');
  assert.equal(child._promoted, false, 'the child of the surface was not');
});

test('the layer goes with the last child', async () => {
  const { native, root, wnd, node, frame } = await mountGLArea({
    children: legend(),
  });
  frame();
  const overlay = wnd._layer.sublayers.find((l) => l.props.zPosition > 1e7);
  assert.ok(overlay);
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
  frame();
  assert.equal(overlay.parent, null, 'off the root layer');
  assert.ok(node._overlay === null, 'no overlay left');
  // and it goes at once: a bare removal fades what the children last
  // painted out over a quarter of a second, over a surface still drawing
  assert.deepEqual(layerMoves(native, overlay), [
    { name: 'addSublayer', still: true },
    { name: 'removeFromSuperlayer', still: true },
  ]);
});

test('the surface comes and goes without an implicit animation', async () => {
  const { native, root, node } = await mountGLArea();
  const layer = node.window.layer;
  root.render(h('window', { width: 200, height: 120 }, h('box')));
  await tick();
  assert.equal(layer.parent, null, 'off the root layer');
  assert.deepEqual(layerMoves(native, layer), [
    { name: 'addSublayer', still: true },
    { name: 'removeFromSuperlayer', still: true },
  ]);
});

test('a still surface is not drawn again when the display hands its buffer back', async () => {
  // The surface reopens its gate one display period after every swap and
  // says so through onFrameAvailable. That is a frame that *can* be drawn,
  // not one that is wanted: asking for one each time turned frameLoop
  // 'demand' into a loop at display rate — a still map drew 75 frames a
  // second on macOS, forever.
  let drawn = 0;
  const { node, frame } = await mountGLArea({
    area: {
      onDraw: () => {
        drawn += 1;
      },
    },
  });
  // several gate periods (16ms here), each followed by a frame tick
  const periods = async (n = 4) => {
    for (let i = 0; i < n; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      frame();
    }
  };
  await periods();
  const still = drawn;
  assert.ok(still > 0, 'the first frame was drawn');
  await periods();
  assert.equal(drawn, still, 'and nothing after it');

  // A frame asked for while the gate is closed is refused — and is the one
  // onFrameAvailable is for: it is drawn when the gate opens.
  node.requestFrame();
  frame();
  assert.equal(drawn, still + 1, 'drawn at once, which closes the gate');
  node.requestFrame();
  frame();
  assert.equal(drawn, still + 1, 'refused while it is closed');
  await periods();
  assert.equal(drawn, still + 2, 'drawn once it opens, and then left alone');
});

test("onDraw's info carries the display scale, as DrawInfo declares", async () => {
  // width/height are device pixels; an onDraw that places anything in
  // logical pixels divides by `scale`. Without it that came out NaN and
  // the scene drew nothing, silently.
  const infos = [];
  await mountGLArea({ area: { onDraw: (gl, info) => infos.push(info) } });
  assert.ok(infos.length > 0, 'a frame was drawn');
  const { width, height, scale } = infos[0];
  assert.deepEqual(
    { width, height, scale },
    { width: 360, height: 200, scale: 2 },
  );
});

// A 120Hz panel: the period the runtime holds its gate for and the period
// the window's clock paces frames at are one and the same display's.
const HZ120 = 1000 / 120;

test('the swap gate opens on the window clock’s grid, not a period after the swap', async () => {
  // The two gates used to be in series. The surface reopened one display
  // period after the *swap* — i.e. after the frame's draw cost had already
  // been spent — so it opened at `slot + cost + period`, past the clock's
  // next slot at `slot + period`, and the clock rounded it up to the one
  // after. Two periods for a frame that cost three milliseconds: a 120Hz
  // panel pinned at 60fps (issue #631).
  const { node, wnd, frame } = await mountGLArea({
    period: HZ120,
    area: {
      onDraw: () => {
        // a frame with a real cost, to pin that the gate no longer counts it
        const until = performance.now() + 3;
        while (performance.now() < until);
      },
    },
  });
  frame();
  const slot = wnd.nextFrameAt();
  assert.ok(
    node.gl.canRender(slot),
    'open by the moment the clock hands out the next frame',
  );
  assert.equal(
    node.gl.canRender(slot - 0.001),
    false,
    'and not a moment before it — still one frame per period',
  );
});

test("a frameLoop 'always' scene draws every display period, not every other one", async () => {
  // The gap the issue measures: median one period, not two. The clock is
  // driven by hand at the display's rate (`_tickFrames(now)`), which is
  // every moment it would offer a frame on a 120Hz panel.
  let drawn = 0;
  const { wnd, frame } = await mountGLArea({
    period: HZ120,
    area: {
      frameLoop: 'always',
      onDraw: () => {
        drawn += 1;
      },
    },
  });
  const at = [];
  const start = wnd._rafLast;
  for (let i = 1; i <= 60; i++) {
    const now = start + i * HZ120;
    const before = drawn;
    frame(now);
    if (drawn > before) at.push(now);
  }
  assert.equal(at.length, 60, 'a frame at every refresh the clock offered');
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  assert.ok(
    Math.abs(median - HZ120) < 0.01,
    `median gap ${median.toFixed(2)}ms is one period, not two`,
  );
});
