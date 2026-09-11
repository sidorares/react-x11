// What the launcher (src/cocoa/main.js) runs on the worker in place of the
// app's entry: the bootstrap of src/cocoa/threaded.js, then the entry
// itself. After it the app cannot tell it is on a worker, short of asking —
// its logs reach the terminal, `process.exit` ends the process, a Ctrl-C
// reaches its `process.on('SIGINT')`, and `process.argv[1]` is its script.
import { pathToFileURL } from 'node:url';
import { workerData } from 'node:worker_threads';

import { loadNative } from './native.js';
import {
  forwardSignals,
  installStdio,
  openThreadedChannel,
  routeExit,
} from './threaded.js';

const entry = workerData.reactX11Entry;
const native = loadNative();

installStdio();
routeExit(native);
openThreadedChannel(native).subscribe(forwardSignals());
process.argv[1] = entry;

// The launcher calls `runMain` just after starting this worker, and until
// it runs the bridge has published nothing: an app that asked first got
// `listScreens()` as [] and took scale 1 on a 2x panel (measured, the
// entry's first line 50ms ahead of the run). A worker starts in tens of
// milliseconds, a function call does not, so this rarely waits at all.
while (!native.threaded()) await new Promise((r) => setTimeout(r, 1));

await import(pathToFileURL(entry).href);
