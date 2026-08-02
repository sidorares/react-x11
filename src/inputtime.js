// The server timestamp of the last X input event, per app.
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

const lastInputTime = new WeakMap();

// Motion is deliberately not tracked. Nothing converts or acquires a
// selection from a motion event — a drag-select owns PRIMARY on the mouseup
// that ends it, and a drag publishes on the mousedown that began it — so
// tracking motion would add a write per motion event to buy nothing.
const TRACKED = new Set(['mousedown', 'mouseup', 'keydown', 'keyup']);

/** Remember the server time an input event carried, if it carried one. */
export function noteInputTime(app, name, native) {
  if (!app || !TRACKED.has(name)) return;
  const time = native?.time;
  if (typeof time === 'number') lastInputTime.set(app, time >>> 0);
}

/**
 * The last input timestamp seen on this app's connection, or `undefined`
 * when no input has arrived yet.
 *
 * `undefined` is passed straight through to ntk rather than replaced with a
 * zero: `write()` turns it into a real server timestamp, and CurrentTime is
 * what ICCCM 2.1 forbids. A caller with no event to name should get ntk's
 * fallback, not a made-up number.
 */
export function inputTime(app) {
  return app ? lastInputTime.get(app) : undefined;
}
