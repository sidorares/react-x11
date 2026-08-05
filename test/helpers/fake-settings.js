// The settings portal on the test bus.
//
// `withBus()` gives a broker; this owns `org.freedesktop.portal.Desktop` on
// it and answers `org.freedesktop.portal.Settings` the way xdg-desktop-portal
// does — `ReadAll` over a namespace, and `SettingChanged` when something
// moves.
//
// The one thing it does that a real portal does not: `onRead` fires *while*
// `ReadAll` is being answered, which is how the subscribe-before-read race is
// made deterministic. A client that subscribed after its read would miss a
// change emitted there, and stay stale for the rest of its life with nothing
// to correct it.

import { PORTAL_NAME, PORTAL_PATH } from '../../src/portal.js';

const SETTINGS_IFACE = 'org.freedesktop.portal.Settings';
const APPEARANCE_NS = 'org.freedesktop.appearance';

/**
 * @param {string} address the broker's address
 * @param {object} values the `org.freedesktop.appearance` namespace, as the
 *   portal spells it — `{ 'color-scheme': 1, 'accent-color': [r, g, b] }`
 */
export async function fakeSettingsPortal(address, values = {}) {
  const dbus = (await import('dbus-native')).default;
  const bus = dbus.createClient({ busAddress: address });
  const { Variant } = dbus;

  // The signatures the real portal uses. `color-scheme` and `contrast` are
  // `u` rather than the `i` a plain JS number infers, and `accent-color` is
  // the struct `(ddd)` rather than the array `ad` — a client that reached
  // into the wrong shape would pass against a looser fake and fail on a real
  // desktop.
  const wrap = (key, value) =>
    key === 'accent-color'
      ? new Variant('(ddd)', value)
      : new Variant('u', value);

  const portal = {
    bus,
    values: { ...values },
    reads: 0,
    /** Called during ReadAll, before it replies. */
    onRead: null,
    /** Change a setting and announce it, the way a desktop does. */
    change(next) {
      Object.assign(portal.values, next);
      for (const key of Object.keys(next)) {
        bus.sendSignal(PORTAL_PATH, SETTINGS_IFACE, 'SettingChanged', 'ssv', [
          APPEARANCE_NS,
          key,
          wrap(key, portal.values[key]),
        ]);
      }
    },
    /** An announcement in a namespace nothing here cares about. */
    changeNamespace(namespace, key) {
      bus.sendSignal(PORTAL_PATH, SETTINGS_IFACE, 'SettingChanged', 'ssv', [
        namespace,
        key,
        new Variant('s', 'something-else'),
      ]);
    },
    stop: () => bus.close(),
  };

  await new Promise((resolve, reject) => {
    bus.connection.once('connect', resolve);
    bus.connection.once('error', reject);
  });
  await bus.listNames();
  await bus.requestName(PORTAL_NAME, 0);

  const appearance = () =>
    Object.fromEntries(
      Object.entries(portal.values).map(([k, v]) => [k, wrap(k, v)]),
    );

  const iface = dbus.defineInterface({
    name: SETTINGS_IFACE,
    methods: {
      ReadAll: {
        in: { namespaces: 'as' },
        out: { value: 'a{sa{sv}}' },
        handler: ({ namespaces }) => {
          portal.reads++;
          // The reply carries what was true when the call arrived. `onRead`
          // changing things afterwards is exactly the race: the *reply* is
          // stale and the *signal* is the only carrier of the new value, so a
          // client that was not already subscribed never learns it.
          const answer = appearance();
          portal.onRead?.();
          const wanted = namespaces?.length ? namespaces : [APPEARANCE_NS];
          return Object.fromEntries(
            wanted
              .filter((ns) => ns === APPEARANCE_NS)
              .map((ns) => [ns, answer]),
          );
        },
      },
      ReadOne: {
        in: { namespace: 's', key: 's' },
        out: { value: 'v' },
        handler: ({ namespace, key }) => {
          if (namespace !== APPEARANCE_NS || !(key in portal.values)) {
            throw new Error('Requested setting not found');
          }
          return wrap(key, portal.values[key]);
        },
      },
    },
    properties: { version: { type: 'u', get: () => 2 } },
  });
  await bus.export(PORTAL_PATH, iface);

  return portal;
}
