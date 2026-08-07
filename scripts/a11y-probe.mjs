#!/usr/bin/env node
// A screen reader, minus the screen reader.
//
// This is the *client* side of AT-SPI — the side Orca is on — in about two
// hundred lines of D-Bus. It exists for two reasons:
//
//  1. **You do not have to learn Orca to see whether your app is
//     accessible.** Point this at a running app and it prints the tree an
//     assistive technology sees, or follows the events one would react to,
//     or (with `--speak`) says them out loud through speech-dispatcher.
//  2. It is the honest measure of what our bridge emits. Nothing here
//     imports react-x11's renderer; it talks to whatever is on the
//     accessibility bus, so it reads a GTK or Qt app exactly as well and
//     you can compare the two side by side. That comparison is the whole
//     test: if `nautilus` and your app print the same *shapes*, a screen
//     reader will treat them the same way.
//
//   node scripts/a11y-probe.mjs                     # what is on the bus
//   node scripts/a11y-probe.mjs widgets             # dump that app's tree
//   node scripts/a11y-probe.mjs widgets --watch     # follow its events
//   node scripts/a11y-probe.mjs widgets --watch --speak   # ...out loud
//   node scripts/a11y-probe.mjs nautilus            # someone else's toolkit
//
// **The `say:` lines are a model, not Orca.** What Orca actually utters is
// Orca's policy — verbosity settings, locale, punctuation level, its own
// per-role scripts — and it changes between releases. The lines here follow
// react-x11's own documented utterance model (`utteranceOf`, shared with
// the `renderX11({ a11y: true })` test spy, which is what makes a probe
// session and a test suite agree on wording) so that a missing accessible
// name is *audible* rather than merely absent from a table. Treat a `say:`
// line as "there is enough here to say something", never as "Orca will say
// this".
//
// See docs/accessibility.md; the design record is
// docs/architecture/accessibility.md.

import { execFile } from 'node:child_process';
import { ATSPI_STATE, ATSPI_STATE_NICK } from '../src/a11y.js';
import { utteranceOf } from '../src/testing/a11y.js';

const REGISTRY = 'org.a11y.atspi.Registry';
const ROOT = '/org/a11y/atspi/accessible/root';
const ACCESSIBLE = 'org.a11y.atspi.Accessible';
const VALUE = 'org.a11y.atspi.Value';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const target = argv.find((a) => !a.startsWith('-'));
const watch = has('--watch');
const speak = has('--speak');
const depthLimit = Number(
  argv[argv.indexOf('--depth') + 1] ?? (watch ? 0 : 40),
);

// --- the bus ----------------------------------------------------------------

/** Wait for a fresh dbus-native client to finish handshake + Hello. */
async function connected(bus) {
  await new Promise((resolve, reject) => {
    bus.connection.once('connect', resolve);
    bus.connection.once('error', reject);
  });
  await bus.listNames();
  return bus;
}

/**
 * The accessibility bus is not the session bus: ask `org.a11y.Bus` where it
 * is, which also starts the launcher on a desktop where nothing has needed
 * it yet. Exactly the rung `src/atspi.js` climbs.
 */
async function accessibilityBus(dbus) {
  if (process.env.AT_SPI_BUS_ADDRESS) {
    return connected(
      dbus.createClient({ busAddress: process.env.AT_SPI_BUS_ADDRESS }),
    );
  }
  const session = await connected(dbus.createClient({}));
  let address;
  try {
    address = await session.invoke({
      destination: 'org.a11y.Bus',
      path: '/org/a11y/bus',
      interface: 'org.a11y.Bus',
      member: 'GetAddress',
    });
  } finally {
    session.connection.end();
  }
  if (!address) throw new Error('org.a11y.Bus answered no address');
  return connected(dbus.createClient({ busAddress: address }));
}

// --- reading an accessible --------------------------------------------------

const STATE_OF = new Map(Object.entries(ATSPI_STATE).map(([k, v]) => [v, k]));

