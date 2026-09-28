// Threaded mode by default on macOS (src/cocoa/relaunch.js): the rules for
// when an import of react-x11 moves the app onto a worker, and the worker's
// side of the hand-off — the main thread waits on shared memory until the
// worker asks for AppKit or says it is done, after every exit handler the
// app has, with its crash printed by itself. Headless: the rules are a pure
// function, the hand-off is shared memory and an EventEmitter, and the
// worker's start is a child process whose worker never asks for AppKit.
import assert from 'node:assert';
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { relaunchVeto } from '../src/cocoa/relaunch.js';
import {
  RELAUNCH,
  onWorkerEnd,
  printUncaught,
  requestAppKit,
  signalEnded,
} from '../src/cocoa/threaded.js';
import { runNode } from './helpers/run-script.js';

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
    [{ env: { REACT_X11_FRAME: '1' } }, 'a <Frame> pane'],
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

test('node flags a Worker refuses to be handed do not stop the move, and the worker keeps every one', async () => {
  // `--expose-gc` is a V8 flag and `--title` a process-wide one: handed
  // either as execArgv, a Worker throws ERR_WORKER_INVALID_EXEC_ARGV, and
  // the app died at its import of react-x11. An `--import`, the way a
  // loader like tsx comes in, must still reach the worker, and its
  // `process.execArgv` must stay the process's, since whatever starts node
  // again from the worker — the bench's per-scenario children — passes it on.
  const flags = [
    '--expose-gc',
    '--title=react-x11-relaunch',
    '--import',
    'data:text/javascript,globalThis.preloaded=true',
  ];
  const run = await runNode([
    ...flags,
    'test/fixtures/relaunch-node-flags.js',
    'report',
  ]);
  assert.strictEqual(run.code, 3, run.stderr);
  assert.deepStrictEqual(JSON.parse(run.stdout), {
    isMainThread: false,
    gc: 'function',
    title: 'react-x11-relaunch',
    preloaded: true,
    execArgv: flags,
  });
});

// The move for real, which needs macOS and a bridge that can run AppKit's
// loop — anywhere else nothing moves and there is nothing to keep.
const bridge = await (async () => {
  if (process.platform !== 'darwin') return null;
  try {
    const { loadNative } = await import('../src/cocoa/native.js');
    return loadNative();
  } catch {
    return null;
  }
})();
const noMove =
  typeof bridge?.runMain !== 'function' &&
  'needs macOS and a bridge with runMain() (@windowkit/appkit >= 0.10)';

/** Fork test/fixtures/relaunch-frame-pane.js as `<Frame>` forks a pane —
 * or, with `pane` false, the same fork with no pane in it. */
function forkPane(execArgv, pane) {
  const env = { ...process.env };
  // the runner's own mark would keep either where it is by itself
  delete env.NODE_TEST_CONTEXT;
  delete env.REACT_X11_FRAME;
  if (pane) env.REACT_X11_FRAME = '1';
  return new Promise((resolve) => {
    const child = fork(
      fileURLToPath(
        new URL('./fixtures/relaunch-frame-pane.js', import.meta.url),
      ),
      ['report'],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        execArgv,
        env,
        serialization: 'advanced',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const last = stdout.trim().split('\n').at(-1);
      resolve({ code, signal, stderr, report: last ? JSON.parse(last) : null });
    });
  });
}

test(
  'a <Frame> pane stays on its main thread, where the IPC channel to its host is',
  { skip: noMove },
  async () => {
    // A pane's entry (src/frame/child.js) talks to its host over the
    // channel fork() sets up, and the channel is the main thread's — a
    // worker has no `process.send` — while the pane has no AppKit for the
    // main thread to keep: its pixels reach the host through shared
    // IOSurfaces. Moved, every pane exited at once. Both ways in: the move
    // on import, and the launcher, which a pane gets whenever its host was
    // started under it, since the host's node flags follow into the fork.
    for (const [how, execArgv] of [
      ['on import', []],
      ['under the launcher', ['--import', './src/cocoa/main.js']],
    ]) {
      const pane = await forkPane(execArgv, true);
      assert.strictEqual(pane.code, 0, `${how}: ${pane.stderr}`);
      assert.deepStrictEqual(
        pane.report,
        { isMainThread: true, send: 'function' },
        how,
      );
      // the same fork with no pane in it moves: what keeps the pane where
      // it is is REACT_X11_FRAME, not something about this harness
      const app = await forkPane(execArgv, false);
      assert.strictEqual(app.code, 0, `${how}: ${app.stderr}`);
      assert.strictEqual(app.report?.isMainThread, false, how);
    }
  },
);

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
