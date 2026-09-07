// Frame pacing, alone: the policy resolver and the token-bucket pacer
// (src/pacing.js), under a fake clock — no window, no backend, no timers.
// The four properties the module header promises are pinned here one by
// one, because each is what somebody will otherwise re-derive as a bug:
// idle is immediate, cheap is unthrottled, a rare expensive frame is free,
// and a flood that ends is un-throttled on its next claim.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  DEFAULT_FRAME_RATE,
  FRAME_RATE_PRESETS,
  FramePacer,
  frameRateDefaultFor,
  frameRateFromEnv,
  realClock,
  resolveFramePolicy,
  resolveFrameRate,
  sameFramePolicy,
  setFrameRateDefault,
} from '../src/pacing.js';

/** A clock the test moves by hand; `after` fires when `advance` crosses it. */
function fakeClock(start = 0) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    after(ms, fn) {
      const entry = { at: t + ms, ms, fn, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    timers,
    /** the waits armed and not cancelled */
    armed: () => timers.filter((e) => !e.cancelled),
    set(ms) {
      t = ms;
    },
    advance(ms) {
      t += ms;
      const due = timers.filter((e) => !e.cancelled && e.at <= t);
      for (const e of due) {
        e.cancelled = true; // fired
        e.fn();
      }
    },
  };
}

const ADAPTIVE = FRAME_RATE_PRESETS.adaptive;

/** Run `n` frames of `cost` ms back to back, each claimed the moment the
 * last one ends and painted after whatever wait the pacer asks. Returns
 * the waits, in order. */
function stream(pacer, clock, { n, cost }) {
  const waits = [];
  for (let i = 0; i < n; i += 1) {
    const wait = pacer.wait();
    waits.push(wait);
    clock.advance(wait);
    pacer.began();
    clock.advance(cost);
    pacer.ended();
  }
  return waits;
}

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(' '));
afterEach(() => {
  warnings.length = 0;
  delete process.env.REACT_X11_FRAME_RATE;
});
process.on('exit', () => {
  console.warn = realWarn;
});

// --- resolveFrameRate ---------------------------------------------------------

test('the presets are the three numbers, and the default is display', () => {
  assert.equal(DEFAULT_FRAME_RATE, 'display');
  assert.deepEqual(resolveFrameRate(undefined), FRAME_RATE_PRESETS.display);
  assert.deepEqual(resolveFrameRate('display'), {
    mode: 'display',
    budget: 1,
    minFps: 0,
    maxFps: 0,
  });
  assert.deepEqual(resolveFrameRate('adaptive'), {
    mode: 'adaptive',
    budget: 0.25,
    minFps: 20,
    maxFps: 0,
  });
  assert.deepEqual(resolveFrameRate('throughput'), {
    mode: 'throughput',
    budget: 0.1,
    minFps: 10,
    maxFps: 30,
  });
  assert.ok(Object.isFrozen(resolveFrameRate('adaptive')));
});

test('a number is a ceiling over the default, and nothing else', () => {
  assert.deepEqual(resolveFrameRate(60), {
    mode: 'custom',
    budget: 1,
    minFps: 0,
    maxFps: 60,
  });
  assert.deepEqual(resolveFrameRate(Infinity), FRAME_RATE_PRESETS.display);
  assert.throws(() => resolveFrameRate(0), /above zero/);
  assert.throws(() => resolveFrameRate(-30), /above zero/);
  assert.throws(() => resolveFrameRate(NaN), /above zero/);
});

test('an object names any of the three; the rest are the default', () => {
  assert.deepEqual(resolveFrameRate({ budget: 0.5, minFps: 15 }), {
    mode: 'custom',
    budget: 0.5,
    minFps: 15,
    maxFps: 0,
  });
  assert.deepEqual(resolveFrameRate({ maxFps: 30 }), {
    mode: 'custom',
    budget: 1,
    minFps: 0,
    maxFps: 30,
  });
  assert.deepEqual(resolveFrameRate({}), {
    mode: 'custom',
    budget: 1,
    minFps: 0,
    maxFps: 0,
  });
});

