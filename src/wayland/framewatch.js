// Noticing that the compositor has stopped showing this surface.
//
// After the first present the frame loop has exactly one source of liveness:
// `wl_surface.frame`, which a compositor is entitled never to send to a
// surface it is not showing — occluded, on another workspace, minimised, the
// screen locked. That is the right behaviour to drive a client with (drawing
// into a surface nobody sees is work for nothing) and it has one hole: a
// callback that never fires is not an error. Nothing rejects, nothing throws,
// the frame stays armed, and every later `_armFrame()` returns at its guard.
// The app above goes on re-rendering into a tree that reaches no screen, and
// from outside the process that is indistinguishable from a hang (#567).
//
// So the loop is watched. A frame callback outstanding longer than
// `REACT_X11_WAYLAND_FRAME_STALL_MS` (2s; `0` turns the watch off) is taken
// as "the compositor has parked us", which is
//
//   - **said once on stderr, in development**, when the window still had
//     something to draw — the line that the debugging session behind #567
//     would have ended at; and
//   - **published**, as `useWindowState().presenting`, so an app can stop
//     animating and simulating instead of feeding a loop nobody is turning.
//
// Nothing here paces or re-arms anything: the parked callback is still queued
// with the compositor and fires the moment the surface is shown again, which
// is what un-parks the loop and flips `presenting` back. A timer that painted
// anyway would be drawing into a surface nobody sees, which is the thing the
// frame callback is right about.

import { writeSync } from 'node:fs';

const DEV = process.env.NODE_ENV !== 'production';

/** How long a frame callback may be outstanding before the loop counts as
 *  parked, in milliseconds. `0` — or anything that is not a number — turns
 *  the watch off entirely: no timer, no warning, `presenting` always true. */
export const FRAME_STALL_MS = (() => {
  const raw = process.env.REACT_X11_WAYLAND_FRAME_STALL_MS;
  if (raw === undefined || raw === '') return 2000;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : 0;
})();

/**
 * The one line. It names the three things the symptom does not: that this is
 * the compositor's decision and not a crash, that the window is the thing to
 * look at, and where to read the state from in code.
 */
export function stallMessage(id, ms) {
  return (
    `react-x11 (wayland): window ${id} has had a frame callback outstanding ` +
    `for ${(ms / 1000).toFixed(1)}s with a repaint waiting — the compositor ` +
    'is not showing this surface (covered, on another workspace, minimised, ' +
    'or the screen is locked), so nothing this app draws will reach the ' +
    'screen until it does. The app is not hung. Read it in the tree as ' +
    'useWindowState().presenting, which is false until the next frame ' +
    'callback arrives. Said once per window; ' +
    'REACT_X11_WAYLAND_FRAME_STALL_MS=0 turns it off.\n'
  );
}

// Synchronous, like the frame trace in backendwindow.js and for the same
// reason: Bun buffers `process.stderr` to a file, and a buffer is what a
// SIGINT leaves behind — which is exactly how a run that looks hung ends.
const toStderr = (message) => writeSync(2, message);

/**
 * One window's frame-callback liveness.
 *
 * Three calls from the frame loop, and they are the whole interface:
 * `waiting()` when a `wl_surface.frame` has been asked for, `arrived()` when
 * one comes back, `idle()` when the loop stops waiting for one at all (a
 * rejected request, a closing connection). `presenting` is the answer, and
 * `onChange` fires only when it turns over.
 *
 * The timers are injected so the policy above can be tested without a
 * compositor, a GPU, or two seconds of wall clock.
 */
export class FrameWatch {
  /**
   * @param {object} opts
   * @param {number|string} [opts.id] the window's id, for the message
   * @param {number} [opts.stallMs] how long is too long
   * @param {() => boolean} [opts.pending] is a repaint waiting? — only then
   *   is the silence worth a line on stderr
   * @param {(presenting: boolean) => void} [opts.onChange]
   * @param {(message: string) => void} [opts.warn]
   * @param {boolean} [opts.dev] whether to warn at all
   */
  constructor({
    id = 0,
    stallMs = FRAME_STALL_MS,
    pending = () => false,
    onChange = () => {},
    warn = toStderr,
    dev = DEV,
    setTimer = (fn, ms) => {
      const t = setTimeout(fn, ms);
      // a diagnostic must never be the reason a process stays up
      t.unref?.();
      return t;
    },
    clearTimer = (t) => clearTimeout(t),
  } = {}) {
    this.id = id;
    this.stallMs = stallMs;
    this.presenting = true;
    this._pending = pending;
    this._onChange = onChange;
    this._warn = warn;
    this._dev = dev;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._timer = null;
    this._warned = false;
    this._stopped = false;
  }

  /** A frame callback has been asked for. */
  waiting() {
    // An already-running timer is left alone: it measures the age of the
    // oldest outstanding request, which is the one that matters.
    if (this._stopped || this._timer || !(this.stallMs > 0)) return;
    this._timer = this._setTimer(() => {
      this._timer = null;
      this._stall();
    }, this.stallMs);
  }

  /** A frame callback arrived: the compositor is showing this surface. */
  arrived() {
    this._disarm();
    this._publish(true);
  }

  /** Nothing is outstanding — a rejected request, a frame that drew nothing
   *  and asked for no other. Says nothing about whether we are being shown. */
  idle() {
    this._disarm();
  }

  /**
   * A repaint was asked for while a frame was already in flight.
   *
   * There is nothing to arm — the flight is armed, and the request will ride
   * it — but if that flight is the compositor's silence then this is the
   * moment the app starts drawing for nobody, and it is the other order the
   * bug arrives in: a window can park while it has nothing to draw (nothing
   * to warn about) and be given work a minute later, by which time the
   * deadline has come and gone.
   */
  workArrived() {
    if (this._stopped || this.presenting) return;
    this._maybeWarn();
  }

  /** The window is going away. */
  stop() {
    this._stopped = true;
    this._disarm();
  }

  _disarm() {
    if (this._timer === null) return;
    this._clearTimer(this._timer);
    this._timer = null;
  }

  _stall() {
    if (this._stopped) return;
    this._maybeWarn();
    this._publish(false);
  }

  /**
   * The line, once per window, and only where the app had something to draw:
   * a window that is simply idle is not being let down by anyone, and a
   * warning there would fire on every app that comes to rest.
   */
  _maybeWarn() {
    if (!this._dev || this._warned || !this._pending()) return;
    this._warned = true;
    this._warn(stallMessage(this.id, this.stallMs));
  }

  _publish(presenting) {
    if (this.presenting === presenting) return;
    this.presenting = presenting;
    this._onChange(presenting);
  }
}
