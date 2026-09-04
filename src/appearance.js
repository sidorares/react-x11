// What the desktop looks like, as four values an app can render from:
// light or dark, the accent colour (with the ink the desktop puts on it,
// where it names one), contrast, and whether the user asked for less motion.
//
// ## Why this is a ladder and not a call
//
// There is no cross-toolkit palette protocol. Nothing on a Linux desktop lets
// one toolkit ask another "what colour is a window background" — what exists
// is a shared *theme name*, each toolkit shipping its own implementation of a
// theme by that name, and exactly four standardised appearance **values**
// behind `org.freedesktop.portal.Settings`. Those four are what this reads,
// and the ladder is what happens where the portal is not running:
//
//   1. **the settings portal** — the real contract, the only source with an
//      accent colour, live over `SettingChanged`. libadwaita, Qt 6.5+,
//      Firefox and Electron all read this one.
//   2. **XSETTINGS** — pre-D-Bus, X11-only, and thin here: `Net/ThemeName`
//      is a *name*, so "is this dark" comes down to trusting the `-dark`
//      suffix. That guess is what the portal was invented to replace, which
//      is why it is a fallback and never a correction.
//   3. **macOS** — `NSUserDefaults` and `NSWorkspace` through one long-lived
//      `osascript` child, which is the only source on a Mac: a stock XQuartz
//      has no portal, no XSETTINGS manager and an unset `RESOURCE_MANAGER`.
//
// `RESOURCE_MANAGER` is deliberately **not** a rung. It is where `Xft.dpi`,
// `Xft.rgba` and `Xcursor.*` live — font and cursor rendering — and there has
// never been an X resource for colour scheme, accent or contrast. It has
// nothing to say about any of the four values here.
//
// ## The rungs disagree, so the ladder is strictly ordered
//
// Measured on one GNOME 49 session, at one moment: the portal reports
// `reduced-motion: 0` while GNOME's own `enable-animations` is `false`.
// Taking the best-answered field from each rung would produce a combination
// no single desktop actually believes, so the first rung that answers owns
// every field, and the ones below it are not consulted again.
//
// ## The first render does not start from nothing
//
// None of these values changes more than a few times in a machine's life, so
// the answer is written to the cache directory and read back — synchronously,
// on the first read — before any rung has been asked. The first frame is
// drawn in the colours this desktop had last time and the ladder revalidates
// behind it, which is the only way to be right on frame one without making
// startup wait for D-Bus.
//
// ## Nothing here holds the process open
//
// The subscription is installed and the bus ref is *released*: the match rule
// stays on the shared connection, but the socket goes back to `unref()`d. An
// app whose windows have closed still exits; an app with a window on screen
// is awake anyway and gets the signal. Same for the macOS child, which is
// spawned `unref()`d and killed on exit.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionBus } from './bus.js';
import { desktopIntegrationEnabled } from './desktopintegration.js';
import { PORTAL_NAME, PORTAL_PATH } from './portal.js';
import { beginXSettings, watchXSettings, xsettings } from './xsettings.js';

const SETTINGS_IFACE = 'org.freedesktop.portal.Settings';
const APPEARANCE_NS = 'org.freedesktop.appearance';

/**
 * What is known before anything has answered, and what stays true on a
 * machine with none of the three sources.
 *
 * `'no-preference'` is the desktop declining to say — which per the portal
 * spec means *use your own default*, not *use light*. It is not a loading
 * state: `source` is what distinguishes "nobody has been asked yet" (null)
 * from "asked, and this desktop has no opinion" — and `'cache'`, which is
 * "this is what the answer was last time, and nobody has been asked yet".
 */
const NOTHING = Object.freeze({
  colorScheme: 'no-preference',
  accent: null,
  accentText: null,
  contrast: 'normal',
  reducedMotion: false,
  source: null,
});