test('a bad value says what it is and what the choices are', () => {
  assert.throws(
    () => resolveFrameRate('fast', '<window frameRate>'),
    /<window frameRate> "fast" is not a frame rate — 'display'.*'adaptive'.*'throughput'.*a number.*budget, minFps, maxFps/,
  );
  assert.throws(() => resolveFrameRate([30]), /is not a frame rate/);
  assert.throws(
    () => resolveFrameRate({ fps: 30 }),
    /has no "fps" — the three numbers are budget, minFps and maxFps/,
  );
  assert.throws(
    () => resolveFrameRate({ budget: 0 }),
    /budget 0 — the share of wall time.*above 0 and at most 1/,
  );
  assert.throws(() => resolveFrameRate({ budget: 1.5 }), /budget 1.5/);
  assert.throws(() => resolveFrameRate({ minFps: -1 }), /minFps -1/);
  assert.throws(() => resolveFrameRate({ maxFps: '30' }), /maxFps "30"/);
  assert.throws(
    () => resolveFrameRate({ minFps: 60, maxFps: 30 }),
    /floor \(minFps 60\) above the ceiling \(maxFps 30\)/,
  );
});

test('a budget with no floor warns once, naming the fix', () => {
  resolveFrameRate({ budget: 0.25 }, '<window frameRate>');
  resolveFrameRate({ budget: 0.25 }, '<window frameRate>');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /budget 0.25 with no minFps/);
  assert.match(warnings[0], /3\.0× its cost/);
  assert.match(warnings[0], /minFps: 20/);
});

test('sameFramePolicy compares the numbers, not the identity', () => {
  assert.ok(
    sameFramePolicy(resolveFrameRate(60), resolveFrameRate({ maxFps: 60 })),
  );
  assert.ok(!sameFramePolicy(resolveFrameRate(60), resolveFrameRate(30)));
  assert.ok(sameFramePolicy(ADAPTIVE, ADAPTIVE));
  assert.ok(!sameFramePolicy(null, ADAPTIVE));
});

// --- the sources ----------------------------------------------------------------

test('REACT_X11_FRAME_RATE is a preset name or a number, and unset when empty', () => {
  assert.equal(frameRateFromEnv({}), undefined);
  assert.equal(frameRateFromEnv({ REACT_X11_FRAME_RATE: '' }), undefined);
  assert.equal(
    frameRateFromEnv({ REACT_X11_FRAME_RATE: 'adaptive' }),
    'adaptive',
  );
  assert.equal(frameRateFromEnv({ REACT_X11_FRAME_RATE: '30' }), 30);
  assert.equal(frameRateFromEnv({ REACT_X11_FRAME_RATE: ' 60 ' }), 60);
  assert.equal(frameRateFromEnv({ REACT_X11_FRAME_RATE: 'fast' }), 'fast');
});

test('the environment beats the prop, the prop beats the root, the root beats the default', () => {
  const app = {};
  assert.equal(resolveFramePolicy(undefined, app).mode, 'display');
  setFrameRateDefault(app, 'throughput');
  assert.equal(frameRateDefaultFor(app), 'throughput');
  assert.equal(resolveFramePolicy(undefined, app).mode, 'throughput');
  assert.equal(resolveFramePolicy('adaptive', app).mode, 'adaptive');
  process.env.REACT_X11_FRAME_RATE = 'display';
  assert.equal(resolveFramePolicy('adaptive', app).mode, 'display');
  process.env.REACT_X11_FRAME_RATE = '45';
  assert.equal(resolveFramePolicy('adaptive', app).maxFps, 45);
  process.env.REACT_X11_FRAME_RATE = 'fast';
  assert.throws(
    () => resolveFramePolicy('adaptive', app),
    /REACT_X11_FRAME_RATE "fast" is not a frame rate/,
  );
  setFrameRateDefault(app, undefined);
  assert.equal(frameRateDefaultFor(app), undefined);
});

test('a bad root default fails at createRoot, not at the first window', () => {
  assert.throws(
    () => setFrameRateDefault({}, 'quick'),
    /createRoot\({ frameRate }\) "quick" is not a frame rate/,
  );
});

// --- the pacer -----------------------------------------------------------------------

