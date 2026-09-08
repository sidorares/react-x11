// Evolution Data Server on the test bus.
//
// `withBus()` gives a broker; this owns the two names EDS owns on it —
// `Sources5` (the registry) and `Calendar8` (the factory) — and answers the
// calls src/desktopcalendar.js's EDS rung makes, the way EDS answers them:
// the registry through `org.freedesktop.DBus.ObjectManager`, a calendar
// through a factory that hands back an object path **and a different bus
// name**, and a view whose `Start()` replays what the query already matched.
//
// That last one is the reason this is a real bus rather than a stub object.
// The replay arrives as a signal after `Start()` has returned, so a fake
// that answered synchronously would pass whether or not the rung subscribed
// first and whether or not it asked for `E_CAL_CLIENT_VIEW_FLAGS_NONE` — and
// the loop that flag prevents (re-query → new view → replay → re-query) is
// the bug the rung is shaped around.
//
// **What the broker cannot do**, from its own docs: no security policy, no
// service activation, no fd passing. Activation is the one that matters
// here — EDS is D-Bus-activatable in real life, so `hasService()`'s
// `ListActivatableNames` branch is exercised against a real daemon or not at
// all. Do not read a green suite as covering it.

const SOURCES_NAME = 'org.gnome.evolution.dataserver.Sources5';
const SOURCES_PATH = '/org/gnome/evolution/dataserver/SourceManager';
const SOURCE_IFACE = 'org.gnome.evolution.dataserver.Source';
const WRITABLE_IFACE = 'org.gnome.evolution.dataserver.Source.Writable';
const FACTORY_NAME = 'org.gnome.evolution.dataserver.Calendar8';
const FACTORY_PATH = '/org/gnome/evolution/dataserver/CalendarFactory';
const FACTORY_IFACE = 'org.gnome.evolution.dataserver.CalendarFactory';
const CAL_IFACE = 'org.gnome.evolution.dataserver.Calendar';
const VIEW_IFACE = 'org.gnome.evolution.dataserver.CalendarView';

/** The name the factory hands back — a *different* one from its own, as the
 *  real factory does (each backend runs in its own subprocess). A rung that
 *  assumed the factory's name would fail here, which is the point. */
const BACKEND_NAME =
  'org.gnome.evolution.dataserver.Subprocess.Backend.Calendarx1';

/** `E_CAL_CLIENT_VIEW_FLAGS_NOTIFY_INITIAL` — what EDS creates a view with,
 *  and why `Start()` announces the range's current contents. */
export const NOTIFY_INITIAL = 1;

/** One source's keyfile, the ini blob a Source carries its whole config in. */
export function keyfile({
  name,
  color,
  backend = 'local',
  enabled = true,
  kind = 'Calendar',
  account,
}) {
  return [
    '[Data Source]',
    `DisplayName=${name}`,
    `Enabled=${enabled}`,
    ...(account ? ['', '[GNOME Online Accounts]', `Account=${account}`] : []),
    '',
    `[${kind}]`,
    `BackendName=${backend}`,
    ...(color ? [`Color=${color}`] : []),
  ].join('\n');
}

const DEFAULT_SOURCES = [
  { uid: 'personal', name: 'Personal', color: '#3584e4', writable: true },
  { uid: 'work', name: 'Work', color: '#e01b24', backend: 'caldav' },
  // an address book: no [Calendar] section, so not a calendar at all
  { uid: 'contacts', name: 'Contacts', kind: 'Address Book' },
];

async function connect(dbus, address) {
  const bus = dbus.createClient({ busAddress: address });
  await new Promise((resolve, reject) => {
    bus.connection.once('connect', resolve);
    bus.connection.once('error', reject);
  });
  await bus.listNames();
  return bus;
}

/**
 * Start a fake Evolution Data Server against `address`.
 *
 * ```js
 * const eds = await fakeEds(address, { objects: { personal: [ICS_ONE] } });
 * eds.views.get('personal').emit('ObjectsModified', [ICS_ONE]);
 * ```
 *
 * - `sources` — what the registry reports. Defaults to two calendars and an
 *   address book, so "the address book is not a calendar" is always tested.
 * - `objects` — `uid -> [ics]`, what that calendar's `GetObjectList` answers
 *   and what its view replays.
 * - `broken` — uids whose `OpenCalendar` fails, standing in for an offline
 *   backend.
 * - `refusesFlags` — uids whose view refuses `SetFlags`, standing in for a
 *   backend that replays its contents whatever it is asked.
 *
 * `views` fills in as views are handed out, keyed by calendar uid, so a test
 * can make something change after the initial delivery is over. `calls`
 * records every method the rung invoked.
 */
