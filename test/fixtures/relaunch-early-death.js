// The app half of the early-death test in test/cocoa-relaunch.test.js: an
// entry that moves itself onto a worker with the relaunch react-x11's
// import makes on macOS (src/cocoa/relaunch.js), then stops on the worker
// before anything of react-x11's has run there — the way an app does whose
// imports ahead of react-x11 make a call only a main thread may. The worker
// never gets as far as asking for AppKit, so a stand-in for the bridge is
// enough, on any OS.
//
//   chdir  on the worker, add an exit handler that takes its time, then
//          call process.chdir(), which a worker refuses
//
// With no mode it does nothing: the test runner runs every file under
// test/ as a test of its own.
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';

import { relaunch } from '../../src/cocoa/relaunch.js';

const noAppKit = () => {
  throw new Error('the worker asked for AppKit');
};

if (process.argv[2] !== 'chdir') {
  // not under test
} else if (isMainThread) {
  relaunch(fileURLToPath(import.meta.url), {
    initApp: noAppKit,
    runMain: noAppKit,
  });
} else {
  // The process ends after this, not halfway through it: slow on purpose,
  // so that a main thread told too early cuts it short. On fd 1, since the
  // worker's own stdout forwards through the parked main thread.
  process.on('exit', () => {
    const until = performance.now() + 300;
    while (performance.now() < until);
    fs.writeSync(1, 'the exit handler ran to its end\n');
  });
  process.chdir(os.tmpdir());
}
