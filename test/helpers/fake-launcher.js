// The other side of `org.freedesktop.Application`, twice over.
//
// `fakeLauncher()` is the desktop: `gio open` and everything else on GLib's
// `g_app_info_launch_default_for_uri`, which calls `Open`/`Activate` on the
// app's well-known name with a `platform_data` dict.
//
// `fakeApplication()` is the *first copy of the app* — the one already running
// when `xdg-open` spawns a second. That case cannot be built out of two
// `registerApplication()` calls in one process: a registration is per-process
// because an identity is, and a second call on the same connection would get
// `ALREADY_OWNER` rather than `EXISTS`. A separate connection owning the name
// is the only faithful way to be the other instance.
//
// **What the broker cannot do**, from its own docs: no security policy and no
// service activation. So the launch that *starts* the process — the bus
// calling `Open` on a name it activates from a `.service` file — is not
// reachable here and is manual QA on a real session; see docs/uri-schemes.md.

import {
  APPLICATION_IFACE,
  objectPathForAppId,
} from '../../src/application.js';

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

/** `{ 'desktop-startup-id': 'x_TIME9' }` → the `a{sv}` the wire wants. */
function platformData(dbus, values) {
  const out = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    out[key] = new dbus.Variant('s', String(value));
  }
  return out;
}

/**
 * A desktop that can open links with an app.
 *
 * ```js
 * const desktop = await fakeLauncher(address);
 * await desktop.open('com.example.myapp', ['com.example.myapp://auth?code=1'], {
 *   'desktop-startup-id': 'launcher/app/1-0_TIME9876',
 * });
 * ```
 */
export async function fakeLauncher(address) {
  const { dbus, bus } = await client(address);

  const call = (appId, member, signature, body) =>
    bus.invoke({
      destination: appId,
      path: objectPathForAppId(appId),
      interface: APPLICATION_IFACE,
      member,
      signature,
      body,
      timeout: 4000,
    });

  return {
    bus,
    open: (appId, uris, data) =>
      call(appId, 'Open', 'asa{sv}', [uris, platformData(dbus, data)]),
    activate: (appId, data) =>
      call(appId, 'Activate', 'a{sv}', [platformData(dbus, data)]),
    activateAction: (appId, name, params = [], data) =>
      call(appId, 'ActivateAction', 'sava{sv}', [
        name,
        params,
        platformData(dbus, data),
      ]),
    introspect: (appId) =>
      bus.invoke({
        destination: appId,
        path: objectPathForAppId(appId),
        interface: 'org.freedesktop.DBus.Introspectable',
        member: 'Introspect',
        signature: '',
        body: [],
        timeout: 4000,
      }),
    stop: () => bus.close(),
  };
}

/**
 * An instance of the app that is already running: it owns the name and records
 * what gets forwarded to it.
 *
 * ```js
 * const first = await fakeApplication(address, 'com.example.myapp');
 * const second = await registerApplication({ appId: 'com.example.myapp', argv });
 * assert.equal(second.role, 'secondary');
 * assert.deepEqual(first.opened[0].uris, argv);
 * ```
 */
export async function fakeApplication(address, appId) {
  const { dbus, bus } = await client(address);

  /** `{ uris, platformData }` per `Open`, in order. */
  const opened = [];
  /** `{ platformData }` per `Activate`. */
  const activated = [];

  const iface = dbus.defineInterface({
    name: APPLICATION_IFACE,
    methods: {
      Activate: {
        in: { platform_data: 'a{sv}' },
        out: {},
        handler: ({ platform_data: data }) => {
          activated.push({ platformData: data ?? {} });
        },
      },
      Open: {
        in: { uris: 'as', platform_data: 'a{sv}' },
        out: {},
        handler: ({ uris, platform_data: data }) => {
          opened.push({ uris: uris ?? [], platformData: data ?? {} });
        },
      },
    },
  });

  const registration = await bus.export(objectPathForAppId(appId), iface);
  const reply = await bus.requestName(appId, 0);

  return {
    bus,
    opened,
    activated,
    /** 1 when this fake really is the owner — a test's own premise. */
    nameReply: reply,
    async stop() {
      await registration.remove().catch(() => {});
      await bus.close();
    },
  };
}
