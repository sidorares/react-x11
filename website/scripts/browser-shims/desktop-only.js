// Browser stub for the node builtins the **file dialog** reaches for:
// `node:crypto` (a Request token), `node:child_process` (`osascript`),
// `node:url` (`file://` URIs → paths) and `node:fs/promises` (the built-in
// browser's directory reads).
//
// Every one of them is behind a *dynamic* import inside a function, so nothing
// here is touched by loading the bundle — but esbuild follows a dynamic import
// as readily as a static one, and four unresolvable builtins fail the build.
//
// Callable and throwing rather than silently empty: a file dialog is not a
// thing a web page can have, and the honest answer to `openFile()` in the
// playground is a message saying so. `sessionBus()` already answers `null`
// there (see stubs/dbus-native.js), so the portal rung is never reached — only
// a demo that rendered `<FileDialog>` directly gets here.
const nope = (what) => () => {
  throw new Error(
    `react-x11 playground: ${what} needs a desktop — there is no filesystem, ` +
      'no process spawning and no file dialog in a browser.',
  );
};

module.exports = {
  // node:crypto
  randomBytes: nope('randomBytes'),
  // node:child_process
  execFile: nope('execFile'),
  // node:url — a real implementation would be four lines, but returning a
  // path that cannot be opened is worse than saying there is no filesystem.
  fileURLToPath: nope('fileURLToPath'),
  // node:fs/promises
  readdir: nope('readdir'),
  stat: nope('stat'),
  readFile: nope('readFile'),
  default: {},
};
