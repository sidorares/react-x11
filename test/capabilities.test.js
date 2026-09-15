// Feature discovery: what the desktop says it can do, and whether we believe
// the right amount of it.
//
// The interesting cases are all *partial* support, because that is where a
// boolean would lie. A freedesktop daemon that does not list `actions` still
// shows banners; an app that posts one with buttons gets a banner with no
// buttons and no callback, silently. The whole point of the feature map is
// that this case reads as `features.actions === false` rather than as
// `available === true`.

import assert from 'node:assert';
import { describe, test } from 'node:test';

import {
  CAPABILITIES,
  NO_CAPABILITY,
  desktopCapability,
} from '../src/capabilities.js';
import {
  _resetApplicationState,
  registerApplication,
} from '../src/application.js';
import { _resetLauncher } from '../src/launcher.js';
import { fakeWatcher } from './helpers/fake-watcher.js';
import {
  offTheDesktopBus,
  transportAvailable,
  withBus,
  withNoBus,
} from './helpers/with-bus.js';

offTheDesktopBus();

const haveTransport = await transportAvailable();
const needsBroker = haveTransport
  ? {}
  : { skip: 'dbus-native is not installed (expected on Node < 22.12)' };

/** A notification daemon on the test bus that advertises exactly `caps`. */
async function fakeNotifier(address, caps) {
  const dbus = (await import('dbus-native')).default;
  const bus = dbus.createClient({ busAddress: address });
  await new Promise((resolve, reject) => {
    bus.connection.once('connect', resolve);
    bus.connection.once('error', reject);
  });
  const iface = dbus.defineInterface({
    name: 'org.freedesktop.Notifications',
    methods: {
      GetCapabilities: {
        in: {},
        out: { caps: 'as' },
        handler: () => caps,
      },
      GetServerInformation: {
        in: {},
        out: { name: 's', vendor: 's', version: 's', specVersion: 's' },
        handler: () => ({
          name: 'fake',
          vendor: 'test',
          version: '1',
          specVersion: '1.2',
        }),
      },
      Notify: {
        in: {
          appName: 's',
          replacesId: 'u',
          appIcon: 's',
          summary: 's',
          body: 's',
          actions: 'as',
          hints: 'a{sv}',
          timeout: 'i',
        },
        out: { id: 'u' },
        handler: () => 1,
      },
      CloseNotification: { in: { id: 'u' }, out: {}, handler: () => {} },
    },
    signals: {
      ActionInvoked: { args: { id: 'u', key: 's' } },
      NotificationClosed: { args: { id: 'u', reason: 'u' } },
    },
  });
  await bus.export('/org/freedesktop/Notifications', iface);
  await bus.requestName('org.freedesktop.Notifications', 0);
  return { stop: () => bus.close() };
}

