// XSETTINGS — the desktop's settings channel that predates D-Bus, and the
// only one that exists on a plain X session with no portal running.
//
// A settings daemon owns the `_XSETTINGS_S<screen>` selection and publishes
// everything as one binary property, `_XSETTINGS_SETTINGS`, on its own
// manager window. Clients read that property and watch it for changes. GTK
// has read it since 2.0, Qt reads it, and on a GNOME session it is live even
// under Wayland — gnome-settings-daemon keeps it up to date for Xwayland
// clients, which is how it is reachable from here at all.
//
// ## What it is worth
//
// For **appearance** it is a fallback and a thin one: `Net/ThemeName` is a
// theme *name*, so "is this desktop dark" comes down to reading `Yaru-dark`
// and believing the suffix. That guess is exactly what the settings portal
// was invented to replace, and it is only ever consulted here when the portal
// answered nothing.
//
// For **font rendering** it is the only source there is — `Xft/RGBA`,
// `Xft/HintStyle`, `Xft/DPI`, `Gtk/FontName` have no portal equivalent — so
// this module reads and publishes the whole map rather than the three keys
// the appearance ladder happens to want (#86 is where the rest lands).

import { requireExtension } from './extensions.js';

/** Per-connection sessions, like `compositing.js`. */
const sessions = new WeakMap();

const SETTINGS_PROPERTY = '_XSETTINGS_SETTINGS';
const PROPERTY_NOTIFY = 28;
const PROPERTY_CHANGE_MASK = 4194304; // x11.eventMask.PropertyChange

/** The three value types in the spec; anything else ends the walk. */
const TYPE_INTEGER = 0;
const TYPE_STRING = 1;
const TYPE_COLOR = 2;

/**
 * Decode a `_XSETTINGS_SETTINGS` payload into a `Map` of name → value:
 * a number for integers, a string for strings, and `[r, g, b, a]` of 16-bit
 * channels for colours.
 *
 * ```
 * CARD8  byte-order          0 = LSBFirst, 1 = MSBFirst
 * CARD8  pad[3]
 * CARD32 serial
 * CARD32 n_settings
 *   CARD8  type              per setting
 *   CARD8  pad
 *   CARD16 name-len
 *   STRING8 name             padded to a 4-byte boundary
 *   CARD32 last-change-serial
 *   <value>                  strings padded to 4 as well
 * ```
 *
 * **Two things make a naive reader desynchronise**, and both are silent: the
 * byte-order byte at the front — every multi-byte field after it follows the
 * *daemon's* order, not the platform's — and the padding after each name and
 * each string. Miss either and the walk reads a length out of the middle of a
 * name and produces plausible garbage rather than an error.
 *
 * Never throws. A payload that is truncated or carries a type from a future
 * version stops the walk and returns everything read so far, because a
 * fallback rung that throws is worse than one that answers less.
 */
export function parseXSettings(buffer) {
  const out = new Map();
  if (!buffer || buffer.length < 12) return out;

  const be = buffer[0] === 1;
  const u16 = (o) => (be ? buffer.readUInt16BE(o) : buffer.readUInt16LE(o));
  const u32 = (o) => (be ? buffer.readUInt32BE(o) : buffer.readUInt32LE(o));
  const i32 = (o) => (be ? buffer.readInt32BE(o) : buffer.readInt32LE(o));
  const pad = (o) => o + ((4 - (o % 4)) % 4);

  const count = u32(8);
  let at = 12;

  for (let i = 0; i < count; i++) {
    if (at + 4 > buffer.length) break;
    const type = buffer[at];
    const nameLength = u16(at + 2);
    let p = at + 4;
    if (p + nameLength > buffer.length) break;
    const name = buffer.toString('latin1', p, p + nameLength);
    p = pad(p + nameLength);
    p += 4; // the per-setting last-change serial, which no client needs

    if (type === TYPE_INTEGER) {
      if (p + 4 > buffer.length) break;
      out.set(name, i32(p));
      p += 4;
    } else if (type === TYPE_STRING) {
      if (p + 4 > buffer.length) break;
      const length = u32(p);
      if (p + 4 + length > buffer.length) break;
      out.set(name, buffer.toString('utf8', p + 4, p + 4 + length));
      p = pad(p + 4 + length);
    } else if (type === TYPE_COLOR) {
      if (p + 8 > buffer.length) break;
      out.set(name, [u16(p), u16(p + 2), u16(p + 4), u16(p + 6)]);
      p += 8;
    } else {
      // A type this version does not know. The walk cannot continue past a
      // value whose length it cannot compute, so it stops with what it has.
      break;
    }
    at = p;
  }
  return out;
}

/**
 * What one connection knows. `values` is null until the first read answers —
 * and stays null on a display with no settings daemon, which is the normal
 * state on a bare `startx`, under most window managers, and on XQuartz.
 */
class XSettingsSession {
  constructor(app) {
    this.app = app;
    this.values = null;
    /** Whether the first read has landed — `values` is null both before it
     * and on a display with no daemon, and those are different states. */
    this.answered = false;
    this.owner = 0;
    this.listeners = new Set();
    this.stopped = false;
    this._selectionAtom = 0;
    this._propertyAtom = 0;
  }

