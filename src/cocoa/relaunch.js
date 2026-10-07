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
  openThreadedChannel,
  RELAUNCH,
  routeExit,
} from './threaded.js';

// Set once the worker is set up, process-wide: the explicit launcher and
// the package's own import can both reach `bootstrapWorker`, and from two
// copies of the package the bridge would refuse the second `connect`.
const BOOTED_KEY = 'react-x11.cocoa.workerBooted';
const BOOTED = Symbol.for(BOOTED_KEY);

// Printed above an error that ended the worker before its import of
// react-x11 had run there: thrown by code the main thread had run without
// a complaint a moment before, which is all the developer has to go on.
const STOPPED_EARLY =
  'react-x11: the app stopped on its worker thread before reaching its ' +
  'import of react-x11 there. On macOS react-x11 runs the app on a worker ' +
  'thread, starting the entry over on it, so what the entry imports ahead ' +
  'of react-x11 runs twice: on the main thread, then on the worker, where ' +
  'a call only a main thread may make — process.chdir(), say — throws. ' +
  'Make such a call on the main thread only (isMainThread, from ' +
  'node:worker_threads); what it changes holds for the whole process, the ' +
  'worker included. Or keep the app on the main thread with ' +
  'REACT_X11_THREADED=0. See docs/macos.md, "What changes for an app".';

/**
 * What a worker `relaunch` starts runs before the app's entry, as the source
 * of a function of `(process, global)`: what the worker needs from its first
 * line, since the main thread is parked and hears nothing else from it.
 *
 * Its end, written into the shared state after the app's last exit
 * listener. The main thread ends the process on it, so an app's
 * `process.on('exit')` handler must have finished by then, as it has in a
 * process of its own. Kept last by re-adding it whenever the app adds one:
 * Node runs a worker's exit listeners through `process.emit` and Bun calls
 * them directly (measured), so wrapping the emit would cover only Node.
 *
 * Its uncaught error, printed by itself. Node hands a worker's uncaught
 * error to its parent as an event, and the parent here never runs its event
 * loop again to hear it. Only when nothing handles the error: an app's own
 * `uncaughtException` handler means it is not uncaught. Straight to fd 2,
 * because the worker's own stderr forwards through the parked thread too
 * until `bootstrapWorker` replaces it; a pipe the main thread made
 * non-blocking answers EAGAIN when full, and the write waits it out.
 *
 * Both used to be set up by `bootstrapWorker`, when the entry reached its
 * import of react-x11. A worker that died before then — a module imported
 * ahead of react-x11 calling `process.chdir()`, which only a main thread
 * may — wrote nothing into the shared state and printed nothing, and the
 * process waited in `Atomics.wait` for ever.
 *
 * A string, not a function's `toString()`: a build step rewrites a function
 * — a bundler's name helper, a coverage counter — into references the
 * worker cannot resolve, and a throw here hangs the process the way this
 * exists to prevent.
 */
