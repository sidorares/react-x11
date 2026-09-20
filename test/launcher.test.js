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
  setLauncherMenu,
  setProgress,
  setQuicklist,
  setUrgent,
} from '../src/launcher.js';
import { sessionBus } from '../src/bus.js';
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

  test('progress, urgency and the quicklist ride the same entry', async () => {
    await withBus(async (address) => {
      const appUri = launcherAppUri(APP_ID);
      const launcher = await fakeLauncher(address, appUri);
      try {
        const reg = await registerApplication({ appId: APP_ID });

        assert.equal(await setProgress(0.42), true);
        await until(() => launcher.seen.length === 1, 'the progress Update');
        let p = plain(launcher.seen[0][1]);
        assert.equal(Number(p.progress).toFixed(2), '0.42');
        assert.equal(p['progress-visible'], true);

        // Every Update carries the whole state, so a launcher that restarted
        // and missed one is corrected by the next of any kind.
        assert.equal(await setUrgent(true), true);
        await until(() => launcher.seen.length === 2, 'the urgent Update');
        p = plain(launcher.seen[1][1]);
        assert.equal(p.urgent, true);
        assert.equal(Number(p.progress).toFixed(2), '0.42');

        // Out of range is clamped rather than refused: a caller dividing by a
        // total that briefly went to zero should not get an exception.
        assert.equal(await setProgress(5), true);
        await until(() => launcher.seen.length === 3, 'the clamped Update');
        assert.equal(Number(plain(launcher.seen[2][1]).progress), 1);

        assert.equal(await setLauncherMenu([{ label: 'New Window' }]), true);
        await until(() => launcher.seen.length === 4, 'the quicklist Update');
        p = plain(launcher.seen[3][1]);
        assert.ok(String(p.quicklist).endsWith('/Menu'), 'a menu object path');

        await setProgress(null);
        await setUrgent(false);
        await setLauncherMenu(null);
        await reg.release();
        await _resetLauncher();
      } finally {
        await launcher.stop();
      }
    });
  });

  test('the quicklist is a real dbusmenu a launcher can walk and click', async () => {
    await withBus(async (address) => {
      const appUri = launcherAppUri(APP_ID);
      const launcher = await fakeLauncher(address, appUri);
      const dbus = (await import('dbus-native')).default;
      const client = dbus.createClient({ busAddress: address });
      await new Promise((resolve, reject) => {
        client.connection.once('connect', resolve);
        client.connection.once('error', reject);
      });
      try {
        const reg = await registerApplication({ appId: APP_ID });
        const picked = [];
        assert.equal(
          await setLauncherMenu([
            { label: 'New Window', onSelect: () => picked.push('new') },
            { type: 'separator' },
            {
              label: 'Recent',
              items: [
                { label: 'notes.md', onSelect: () => picked.push('notes') },
              ],
            },
          ]),
          true,
        );
        await until(() => launcher.seen.length === 1, 'the quicklist Update');
        const menuPath = String(plain(launcher.seen[0][1]).quicklist);

        // The menu is exported on the app's *shared* connection — one identity
        // on the bus for the tray, the panel menu and the launcher menu.
        const ref = await sessionBus();
        const destination = ref.uniqueName;
        await ref.release();

        const call = (member, signature, body) =>
          client.invoke({
            destination,
            path: menuPath,
            interface: 'com.canonical.dbusmenu',
            member,
            signature,
            body,
            timeout: 4000,
          });

        const [, layout] = await call('GetLayout', 'iias', [0, -1, []]);
        // `dbus-native` resolves the variants, so a property is its value.
        const rows = (layout[2] ?? []).map(([id, props]) => ({
          id,
          label: props.label,
          type: props.type,
        }));
        assert.deepEqual(
          rows.map((r) => r.label ?? r.type),
          ['New Window', 'separator', 'Recent'],
        );

        await call('Event', 'isvu', [
          rows[0].id,
          'clicked',
          new dbus.Variant('s', ''),
          0,
        ]);
        await until(() => picked.length === 1, 'the handler to run');
        assert.deepEqual(picked, ['new']);

        await setLauncherMenu(null);
        await reg.release();
        await _resetLauncher();
      } finally {
        client.close();
        await launcher.stop();
      }
    });
  });

  test('with no registration there is nothing to attribute a count to', async () => {
    await withBus(async () => {
      assert.equal(await setBadge(7), false);
    });
  });

  test('the old name is the new one, not a copy of it', () => {
    // `setQuicklist` was the Unity launcher's word for the menu macOS calls
    // the Dock menu, and this function always drove both. Renamed to the one
    // word that is neither desktop's; the old name stays because an app that
    // used it is not wrong, only early. Identity rather than a wrapper, so a
    // caller cannot end up holding two functions that drift apart.
    assert.equal(setQuicklist, setLauncherMenu);
  });
});
