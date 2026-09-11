// Threaded mode by default (docs/macos.md §"JS on a worker"). On macOS the
// process main thread is AppKit's — the only thread it lets own a window —
// and while the app's JS runs there, every menu, drag, live resize and
// modal panel stops it. So the first import of react-x11 on the main thread
// moves the app onto a `worker_threads` Worker before the app's own code has
// run, and parks the main thread for AppKit.
//
// It can be that early because of how modules evaluate: an entry's imports
// finish before its own body starts, so when react-x11 is being evaluated
// the entry has not run a line. The worker is started on that entry, and
// the main thread never returns to it — `process.exit` is the only way out.
// Nothing here is a top-level await, which would cost the CommonJS builds
// (docs/packaging.md, tier 3) and `require()` of the package.
//
// The main thread waits without AppKit, on shared memory, until the worker
// says what it needs: the first cocoa `createRoot` asks for it
// (`requestAppKit`, src/cocoa/threaded.js), and an app that never makes one
// — an X11 app on XQuartz, a script — never launches AppKit and never gets
// a Dock tile.
//
// `react-x11/cocoa-main` (src/cocoa/main.js) is the same move, asked for by
// name: it runs before the entry is even loaded, and skips the checks.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { isMainThread, SHARE_ENV, Worker } from 'node:worker_threads';

import { loadNative } from './native.js';
import {
  bindRelaunchState,
  forwardSignals,
  installStdio,
  onWorkerEnd,
  openThreadedChannel,
  printUncaught,
  RELAUNCH,
  routeExit,
  signalEnded,
} from './threaded.js';

// Set once the worker is set up, process-wide: the explicit launcher and
// the package's own import can both reach `bootstrapWorker`, and from two
// copies of the package the bridge would refuse the second `connect`.
const BOOTED = Symbol.for('react-x11.cocoa.workerBooted');

// How long the main thread waits, once AppKit's run is over, for the
// worker's own exit handlers to finish — they run to the end in a process
// of their own, and should here; a handler that hangs must not hang the
// process for ever.
const WORKER_END_MS = 5000;

/**
 * Why this import should not move the app onto a worker, or null when it
 * should. A pure answer over what the process says about itself, so that
 * each rule is testable on any OS.
 */
export function relaunchVeto({
  isMainThread: main,
  platform,
  env,
  entry,
  compiled,
  late,
}) {
  if (!main) return 'not the main thread';
  if (platform !== 'darwin') return 'not macOS';
  if (env.REACT_X11_THREADED === '0') return 'REACT_X11_THREADED=0';
  if (env.REACT_X11_BACKEND && env.REACT_X11_BACKEND !== 'cocoa') {
    return `REACT_X11_BACKEND=${env.REACT_X11_BACKEND}`;
  }
  // a REPL, `node -e`, or an entry that is not a file a worker can load
  if (!entry) return 'no entry script';
  // a single executable carries its entry inside the binary, where a worker
  // cannot load it from (docs/packaging.md)
  if (compiled) return 'a single executable';
  // a test runner's file is a test, not an app: node --test, bun test,
  // vitest, jest
  if (
    env.NODE_TEST_CONTEXT ||
    env.VITEST ||
    env.JEST_WORKER_ID ||
    env.NODE_ENV === 'test'
  ) {
    return 'a test runner';
  }
  // Imported after the app started running — a dynamic import from a
  // timer, say. Relaunching would run again, on the worker, everything the
  // entry has already done on this thread.
  if (late) return 'imported after the app started running';
  return null;
}

/** What `relaunchVeto` reads, from this process. */
export function describeProcess(moduleUrl) {
  const bun = globalThis.Bun;
  const entry = bun ? bun.main : process.argv[1];
  return {
    isMainThread,
    platform: process.platform,
    env: process.env,
    entry: typeof entry === 'string' && fs.existsSync(entry) ? entry : null,
    compiled: compiledExecutable(bun),
    late: startedRunning(bun, moduleUrl, entry),
  };
}

