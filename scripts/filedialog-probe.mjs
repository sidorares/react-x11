#!/usr/bin/env node
// A file dialog, with a stopwatch on every phase — and **no X11 and no
// react-x11 anywhere in it**.
//
// The point is subtraction. "Click to dialog takes two seconds" has at least
// five candidates in it: loading the transport, dialling the bus, asking
// whether a portal exists, the portal call itself, and the desktop's own
// backend building a GTK window. Only the last one is out of our hands, and
// the only way to know which it is, is to run the same conversation with
// nothing else in the process.
//
//   node scripts/filedialog-probe.mjs                 # open, once
//   node scripts/filedialog-probe.mjs save --repeat 3 # warm vs cold
//   node scripts/filedialog-probe.mjs open --osascript   # the macOS rung
//   node scripts/filedialog-probe.mjs --no-show       # timings only, no UI
//
// What it cannot time, and says so rather than pretending: the gap between
// the portal handing back a Request handle and a dialog actually appearing.
// That is another process drawing a window — on a Wayland session it is not
// even an X window — so the script prints a marker the instant the handle
// lands and leaves the last leg to your eyes.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const FILE_CHOOSER = 'org.freedesktop.portal.FileChooser';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';

// --- arguments --------------------------------------------------------------

const argv = process.argv.slice(2);
const kind = argv.find((a) => ['open', 'save', 'folder'].includes(a)) ?? 'open';
const has = (flag) => argv.includes(flag);
const value = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const repeat = Number(value('--repeat', '1'));
const show = !has('--no-show');
const multiple = has('--multiple');
const useOsascript = has('--osascript');

// --- the stopwatch ----------------------------------------------------------

const ms = () => Number(process.hrtime.bigint()) / 1e6;
const started = ms();
let last = started;

function lap(label, note = '') {
  const now = ms();
  const delta = now - last;
  last = now;
  const bar = '█'.repeat(Math.min(40, Math.round(delta / 25)));
  console.log(
    `${String(Math.round(delta)).padStart(6)} ms  ` +
      `${String(Math.round(now - started)).padStart(7)} total  ` +
      `${label.padEnd(42)}${bar}${note}`,
  );
  return delta;
}

// --- the macOS rung ---------------------------------------------------------

function osascriptLines(dialogKind) {
  const prompt = `"react-x11 probe (${dialogKind})"`;
  const head =
    dialogKind === 'save'
      ? `set theFiles to choose file name with prompt ${prompt}`
      : dialogKind === 'folder'
        ? `set theFiles to choose folder with prompt ${prompt}`
        : `set theFiles to choose file with prompt ${prompt}` +
          (multiple ? ' with multiple selections allowed' : '');
  return [
    head,
    'if class of theFiles is not list then set theFiles to {theFiles}',
    'set out to ""',
    'repeat with f in theFiles',
    'set out to out & POSIX path of f & linefeed',
    'end repeat',
    'return out',
  ].flatMap((line) => ['-e', line]);
}

async function runOsascript() {
  console.log(`\n--- osascript (${kind}) ---\n`);
  lap('start');
  const args = osascriptLines(kind);
  console.log(
    `\n  >>> spawning osascript at +${Math.round(ms() - started)} ms`,
  );
  console.log(
    '  >>> the panel appears some time after this line — that gap is',
  );
  console.log('      AppKit starting up inside osascript, not this process.\n');
  const result = await new Promise((resolve) => {
    execFile('osascript', args, { encoding: 'utf8' }, (error, stdout, stderr) =>
      resolve({ error, stdout, stderr }),
    );
  });
  lap('osascript exited (includes your thinking time)');
  if (result.error) {
    const cancelled =
      /-128/.test(result.stderr) || /User canceled/i.test(result.stderr);
    console.log(
      cancelled ? '\ncancelled' : `\nfailed: ${result.stderr.trim()}`,
    );
    return;
  }
  console.log(
    '\npicked:',
    result.stdout.split('\n').filter(Boolean).join(', ') || '(nothing)',
  );
}

// --- the portal rung --------------------------------------------------------

