#!/usr/bin/env node
// A panel, in a terminal — the consumer half of the global menu, so the
// exporter half can be seen working without installing a desktop that has one.
//
// This is the piece that is otherwise missing. `com.canonical.dbusmenu` has no
// freedesktop specification and no reference client you can `apt install` on
// its own: the consumers are panel applets welded into KDE Plasma, into
// `vala-panel`, or into a GNOME extension. So "does react-x11's menu actually
// show up" normally needs a whole second desktop session. It does not need to.
//
//   node scripts/globalmenu-host.mjs          # BE the panel: own the registrar
//   node scripts/globalmenu-host.mjs --watch  # attach to the panel already there
//
// Then, in another terminal:
//
//   npm run examples:menu
//
// The window's own menu bar disappears — that is the feature — and the menu
// shows up here instead. Type an item's id and press Enter to activate it; the
// example prints what it received.
//
// `--watch` is the mode for a machine that really has a panel (Plasma, a
// vala-panel with the appmenu applet, Ubuntu's `appmenu-registrar` started by
// one of them): it asks the live registrar what it knows rather than competing
// for the name, so it shows what the panel sees.
//
// Note the asymmetry it is worth knowing about, because it is the whole reason
// react-x11 checks for a *live owner* rather than an activatable name: on
// Ubuntu `com.canonical.AppMenu.Registrar` ships a D-Bus service file, so it is
// activatable even with no panel installed. Starting it would make every app
// hand its menu to a directory nobody reads. Run this script and the name has
// an owner, so the menus come here; kill it and they go back into their
// windows, live.

import { createInterface } from 'node:readline';

const REGISTRAR_NAME = 'com.canonical.AppMenu.Registrar';
const REGISTRAR_PATH = '/com/canonical/AppMenu/Registrar';
const DBUSMENU = 'com.canonical.dbusmenu';

const watch = process.argv.includes('--watch');
const once = process.argv.includes('--once');

const dbusMod = await import('dbus-native').catch(() => null);
if (!dbusMod) {
  console.error(
    'dbus-native is not installed. `npm i dbus-native` (it is an optional\n' +
      'dependency, and npm skips it on Node < 22.12).',
  );
  process.exit(1);
}
const dbus = dbusMod.default ?? dbusMod;

const bus = dbus.sessionBus();
await new Promise((resolve, reject) => {
  bus.connection.once('connect', resolve);
  bus.connection.once('error', reject);
});
await bus.listNames();

/** xid → { service, path } */
const windows = new Map();
/** Every item we have printed, so a typed id can be activated. */
const items = new Map();

// ---------------------------------------------------------------------------
// Being the registrar
// ---------------------------------------------------------------------------