test("'display' never holds a frame, whatever the last one cost", () => {
  const clock = fakeClock();
  const pacer = new FramePacer(resolveFrameRate('display'), clock);
  assert.equal(pacer.active, false);
  const waits = stream(pacer, clock, { n: 20, cost: 60 });
  assert.deepEqual(waits, new Array(20).fill(0));
  assert.equal(
    pacer.defer(() => {}),
    false,
    'schedule it now',
  );
  assert.equal(pacer.stats.frames, 20);
  assert.equal(pacer.stats.lastCostMs, 60);
  assert.equal(pacer.stats.deferred, 0);
});

test('idle is immediate: a claim after a pause never waits', () => {
  const clock = fakeClock();
  const pacer = new FramePacer(ADAPTIVE, clock);
  stream(pacer, clock, { n: 30, cost: 40 }); // in debt by now
  assert.ok(pacer.wait() > 0, 'a flood is being paced');
  clock.advance(500);
  assert.equal(pacer.wait(), 0);
});

test('cheap is unthrottled: blit-sized frames at 120Hz keep 120Hz', () => {
  const clock = fakeClock();
  const pacer = new FramePacer(ADAPTIVE, clock);
  for (let i = 0; i < 600; i += 1) {
    assert.equal(pacer.wait(), 0, `frame ${i}`);
    pacer.began();
    clock.advance(0.5);
    pacer.ended();
    clock.advance(1000 / 120 - 0.5);
  }
  assert.equal(pacer.stats.deferred, 0);
});

test('a rare expensive frame is free: the burst absorbs one relayout in a scroll', () => {
  const clock = fakeClock();
  const pacer = new FramePacer(ADAPTIVE, clock);
  // a hundred cheap scroll frames, then one 30ms relayout, then cheap again
  for (let i = 0; i < 100; i += 1) {
    pacer.began();
    clock.advance(0.4);
    pacer.ended();
    clock.advance(8);
  }
  pacer.began();
  clock.advance(30);
  pacer.ended();
  assert.equal(pacer.wait(), 0, 'the frame after it does not wait');
  for (let i = 0; i < 20; i += 1) {
    assert.equal(pacer.wait(), 0);
    pacer.began();
    clock.advance(0.4);
    pacer.ended();
    clock.advance(8);
  }
});

test('a stream of expensive frames is held to the budget: cost × (1/budget − 1)', () => {
  const clock = fakeClock();
  const pacer = new FramePacer(ADAPTIVE, clock);
  const waits = stream(pacer, clock, { n: 60, cost: 6 });
  // the burst (50ms of paint at 0.25) is spent over the first frames…
  assert.equal(waits[0], 0);
  // …and from then on every frame waits three times what it cost
  const paced = waits.slice(-40);
  for (const w of paced) assert.ok(Math.abs(w - 18) < 1e-6, `waited ${w}`);
  assert.equal(pacer.stats.deferred, 0, 'wait() alone arms nothing');
  assert.equal(pacer.stats.frames, 60);
  assert.equal(pacer.stats.lastCostMs, 6);
});

test('the paint share of wall time converges on the budget', () => {
  for (const [name, cost] of [
    ['adaptive', 6],
    ['throughput', 6],
    ['adaptive', 2.5],
  ]) {
    const clock = fakeClock();
    const pacer = new FramePacer(resolveFrameRate(name), clock);
    const from = clock.now();
    const n = 400;
    stream(pacer, clock, { n, cost });
    const share = (n * cost) / (clock.now() - from);
    const { budget, minFps, maxFps } = resolveFrameRate(name);
    // the burst is paid for in the first frames, so a long stream lands a
    // little above the budget, never below it
    const expected =
      maxFps > 0 ? Math.min(budget, (cost * maxFps) / 1000) : budget;
    assert.ok(
      share >= expected - 1e-9 && share < expected * 1.1,
      `${name} at ${cost}ms: paint took ${(share * 100).toFixed(1)}% (budget ${budget * 100}%, floor ${minFps})`,
    );
  }
});

test('the floor bounds the wait whatever the debt', () => {
  const clock = fakeClock();
  const pacer = new FramePacer(ADAPTIVE, clock);
  const waits = stream(pacer, clock, { n: 20, cost: 40 });
  // 40ms at a quarter would wait 120; the 20fps floor says 50
  for (const w of waits.slice(-10)) assert.ok(Math.abs(w - 50) < 1e-6, `${w}`);
});

