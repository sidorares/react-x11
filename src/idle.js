// Whether the user is still there, and how to tell the desktop not to blank
// the screen while something is playing.
//
// ## Idle: alarms, not polling
//
// X has a counter for this — `IDLETIME`, a SYNC system counter carrying
// milliseconds since the last input on any device — and SYNC *alarms* fire an
// event when a counter crosses a value. So "tell me when the user has been
// idle for five minutes" is one alarm and no timer at all, which is what
// every idle daemon on the desktop (xss-lock, KDE's, GNOME's) is built on.
//
// The idiom is a flip-flop, and it is the whole mechanism:
//
//   idle    ← alarm on IDLETIME >= timeout   (PositiveComparison)
//   active  ← alarm on IDLETIME <= timeout   (NegativeComparison)
//
// One fires, the state flips, and the alarm is changed to watch for the
// crossing back. Nothing runs in between — no interval, nothing waking the
// process up to ask a question whose answer is usually "no".
//
// **`delta` must be sent as 0.** It defaults to 1, and the protocol rejects a
// positive delta on a negative test with a Match error, so the half of the
// flip-flop that waits for the user to come back would fail — and fail
// silently, since a void request's error goes to the connection's error hook
// rather than to a callback.
//
// Where there is no `IDLETIME` counter the fallback is MIT-SCREEN-SAVER's
// `QueryInfo`, which answers the same number for one round trip but has no
// event behind it, so that rung polls. It schedules against the answer rather
// than on a fixed tick — with 12 seconds elapsed of a 300-second timeout the
// next check is 288 seconds away — so an active user costs one round trip per
// timeout period.
//
// ## Inhibition: three rungs that agree on what they do
//
// All three keep the **screen** awake and none of them stops a suspend. That
// is not a simplification, it is the intersection: `ScreenSaverSuspend` is
// an X request about blanking, `org.freedesktop.ScreenSaver` is the pre-portal
// desktop interface for the same thing, and only the portal can also inhibit
// logout and suspend. Exposing a `mode` that works on one rung out of three
// would be a seam that mostly does not.

import { sessionBus } from './bus.js';
import { PORTAL_NAME, PORTAL_PATH } from './portal.js';

const IDLETIME = 'IDLETIME';
const SCREENSAVER_NAME = 'org.freedesktop.ScreenSaver';
const SCREENSAVER_PATH = '/org/freedesktop/ScreenSaver';
const INHIBIT_IFACE = 'org.freedesktop.portal.Inhibit';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';
/** `org.freedesktop.portal.Inhibit`'s flag for "do not let the session idle". */
const INHIBIT_IDLE = 8;

const sessions = new WeakMap();

// --------------------------------------------------------------------------
// Idle
// --------------------------------------------------------------------------

/**
 * One connection's idle machinery: the extensions it resolved once, and a
 * watcher per distinct timeout. Two components asking for the same timeout
 * share an alarm; asking for two different ones costs two.
 */
class IdleSession {
  constructor(app) {
    this.app = app;
    this.watchers = new Map();
    this.stopped = false;
    this._sync = undefined;
    this._saver = undefined;
    this._counter = undefined;
    this._handler = null;
  }

  stop() {
    this.stopped = true;
    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
    if (this._handler && this.app?.X?.off) {
      try {
        this.app.X.off('event', this._handler);
      } catch {
        // an ntk old enough to hand back a client with no `off`
      }
    }
    this._handler = null;
  }

  /** The SYNC extension, resolved once per connection. */
  sync() {
    if (this._sync === undefined) this._sync = requireExt(this.app, 'sync');
    return this._sync;
  }

  /** MIT-SCREEN-SAVER, likewise. */
  saver() {
    if (this._saver === undefined) {
      this._saver = requireExt(this.app, 'screen-saver');
    }
    return this._saver;
  }

  /**
   * The `IDLETIME` counter's id, or null where the server has no such
   * counter — which is every server without the XInput-driven idle tracking
   * Xorg has, XQuartz among them.
   */
  counter() {
    if (this._counter !== undefined) return this._counter;
    this._counter = this.sync().then((sync) => {
      if (!sync?.ListSystemCounters) return null;
      return new Promise((resolve) => {
        try {
          sync.ListSystemCounters((err, counters) => {
            if (err || !counters) return resolve(null);
            resolve(counters.find((c) => c.name === IDLETIME)?.counter ?? null);
          });
        } catch {
          resolve(null);
        }
      });
    });
    return this._counter;
  }

  /** One `event` listener for every alarm, installed once. */
  listen(fn) {
    if (this._handler) return;
    const X = this.app?.X;
    if (!X?.on) return;
    this._handler = fn;
    X.on('event', fn);
  }
}

class IdleWatcher {
  constructor(session, timeout) {
    this.session = session;
    this.timeout = timeout;
    this.idle = false;
    this.listeners = new Set();
    this.stopped = false;
    this.alarm = 0;
    this._sync = null;
    this._timer = null;
  }

