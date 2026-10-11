// `useIdle()` on the cocoa backend (src/cocoa/idle.js, #938).
//
// Every rung of src/idle.js's ladder but one reaches into `app.X`, and the
// cocoa `X` is a stub with no SYNC and no MIT-SCREEN-SAVER behind it — so on a
// Mac `useIdle()` armed nothing and stayed `false` however long the desk had
// been empty. The rung that needs no X is `app.lastInputMs()`, which only the
// win32 backend set. These pin the cocoa app setting it, from both of its
// sources:
//
//   1. the bridge's `lastInputMs()` (CoreGraphics' combined-session idle
//      time), where the bridge has it — synchronous, and preferred;
//   2. `ioreg`'s `HIDIdleTime`, where it does not, through a fake child.
//
// And what keeps the second affordable: the poll sleeps for the remaining
// time rather than ticking, two timeouts share a child, and nothing asks once
// the last subscriber has gone.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';

import { _setIoregForTests, hidIdleMs } from '../src/cocoa/idle.js';
import { idleSnapshot, watchIdle } from '../src/idle.js';
import { useIdle } from '../src/idlehooks.js';
import {
  cleanupCocoa,
  fakeCocoaApp,
  fakeCocoaBridge,
  mountCocoa,
} from './helpers/cocoa-bridge.js';

const h = React.createElement;

/** Let the poll's awaits run: a child's answer is a promise. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => _setIoregForTests(null));

/** A bridge whose `lastInputMs()` answers `idle.ms`. */
function bridgeWithIdle(ms) {
  const native = fakeCocoaBridge();
  const idle = { ms, asked: 0 };
  native.lastInputMs = () => {
    idle.asked += 1;
    return idle.ms;
  };
  return { native, idle };
}

/** The bridge as published today, which has no `lastInputMs`. (The fake
 *  answers every verb it is asked for, so the verb is taken away.) */
function bridgeWithoutIdle() {
  const native = fakeCocoaBridge();
  native.lastInputMs = undefined;
  return native;
}

/** `ioreg -r -d 1 -k HIDIdleTime -c IOHIDSystem`'s output for `ms`. */
const ioregSays = (ms) =>
  '+-o IOHIDSystem  <class IOHIDSystem, id 0x10000093d, registered>\n' +
  '    {\n' +
  `      "HIDIdleTime" = ${Math.round(ms * 1e6)}\n` +
  '    }\n';

/** A fake `ioreg`: answers `state.ms`, counts children, records the call. */
function fakeIoreg(ms) {
  const state = { ms, runs: [], fail: false };
  _setIoregForTests(async (file, args) => {
    state.runs.push([file, ...args]);
    if (state.fail) throw new Error('spawn /usr/sbin/ioreg ENOENT');
    return ioregSays(state.ms);
  });
  return state;
}

// --- the hook, end to end ------------------------------------------------------

test('useIdle() reports an empty desk on a Mac, from the bridge', async (t) => {
  t.after(cleanupCocoa);
  const { native, idle } = bridgeWithIdle(400_000);
  const seen = [];
  function Probe() {
    seen.push(useIdle(300_000));
    return h('text', null, 'x');
  }
  await mountCocoa(h(Probe), { native });
  await drain();
  // 400 s since the last input against a five-minute timeout. Before the
  // cocoa app said how long that was, nothing armed and this stayed false.
  assert.equal(seen.at(-1), true);
  assert.ok(idle.asked >= 1, 'the bridge was asked');
});

test('useIdle() reports an empty desk on a Mac, from ioreg', async (t) => {
  t.after(cleanupCocoa);
  const io = fakeIoreg(400_000);
  const seen = [];
  function Probe() {
    seen.push(useIdle(300_000));
    return h('text', null, 'x');
  }
  await mountCocoa(h(Probe), { native: bridgeWithoutIdle() });
  await drain();
  assert.equal(seen.at(-1), true);
  // the property, off the one registry entry that carries it
  assert.deepEqual(io.runs[0], [
    '/usr/sbin/ioreg',
    '-c',
    'IOHIDSystem',
    '-r',
    '-d',
    '1',
    '-k',
    'HIDIdleTime',
  ]);
});

// --- which rung --------------------------------------------------------------

test("the bridge's verb outranks ioreg", async (t) => {
  const io = fakeIoreg(0);
  const { native } = bridgeWithIdle(400_000);
  const { app } = fakeCocoaApp({ screenPoll: 0 }, { native });
  t.after(() => app.close());
  assert.equal(typeof app.lastInputMs, 'function');
  const stop = watchIdle(app, 300_000, () => {});
  t.after(stop);
  await drain();
  assert.equal(idleSnapshot(app, 300_000), true);
  assert.equal(io.runs.length, 0, 'no child where the bridge can answer');
});