/**
 * The current answer, as one frozen object that is replaced rather than
 * mutated.
 *
 * Identity matters: `useSystemAppearance()` reads this through
 * `useSyncExternalStore`, whose `getSnapshot` must return the *same* object
 * until something actually changes. Building `{ colorScheme, accent, … }` per
 * call — the obvious shape — makes React see a new value every render and
 * loop.
 */
let snapshot = NOTHING;

/** Which rung owns the snapshot; once one does, the ones below it stop. */
let owner = null;

/** The in-flight ladder run, shared by concurrent callers. */
let probe = null;

const watchers = new Set();

// --------------------------------------------------------------------------
// Publishing
// --------------------------------------------------------------------------

const SAME = (a, b) =>
  a.colorScheme === b.colorScheme &&
  a.accent === b.accent &&
  a.accentText === b.accentText &&
  a.contrast === b.contrast &&
  a.reducedMotion === b.reducedMotion &&
  a.source === b.source;

/**
 * Publish a rung's answer. A rung that reports the values it already reported
 * notifies nobody — desktops re-announce settings for reasons of their own,
 * and a re-render per announcement would be churn with nothing behind it.
 */
function publish(values, source) {
  const next = Object.freeze({ ...NOTHING, ...values, source });
  if (SAME(next, snapshot)) return;
  snapshot = next;
  // What came *off* the disk does not go back onto it, and a pinned test
  // value must never reach a developer's real cache file.
  if (source !== 'cache' && source !== 'test') save(next);
  for (const fn of [...watchers]) {
    try {
      fn(snapshot);
    } catch {
      // a subscriber that throws must not take the others with it
    }
  }
}

/**
 * Pin the appearance, and stop the ladder from running at all.
 *
 * `react-x11/test`'s `renderX11` calls this, and that is not a convenience —
 * it is what keeps a test suite from rendering differently on a developer's
 * dark desktop. The default palette now follows the system, so without a pin
 * every pixel assertion in every suite, here and in applications, would be a
 * function of whoever ran it.
 *
 * Pass `null` to release the pin and let the ladder run again.
 */
export function setAppearanceForTests(values) {
  probe = null;
  // Never touch the developer's own remembered answer either, in either
  // direction: `publish` will not write a pinned value, and marking the cache
  // as already checked keeps `load()` from reading one back over it.
  cacheChecked = true;
  if (values === null) {
    cacheChecked = false;
    // Releasing undoes a *pin*, and only a pin. A real rung's answer is not
    // this function's to throw away: `cleanup()` releases after every test,
    // and a suite that resolved the appearance for real would otherwise find
    // it wiped by the harness that was meant to leave it alone.
    if (owner === 'test') {
      owner = null;
      publish({}, null);
    }
    return;
  }
  owner = 'test';
  publish(values, 'test');
}

// --------------------------------------------------------------------------
// The last known answer
// --------------------------------------------------------------------------
//
// None of this changes more than a few times in a machine's life, so the
// first render does not have to start from the defaults: the answer from last
// time is on disk, it is read synchronously before anything else happens, and
// the ladder revalidates it in the background. Stale-while-revalidate, and
// the stale value is almost always the right one.
//
// It is written to the **cache** directory rather than a dotfile in $HOME,
// because that is exactly what it is — regenerable, disposable, and nothing a
// user would ever want to edit. `REACT_X11_NO_APPEARANCE_CACHE=1` turns it
// off for a process that must not touch the disk.

const CACHE_VERSION = 1;
let cacheChecked = false;

function cacheFile() {
  if (process.env.REACT_X11_NO_APPEARANCE_CACHE) return null;
  let base = process.env.XDG_CACHE_HOME;
  if (!base) {
    let home;
    try {
      home = os.homedir();
    } catch {
      return null;
    }
    // '/' is what the browser bundle's `os` shim answers; a process with no
    // home has nowhere to put this and does without.
    if (!home || home === '/') return null;
    base =
      process.platform === 'darwin'
        ? path.join(home, 'Library', 'Caches')
        : path.join(home, '.cache');
  }
  return path.join(base, 'react-x11', 'appearance.json');
}

