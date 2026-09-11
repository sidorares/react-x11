// Threaded mode by default on macOS (src/cocoa/relaunch.js): the rules for
// when an import of react-x11 moves the app onto a worker, and the worker's
// side of the hand-off — the main thread waits on shared memory until the
// worker asks for AppKit or says it is done, after every exit handler the
// app has, with its crash printed by itself. Headless: the rules are a pure
// function, and the hand-off is shared memory and an EventEmitter.
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { relaunchVeto } from '../src/cocoa/relaunch.js';
import {
  RELAUNCH,
  onWorkerEnd,
  printUncaught,
  requestAppKit,
  signalEnded,
} from '../src/cocoa/threaded.js';

const app = {
  isMainThread: true,
  platform: 'darwin',
  env: {},
  entry: '/Users/me/app.jsx',
  compiled: false,
  late: false,
};

test('an app on macOS, imported as it starts, moves onto a worker', () => {
  assert.strictEqual(relaunchVeto(app), null);
  assert.strictEqual(
    relaunchVeto({ ...app, env: { REACT_X11_BACKEND: 'cocoa' } }),
    null,
  );
});

test('everything that keeps it where it is says why', () => {
  const cases = [
    [{ isMainThread: false }, 'not the main thread'],
    [{ platform: 'linux' }, 'not macOS'],
    [{ platform: 'win32' }, 'not macOS'],
    [{ env: { REACT_X11_THREADED: '0' } }, 'REACT_X11_THREADED=0'],
    [{ env: { REACT_X11_BACKEND: 'x11' } }, 'REACT_X11_BACKEND=x11'],
    [{ entry: null }, 'no entry script'],
    [{ compiled: true }, 'a single executable'],
    [{ env: { NODE_TEST_CONTEXT: 'child-v8' } }, 'a test runner'],
    [{ env: { NODE_ENV: 'test' } }, 'a test runner'],
    [{ env: { VITEST: 'true' } }, 'a test runner'],
    [{ late: true }, 'imported after the app started running'],
  ];
  for (const [change, reason] of cases) {
    assert.strictEqual(relaunchVeto({ ...app, ...change }), reason);
  }
});

test('the first cocoa root asks the waiting main thread for AppKit, and waits for its run', async () => {
  const state = new Int32Array(new SharedArrayBuffer(8));
  let running = false;
  const asked = requestAppKit({ threaded: () => running }, state);
  assert.strictEqual(Atomics.load(state, 0), RELAUNCH.APPKIT);
  let done = false;
  asked.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(done, false, 'not before runMain runs');
  running = true;
  await asked;
  // a second root finds AppKit up and asks nothing
  await requestAppKit({ threaded: () => true }, state);
  assert.strictEqual(Atomics.load(state, 0), RELAUNCH.APPKIT);
});

test('the worker says it is done after every exit handler the app has, however late it added one', () => {
  const proc = new EventEmitter();
  proc.exitCode = undefined;
  const order = [];
  onWorkerEnd((code) => order.push(`ended ${code}`), proc);
  proc.on('exit', () => order.push('the app'));
  proc.once('exit', () => order.push('the app, once'));
  proc.prependListener('exit', () => order.push('the app, first'));
  proc.emit('exit', 4);
  assert.deepStrictEqual(order, [
    'the app, first',
    'the app',
    'the app, once',
    'ended 4',
  ]);

  const state = new Int32Array(new SharedArrayBuffer(8));
  signalEnded(7, state);
  assert.deepStrictEqual([...state], [RELAUNCH.ENDED, 7]);
});

test('the worker prints its own uncaught error, unless the app handles it', () => {
  const proc = new EventEmitter();
  const printed = [];
  printUncaught(proc, (s) => printed.push(s));
  proc.emit('uncaughtExceptionMonitor', new Error('nobody caught this'));
  assert.match(printed.join(''), /Error: nobody caught this/);

  printed.length = 0;
  proc.on('uncaughtException', () => {});
  proc.emit('uncaughtExceptionMonitor', new Error('the app did'));
  assert.deepStrictEqual(printed, []);
});