async function runPortal() {
  console.log(`\n--- xdg-desktop-portal (${kind}) ---\n`);
  lap('start');

  let dbus;
  try {
    dbus = (await import('dbus-native')).default;
  } catch (err) {
    console.error(
      '\nno dbus-native here. It is an optionalDependency and npm skips it ' +
        'on Node < 22.12 (this is ' +
        process.version +
        ').\n  npm i dbus-native\n',
      err.message,
    );
    process.exit(1);
  }
  lap('import dbus-native', '  (xml2js + sax come with it)');

  const address =
    process.env.DBUS_SESSION_BUS_ADDRESS ||
    (process.env.XDG_RUNTIME_DIR
      ? `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`
      : undefined);
  console.log(
    `\n  address: ${address ?? '(none — dbus-native will try launchd, which spawns `launchctl getenv`)'}\n`,
  );

  let bus;
  try {
    bus = dbus.createClient(address ? { busAddress: address } : {});
  } catch (err) {
    lap('createClient THREW');
    console.error(`\nno session bus: ${err.message}\n`);
    process.exit(1);
  }
  lap('createClient (socket + address resolution)');

  try {
    await new Promise((resolve, reject) => {
      bus.connection.once('connect', resolve);
      bus.connection.once('error', reject);
      bus.connection.once('close', () => reject(new Error('closed')));
    });
  } catch (err) {
    lap('connect FAILED');
    console.error(`\ncould not connect: ${err.message}\n`);
    process.exit(1);
  }
  lap('connect + SASL auth');

  // The unique name is assigned in the Hello reply, so one round trip is the
  // barrier that makes it readable. react-x11's bus layer does exactly this.
  await bus.listNames();
  lap('ListNames (the name-ready barrier)', `  name=${bus.name}`);

  // What hasService() costs: is the portal owned, or activatable?
  const owned = await bus.listNames();
  lap('ListNames (hasService)');
  const activatable = await bus.listActivatableNames().catch(() => []);
  lap('ListActivatableNames (hasService)');
  const reachable =
    owned.includes(PORTAL_NAME) || activatable.includes(PORTAL_NAME);
  console.log(
    `\n  portal ${reachable ? 'reachable' : 'NOT reachable'} — ` +
      `owned=${owned.includes(PORTAL_NAME)} activatable=${activatable.includes(PORTAL_NAME)}\n`,
  );
  if (!reachable) {
    console.log(
      'nothing to call. On macOS this is where osascript takes over.',
    );
    await bus.close();
    return;
  }

  // The version property is the first call that actually *activates* the
  // service if it is not running — worth timing on its own, because it is the
  // one that pays for the daemon starting.
  try {
    const obj = await bus.getObject(PORTAL_NAME, PORTAL_PATH);
    const version = await obj.proxy[FILE_CHOOSER]?.$readProp('version');
    lap('Introspect + read FileChooser.version', `  v${version}`);
  } catch (err) {
    lap('Introspect FAILED', `  ${err.message}`);
  }

  if (!show) {
    console.log('\n--no-show: stopping before any UI.\n');
    await bus.close();
    return;
  }

  for (let attempt = 1; attempt <= repeat; attempt++) {
    if (repeat > 1) console.log(`\n  --- attempt ${attempt}/${repeat} ---`);
    const token = `rx11probe_${randomBytes(8).toString('hex')}`;
    const sender = bus.name.replace(/^:/, '').replaceAll('.', '_');
    const path = `${PORTAL_PATH}/request/${sender}/${token}`;

    const sub = await bus.watch(
      `type='signal',sender='${PORTAL_NAME}',interface='${REQUEST_IFACE}',` +
        `member='Response',path='${path}'`,
    );
    lap('AddMatch (subscribe BEFORE calling)');

    const key = bus.mangle(path, REQUEST_IFACE, 'Response');
    const answered = new Promise((resolve) =>
      bus.signals.once(key, ([response, results]) =>
        resolve({ response, results }),
      ),
    );

    const options = { handle_token: token, modal: true };
    if (multiple && kind !== 'save') options.multiple = true;
    if (kind === 'folder') options.directory = true;
    if (kind === 'save') options.current_name = 'probe.txt';

    const handle = await bus.invoke(
      {
        destination: PORTAL_NAME,
        path: PORTAL_PATH,
        interface: FILE_CHOOSER,
        member: kind === 'save' ? 'SaveFile' : 'OpenFile',
        signature: 'ssa{sv}',
        body: ['', `react-x11 probe (${kind})`, options],
      },
      { timeout: 15000 },
    );
    const callMs = lap(
      `${kind === 'save' ? 'SaveFile' : 'OpenFile'} -> Request handle`,
    );
    console.log(
      `\n  path predicted: ${path}\n  handle returned: ${handle}\n  ${
        handle === path
          ? 'MATCH — the subscription was on the right path'
          : 'MISMATCH'
      }`,
    );
    console.log(
      `\n  >>> everything above is this process: ${Math.round(ms() - started)} ms total.\n` +
        "  >>> THE DIALOG IS NOT ON SCREEN YET. The desktop's backend\n" +
        '      (xdg-desktop-portal-gnome / -gtk) is building it now, in another\n' +
        '      process. If you see a two-second wait, this is where it is —\n' +
        '      time it from this line.\n',
    );
    if (callMs > 500) {
      console.log(
        '  NOTE: the call itself took >500 ms, which usually means D-Bus had\n' +
          '        to activate xdg-desktop-portal. That cost is once per session.\n',
      );
    }

    const waiting = ms();
    const { response, results } = await answered;
    lap('Response signal (includes your thinking time)');
    console.log(
      `\n  you took ${Math.round(ms() - waiting)} ms to answer; response=${response} ` +
        `(0 ok, 1 cancelled, 2 other)`,
    );
    if (response === 0) console.log('  uris:', results?.uris ?? []);
    await sub.remove();
  }

  await bus.close();
}

// --- go ---------------------------------------------------------------------

console.log(
  `react-x11 file-dialog probe — node ${process.version} on ${process.platform}`,
);
console.log(
  `session: XDG_SESSION_TYPE=${process.env.XDG_SESSION_TYPE ?? '(unset)'} ` +
    `DISPLAY=${process.env.DISPLAY ?? '(unset)'} ` +
    `WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? '(unset)'}`,
);
if (process.env.WAYLAND_DISPLAY) {
  console.log(
    '\nNote: on a Wayland session the portal dialog is a Wayland window, so an\n' +
      'x11: parent handle cannot parent it — the dialog appears unparented.\n' +
      "That is the desktop's doing, not the app's.",
  );
}

if (useOsascript || (process.platform === 'darwin' && has('--native'))) {
  await runOsascript();
} else {
  await runPortal();
}
process.exit(0);
