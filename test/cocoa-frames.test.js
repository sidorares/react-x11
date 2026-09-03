// The Cocoa backend's frame clock and swapchain, over a fake bridge — the
// shape of cocoa-surface.test.js: what reaches the natives is the whole of
// what the glue decides, so a bridge that records its calls is the pixels'
// witness. Four rules pinned here, each measured before it was written
// (scripts/bench/presenters.js, the `resize`, `occluded`, `hover` and
// `scroll` scenarios):
//
//   - a live-resize tick is ONE full frame, and its microtasks add none;
//   - a bounded flush onto a fresh backing surface asks for a full frame and
//     holds the present until it lands, so garbage is never on glass;
//   - a window nobody can see owes no frame and no present;
//   - a wheel notch is answered on the event, like a press.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { CocoaApp } from '../src/cocoa/app.js';
import { setCompositingForTests } from '../src/compositing.js';
import { createRoot } from '../src/index.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';

process.env.NO_AT_BRIDGE ??= '1';

const h = React.createElement;

// --- the fake bridge ----------------------------------------------------------

/**
 * Enough of @windowkit/appkit for a window with a box tree: windows carry
 * a number and a frame, `setWindowFrame` answers the way AppKit's delegate
 * does (a `window-resize` event through the backend callback, synchronously,
 * from inside the call), surfaces are handles with a size, and every verb
 * that decides something is recorded.
 */
function fakeBridge() {
  const calls = [];
  let seq = 0;
  let backendCb = null;
  const native = {
    calls,
    of: (name) => calls.filter((c) => c[0] === name),
    visible: true,
    listScreens: () => [
      {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        scale: 2,
        visible: { x: 0, y: 0, width: 1440, height: 875 },
        primary: true,
      },
    ],
    createWindow2(options) {
      const handle = { id: ++seq, options: { ...options } };
      calls.push(['createWindow2', options.width, options.height]);
      return handle;
    },
    windowNumber: (handle) => handle.id,
    windowRootLayer: (handle) => ({ root: handle.id }),
    getWindowFrame: (handle) => ({
      x: 0,
      y: 0,
      width: handle.options.width,
      height: handle.options.height,
    }),
    showWindow(handle) {
      calls.push(['showWindow', handle.id]);
    },
    hideWindow(handle) {
      calls.push(['hideWindow', handle.id]);
    },
    windowIsVisible: () => native.visible,
    setBackendEventCallback(cb) {
      backendCb = cb;
    },
    initApp() {},
    setWindowFrame(handle, x, y, width, height) {
      if (typeof width === 'number') handle.options.width = width;
      if (typeof height === 'number') handle.options.height = height;
      calls.push([
        'setWindowFrame',
        handle.options.width,
        handle.options.height,
      ]);
      // the delegate's windowDidResize, from inside setFrame: — the route a
      // drag takes, minus the modal loop around it
      backendCb?.({
        type: 'window-resize',
        windowNumber: handle.id,
        width: handle.options.width,
        height: handle.options.height,
        x: 0,
        y: 0,
        live: true,
      });
    },
    createSurfaceIOSurface(width, height, scale) {
      const id = ++seq;
      calls.push(['createSurfaceIOSurface', width, height]);
      return { handle: { id, width, height, scale }, iosurfaceId: id };
    },
    createSurface(width, height, scale) {
      calls.push(['createSurface', width, height]);
      return { id: ++seq, width, height, scale };
    },
    surfaceSize: (handle) => ({
      width: handle.width,
      height: handle.height,
      scale: handle.scale,
    }),
    setLayerContentsIOSurface(layer, id) {
      calls.push(['flip', id]);
    },
    copySurfaceRegion(src, dst, rects) {
      calls.push(['copy', rects ? rects.length / 4 : 'all']);
    },
    ctxClearRect(handle, ...rect) {
      calls.push(['ctxClearRect', ...rect]);
    },
    ctxFillRect(handle, ...rect) {
      calls.push(['ctxFillRect', ...rect]);
    },
    scrollSurface() {
      calls.push(['scrollSurface']);
      return true;
    },
  };
  return new Proxy(native, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

/**
 * A CocoaApp over the fake, seeded the way `createCocoaApp` seeds the
 * platform stores, with no pump: frames tick when the test says so
 * (`app._tickFrames()`), and the cadence gate is off unless a test turns
 * it on.
 */
async function mount(children, { width = 100, height = 80 } = {}) {
  const native = fakeBridge();
  const app = new CocoaApp(native);
  setScaleForTests(app, 2, 'cocoa');
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 2880, height: 1800 }],
    workArea: { x: 0, y: 0, width: 2880, height: 1750 },
  });
  setCompositingForTests(app, true);
  app._frameInterval = 0;
  native.setBackendEventCallback((ev) => app._route(ev));
  const root = await createRoot({ app });
  roots.push(root);
  root.render(h('window', { width, height }, children));
  await tick();
  const wnd = [...app._windows.values()][0];
  const node = wnd._reactX11Node;
  const flushes = { count: 0, full: 0 };
  const flush = node.flush.bind(node);
  node.flush = (...a) => {
    const painting =
      node.needsPaint || node.needsLayout || node._animating.size > 0;
    const out = flush(...a);
    if (painting) {
      flushes.count += 1;
      if (!node._lastDamageRects) flushes.full += 1;
    }
    return out;
  };
  app._tickFrames();
  return { native, app, root, wnd, node, flushes };
}