test('the ceiling holds cheap frames to a rate, start to start', () => {
  const clock = fakeClock();
  const pacer = new FramePacer(resolveFrameRate(30), clock);
  assert.equal(pacer.active, true);
  assert.equal(pacer.wait(), 0, 'the first frame');
  pacer.began();
  clock.advance(0.5);
  pacer.ended();
  assert.ok(Math.abs(pacer.wait() - (1000 / 30 - 0.5)) < 1e-9);
  clock.advance(20);
  assert.ok(Math.abs(pacer.wait() - (1000 / 30 - 20.5)) < 1e-9);
  clock.advance(20);
  assert.equal(pacer.wait(), 0);
  // a ceiling with a budget: the longer of the two waits wins
  const both = new FramePacer(
    resolveFrameRate({ budget: 0.25, minFps: 20, maxFps: 30 }),
    clock,
  );
  const waits = stream(both, clock, { n: 40, cost: 6 });
  for (const w of waits.slice(-10)) {
    assert.ok(Math.abs(w - (1000 / 30 - 6)) < 1e-6, `${w}`);
  }
});

test('a flood that ends is un-throttled on its next claim', () => {
  const clock = fakeClock();
  const pacer = new FramePacer(ADAPTIVE, clock);
  stream(pacer, clock, { n: 60, cost: 6 });
  // the flood stops: the prompt that follows waits for the last frame's
  // debt and nothing more…
  const last = pacer.wait();
  assert.ok(last > 0 && last <= 18, `${last}`);
  clock.advance(last);
  pacer.began();
  clock.advance(0.3);
  pacer.ended();
  // …and the next cheap frame is immediate
  assert.equal(pacer.wait(), 0);
});

test('a wait under a millisecond is not armed; the debt carries over', () => {
  const clock = fakeClock();
  const pacer = new FramePacer(ADAPTIVE, clock);
  stream(pacer, clock, { n: 60, cost: 6 });
  clock.advance(pacer.wait()); // the debt is paid
  // sub-millisecond frames claimed back to back: each would owe 3x its
  // cost, under the millisecond a timer can keep — so they run, and the
  // debt they run up is collected once it is worth a timer
  let waited = 0;
  let waits = 0;
  for (let i = 0; i < 40; i += 1) {
    const wait = pacer.wait();
    if (wait > 0) {
      assert.ok(wait >= 1, `${wait}`);
      waited += wait;
      waits += 1;
      clock.advance(wait);
    }
    pacer.began();
    clock.advance(0.3);
    pacer.ended();
  }
  assert.ok(waits > 0 && waits < 40, `${waits} waits for 40 frames`);
  // …and the share still lands on the budget
  const share = (40 * 0.3) / (40 * 0.3 + waited);
  assert.ok(share > 0.2 && share < 0.3, `${share}`);
});

test('a no-op flush charges its time but is not a frame', () => {
  const clock = fakeClock();
  const pacer = new FramePacer(resolveFrameRate(30), clock);
  pacer.began();
  clock.advance(1);
  pacer.ended(undefined, true);
  clock.advance(10);
  pacer.began();
  clock.advance(0.1);
  pacer.ended(undefined, false); // found nothing to paint
  assert.equal(pacer.stats.frames, 1);
  // the ceiling still measures from the frame that painted
  assert.ok(Math.abs(pacer.wait() - (1000 / 30 - 11.1)) < 1e-9);
});

