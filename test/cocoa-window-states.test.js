// What AppKit does with a window, as the Cocoa backend reports it
// (@windowkit/appkit 0.30.0): the green button's full screen, the zoom, the
// Dock and the key window come back in `_NET_WM_STATE` names, so
// `useWindowState()` and `onStatesChange` read them as they read X11's and
// Wayland's — and `<window fullscreen>` / `states` reach the verbs. Over a
// fake bridge that publishes the state the way the real one does: a
// full-screen transition's target from its `begin`, before the animation,
// which is when a browser takes its toolbar away.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { CocoaApp } from '../src/cocoa/app.js';
import { setCompositingForTests } from '../src/compositing.js';
import { createRoot, useWindowState } from '../src/index.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';

process.env.NO_AT_BRIDGE ??= '1';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Windows with a published state the test sets (`publish`), the verbs
 * recorded, and every other verb a no-op. `verbs: false` is a bridge older
 * than 0.30.0, with no window-state verbs and nothing but `key` published.
 */
function fakeBridge({ verbs = true } = {}) {
  const calls = [];
  let seq = 0;
  let backendCb = null;
  const native = {
    calls,
    of: (name) => calls.filter((c) => c[0] === name),
    frameReads: 0,
    emit: (ev) => backendCb?.(ev),
    publish(handle, state) {
      Object.assign(handle.state, state);
    },
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
      return {
        id: ++seq,
        options: { ...options },
        state: verbs
          ? {
              key: false,
              fullscreen: false,
              zoomed: false,
              miniaturized: false,
            }
          : { key: false },
      };
    },
    windowNumber: (handle) => handle.id,
    windowRootLayer: (handle) => ({ root: handle.id }),
    getWindowFrame(handle) {
      native.frameReads += 1;
      return {
        x: handle.options.x ?? 0,
        y: handle.options.y ?? 0,
        width: handle.options.width,
        height: handle.options.height,
        ...handle.state,
      };
    },
    windowIsVisible: () => true,
    setBackendEventCallback(cb) {
      backendCb = cb;
    },
    createSurfaceIOSurface(width, height, scale) {
      const id = ++seq;
      return {
        handle: { id, width, height, scale, iosurfaceId: id },
        iosurfaceId: id,
      };
    },
    createSurface: (width, height, scale) => ({
      id: ++seq,
      width,
      height,
      scale,
    }),
    surfaceSize: (handle) => ({
      width: handle.width,
      height: handle.height,
      scale: handle.scale,
    }),
    createLayer: () => ({ layer: ++seq }),
  };
  if (verbs) {
    for (const verb of [
      'setWindowFullScreen',
      'setWindowZoomed',
      'setWindowMiniaturized',
    ]) {
      native[verb] = (handle, on) => calls.push([verb, handle.id, on]);
    }
  }
  return new Proxy(native, {
    // every other verb a no-op — but not the window-state verbs, whose
    // absence is what an older bridge looks like
    get: (target, key) =>
      key in target || /^setWindow(FullScreen|Zoomed|Miniaturized)$/.test(key)
        ? target[key]
        : () => undefined,
    has: (target, key) => key in target,
  });
}

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

async function mount(children, { bridge = {}, ...attrs } = {}) {
  const native = fakeBridge(bridge);
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
  const render = (props, kids = children) =>
    root.render(
      h('window', { width: 100, height: 80, ...attrs, ...props }, kids),
    );
  render({});
  await tick();
  const wnd = [...app._windows.values()][0];
  return { native, app, root, wnd, render };
}

/** What a component in the window last read from `useWindowState()`. */
function stateProbe() {
  const seen = [];
  function Probe() {
    const s = useWindowState();
    seen.push(s);
    return h('box', { style: { flexGrow: 1 } });
  }
  return { seen, last: () => seen.at(-1), element: h(Probe) };
}

test('the green button: useWindowState says full screen from the transition’s begin, and not after its exit', async () => {
  const probe = stateProbe();
  const { native, wnd } = await mount(probe.element);
  await tick();
  assert.equal(probe.last().fullscreen, false);

  // windowWillEnterFullScreen: the bridge publishes the target, then says so
  native.publish(wnd._h, { fullscreen: true });
  native.emit({
    type: 'window-fullscreen',
    windowNumber: wnd.windowNumber,
    fullscreen: true,
    phase: 'begin',
  });
  await tick();
  assert.equal(probe.last().fullscreen, true, 'before the animation runs');
  assert.deepEqual(probe.last().states, ['fullscreen']);

  // the end changes nothing: the state was already there
  const renders = probe.seen.length;
  native.emit({
    type: 'window-fullscreen',
    windowNumber: wnd.windowNumber,
    fullscreen: true,
    phase: 'end',
  });
  await tick();
  assert.equal(
    probe.seen.length,
    renders,
    'no render for an end that moved nothing',
  );

  native.publish(wnd._h, { fullscreen: false });
  native.emit({
    type: 'window-fullscreen',
    windowNumber: wnd.windowNumber,
    fullscreen: false,
    phase: 'begin',
  });
  await tick();
  assert.equal(probe.last().fullscreen, false);
});

