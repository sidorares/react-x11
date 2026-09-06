// Desktop notifications (src/notifications.js, docs/notifications.md): the
// four rungs, each pinned where it can be — the freedesktop daemon against a
// fake one on a real broker (the wire: hints, replaces_id, the two signals),
// the cocoa centre over a recording fake bridge (the bundle gate, the one
// authorization, categories, the events back), the two shell-outs over a
// faked child (what they are handed), and the ladder's choices.
import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { CocoaApp } from '../src/cocoa/app.js';
import {
  NoNotificationServiceError,
  _resetNotifications,
  notificationBackend,
  notify,
  notifySendArgs,
  osascriptNotificationLines,
} from '../src/notifications.js';
import { useNotifier } from '../src/notificationhooks.js';
import {
  _resetApplicationState,
  registerApplication,
} from '../src/application.js';
import { _resetServiceCache } from '../src/portal.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';
import { setCompositingForTests } from '../src/compositing.js';
import { createMockApp } from './helpers/mock-app.js';
import { fakeNotifications } from './helpers/fake-notifications.js';
import {
  transportAvailable,
  until,
  withBus,
  withNoBus,
} from './helpers/with-bus.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const haveTransport = await transportAvailable();
const needsBroker = haveTransport
  ? {}
  : { skip: 'dbus-native is not installed (expected on Node < 22.12)' };

afterEach(async () => {
  await _resetNotifications();
  _resetApplicationState();
  _resetServiceCache();
});

// --- the pure parts -----------------------------------------------------------

describe('the arguments the shell-outs are handed', () => {
  test('osascript: title, body, subtitle, and quotes that cannot break out', () => {
    const [flag, line] = osascriptNotificationLines({
      summary: 'Done "now"',
      body: 'report.pdf',
      subtitle: 'Exports',
    });
    assert.equal(flag, '-e');
    assert.equal(
      line,
      'display notification "report.pdf" with title "Done \\"now\\"" subtitle "Exports"',
    );
  });

  test('notify-send: urgency, timeout, icon, the id back, and replace', () => {
    assert.deepEqual(
      notifySendArgs({
        summary: 'Hi',
        body: 'there',
        urgency: 'critical',
        timeout: 4000,
        icon: 'dialog-information',
        appName: 'App',
      }),
      [
        '-p',
        '-u',
        'critical',
        '-t',
        '4000',
        '-i',
        'dialog-information',
        '-a',
        'App',
        '--',
        'Hi',
        'there',
      ],
    );
    assert.deepEqual(notifySendArgs({ summary: 'x' }, 7), [
      '-p',
      '-u',
      'normal',
      '-r',
      '7',
      '--',
      'x',
      '',
    ]);
  });

  test('a notification needs a summary, a known urgency, and keyed actions', async () => {
    await assert.rejects(() => notify({}), TypeError);
    await assert.rejects(
      () => notify({ summary: 'x', urgency: 'loud' }),
      TypeError,
    );
    await assert.rejects(
      () => notify({ summary: 'x', actions: [{ label: 'no key' }] }),
      TypeError,
    );
  });
});

// --- rung 2: the freedesktop daemon --------------------------------------------

/** `a{sv}` as dbus-native delivers it, a plain map with variants unwrapped. */
function plain(dict) {
  const entries = Array.isArray(dict) ? dict : Object.entries(dict ?? {});
  return Object.fromEntries(
    entries.map(([k, v]) => [
      k,
      Array.isArray(v) ? v[1]?.[0] : (v?.value ?? v),
    ]),
  );
}

