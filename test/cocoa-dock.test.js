// The Dock tile on the cocoa backend (@windowkit/appkit >= 0.5,
// docs/desktop.md "The launcher"): the badge, the attention bounce a
// window's `demands_attention` state asks for, the Dock menu, and the two
// launch-time facts — activation policy and the app's name.
//
// Headless over a recording fake bridge. What is pinned is what reaches the
// bridge and when — the policy before the app launches, the bounce cancelled
// when the state goes or the window does, a Dock-menu pick running the
// item's own handler — not what the Dock draws.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { CocoaApp } from '../src/cocoa/app.js';
import { setBadge } from '../src/launcher.js';
import { useBadge, useDockMenu } from '../src/launcherhooks.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';
import { setCompositingForTests } from '../src/compositing.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeNative() {
  let cb = null;
  let seq = 0;
  let attention = 0;
  const base = {
    calls: [],
    of: (name) =>
      base.calls.filter((c) => c[0] === name).map((c) => c.slice(1)),
    emit(ev) {
      cb?.(ev);
    },
    setBackendEventCallback(fn) {
      cb = fn;
    },
    initApp(opts) {
      base.calls.push(['initApp', opts]);
    },
    setAppName(name) {
      base.calls.push(['setAppName', name]);
      return true;
    },
    setDockBadge(label) {
      base.calls.push(['setDockBadge', label]);
    },
    setDockMenu(spec) {
      base.calls.push(['setDockMenu', spec]);
    },
    requestUserAttention(kind) {
      base.calls.push(['requestUserAttention', kind]);
      return ++attention;
    },
    cancelUserAttention(id) {
      base.calls.push(['cancelUserAttention', id]);
    },
    listScreens: () => {
      base.calls.push(['listScreens']);
      return [
        {
          x: 0,
          y: 0,
          width: 1440,
          height: 900,
          scale: 2,
          fps: 60,
          visible: { x: 0, y: 0, width: 1440, height: 875 },
          primary: true,
        },
      ];
    },
    createWindow2: (o) => ({ id: ++seq, options: { ...o } }),
    windowNumber: (handle) => handle.id,
    windowRootLayer: (handle) => ({ root: handle.id }),
    getWindowFrame: (handle) => ({
      x: 0,
      y: 0,
      width: handle.options.width,
      height: handle.options.height,
    }),
    windowIsVisible: () => true,
    createSurfaceIOSurface: (width, height, scale) => ({
      handle: { id: ++seq, width, height, scale },
      iosurfaceId: seq,
    }),
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
  };
  return new Proxy(base, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

function appOver(native, options = {}) {
  const app = new CocoaApp(native, options);
  setScaleForTests(app, 2, 'cocoa');
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 2880, height: 1800 }],
    workArea: { x: 0, y: 0, width: 2880, height: 1750 },
  });
  setCompositingForTests(app, true);
  native.setBackendEventCallback((ev) => app._route(ev));
  return app;
}

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

test('the activation policy is fixed before the first launching call; the name after', () => {
  const native = fakeNative();
  appOver(native, {
    cocoa: { activationPolicy: 'accessory', appName: 'Notes' },
  });
  const order = native.calls.map((c) => c[0]);
  assert.ok(
    order.indexOf('initApp') < order.indexOf('listScreens'),
    `initApp before listScreens, got ${order.join(', ')}`,
  );
  assert.deepEqual(native.of('initApp')[0], [
    { activationPolicy: 'accessory' },
  ]);
  assert.deepEqual(native.of('setAppName'), [['Notes']]);
});

test('with neither option the launch is left alone', () => {
  const native = fakeNative();
  appOver(native);
  assert.equal(native.of('initApp').length, 0);
  assert.equal(native.of('setAppName').length, 0);
});