/** The state nicks set on a node, from the two uint32s the wire carries. */
function stateNames([lo = 0, hi = 0]) {
  const out = [];
  for (const bit of STATE_OF.keys()) {
    const on = bit < 32 ? lo & (1 << bit) : hi & (1 << (bit - 32));
    if (on) out.push(ATSPI_STATE_NICK[bit]);
  }
  return out;
}

/** A remote accessible, as a handful of calls. `ref` is the `(so)` pair
 * every AT-SPI reply hands you: a bus name and an object path. */
function accessible(bus, [dest, path]) {
  const call = (iface, member, signature, body) =>
    bus.invoke({
      destination: dest,
      path,
      interface: iface,
      member,
      signature,
      body,
    });
  const prop = (iface, name) =>
    call(PROPERTIES, 'Get', 'ss', [iface, name]).then((v) =>
      Array.isArray(v) ? (v[1]?.[0] ?? v[1]) : v,
    );
  return {
    ref: [dest, path],
    dest,
    path,
    call,
    name: () => prop(ACCESSIBLE, 'Name'),
    roleName: () => call(ACCESSIBLE, 'GetRoleName'),
    states: () => call(ACCESSIBLE, 'GetState').then(stateNames),
    children: () => call(ACCESSIBLE, 'GetChildren'),
    interfaces: () => call(ACCESSIBLE, 'GetInterfaces'),
    value: () => prop(VALUE, 'CurrentValue'),
    valueMax: () => prop(VALUE, 'MaximumValue'),
  };
}

/** Everything on the bus: the registry's root lists one child per app. */
async function applications(bus) {
  const refs = await accessible(bus, [REGISTRY, ROOT]).children();
  return Promise.all(
    refs.map(async (ref) => {
      const a = accessible(bus, ref);
      return { ...a, label: await a.name().catch(() => '?') };
    }),
  );
}

// --- the utterance, over the wire -------------------------------------------

/** Gather a remote accessible's parts and hand them to the shared model —
 * the same `utteranceOf` the test spy uses on live nodes, fed here from
 * real D-Bus replies so the two can never drift apart. */
async function utterance(node) {
  const [name, role, states, ifaces] = await Promise.all([
    node.name().catch(() => ''),
    node.roleName().catch(() => ''),
    node.states().catch(() => []),
    node.interfaces().catch(() => []),
  ]);
  let value = null;
  if (ifaces.includes(VALUE)) {
    const [now, max] = await Promise.all([
      node.value().catch(() => null),
      node.valueMax().catch(() => null),
    ]);
    if (typeof now === 'number') value = { now, min: 0, max: max ?? 0 };
  }
  return utteranceOf({ name, role, states, value });
}

let speaking = Promise.resolve();
function say(text) {
  if (!speak) return;
  // queued through speech-dispatcher, the same daemon Orca speaks through
  speaking = speaking.then(
    () =>
      new Promise((resolve) => execFile('spd-say', ['--wait', text], resolve)),
  );
}

// --- the tree ---------------------------------------------------------------

async function dump(node, depth = 0, budget = { left: 400 }) {
  if (depth > depthLimit || budget.left-- <= 0) return;
  const [name, role, states] = await Promise.all([
    node.name().catch(() => ''),
    node.roleName().catch(() => '?'),
    node.states().catch(() => []),
  ]);
  const interesting = states.filter((s) =>
    [
      'focusable',
      'focused',
      'checked',
      'selected',
      'expanded',
      'editable',
      'modal',
    ].includes(s),
  );
  console.log(
    '  '.repeat(depth) +
      `${role}${name ? ` "${name}"` : ''}` +
      (interesting.length ? ` [${interesting.join(',')}]` : ''),
  );
  const kids = await node.children().catch(() => []);
  for (const ref of kids) await dump(accessible(bus, ref), depth + 1, budget);
}

// --- events -----------------------------------------------------------------

const WATCHED = [
  'org.a11y.atspi.Event.Object',
  'org.a11y.atspi.Event.Window',
  'org.a11y.atspi.Event.Focus',
];

