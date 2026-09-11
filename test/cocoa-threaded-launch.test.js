// Threaded mode for real: an app started under the launcher
// (`node --import react-x11/cocoa-main`, src/cocoa/main.js) with the real
// bridge — the entry on a worker, AppKit's main thread in `[NSApp run]`, a
// window made and painted, and the three ways out of the process.
//
// It opens a real window, so it needs macOS and a bridge with `runMain()`
// (@windowkit/appkit >= 0.10, or a checkout through REACT_X11_CALAYERS_PATH);
// anywhere else it skips. The app half is test/fixtures/cocoa-threaded-app.js.
import assert from 'node:assert';
import { test } from 'node:test';

import { runNode } from './helpers/run-script.js';

const bridge = await (async () => {
  if (process.platform !== 'darwin') return null;
  try {
    const { loadNative } = await import('../src/cocoa/native.js');
    return loadNative();
  } catch {
    return null;
  }
})();
const skip =
  typeof bridge?.runMain !== 'function' &&
  'needs macOS and a bridge with runMain() (@windowkit/appkit >= 0.10)';

const launch = (mode) =>
  runNode(
    [
      '--import',
      './src/cocoa/main.js',
      'test/fixtures/cocoa-threaded-app.js',
      mode,
    ],
    { NO_AT_BRIDGE: '1' },
    30000,
  );

const report = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));

test(
  'the entry runs on a worker, and its window is made and painted',
  { skip },
  async () => {
    const run = await launch('report');
    assert.strictEqual(run.code, 0, run.stderr);
    const got = report(run.stdout);
    assert.deepStrictEqual(
      {
        isMainThread: got.isMainThread,
        threaded: got.threaded,
        made: got.made,
        presented: got.presented,
        entry: got.entry,
      },
      {
        isMainThread: false,
        threaded: true,
        made: true,
        presented: true,
        entry: true,
      },
    );
    assert.strictEqual(got.scale, bridge.listScreens()[0].scale);
  },
);

test(
  'process.exit on the worker is the process’s exit code',
  { skip },
  async () => {
    const run = await launch('exit');
    assert.strictEqual(run.code, 7, run.stderr);
    // and while the worker's exit handler runs, the main thread — back from
    // AppKit already — does not go on to run the entry itself
    const lines = run.stdout.trim().split('\n');
    assert.strictEqual(lines.length, 1, run.stdout);
    assert.strictEqual(report(run.stdout).threaded, true);
  },
);

test(
  'an uncaught error on the worker is printed, and the process exits 1',
  { skip },
  async () => {
    const run = await launch('throw');
    assert.strictEqual(run.code, 1);
    assert.match(run.stderr, /thrown by the app/);
  },
);

// No flag at all: the first import of react-x11 moves the app onto a worker
// (src/cocoa/relaunch.js). NODE_TEST_CONTEXT is what the test runner hands
// this process, and the relaunch declines a test runner's children.
const auto = (mode, env = {}) =>
  runNode(
    ['test/fixtures/cocoa-threaded-app.js', mode],
    { NO_AT_BRIDGE: '1', NODE_TEST_CONTEXT: '', ...env },
    30000,
  );

test(
  'with no flag at all the app moves onto a worker as react-x11 is imported',
  { skip },
  async () => {
    const run = await auto('report');
    assert.strictEqual(run.code, 0, run.stderr);
    const got = report(run.stdout);
    assert.deepStrictEqual(
      [got.isMainThread, got.threaded, got.made, got.presented],
      [false, true, true, true],
    );
    assert.strictEqual(got.scale, bridge.listScreens()[0].scale);
  },
);

test(
  'REACT_X11_THREADED=0 keeps the app on the main thread, with the pump',
  { skip },
  async () => {
    const run = await auto('report', { REACT_X11_THREADED: '0' });
    assert.strictEqual(run.code, 0, run.stderr);
    const got = report(run.stdout);
    assert.deepStrictEqual(
      [got.isMainThread, got.threaded, got.presented],
      [true, false, true],
    );
  },
);

test(
  'an app that never makes a cocoa root runs on the worker and never launches AppKit',
  { skip },
  async () => {
    const run = await auto('plain');
    assert.strictEqual(run.code, 0, run.stderr);
    assert.deepStrictEqual(report(run.stdout), {
      isMainThread: false,
      appKit: false,
    });
  },
);

test(
  'an app that closes its window and runs out ends the process, its entry run once',
  { skip },
  async () => {
    const run = await launch('idle');
    assert.strictEqual(run.code, 0, run.stderr);
    // once: back from AppKit, the main thread must not go on to the entry
    const lines = run.stdout.trim().split('\n');
    assert.strictEqual(lines.length, 1, run.stdout);
    assert.strictEqual(JSON.parse(lines[0]).isMainThread, false);
  },
);
