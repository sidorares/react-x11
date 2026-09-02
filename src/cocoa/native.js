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

const require = createRequire(import.meta.url);

const PACKAGE = '@windowkit/appkit';

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
      const mod = require(spec);
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