async function follow(bus, app) {
  for (const iface of WATCHED) {
    await bus.addMatch(
      `type='signal',interface='${iface}',sender='${app.dest}'`,
    );
  }
  // Some toolkits only emit once the registry says somebody is listening.
  // Ours emits unconditionally, so this is best-effort — and the reason the
  // probe works against GTK apps too.
  for (const event of [
    'object:state-changed',
    'object:text-changed',
    'focus:',
  ]) {
    await bus
      .invoke({
        destination: REGISTRY,
        path: '/org/a11y/atspi/registry',
        interface: 'org.a11y.atspi.Registry',
        member: 'RegisterEvent',
        signature: 'sas',
        body: [event, []],
      })
      .catch(() => {});
  }

  console.log(
    `\nwatching "${app.label}" — interact with the window (^C to stop)\n`,
  );

  bus.connection.on('message', async (msg) => {
    if (msg.type !== 4 || msg.sender !== app.dest) return;
    const member = msg.member;
    const [detail, d1, , any] = msg.body ?? [];
    const node = accessible(bus, [msg.sender, msg.path]);
    const plain = (v) => (Array.isArray(v) ? (v[1]?.[0] ?? v[1]) : v);

    if (member === 'StateChanged' && detail === 'focused' && d1 === 1) {
      const text = await utterance(node);
      console.log(`focus      ${text}`);
      say(text);
      return;
    }
    if (member === 'StateChanged' && detail !== 'focused') {
      // a state a screen reader would re-announce on the focused control
      if (['checked', 'expanded', 'selected', 'pressed'].includes(detail)) {
        const word = d1 === 1 ? detail : `not ${detail}`;
        console.log(`state      ${word}`);
        say(word);
      }
      return;
    }
    if (member === 'TextChanged') {
      const text = String(plain(any) ?? '');
      console.log(`text       ${detail} ${JSON.stringify(text)} @${d1}`);
      // an inserted character is what a screen reader echoes as you type
      if (detail === 'insert' && text.length <= 2) say(text);
      return;
    }
    if (member === 'TextCaretMoved') {
      console.log(`caret      ${d1}`);
      return;
    }
    if (member === 'Announcement') {
      const text = String(plain(any) ?? '');
      console.log(`announce   ${text}`);
      say(text);
      return;
    }
    if (member === 'ChildrenChanged') {
      console.log(`tree       ${detail} at ${d1}`);
      return;
    }
    if (member === 'Activate' || member === 'Deactivate') {
      console.log(`window     ${member.toLowerCase()}`);
      return;
    }
    if (member === 'PropertyChange') {
      console.log(`property   ${detail} = ${JSON.stringify(plain(any))}`);
    }
  });
}

// --- main -------------------------------------------------------------------

let bus;
try {
  const dbus = (await import('dbus-native')).default;
  bus = await accessibilityBus(dbus);
} catch (err) {
  console.error(
    'no accessibility bus here:',
    err?.message ?? err,
    '\n\nOn a desktop, enable it once with:\n' +
      '  gsettings set org.gnome.desktop.interface toolkit-accessibility true\n' +
      'On Node < 22.12, dbus-native is not installed: npm i dbus-native',
  );
  process.exit(1);
}

const apps = await applications(bus);

if (!target) {
  console.log('applications on the accessibility bus:\n');
  for (const app of apps) console.log(`  ${app.label}`);
  console.log(
    '\npass one of those names to dump its tree, --watch to follow it.',
  );
  process.exit(0);
}

const app =
  apps.find((a) => a.label === target) ??
  apps.find((a) => a.label?.includes(target));
if (!app) {
  console.error(
    `no application named "${target}" on the bus. Present: ${apps
      .map((a) => a.label)
      .join(', ')}`,
  );
  process.exit(1);
}

if (watch) {
  await follow(bus, app);
} else {
  await dump(app);
  process.exit(0);
}
