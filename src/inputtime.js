// The server timestamp of the last X input event, per app — and a way to ask
// the server for a fresh one when there has not been an input to name.
//
// X arbitrates between clients by timestamp, and every selection operation
// wants one: taking a selection (ICCCM 2.1), converting one (ICCCM 2.4) and
// giving one back (ICCCM 2.3.1) all say to use "the timestamp of the event
// that caused this" and not CurrentTime. The only place that value exists is
// the X event being dispatched, which is nowhere near the code that copies —
// `_copySelection` is four frames down from the keystroke that triggered it.
//
// So it is stashed on the way past, the same trick GTK plays with
// `gtk_get_current_event_time()`. Without it ntk asks the server for a
// timestamp on every acquisition, which is a round trip per copy — and
// select-to-own PRIMARY copies on every selection-extending keystroke.
//
// Keyed on the app rather than stored on it: one process can drive several
// roots on several connections, and a timestamp is only meaningful against
// the server clock that issued it.
//
// ## Why both halves are public
//
// react-x11 owns the clipboard, so for a long time nothing outside this file
// needed either. An application that owns a selection of its own does — a
// system tray takes `_NET_SYSTEM_TRAY_S<screen>`, a clipboard manager takes
// `CLIPBOARD_MANAGER`, an input method takes `XIM_SERVERS` — and the choice
// it faces is exactly the one the two exports name:
//
//   - There **was** a user action behind this, and ICCCM wants that event's
//     own time: `lastInputTime(app)`, free, already stashed.
//   - There was **not** — a tray acquires its selection when it starts, not
//     because anyone clicked — so there is no causing event and any current
//     server time is correct: `await serverTime(app)`, one round trip.
//
// Both beat `CurrentTime`, which is the failure this exists to prevent: the
// server takes it, two clients racing for one selection cannot be ordered by
// it, and the loser is never told it lost.

const lastInput = new WeakMap();

// Motion is deliberately not tracked. Nothing converts or acquires a
// selection from a motion event — a drag-select owns PRIMARY on the mouseup
// that ends it, and a drag publishes on the mousedown that began it — so
// tracking motion would add a write per motion event to buy nothing.
const TRACKED = new Set(['mousedown', 'mouseup', 'keydown', 'keyup']);

/** Remember the server time an input event carried, if it carried one. */
export function noteInputTime(app, name, native) {
  if (!app || !TRACKED.has(name)) return;
  const time = native?.time;
  if (typeof time === 'number') lastInput.set(app, time >>> 0);
}

/**
 * The last input timestamp seen on this app's connection, or `undefined`
 * when no input has arrived yet.
 *
 * ```jsx
 * const app = useApp();
 * // acquiring PRIMARY because the user just selected something
 * app.X.SetSelectionOwner(wid, atom, lastInputTime(app));
 * ```
 *
 * This is EWMH's own definition of `_NET_WM_USER_TIME` and ICCCM's "the
 * timestamp of the event that caused this", so it is the right value for
 * anything happening *because the user did something* — which includes every
 * selection a keystroke or a click acquires, and the `_NET_ACTIVE_WINDOW`
 * request behind {@link activateWindow}.
 *
 * `undefined` is passed straight through to ntk rather than replaced with a
 * zero: ntk's `write()` turns it into a real server timestamp, and
 * CurrentTime is what ICCCM 2.1 forbids. Elsewhere `undefined` means there
 * is no user action to name and {@link serverTime} is the answer — a caller
 * who reaches for `?? 0` has written CurrentTime back in.
 */
export function lastInputTime(app) {
  return app ? lastInput.get(app) : undefined;
}

/** ms before `serverTime()` gives up on the round trip. */
const TIMEOUT = 5000;

/** x11.eventMask.PropertyChange, and PropertyNotify's event code. */
const PROPERTY_CHANGE_MASK = 4194304;
const PROPERTY_NOTIFY = 28;

/** ChangeProperty's Append mode, and PropertyNotify's NewValue state. */
const APPEND = 2;
const NEW_VALUE = 0;