  set(idle) {
    if (this.stopped || this.idle === idle) return;
    this.idle = idle;
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // one subscriber throwing must not take the others with it, nor the
        // X event loop this runs on
      }
    }
  }

  stop() {
    this.stopped = true;
    this.listeners.clear();
    clearTimeout(this._timer);
    this._timer = null;
    if (this.alarm) {
      try {
        this._sync?.DestroyAlarm(this.alarm);
      } catch {
        // the connection is going away with it
      }
      this.alarm = 0;
    }
  }
}

/**
 * Arm a watcher: SYNC alarms where the counter exists, polling where it does
 * not, and nothing at all where neither extension is present — on which the
 * watcher reports "not idle" for good, which is the honest answer for a
 * display that cannot be asked.
 */
async function armIdle(watcher) {
  const session = watcher.session;
  const counter = await session.counter();
  if (watcher.stopped) return;

  if (counter) {
    const sync = await session.sync();
    if (watcher.stopped || !sync) return;
    watcher._sync = sync;
    const X = session.app.X;
    watcher.alarm = X.AllocID();

    session.listen((ev) => {
      if (session.stopped) return;
      if (ev.type !== sync.firstEvent + sync.events.AlarmNotify) return;
      for (const w of session.watchers.values()) {
        if (w.alarm !== ev.alarm || w.stopped) continue;
        // The counter value the alarm fired at says which way it crossed,
        // rather than trusting the flip-flop's own idea of where it was: an
        // alarm changed twice in a frame can deliver events out of order.
        const idle = ev.counterValue >= w.timeout;
        w.set(idle);
        retest(sync, w, idle);
      }
    });

    try {
      sync.CreateAlarm(watcher.alarm, {
        counter,
        valueType: sync.ValueType.Absolute,
        value: watcher.timeout,
        testType: sync.TestType.PositiveComparison,
        delta: 0,
        events: 1,
      });
    } catch {
      watcher.alarm = 0;
    }
    return;
  }

  // No counter: poll MIT-SCREEN-SAVER instead.
  const saver = await session.saver();
  if (watcher.stopped || !saver?.QueryInfo) return;
  poll(watcher, saver);
}

/** Flip the alarm over to watch for the crossing back. */
function retest(sync, watcher, idle) {
  if (!watcher.alarm) return;
  try {
    sync.ChangeAlarm(watcher.alarm, {
      valueType: sync.ValueType.Absolute,
      value: watcher.timeout,
      testType: idle
        ? sync.TestType.NegativeComparison
        : sync.TestType.PositiveComparison,
      delta: 0,
      events: 1,
    });
  } catch {
    // the connection went away; nothing further will arrive either way
  }
}

/**
 * The fallback rung. Sleeps for exactly as long as the answer says it can:
 * an idle time of 12s against a 300s timeout cannot become idle for another
 * 288s, so that is when to look again.
 *
 * Once idle, there is nothing to compute a wait from — the counter only goes
 * up until input resets it, and no input reaches this process when the user
 * is typing in another window. So that direction polls on an interval scaled
 * to the timeout, floored at a second and capped at half a minute: a
 * five-minute away marker clears within 30s of the user coming back, and a
 * ten-second one clears within a second.
 */
function poll(watcher, saver) {
  if (watcher.stopped) return;
  const root = watcher.session.app.X.display?.screen?.[0]?.root;
  if (root == null) return;
  saver.QueryInfo(root, (err, info) => {
    if (watcher.stopped) return;
    if (err || !info) return schedule(watcher, saver, watcher.timeout);
    const elapsed = info.idle ?? 0;
    const idle = elapsed >= watcher.timeout;
    watcher.set(idle);
    schedule(
      watcher,
      saver,
      idle
        ? Math.min(30_000, Math.max(1_000, watcher.timeout / 4))
        : Math.max(250, watcher.timeout - elapsed),
    );
  });
}

function schedule(watcher, saver, delay) {
  clearTimeout(watcher._timer);
  watcher._timer = setTimeout(() => poll(watcher, saver), delay);
  // Never a reason for this to keep the process alive: an app whose windows
  // have closed does not care whether anyone is at the keyboard.
  watcher._timer.unref?.();
}

/** Whether this timeout is currently elapsed. Not public — `useIdle()` is. */
export function idleSnapshot(app, timeout) {
  return sessions.get(app)?.watchers.get(timeout)?.idle ?? false;
}

/** Subscribe to a timeout elapsing and un-elapsing. */
export function watchIdle(app, timeout, onChange) {
  if (!app || !(timeout > 0)) return () => {};
  let session = sessions.get(app);
  if (!session) {
    session = new IdleSession(app);
    sessions.set(app, session);
  }
  let watcher = session.watchers.get(timeout);
  if (!watcher) {
    watcher = new IdleWatcher(session, timeout);
    session.watchers.set(timeout, watcher);
    armIdle(watcher).catch(() => {
      // an extension that is not there is not an error, it is a rung
    });
  }
  watcher.listeners.add(onChange);
  return () => watcher.listeners.delete(onChange);
}

/** Tear down with the root that started it. */
export function endIdle(app) {
  const session = sessions.get(app);
  if (!session) return;
  session.stop();
  sessions.delete(app);
}