test('defer arms one wait, coalesces the claims under it, and cancel drops it', () => {
  const clock = fakeClock();
  const pacer = new FramePacer(ADAPTIVE, clock);
  stream(pacer, clock, { n: 30, cost: 6 });
  let fired = 0;
  const fn = () => (fired += 1);
  assert.equal(pacer.defer(fn), true);
  assert.equal(pacer.deferring, true);
  assert.equal(pacer.stats.deferred, 1);
  assert.equal(clock.armed().length, 1);
  assert.ok(Math.abs(clock.armed()[0].ms - 18) < 1e-6);
  assert.equal(pacer.defer(fn), true, 'folded into the wait');
  assert.equal(pacer.defer(fn), true);
  assert.equal(pacer.stats.coalesced, 2);
  assert.equal(clock.armed().length, 1, 'one timer');
  clock.advance(18);
  assert.equal(fired, 1);
  assert.equal(pacer.deferring, false);
  // the frame that follows a wait records it
  pacer.began();
  clock.advance(6);
  pacer.ended();
  assert.ok(Math.abs(pacer.stats.lastWaitMs - 18) < 1e-6);
  // a wait a discrete flush made moot
  assert.equal(pacer.defer(fn), true);
  pacer.cancel();
  assert.equal(pacer.deferring, false);
  assert.equal(clock.armed().length, 0);
  clock.advance(100);
  assert.equal(fired, 1, 'cancelled, so never fired');
  pacer.began();
  clock.advance(0.2);
  pacer.ended();
  assert.equal(pacer.stats.lastWaitMs, 0, 'this frame waited on nothing');
});

test('a new policy starts from a full bucket; the same one again is a no-op', () => {
  const clock = fakeClock();
  const pacer = new FramePacer(ADAPTIVE, clock);
  stream(pacer, clock, { n: 30, cost: 6 });
  assert.ok(pacer.wait() > 0);
  pacer.configure(resolveFrameRate('adaptive'));
  assert.ok(pacer.wait() > 0, 'the same numbers: nothing reset');
  pacer.configure(resolveFrameRate('throughput'));
  assert.equal(pacer.wait(), 0, 'a new policy: the debt is forgiven');
  assert.equal(pacer.stats.mode, 'throughput');
  assert.equal(pacer.stats.budget, 0.1);
  pacer.configure(resolveFrameRate('display'));
  assert.equal(pacer.active, false);
  assert.equal(pacer.stats.mode, 'display');
});

test('a new clock starts the pacer afresh in its own time', () => {
  const late = fakeClock(600000); // ten minutes into a suite
  const pacer = new FramePacer(ADAPTIVE, late);
  stream(pacer, late, { n: 30, cost: 6 });
  assert.ok(pacer.wait() > 0, 'in debt on the old clock');
  const clock = fakeClock(1000);
  pacer.clock = clock;
  assert.equal(pacer.clock, clock);
  // a full bucket, no last frame: the rule's timestamps are all the new
  // clock's, so credit accrues from its first millisecond
  assert.equal(pacer.wait(), 0);
  const waits = stream(pacer, clock, { n: 60, cost: 6 });
  assert.equal(waits[0], 0, 'the burst is back');
  for (const w of waits.slice(-10)) assert.ok(Math.abs(w - 18) < 1e-6, `${w}`);
  // and a ceiling measured from a frame on the old clock does not hold
  // the first frame on the new one for ten minutes
  const capped = new FramePacer(resolveFrameRate(30), late);
  capped.began();
  late.advance(1);
  capped.ended();
  capped.clock = fakeClock(1000);
  assert.equal(capped.wait(), 0);
});

test('charge extends the last frame — the present on Cocoa', () => {
  const clock = fakeClock();
  const pacer = new FramePacer(ADAPTIVE, clock);
  // 4ms flushes alone are too cheap to pace at 8ms intervals…
  for (let i = 0; i < 40; i += 1) {
    pacer.began();
    clock.advance(1.5);
    pacer.ended();
    clock.advance(6.8);
  }
  assert.equal(pacer.wait(), 0);
  // …but with a 4.5ms present after each, they are a flood
  for (let i = 0; i < 40; i += 1) {
    const wait = pacer.wait();
    clock.advance(wait);
    pacer.began();
    clock.advance(1.5);
    pacer.ended();
    clock.advance(4.5);
    pacer.charge(4.5);
  }
  assert.equal(pacer.stats.lastCostMs, 6);
  assert.ok(Math.abs(pacer.wait() - 18) < 1e-6, `${pacer.wait()}`);
  pacer.charge(0);
  pacer.charge(-1);
  assert.equal(pacer.stats.lastCostMs, 6, 'nothing to charge');
});

test('the real clock is performance.now and an unref timer', async () => {
  assert.ok(Math.abs(realClock.now() - performance.now()) < 50);
  let ran = 0;
  const cancel = realClock.after(1, () => (ran += 1));
  cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ran, 0);
  realClock.after(1, () => (ran += 1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ran, 1);
});