test('onStatesChange hears the zoom on its resize, the Dock, and the key window, in _NET_WM_STATE names', async () => {
  const heard = [];
  const { native, wnd } = await mount(h('box', { style: { flexGrow: 1 } }), {
    onStatesChange: (states) => heard.push(states),
  });
  // AppKit sends nothing for a zoom but the resize
  native.publish(wnd._h, { zoomed: true });
  native.emit({
    type: 'window-resize',
    windowNumber: wnd.windowNumber,
    width: 1440,
    height: 875,
    x: 0,
    y: 0,
  });
  native.publish(wnd._h, { key: true });
  native.emit({ type: 'window-focus', windowNumber: wnd.windowNumber });
  native.publish(wnd._h, { miniaturized: true });
  native.emit({
    type: 'window-miniaturize',
    windowNumber: wnd.windowNumber,
    miniaturized: true,
  });
  await tick();
  assert.deepEqual(heard, [
    ['maximized_vert', 'maximized_horz'],
    ['maximized_vert', 'maximized_horz', 'focused'],
    ['maximized_vert', 'maximized_horz', 'hidden', 'focused'],
  ]);
  // and a resize that moves no state says nothing
  native.emit({
    type: 'window-resize',
    windowNumber: wnd.windowNumber,
    width: 1400,
    height: 875,
    x: 0,
    y: 0,
  });
  await tick();
  assert.equal(heard.length, 3);
});

test('a window nobody asks about reads no state on a resize', async () => {
  const { native, wnd } = await mount(h('box', { style: { flexGrow: 1 } }));
  const before = native.frameReads;
  native.emit({
    type: 'window-fullscreen',
    windowNumber: wnd.windowNumber,
    fullscreen: true,
    phase: 'begin',
  });
  native.emit({ type: 'window-focus', windowNumber: wnd.windowNumber });
  // a resize reads the origin, so count the reads it made beyond that
  const geometry = native.frameReads;
  native.emit({
    type: 'window-resize',
    windowNumber: wnd.windowNumber,
    width: 120,
    height: 90,
    x: 0,
    y: 0,
  });
  const perResize = native.frameReads - geometry;
  assert.equal(geometry, before, 'the state events read nothing');
  assert.ok(
    perResize <= 1,
    `a resize reads the frame for its origin only (${perResize})`,
  );
});

test('<window fullscreen> and states reach the verbs, added and removed', async () => {
  const { native, wnd, render } = await mount(
    h('box', { style: { flexGrow: 1 } }),
  );
  render({ fullscreen: true });
  await tick();
  render({ fullscreen: false, states: ['maximized'] });
  await tick();
  render({ states: ['hidden'] });
  await tick();
  const id = wnd._h.id;
  assert.deepEqual(
    native.calls.filter((c) => c[0].startsWith('setWindow')),
    [
      ['setWindowFullScreen', id, true],
      // each render adds what it asks for before removing what it stopped
      ['setWindowZoomed', id, true],
      ['setWindowFullScreen', id, false],
      ['setWindowMiniaturized', id, true],
      ['setWindowZoomed', id, false],
    ],
  );
});

test('setWmState: a toggle reads the published state, and a name with no verb resolves false', async () => {
  const { native, wnd } = await mount(h('box', { style: { flexGrow: 1 } }));
  native.publish(wnd._h, { fullscreen: true, zoomed: false });
  assert.equal(await wnd.setWmState('fullscreen', 'toggle'), true);
  assert.equal(await wnd.setWmState('maximized_horz', 'toggle'), true);
  assert.equal(await wnd.setWmState('sticky'), false);
  const id = wnd._h.id;
  assert.deepEqual(native.calls, [
    ['setWindowFullScreen', id, false],
    ['setWindowZoomed', id, true],
  ]);
});

test('a bridge older than 0.30.0: the requests resolve false and the states are only the key window', async () => {
  const probe = stateProbe();
  const { native, wnd } = await mount(probe.element, {
    bridge: { verbs: false },
  });
  assert.equal(await wnd.setWmState('fullscreen'), false);
  assert.deepEqual(await wnd.getWmStates(), []);
  native.publish(wnd._h, { key: true });
  native.emit({ type: 'window-focus', windowNumber: wnd.windowNumber });
  await tick();
  assert.deepEqual(probe.last().states, ['focused']);
  assert.equal(probe.last().fullscreen, false);
});