describe('the freedesktop daemon', { ...needsBroker }, () => {
  test('Notify carries the hints, an update is replaces_id, close is CloseNotification', async () => {
    await withBus(async (address) => {
      const daemon = await fakeNotifications(address);
      try {
        const reg = await registerApplication({
          appId: 'com.example.notifier',
        });
        const closes = [];
        const banner = await notify({
          summary: 'Export finished',
          body: 'report.pdf',
          urgency: 'critical',
          icon: 'document-save',
          timeout: 5000,
          onClose: (reason) => closes.push(reason),
        });
        assert.equal(banner.backend, 'dbus');
        assert.equal(banner.id, 1);
        const [call] = daemon.calls;
        assert.equal(call.summary, 'Export finished');
        assert.equal(call.body, 'report.pdf');
        assert.equal(call.app_icon, 'document-save');
        assert.equal(call.expire_timeout, 5000);
        assert.equal(call.replaces_id, 0);
        const hints = plain(call.hints);
        assert.equal(Number(hints.urgency), 2);
        assert.equal(hints['desktop-entry'], 'com.example.notifier');

        await banner.update({ body: 'opened' });
        assert.equal(daemon.calls.length, 2);
        assert.equal(daemon.calls[1].replaces_id, 1, 'in place');
        assert.equal(daemon.calls[1].body, 'opened');
        assert.equal(banner.id, 1);

        await banner.close();
        assert.deepEqual(daemon.closed, [1]);
        await until(() => closes.length === 1, 'the NotificationClosed');
        assert.deepEqual(closes, ['closed']);
        // the last banner gone, the session went with it: the next banner
        // starts one afresh, which the daemon sees as a second capability read
        assert.equal(daemon.capabilityReads, 1);
        await notify({ summary: 'again' });
        assert.equal(daemon.capabilityReads, 2, 'a fresh session');
        await reg.release();
      } finally {
        await daemon.stop();
      }
    });
  });

  test('what the user did comes back: an action, then a dismissal with its reason', async () => {
    await withBus(async (address) => {
      const daemon = await fakeNotifications(address, {
        capabilities: ['actions'],
      });
      try {
        const seen = [];
        const banner = await notify({
          summary: 'Update ready',
          actions: [{ key: 'install', label: 'Install' }],
          onAction: (key) => seen.push(['action', key]),
          onClose: (reason) => seen.push(['close', reason]),
        });
        assert.deepEqual(daemon.calls[0].actions, ['install', 'Install']);
        daemon.invoke(banner.id, 'install');
        await until(() => seen.length === 1, 'the action');
        daemon.close(banner.id, 2);
        await until(() => seen.length === 2, 'the close');
        assert.deepEqual(seen, [
          ['action', 'install'],
          ['close', 'dismissed'],
        ]);
        // a second close for a banner already gone is nobody's
        daemon.close(banner.id, 1);
        await tick();
        assert.equal(seen.length, 2);
      } finally {
        await daemon.stop();
      }
    });
  });

  test('a daemon without the actions capability gets none, rather than blind ones', async () => {
    await withBus(async (address) => {
      const daemon = await fakeNotifications(address, {
        capabilities: ['body'],
      });
      const warn = console.warn;
      const warned = [];
      console.warn = (...a) => warned.push(a.join(' '));
      try {
        await notify({
          summary: 'x',
          actions: [{ key: 'open', label: 'Open' }],
        });
        assert.deepEqual(daemon.calls[0].actions, []);
        assert.match(warned.join('\n'), /actions/);
      } finally {
        console.warn = warn;
        await daemon.stop();
      }
    });
  });

  test('notificationBackend says dbus while a daemon is on the bus', async () => {
    await withBus(async (address) => {
      const daemon = await fakeNotifications(address);
      try {
        assert.equal(await notificationBackend(), 'dbus');
      } finally {
        await daemon.stop();
      }
    });
  });
});

// --- rung 1: the cocoa centre ----------------------------------------------------

