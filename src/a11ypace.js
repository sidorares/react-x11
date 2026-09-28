// How often an accessibility bridge tells its platform what changed.
//
// Both bridges mirror the tree for a platform that reads it on its own
// schedule: AT-SPI (src/atspi.js) exports objects and sends signals, UI
// Automation (src/win32/a11y.js) walks a window and pushes a diff. Pushed on
// every commit, that is paid by everything that commits often, and mostly
// for nobody. On Windows it was 1.6 ms of each frame of a graph pane's pan
// (#656). On a Linux desktop whose session runs the AT-SPI bus, as most do
// with no screen reader in sight, it was a sixth of a 100,000-row table's
// fling: rows exported, diffed and unexported as they scrolled past.
//
// The rule is the one browsers use. Chromium's AXObjectCacheImpl batches
// non-interactive updates, 150 ms apart once a page has loaded and 350 ms
// before, and the bounds of anything that is not focused 500 ms apart. It
// serializes a focus or selection change at once, because that is what the
// user is waiting on. So here:
//
//   - a change after a quiet spell is pushed at once, so a click or a key
//     that changes one thing is heard immediately;
//   - a stream of changes (a scroll, a pan, a value ticking) is pushed at
//     most once per `interval`, and the last push carries the last state;
//   - what the user is waiting on goes at once regardless: a focus change,
//     an announcement, and a change to the focused element itself, such as
//     the characters typed into it. That exception is each bridge's to
//     call (`urgent`).
//
// The interval is 500 ms: at most two pushes a second, the slower end of
// what Chromium spends. `REACT_X11_A11Y_INTERVAL` sets it in milliseconds,
// and `0` pushes on every change, as both bridges once did.

export const DEFAULT_A11Y_INTERVAL = 500;

/**
 * The push interval: `REACT_X11_A11Y_INTERVAL` in milliseconds where it is a
 * number of them (`0` included), and the default otherwise.
 */
export function a11yInterval(env = globalThis.process?.env ?? {}) {
  const raw = env.REACT_X11_A11Y_INTERVAL;
  if (raw === undefined || raw === '') return DEFAULT_A11Y_INTERVAL;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_A11Y_INTERVAL;
}

/**
 * The pacing, without the pushing: the bridge asks whether a push may go now
 * and says when one went, and the pacer keeps the one timer a stream owes.
 */
export class A11yPacer {
  constructor(interval = a11yInterval()) {
    this.interval = interval;
    this._last = -Infinity;
    this._timer = null;
  }

  /**
   * Something changed. True when it may be pushed now, because nothing has
   * been pushed for an interval. False when `later` has been set to run once
   * the interval is up: one timer, however many changes ask while it runs.
   */
  ready(later) {
    if (this._timer) return false;
    const wait = this._last + this.interval - performance.now();
    if (wait <= 0) return true;
    this._timer = setTimeout(() => {
      this._timer = null;
      later();
    }, wait);
    this._timer.unref?.();
    return false;
  }

  /** A push went out, paced or not: the next interval runs from here. */
  pushed() {
    this._last = performance.now();
  }

  /** Drop the push a stream is owed, for one that goes now and takes it. */
  cancel() {
    if (this._timer === null) return;
    clearTimeout(this._timer);
    this._timer = null;
  }
}
