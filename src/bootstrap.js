// What runs the moment react-x11 is imported, before any of the app's own
// code: each backend's chance to put the app where its platform wants it.
// Only the cocoa backend has one — AppKit keeps the process main thread, so
// an app on macOS moves onto a worker (src/cocoa/relaunch.js), and on that
// worker the same import sets it up. A Windows backend's UI thread will be
// the addon's own, and X11 has none, so neither needs this step
// (docs/windows.md §"Three shapes on Windows"). Imported first by
// src/index.js, so that it runs before the rest of the package.
import { isMainThread, workerData } from 'node:worker_threads';

import { bootstrapWorker, relaunchOnImport } from './cocoa/relaunch.js';

if (isMainThread) relaunchOnImport(import.meta.url);
else if (workerData?.reactX11State) bootstrapWorker(workerData.reactX11State);