test("ioreg's HIDIdleTime is nanoseconds", () => {
  assert.equal(hidIdleMs(ioregSays(12_000)), 12_000);
  assert.equal(
    hidIdleMs('      "HIDIdleTime" = 3588594533583\n'),
    3588594.533583,
  );
  assert.equal(hidIdleMs(''), null);
  assert.equal(hidIdleMs('"HIDIdleTime" = Yes'), null);
});

// --- what it costs ------------------------------------------------------------

test('it sleeps for the remaining time, and polls only while away', async (t) => {
  const { native, idle } = bridgeWithIdle(12_000);
  const { app } = fakeCocoaApp({ screenPoll: 0 }, { native });
  t.after(() => app.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const changes = [];
  const stop = watchIdle(app, 300_000, () =>
    changes.push(idleSnapshot(app, 300_000)),
  );
  t.after(stop);
  await drain();
  assert.equal(idle.asked, 1);
  assert.equal(idleSnapshot(app, 300_000), false);

  // 12 s of a five-minute timeout gone: nothing can change for 288 s, so
  // nothing asks before then.
  idle.ms = 299_999;
  t.mock.timers.tick(287_999);
  await drain();
  assert.equal(idle.asked, 1, 'asked before the remainder ran out');
  idle.ms = 300_000;
  t.mock.timers.tick(1);
  await drain();
  assert.equal(idle.asked, 2);
  assert.deepEqual(changes, [true]);

  // Away: no input reaches this process to say they are back, so it asks
  // on an interval scaled to the timeout — capped at half a minute.
  idle.ms = 40;
  t.mock.timers.tick(29_999);
  await drain();
  assert.equal(idle.asked, 2);
  t.mock.timers.tick(1);
  await drain();
  assert.equal(idle.asked, 3);
  assert.deepEqual(changes, [true, false]);
});

test('two timeouts asking at once share one ioreg child', async (t) => {
  const io = fakeIoreg(20_000);
  const { app } = fakeCocoaApp(
    { screenPoll: 0 },
    { native: bridgeWithoutIdle() },
  );
  t.after(() => app.close());
  const stops = [
    watchIdle(app, 10_000, () => {}),
    watchIdle(app, 60_000, () => {}),
  ];
  t.after(() => stops.forEach((stop) => stop()));
  await drain();
  assert.equal(io.runs.length, 1);
  assert.equal(idleSnapshot(app, 10_000), true);
  assert.equal(idleSnapshot(app, 60_000), false);
});

test('nothing asks once the last subscriber has gone', async (t) => {
  const { native, idle } = bridgeWithIdle(0);
  const { app } = fakeCocoaApp({ screenPoll: 0 }, { native });
  t.after(() => app.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = watchIdle(app, 10_000, () => {});
  const second = watchIdle(app, 10_000, () => {});
  await drain();
  assert.equal(idle.asked, 1, 'one watcher per timeout');

  first();
  t.mock.timers.tick(10_000);
  await drain();
  assert.equal(idle.asked, 2, 'still watched by the second');

  second();
  t.mock.timers.tick(60_000);
  await drain();
  assert.equal(idle.asked, 2, 'asked with nobody listening');

  // …and a new subscriber arms it again
  const third = watchIdle(app, 10_000, () => {});
  t.after(third);
  await drain();
  assert.equal(idle.asked, 3);
});

// --- when ioreg cannot answer --------------------------------------------------

test('an ioreg that cannot answer is asked again, and said once', async (t) => {
  const io = fakeIoreg(400_000);
  io.fail = true;
  const warned = [];
  t.mock.method(console, 'warn', (msg) => warned.push(msg));
  const { app } = fakeCocoaApp(
    { screenPoll: 0 },
    { native: bridgeWithoutIdle() },
  );
  t.after(() => app.close());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stop = watchIdle(app, 300_000, () => {});
  t.after(stop);
  await drain();
  assert.equal(idleSnapshot(app, 300_000), false);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /useIdle\(\) cannot read the idle time/);
  assert.match(warned[0], /lastInputMs/);

  // Not latched: a timeout later it asks again, and this time is answered.
  io.fail = false;
  t.mock.timers.tick(300_000);
  await drain();
  assert.equal(io.runs.length, 2);
  assert.equal(idleSnapshot(app, 300_000), true);
  assert.equal(warned.length, 1, 'said once, not per poll');
});
