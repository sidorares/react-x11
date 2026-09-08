// Permissions (src/permissions.js, docs/permissions.md): the ladder's
// vocabulary, the cocoa rung over a recording fake bridge, the
// Settings-pane rung over a faked `open`, and what a backend with no
// authorization API answers — `'unknown'` for a query, a typed rejection
// for a request. The system prompt itself is the one thing this cannot
// show; the bridge's own tests own that path.
import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { CocoaApp } from '../src/cocoa/app.js';
import { statusFromBridge } from '../src/cocoa/permissions.js';
import {
  NoPermissionServiceError,
  PERMISSION_KINDS,
  openPrivacySettings,
  permissionBackend,
  permissionStatus,
  privacySettingsUrl,
  requestPermission,
} from '../src/permissions.js';
import { usePermission } from '../src/permissionhooks.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';
import { setCompositingForTests } from '../src/compositing.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeNative({ statuses = {}, answer = 'authorized' } = {}) {
  let seq = 0;
  const base = {
    calls: [],
    of: (name) =>
      base.calls.filter((c) => c[0] === name).map((c) => c.slice(1)),
    authorizationStatus(kind, opts) {
      base.calls.push(['authorizationStatus', kind, opts]);
      return statuses[kind] ?? 'notDetermined';
    },
    requestAuthorization(kind, ...rest) {
      const cb = rest.pop();
      base.calls.push(['requestAuthorization', kind, rest[0]]);
      // once, asynchronously — never inside the call
      setImmediate(() => cb(answer === 'authorized', answer));
    },
    openPrivacySettings(kind) {
      base.calls.push(['openPrivacySettings', kind]);
    },
    setBackendEventCallback() {},
    initApp() {},
    listScreens: () => [
      { x: 0, y: 0, width: 1440, height: 900, scale: 2, fps: 60 },
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
  return app;
}

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

describe('the vocabulary', () => {
  test('Apple’s words become the ladder’s, and anything else is unknown', () => {
    assert.equal(statusFromBridge('authorized'), 'granted');
    assert.equal(statusFromBridge('denied'), 'denied');
    assert.equal(statusFromBridge('restricted'), 'restricted');
    assert.equal(statusFromBridge('notDetermined'), 'prompt');
    // macOS 14's partial EventKit grant, kept as its own word: a grant to a
    // writer and a refusal to a reader (docs/desktop-calendar.md)
    assert.equal(statusFromBridge('writeOnly'), 'write-only');
    assert.equal(statusFromBridge('surprise'), 'unknown');
  });

  test('a kind that is not one is a TypeError, not a machine answer', async () => {
    await assert.rejects(() => permissionStatus('bluetooth'), TypeError);
    await assert.rejects(() => requestPermission('bluetooth'), TypeError);
    assert.equal(PERMISSION_KINDS.length, 9);
  });

  test('the Settings deep link, per pane and for the Privacy pane itself', () => {
    assert.equal(
      privacySettingsUrl('camera'),
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
    );
    assert.match(privacySettingsUrl('full-disk-access'), /Privacy_AllFiles$/);
    assert.match(privacySettingsUrl(), /\?Privacy$/);
    assert.throws(() => privacySettingsUrl('bluetooth'), TypeError);
  });
});

describe('the cocoa rung', () => {
  test('status: read without prompting; automation carries its target', async () => {
    const native = fakeNative({
      statuses: { camera: 'authorized', microphone: 'denied' },
    });
    const app = appOver(native);
    assert.equal(permissionBackend({ app }), 'cocoa');
    assert.equal(await permissionStatus('camera', { app }), 'granted');
    assert.equal(await permissionStatus('microphone', { app }), 'denied');
    assert.equal(await permissionStatus('location', { app }), 'prompt');
    await permissionStatus('automation', { app, target: 'com.apple.finder' });
    assert.deepEqual(native.of('authorizationStatus').at(-1), [
      'automation',
      { target: 'com.apple.finder' },
    ]);
    assert.equal(native.of('requestAuthorization').length, 0, 'no prompt');
  });

  test('request: the system prompt, answered once and asynchronously', async () => {
    const native = fakeNative({ answer: 'denied' });
    const app = appOver(native);
    let settled = false;
    const pending = requestPermission('microphone', { app }).then((s) => {
      settled = true;
      return s;
    });
    assert.equal(settled, false, 'never inside the call');
    assert.equal(await pending, 'denied');
    assert.deepEqual(native.of('requestAuthorization'), [
      ['microphone', undefined],
    ]);
  });

  test('openPrivacySettings goes through the bridge', async () => {
    const native = fakeNative();
    const app = appOver(native);
    assert.equal(await openPrivacySettings('accessibility', { app }), true);
    assert.equal(await openPrivacySettings(null, { app }), true);
    assert.deepEqual(native.of('openPrivacySettings'), [
      ['accessibility'],
      [undefined],
    ]);
  });

  test('the tree’s own connection is found without naming it', async () => {
    const native = fakeNative({ statuses: { camera: 'restricted' } });
    const app = appOver(native);
    const root = await createRoot({ app });
    roots.push(root);
    root.render(h('window', { width: 100, height: 100 }, h('box')));
    await tick();
    assert.equal(await permissionStatus('camera'), 'restricted');
  });
});

describe('a backend with no authorization API', () => {
  test('a query is unknown, a request is a typed rejection', async () => {
    const app = createMockApp();
    assert.equal(permissionBackend({ app }), null);
    assert.equal(await permissionStatus('camera', { app }), 'unknown');
    await assert.rejects(
      () => requestPermission('camera', { app }),
      (err) => {
        assert.ok(err instanceof NoPermissionServiceError);
        assert.match(err.message, /permissionStatus/);
        return true;
      },
    );
  });

  test('the Settings pane still opens on a Mac, by `open`; nowhere else', async () => {
    const app = createMockApp();
    const nodeModule = await import('node:module');
    const cp = nodeModule.createRequire(import.meta.url)('node:child_process');
    const real = cp.execFile;
    const opened = [];
    cp.execFile = (file, args, cb) => {
      opened.push([file, ...args]);
      setImmediate(() => cb(null));
      return {};
    };
    nodeModule.syncBuiltinESMExports();
    const saved = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      assert.equal(await openPrivacySettings('camera', { app }), true);
      assert.deepEqual(opened, [
        [
          'open',
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
        ],
      ]);
      Object.defineProperty(process, 'platform', { value: 'linux' });
      assert.equal(await openPrivacySettings('camera', { app }), false);
      assert.equal(opened.length, 1);
    } finally {
      Object.defineProperty(process, 'platform', { value: saved });
      cp.execFile = real;
      nodeModule.syncBuiltinESMExports();
    }
  });
});