function compiledExecutable(bun) {
  // `bun build --compile` serves its modules from a virtual filesystem
  if (bun) return /^\/\$bunfs\/|~BUN/.test(String(bun.main));
  try {
    return createRequire(process.execPath)('node:sea').isSea();
  } catch {
    return false;
  }
}

/**
 * Whether the entry's own code has started. Node's event loop has not
 * turned while the entry's static imports evaluate —
 * `performance.nodeTiming.loopStart` is -1 until it does. Bun reports 1
 * there from the first line; what tells in Bun is the entry's record in the
 * module cache, which is there once the entry has been evaluated and
 * absent while its imports are (both measured, Node 26 and Bun 1.4).
 */
function startedRunning(bun, moduleUrl, entry) {
  if (!bun) return performance.nodeTiming?.loopStart > 0;
  try {
    return Boolean(createRequire(moduleUrl).cache?.[entry]?.loaded);
  } catch {
    return false;
  }
}

/**
 * The import-time move (src/bootstrap.js): relaunch when nothing vetoes it
 * and a bridge that can run AppKit's loop is installed. Returns why it did
 * not, for anyone asking; when it does, it does not return.
 */
export function relaunchOnImport(moduleUrl) {
  const veto = relaunchVeto(describeProcess(moduleUrl));
  if (veto) return veto;
  let native;
  try {
    native = loadNative();
  } catch {
    // no bridge: `createRoot` falls back to X11 the way it always has
    return 'no cocoa bridge';
  }
  if (typeof native.runMain !== 'function') return 'the bridge has no runMain';
  return relaunch(describeProcess(moduleUrl).entry, native);
}

/**
 * The worker's side, set up the moment it imports react-x11: after it the
 * app cannot tell it is on a worker, short of asking — its logs reach the
 * terminal, `process.exit` ends the process, a crash is printed, and a
 * Ctrl-C reaches its `process.on('SIGINT')` (src/cocoa/threaded.js). What
 * the app imports before react-x11 runs before this, so a module that logs
 * as it loads should come after it.
 */
export function bootstrapWorker(state) {
  if (globalThis[BOOTED]) return;
  globalThis[BOOTED] = true;
  const native = loadNative();
  installStdio();
  bindRelaunchState(state);
  printUncaught();
  routeExit(native);
  onWorkerEnd(signalEnded);
  openThreadedChannel(native).subscribe(forwardSignals());
}

/**
 * Start the app's entry on a worker and park this thread — waiting, then
 * in AppKit's run once the worker asks for it — until the app is done.
 * Never returns.
 */
export function relaunch(entry, native) {
  const state = new Int32Array(new SharedArrayBuffer(8));
  // The worker's entry is the app's own, so nothing has to ship beside it —
  // a bundle (docs/packaging.md, tier 2) is one file, and a worker entry of
  // the package's own would be a second one the bundler never emits. The
  // worker sets itself up when it imports react-x11 (`bootstrapWorker`,
  // src/bootstrap.js), recognising the shared state in its workerData.
  // execArgv carries a loader like `--import tsx`, which is what lets the
  // worker load a .jsx entry at all.
  new Worker(entry, {
    argv: process.argv.slice(2),
    execArgv: process.execArgv,
    env: SHARE_ENV,
    workerData: { reactX11State: state.buffer },
  });
  for (;;) {
    Atomics.wait(state, 0, RELAUNCH.WAITING);
    const now = Atomics.load(state, 0);
    if (now === RELAUNCH.APPKIT) break;
    if (now === RELAUNCH.ENDED) process.exit(Atomics.load(state, 1));
  }
  native.initApp();
  const code = native.runMain();
  // Back from AppKit: the app asked to exit — its `process.exit`, a crash,
  // a signal nobody listened for — and `code` is what it asked for, or the
  // worker ended without asking. Its exit handlers may still be running;
  // the worker says when they are done.
  Atomics.wait(state, 0, RELAUNCH.APPKIT, WORKER_END_MS);
  const ended = Atomics.load(state, 0) === RELAUNCH.ENDED;
  process.exit(code ?? (ended ? Atomics.load(state, 1) : 0));
}