const box = (style) => h('box', { style });

const flips = (native) => native.of('flip').length;

// --- a live resize --------------------------------------------------------------

test('a resize tick is one full frame, and its microtasks add none', async () => {
  const { native, app, wnd, flushes } = await mount(
    box({ flexGrow: 1, backgroundColor: '#3498db' }),
  );
  assert.equal(flushes.count, 1, 'the mount frame');
  assert.equal(native.of('createSurfaceIOSurface').length, 2, 'one pair');

  // five ticks of a drag, each answered from inside the delegate
  for (let i = 1; i <= 5; i += 1) {
    native.setWindowFrame(wnd._h, null, null, 100 + i * 4, 80 + i * 2);
  }
  assert.equal(flushes.count, 6, 'one flush per tick, synchronously');
  assert.equal(flushes.full, 6, 'each a full frame');
  assert.equal(
    native.of('createSurfaceIOSurface').length,
    12,
    'a fresh pair per size',
  );
  // the drag ends: everything the ticks queued runs now
  await tick();
  await tick();
  assert.equal(
    flushes.count,
    6,
    'the release owes no frame — the ticks already painted every pixel',
  );
  assert.equal(wnd._holdPresent, false, 'nothing holds the present');
  // the frame each tick scheduled before flushing early is still queued;
  // it runs, finds nothing owed, and paints nothing
  app._tickFrames();
  assert.equal(flushes.count, 6, 'the queued callback is a no-op');
  // every tick presented from inside the delegate — the same early present
  // a press gets — so the release finds nothing left to put on glass
  assert.equal(flips(native), 5, 'one present per tick');
  wnd.present();
  assert.equal(flips(native), 5, 'and nothing owed after');
});

test('the second flush a resize tick queues is one per burst, not one per tick', async () => {
  const { native, app, wnd } = await mount(
    box({ flexGrow: 1, backgroundColor: '#3498db' }),
  );
  const afterInput = [];
  const original = app._afterInput.bind(app);
  app._afterInput = () => {
    afterInput.push('flush');
    return original();
  };
  for (let i = 1; i <= 8; i += 1) {
    native.setWindowFrame(wnd._h, null, null, 100 + i, 80);
  }
  assert.equal(afterInput.length, 8, 'one synchronous flush per tick');
  await tick();
  await tick();
  // the React half of a resize commits on a microtask, and one flush
  // behind it is what paints it — one, because inside AppKit's resize
  // loop no microtask runs until the drag ends, and eight queued here
  // were eight full frames on the mouse release
  assert.equal(afterInput.length, 9, 'and one more for the whole burst');
});

