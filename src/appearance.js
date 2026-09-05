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
  selection: null,
  palette: null,
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

/** Two palettes with the same tokens — or both absent. */
function samePalette(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
}

const SAME = (a, b) =>
  a.colorScheme === b.colorScheme &&
  a.accent === b.accent &&
  a.accentText === b.accentText &&
  a.selection === b.selection &&
  samePalette(a.palette, b.palette) &&
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
  // A string, checked as one: `RegExp.test` coerces, and `['#ed5b00']`
  // would pass the pattern and then reach a style as an array.
  const hex = (value) =>
    typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : null;
  return {
    colorScheme: SCHEMES.has(saved?.colorScheme)
      ? saved.colorScheme
      : 'no-preference',
    accent: hex(saved?.accent),
    accentText: hex(saved?.accentText),
    selection: hex(saved?.selection),
    palette: sanitizePalette(saved?.palette, hex),
    contrast: saved?.contrast === 'high' ? 'high' : 'normal',
    reducedMotion: saved?.reducedMotion === true,
  };
}

/**
 * A remembered palette is taken whole or not at all: every token named in
 * `PALETTE_TOKENS` must be a colour, and nothing else is kept. A palette with
 * a hole would merge over the built-in one and paint a built-in colour next
 * to the desktop's, which is the one look this whole thing exists to avoid.
 */
