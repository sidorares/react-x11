// The desktop's interaction settings: how fast a caret blinks, how long a
// double click has, how far a press has to move before it is a drag, and
// whether it wants animation at all.
//
// These were four constants in this codebase — `CARET_BLINK_MS` in nodes.js,
// `DRAG_THRESHOLD` in dnd.js, and the 400ms/4px pair inside
// `EventManager._clickDetail` — every one of them a guess at a number the
// desktop already publishes and every other toolkit already reads.
//
// ## Why this is not part of the appearance ladder
//
// `appearance.js` climbs three sources for colour scheme and accent, because
// those are answered by three different things and the portal is the modern
// one. Nothing here has a *standard* portal equivalent:
// `org.freedesktop.appearance` has four keys and none of them is a timing.
// On X11, XSETTINGS is the whole story, and where there is no settings
// daemon — a bare `startx`, most window managers, XQuartz — the defaults
// below stand.
//
// So on X11 this reads the map `xsettings.js` already maintains, rather than
// standing up a source of its own. There are two exceptions, one per backend
// that has no X server to ask:
//
// - **macOS** answers exactly one of these — "reduce motion", through
//   `NSWorkspace` — so the Cocoa app exposes that behind a two-method seam
//   (`accessibilityDisplayOptions`, `watchAccessibilityDisplay`) and this
//   module reads it the way it reads the map: synchronously, cached, live.
//
// - **The Wayland backend** has no XSETTINGS either, but the settings portal
//   is not limited to `org.freedesktop.appearance`: the GNOME and GTK portal
//   backends pass whole GSettings schemas through it, and
//   `org.gnome.desktop.interface` and `org.gnome.desktop.peripherals.mouse`
//   are exactly what gsd-xsettings translates into the XSETTINGS keys this
//   reads on X11. Same numbers, one hop closer to the source. Read once at
//   startup and again on `SettingChanged`; a desktop whose portal does not
//   carry them (KDE, a bare compositor) keeps the defaults, as a bare
//   `startx` does.
//
// ## Two of these are read synchronously, which is what shapes the module
//
// A caret arms its blink inside `defaultFocus()` and a drag decides it has
// started inside a mousemove. Neither has a round trip available, so
// `desktopSettings(app)` is a synchronous read of an already-populated map
// and `createRoot()` starts XSETTINGS **without awaiting it** — the settings
// land in a few milliseconds and the first interaction is much later than
// that. A field focused on the very first frame gets the defaults and the
// desktop's cadence from the next focus onward; that is the one seam, and it
// is worth more than the round trips on every app's startup path.

import { sessionBus } from './bus.js';
import { desktopIntegrationEnabled } from './desktopintegration.js';
import { PORTAL_NAME, PORTAL_PATH } from './portal.js';
import { beginXSettings, watchXSettings, xsettings } from './xsettings.js';

const SETTINGS_IFACE = 'org.freedesktop.portal.Settings';
const INTERFACE_NS = 'org.gnome.desktop.interface';
const MOUSE_NS = 'org.gnome.desktop.peripherals.mouse';

/** The keys a `SettingChanged` has to name for a re-read to be worth it —
 *  `org.gnome.desktop.interface` also carries the clock format, the font
 *  and the icon theme, and none of those is a reason to re-render. */
const WATCHED = new Set([
  `${INTERFACE_NS}/cursor-blink`,
  `${INTERFACE_NS}/cursor-blink-time`,
  `${INTERFACE_NS}/enable-animations`,
  `${MOUSE_NS}/double-click`,
  `${MOUSE_NS}/drag-threshold`,
]);

/**
 * What is true with no settings daemon to ask.
 *
 * These are **this renderer's existing constants**, not GTK's defaults. The
 * two disagree — GTK blinks on a 1200ms cycle and drags at 8px, against 1060
 * and 4 here — and changing what an app does on a desktop that never
 * expressed a preference is a different decision from honouring one that
 * did. This module only does the second.
 */
export const DEFAULTS = Object.freeze({
  caretBlink: true,
  // GTK, Qt and Windows all land within a few tens of milliseconds of this,
  // and a blink out of step with the rest of the desktop is noticed even
  // when the number cannot be named. Re-exported as `CARET_BLINK_MS` from
  // `react-x11/node`, so an element drawing its own caret has one number to
  // agree with rather than two.
  caretBlinkMs: 530,
  doubleClickMs: 400,
  doubleClickDistance: 4,
  // A press is a click until it moves this far. GTK's is 8; this is the
  // DOM's, which is what the drag machinery here was built against.
  dragThreshold: 4,
  // Whether the desktop wants things to move. On by default because that is
  // what the desktops that never say anything mean, and because the setting
  // exists to be turned *off* — nobody enables animation, they disable it.
  animations: true,
  source: null,
});

const sessions = new WeakMap();

/** A positive integer from the map, or undefined — a settings daemon can
 *  export a key with a string value or a nonsense one, and a caret with a
 *  blink period of `'fast'` would never come back on. */
function positive(map, key) {
  return positiveValue(map?.get(key));
}

function positiveValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * macOS's accessibility display options → the settings. Only `animations`
 * comes from the system there: it is the one of these macOS publishes at all
 * (System Settings › Accessibility › Display › Reduce motion, which the
 * bridge reads from `NSWorkspace`), and the rest keep this renderer's
 * defaults rather than being guessed from something that is not them. Pure,
 * and exported for the test.
 */
export function fromMacOS(options) {
  return Object.freeze({
    ...DEFAULTS,
    animations: options?.reduceMotion !== true,
    source: 'macos',
  });
}

/**
 * An XSETTINGS map → the settings. Pure, and exported for the test: the
 * in-process X server has no settings daemon, so this is the part of the
 * path worth pinning without one.
 *
 * **`Net/CursorBlinkTime` is a full cycle**, on and off together — that is
 * what GTK means by `gtk-cursor-blink-time` and what every daemon writes —
 * and `caretBlinkMs` is how long the caret stays in *each* state, because
 * that is the number that goes into a timer. Halving it is the whole
 * conversion, and forgetting to is a caret that blinks at half speed and
 * looks broken rather than wrong.
 */
export function fromXSettings(map) {
  if (!map) return DEFAULTS;
  const cycle = positive(map, 'Net/CursorBlinkTime');
  const blink = map.get('Net/CursorBlink');
  return Object.freeze({
    // 0 is "do not blink at all", which is an accessibility setting rather
    // than a preference: a moving thing on screen is what some people cannot
    // read past. A caret that ignores it is the bug this module was written
    // for. Only an explicit 0 turns it off — an absent key is not an answer.
    caretBlink: blink !== 0,
    caretBlinkMs: cycle
      ? Math.max(1, Math.round(cycle / 2))
      : DEFAULTS.caretBlinkMs,
    doubleClickMs:
      positive(map, 'Net/DoubleClickTime') ?? DEFAULTS.doubleClickMs,
    doubleClickDistance:
      positive(map, 'Net/DoubleClickDistance') ?? DEFAULTS.doubleClickDistance,
    dragThreshold:
      positive(map, 'Net/DndDragThreshold') ?? DEFAULTS.dragThreshold,
    // `Gtk/EnableAnimations` is GTK's `gtk-enable-animations`, which every
    // GNOME and Xfce session writes and which "reduce motion" in the
    // accessibility panel turns off. Like the blink above, only an explicit
    // 0 is an answer: a desktop that never exported the key has not asked
    // for stillness, it has said nothing.
    animations: map.get('Gtk/EnableAnimations') !== 0,
    source: 'xsettings',
  });
}

/**
 * The settings portal's GNOME namespaces → the settings. Pure, and exported
 * for the test. `all` is a `ReadAll` reply, namespace → key → value.
 *
 * The same keys gsd-xsettings turns into the XSETTINGS ones above, so the
 * same rules: `cursor-blink-time` is a full cycle and is halved, only an
 * explicit `false` turns blinking or animation off, and a value of the wrong
 * type is no answer. GNOME has no double-click *distance*; GTK's is a
 * constant there, so the default stands.
 *
 * `null` when neither namespace came back — a portal that does not pass
 * GSettings through has not answered, and the source stays null.
 */
export function fromGnomePortal(all) {
  const iface = all?.[INTERFACE_NS];
  const mouse = all?.[MOUSE_NS];
  if (!iface && !mouse) return null;
  const cycle = positiveValue(iface?.['cursor-blink-time']);
  return Object.freeze({
    ...DEFAULTS,
    caretBlink: iface?.['cursor-blink'] !== false,
    caretBlinkMs: cycle
      ? Math.max(1, Math.round(cycle / 2))
      : DEFAULTS.caretBlinkMs,
    doubleClickMs:
      positiveValue(mouse?.['double-click']) ?? DEFAULTS.doubleClickMs,
    dragThreshold:
      positiveValue(mouse?.['drag-threshold']) ?? DEFAULTS.dragThreshold,
    animations: iface?.['enable-animations'] !== false,
    source: 'portal',
  });
}

/**
 * The settings for a connection, **synchronously**. Always a complete answer:
 * the defaults before the daemon has been read, and on a display with none.
 *
 * Cached rather than derived per call, because `useDesktopSettings()` reads
 * it through `useSyncExternalStore` and because the drag path calls it on
 * every mousemove.
 */
export function desktopSettings(app) {
  const session = sessions.get(app);
  if (!session) return DEFAULTS;
  if (!session.snapshot) {
    session.snapshot = session.macos
      ? fromMacOS(app.accessibilityDisplayOptions())
      : session.wayland
        ? (fromGnomePortal(session.portal) ?? DEFAULTS)
        : fromXSettings(xsettings(app));
  }
  return session.snapshot;
}

/**
 * Start reading the settings on `app`.
 *
 * Deliberately **not** awaited by `createRoot()` — see the note at the top of
 * the file. Never rejects.
 */
