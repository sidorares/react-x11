// The app half of test/cocoa-threaded-launch.test.js, run under
// `node --import ./src/cocoa/main.js`: a window and its first frame, and
// what the app can see of the thread it is on — reported on stdout, which
// is itself under test (a worker's stdout forwards through its parent's
// event loop, and the launcher parks the parent).
//
//   report  print the report and exit 0
//   exit    print it, then process.exit(7) — with an exit handler that
//           takes its time, so the main thread is back from AppKit well
//           before the worker is gone
//   throw   throw once the window is up
//   idle    print it, close the window and let the script run out
//
// With no mode it does nothing: the test runner runs every file under
// test/ as a test of its own, and on Linux there is no window to open.
import { isMainThread } from 'node:worker_threads';
import React from 'react';

import { createRoot } from '../../src/index.js';

const mode = process.argv[2];
if (mode) await run(mode);

async function run(mode) {
  const root = await createRoot({ backend: 'cocoa' });
  root.render(
    React.createElement(
      'window',
      { title: 'threaded', width: 160, height: 100 },
      React.createElement('text', null, 'on a worker'),
    ),
  );

  const app = root.app;
  const deadline = Date.now() + 5000;
  let wnd = null;
  while (Date.now() < deadline) {
    wnd = [...app._windows.values()][0] ?? null;
    if (wnd?.windowNumber != null && wnd._presentedAt > 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }

  if (mode === 'throw') throw new Error('thrown by the app');

  console.log(
    JSON.stringify({
      isMainThread,
      threaded: app._threaded,
      made: wnd?.windowNumber != null,
      presented: (wnd?._presentedAt ?? 0) > 0,
      scale: app.scale,
      entry: process.argv[1].endsWith('cocoa-threaded-app.js'),
    }),
  );
  if (mode === 'exit') {
    process.on('exit', () => {
      for (const t = Date.now(); Date.now() - t < 700;);
    });
  }
  if (mode === 'idle') {
    // nothing left open: the worker's script runs out, and the process with it
    await root.unmount();
  } else {
    process.exit(mode === 'exit' ? 7 : 0);
  }
}