function sanitizePalette(saved, hex) {
  if (!saved || typeof saved !== 'object') return null;
  const palette = {};
  for (const token of PALETTE_TOKENS) {
    const value = hex(saved[token]);
    if (!value) return null;
    palette[token] = value;
  }
  return Object.freeze(palette);
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
        selection: values.selection,
        palette: values.palette,
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
    // The portal names the fill and nothing about what goes on it, nor a
    // second shade for a selected row; the palette picks the legible ink
    // itself (`resolveTheme`) and highlights with the accent.
    accentText: null,
    selection: null,
    palette: null,
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
    selection: null,
    palette: null,
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
 * **And the selection shade.** A selected menu row or list row on macOS is
 * not filled with the accent but with `selectedContentBackgroundColor`, a
 * darker cut of it — same hue, lightness 0.54 → 0.40 in dark and 0.45 in
 * light for the orange, hand-tuned per accent rather than computed. A menu
 * highlighted in the raw accent beside a native one reads as too bright, so
 * it is read rather than approximated, and is null where nothing names it.
 *
 * **One process reads the colours once.** `controlAccentColor` and the rest
 * are resolved on first use and cached for the life of the process — after
 * the user picks another accent, the same process still answers the old one,
 * with or without an `NSApplication` (measured on macOS 15: the value does
 * not move even after `NSSystemColorsDidChangeNotification`). So the program
 * prints its values once and, on the change notifications, **exits**; the
 * rung spawns another, whose first read is fresh. A watcher that re-read in
 * place re-announced the same values, and nothing downstream ever saw a
 * change — that was the bug.
 *
 * And it leaves when its parent has: eight of these were found on one
 * machine, days old, reparented to launchd by apps that had died without
 * running their exit handler.
 *
 * Exported so a test can pin the source; it cannot be executed on Linux.
 */
export const MACOS_PROGRAM = `
ObjC.import('AppKit');
var ud = $.NSUserDefaults.standardUserDefaults;
var ws = $.NSWorkspace.sharedWorkspace;
function srgb(color) {
  var c = color.colorUsingColorSpace($.NSColorSpace.sRGBColorSpace);
  return c.isNil() ? null
    : [c.redComponent, c.greenComponent, c.blueComponent, c.alphaComponent];
}
function read() {
  var style = ud.stringForKey('AppleInterfaceStyle');
  var dark = !style.isNil() && ObjC.unwrap(style) === 'Dark';
  var accent = null;
  var accentText = null;
  var selection = null;
  try {
    ObjC.import('stdlib');
    // Dynamic colours resolve in the *current* appearance, which in a bare
    // osascript is Aqua whatever the desktop is in; the ink AppKit puts on
    // a filled control is allowed to differ between the two.
    $.NSAppearance.setCurrentAppearance($.NSAppearance.appearanceNamed(
      dark ? $.NSAppearanceNameDarkAqua : $.NSAppearanceNameAqua));
    accent = srgb($.NSColor.controlAccentColor);
    accentText = srgb($.NSColor.alternateSelectedControlTextColor);
    selection = srgb($.NSColor.selectedContentBackgroundColor);
  } catch (e) {}
  // The rest of the desktop's palette: the semantic colours AppKit paints
  // its own windows and controls with, in this appearance. Alpha is kept
  // and composited on the other side, where the ground is known.
  var colors = null;
  try {
    var C = $.NSColor;
    var A = C.controlAccentColor;
    var R = C.systemRedColor;
    var rows = C.alternatingContentBackgroundColors;
    colors = {
      windowBackground: srgb(C.windowBackgroundColor),
      controlBackground: srgb(C.controlBackgroundColor),
      alternateRow: srgb(rows.objectAtIndex(rows.count > 1 ? 1 : 0)),
      label: srgb(C.labelColor),
      secondaryLabel: srgb(C.secondaryLabelColor),
      separator: srgb(C.separatorColor),
      focus: srgb(C.keyboardFocusIndicatorColor),
      unemphasizedSelection: srgb(C.unemphasizedSelectedContentBackgroundColor),
      accentPressed: srgb(A.colorWithSystemEffect($.NSColorSystemEffectPressed)),
      accentDeepPressed: srgb(A.colorWithSystemEffect($.NSColorSystemEffectDeepPressed)),
      textSelection: srgb(C.selectedTextBackgroundColor),
      caret: srgb(C.textInsertionPointColor),
      link: srgb(C.linkColor),
      red: srgb(R),
      redPressed: srgb(R.colorWithSystemEffect($.NSColorSystemEffectPressed)),
      green: srgb(C.systemGreenColor),
      orange: srgb(C.systemOrangeColor),
      blue: srgb(C.systemBlueColor)
    };
  } catch (e) {}
  return JSON.stringify({
    dark: dark,
    accent: accent,
    accentText: accentText,
    selection: selection,
    colors: colors,
    reducedMotion: !!ws.accessibilityDisplayShouldReduceMotion,
    contrast: !!ws.accessibilityDisplayShouldIncreaseContrast
  });
}
console.log(read());
// A change is answered by *leaving*: the parent spawns a fresh process and
// takes its first line. Reading again here would answer the old colours —
// see the comment above the program.
function changed() { $.exit(0); }
var dnc = $.NSDistributedNotificationCenter.defaultCenter;
['AppleInterfaceThemeChangedNotification',
 'AppleColorPreferencesChangedNotification'].forEach(function (name) {
  dnc.addObserverForNameObjectQueueUsingBlock(
    name, $(), $.NSOperationQueue.mainQueue, changed);
});
ws.notificationCenter.addObserverForNameObjectQueueUsingBlock(
  'NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification',
  $(), $.NSOperationQueue.mainQueue, changed);
// An app that dies without its exit handler (a signal, a crash) leaves this
// process behind, reparented to launchd, for as long as the machine is up.
ObjC.import('unistd');
$.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(5, true, function () {
  if ($.getppid() === 1) $.exit(0);
});
$.NSRunLoop.currentRunLoop.run();
`;

/**
 * The tokens a desktop palette names — the colour half of the built-in
 * palette, less the inks `resolveTheme` derives by contrast. Both the cache
 * and the macOS parser take a palette whole or not at all, and this is the
 * list "whole" means.
 */
export const PALETTE_TOKENS = Object.freeze([
  'background',
  'surface',
  'surfaceHover',
  'text',
  'textMuted',
  'border',
  'borderFocus',
  'focusRing',
  'track',
  'accent',
  'accentHover',
  'accentActive',
  'accentText',
  'hoverBackground',
  'hoverText',
  'selection',
  'caret',
  'link',
  'danger',
  'dangerHover',
  'success',
  'warning',
  'info',
]);

/** `[r, g, b]` or `[r, g, b, a]` in [0, 1], or null. */
function channels(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const c = value.slice(0, 4);
  if (c.length === 3) c.push(1);
  return c.every((v) => typeof v === 'number' && v >= 0 && v <= 1) ? c : null;
}

const toHex = (c) =>
  '#' +
  c
    .slice(0, 3)
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

/**
 * AppKit's semantic colours → react-x11's tokens, or null unless every one
 * of them was read.
 *
 * **Alpha is composited here, over the ground it is drawn on.** AppKit's
 * inks are translucent — `labelColor` is black at 85%, `separatorColor` at
 * 10% — and every token in this renderer is a colour, so each is flattened
 * over the window ground. The focus ring is drawn at 50% and gets the same
 * treatment; a ring over a control is a shade off, and no one can see it.
 *
 * The rest is a naming exercise, with two decisions in it. The hover and
 * pressed steps are AppKit's *pressed* and *deep-pressed* effects, because
 * AppKit has no hover state for a filled control and its rollover effect
 * is darker than its pressed one in light mode — a ramp that ran backwards.
 * And `warning` is the system orange, not the yellow: a warning is read as
 * letters too, and yellow on white is not.
 */
export function paletteFromMacOS(colors) {
  if (!colors || typeof colors !== 'object') return null;
  const read = {};
  for (const name of [
    'windowBackground',
    'controlBackground',
    'alternateRow',
    'label',
    'secondaryLabel',
    'separator',
    'focus',
    'unemphasizedSelection',
    'accentPressed',
    'accentDeepPressed',
    'textSelection',
    'caret',
    'link',
    'red',
    'redPressed',
    'green',
    'orange',
    'blue',
  ]) {
    const c = channels(colors[name]);
    if (!c) return null;
    read[name] = c;
  }
  const over = (c, ground) =>
    toHex(ground.map((g, i) => c[i] * c[3] + g * (1 - c[3])));
  const flat = (c) => toHex(c);
  const ground = read.windowBackground;
  const accent = colors.accent && channels(colors.accent);
  const accentText = colors.accentText && channels(colors.accentText);
  const selection = colors.selection && channels(colors.selection);
  if (!accent || !accentText || !selection) return null;
  const ink = flat(accentText);
  const focus = over(read.focus, ground);
  return Object.freeze({
    background: flat(ground),
    surface: flat(read.controlBackground),
    surfaceHover: over(read.alternateRow, read.controlBackground),
    text: over(read.label, ground),
    textMuted: over(read.secondaryLabel, ground),
    border: over(read.separator, ground),
    borderFocus: focus,
    focusRing: focus,
    track: flat(read.unemphasizedSelection),
    accent: flat(accent),
    accentHover: flat(read.accentPressed),
    accentActive: flat(read.accentDeepPressed),
    accentText: ink,
    hoverBackground: flat(selection),
    hoverText: ink,
    selection: flat(read.textSelection),
    caret: flat(read.caret),
    link: flat(read.link),
    danger: flat(read.red),
    dangerHover: flat(read.redPressed),
    success: flat(read.green),
    warning: flat(read.orange),
    info: flat(read.blue),
  });
}

/** One line of the child's output → the values, or null if it is noise. */
export function fromMacOS(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  // The palette's accent family is the three values above it, so the parser
  // sees them together
  const colors = parsed.colors
    ? {
        ...parsed.colors,
        accent: parsed.accent,
        accentText: parsed.accentText,
        selection: parsed.selection,
      }
    : null;
  return {
    // macOS always has a definite appearance, so an unset AppleInterfaceStyle
    // is *light* rather than "no preference".
    colorScheme: parsed.dark ? 'dark' : 'light',
    accent: accentFromPortal(parsed.accent),
    // The same `(r, g, b)` shape as the accent, by construction above
    accentText: accentFromPortal(parsed.accentText),
    selection: accentFromPortal(parsed.selection),
    palette: paletteFromMacOS(colors),
    contrast: parsed.contrast ? 'high' : 'normal',
    reducedMotion: Boolean(parsed.reducedMotion),
  };
}

let child = null;

/** Set while this process is exiting, so a watcher's death is not answered. */
let closing = false;

/**
 * Test seam, not public: what spawns the watcher. A fake here also lets the
 * rung run off a Mac, where the real one cannot, so the respawn is tested on
 * CI rather than on whoever has a Mac.
 */
let spawnWatcher = null;
export function _setMacOSSpawnForTests(fn) {
  spawnWatcher = fn;
}

async function spawnProgram() {
  if (spawnWatcher) return spawnWatcher();
  const { spawn } = await import('node:child_process');
  return spawn('osascript', ['-l', 'JavaScript', '-e', MACOS_PROGRAM], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** How long after an answered exit the next watcher starts. */
const RESPAWN_DELAY_MS = 150;

/**
 * Run one watcher process and resolve on its first usable line — or `false`
 * if it dies, prints nothing usable, or takes more than a few seconds, any of
 * which mean this Mac cannot answer and the ladder is finished.
 *
 * A watcher that exits *after* answering is a different thing: that is how
 * the program says the desktop changed (see `MACOS_PROGRAM`), and the next
 * one is started to read the new values. One that dies before answering is
 * not replaced — that is osascript failing, and a respawn would loop on it.
 *
 * `console.log` in JXA has gone to stderr in some macOS releases and stdout in
 * others, so both are read. It costs one extra listener to not depend on
 * which.
 */
async function runWatcher() {
  let proc;
  try {
    proc = await spawnProgram();
  } catch {
    return false;
  }
  child = proc;
  // Never a reason for the process to stay alive.
  proc.unref?.();
  proc.stdout.unref?.();
  proc.stderr.unref?.();
  proc.on('error', () => {});

  return await new Promise((resolve) => {
    let settled = false;
    let answered = false;
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
        answered = true;
        publish(values, 'macos');
        done(true);
      }
    };
    proc.stdout.setEncoding?.('utf8');
    proc.stderr.setEncoding?.('utf8');
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', () => {
      if (child === proc) child = null;
      // Dying after it answered leaves the last value standing, which is more
      // useful than reverting to the defaults — and, while this rung owns the
      // store, is the cue to read again.
      done(false);
      if (!answered || owner !== 'macos' || closing || child) return;
      const again = setTimeout(() => {
        if (owner === 'macos' && !closing && !child) void runWatcher();
      }, RESPAWN_DELAY_MS);
      again.unref?.();
    });
  });
}

async function macosRung() {
  if ((process.platform !== 'darwin' && !spawnWatcher) || child) return false;
  return runWatcher();
}

// Killed rather than left behind: `unref()` keeps it from holding *this*
// process open, and nothing keeps it from outliving it.
process.on('exit', () => {
  closing = true;
  child?.kill();
});

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
