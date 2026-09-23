// A `<glarea>`'s children on Windows: composited layers above the window's
// swap chains (src/win32/overlay.js, over the bridge's src/layer.cc).
//
// Before layers, the overlay asked the backend for a plain child window —
// the X11 answer (src/gloverlay.js) — and `app.createWindow({ parent })` on
// this backend is a GL surface: a WGL context and a swap chain per pane,
// and no 2D context. The children were laid out and painted nowhere, and a
// component that drew their cards under them (`<Flow>`) had nothing on
// screen where they were.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import React from 'react';

import { createRoot } from '../../src/index.js';
import { canOverlay, overlayRefusal } from '../../src/gloverlay.js';
import { Win32App } from '../../src/win32/app.js';
import { Win32Window } from '../../src/win32/window.js';
import { createFakeBridge } from './fake-bridge.js';

const h = React.createElement;

function setup(options) {
  const bridge = createFakeBridge(options);
  const app = new Win32App(bridge, {});
  const wnd = new Win32Window(app, { width: 300, height: 200, title: 'w' });
  wnd._onReady(0, 0);
  return { bridge, app, wnd };
}

async function waitFor(check, what, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('win32 <glarea> overlay: whether there is one', () => {
  it('a bridge with layers composites a pane, and says so', () => {
    const { app } = setup();
    assert.equal(typeof app.createOverlayPane, 'function');
    assert.equal(canOverlay(app), true);
    assert.equal(overlayRefusal(app), null);
  });

  it('a bridge without them draws nothing over a GL surface, and says why', () => {
    const { app } = setup({ layers: false });
    assert.equal(app.createOverlayPane, undefined);
    assert.equal(
      canOverlay(app),
      false,
      'a child window here is a GL surface, not a pane',
    );
    assert.match(overlayRefusal(app), /@windowkit\/win32/);
  });
});

describe('win32 <glarea> overlay: the pane', () => {
  it('is a layer at its rect, moved and hidden where the overlay says', () => {
    const { bridge, app, wnd } = setup();
    const pane = app.createOverlayPane({
      parent: wnd,
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
    const [layer] = bridge.layers.values();
    assert.deepEqual(
      [layer.windowId, layer.x, layer.y, layer.width, layer.height],
      [wnd.id, 10, 20, 100, 50],
    );
    pane.setState({ x: 12, y: 24, width: 90, height: 40 });
    assert.deepEqual(
      [layer.x, layer.y, layer.width, layer.height],
      [12, 24, 90, 40],
    );
    pane.unmap();
    assert.equal(layer.visible, false);
    pane.map();
    assert.equal(layer.visible, true);
    pane.destroy();
    assert.equal(bridge.layers.size, 0, 'the layer went with the pane');
  });

  it('draws a pass through its own BeginDraw, grown to whole pixels, in window coordinates', () => {
    const { bridge, app, wnd } = setup();
    const pane = app.createOverlayPane({
      parent: wnd,
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
    const [layer] = bridge.layers.values();
    const seen = [];
    pane.paintPasses(
      [{ x: 30.5, y: 25.2, width: 10, height: 10 }],
      (ctx, pass) => {
        seen.push(pass);
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(pass.x, pass.y, pass.width, pass.height);
      },
    );
    // grown outward: everything inside a BeginDraw rect is undefined until
    // painted, so the pass the painter clears is the rect the surface gave
    assert.deepEqual(seen, [{ x: 30, y: 25, width: 11, height: 11 }]);
    assert.deepEqual(
      layer.passes,
      [[20, 5, 11, 11]],
      'in the layer’s own space',
    );
    assert.ok(
      layer.ops.some((op) => op[0] === 'ctxFillRect'),
      'and what the painter drew landed on the layer',
    );
    assert.equal(bridge.open.size, 0, 'every pass was ended');
  });

  it('a pass it paints is committed with the window’s frame, even one with no damage of its own', () => {
    const { bridge, app, wnd } = setup();
    const pane = app.createOverlayPane({
      parent: wnd,
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    pane.paintPasses([{ x: 0, y: 0, width: 10, height: 10 }], () => {});
    pane.present();
    const before = bridge.committed;
    wnd.presentFrame({ _paintRegion() {} }, []);
    assert.equal(bridge.committed, before + 1, 'one commit for the frame');
  });

  it('moves pixels with the layer’s own Scroll, whole pixels only', () => {
    const { bridge, app, wnd } = setup();
    const pane = app.createOverlayPane({
      parent: wnd,
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    const [layer] = bridge.layers.values();
    assert.equal(
      pane.scrollRegion({ x: 0, y: 0, width: 100, height: 50 }, 4, 0),
      true,
    );
    assert.equal(
      pane.scrollRegion({ x: 0, y: 0, width: 100, height: 50 }, 2.5, 0),
      false,
    );
    assert.deepEqual(layer.scrolled, [[0, 0, 100, 50, 4, 0]]);
  });

  it('a pane made before its window is composed asks to be painted whole once it can be', async () => {
    const bridge = createFakeBridge();
    const app = new Win32App(bridge, {});
    const wnd = new Win32Window(app, { width: 300, height: 200, title: 'w' });
    const pane = app.createOverlayPane({
      parent: wnd,
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    let owed = 0;
    pane.on('draw', () => owed++);
    pane.paintPasses([{ x: 0, y: 0, width: 10, height: 10 }], () => {
      assert.fail('painted with nothing to paint into');
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(owed, 1, 'the overlay is told its pixels never landed');
    wnd._onReady(0, 0);
    pane.paintPasses([{ x: 0, y: 0, width: 10, height: 10 }], () => {});
    assert.equal(bridge.layers.size, 1, 'and the next paint makes the layer');
  });
});

describe('win32 <glarea> overlay: in a tree', () => {
  it('a child of a <glarea> is painted on a layer over it', async () => {
    const bridge = createFakeBridge();
    // what realizing a window reaches that the fake leaves out
    Object.assign(bridge, {
      dropTargetEnable() {},
      systemAppearance: () => null,
      windowAppId() {},
      windowRelaunch() {},
    });
    const app = new Win32App(bridge, {});
    const root = await createRoot({ app });
    try {
      root.render(
        h(
          'window',
          { width: 300, height: 200 },
          h(
            'glarea',
            { style: { flexGrow: 1 }, onError: () => {} },
            h('box', {
              style: {
                position: 'absolute',
                left: 20,
                top: 30,
                width: 40,
                height: 20,
                backgroundColor: '#ff0000',
              },
            }),
          ),
        ),
      );
      await waitFor(() => bridge.windows.size > 0, 'the window');
      const [id] = bridge.windows.keys();
      app._route({ type: 'window-ready', id, a: 0, b: 0 });
      await waitFor(
        () =>
          [...(bridge.layers?.values() ?? [])].some((layer) =>
            layer.ops.some((op) => op[0] === 'ctxFillRect'),
          ),
        'the child painted on a layer',
      );
      const [layer] = bridge.layers.values();
      assert.equal(layer.windowId, id);
      assert.ok(layer.passes.length > 0);
    } finally {
      await root.unmount();
    }
  });
});
