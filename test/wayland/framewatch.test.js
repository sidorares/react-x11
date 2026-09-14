// The frame-loop watchdog (#567): what happens when the compositor stops
// answering `wl_surface.frame`.
//
// No compositor, no GPU and no wall clock — the watch takes its timers as
// arguments precisely so the policy can be read off a test rather than
// waited for. What is pinned here is the policy, in the words the bug
// report used: the silence is noticed, it is said **once** and only when
// there was something to draw, it is published either way, and the next
// callback takes it all back.
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { FrameWatch, FRAME_STALL_MS } from '../../src/wayland/framewatch.js';
import { WaylandBackendWindow } from '../../src/wayland/backendwindow.js';

/** A clock with a hand: `fire()` runs whatever is due. */
function fakeTimers() {
  let next = 1;
  const timers = new Map();
  return {
    timers,
    setTimer(fn, ms) {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    /** Everything armed right now, oldest first. */
    fire() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, t] of due) t.fn();
      return due.length;
    },
  };
}

function watchOn({ pending = () => true, dev = true, stallMs = 2000 } = {}) {
  const clock = fakeTimers();
  const changes = [];
  const warnings = [];
  const watch = new FrameWatch({
    id: 7,
    stallMs,
    dev,
    pending,
    onChange: (presenting) => changes.push(presenting),
    warn: (message) => warnings.push(message),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { watch, clock, changes, warnings };
}

describe('FrameWatch', () => {
  test('a frame callback that comes back says nothing at all', () => {
    const { watch, clock, changes, warnings } = watchOn();
    watch.waiting();
    watch.arrived();
    assert.equal(clock.fire(), 0, 'the deadline was disarmed');
    assert.equal(watch.presenting, true);
    assert.deepEqual(changes, [], 'nothing turned over, so nobody was told');
    assert.deepEqual(warnings, []);
  });

  test('silence past the deadline is the compositor parking us', () => {
    const { watch, clock, changes, warnings } = watchOn();
    watch.waiting();
    clock.fire();
    assert.equal(watch.presenting, false);
    assert.deepEqual(changes, [false]);
    assert.equal(warnings.length, 1);
    const line = warnings[0];
    assert.match(line, /react-x11 \(wayland\): window 7/);
    assert.match(line, /2\.0s/, 'the wait is in the message');
    assert.match(line, /not showing this surface/);
    // the two things the debugging session in #567 needed: that this is not
    // a hang, and where to read it in code
    assert.match(line, /not hung/);
    assert.match(line, /useWindowState\(\)\.presenting/);
  });

  test('the next callback takes it back', () => {
    const { watch, clock, changes } = watchOn();
    watch.waiting();
    clock.fire();
    watch.arrived();
    assert.equal(watch.presenting, true);
    assert.deepEqual(changes, [false, true]);
  });

  // The frame callback stays queued with the compositor while the surface is
  // hidden, so the loop un-parks on its own — nothing re-arms or polls, and a
  // window that parked and came back is a window whose watch is armed again.
  test('parking and coming back leaves the loop armed as usual', () => {
    const { watch, clock, changes } = watchOn();
    watch.waiting();
    clock.fire();
    watch.arrived();
    watch.waiting();
    assert.equal(clock.timers.size, 1);
    watch.arrived();
    assert.deepEqual(changes, [false, true]);
  });

  test('an idle window parks quietly: the state turns over, stderr does not', () => {
    const { watch, clock, changes, warnings } = watchOn({
      pending: () => false,
    });
    watch.waiting();
    clock.fire();
    assert.deepEqual(changes, [false], 'an app can still pause its own work');
    assert.deepEqual(
      warnings,
      [],
      'a window with nothing to draw is not being let down by anyone',
    );
  });

  // The other order the bug arrives in, and the one a single shot at the
  // deadline misses: the window parks with nothing to draw — no line, because
  // there was nothing to be let down — and is handed work afterwards.
  test('work arriving at a parked window is the same complaint', () => {
    let busy = false;
    const { watch, clock, warnings } = watchOn({ pending: () => busy });
    watch.waiting();
    clock.fire();
    assert.deepEqual(warnings, []);

    busy = true;
    watch.workArrived();
    assert.equal(warnings.length, 1);
    watch.workArrived();
    assert.equal(warnings.length, 1, 'still once per window');
  });

  test('work arriving at a window that is being shown says nothing', () => {
    const { watch, warnings } = watchOn();
    watch.waiting();
    watch.workArrived();
    assert.deepEqual(warnings, [], 'a frame in flight is not a frame parked');
  });

  test('said once per window, however often it parks', () => {
    const { watch, clock, warnings } = watchOn();
    watch.waiting();
    clock.fire();
    watch.arrived();
    watch.waiting();
    clock.fire();
    assert.equal(warnings.length, 1);
  });

  test('production says nothing, and still publishes', () => {
    const { watch, clock, changes, warnings } = watchOn({ dev: false });
    watch.waiting();
    clock.fire();
    assert.deepEqual(warnings, []);
    assert.deepEqual(changes, [false]);
  });

  test('idle() stops counting without declaring anything', () => {
    const { watch, clock, changes } = watchOn();
    watch.waiting();
    watch.idle();
    assert.equal(clock.fire(), 0);
    assert.equal(watch.presenting, true, 'idle is not "we are being shown"');
    assert.deepEqual(changes, []);
  });

  // `waiting()` is called per frame request, and the one that matters is the
  // oldest outstanding: a second call must not push the deadline out.
  test('a second wait does not restart the clock', () => {
    const { watch, clock } = watchOn();
    watch.waiting();
    const armed = [...clock.timers.keys()];
    watch.waiting();
    assert.deepEqual([...clock.timers.keys()], armed);
  });

  test('a destroyed window is silent even if its timer was due', () => {
    const { watch, clock, changes, warnings } = watchOn();
    watch.waiting();
    const [timer] = [...clock.timers.values()];
    watch.stop();
    timer.fn(); // the timer the platform had already scheduled
    assert.deepEqual(changes, []);
    assert.deepEqual(warnings, []);
    watch.waiting();
    assert.equal(clock.timers.size, 0, 'a stopped watch arms nothing');
  });

  test('a stall of 0 turns the whole thing off', () => {
    const { watch, clock, changes } = watchOn({ stallMs: 0 });
    watch.waiting();
    assert.equal(clock.timers.size, 0);
    assert.equal(clock.fire(), 0);
    assert.equal(watch.presenting, true);
    assert.deepEqual(changes, []);
  });

  test('the default deadline is two seconds', () => {
    assert.equal(FRAME_STALL_MS, 2000);
  });
});

// ---------------------------------------------------------------------------
// The other half: the frame loop's calls into it
// ---------------------------------------------------------------------------

/**
 * `_armFrame` over stubs. It reaches for four things — the shell window's
 * `whenConfigured`, `scheduleFrame` and `commit`, and the watch — so a window
 * that has those is enough to read the wiring off, with no GPU context, no
 * compositor and no surface anywhere in it.
 */
function loopWindow({ everPresented = true } = {}) {
  const calls = [];
  const fired = [];
  const requests = [];
  let answer = null;
  const win = Object.create(WaylandBackendWindow.prototype);
  Object.assign(win, {
    id: 3,
    isDragPreview: false,
    _destroyed: false,
    app: { conn: { destroyed: false } },
    _frameArmed: false,
    _presentInFlight: false,
    _everPresented: everPresented,
    _eagerFired: false,
    _raf: [],
    _surfaceRaf: [],
    _frameDirty: false,
    _frameWatch: new Proxy(
      {},
      {
        get:
          (_, name) =>
          (...args) =>
            calls.push(String(name), ...args),
      },
    ),
    _fireRaf: (t) => fired.push(t),
    wl: {
      whenConfigured: Promise.resolve(),
      scheduleFrame() {
        requests.push('frame');
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
      surface: { $: { commit: () => requests.push('commit') } },
    },
  });
  return { win, calls, fired, requests, answer: (t) => answer(t) };
}

/** Let the `whenConfigured` chain (and one frame callback) settle. */
const turn = () => new Promise((r) => setTimeout(r, 0));

describe('the frame loop and the watch', () => {
  test('a frame request starts the watch, and its callback stops it', async () => {
    const { win, calls, fired, requests, answer } = loopWindow();
    win._raf.push(() => {});
    win._armFrame();
    await turn();
    assert.deepEqual(requests, ['frame', 'commit']);
    assert.deepEqual(calls, ['waiting'], 'armed with the request, not before');

    answer(42);
    await turn();
    assert.deepEqual(calls, ['waiting', 'arrived']);
    assert.deepEqual(fired, [42], 'and the frame still runs');
  });

  // The guard #567 is really about: every repaint after the first returns
  // here, and until now that was the last anything heard of it.
  test('a repaint while a frame is in flight tells the watch', async () => {
    const { win, calls, requests } = loopWindow();
    win._frameArmed = true;
    win._raf.push(() => {});
    win._armFrame();
    await turn();
    assert.deepEqual(calls, ['workArrived']);
    assert.deepEqual(requests, [], 'and asks for no second frame');
  });

  test('a frame that presented nothing stops the watch counting', () => {
    const { win, calls } = loopWindow();
    win._frameIdle();
    assert.deepEqual(calls, ['idle']);
    assert.equal(win._frameArmed, false);
  });

  // Before the first present the loop runs off a timer, because a compositor
  // schedules no callbacks for a surface it has never seen — there is no
  // outstanding request to watch, and nothing to complain about.
  test('the first frame is a timer, and arms no watch', async () => {
    const { win, calls, fired, requests } = loopWindow({
      everPresented: false,
    });
    win._raf.push(() => {});
    win._armFrame();
    await turn(); // the configure chain…
    await turn(); // …and the timer it sets from there
    assert.deepEqual(requests, [], 'nothing was asked of the compositor');
    assert.deepEqual(calls, []);
    assert.deepEqual(fired, [0], 'the frame ran off the timer');
  });

  test('what counts as a repaint waiting', () => {
    const { win } = loopWindow();
    assert.equal(win._hasFrameWork(), false);
    win._raf.push(() => {});
    assert.equal(win._hasFrameWork(), true, "the renderer's frame");
    win._raf.length = 0;
    win._surfaceRaf.push(() => {});
    assert.equal(win._hasFrameWork(), true, "a <glarea>'s");
    win._surfaceRaf.length = 0;
    win._frameDirty = true;
    assert.equal(win._hasFrameWork(), true, "the decorations'");
  });
});