const TIME_PROPERTY = '_REACT_X11_TIMESTAMP';

/** The 1x1 window and property atom each connection derives times through. */
const timeSources = new WeakMap();

/**
 * A current timestamp from this connection's server.
 *
 * ```jsx
 * // a tray taking its manager selection at startup: nothing the user did
 * // caused this, so there is no event time to use
 * app.X.SetSelectionOwner(manager, selection, await serverTime(app));
 * ```
 *
 * There is no request that just asks for the time, so this is the trick every
 * X client uses instead: append zero bytes to a property on a window we own
 * and watch, and read the time off the `PropertyNotify` that generates. One
 * round trip, no visible side effect — the window is 1x1, never mapped, and
 * created once per connection.
 *
 * Prefer {@link lastInputTime} where a user action caused the operation: it
 * is free, and ICCCM asks for the causing event's time specifically. Reach
 * for this where nothing did, and where a stale value would be wrong anyway —
 * `SetSelectionOwner` is refused outright if the timestamp predates the
 * current owner's acquisition, so "the last thing the user touched, an hour
 * ago" is not a safe substitute for "now".
 *
 * Resolves `0` — CurrentTime — if the server has not answered within five
 * seconds, or if this app has no connection to ask. Never rejects and never
 * hangs: a caller stuck waiting for a timestamp is worse than one told the
 * connection is not answering.
 */
export async function serverTime(app) {
  const X = app?.X;
  const source = await timeSource(app);
  if (!source) return 0;
  return new Promise((resolve) => {
    const done = (time) => {
      clearTimeout(timer);
      X.removeListener('event', onEvent);
      resolve(time);
    };
    const onEvent = (ev) => {
      if (
        ev.type === PROPERTY_NOTIFY &&
        ev.wid === source.window &&
        ev.atom === source.atom &&
        ev.state === NEW_VALUE
      ) {
        done(ev.time >>> 0);
      }
    };
    const timer = setTimeout(() => done(0), TIMEOUT);
    timer.unref?.();
    X.on('event', onEvent);
    // Appending nothing still rewrites the property, which is what generates
    // the event; replacing would too, but appending cannot grow the property
    // however many times this is called.
    X.ChangeProperty(
      APPEND,
      source.window,
      source.atom,
      X.atoms.STRING,
      8,
      Buffer.alloc(0),
    );
  });
}

/**
 * The window and atom to bounce a timestamp off, created on first use and
 * shared by every later call on the same connection.
 *
 * Its own window rather than one of the app's: selecting PropertyChange on a
 * `<window>` would put every property the window manager writes on it — and
 * `_NET_WM_STATE` changes constantly — through this connection's event stream
 * for the life of the app, to serve a call that happens once.
 *
 * A promise because the property atom has to be interned before anything can
 * be appended to it; awaiting it is also what keeps two calls racing at
 * startup from creating two windows. Resolves null on a connection that
 * cannot do this at all, which is a headless mock rather than any real
 * server.
 */
function timeSource(app) {
  if (!app || typeof app !== 'object') return null;
  const cached = timeSources.get(app);
  if (cached !== undefined) return cached;

  const X = app.X;
  const root = X?.display?.screen?.[0]?.root;
  if (
    root == null ||
    typeof X.AllocID !== 'function' ||
    typeof X.CreateWindow !== 'function' ||
    typeof X.ChangeProperty !== 'function' ||
    typeof X.on !== 'function'
  ) {
    timeSources.set(app, null);
    return null;
  }

  const window = X.AllocID();
  // InputOutput rather than InputOnly: properties are legal on both, but a
  // 1x1 window that is never mapped costs the same either way, and this is
  // the shape every other toolkit's timestamp window has.
  X.CreateWindow(window, root, -100, -100, 1, 1, 0, 0, 1, 0, {
    eventMask: PROPERTY_CHANGE_MASK,
  });
  const pending = new Promise((resolve) => {
    X.InternAtom(false, TIME_PROPERTY, (err, atom) =>
      resolve(err || !atom ? null : { window, atom }),
    );
  });
  timeSources.set(app, pending);
  return pending;
}