describe('usePermission', () => {
  test('the status settles, a request updates it, and a second request shares the first', async () => {
    const native = fakeNative({
      statuses: { camera: 'notDetermined' },
      answer: 'authorized',
    });
    const app = appOver(native);
    const root = await createRoot({ app });
    roots.push(root);
    let seen;
    function Probe() {
      seen = usePermission('camera');
      return h('box');
    }
    root.render(h('window', { width: 100, height: 100 }, h(Probe)));
    await tick();
    await tick();
    assert.equal(seen.available, true);
    assert.equal(seen.status, 'prompt');

    const first = seen.request();
    assert.equal(seen.request(), first, 'one prompt for a double click');
    assert.equal(await first, 'granted');
    await tick();
    assert.equal(seen.status, 'granted');
    assert.equal(native.of('requestAuthorization').length, 1);
  });

  test('on a backend with no API it is unavailable and unknown', async () => {
    const app = createMockApp();
    const root = await createRoot({ app });
    roots.push(root);
    let seen;
    function Probe() {
      seen = usePermission('camera');
      return h('box');
    }
    root.render(h('window', { width: 100, height: 100 }, h(Probe)));
    await tick();
    await tick();
    assert.equal(seen.available, false);
    assert.equal(seen.status, 'unknown');
  });
});