/**
 * Test seam: state that a timeout has or has not elapsed, without a server
 * that has SYNC. The watcher it creates is inert — nothing arms it — so a
 * test drives the value itself.
 */
export function setIdleForTests(app, timeout, idle) {
  let session = sessions.get(app);
  if (!session) {
    session = new IdleSession(app);
    sessions.set(app, session);
  }
  let watcher = session.watchers.get(timeout);
  if (!watcher) {
    watcher = new IdleWatcher(session, timeout);
    session.watchers.set(timeout, watcher);
  }
  watcher.set(idle);
  return watcher;
}

// --------------------------------------------------------------------------
// Inhibition
// --------------------------------------------------------------------------

/**
 * Ask the desktop not to blank the screen, and get back the release.
 *
 * ```js
 * const release = await keepAwake({ reason: 'Playing a video', app });
 * // …later
 * release();
 * ```
 *
 * Never rejects and never throws: a desktop with no portal, no screensaver
 * service and no MIT-SCREEN-SAVER hands back a release that does nothing,
 * because "could not ask" and "asked and it was ignored" are the same outcome
 * for the caller and neither is worth an error path in a video player.
 *
 * `useKeepAwake()` is the shape a component wants; this is for imperative
 * code and for tests.
 */
export async function keepAwake({ reason = 'Busy', app = null } = {}) {
  for (const rung of [portalInhibit, screenSaverInhibit, xInhibit]) {
    try {
      const release = await rung(reason, app);
      if (release) return once(release);
    } catch {
      // the next rung down
    }
  }
  return () => {};
}

/** A release that runs once however many times it is called — a double
 *  release would drop somebody else's inhibition on the counted X rung. */
function once(fn) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    try {
      fn();
    } catch {
      // releasing something already gone is the outcome we wanted
    }
  };
}

/**
 * Rung 1: `org.freedesktop.portal.Inhibit`.
 *
 * Not `portalRequest()`, though it is Request-shaped: this call's `Response`
 * fires when the inhibition *ends*, so a helper that awaits one would hang
 * for exactly as long as the feature is working. What is wanted is the
 * handle, to `Close()` later.
 */
async function portalInhibit(reason, app) {
  void app;
  const ref = await sessionBus();
  if (!ref) return null;
  try {
    const path = await ref.bus.invoke(
      {
        destination: PORTAL_NAME,
        path: PORTAL_PATH,
        interface: INHIBIT_IFACE,
        member: 'Inhibit',
        signature: 'sua{sv}',
        // No parent window: an inhibition is not modal to anything, and the
        // portal only uses the handle to place a dialog it does not show here.
        body: ['', INHIBIT_IDLE, [['reason', ['s', reason]]]],
      },
      { timeout: 5_000 },
    );
    if (!path) return null;
    return () => {
      ref.bus
        .invoke({
          destination: PORTAL_NAME,
          path,
          interface: REQUEST_IFACE,
          member: 'Close',
          signature: '',
          body: [],
        })
        .catch(() => {});
    };
  } finally {
    // The inhibition belongs to the connection, not to this reference, and
    // the connection stays open — holding a ref would keep the socket
    // `ref()`d and the process alive for as long as a video was playing,
    // which the window on screen is already doing.
    await ref.release();
  }
}

/** Rung 2: the pre-portal desktop interface, which KDE, Xfce, MATE and
 *  every screensaver of that era implement. */
async function screenSaverInhibit(reason, app) {
  void app;
  const ref = await sessionBus();
  if (!ref) return null;
  try {
    const cookie = await ref.bus.invoke(
      {
        destination: SCREENSAVER_NAME,
        path: SCREENSAVER_PATH,
        interface: SCREENSAVER_NAME,
        member: 'Inhibit',
        signature: 'ss',
        body: [process.title || 'react-x11', reason],
      },
      { timeout: 5_000 },
    );
    if (typeof cookie !== 'number') return null;
    return () => {
      ref.bus
        .invoke({
          destination: SCREENSAVER_NAME,
          path: SCREENSAVER_PATH,
          interface: SCREENSAVER_NAME,
          member: 'UnInhibit',
          signature: 'u',
          body: [cookie],
        })
        .catch(() => {});
    };
  } finally {
    await ref.release();
  }
}

/**
 * Rung 3: `ScreenSaverSuspend`, which needs no bus at all — the reason this
 * ladder has a floor on a bare `startx` with no session services running.
 *
 * The server counts suspensions per client, so every `Suspend(true)` owes a
 * `Suspend(false)`; `once()` above is what guarantees the pairing.
 */
async function xInhibit(reason, app) {
  void reason;
  const saver = app ? await requireExt(app, 'screen-saver') : null;
  if (!saver?.Suspend) return null;
  saver.Suspend(true);
  return () => saver.Suspend(false);
}

/** An extension, or null where the server does not have it. */
function requireExt(app, name) {
  return new Promise((resolve) => {
    try {
      app.X.require(name, (err, ext) => resolve(err || !ext ? null : ext));
    } catch {
      resolve(null);
    }
  });
}
