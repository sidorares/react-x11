// A panel on the test bus: the AppMenu registrar, plus enough of a dbusmenu
// *consumer* to read back what react-x11 exported.
//
// Both halves matter. The registrar alone would only prove that we call
// `RegisterWindow`; a menu is only exported if a panel can then walk it and
// activate a row, which is the round trip `readMenu()` and `click()` close.
//
// **What the broker cannot do**, from its own docs: no security policy, no
// service activation, no fd passing. Activation is the one that matters here —
// this owns the registrar name up front, where the real Ubuntu one is
// activatable and unowned until a panel starts it. That difference is the
// whole reason `globalmenu.js` asks `ListNames` rather than `hasService()`,
// and a broker cannot exercise the other side of it. Do not read a green
// suite as covering it; `scripts/globalmenu-host.mjs` against the real
// `appmenu-registrar` is what does.

import { REGISTRAR_NAME, REGISTRAR_PATH } from '../../src/globalmenu.js';

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
 * Start a registrar on `address`.
 *
 * ```js
 * const panel = await fakeRegistrar(address);
 * await until(() => panel.windows.size === 1, 'the window to register');
 * const menu = await panel.readMenu();
 * await panel.click(menu.children[0].children[0].id);
 * await panel.stop();          // the panel exits; the bar comes back
 * ```
 */
export async function fakeRegistrar(
  address,
  { registerDelay = 0, refuseRegister = false } = {},
) {
  const { dbus, bus } = await client(address);

  /** xid → { service, path } — what `GetMenus` is made of. */
  const windows = new Map();
  const calls = [];
  /**
   * The raw message flags each call arrived with.
   *
   * `NO_AUTO_START` (2) is the one that matters and it is invisible from the
   * arguments: an app that omits it turns a tidy-up call into `exec` of
   * whatever `.service` file claims the name.
   */
  const flags = [];

  const iface = dbus.defineInterface({
    name: REGISTRAR_NAME,
    methods: {
      RegisterWindow: {
        in: { windowId: 'u', menuObjectPath: 'o' },
        out: {},
        // The service is the *sender*, never an argument: the registrar's own
        // XML says it "assumes that the connection from the caller is the DBus
        // connection to use for the object". An exporter that passed a name
        // here would be talking to a registrar nobody has written.
        // `registerDelay` holds the reply open, which is the only way to get
        // an exporter reliably *inside* publish() for the teardown races.
        handler: async ({ windowId, menuObjectPath }, { sender, message }) => {
          if (registerDelay) {
            await new Promise((r) => setTimeout(r, registerDelay));
          }
          // Recorded before the refusal, so a test can wait for the attempt
          // rather than for its (absent) effect.
          calls.push(['RegisterWindow', windowId, menuObjectPath, sender]);
          flags.push(['RegisterWindow', message?.flags ?? 0]);
          // A registrar that answers the bus but refuses this call — a
          // version mismatch, a policy, a panel shutting down.
          if (refuseRegister) throw new Error('not accepting registrations');
          windows.set(windowId, { service: sender, path: menuObjectPath });
        },
      },
      UnregisterWindow: {
        in: { windowId: 'u' },
        out: {},
        handler: ({ windowId }, { message }) => {
          windows.delete(windowId);
          calls.push(['UnregisterWindow', windowId]);
          flags.push(['UnregisterWindow', message?.flags ?? 0]);
        },
      },
      GetMenuForWindow: {
        in: { windowId: 'u' },
        out: { service: 's', menuObjectPath: 'o' },
        handler: ({ windowId }) => {
          const entry = windows.get(windowId);
          if (!entry) throw new Error('no menu for that window');
          return { service: entry.service, menuObjectPath: entry.path };
        },
      },
      GetMenus: {
        in: {},
        out: { menus: 'a(uso)' },
        handler: () =>
          [...windows].map(([xid, { service, path }]) => [xid, service, path]),
      },
    },
    signals: {
      WindowRegistered: {
        args: { windowId: 'u', service: 's', menuObjectPath: 'o' },
      },
      WindowUnregistered: { args: { windowId: 'u' } },
    },
  });

  await bus.export(REGISTRAR_PATH, iface);
  await bus.requestName(REGISTRAR_NAME, 0);

  const call = (destination, path, member, signature, body) =>
    bus.invoke({
      destination,
      path,
      interface: DBUSMENU,
      member,
      signature,
      body,
      timeout: 4000,
    });

  /** The first registered window, since a test almost always has exactly one. */
  const only = () => {
    const [entry] = [...windows.values()];
    if (!entry) throw new Error('nothing has registered a menu');
    return entry;
  };

  return {
    bus,
    windows,
    calls,
    flags,

    /** `GetLayout(0, -1, [])`, as `{ id, props, children }` all the way down. */
    async readMenu(target = only()) {
      const [revision, layout] = await call(
        target.service,
        target.path,
        'GetLayout',
        'iias',
        [0, -1, []],
      );
      return { revision, ...plain(layout) };
    },

    /** One item's properties, through the group call a panel actually uses. */
    async properties(ids, names = [], target = only()) {
      const reply = await call(
        target.service,
        target.path,
        'GetGroupProperties',
        'aias',
        [ids, names],
      );
      return reply.map(([id, props]) => [id, props]);
    },

    async interfaceProperty(name, target = only()) {
      const value = await bus.invoke({
        destination: target.service,
        path: target.path,
        interface: 'org.freedesktop.DBus.Properties',
        member: 'Get',
        signature: 'ss',
        body: [DBUSMENU, name],
        timeout: 4000,
      });
      return dbus.variantValue(value);
    },

    /** Activate a row, the way a click on the panel's menu does. */
    click(id, target = only()) {
      return call(target.service, target.path, 'Event', 'isvu', [
        id,
        'clicked',
        new dbus.Variant('s', ''),
        0,
      ]);
    },

    aboutToShow(id, target = only()) {
      return call(target.service, target.path, 'AboutToShow', 'i', [id]);
    },

    /**
     * Collect the menu's signals. Returns a stop function and an array that
     * fills as they arrive — `LayoutUpdated` and `ItemsPropertiesUpdated` are
     * the two the diff has to choose between, and telling them apart is the
     * only way to test that choice from the outside.
     */
    async watchSignals(target = only()) {
      const seen = [];
      const sub = await bus.watch(
        `type='signal',sender='${target.service}',interface='${DBUSMENU}'`,
      );
      const handler = (member) => (body) => seen.push([member, ...body]);
      const handlers = ['LayoutUpdated', 'ItemsPropertiesUpdated'].map(
        (member) => {
          const key = bus.mangle(target.path, DBUSMENU, member);
          const fn = handler(member);
          bus.signals.on(key, fn);
          return [key, fn];
        },
      );
      return {
        seen,
        async stop() {
          for (const [key, fn] of handlers) bus.signals.removeListener(key, fn);
          await sub.remove().catch(() => {});
        },
      };
    },

    /** The panel exits — which is the case the whole detection story is for. */
    stop: () => bus.close(),
  };
}

/** `(id, props, av)` → `{ id, props, children }`, recursively. */
function plain(node) {
  const [id, props, children] = node;
  return { id, props, children: (children ?? []).map(plain) };
}
