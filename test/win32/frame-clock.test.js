// The frame clock on the Windows backend: the compositor's, with a timer
// behind it (src/win32/app.js, `_armFrame`).
//
// A request made after a quiet spell could wait 0.3–3 s for the compositor's
// tick, and the watchdog that caught it latched the timer for the rest of the
// session: an application that sat still for a moment at startup ran at 34
// frames a second from then on. These drive the clock by hand — the fake
// bridge offers one, and a tick is a routed 'frame-clock' — and check that a
// clock is trusted only while it ticks, and trusted again once it does.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Win32App } from '../../src/win32/app.js';
import { createFakeBridge } from './fake-bridge.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup() {
  const bridge = createFakeBridge();
  let requests = 0;
  bridge.frameClockRequest = () => {
    requests++;
    return true;
  };
  const app = new Win32App(bridge, {});
  const frames = [];
  const ask = () => app._requestFrame((at) => frames.push(at));
  const tick = () => app._route({ type: 'frame-clock' });
  return { app, frames, ask, tick, requests: () => requests };
}

/** Resolves with how long `frames` took to reach `count`, or rejects. */
async function until(frames, count, within) {
  const started = performance.now();
  while (frames.length < count) {
    if (performance.now() - started > within) {
      throw new Error(`${frames.length} of ${count} frames in ${within} ms`);
    }
    await sleep(2);
  }
  return performance.now() - started;
}

describe('win32 frame clock', () => {
  it('a ticking clock answers the frame, and the timer only watches for it', async () => {
    const { app, frames, ask, tick } = setup();
    ask();
    tick();
    assert.equal(frames.length, 1, 'the tick is the frame');
    // ticked just now: the next frame is the clock's to answer, and nothing
    // answers it for longer than a timer-paced frame would take
    ask();
    await sleep(80);
    assert.equal(frames.length, 1, 'no timer answered a frame the clock owes');
    tick();
    assert.equal(frames.length, 2);
    app._closed = true;
  });

  it('after a quiet spell a timer races the clock, and wins while it sleeps', async () => {
    const { app, frames, ask, requests } = setup();
    // never ticked: the compositor may be asleep
    ask();
    assert.equal(requests(), 1, 'the clock is still asked');
    const took = await until(frames, 1, 200);
    assert.ok(took < 100, `a timer answered in ${took.toFixed(0)} ms`);
    app._closed = true;
  });

  it('a late tick trusts the clock again: a missed one is not for good', async () => {
    const { app, frames, ask, tick } = setup();
    ask();
    await until(frames, 1, 200); // the timer's
    // the tick that frame asked for arrives late, and the clock is back
    tick();
    const before = frames.length;
    ask();
    await sleep(80);
    assert.equal(frames.length, before, 'the clock owes this one, not a timer');
    tick();
    assert.equal(frames.length, before + 1);
    app._closed = true;
  });

  it('a clock that never ticks paces frames like the timer, not like the watchdog', async () => {
    const { app, frames, ask } = setup();
    const started = performance.now();
    for (let i = 1; i <= 5; i++) {
      ask();
      await until(frames, i, 300);
    }
    const took = performance.now() - started;
    // five of the watchdog's would be 1.25 s; five frame intervals, rounded
    // up to the system tick, are well under half of that
    assert.ok(took < 500, `five frames in ${took.toFixed(0)} ms`);
    app._closed = true;
  });
});
