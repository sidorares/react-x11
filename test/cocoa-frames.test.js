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
//   - a window nobody can see owes no frame and no present — ordered out,
//     miniaturized, or entirely behind another application's window;
//   - a wheel notch is answered on the event, like a press.
//
// And three more from the pass after it (#442, over bridge 0.4):
//
//   - the pair a resize retires is released on the spot, not on GC;
//   - a window paces itself on the display it is on, and each window on
//     its own;
//   - an occlusion event holds the frames and the present until the
//     window is back on glass.
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
function fakeBridge({ screens } = {}) {
  const calls = [];
  let seq = 0;
  let backendCb = null;
  const native = {
    calls,
    of: (name) => calls.filter((c) => c[0] === name),
    visible: true,
    emit: (ev) => backendCb?.(ev),
    listScreens: () =>
      screens ?? [
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
      x: handle.options.x ?? 0,
      y: handle.options.y ?? 0,
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
      if (typeof x === 'number') handle.options.x = x;
      if (typeof y === 'number') handle.options.y = y;
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
        x: handle.options.x ?? 0,
        y: handle.options.y ?? 0,
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
    releaseSurface(handle) {
      calls.push(['releaseSurface', handle.id]);
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
async function mount(
  children,
  { width = 100, height = 80, screens, frameInterval = 0, ...attrs } = {},
) {
  const native = fakeBridge({ screens });
  const app = new CocoaApp(native);
  setScaleForTests(app, 2, 'cocoa');
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 2880, height: 1800 }],
    workArea: { x: 0, y: 0, width: 2880, height: 1750 },
  });
  setCompositingForTests(app, true);
  app._frameInterval = frameInterval;
  native.setBackendEventCallback((ev) => app._route(ev));
  const root = await createRoot({ app });
  roots.push(root);
  root.render(h('window', { width, height, ...attrs }, children));
  await tick();
  const wnd = [...app._windows.values()][0];
  const node = wnd._reactX11Node;
  const flushes = countFlushes(node);
  app._tickFrames();
  return { native, app, root, wnd, node, flushes };
}

/** Frames that painted, and how many of them were full. */
function countFlushes(node) {
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
  return flushes;
}

/**
 * The pane's end of a `<Frame>`: the app in pane mode, its window over the
 * shared ring rather than an NSWindow, geometry and input arriving as
 * channel messages and presents leaving as them (src/cocoa/panewindow.js).
 * `deliver` is the host speaking; `sent` is what the pane said back.
 */
async function mountPane(children, { width = 100, height = 80 } = {}) {
  const native = fakeBridge({});
  const app = new CocoaApp(native, { pane: true });
  setScaleForTests(app, 2, 'cocoa');
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 2880, height: 1800 }],
    workArea: { x: 0, y: 0, width: 2880, height: 1750 },
  });
  setCompositingForTests(app, true);
  app._frameInterval = 0;
  const sent = [];
  let onMessage = null;
  app.attachPaneChannel({
    send: (msg) => sent.push(msg),
    onMessage: (cb) => {
      onMessage = cb;
    },
  });
  const root = await createRoot({ app });
  roots.push(root);
  root.render(h('window', { width, height, embeddable: true }, children));
  await tick();
  const wnd = [...app._windows.values()][0];
  const node = wnd._reactX11Node;
  const flushes = countFlushes(node);
  app._tickFrames();
  const presents = () => sent.filter((m) => m.type === 'pane-present');
  return { app, wnd, node, flushes, presents, deliver: (m) => onMessage(m) };
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

test("a window entirely behind another application's window owes nothing until it is back", async () => {
  const { native, app, wnd, node, flushes } = await mount(
    box({ flexGrow: 1, backgroundColor: '#3498db' }),
  );
  const inner = node.children[0];
  // windowDidChangeOcclusionState: no pixel of this window is on glass
  native.emit({
    type: 'window-occlusion',
    windowNumber: wnd.windowNumber,
    visible: false,
  });
  assert.equal(wnd._visible(), false);
  inner.invalidate(false, inner, 'props');
  app._tickFrames();
  assert.equal(flushes.count, 1, 'the frame waits');
  assert.equal(app._rafQueue.length, 1, 'in the queue');
  const before = flips(native);
  wnd._dirty = true;
  wnd.present();
  assert.equal(flips(native), before, 'no present while covered');
  assert.equal(wnd._dirty, true, 'but it is still owed');

  // the cover moves away
  native.emit({
    type: 'window-occlusion',
    windowNumber: wnd.windowNumber,
    visible: true,
  });
  assert.equal(wnd._visible(), true);
  app._tickFrames();
  assert.equal(flushes.count, 2, 'one catch-up frame');
  wnd.present();
  assert.equal(flips(native), before + 1, 'presented on return');
  assert.equal(app._rafQueue.length, 0);
});