export const WORKER_START = `(function (process, global) {
  'use strict';
  const { workerData } = process.getBuiltinModule('node:worker_threads');
  const { writeSync } = process.getBuiltinModule('node:fs');
  const { inspect } = process.getBuiltinModule('node:util');
  const state = new Int32Array(workerData.reactX11State);

  const write = (text) => {
    const bytes = Buffer.from(text);
    for (let off = 0; off < bytes.length; ) {
      try {
        off += writeSync(2, bytes, off);
      } catch (err) {
        if (err.code !== 'EAGAIN') return;
      }
    }
  };
  process.on('uncaughtExceptionMonitor', (err) => {
    if (process.listenerCount('uncaughtException') > 0) return;
    const why = global[Symbol.for(${JSON.stringify(BOOTED_KEY)})]
      ? ''
      : ${JSON.stringify(`${STOPPED_EARLY}\n`)};
    write(why + inspect(err) + '\\n');
  });

  const add = process.on;
  const end = (code) => {
    const n = Number.parseInt(code ?? process.exitCode ?? 0, 10) || 0;
    Atomics.store(state, 1, n);
    Atomics.store(state, 0, ${RELAUNCH.ENDED});
    Atomics.notify(state, 0);
  };
  add.call(process, 'exit', end);
  for (const name of [
    'on',
    'addListener',
    'once',
    'prependListener',
    'prependOnceListener',
  ]) {
    const method = process[name];
    process[name] = function (event, listener) {
      const out = method.call(this, event, listener);
      if (event === 'exit' && listener !== end) {
        process.removeListener('exit', end);
        add.call(process, 'exit', end);
      }
      return out;
    };
  }
})`;

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
  // A `<Frame>` pane (REACT_X11_FRAME is what the host sets on the fork)
  // has no AppKit for the main thread to keep — its pixels reach the host
  // through shared IOSurfaces (src/cocoa/panewindow.js) — and its entry
  // talks to the host over the IPC channel fork() sets up, which is the
  // main thread's: on a worker there is no `process.send`, and the pane
  // exited as it started (src/frame/child.js).
  if (env.REACT_X11_FRAME === '1') return 'a <Frame> pane';
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
 * The worker's side, set up the moment it imports react-x11, on top of
 * `WORKER_START`, which has said how the worker ends and printed what
 * crashed it since its first line: after it the app cannot tell it is on a
 * worker, short of asking — its logs reach the terminal, `process.exit`
 * ends the process, and a Ctrl-C reaches its `process.on('SIGINT')`
 * (src/cocoa/threaded.js). What the app imports before react-x11 runs
 * before this, so a module that logs as it loads should come after it.
 */
export function bootstrapWorker(state) {
  if (globalThis[BOOTED]) return;
  globalThis[BOOTED] = true;
  const native = loadNative();
  installStdio();
  bindRelaunchState(state);
  routeExit(native);
  openThreadedChannel(native).subscribe(forwardSignals());
}

/**
 * Start the app's entry on a worker and park this thread — waiting, then
 * in AppKit's run once the worker asks for it — until the app is done.
 * Never returns.
 */
export function relaunch(entry, native) {
  const state = new Int32Array(new SharedArrayBuffer(8));
  // The worker runs the app's own entry, so nothing has to ship beside it —
  // a bundle (docs/packaging.md, tier 2) is one file, and a worker entry of
  // the package's own would be a second one the bundler never emits. The
  // worker sets itself up when it imports react-x11 (`bootstrapWorker`,
  // src/bootstrap.js), recognising the shared state in its workerData, and
  // runs `WORKER_START` before anything else, so that it can end the
  // process even if it never gets that far.
  //
  // Node starts the worker on those lines, as `eval` code that then runs
  // the entry the way Node runs a worker's file: `process.argv[1]` set to
  // it, and `Module.runMain`, which runs the `--import` loaders first and
  // makes the entry the main module, `require.main` and `import.meta.main`
  // as before. An `import()` of the entry does neither, and an eval worker
  // runs no `--import` of its own (measured, Node 20–26). Bun's eval worker
  // loses both a failure of the entry and `require.main` (measured, Bun
  // 1.4), so there the entry stays the worker's own and the lines go in as
  // its preload, base64-encoded: percent-encoded, Bun skipped them without
  // an error.
  //
  // No `execArgv`: a Worker given none inherits the node flags the process
  // started with, and among them a loader like `--import tsx`, which is what
  // lets the worker load a .jsx entry at all. Handed `process.execArgv`
  // instead, it refuses the whole list over one V8 or process-wide flag —
  // `--expose-gc`, `--max-old-space-size`, `--title` — which the worker
  // would have had anyway, since those hold for every thread: it gets `gc`
  // either way (measured, Node 20–26; Bun treats the two the same).
  const options = {
    argv: process.argv.slice(2),
    env: SHARE_ENV,
    workerData: { reactX11State: state.buffer },
  };
  const start = `${WORKER_START}(process, globalThis);\n`;
  if (globalThis.Bun) {
    const source = Buffer.from(start).toString('base64');
    new Worker(entry, {
      ...options,
      preload: [`data:text/javascript;base64,${source}`],
    });
  } else {
    new Worker(
      `${start}process.argv[1] = ${JSON.stringify(entry)};\n` +
        "process.getBuiltinModule('node:module').runMain(process.argv[1]);\n",
      { ...options, eval: true },
    );
  }
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
