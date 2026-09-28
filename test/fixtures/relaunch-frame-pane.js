// The pane half of the <Frame> test in test/cocoa-relaunch.test.js: an entry
// forked the way `<Frame>` forks its pane (src/frame/index.js) — node's IPC
// channel, REACT_X11_FRAME=1 — that imports react-x11 and says which thread
// its body ran on and whether it has the channel. No root is made, so no
// AppKit is asked for, wherever it runs.
//
//   report  print that, on fd 1 — a worker's own stdout forwards through the
//           parked main thread — and exit
//
// With no mode it does nothing: the test runner runs every file under
// test/ as a test of its own.
import fs from 'node:fs';
import { isMainThread } from 'node:worker_threads';

import '../../src/index.js';

if (process.argv[2] === 'report') {
  const report = { isMainThread, send: typeof process.send };
  fs.writeSync(1, `${JSON.stringify(report)}\n`);
  process.exit(0);
}