export function beginDesktopSettings(app) {
  if (sessions.has(app)) return;
  const session = { snapshot: null, listeners: new Set(), stop: null };
  sessions.set(app, session);
  // The Cocoa app: the answer is synchronous from the start, and the change
  // arrives as a backend event rather than a property on a selection owner.
  if (typeof app?.accessibilityDisplayOptions === 'function') {
    session.macos = true;
    session.stop = app.watchAccessibilityDisplay?.(() => {
      session.snapshot = null;
      notify(session);
    });
    return;
  }
  // The Wayland backend: no X server, so no XSETTINGS — the portal instead,
  // behind the same switch as the appearance ladder that reads the portal
  // too. `createRoot({ desktop: false })` keeps the defaults, which is what a
  // test or an embedder that asked for determinism wants.
  if (app?.backend === 'wayland') {
    session.wayland = true;
    if (desktopIntegrationEnabled('appearance')) {
      portalSettings(app, session).catch(() => {
        // no bus, no portal, a portal without the GNOME namespaces: the
        // defaults stand, which is what they are for
      });
    }
    return;
  }
  beginXSettings(app).then(
    () => {
      if (!sessions.has(app)) return;
      session.snapshot = null;
      notify(session);
      session.stop = watchXSettings(app, () => {
        session.snapshot = null;
        notify(session);
      });
    },
    () => {
      // no daemon, no raw connection, a headless mock: the defaults stand,
      // which is what they are for
    },
  );
}

/**
 * Read the GNOME namespaces off the settings portal, and again whenever one
 * of the keys this cares about changes.
 *
 * The order is `appearance.js`'s portal rung, for the same reasons: the
 * match rule and the handler go in **before** the first read, so a change
 * that lands while it is in flight is not lost; and reads are sequenced, so
 * a slow reply never publishes over a newer one. The bus ref is released as
 * soon as the first read settles — the subscription outlives it, and holding
 * it would keep the process alive for as long as the app cared how fast its
 * caret blinks.
 */
async function portalSettings(app, session) {
  const ref = await sessionBus();
  if (!ref) return;
  const { bus } = ref;
  let sub = null;
  let handler = null;
  const key = bus.mangle(PORTAL_PATH, SETTINGS_IFACE, 'SettingChanged');
  const stop = () => {
    if (handler) bus.signals.removeListener(key, handler);
    handler = null;
    sub?.remove().catch(() => {});
    sub = null;
  };
  try {
    sub = await bus.watch(
      `type='signal',sender='${PORTAL_NAME}',` +
        `interface='${SETTINGS_IFACE}',member='SettingChanged'`,
    );

    let started = 0;
    let published = 0;
    const refresh = async () => {
      const mine = ++started;
      const all = await bus.invoke(
        {
          destination: PORTAL_NAME,
          path: PORTAL_PATH,
          interface: SETTINGS_IFACE,
          member: 'ReadAll',
          signature: 'as',
          body: [[INTERFACE_NS, MOUSE_NS]],
        },
        { timeout: 5_000 },
      );
      if (mine <= published || sessions.get(app) !== session) return;
      published = mine;
      const next = fromGnomePortal(all);
      if (!next) return;
      const before = desktopSettings(app);
      session.portal = all;
      session.snapshot = null;
      // A re-read that changed nothing this reads notifies nobody: the hook
      // re-renders on identity, and so would every subscriber.
      if (!sameSettings(before, desktopSettings(app))) notify(session);
      else session.snapshot = before;
    };

    handler = ([namespace, name]) => {
      if (!WATCHED.has(`${namespace}/${name}`)) return;
      refresh().catch(() => {
        // the portal went away mid-session; the last answer stands
      });
    };
    bus.signals.on(key, handler);

    // Torn down while the bus was connecting: undo, and publish nothing.
    if (sessions.get(app) !== session) return stop();
    session.stop = stop;
    await refresh();
  } catch (err) {
    stop();
    throw err;
  } finally {
    await ref.release();
  }
}

function sameSettings(a, b) {
  for (const key of Object.keys(DEFAULTS)) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function notify(session) {
  for (const fn of [...session.listeners]) {
    try {
      fn();
    } catch {
      // one subscriber throwing must not take the others with it
    }
  }
}

/** Subscribe to the settings changing. Not public — `useDesktopSettings()` is. */
export function watchDesktopSettings(app, fn) {
  let session = sessions.get(app);
  if (!session) {
    beginDesktopSettings(app);
    session = sessions.get(app);
  }
  if (!session) return () => {};
  session.listeners.add(fn);
  return () => session.listeners.delete(fn);
}

/** Tear down with the root that started it. */
export function endDesktopSettings(app) {
  const session = sessions.get(app);
  if (!session) return;
  session.stop?.();
  session.listeners.clear();
  sessions.delete(app);
}

/**
 * Test seam: state the settings without a settings daemon. Takes the same
 * shape the hook returns; anything left out keeps its default.
 */
export function setDesktopSettingsForTests(app, values) {
  let session = sessions.get(app);
  if (!session) {
    session = { snapshot: null, listeners: new Set(), stop: null };
    sessions.set(app, session);
  }
  session.snapshot = Object.freeze({
    ...DEFAULTS,
    ...values,
    source: values ? 'test' : null,
  });
  notify(session);
  return session.snapshot;
}
