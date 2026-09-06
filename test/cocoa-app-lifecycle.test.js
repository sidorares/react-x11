// The application as a whole on the cocoa backend (@windowkit/appkit >= 0.5,
// docs/uri-schemes.md "On macOS"): what the OS asks the app rather than a
// window, arriving as backend events from the NSApplicationDelegate the
// bridge installs, and what the renderer decides for each.
//
//   app-open-urls     → `useAppOpen` / `onAppOpen`, the same filter, buffer
//                       and replay a D-Bus `Open` takes
//   app-reopen        → `useAppActivate` / `onAppActivate`
//   app-quit-request  → the primary window's close request, and the process
//                       ending once the app has closed
//
// Headless: a recording fake bridge delivers the events the way the real one
// does, so this runs everywhere and says nothing about Launch Services — only
// that what the bridge reports reaches the hooks, and that a quit is the
// close request it is documented to be.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { CocoaApp } from '../src/cocoa/app.js';
import {
  _resetApplicationState,
  onAppActivate,
  onAppOpen,
  registerApplication,
} from '../src/application.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';
import { setCompositingForTests } from '../src/compositing.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A bridge shaped like @windowkit/appkit's: answers what a window's
 *  construction asks, and delivers app-level events through the callback
 *  the app installs, the way `initApp()`'s delegate does. */
function fakeNative() {
  let cb = null;
  let seq = 0;
  const base = {
    /** Deliver an event as the delegate would. */
    emit(ev) {
      cb?.(ev);
    },
    setBackendEventCallback(fn) {
      cb = fn;
    },
    initApp() {},
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

/** Run `fn` as if on a machine with no session bus, so `registerApplication`
 *  takes its no-bus path — the one the cocoa backend takes on a Mac. */
async function withoutBus(fn) {
  const saved = {
    addr: process.env.DBUS_SESSION_BUS_ADDRESS,
    runtime: process.env.XDG_RUNTIME_DIR,
    platform: process.platform,
  };
  delete process.env.DBUS_SESSION_BUS_ADDRESS;
  delete process.env.XDG_RUNTIME_DIR;
  // darwin has launchd to fall back to, so there is always an address there
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: saved.platform });
    if (saved.addr !== undefined)
      process.env.DBUS_SESSION_BUS_ADDRESS = saved.addr;
    if (saved.runtime !== undefined)
      process.env.XDG_RUNTIME_DIR = saved.runtime;
  }
}

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
  _resetApplicationState();
});

test('app-open-urls reaches onAppOpen, and a URL that arrives first is replayed', async () => {
  const native = fakeNative();
  appOver(native);

  // the launching Apple Event lands before anything subscribes
  native.emit({ type: 'app-open-urls', urls: ['myapp://auth?code=1'] });

  const got = [];
  onAppOpen((uris, ctx) => got.push([uris, ctx]));
  await tick();
  assert.equal(got.length, 1, 'replayed to the first handler');
  assert.deepEqual(got[0][0], ['myapp://auth?code=1']);
  // Apple Events carry no startup id and no timestamp: nulls, not inventions
  assert.equal(got[0][1].timestamp, null);
  assert.equal(got[0][1].startupId, null);

  native.emit({ type: 'app-open-urls', urls: ['myapp://two', 42, 'nonsense'] });
  await tick();
  assert.equal(got.length, 2);
  assert.deepEqual(got[1][0], ['myapp://two'], 'only strings that are URIs');
});

test('a registration filters what the platform delivers, file: always allowed', async () => {
  const native = fakeNative();
  appOver(native);
  await withoutBus(async () => {
    const reg = await registerApplication({
      appId: 'com.example.myapp',
      schemes: ['com.example.myapp'],
    });
    assert.equal(reg, null, 'no bus: the app is the only copy there is');
  });

  const got = [];
  onAppOpen((uris) => got.push(uris));
  native.emit({
    type: 'app-open-urls',
    urls: ['com.example.myapp://x', 'other://y', 'file:///tmp/doc.txt'],
  });
  await tick();
  assert.deepEqual(got, [['com.example.myapp://x', 'file:///tmp/doc.txt']]);

  // nothing of ours in it: nothing delivered, nothing buffered
  native.emit({ type: 'app-open-urls', urls: ['other://z'] });
  await tick();
  assert.equal(got.length, 1);
});

test('app-reopen is an Activate, with the one fact the OS adds', async () => {
  const native = fakeNative();
  appOver(native);
  const got = [];
  onAppActivate((ctx) => got.push(ctx));
  native.emit({ type: 'app-reopen', hasVisibleWindows: false });
  await tick();
  assert.equal(got.length, 1);
  assert.equal(got[0].platformData['has-visible-windows'], false);
  assert.equal(got[0].timestamp, null);
});

test('a quit request is the primary window’s close request: onCloseRequest sees it', async () => {
  const native = fakeNative();
  const app = appOver(native, { cocoa: { exitOnQuit: false } });
  const root = await createRoot({ app });
  roots.push(root);
  const asked = [];
  root.render(
    h(
      'window',
      { width: 200, height: 100, onCloseRequest: (ev) => asked.push(ev) },
      h('box', null),
    ),
  );
  await tick();

  native.emit({ type: 'app-quit-request' });
  await tick();
  assert.equal(asked.length, 1, 'the app was asked, and decides');
  const wnd = [...app._windows.values()][0];
  assert.equal(wnd.destroyed, false, 'a handler that does nothing is a veto');
});

test('a quit request with no handler closes the app, the way the red light does', async () => {
  const native = fakeNative();
  const app = appOver(native, { cocoa: { exitOnQuit: false } });
  const root = await createRoot({ app });
  roots.push(root);
  root.render(h('window', { width: 200, height: 100 }, h('box', null)));
  await tick();
  const wnd = [...app._windows.values()][0];

  native.emit({ type: 'app-quit-request' });
  await tick();
  await tick();
  assert.equal(wnd.destroyed, true, 'the tree unmounted');
  assert.equal(app._quitting, true);
});

test('with several windows the primary one is asked, not the first one opened', async () => {
  const native = fakeNative();
  const app = appOver(native, { cocoa: { exitOnQuit: false } });
  const root = await createRoot({ app });
  roots.push(root);
  const asked = [];
  root.render(
    h(
      React.Fragment,
      null,
      h('window', {
        width: 200,
        height: 100,
        windowType: 'utility',
        onCloseRequest: () => asked.push('palette'),
      }),
      h('window', {
        width: 300,
        height: 200,
        onCloseRequest: () => asked.push('main'),
      }),
    ),
  );
  await tick();
  native.emit({ type: 'app-quit-request' });
  await tick();
  assert.deepEqual(asked, ['main']);
});

test('⌘Q on the synthesized app menu takes the same route', async () => {
  const native = fakeNative();
  const app = appOver(native, { cocoa: { exitOnQuit: false } });
  let quits = 0;
  app.requestQuit = () => quits++;
  const { CocoaGlobalMenuExport } = await import('../src/cocoa/globalmenu.js');
  const menu = new CocoaGlobalMenuExport(app, {
    getMenus: () => [],
    onSelect: () => {},
  });
  await menu.start();
  menu.activate(-2); // QUIT_ID
  assert.equal(quits, 1);
});
