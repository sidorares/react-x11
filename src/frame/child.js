// The file a `<Frame>` forks. Everything of substance is in childmain.js
// behind the transport seam; this is the seam's other resident — the one
// transport a fork actually has, node's IPC channel, wired straight off
// `process`. Kept import-light and JSX-free on purpose: it runs before
// anything decided what loaders this process has.

import { runFrameChild } from './childmain.js';

if (typeof process.send !== 'function') {
  console.error(
    'react-x11: frame/child.js is the entry a <Frame> forks — it needs the ' +
      'IPC channel fork() sets up, and cannot be run directly.',
  );
  process.exit(1);
}

runFrameChild({
  send: (msg) => {
    try {
      process.send(msg);
    } catch {
      // the parent's end is closing; its exit handling takes it from here
    }
  },
  onMessage: (cb) => {
    process.on('message', cb);
    return () => process.off('message', cb);
  },
  onDisconnect: (cb) => {
    process.on('disconnect', cb);
    return () => process.off('disconnect', cb);
  },
});
