// react-x11/cocoa-main — threaded mode asked for by name, for `--import`:
//
//   node --import react-x11/cocoa-main app.jsx
//   bun --preload react-x11/cocoa-main app.jsx
//
// Threaded mode is the default on macOS without it: the first import of
// react-x11 moves the app onto a worker (src/cocoa/relaunch.js). This does
// the same before the entry is even loaded, and skips the checks that keep
// the automatic move from firing where it should not — so it is the way in
// for an app the automatic move declines (react-x11 imported late, say),
// and it spares the main thread from loading the entry's imports once for
// nothing (docs/packaging.md).
//
// On the worker it starts, Node runs this `--import` again, before the
// entry, and it sets the worker up there — earlier than the package's own
// import would (Bun does not apply a `--preload` to a Worker, and gets the
// import's). Anywhere else it does nothing, so one command line serves
// every platform: on Linux the entry runs as it would without it, and so
// does a Worker the app starts itself (it inherits this `--import`).
import { isMainThread, workerData } from 'node:worker_threads';

import { loadNative } from './native.js';
import { bootstrapWorker, relaunch } from './relaunch.js';

if (!isMainThread && workerData?.reactX11State) {
  bootstrapWorker(workerData.reactX11State);
} else if (isMainThread && process.platform === 'darwin') {
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
        'runMain() — threaded mode needs bridge 0.10 or later.',
    );
  }
  relaunch(entry, native);
}