test('a bounded flush onto a fresh surface asks for a full frame and holds the present until it lands', async () => {
  const { native, app, wnd, node, flushes } = await mount(
    h(
      'box',
      { style: { flexGrow: 1, backgroundColor: '#ffffff' } },
      box({ width: 20, height: 20, backgroundColor: '#e74c3c' }),
    ),
  );
  const inner = node.children[0].children[0];
  // the window grows underneath the tree without the 'resize' listener
  // hearing about it: the next frame paints a bounded claim onto a backing
  // surface that is brand new and empty everywhere else
  wnd._nativeResized({ width: 70, height: 60, x: 0, y: 0 });
  inner.invalidate(false, inner, 'props');
  app._tickFrames();
  assert.equal(flushes.count, 2);
  assert.ok(node._lastDamageRects, 'the claim was bounded');
  assert.equal(
    native.of('createSurfaceIOSurface').length,
    4,
    'the surface was replaced under it',
  );
  assert.equal(wnd._holdPresent, true, 'so the present is held');
  const before = flips(native);
  wnd.present();
  assert.equal(flips(native), before, 'garbage never reaches the glass');
  assert.equal(app._rafQueue.length, 1, 'a full frame is on its way');
  app._tickFrames();
  assert.equal(flushes.count, 3);
  assert.equal(node._lastDamageRects, null, 'and it is a full one');
  assert.equal(wnd._holdPresent, false);
  wnd.present();
  assert.equal(flips(native), before + 1, 'which presents');
});

test('a live resize lays out with the floors it has, and measures fresh ones once the drag ends', async () => {
  const { native, app, wnd, node, flushes } = await mount(
    h(
      'box',
      { style: { flexGrow: 1, flexDirection: 'row' } },
      box({ flexGrow: 1, backgroundColor: '#3498db' }),
      box({ flexGrow: 1, backgroundColor: '#e74c3c' }),
    ),
  );
  let measured = 0;
  const apply = node._applyContentFloors.bind(node);
  node._applyContentFloors = (...a) => {
    measured += 1;
    return apply(...a);
  };
  // a drag: five live ticks, no pump between them
  for (let i = 1; i <= 5; i += 1) {
    native.setWindowFrame(wnd._h, null, null, 100 + i * 4, 80 + i * 2);
  }
  assert.equal(flushes.count, 6, 'every tick laid out and painted');
  assert.equal(measured, 0, 'without measuring the floors again');
  assert.equal(wnd.liveResizing, true);
  assert.equal(node._floorsCatchUp, true, 'one catch-up frame is owed');
  // the release: the pump runs, ends the live resize, ticks the frames
  app._endLiveResizes();
  app._tickFrames();
  assert.equal(measured, 1, 'measured once, after the drag');
  assert.equal(flushes.count, 7, 'one catch-up frame');
  assert.equal(flushes.full, 7);
  assert.equal(node._floorsCatchUp, false);
  // a scripted resize — not live — measures on the spot
  app._routeGeometry({
    type: 'window-resize',
    windowNumber: wnd.windowNumber,
    width: 90,
    height: 70,
    x: 0,
    y: 0,
    live: false,
  });
  assert.equal(measured, 2);
  assert.equal(flushes.count, 8);
});

