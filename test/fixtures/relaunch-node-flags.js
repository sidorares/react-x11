// The app half of the node-flags test in test/cocoa-relaunch.test.js: an
// entry that moves itself onto a worker with the relaunch react-x11's
// import makes on macOS (src/cocoa/relaunch.js). The worker never asks for
// AppKit, so a stand-in for the bridge is enough, on any OS.
//
//   report  on the worker, print what it runs with — on fd 1, since its
//           own stdout forwards through the parked main thread — and end
//           the process with code 3: a bare process.exit, which the lines
//           the worker starts on pass to the main thread
//
// With no mode it does nothing: the test runner runs every file under
// test/ as a test of its own.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';

import { relaunch } from '../../src/cocoa/relaunch.js';

const noAppKit = () => {
  throw new Error('the worker asked for AppKit');
};

if (process.argv[2] !== 'report') {
  // not under test
} else if (isMainThread) {
  relaunch(fileURLToPath(import.meta.url), {
    initApp: noAppKit,
    runMain: noAppKit,
  });
} else {
  const report = {
    isMainThread,
    gc: typeof globalThis.gc,
    title: process.title,
    preloaded: globalThis.preloaded ?? false,
    execArgv: process.execArgv,
    argv: process.argv.slice(1),
  };
  fs.writeSync(1, `${JSON.stringify(report)}\n`);
  process.exit(3);
}
