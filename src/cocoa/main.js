// react-x11/cocoa-main — threaded mode's launcher, for `--import`:
//
//   node --import react-x11/cocoa-main app.jsx
//   bun --preload react-x11/cocoa-main app.jsx
//
// On macOS the process main thread is AppKit's — it is the only thread
// AppKit lets own a window — and while the app's JS runs there, every menu,
// drag, live resize and modal panel stops it (docs/macos.md §"JS on a
// worker: a UI thread of the bridge's own"). This module runs before the
// entry: on the main thread it starts a `worker_threads` Worker for the
// app, then parks the main thread in the bridge's `runMain()` — a real
// `[NSApp run]` — for the life of the app. The entry is never evaluated
// here: `runMain` does not return until the app has asked to exit, and
// the top-level await below holds the entry back until the process ends.
//
// Anywhere else it does nothing, so one command line serves every
// platform: on Linux the entry runs as it would without it, and so does a
// Worker the app starts itself (it inherits this `--import`).
import { isMainThread, SHARE_ENV, Worker } from 'node:worker_threads';

import { loadNative } from './native.js';

if (isMainThread && process.platform === 'darwin') await launch();

async function launch() {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error(
      'react-x11/cocoa-main: no entry script to run — start the app with ' +
        '`node --import react-x11/cocoa-main app.js`.',
    );
  }
  const native = loadNative();
  if (typeof native.runMain !== 'function') {
    throw new Error(
      'react-x11/cocoa-main: the installed @windowkit/appkit has no ' +
        'runMain() — threaded mode needs bridge 0.10 or later. Without the ' +
        'launcher the app runs on the main thread with the event pump.',
    );
  }
  // AppKit comes up before the worker starts, so that the gap between the
  // worker's first line and `runMain` — before which the bridge has
  // published nothing — is a function call, not an app launch.
  native.initApp();
  // The worker's entry is the bootstrap, which imports the app's: Bun does
  // not apply a `--preload` from execArgv to a Worker (measured, 1.4.0), so
  // this module run a second time could not be what sets the worker up.
  // execArgv still carries the rest — a loader like `--import tsx` is what
  // lets the worker import a .jsx entry at all.
  const worker = new Worker(new URL('./worker.js', import.meta.url), {
    argv: process.argv.slice(2),
    execArgv: process.execArgv,
    env: SHARE_ENV,
    workerData: { reactX11Entry: entry },
  });
  // Node hands the worker's uncaught error to this thread as an event, and
  // with no listener it was dropped when the exit below won the race —
  // listened for now, delivered once this thread is back from AppKit.
  let failed = false;
  worker.on('error', (err) => {
    failed = true;
    console.error(err);
  });
  const code = native.runMain();
  // Back from AppKit. Either the app asked to exit (`requestExit`: its
  // `process.exit`, a crash, a signal nobody listened for), and `code` is
  // what it asked for, or the worker ended without asking — its script ran
  // out with no window open — and its own exit code says how it went. In
  // both cases the worker's ending is still in flight, and the error it
  // may carry is only printed once it lands.
  await new Promise(() => {
    worker.once('exit', (workerCode) => {
      process.exit(code ?? (failed ? 1 : workerCode));
    });
    // a request that did not come with the worker's own exit behind it
    if (code != null) setTimeout(() => worker.terminate(), 1000).unref();
  });
}