if (!watch) {
  const iface = dbus.defineInterface({
    name: REGISTRAR_NAME,
    methods: {
      // The service is the *sender*: the registrar's own XML says it "assumes
      // that the connection from the caller is the DBus connection to use for
      // the object", so an app supplies only the path.
      RegisterWindow: {
        in: { windowId: 'u', menuObjectPath: 'o' },
        out: {},
        handler: ({ windowId, menuObjectPath }, { sender }) => {
          windows.set(windowId, { service: sender, path: menuObjectPath });
          console.log(
            `\n+ window 0x${windowId.toString(16)} registered ` +
              `(${sender} ${menuObjectPath})`,
          );
          show(windowId).catch(report);
          follow(windowId).catch(report);
        },
      },
      UnregisterWindow: {
        in: { windowId: 'u' },
        out: {},
        handler: ({ windowId }) => {
          windows.delete(windowId);
          console.log(`\n- window 0x${windowId.toString(16)} unregistered`);
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
  const reply = await bus.requestName(REGISTRAR_NAME, 0);
  // 1 is DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER. Anything else means a real
  // panel is already here, and competing with it would be worse than useless.
  if (reply !== 1) {
    console.error(
      `Something already owns ${REGISTRAR_NAME} — you have a panel.\n` +
        'Run with --watch to see what it sees.',
    );
    process.exit(1);
  }
  console.log(`owning ${REGISTRAR_NAME} as ${bus.name}`);
  console.log(
    'waiting for an app to register a menu…  (Ctrl-C to give it back)',
  );
} else {
  // Owned *right now*, and asked the same way the library asks — the name
  // being activatable is not the same as a panel being there, and a plain
  // method call would launch one rather than tell us that. Ubuntu's
  // `appmenu-registrar --gapplication-service` also quits on an idle timeout,
  // so "it was running a minute ago" is not the same either.
  const owners = await bus.listNames();
  if (!owners.includes(REGISTRAR_NAME)) {
    console.error(
      `Nothing owns ${REGISTRAR_NAME} — there is no panel showing menus\n` +
        'here right now. Run without --watch and this script will be one.',
    );
    process.exit(1);
  }
  const menus = await call(REGISTRAR_NAME, REGISTRAR_PATH, REGISTRAR_NAME, {
    member: 'GetMenus',
    signature: '',
    body: [],
  }).catch((err) => {
    console.error(`  ! the registrar refused GetMenus: ${err.message}`);
    return [];
  });
  for (const [xid, service, path] of menus) windows.set(xid, { service, path });
  if (windows.size === 0) console.log('the registrar knows of no menus');
  for (const xid of windows.keys()) {
    await show(xid).catch(report);
    await follow(xid).catch(report);
  }
  if (once) process.exit(0);
}

// ---------------------------------------------------------------------------
// Reading a menu
// ---------------------------------------------------------------------------

function call(destination, path, iface, { member, signature, body }) {
  return bus.invoke(
    { destination, path, interface: iface, member, signature, body },
    { timeout: 5000 },
  );
}

// A declaration rather than a `const` arrow, and deliberately: `--watch` reads
// a menu from the top level of this module, above where this sits, so a
// `const` would be in its temporal dead zone.
function menuCall(xid, member, signature, body) {
  const entry = windows.get(xid);
  if (!entry) throw new Error(`window 0x${xid.toString(16)} is not registered`);
  return call(entry.service, entry.path, DBUSMENU, { member, signature, body });
}

/** Print a window's whole menu, and remember every id it contains. */
async function show(xid) {
  const [revision, layout] = await menuCall(xid, 'GetLayout', 'iias', [
    0,
    -1,
    [],
  ]);
  const version = await property(xid, 'Version').catch(() => '?');
  console.log(
    `\nmenu for 0x${xid.toString(16)}  (revision ${revision}, ` +
      `dbusmenu version ${version})`,
  );
  print(layout, 0, xid);
  console.log('\ntype an item id and press Enter to activate it');
}

function print(node, depth, xid) {
  const [id, props, children] = node;
  if (depth > 0) {
    items.set(id, { xid, props });
    const pad = '  '.repeat(depth);
    console.log(`${String(id).padStart(4)} ${pad}${describe(props)}`);
  }
  for (const child of children ?? []) print(child, depth + 1, xid);
}

/** One item as a panel would draw it, plus what the protocol actually said. */
function describe(props) {
  if (props.type === 'separator') return '────────';
  let line = props.label ?? '(no label)';
  if (props['toggle-type']) {
    const state = props['toggle-state'];
    const mark = state === 1 ? '[x]' : state === -1 ? '[-]' : '[ ]';
    line = `${mark} ${line}`;
  }
  if (props.shortcut) {
    line += `   ${props.shortcut.map((c) => c.join('+')).join(' / ')}`;
  }
  if (props['children-display'] === 'submenu') line += '  ▸';
  if (props.enabled === false) line += '   (disabled)';
  if (props.visible === false) line += '   (hidden)';
  if (props['icon-name']) line += `   [icon: ${props['icon-name']}]`;
  if (props['icon-data'])
    line += `   [icon: ${props['icon-data'].length} bytes]`;
  return line;
}

async function property(xid, name) {
  const entry = windows.get(xid);
  const value = await call(
    entry.service,
    entry.path,
    'org.freedesktop.DBus.Properties',
    { member: 'Get', signature: 'ss', body: [DBUSMENU, name] },
  );
  return dbus.variantValue(value);
}

/**
 * Follow a menu's updates.
 *
 * Which of the two signals arrives is the interesting part, and the reason
 * they are both printed with their arguments: a check mark moving must be an
 * `ItemsPropertiesUpdated` with the revision unchanged, where a row appearing
 * is a `LayoutUpdated` with a new one. A shell re-walks a whole subtree on the
 * second, so an exporter that sends it for the first is quietly expensive.
 */
async function follow(xid) {
  const entry = windows.get(xid);
  await bus.watch(
    `type='signal',sender='${entry.service}',interface='${DBUSMENU}'`,
  );
  const on = (member, fn) =>
    bus.signals.on(bus.mangle(entry.path, DBUSMENU, member), fn);

  on('LayoutUpdated', ([revision, parent]) => {
    console.log(`\n· LayoutUpdated(revision=${revision}, parent=${parent})`);
    show(xid).catch(report);
  });
  on('ItemsPropertiesUpdated', ([updated, removed]) => {
    console.log('\n· ItemsPropertiesUpdated — revision unchanged');
    for (const [id, props] of updated ?? []) {
      const known = items.get(id);
      if (known) Object.assign(known.props, props);
      console.log(`    ${id}: ${JSON.stringify(props)}`);
    }
    for (const [id, names] of removed ?? []) {
      const known = items.get(id);
      if (known) for (const name of names) delete known.props[name];
      console.log(`    ${id}: back to default ${JSON.stringify(names)}`);
    }
    for (const [id] of updated ?? []) {
      const known = items.get(id);
      if (known) console.log(`  → ${id} is now: ${describe(known.props)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Activating
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  const id = Number(text);
  const item = items.get(id);
  if (!Number.isInteger(id) || !item) {
    console.log(`no item ${text}. Ids are in the left column.`);
    return;
  }
  try {
    // A real panel sends `opened` on the way in and `clicked` on the way out.
    // `AboutToShow` first, because a menu that fills itself lazily is told to
    // by that and by nothing else.
    if (item.props['children-display'] === 'submenu') {
      const needUpdate = await menuCall(item.xid, 'AboutToShow', 'i', [id]);
      console.log(`AboutToShow(${id}) → ${needUpdate}`);
      return;
    }
    await menuCall(item.xid, 'Event', 'isvu', [
      id,
      'clicked',
      new dbus.Variant('s', ''),
      Math.floor(Date.now() / 1000),
    ]);
    console.log(`clicked ${id} (${item.props.label ?? ''})`);
  } catch (err) {
    report(err);
  }
});

function report(err) {
  console.error(`  ! ${err?.message ?? err}`);
}

process.on('SIGINT', () => {
  console.log(
    '\ngiving the registrar name back — menus return to their windows',
  );
  process.exit(0);
});
