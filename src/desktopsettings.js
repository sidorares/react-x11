// The desktop's interaction settings: how fast a caret blinks, how long a
// double click has, how far a press has to move before it is a drag.
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
// one. Nothing here has a portal equivalent: `org.freedesktop.appearance` has
// four keys and none of them is a timing. XSETTINGS is the whole story, and
// where there is no settings daemon — a bare `startx`, most window managers,
// XQuartz — the defaults below stand.
//
// So this reads the map `xsettings.js` already maintains, rather than
// standing up a source of its own.
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

import { beginXSettings, watchXSettings, xsettings } from './xsettings.js';

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
  source: null,
});

const sessions = new WeakMap();

/** A positive integer from the map, or undefined — a settings daemon can
 *  export a key with a string value or a nonsense one, and a caret with a
 *  blink period of `'fast'` would never come back on. */
function positive(map, key) {
  const value = map?.get(key);
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
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
    source: 'xsettings',
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
    session.snapshot = fromXSettings(xsettings(app));
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