test('mapping a window is a claim that it is on glass, whatever the last occlusion event said', async () => {
  const { native, wnd } = await mount(box({ flexGrow: 1 }));
  native.emit({
    type: 'window-occlusion',
    windowNumber: wnd.windowNumber,
    visible: false,
  });
  wnd.unmap();
  assert.equal(wnd._visible(), false);
  // the show fires its own occlusion event a pump later; until it lands
  // the frames must not wait on the one delivered before the hide
  wnd.map();
  assert.equal(wnd._occluded, false);
  assert.equal(wnd._visible(), true);
});

test('an occlusion event for a window that is gone is nothing', async () => {
  const { native, app, wnd } = await mount(box({ flexGrow: 1 }));
  const number = wnd.windowNumber;
  wnd.destroy();
  native.emit({
    type: 'window-occlusion',
    windowNumber: number,
    visible: false,
  });
  native.emit({ type: 'window-occlusion', windowNumber: 999, visible: false });
  assert.equal(app._windows.size, 0);
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

// --- the swapchain's memory ------------------------------------------------------

test('the pair a resize retires is released on the spot, and the last pair with the window', async () => {
  const { native, wnd } = await mount(
    box({ flexGrow: 1, backgroundColor: '#3498db' }),
  );
  const made = () => native.of('createSurfaceIOSurface').length;
  const released = () => native.of('releaseSurface').length;
  assert.equal(made(), 2, 'the mount pair');
  assert.equal(released(), 0);
  // five ticks of a drag: each retires the pair before it
  for (let i = 1; i <= 5; i += 1) {
    native.setWindowFrame(wnd._h, null, null, 100 + i * 4, 80 + i * 2);
  }
  assert.equal(made(), 12);
  assert.equal(released(), 10, 'every retired handle, at the tick');
  // never the pair in use: the live back buffer and the frame on glass
  const live = [wnd._chain.back.handle.id, wnd._chain.front.handle.id];
  for (const [, id] of native.of('releaseSurface')) {
    assert.ok(!live.includes(id), `released a live surface ${id}`);
  }
  wnd.destroy();
  assert.equal(released(), 12, 'and the last pair goes with the window');
  assert.equal(wnd._chain, null);
  assert.equal(wnd._surface, null);
});

test('a bridge without releaseSurface leaves the retired pair to the finalizer', async () => {
  const { native, wnd } = await mount(
    box({ flexGrow: 1, backgroundColor: '#3498db' }),
  );
  delete native.releaseSurface; // the Proxy answers a no-op for it now
  native.setWindowFrame(wnd._h, null, null, 120, 90);
  assert.equal(native.of('releaseSurface').length, 0);
  assert.equal(native.of('createSurfaceIOSurface').length, 4);
  wnd.destroy();
});

// --- the cadence ------------------------------------------------------------------

const twoScreens = [
  {
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
    scale: 2,
    visible: { x: 0, y: 0, width: 1440, height: 875 },
    primary: true,
    fps: 120,
  },
  {
    x: 1440,
    y: 0,
    width: 2560,
    height: 1440,
    scale: 2,
    visible: { x: 1440, y: 0, width: 2560, height: 1440 },
    primary: false,
    fps: 60,
  },
];

test('a window paces itself on the display it is on', async () => {
  const { app, wnd, native } = await mount(box({ flexGrow: 1 }), {
    screens: twoScreens,
    frameInterval: null,
  });
  // on the 120Hz panel: one frame per refresh
  assert.ok(
    Math.abs(wnd._frameInterval - 1000 / 120) < 1e-9,
    `${wnd._frameInterval}`,
  );
  // dragged onto the 60Hz monitor (points; the window is 50x40 there)
  native.setWindowFrame(wnd._h, 1500, 100, null, null);
  assert.ok(Math.abs(wnd._frameInterval - 1000 / 60) < 1e-9);
  // and back, by the renderer's own move
  wnd.move(0, 0);
  assert.ok(Math.abs(wnd._frameInterval - 1000 / 120) < 1e-9);
  // a frame no window owns takes the primary's period
  assert.ok(Math.abs(app.frameIntervalFor(null) - 1000 / 120) < 1e-9);
});

test('a screen the OS reports no rate for, and a bridge that reports none, pace at 60Hz', async () => {
  const silent = twoScreens.map((sc) => ({ ...sc, fps: 0 }));
  const { wnd: a } = await mount(box({ flexGrow: 1 }), {
    screens: silent,
    frameInterval: null,
  });
  assert.equal(a._frameInterval, 16);
  const { wnd: b } = await mount(box({ flexGrow: 1 }), {
    frameInterval: null, // the default screens carry no fps at all
  });
  assert.equal(b._frameInterval, 16);
  // a window off every screen takes the primary's rate
  const { wnd: c, native } = await mount(box({ flexGrow: 1 }), {
    screens: twoScreens,
    frameInterval: null,
  });
  native.setWindowFrame(c._h, -5000, -5000, null, null);
  assert.ok(Math.abs(c._frameInterval - 1000 / 120) < 1e-9);
});

test('an explicit frameInterval applies to every window, whatever its display', async () => {
  const { wnd, native, app } = await mount(box({ flexGrow: 1 }), {
    screens: twoScreens,
    frameInterval: 8,
  });
  assert.equal(wnd._frameInterval, 8);
  native.setWindowFrame(wnd._h, 1500, 100, null, null);
  assert.equal(wnd._frameInterval, 8);
  assert.equal(app.frameIntervalFor(null), 8);
});

test('two windows keep two clocks: the one on the faster display paints while the other waits', async () => {
  const {
    app,
    wnd: fast,
    native,
  } = await mount(box({ flexGrow: 1 }), {
    screens: twoScreens,
    frameInterval: null,
  });
  app._pumpInterval = 8;
  const slow = app.createWindow({ width: 100, height: 80, x: 3000, y: 200 });
  slow.map();
  assert.ok(Math.abs(slow._frameInterval - 1000 / 60) < 1e-9);
  let fastRan = 0;
  let slowRan = 0;
  fast.requestAnimationFrame(() => (fastRan += 1));
  fast.requestAnimationFrame(() => (fastRan += 1));
  slow.requestAnimationFrame(() => (slowRan += 1));
  // 9ms since either last painted: past the 120Hz gate (8.3 - 4), short
  // of the 60Hz one (16.7 - 4)
  fast._rafLast = performance.now() - 9;
  slow._rafLast = performance.now() - 9;
  app._tickFrames();
  assert.equal(fastRan, 2, 'every frame the fast window queued');
  assert.equal(slowRan, 0);
  assert.equal(app._rafQueue.length, 1, 'the slow one waits');
  slow._rafLast = performance.now() - 14;
  app._tickFrames();
  assert.equal(slowRan, 1);
  assert.equal(app._rafQueue.length, 0);
  slow.destroy();
  void native;
});

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

// --- a pane -------------------------------------------------------------------------

test('a pane answers a burst of geometry with one frame, not one per message', async () => {
  const { app, wnd, flushes, presents, deliver } = await mountPane(
    box({ flexGrow: 1, backgroundColor: '#3498db' }),
  );
  assert.equal(flushes.count, 1, 'the mount frame');
  // The gate on, at any interval: what is under test is that a present
  // counts as in flight at all, not for how long.
  app._frameInterval = 1e9;
  // A pane that was busy painting finds the host's messages queued behind
  // it — one resize tick per 16ms of the drag — and Node hands them over
  // back to back. The first, after a quiet interval, is answered on the
  // spot, like a press…
  deliver({ type: 'pane-rect', width: 104, height: 82, scale: 2 });
  assert.equal(flushes.count, 2, 'answered on the spot');
  assert.equal(presents().length, 1, 'and presented');
  assert.equal(wnd.frameInFlight(), true, 'which is now in flight');
  // …and the rest of the burst finds that present in flight: each one
  // resizes the window and asks for a frame, none of them paints
  for (let i = 2; i <= 8; i += 1) {
    deliver({ type: 'pane-rect', width: 100 + i * 4, height: 80 + i * 2 });
  }
  assert.equal(wnd.width, 264, 'the window is the size the burst ended on');
  assert.equal(flushes.count, 2, 'without a frame per message');
  assert.equal(presents().length, 1);
  // the pump: one paced frame, at that size
  app._rafLast = -Infinity;
  app._tickFrames();
  app._presentAll();
  assert.equal(flushes.count, 3, 'one catch-up frame');
  assert.equal(flushes.full, 3, 'a full one');
  const last = presents().at(-1);
  assert.equal(presents().length, 2);
  assert.deepEqual([last.width, last.height], [264, 192]);
  // the interval passes: the next lone message is answered on the spot again
  wnd._presentedAt = -Infinity;
  deliver({ type: 'pane-rect', width: 140, height: 100 });
  assert.equal(flushes.count, 4);
  assert.equal(presents().length, 3);
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