test('setBadge reaches the Dock tile through the app: digits, any string, and clear', async () => {
  const native = fakeNative();
  const app = appOver(native);
  assert.equal(await setBadge(3, { app }), true);
  assert.equal(await setBadge('•', { app }), true);
  assert.equal(await setBadge(0, { app }), true);
  assert.equal(await setBadge(null, { app }), true);
  assert.deepEqual(native.of('setDockBadge'), [['3'], ['•'], [null], [null]]);
});

test('useBadge shows while mounted, follows the value, clears on unmount', async () => {
  const native = fakeNative();
  const app = appOver(native);
  const root = await createRoot({ app });
  roots.push(root);
  function Unread({ n }) {
    useBadge(n);
    return h('box');
  }
  root.render(h('window', { width: 200, height: 100 }, h(Unread, { n: 5 })));
  await tick();
  await tick();
  assert.deepEqual(native.of('setDockBadge'), [['5']]);
  root.render(h('window', { width: 200, height: 100 }, h(Unread, { n: 12 })));
  await tick();
  await tick();
  assert.deepEqual(native.of('setDockBadge').at(-1), ['12']);
  await root.unmount();
  roots.length = 0;
  await tick();
  assert.deepEqual(native.of('setDockBadge').at(-1), [null], 'cleared');
});

test('demands_attention bounces the Dock icon, and dropping the state cancels it', async () => {
  const native = fakeNative();
  const app = appOver(native);
  const root = await createRoot({ app });
  roots.push(root);
  root.render(
    h('window', { width: 200, height: 100, states: ['demands_attention'] }),
  );
  await tick();
  assert.deepEqual(native.of('requestUserAttention'), [['critical']]);

  // asked again: still one request outstanding
  const wnd = [...app._windows.values()][0];
  assert.equal(await wnd.setWmState('demands_attention', 'add'), true);
  assert.equal(native.of('requestUserAttention').length, 1);

  root.render(h('window', { width: 200, height: 100, states: [] }));
  await tick();
  assert.deepEqual(native.of('cancelUserAttention'), [[1]]);

  // a state the bridge has no verb for is an honest false, not a throw
  assert.equal(await wnd.setWmState('fullscreen', 'add'), false);
});

test('a window destroyed mid-bounce takes its request with it', async () => {
  const native = fakeNative();
  const app = appOver(native);
  const wnd = app.createWindow({ width: 100, height: 100 });
  await wnd.setWmState('demands_attention');
  wnd.destroy();
  assert.deepEqual(native.of('cancelUserAttention'), [[1]]);
});

test('useDockMenu installs the items and a pick runs the item’s own onSelect', async () => {
  const native = fakeNative();
  const app = appOver(native);
  const root = await createRoot({ app });
  roots.push(root);
  const picked = [];
  const items = [
    { label: 'New Window', onSelect: () => picked.push('new') },
    { type: 'separator' },
    {
      label: 'Recent',
      items: [{ label: 'a.txt', onSelect: (item) => picked.push(item.label) }],
    },
  ];
  function Menu() {
    useDockMenu(items);
    return h('box');
  }
  root.render(h('window', { width: 200, height: 100 }, h(Menu)));
  await tick();
  await tick();
  const [spec] = native.of('setDockMenu').at(-1);
  assert.equal(spec.length, 3);
  assert.equal(spec[0].title, 'New Window');
  assert.equal(spec[1].separator, true);
  assert.equal(spec[2].items[0].title, 'a.txt');

  native.emit({ type: 'menu-activate', menu: 'dock', id: spec[0].id });
  native.emit({ type: 'menu-activate', menu: 'dock', id: spec[2].items[0].id });
  assert.deepEqual(picked, ['new', 'a.txt']);

  // an id from the *bar* does not fire a Dock item, whatever the number
  native.emit({ type: 'menu-activate', menu: 'main', id: spec[0].id });
  assert.deepEqual(picked, ['new', 'a.txt']);

  await root.unmount();
  roots.length = 0;
  assert.deepEqual(native.of('setDockMenu').at(-1), [null], 'taken down');
});