const SCHEMES = new Set(['light', 'dark', 'no-preference']);

/**
 * The file is ordinary user-writable JSON that has been sitting on a disk
 * since some previous run, so every field is checked rather than trusted —
 * `accent` in particular goes straight into a style, and the shape of a
 * colour is the one thing worth being sure of.
 */
function sanitize(saved) {
  return {
    colorScheme: SCHEMES.has(saved?.colorScheme)
      ? saved.colorScheme
      : 'no-preference',
    accent: /^#[0-9a-f]{6}$/i.test(saved?.accent) ? saved.accent : null,
    accentText: /^#[0-9a-f]{6}$/i.test(saved?.accentText)
      ? saved.accentText
      : null,
    contrast: saved?.contrast === 'high' ? 'high' : 'normal',
    reducedMotion: saved?.reducedMotion === true,
  };
}

/**
 * Seed the snapshot from disk. Once, synchronously, on the first read —
 * never at import, so a process that does not ask what colour the desktop is
 * never touches the filesystem for it.
 *
 * It assigns rather than publishing: this runs from `appearanceSnapshot()`,
 * which React calls **during render**, and notifying subscribers from there
 * is how you get a warning about updating a component while rendering. There
 * is nothing to notify anyway — a subscription is an effect, so it cannot
 * exist before the first render has read the store.
 */
function load() {
  if (cacheChecked) return;
  cacheChecked = true;
  // `createRoot({ desktop: false })` means this process does not follow the
  // desktop, and that has to include the remembered answer: seeding from the
  // cache would leave an app that opted out drawing in whatever colours this
  // machine happened to be in last time, which is the opposite of the
  // determinism the switch is asked for (#417).
  if (!desktopIntegrationEnabled('appearance')) return;
  const file = cacheFile();
  if (!file) return;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved?.v !== CACHE_VERSION) return;
    snapshot = Object.freeze({ ...sanitize(saved), source: 'cache' });
  } catch {
    // no cache yet, an unreadable one, a full disk, a container with no
    // home — every one of them means the defaults stand, which is what they
    // are for
  }
}

/**
 * Write what a rung answered, for the next process to start with.
 *
 * Through a temporary file and a rename, which is atomic on POSIX: two apps
 * launched together would otherwise be able to leave a half-written file for
 * a third to parse. Synchronous, because it is 150 bytes and happens once at
 * startup and once per theme change — an async write would buy a fraction of
 * a millisecond and cost an error path that has to be got right.
 */