function fakeNative({
  available = true,
  authorization = 'notDetermined',
  grant = true,
} = {}) {
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
    notificationSettings(done) {
      base.calls.push(['notificationSettings']);
      setImmediate(() =>
        done(
          available
            ? { available: true, authorizationStatus: authorization }
            : { available: false, bundleIdentifier: null, reason: 'bare' },
        ),
      );
    },
    requestNotificationAuthorization(options, done) {
      base.calls.push(['requestNotificationAuthorization', options]);
      setImmediate(() => done(grant, null));
    },
    setNotificationCategories(categories) {
      base.calls.push(['setNotificationCategories', categories]);
    },
    postNotification(props, done) {
      const id = props.identifier ?? `n${++seq}`;
      base.calls.push(['postNotification', { ...props, identifier: id }]);
      setImmediate(() => done?.(null));
      return id;
    },
    updateNotification(id, props, done) {
      base.calls.push(['updateNotification', id, props]);
      setImmediate(() => done?.(null));
    },
    removeNotification(id) {
      base.calls.push(['removeNotification', id]);
    },
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
  native.setBackendEventCallback((ev) => app._route(ev));
  return app;
}

describe('the cocoa centre', () => {
  test('asks once, posts with a category for the actions, updates in place, and hears back', async () => {
    const native = fakeNative();
    const app = appOver(native);
    const seen = [];
    const banner = await notify({
      app,
      summary: 'Export finished',
      body: 'report.pdf',
      subtitle: 'Exports',
      actions: [{ key: 'open', label: 'Open' }],
      onAction: (key) => seen.push(['action', key]),
      onClose: (reason) => seen.push(['close', reason]),
    });
    assert.equal(banner.backend, 'cocoa');
    assert.equal(banner.id, 'n1');
    assert.equal(native.of('requestNotificationAuthorization').length, 1);
    const [[categories]] = native.of('setNotificationCategories');
    assert.equal(categories.length, 1);
    assert.deepEqual(categories[0].actions[0], {
      id: 'open',
      title: 'Open',
      foreground: true,
    });
    const [[post]] = native.of('postNotification');
    assert.equal(post.title, 'Export finished');
    assert.equal(post.subtitle, 'Exports');
    assert.equal(post.categoryId, categories[0].id);
    assert.equal(post.sound, 'default');

    await banner.update({ body: 'opened' });
    assert.deepEqual(native.of('updateNotification')[0].slice(0, 1), ['n1']);
    assert.equal(native.of('updateNotification')[0][1].body, 'opened');

    // a second notification with the same actions reuses the category and
    // asks for no authorization again
    await notify({
      app,
      summary: 'Again',
      actions: [{ key: 'open', label: 'Open' }],
    });
    assert.equal(native.of('setNotificationCategories').length, 1);
    assert.equal(native.of('requestNotificationAuthorization').length, 1);

    native.emit({
      type: 'notification-action',
      identifier: 'n1',
      actionId: 'open',
    });
    native.emit({
      type: 'notification-action',
      identifier: 'n1',
      actionId: 'default',
    });
    native.emit({
      type: 'notification-dismissed',
      identifier: 'n1',
      reason: 'dismissed',
    });
    assert.deepEqual(seen, [
      ['action', 'open'],
      ['action', 'default'],
      ['close', 'dismissed'],
    ]);

    await banner.close(); // already gone: nothing to remove, no second onClose
    assert.equal(native.of('removeNotification').length, 0);
    assert.equal(seen.length, 3);
  });

  test('close removes a live banner and reports it', async () => {
    const native = fakeNative({ authorization: 'authorized' });
    const app = appOver(native);
    const closes = [];
    const banner = await notify({
      app,
      summary: 'x',
      onClose: (r) => closes.push(r),
    });
    assert.equal(native.of('requestNotificationAuthorization').length, 0);
    await banner.close();
    assert.deepEqual(native.of('removeNotification'), [['n1']]);
    assert.deepEqual(closes, ['closed']);
  });

  test('a refusal is reported, not fallen through', async () => {
    const native = fakeNative({ authorization: 'denied' });
    const app = appOver(native);
    await assert.rejects(
      () => notify({ app, summary: 'x' }),
      (err) => err.name === 'NotificationsDeniedError',
    );
    assert.equal(await notificationBackend({ app }), 'cocoa');
  });

  test('a bare process — no bundle — is unavailable, and the ladder moves on', async () => {
    const native = fakeNative({ available: false });
    const app = appOver(native);
    assert.equal(await notificationBackend({ app, backend: 'cocoa' }), null);
    await withNoBus(async () => {
      await assert.rejects(
        () => notify({ app, summary: 'x', backend: 'cocoa' }),
        (err) => err instanceof NoNotificationServiceError,
      );
    });
  });
});

