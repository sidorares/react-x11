// The bridge to @windowkit/appkit — the macOS Cocoa/Core Animation
// backend's native half. Resolved lazily so that importing react-x11 on
// Linux (or on a mac without the addon installed) costs nothing;
// `createRoot` only walks in here once the backend decision has landed on
// 'cocoa'. That laziness is what lets the package be an *optional*
// dependency: on Linux npm skips it (its `os` field is darwin-only) and
// nothing here ever asks for it.
//
// Resolution order: `REACT_X11_CALAYERS_PATH` (a checkout, for
// development), then the installed `@windowkit/appkit` package. The addon
// is CommonJS + a .node binary, so `createRequire` is the honest loader.
import { createRequire } from 'node:module';

const PACKAGE = '@windowkit/appkit';

// The loader is made on first use, and from the executable when there is
// no module URL to make it from. A bundle built for Node's single-executable
// format (docs/packaging.md, tier 3) is CommonJS, and esbuild leaves
// `import.meta` an empty object in that output — so a module-scope
// `createRequire(import.meta.url)` threw ERR_INVALID_ARG_VALUE the moment
// the backend loaded, in every cocoa app shipped as a SEA, before this
// could say what it was trying to load. `createRequire(process.execPath)`
// is the loader Node's SEA docs prescribe (the embedded main's `__filename`
// *is* the executable), and it answers both specs below: an absolute
// REACT_X11_CALAYERS_PATH resolves from anywhere, and the bare package name
// resolves through a `node_modules` beside the binary. Made lazily, a
// loader that cannot be made at all is reported by the error at the bottom
// rather than by a throw at import.
let require = null;
function load(spec) {
  require ??= createRequire(import.meta.url ?? process.execPath);
  return require(spec);
}

let cached = null;

export function loadNative() {
  if (cached) return cached;
  if (process.platform !== 'darwin') {
    throw new Error(
      "react-x11: the 'cocoa' backend is macOS-only. On this platform use " +
        'the X11 backend (the default when DISPLAY is set), or pass ' +
        "createRoot({ backend: 'x11' }).",
    );
  }
  const tried = [];
  const path = process.env.REACT_X11_CALAYERS_PATH;
  for (const spec of [path, PACKAGE].filter(Boolean)) {
    try {
      const mod = load(spec);
      // the package's index.js exports the raw addon as `native`; a direct
      // path to a built checkout may be the addon itself
      cached = mod.native ?? mod;
      return cached;
    } catch (err) {
      tried.push(`  ${spec}: ${err.message}`);
    }
  }
  throw new Error(
    `react-x11: the cocoa backend needs the ${PACKAGE} native bridge ` +
      'and none could be loaded:\n' +
      tried.join('\n') +
      `\nInstall it with \`npm install ${PACKAGE}\` (macOS, needs the ` +
      'Xcode command-line tools), or point REACT_X11_CALAYERS_PATH at a ' +
      'built checkout. To use X11 instead, set DISPLAY and pass ' +
      "createRoot({ backend: 'x11' }).",
  );
}