function save(values) {
  const file = cacheFile();
  if (!file) return;
  const temporary = `${file}.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      temporary,
      JSON.stringify({
        v: CACHE_VERSION,
        colorScheme: values.colorScheme,
        accent: values.accent,
        accentText: values.accentText,
        contrast: values.contrast,
        reducedMotion: values.reducedMotion,
      }),
    );
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // read-only home, no disk space, no filesystem at all: the cache is an
      // optimisation and never a requirement
    }
  }
}

// --------------------------------------------------------------------------
// Rung 1: org.freedesktop.portal.Settings
// --------------------------------------------------------------------------

/**
 * `0` no preference, `1` **dark**, `2` **light**, anything else no
 * preference.
 *
 * The ordering is the trap. 1-is-dark reads backwards, so a comparison
 * written from memory inverts the whole desktop — and inverts it only on the
 * machines that expressed a preference, which are the ones that care.
 */
function schemeFromPortal(value) {
  if (value === 1) return 'dark';
  if (value === 2) return 'light';
  return 'no-preference';
}

/**
 * `(ddd)` of sRGB values in [0, 1] → `'#rrggbb'`, or null when unset.
 *
 * The spec spells "no accent colour" as values outside the range, which is
 * `(-1, -1, -1)` in practice. A string rather than the triple because every
 * style in this renderer takes a CSS colour: handing back `{ r: 0.93, … }`
 * invites `rgb(0.93, 0.36, 0)`, which is black.
 */
function accentFromPortal(triple) {
  if (!Array.isArray(triple) || triple.length < 3) return null;
  const channels = triple.slice(0, 3);
  if (!channels.every((c) => typeof c === 'number' && c >= 0 && c <= 1)) {
    return null;
  }
  return (
    '#' +
    channels
      .map((c) =>
        Math.round(c * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** The `org.freedesktop.appearance` dict → the four values. */
export function fromPortal(ns = {}) {
  return {
    colorScheme: schemeFromPortal(ns['color-scheme']),
    accent: accentFromPortal(ns['accent-color']),
    // The portal names the fill and nothing about what goes on it; the
    // palette picks the legible ink itself (`resolveTheme`).
    accentText: null,
    contrast: ns.contrast === 1 ? 'high' : 'normal',
    // version 2 of the interface; on version 1 the key is simply absent and
    // "no" is the right answer
    reducedMotion: ns['reduced-motion'] === 1,
  };
}

async function portalRung() {
  const ref = await sessionBus();
  if (!ref) return false;

  let sub = null;
  try {
    // **Subscribe before reading.** A change landing between the read and the
    // match rule is lost, and nothing ever corrects it — the app stays stale
    // for its whole lifetime. Same shape as the portal Request race, and the
    // cost of getting it right is the order of two lines.
    sub = await ref.bus.watch(
      `type='signal',sender='${PORTAL_NAME}',` +
        `interface='${SETTINGS_IFACE}',member='SettingChanged'`,
    );

    // **And attach the handler before reading too.** The match rule alone
    // only makes the daemon route the signal here; with no listener on the
    // other end it is still dropped, and a change that landed while the
    // initial read was in flight is exactly the change this ordering exists
    // to catch.
    //
    // Which makes the two reads racy, so they are sequenced: a read never
    // publishes over the answer of one that was *started* after it, however
    // the replies happen to arrive.
    let started = 0;
    let published = 0;
    const refresh = async () => {
      const mine = ++started;
      const values = await readAppearance(ref.bus);
      if (values && mine > published) {
        published = mine;
        publish(fromPortal(values), 'portal');
      }
      return values;
    };

    const key = ref.bus.mangle(PORTAL_PATH, SETTINGS_IFACE, 'SettingChanged');
    ref.bus.signals.on(key, ([namespace]) => {
      if (namespace !== APPEARANCE_NS) return;
      // Re-read rather than patch the one key the signal named: the value it
      // carries has been reported stale under rapid switching, and a read is
      // one round trip on a connection that is already open.
      refresh().catch(() => {
        // the portal went away mid-session; the last answer stands
      });
    });

    // No `hasService()` probe first: this is one call either way, and a name
    // that is neither owned nor activatable fails it immediately with
    // ServiceUnknown. The probe would be two extra round trips to learn what
    // the call itself reports.
    if (!(await refresh())) {
      throw new Error('the settings portal answered no appearance');
    }
    return true;
  } catch {
    await sub?.remove().catch(() => {});
    return false;
  } finally {
    // The match rule outlives the ref, and must: holding one would keep the
    // socket `ref()`d and the process alive for as long as the app cared what
    // colour the desktop is.
    await ref.release();
  }
}

function invoke(bus, { member, signature, body }) {
  return bus.invoke(
    {
      destination: PORTAL_NAME,
      path: PORTAL_PATH,
      interface: SETTINGS_IFACE,
      member,
      signature,
      body,
    },
    { timeout: 5_000 },
  );
}

/** `ReadAll(['org.freedesktop.appearance'])`, unwrapped to the namespace. */
const readAppearance = (bus) =>
  invoke(bus, {
    member: 'ReadAll',
    signature: 'as',
    body: [[APPEARANCE_NS]],
  }).then((all) => all?.[APPEARANCE_NS] ?? null);

// --------------------------------------------------------------------------
// Rung 2: XSETTINGS
// --------------------------------------------------------------------------

/**
 * A theme *name* is all this rung has, so reading it is a convention rather
 * than a contract: `Adwaita-dark`, `Yaru-dark`, `Breeze-Dark`. Matched at the
 * end of the name only — `Darkly` and `HighContrast` are not dark themes, and
 * a substring match calls them one.
 *
 * `Gtk/ApplicationPreferDarkTheme` is checked first where a daemon exports
 * it, because it is the answer rather than a hint about it.
 */
export function fromXSettings(map) {
  const name = map.get('Net/ThemeName');
  const theme = typeof name === 'string' ? name : '';
  const prefersDark = map.get('Gtk/ApplicationPreferDarkTheme');
  const dark =
    typeof prefersDark === 'number'
      ? prefersDark === 1
      : /[-_ :]dark$/i.test(theme);

  // GNOME's are `HighContrast` and `HighContrastInverse`; matched with the
  // separators stripped so `High-Contrast` and `high contrast` count too.
  const high = /highcontrast/i.test(theme.replace(/[-_ ]/g, ''));

  // `Gtk/EnableAnimations` is in GTK's key list but a settings daemon need
  // not export it — gnome-settings-daemon does not, so on GNOME this rung
  // cannot answer reduced motion and says no rather than guessing.
  const animations = map.get('Gtk/EnableAnimations');

  return {
    colorScheme: dark ? 'dark' : theme ? 'light' : 'no-preference',
    // XSETTINGS has no accent colour. Not "none set" — no such key exists.
    accent: null,
    accentText: null,
    contrast: high ? 'high' : 'normal',
    reducedMotion: animations === 0,
  };
}

async function xsettingsRung(app) {
  if (!app) return false;
  await beginXSettings(app);
  const values = xsettings(app);
  if (!values) return false;
  publish(fromXSettings(values), 'xsettings');
  watchXSettings(app, (next) => {
    if (owner !== 'xsettings') return;
    publish(next ? fromXSettings(next) : {}, 'xsettings');
  });
  return true;
}

// --------------------------------------------------------------------------
// Rung 3: macOS
// --------------------------------------------------------------------------

/**
 * One JXA program: read the four values, print them as JSON, and print them
 * again whenever macOS says they changed.
 *
 * **It reads the frameworks rather than `defaults`.** Three of the four
 * `defaults` keys — `AppleHighlightColor`, `AppleAccentColor`,
 * `com.apple.universalaccess increaseContrast` — do not exist until the user
 * changes that setting, so "key not found" is the normal answer rather than
 * the error case, and `AppleAccentColor` is an integer index into a table
 * that has to be maintained by hand and is wrong the moment Apple adds a
 * colour. `NSColor.controlAccentColor` is the colour itself, with Multicolor
 * already resolved, and `NSWorkspace` answers the two accessibility flags
 * directly.
 *
 * **The ink is read too.** `alternateSelectedControlTextColor` is what AppKit
 * writes on a control filled with the accent, and it is not what a contrast
 * ratio would choose: white on the orange accent is 2.6:1, and every native
 * control does it anyway. A palette that follows the desktop's fill and
 * picks its own letters for it looks like neither — so the pair travels
 * together, and `accentText` is null from the sources that have no ink to
 * name (the portal), where the palette decides by contrast.
 *
 * Exported so a test can pin the source; it cannot be executed on Linux.
 */
export const MACOS_PROGRAM = `
ObjC.import('AppKit');
var ud = $.NSUserDefaults.standardUserDefaults;
var ws = $.NSWorkspace.sharedWorkspace;
function srgb(color) {
  var c = color.colorUsingColorSpace($.NSColorSpace.sRGBColorSpace);
  return c.isNil() ? null : [c.redComponent, c.greenComponent, c.blueComponent];
}
function read() {
  var style = ud.stringForKey('AppleInterfaceStyle');
  var dark = !style.isNil() && ObjC.unwrap(style) === 'Dark';
  var accent = null;
  var accentText = null;
  try {
    // Dynamic colours resolve in the *current* appearance, which in a bare
    // osascript is Aqua whatever the desktop is in; the ink AppKit puts on
    // a filled control is allowed to differ between the two.
    $.NSAppearance.setCurrentAppearance($.NSAppearance.appearanceNamed(
      dark ? $.NSAppearanceNameDarkAqua : $.NSAppearanceNameAqua));
    accent = srgb($.NSColor.controlAccentColor);
    accentText = srgb($.NSColor.alternateSelectedControlTextColor);
  } catch (e) {}
  return JSON.stringify({
    dark: dark,
    accent: accent,
    accentText: accentText,
    reducedMotion: !!ws.accessibilityDisplayShouldReduceMotion,
    contrast: !!ws.accessibilityDisplayShouldIncreaseContrast
  });
}
function emit() { console.log(read()); }
emit();
var dnc = $.NSDistributedNotificationCenter.defaultCenter;
['AppleInterfaceThemeChangedNotification',
 'AppleColorPreferencesChangedNotification'].forEach(function (name) {
  dnc.addObserverForNameObjectQueueUsingBlock(
    name, $(), $.NSOperationQueue.mainQueue, emit);
});
ws.notificationCenter.addObserverForNameObjectQueueUsingBlock(
  'NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification',
  $(), $.NSOperationQueue.mainQueue, emit);
$.NSRunLoop.currentRunLoop.run();
`;

/** One line of the child's output → the four values, or null if it is noise. */
export function fromMacOS(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    // macOS always has a definite appearance, so an unset AppleInterfaceStyle
    // is *light* rather than "no preference".
    colorScheme: parsed.dark ? 'dark' : 'light',
    accent: accentFromPortal(parsed.accent),
    // The same `(r, g, b)` shape as the accent, by construction above
    accentText: accentFromPortal(parsed.accentText),
    contrast: parsed.contrast ? 'high' : 'normal',
    reducedMotion: Boolean(parsed.reducedMotion),
  };
}

let child = null;

/**
 * Spawn the watcher and resolve on its first line — or `false` if it dies,
 * prints nothing usable, or takes more than a few seconds, any of which mean
 * this Mac cannot answer and the ladder is finished.
 *
 * `console.log` in JXA has gone to stderr in some macOS releases and stdout in
 * others, so both are read. It costs one extra listener to not depend on
 * which.
 */
async function macosRung() {
  if (process.platform !== 'darwin' || child) return false;
  const { spawn } = await import('node:child_process');

  let proc;
  try {
    proc = spawn('osascript', ['-l', 'JavaScript', '-e', MACOS_PROGRAM], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return false;
  }
  child = proc;
  // Never a reason for the process to stay alive.
  proc.unref();
  proc.stdout.unref?.();
  proc.stderr.unref?.();
  proc.on('error', () => {});

  return await new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      proc.kill();
      done(false);
    }, 5_000);
    timer.unref?.();

    let buffered = '';
    const onData = (chunk) => {
      buffered += chunk;
      let at;
      while ((at = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, at).trim();
        buffered = buffered.slice(at + 1);
        if (!line) continue;
        const values = fromMacOS(line);
        if (!values) continue;
        if (settled && owner !== 'macos') return;
        publish(values, 'macos');
        done(true);
      }
    };
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', () => {
      // Dying after it answered leaves the last value standing, which is more
      // useful than reverting to the defaults.
      child = null;
      done(false);
    });
  });
}

// Killed rather than left behind: `unref()` keeps it from holding *this*
// process open, and nothing keeps it from outliving it.
process.on('exit', () => child?.kill());

// --------------------------------------------------------------------------
// The ladder
// --------------------------------------------------------------------------

async function runLadder(app) {
  for (const [name, rung] of [
    ['portal', portalRung],
    // Before XSETTINGS, and only on a Mac: where the process is macOS, the
    // Mac's own preference is the one the user set, and an XSETTINGS daemon
    // there would be something they installed by hand. A *Linux* process on
    // an XQuartz display never reaches this at all, which is correct — it
    // cannot read that Mac's defaults.
    ['macos', macosRung],
    ['xsettings', () => xsettingsRung(app)],
  ]) {
    let answered = false;
    try {
      answered = await rung();
    } catch {
      answered = false;
    }
    if (answered) {
      owner = name;
      return snapshot;
    }
  }
  return snapshot;
}

/**
 * The desktop's appearance, resolved.
 *
 * ```js
 * const { colorScheme, accent } = await systemAppearance();
 * ```
 *
 * The imperative twin of `useSystemAppearance()`, and a **verified** answer
 * rather than the remembered one the first render starts from:
 *
 * ```js
 * const [root] = await Promise.all([createRoot(), systemAppearance()]);
 * root.render(<App />);
 * ```
 *
 * Most apps do not need that line, because the snapshot is seeded from the
 * last run before the first render — see `load()` above. It is for the first
 * launch on a machine, and for anything that must be exact rather than
 * probably right.
 *
 * Waiting is a deliberate choice, and it is why the probe does not live
 * inside `createRoot()`. Measured cold on a GNOME session: `createRoot()`
 * alone 85 ms, `createRoot()` with a concurrent portal probe 124 ms —
 * `dbus-native`'s import is CPU-bound, so it does not hide behind ntk's
 * startup. An app that never asks what colour the desktop is should not pay
 * 40 ms to find out.
 *
 * Never rejects. A machine with no portal, no settings daemon and no Mac
 * answers `'no-preference'` with `source: null`, which is a real answer:
 * use your own defaults.
 *
 * `app` lets the XSETTINGS rung run — pass the ntk connection where you have
 * one. Without it that rung is skipped, so a call made before `createRoot()`
 * resolves sees the portal and macOS only; the hook always passes its tree's
 * connection.
 *
 * @param {{ app?: any }} [options]
 * @returns {Promise<Readonly<SystemAppearance>>}
 */
export function systemAppearance(options = {}) {
  if (owner) return Promise.resolve(snapshot);
  // Turned off, so there is nothing to climb and nothing to remember: the
  // defaults, which is a real answer — `'no-preference'` means *use your own*
  // (src/desktopintegration.js).
  if (!desktopIntegrationEnabled('appearance')) return Promise.resolve(NOTHING);
  load();
  if (!probe) {
    // **Failure is not cached**, for the same reason `bus.js` does not cache
    // it: a session bus can genuinely appear later, the moment something
    // creates $XDG_RUNTIME_DIR/bus. Concurrent callers share the run in
    // flight; the next call after it settles starts a fresh one.
    probe = runLadder(options.app ?? null).finally(() => {
      probe = null;
    });
  }
  return probe;
}

/**
 * What is known right now, without asking. Always a complete answer — and on
 * the first call, the one this machine gave last time rather than the
 * defaults.
 */
export function appearanceSnapshot() {
  load();
  return snapshot;
}

/**
 * Re-render when the desktop's appearance changes. Not public —
 * `useSystemAppearance()` is the public shape.
 */
export function watchAppearance(onChange) {
  watchers.add(onChange);
  return () => watchers.delete(onChange);
}

/** Test seam, not public: forget everything that was learned. */
export function _resetAppearance() {
  snapshot = NOTHING;
  owner = null;
  probe = null;
  cacheChecked = false;
  watchers.clear();
  child?.kill();
  child = null;
}

/** @typedef {typeof NOTHING} SystemAppearance */