  _set(values) {
    this.values = values;
    this.answered = true;
    for (const fn of [...this.listeners]) {
      try {
        fn(values);
      } catch {
        // one subscriber throwing must not take the others with it, nor the
        // X event loop this runs on
      }
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  stop() {
    this.stopped = true;
    this.listeners.clear();
  }
}

/**
 * Start reading XSETTINGS on `app`. Resolves once the first answer is in —
 * a `Map`, or `null` where no daemon owns the selection.
 *
 * Never rejects. A server with no settings manager, an ntk too old to reach
 * the raw connection, and a headless mock all answer `null` and stop there.
 */
export async function beginXSettings(app, screen = 0) {
  let session = sessions.get(app);
  if (session) return session;
  session = new XSettingsSession(app);
  sessions.set(app, session);

  const X = app?.X;
  if (!X || typeof X.GetSelectionOwner !== 'function') {
    session._set(null);
    return session;
  }

  try {
    // Two name lookups that know nothing about each other, so they go out
    // together — the property atom is not read until the owner answers.
    [session._selectionAtom, session._propertyAtom] = await Promise.all([
      internAtom(X, `_XSETTINGS_S${screen}`),
      internAtom(X, SETTINGS_PROPERTY),
    ]);
    await latch(session);
    // Live updates are a bonus: without XFixes the startup answer stands for
    // the life of the connection, which is what every pre-2005 client did —
    // and a bonus does not belong on the chain the first window waits behind.
    void watchOwner(session).catch(() => {});
  } catch {
    if (!session.answered) session._set(null);
  }
  return session;
}

/**
 * Find the manager window, read it, and start watching it.
 *
 * Called again whenever the selection changes hands, which is what happens
 * when the settings daemon is restarted — the old window is destroyed and
 * every property read from it after that answers nothing.
 */
async function latch(session) {
  const X = session.app.X;
  const owner = await selectionOwner(X, session._selectionAtom);
  session.owner = owner;
  if (!owner) {
    session._set(null);
    return;
  }
  // PropertyChange on a window we do not own. Legal and shared — unlike
  // SubstructureRedirect, any number of clients may select it, which is how
  // GTK and Qt watch this same window at the same time.
  X.ChangeWindowAttributes(owner, { eventMask: PROPERTY_CHANGE_MASK }, () => {
    // A BadWindow here means the daemon died between the two calls; the
    // XFixes watch below is what recovers, so there is nothing to do.
  });
  session._set(await readSettings(session));
}

async function readSettings(session) {
  const X = session.app.X;
  const prop = await getProperty(X, session.owner, session._propertyAtom);
  if (!prop || !prop.type || !prop.data?.length) return null;
  return parseXSettings(prop.data);
}

/**
 * Two watches, for the two ways this changes.
 *
 * A **setting** changing rewrites the property on the same window, which is a
 * PropertyNotify. The **daemon** restarting takes the selection to a new
 * window, which is an XFixes SetSelectionOwner.
 *
 * The spec's own answer to the second one is the `MANAGER` ClientMessage on
 * the root window. XFixes is the same information delivered directly — no
 * root-window event mask, no filtering other managers' announcements out of a
 * message that is broadcast for all of them — and `compositing.js` already
 * proves the path on this connection.
 */
async function watchOwner(session) {
  const app = session.app;
  const X = app.X;

  X.on('event', (ev) => {
    if (session.stopped) return;
    if (
      ev.type === PROPERTY_NOTIFY &&
      ev.wid === session.owner &&
      ev.atom === session._propertyAtom
    ) {
      readSettings(session).then(
        (values) => !session.stopped && session._set(values),
        () => {},
      );
    }
  });

  const fixes = await requireExtension(app, 'fixes');
  if (!fixes || session.stopped) return;
  // A 1x1 InputOnly window, never mapped: XFixes addresses notifications to a
  // window and this one exists only to be that address.
  const id = X.AllocID();
  X.CreateWindow(id, app.display.screen[0].root, -10, -10, 1, 1, 0, 0, 2, 0, {
    eventMask: 0,
  });
  X.on('event', (ev) => {
    if (session.stopped) return;
    if (ev.type !== fixes.firstEvent) return;
    if (ev.selection !== session._selectionAtom) return;
    latch(session).catch(() => {});
  });
  fixes.SelectSelectionInput(
    id,
    session._selectionAtom,
    fixes.SelectionEventMask.SetSelectionOwner |
      fixes.SelectionEventMask.SelectionWindowDestroy |
      fixes.SelectionEventMask.SelectionClientClose,
  );
}

function internAtom(X, name) {
  return new Promise((resolve, reject) =>
    X.InternAtom(false, name, (err, atom) =>
      err ? reject(err) : resolve(atom),
    ),
  );
}

function selectionOwner(X, atom) {
  return new Promise((resolve, reject) =>
    X.GetSelectionOwner(atom, (err, owner) =>
      err ? reject(err) : resolve(owner),
    ),
  );
}

function getProperty(X, wid, atom) {
  return new Promise((resolve) =>
    X.GetProperty(0, wid, atom, 0, 0, 0x1fffffff, (err, prop) =>
      resolve(err ? null : prop),
    ),
  );
}

/** The settings this connection last read, or `null`. */
export function xsettings(app) {
  return sessions.get(app)?.values ?? null;
}

/** Subscribe to the settings changing. Returns an unsubscribe function. */
export function watchXSettings(app, fn) {
  const session = sessions.get(app);
  if (!session) return () => {};
  return session.subscribe(fn);
}

/** Tear down with the root that started it. */
export function endXSettings(app) {
  const session = sessions.get(app);
  if (!session) return;
  session.stop();
  sessions.delete(app);
}

/**
 * Test seam: publish settings without an X server, the way
 * `setCompositingForTests` does. Also what a headless mock uses to model a
 * display with or without a settings daemon.
 */
export function setXSettingsForTests(app, values) {
  let session = sessions.get(app);
  if (!session) {
    session = new XSettingsSession(app);
    sessions.set(app, session);
  }
  session._set(values);
  return session;
}