describe('desktop capability discovery', () => {
  test('an unknown name is a mistake in the source, and says so', async () => {
    await assert.rejects(
      () => desktopCapability('teleportation'),
      (err) =>
        err instanceof TypeError && /no such capability/.test(err.message),
    );
  });

  test('every advertised name actually has a probe', async () => {
    await withNoBus(async () => {
      for (const name of CAPABILITIES) {
        const result = await desktopCapability(name);
        assert.equal(typeof result.available, 'boolean', name);
      }
    });
  });

  test('with no bus there is no tray and no launcher', async () => {
    await withNoBus(async () => {
      for (const name of ['tray', 'launcher']) {
        const result = await desktopCapability(name);
        assert.equal(result.available, false, name);
        assert.deepEqual(result.features, {}, name);
      }
      assert.equal(NO_CAPABILITY.available, false);
    });
  });

  test('with no bus, notifications degrade to a one-way rung', async () => {
    await withNoBus(async () => {
      // `notify-send` needs no bus, so a Linux box without one still has
      // *some* notification — and this is precisely the tier the feature map
      // exists to distinguish. `available` alone would say "yes" here and an
      // app would post a banner with reply buttons that can never come back.
      const caps = await desktopCapability('notifications');
      assert.equal(caps.available, true);
      assert.equal(caps.backend, 'notify-send');
      assert.equal(caps.features.body, true);
      assert.equal(caps.features.icon, true);
      assert.equal(caps.features.urgency, true);
      // One way, and that is the whole of it.
      assert.equal(caps.features.actions, false);
      assert.equal(caps.features.events, false);
      assert.equal(caps.features.close, false);
    });
  });

  test(
    'a daemon without `actions` is available but not interactive',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        // GNOME's own daemon looked like this for years.
        const daemon = await fakeNotifier(address, ['body', 'icon-static']);
        try {
          const caps = await desktopCapability('notifications');
          assert.equal(caps.available, true);
          assert.equal(caps.backend, 'dbus');
          assert.equal(caps.features.body, true);
          assert.equal(caps.features.icon, true);
          // The whole point: a banner, but nothing comes back from it.
          assert.equal(caps.features.actions, false);
          assert.equal(caps.features.events, false);
          assert.equal(caps.features.bodyMarkup, false);
        } finally {
          await daemon.stop();
        }
      });
    },
  );

  test(
    'a daemon with `actions` reports a two-way notification',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        const daemon = await fakeNotifier(address, [
          'actions',
          'body',
          'body-markup',
          'persistence',
          'sound',
        ]);
        try {
          const caps = await desktopCapability('notifications');
          assert.equal(caps.features.actions, true);
          assert.equal(caps.features.events, true);
          assert.equal(caps.features.bodyMarkup, true);
          assert.equal(caps.features.persistence, true);
          // Required by the protocol rather than advertised, so always true
          // on this rung — a daemon cannot opt out of replaces_id.
          assert.equal(caps.features.update, true);
          assert.equal(caps.features.close, true);
        } finally {
          await daemon.stop();
        }
      });
    },
  );

  test(
    'a live watcher is a tray; a bus with nothing on it is not',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        assert.equal((await desktopCapability('tray')).available, false);

        const host = await fakeWatcher(address);
        try {
          const caps = await desktopCapability('tray');
          assert.equal(caps.available, true);
          assert.equal(caps.backend, 'statusnotifier');
          assert.equal(caps.features.menu, true);
          // Named after the mechanism, never after the platform.
          assert.notEqual(caps.backend, 'linux');
        } finally {
          await host.stop();
        }
      });
    },
  );

  test(
    'the launcher needs an app id, and says which one is missing',
    needsBroker,
    async () => {
      await withBus(async () => {
        _resetApplicationState();
        const before = await desktopCapability('launcher');
        assert.equal(before.available, false);
        // The one "no" an app author can actually fix, so it is distinguished
        // from a desktop that simply has no launcher.
        assert.equal(before.reason, 'no-app-id');

        const reg = await registerApplication({
          appId: 'com.example.capstest',
        });
        const after = await desktopCapability('launcher');
        assert.equal(after.available, true);
        assert.equal(after.backend, 'launcherentry');
        assert.equal(after.features.badge, true);
        assert.equal(after.features.progress, true);
        assert.equal(after.features.menu, true);
        // The protocol carries a count and nothing else — a string badge is
        // macOS's alone, and an app is told rather than left to discover it.
        assert.equal(after.features.badgeText, false);
        // Availability on the bus is not the whole story here.
        assert.equal(after.features.needsDesktopFile, true);

        await reg?.release();
        await _resetLauncher();
        _resetApplicationState();
      });
    },
  );

  test(
    'a second copy of the app is not-primary, not a missing app id',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        _resetApplicationState();
        // The first copy takes the name.
        const dbus = (await import('dbus-native')).default;
        const other = dbus.createClient({ busAddress: address });
        await new Promise((resolve, reject) => {
          other.connection.once('connect', resolve);
          other.connection.once('error', reject);
        });
        await other.requestName('com.example.capsprimary', 0);

        const reg = await registerApplication({
          appId: 'com.example.capsprimary',
        });
        assert.equal(reg?.role, 'secondary', 'the name was already taken');

        const caps = await desktopCapability('launcher');
        assert.equal(caps.available, false);
        // Not `no-app-id`: the author called `registerApplication` and it did
        // exactly what it should. Sending them to add a call they already
        // made is the failure this distinction prevents.
        assert.equal(caps.reason, 'not-primary');

        await reg?.release?.();
        other.close();
        _resetApplicationState();
      });
    },
  );

  test('results are frozen, so a caller cannot corrupt the next probe', async () => {
    await withNoBus(async () => {
      const caps = await desktopCapability('tray');
      assert.throws(() => {
        'use strict';
        caps.available = true;
      });
    });
  });
});
