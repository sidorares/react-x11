// A notification daemon on the test bus: owns `org.freedesktop.Notifications`
// and answers `Notify`, `CloseNotification` and `GetCapabilities` the way a
// real one does — an id back at once, the signals later, on request — so
// what `src/notifications.js` puts on the wire and what it makes of the
// daemon's signals can both be pinned from the outside.

import {
  NOTIFICATIONS_NAME,
  NOTIFICATIONS_PATH,
} from '../../src/notifications.js';

/**
 * ```js
 * const daemon = await fakeNotifications(address, { capabilities: ['actions'] });
 * const id = daemon.calls[0].id;
 * daemon.invoke(id, 'open');    // ActionInvoked
 * daemon.close(id, 2);          // NotificationClosed, reason 2 = dismissed
 * await daemon.stop();
 * ```
 */
export async function fakeNotifications(
  address,
  { capabilities = ['actions', 'body'] } = {},
) {
  const dbus = (await import('dbus-native')).default;
  const bus = dbus.createClient({ busAddress: address });
  await new Promise((resolve, reject) => {
    bus.connection.once('connect', resolve);
    bus.connection.once('error', reject);
  });
  await bus.listNames();
  await bus.requestName(NOTIFICATIONS_NAME, 0);

  let next = 1;
  const daemon = {
    bus,
    /** every Notify, in order, with the id it was given */
    calls: [],
    /** every CloseNotification */
    closed: [],
    /** how many times GetCapabilities was read — once per client session */
    capabilityReads: 0,
    invoke(id, key) {
      bus.sendSignal(
        NOTIFICATIONS_PATH,
        NOTIFICATIONS_NAME,
        'ActionInvoked',
        'us',
        [id, key],
      );
    },
    close(id, reason = 2) {
      bus.sendSignal(
        NOTIFICATIONS_PATH,
        NOTIFICATIONS_NAME,
        'NotificationClosed',
        'uu',
        [id, reason],
      );
    },
    stop: () => bus.close(),
  };

  const iface = dbus.defineInterface({
    name: NOTIFICATIONS_NAME,
    methods: {
      GetCapabilities: {
        in: {},
        out: { capabilities: 'as' },
        handler: () => {
          daemon.capabilityReads++;
          return capabilities;
        },
      },
      Notify: {
        in: {
          app_name: 's',
          replaces_id: 'u',
          app_icon: 's',
          summary: 's',
          body: 's',
          actions: 'as',
          hints: 'a{sv}',
          expire_timeout: 'i',
        },
        out: { id: 'u' },
        handler: (args) => {
          const id = args.replaces_id || next++;
          daemon.calls.push({ ...args, id });
          return id;
        },
      },
      CloseNotification: {
        in: { id: 'u' },
        out: {},
        handler: ({ id }) => {
          daemon.closed.push(id);
          daemon.close(id, 3);
        },
      },
    },
  });
  await bus.export(NOTIFICATIONS_PATH, iface);
  return daemon;
}