// --- rungs 3 and 4: the shell-outs -----------------------------------------------

async function withFakeChild(answers, fn) {
  const nodeModule = await import('node:module');
  const cp = nodeModule.createRequire(import.meta.url)('node:child_process');
  const real = cp.execFile;
  const ran = [];
  cp.execFile = (file, args, options, callback) => {
    ran.push([file, ...args]);
    const answer = answers[file];
    setImmediate(() =>
      answer === undefined
        ? callback(Object.assign(new Error('not found'), { code: 'ENOENT' }))
        : callback(null, typeof answer === 'function' ? answer(args) : answer),
    );
    return {};
  };
  nodeModule.syncBuiltinESMExports();
  try {
    await fn(ran);
  } finally {
    cp.execFile = real;
    nodeModule.syncBuiltinESMExports();
  }
}

describe('the shell-outs', () => {
  test('osascript: a banner with no id, whose update posts anew and whose close is nothing', async () => {
    await withFakeChild({ osascript: '' }, async (ran) => {
      const banner = await notify({
        summary: 'Hi',
        body: 'there',
        backend: 'osascript',
        onClose: () => assert.fail('never reported on this rung'),
      });
      assert.equal(banner.backend, 'osascript');
      assert.equal(banner.id, null);
      await banner.update({ body: 'again' });
      await banner.close();
      assert.equal(ran.length, 2);
      assert.match(ran[1][2], /"again"/);
    });
  });

  test('notify-send: the printed id makes the update a replace', async () => {
    await withFakeChild({ 'notify-send': '42\n' }, async (ran) => {
      const banner = await notify({ summary: 'Hi', backend: 'notify-send' });
      assert.equal(banner.id, 42);
      await banner.update({ body: 'more' });
      assert.ok(ran[1].includes('-r') && ran[1].includes('42'));
    });
  });

  test('neither installed: the typed error, naming the ladder', async () => {
    await withFakeChild({}, async () => {
      await assert.rejects(
        () => notify({ summary: 'x', backend: 'notify-send' }),
        (err) => err instanceof NoNotificationServiceError,
      );
    });
  });
});

// --- the hook ----------------------------------------------------------------------

test('useNotifier binds the tree and settles available/backend', async () => {
  const native = fakeNative({ authorization: 'authorized' });
  const app = appOver(native);
  const root = await createRoot({ app });
  try {
    let seen;
    function Probe() {
      seen = useNotifier();
      return h('box');
    }
    root.render(h('window', { width: 100, height: 100 }, h(Probe)));
    await tick();
    await tick();
    await tick();
    assert.equal(seen.available, true);
    assert.equal(seen.backend, 'cocoa');
    const banner = await seen.notify({ summary: 'from the hook' });
    assert.equal(banner.backend, 'cocoa');
  } finally {
    await root.unmount();
  }
});

test('on a mock backend with no bus the hook is unavailable', async () => {
  await withNoBus(async () => {
    const root = await createRoot({ app: createMockApp() });
    try {
      let seen;
      function Probe() {
        seen = useNotifier({ backend: 'dbus' });
        return h('box');
      }
      root.render(h('window', { width: 100, height: 100 }, h(Probe)));
      await tick();
      await tick();
      await tick();
      assert.equal(seen.available, false);
    } finally {
      await root.unmount();
    }
  });
});