test('a live resize over content the floors have not seen measures them', async () => {
  const { native, app, wnd, node, root } = await mount(
    box({ flexGrow: 1, backgroundColor: '#3498db' }),
  );
  let measured = 0;
  const apply = node._applyContentFloors.bind(node);
  node._applyContentFloors = (...a) => {
    measured += 1;
    return apply(...a);
  };
  // a row mounts mid-drag: its floor does not exist yet, and a frame laid
  // out without one is the collapse the floors exist to prevent
  root.render(
    h(
      'window',
      { width: 100, height: 80 },
      box({ flexGrow: 1, backgroundColor: '#3498db' }),
      box({ height: 20, backgroundColor: '#2ecc71' }),
    ),
  );
  native.setWindowFrame(wnd._h, null, null, 110, 90);
  assert.equal(measured, 1, 'measured on the tick, live or not');
  app._endLiveResizes();
  app._tickFrames();
  assert.equal(measured, 1, 'and nothing was owed after');
});

// --- a window nobody can see -----------------------------------------------------

test('a window that is not on glass owes no frame and no present until it is back', async () => {
  const { native, app, wnd, node, flushes } = await mount(
    box({ flexGrow: 1, backgroundColor: '#3498db' }),
  );
  const inner = node.children[0];
  native.visible = false; // ordered out, miniaturized, the app hidden
  inner.invalidate(false, inner, 'props');
  app._tickFrames();
  assert.equal(flushes.count, 1, 'the frame waits');
  assert.equal(app._rafQueue.length, 1, 'in the queue');
  const before = flips(native);
  // …and a paint that got in through another route stays off the glass
  wnd._dirty = true;
  wnd.present();
  assert.equal(flips(native), before, 'no present while hidden');
  assert.equal(wnd._dirty, true, 'but it is still owed');

  native.visible = true;
  app._tickFrames();
  assert.equal(flushes.count, 2, 'one catch-up frame');
  wnd.present();
  assert.equal(flips(native), before + 1, 'presented on return');
  assert.equal(app._rafQueue.length, 0);
});

test('an unmapped window is not on glass either', async () => {
  const { app, node, flushes, wnd } = await mount(
    box({ flexGrow: 1, backgroundColor: '#3498db' }),
  );
  wnd.unmap();
  node.children[0].invalidate(false, node.children[0], 'props');
  app._tickFrames();
  assert.equal(flushes.count, 1);
  wnd.map();
  app._tickFrames();
  assert.equal(flushes.count, 2);
});

// --- the cadence ------------------------------------------------------------------

test('a frame lands on the first pump tick at or after the interval, not the one after', async () => {
  const { app } = await mount(box({ flexGrow: 1 }));
  app._frameInterval = 16;
  app._pumpInterval = 8;
  let ran = 0;
  app._requestFrame(() => {
    ran += 1;
  });
  // a tick that arrives 10ms after the last frame is the one before the
  // interval — too early
  app._rafLast = performance.now() - 10;
  app._tickFrames();
  assert.equal(ran, 0);
  // 13ms is the tick that straddles it: with the gate at exactly 16 timer
  // drift would push this frame to the tick after, 24ms out
  app._rafLast = performance.now() - 13;
  app._tickFrames();
  assert.equal(ran, 1);
});

// --- the wheel ----------------------------------------------------------------------

test('a wheel notch is answered on the event, like a press', async () => {
  const { app, wnd, node, flushes } = await mount(
    h(
      'box',
      { style: { flexGrow: 1, overflow: 'scroll' } },
      ...Array.from({ length: 20 }, (_, i) =>
        box({ height: 30, backgroundColor: i % 2 ? '#ffffff' : '#eeeeee' }),
      ),
    ),
    { width: 100, height: 100 },
  );
  const scroller = node.children[0];
  assert.equal(scroller.scrollY, 0);
  app._route({
    type: 'wheel',
    windowNumber: wnd.windowNumber,
    x: 50,
    y: 50,
    gx: 50,
    gy: 50,
    dx: 0,
    dy: -3,
    precise: false,
    time: 1,
  });
  assert.ok(scroller.scrollY > 0, 'the notch scrolled');
  assert.equal(
    flushes.count,
    2,
    'and the frame went out before the route returned',
  );
});
