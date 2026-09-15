// A tray host on the test bus: the StatusNotifierWatcher, plus enough of an
// item *consumer* to read back what react-x11 registered.
//
// The same shape as `fake-registrar.js` and for the same reason: owning the
// watcher name only proves that `RegisterStatusNotifierItem` was called. An
// icon is only really in a tray if the host can then read its properties and
// walk its menu, which is the round trip `item()` and `readMenu()` close.
//
// **What a broker cannot do**: service activation. This owns the watcher name
// up front, where a real desktop may have `org.kde.StatusNotifierWatcher` as
// an *activatable* name that nothing has started. That difference is exactly
// why `statusnotifier.js` asks `nameHasOwner` rather than `hasService()`, and
// a broker cannot exercise the other side of it. Do not read a green suite as
// covering it.

import {
  ITEM_IFACE,
  WATCHER_IFACE,
  WATCHER_NAME,
  WATCHER_PATH,
} from '../../src/statusnotifier.js';

const DBUSMENU = 'com.canonical.dbusmenu';

async function client(address) {
  const dbus = (await import('dbus-native')).default;
  const bus = dbus.createClient({ busAddress: address });
  await new Promise((resolve, reject) => {
    bus.connection.once('connect', resolve);
    bus.connection.once('error', reject);
  });
  await bus.listNames();
  return { dbus, bus };
}

/**
 * Start a watcher on `address`.
 *
 * ```js
 * const host = await fakeWatcher(address);
 * await until(() => host.items.length === 1, 'the item to register');
 * assert.equal(await host.property('Title'), 'Inbox');
 * await host.click(host.menuOf(await host.readMenu()).children[0].id);
 * await host.stop();          // the panel exits; the icon goes with it
 * ```
 */
export async function fakeWatcher(
  address,
  { refuseRegister = false, registerDelay = 0 } = {},
) {
  const { dbus, bus } = await client(address);

  /** `sender@path`, the spec's own spelling, as the watcher property. */
  const items = [];
  const calls = [];

  const iface = dbus.defineInterface({
    name: WATCHER_IFACE,
    methods: {
      // One string, read two ways — a bus name or an object path. react-x11
      // sends the path (see `statusnotifier.js`), and a test that let the
      // name form through here would not notice if that changed.
      RegisterStatusNotifierItem: {
        in: { service: 's' },
        out: {},
        handler: async ({ service }, { sender }) => {
          if (registerDelay) {
            await new Promise((r) => setTimeout(r, registerDelay));
          }
          calls.push(['RegisterStatusNotifierItem', service, sender]);
          if (refuseRegister) throw new Error('not accepting items');
          const path = service.startsWith('/')
            ? service
            : '/StatusNotifierItem';
          const owner = service.startsWith('/') ? sender : service;
          items.push({ service: owner, path });
          watcher.emit.StatusNotifierItemRegistered(`${owner}${path}`);
        },
      },
      RegisterStatusNotifierHost: {
        in: { service: 's' },
        out: {},
        handler: ({ service }) => void calls.push(['RegisterHost', service]),
      },
    },
    properties: {
      IsStatusNotifierHostRegistered: {
        type: 'b',
        access: 'read',
        get: () => true,
      },
      ProtocolVersion: { type: 'i', access: 'read', get: () => 0 },
      RegisteredStatusNotifierItems: {
        type: 'as',
        access: 'read',
        get: () => items.map(({ service, path }) => `${service}${path}`),
      },
    },
    signals: {
      StatusNotifierItemRegistered: { args: { service: 's' } },
      StatusNotifierItemUnregistered: { args: { service: 's' } },
      StatusNotifierHostRegistered: { args: {} },
      StatusNotifierHostUnregistered: { args: {} },
    },
  });
  const watcher = iface;

  await bus.export(WATCHER_PATH, iface);
  await bus.requestName(WATCHER_NAME, 0);

  /** The first registered item, since a test almost always has exactly one. */
  const only = () => {
    const [entry] = items;
    if (!entry) throw new Error('nothing has registered a tray item');
    return entry;
  };

  const getProperty = (target, iface_, name) =>
    bus
      .invoke({
        destination: target.service,
        path: target.path,
        interface: 'org.freedesktop.DBus.Properties',
        member: 'Get',
        signature: 'ss',
        body: [iface_, name],
        timeout: 4000,
      })
      .then((v) => dbus.variantValue(v));

  return {
    bus,
    items,
    calls,

    /** One `org.kde.StatusNotifierItem` property, as a host reads it. */
    property: (name, target = only()) => getProperty(target, ITEM_IFACE, name),

    /**
     * Every property at once — the `GetAll` a host does on registration.
     *
     * `dbus-native` already unwraps the `a{sv}` into a plain object with the
     * variants resolved, so unlike `Get` there is nothing left to unpack.
     */
    properties(target = only()) {
      return bus.invoke({
        destination: target.service,
        path: target.path,
        interface: 'org.freedesktop.DBus.Properties',
        member: 'GetAll',
        signature: 's',
        body: [ITEM_IFACE],
        timeout: 4000,
      });
    },

    /** The item's menu, walked from its own `Menu` property. */
    async readMenu(target = only()) {
      const path = await getProperty(target, ITEM_IFACE, 'Menu');
      const [revision, layout] = await bus.invoke({
        destination: target.service,
        path,
        interface: DBUSMENU,
        member: 'GetLayout',
        signature: 'iias',
        body: [0, -1, []],
        timeout: 4000,
      });
      return { revision, ...plain(layout) };
    },

    /** Activate a row, the way a click in the tray menu does. */
    async click(id, target = only()) {
      const path = await getProperty(target, ITEM_IFACE, 'Menu');
      return bus.invoke({
        destination: target.service,
        path,
        interface: DBUSMENU,
        member: 'Event',
        signature: 'isvu',
        body: [id, 'clicked', new dbus.Variant('s', ''), 0],
        timeout: 4000,
      });
    },

    /** A left click on the icon itself. */
    activate(x = 10, y = 20, target = only()) {
      return bus.invoke({
        destination: target.service,
        path: target.path,
        interface: ITEM_IFACE,
        member: 'Activate',
        signature: 'ii',
        body: [x, y],
        timeout: 4000,
      });
    },

    /**
     * Collect the item's own `New*` signals. The protocol has no general
     * property-changed signal, so which of these arrives is the only way to
     * see from outside that an update sent the narrow thing rather than
     * everything.
     */
    async watchSignals(target = only()) {
      const seen = [];
      const sub = await bus.watch(
        `type='signal',sender='${target.service}',interface='${ITEM_IFACE}'`,
      );
      const members = [
        'NewIcon',
        'NewTitle',
        'NewToolTip',
        'NewStatus',
        'NewAttentionIcon',
        'NewOverlayIcon',
      ];
      const handlers = members.map((member) => {
        const key = bus.mangle(target.path, ITEM_IFACE, member);
        const fn = (body) => seen.push([member, ...(body ?? [])]);
        bus.signals.on(key, fn);
        return [key, fn];
      });
      return {
        seen,
        async stop() {
          for (const [key, fn] of handlers) bus.signals.removeListener(key, fn);
          await sub.remove().catch(() => {});
        },
      };
    },

    /** The panel exits — which is the case the detection story is for. */
    stop: () => bus.close(),
  };
}

/** `(id, props, av)` → `{ id, props, children }`, recursively. */
function plain(node) {
  const [id, props, children] = node;
  return { id, props, children: (children ?? []).map(plain) };
}
