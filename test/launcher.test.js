// The badge on Linux (src/launcher.js, docs/desktop.md "The launcher"): one
// `com.canonical.Unity.LauncherEntry.Update` signal on the session bus,
// attributed to the app by the identity `registerApplication` established.
//
// Against a real broker, with a peer subscribed the way a launcher is — by
// interface, then by the entry's path — so what is pinned is the wire: the
// app URI, the count as an int64 variant, `count-visible`, and the entry
// leaving the bus once the badge is cleared.
import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';

import {
  _resetApplicationState,
  registerApplication,
} from '../src/application.js';
import {
  LAUNCHER_ENTRY_IFACE,
  _resetLauncher,
  badgeLabel,
  launcherAppUri,
  launcherEntryPath,
  setBadge,
} from '../src/launcher.js';
import { transportAvailable, until, withBus } from './helpers/with-bus.js';

const haveTransport = await transportAvailable();
const needsBroker = haveTransport
  ? {}
  : { skip: 'dbus-native is not installed (expected on Node < 22.12)' };

const APP_ID = 'com.example.badged';

afterEach(async () => {
  await _resetLauncher();
  _resetApplicationState();
});

describe('the label', () => {
  test('a count is its digits; zero, empty and nothing are no badge', () => {
    assert.equal(badgeLabel(3), '3');
    assert.equal(badgeLabel(12.9), '12');
    assert.equal(badgeLabel('•'), '•');
    for (const none of [0, null, undefined, '', false, NaN]) {
      assert.equal(badgeLabel(none), null, `${String(none)} clears`);
    }
  });

  test('the entry path is the conventional hash under the Unity prefix', () => {
    const path = launcherEntryPath(launcherAppUri(APP_ID));
    assert.match(path, /^\/com\/canonical\/unity\/launcherentry\/\d+$/);
    assert.equal(path, launcherEntryPath(launcherAppUri(APP_ID)), 'stable');
  });
});

/** A launcher on the test bus: subscribes to Update and collects them. */
async function fakeLauncher(address, appUri) {
  const dbus = (await import('dbus-native')).default;
  const bus = dbus.createClient({ busAddress: address });
  await new Promise((resolve, reject) => {
    bus.connection.once('connect', resolve);
    bus.connection.once('error', reject);
  });
  const seen = [];
  const sub = await bus.watch(
    `type='signal',interface='${LAUNCHER_ENTRY_IFACE}'`,
  );
  const key = bus.mangle(
    launcherEntryPath(appUri),
    LAUNCHER_ENTRY_IFACE,
    'Update',
  );
  bus.signals.on(key, (body) => seen.push(body));
  return {
    seen,
    async stop() {
      await sub.remove().catch(() => {});
      bus.close();
    },
  };
}

/** `a{sv}` as dbus-native delivers it, whichever of its shapes: a plain map. */
function plain(dict) {
  if (Array.isArray(dict)) {
    return Object.fromEntries(
      dict.map(([k, v]) => [k, Array.isArray(v) ? v[1]?.[0] : (v?.value ?? v)]),
    );
  }
  return Object.fromEntries(
    Object.entries(dict ?? {}).map(([k, v]) => [k, v?.value ?? v]),
  );
}

describe('the LauncherEntry rung', { ...needsBroker }, () => {
  test('a count is one Update signal under the app’s URI; clearing releases the entry', async () => {
    await withBus(async (address, broker) => {
      const appUri = launcherAppUri(APP_ID);
      const launcher = await fakeLauncher(address, appUri);
      try {
        const reg = await registerApplication({ appId: APP_ID });
        assert.equal(reg?.role, 'primary');

        assert.equal(await setBadge(3), true);
        await until(() => launcher.seen.length === 1, 'the Update to arrive');
        const [uri, props] = launcher.seen[0];
        assert.equal(uri, appUri);
        const p = plain(props);
        assert.equal(Number(p.count), 3);
        assert.equal(p['count-visible'], true);

        assert.equal(
          await setBadge('•'),
          true,
          'a string is a count of nothing',
        );
        await until(() => launcher.seen.length === 2, 'the second Update');
        assert.equal(Number(plain(launcher.seen[1][1]).count), 0);
        assert.equal(plain(launcher.seen[1][1])['count-visible'], true);

        const before = broker.liveClients;
        assert.equal(await setBadge(null), true);
        await until(() => launcher.seen.length === 3, 'the clearing Update');
        assert.equal(plain(launcher.seen[2][1])['count-visible'], false);
        // the entry's bus ref is released with the badge, so an app that
        // cleared its badge on the way out is free to exit
        assert.ok(broker.liveClients <= before);

        // nothing shown: clearing again tells nobody, and never rejects
        assert.equal(await setBadge(null), false);
        await reg.release();
      } finally {
        await launcher.stop();
      }
    });
  });

  test('with no registration there is nothing to attribute a count to', async () => {
    await withBus(async () => {
      assert.equal(await setBadge(7), false);
    });
  });
});
