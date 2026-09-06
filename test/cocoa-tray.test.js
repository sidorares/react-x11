// The tray on the cocoa backend (src/cocoa/statusitem.js + src/trayhooks.js,
// @windowkit/appkit >= 0.5; docs/desktop.md "The tray"). Headless over a
// recording fake bridge: what reaches the bridge, how a click and a menu
// pick find their way back to the item that owns them — two items with
// menus of their own included, since the bridge tags an activation
// `status` and nothing else — and the hook's lifecycle.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { CocoaApp } from '../src/cocoa/app.js';
import { statusItemSpec } from '../src/cocoa/statusitem.js';
import { useTray } from '../src/trayhooks.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';
import { setCompositingForTests } from '../src/compositing.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeNative() {
  let cb = null;
  let seq = 0;
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
    initApp() {},
    createStatusItem(spec) {
      const handle = { item: ++seq };
      base.calls.push(['createStatusItem', spec, handle]);
      return handle;
    },
    setStatusItem(handle, spec) {
      base.calls.push(['setStatusItem', handle, spec]);
    },
    setStatusItemMenu(handle, spec) {
      base.calls.push(['setStatusItemMenu', handle, spec]);
    },
    removeStatusItem(handle) {
      base.calls.push(['removeStatusItem', handle]);
    },
    listScreens: () => [
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
    ],
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

function appOver(native) {
  const app = new CocoaApp(native);
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

test('statusItemSpec: the bridge’s keys, and only for the fields given', () => {
  assert.deepEqual(
    statusItemSpec({
      icon: 'bell.badge',
      title: '3',
      tooltip: 'Notifications',
      template: false,
      length: 'square',
      iconSize: [18, 18],
      onClick: () => {},
      menu: [],
    }),
    {
      image: 'bell.badge',
      title: '3',
      tooltip: 'Notifications',
      imageTemplate: false,
      length: 'square',
      imageSize: [18, 18],
    },
  );
  assert.deepEqual(statusItemSpec({ visible: false }), { visible: false });
  assert.deepEqual(statusItemSpec({ icon: null, title: null }), {
    image: null,
    title: '',
  });
  assert.deepEqual(statusItemSpec({}), {});
});

test('an item with a menu: created, menu installed, a pick runs the item’s onSelect', () => {
  const native = fakeNative();
  const app = appOver(native);
  const picked = [];
  const item = app.createStatusItem({
    icon: 'star',
    menu: [
      { label: 'Open', onSelect: () => picked.push('open') },
      { label: 'Quit', onSelect: (it) => picked.push(it.label) },
    ],
  });
  const [spec, handle] = native.of('createStatusItem')[0];
  assert.deepEqual(spec, { image: 'star' });
  assert.equal(item.handle, handle);
  const [, menu] = native.of('setStatusItemMenu')[0];
  assert.equal(menu.length, 2);
  assert.equal(menu[0].title, 'Open');

  native.emit({ type: 'menu-activate', menu: 'status', id: menu[1].id });
  native.emit({ type: 'menu-activate', menu: 'status', id: menu[0].id });
  assert.deepEqual(picked, ['Quit', 'open']);

  item.remove();
  assert.deepEqual(native.of('removeStatusItem'), [[handle]]);
  item.remove(); // idempotent
  assert.equal(native.of('removeStatusItem').length, 1);
});

test('two items with menus: an activation reaches the item whose menu it is', () => {
  const native = fakeNative();
  const app = appOver(native);
  const picked = [];
  app.createStatusItem({
    title: 'A',
    menu: [{ label: 'Same', onSelect: () => picked.push('A') }],
  });
  app.createStatusItem({
    title: 'B',
    menu: [{ label: 'Same', onSelect: () => picked.push('B') }],
  });
  const [[, menuA], [, menuB]] = native.of('setStatusItemMenu');
  assert.notEqual(menuA[0].id, menuB[0].id, 'disjoint ids by construction');
  native.emit({ type: 'menu-activate', menu: 'status', id: menuB[0].id });
  native.emit({ type: 'menu-activate', menu: 'status', id: menuA[0].id });
  assert.deepEqual(picked, ['B', 'A']);
});

test('an item without a menu reports clicks, with the rect to anchor a popup on', () => {
  const native = fakeNative();
  const app = appOver(native);
  const clicks = [];
  const item = app.createStatusItem({
    title: '•',
    onClick: (ev) => clicks.push(ev),
  });
  assert.deepEqual(native.of('setStatusItemMenu')[0][1], null);
  native.emit({
    type: 'status-item-click',
    statusItem: item.handle,
    kind: 'left',
    x: 1200,
    y: 0,
    width: 28,
    height: 22,
    command: true,
    clickCount: 1,
  });
  // a click on some other item is not this one's
  native.emit({ type: 'status-item-click', statusItem: {}, kind: 'right' });
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].button, 'left');
  assert.deepEqual(
    [clicks[0].x, clicks[0].y, clicks[0].width, clicks[0].height],
    [1200, 0, 28, 22],
  );
  assert.equal(clicks[0].command, true);
  assert.equal(clicks[0].shift, false);
});

test('useTray: created on mount, patched in place, removed on unmount', async () => {
  const native = fakeNative();
  const app = appOver(native);
  const root = await createRoot({ app });
  roots.push(root);
  let seen;
  function Tray({ title }) {
    seen = useTray({ icon: 'bell', title, tooltip: 'Hi' });
    return h('box');
  }
  root.render(
    h('window', { width: 200, height: 100 }, h(Tray, { title: '1' })),
  );
  await tick();
  await tick();
  assert.equal(seen.available, true);
  assert.equal(native.of('createStatusItem').length, 1);
  assert.deepEqual(native.of('createStatusItem')[0][0], {
    image: 'bell',
    title: '1',
    tooltip: 'Hi',
  });

  root.render(
    h('window', { width: 200, height: 100 }, h(Tray, { title: '2' })),
  );
  await tick();
  await tick();
  assert.equal(native.of('createStatusItem').length, 1, 'patched, not rebuilt');
  assert.equal(native.of('setStatusItem').at(-1)[1].title, '2');

  await root.unmount();
  roots.length = 0;
  assert.equal(native.of('removeStatusItem').length, 1);
});

test('useTray on a backend with no tray is inert and says so', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  roots.push(root);
  let seen;
  function Tray() {
    seen = useTray({ icon: 'bell' });
    return h('box');
  }
  root.render(h('window', { width: 200, height: 100 }, h(Tray)));
  await tick();
  assert.equal(seen.available, false);
});
