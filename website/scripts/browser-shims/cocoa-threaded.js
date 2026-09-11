// Browser stub for the node builtins react-x11's Cocoa threaded mode imports:
// `node:worker_threads` (src/cocoa/app.js asks whether it is on a worker),
// and `node:console`, `node:stream` and `node:tty` (src/cocoa/threaded.js,
// the worker's stdio). Like zlib.js, that is the macOS backend only, which a
// browser never selects — but esbuild follows the dynamic import of the
// cocoa backend and bundles it, so the specifiers have to resolve. Callable
// and throwing rather than silently empty: there is no AppKit and no worker
// launcher in a web page, so none of this is reached, and a throw is the
// honest answer if it somehow were.
const nope = (what) =>
  function () {
    throw new Error(
      `react-x11 playground: ${what} belongs to the macOS backend's ` +
        'threaded mode and has no browser implementation.',
    );
  };

module.exports = {
  // node:worker_threads — the relaunch onto a worker (src/cocoa/relaunch.js)
  // never starts off macOS, so these are never called
  isMainThread: true,
  Worker: nope('Worker'),
  SHARE_ENV: undefined,
  workerData: null,
  // node:console, node:stream
  Console: nope('Console'),
  Writable: nope('Writable'),
  // node:tty
  isatty: () => false,
  WriteStream: nope('WriteStream'),
  default: {},
};