export async function fakeEds(address, options = {}) {
  const {
    sources = DEFAULT_SOURCES,
    objects = {},
    broken = [],
    refusesFlags = [],
  } = options;
  const dbus = (await import('dbus-native')).default;
  const bus = await connect(dbus, address);

  const eds = {
    bus,
    calls: [],
    views: new Map(),
    stop: () => bus.connection.end(),
  };
  const record = (member, ...args) => eds.calls.push([member, ...args]);

  await bus.requestName(SOURCES_NAME, 0);
  await bus.requestName(FACTORY_NAME, 0);
  await bus.requestName(BACKEND_NAME, 0);

  // --- the registry: one exported object per source, under a manager ------
  sources.forEach((source, index) => {
    const path = `${SOURCES_PATH}/Sources/${index + 1}`;
    bus.exportInterface({ UID: source.uid, Data: keyfile(source) }, path, {
      name: SOURCE_IFACE,
      methods: {},
      signals: {},
      properties: { UID: 's', Data: 's' },
    });
    // The marker interface is the whole of "the user may write to this one".
    if (source.writable) {
      bus.exportInterface({}, path, {
        name: WRITABLE_IFACE,
        methods: {},
        signals: {},
        properties: {},
      });
    }
  });
  bus.exportObjectManager(SOURCES_PATH);

  // --- one calendar object and one view per source ------------------------
  const exportCalendar = (uid) => {
    const path = `/org/gnome/evolution/dataserver/Calendar/${uid}`;
    const viewPath = `${path}/view`;

    bus.exportInterface(
      {
        Open: () => record('Open', uid),
        GetObjectList: (query) => {
          record('GetObjectList', uid, query);
          return objects[uid] ?? [];
        },
        GetTimezone: (tzid) => {
          record('GetTimezone', uid, tzid);
          // No definition here: ical.js falls back to floating time, which
          // is the branch worth having under test.
          throw new Error(`no definition for ${tzid}`);
        },
        GetView: (query) => {
          record('GetView', uid, query);
          return viewPath;
        },
      },
      path,
      {
        name: CAL_IFACE,
        methods: {
          Open: ['', '', [], []],
          GetObjectList: ['s', 'as', ['query'], ['objects']],
          GetTimezone: ['s', 's', ['tzid'], ['object']],
          GetView: ['s', 'o', ['query'], ['view']],
        },
        signals: {},
        properties: {},
      },
    );

    const view = {
      flags: NOTIFY_INITIAL,
      started: false,
      stopped: false,
      disposed: false,
      emit: (signal, objs) =>
        bus.sendSignal(viewPath, VIEW_IFACE, signal, 'as', [objs]),
    };
    eds.views.set(uid, view);

    bus.exportInterface(
      {
        SetFlags: (flags) => {
          record('SetFlags', uid, flags);
          if (refusesFlags.includes(uid)) throw new Error('SetFlags: no');
          view.flags = flags;
        },
        Start: () => {
          record('Start', uid);
          view.started = true;
          // EDS replays what the query already matches, unless the flags
          // said not to — and `Complete` closes the delivery either way.
          const initial = objects[uid] ?? [];
          if (view.flags & NOTIFY_INITIAL && initial.length) {
            view.emit('ObjectsAdded', initial);
          }
          bus.sendSignal(viewPath, VIEW_IFACE, 'Complete', 'us', [0, '']);
        },
        Stop: () => {
          record('Stop', uid);
          view.stopped = true;
        },
        Dispose: () => {
          record('Dispose', uid);
          view.disposed = true;
        },
      },
      viewPath,
      {
        name: VIEW_IFACE,
        methods: {
          SetFlags: ['u', '', ['flags'], []],
          Start: ['', '', [], []],
          Stop: ['', '', [], []],
          Dispose: ['', '', [], []],
        },
        signals: {
          ObjectsAdded: ['as', 'objects'],
          ObjectsModified: ['as', 'objects'],
          ObjectsRemoved: ['as', 'uids'],
          Complete: ['us', 'status', 'message'],
        },
        properties: {},
      },
    );
    return path;
  };

  for (const source of sources) {
    if (source.kind && source.kind !== 'Calendar') continue;
    exportCalendar(source.uid);
  }

  // --- the factory --------------------------------------------------------
  bus.exportInterface(
    {
      OpenCalendar: (uid) => {
        record('OpenCalendar', uid);
        if (broken.includes(uid)) throw new Error(`cannot open ${uid}`);
        return [
          `/org/gnome/evolution/dataserver/Calendar/${uid}`,
          BACKEND_NAME,
        ];
      },
    },
    FACTORY_PATH,
    {
      name: FACTORY_IFACE,
      methods: {
        OpenCalendar: ['s', 'os', ['uid'], ['path', 'bus_name']],
      },
      signals: {},
      properties: {},
    },
  );

  return eds;
}
