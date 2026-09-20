// The bridge to @windowkit/win32 — the Windows backend's native half.
// Resolved lazily so that importing react-x11 anywhere else costs nothing;
// `createRoot` only walks in here once the backend decision has landed on
// 'win32'. That laziness is what lets the package be an *optional* dependency:
// off Windows npm skips it (its `os` field is win32-only) and nothing here
// ever asks for it.
//
// Resolution order: `REACT_X11_WIN32_PATH` (a checkout, for development), then
// the installed `@windowkit/win32`. This mirrors src/cocoa/native.js down to
// the loader, including why `createRequire` is made from `process.execPath`
// when there is no module URL — a single-executable build (docs/packaging.md
// tier 3) is CommonJS, and esbuild leaves `import.meta` an empty object there.
import { createRequire } from 'node:module';

const PACKAGE = '@windowkit/win32';

let require = null;
function load(spec) {
  require ??= createRequire(import.meta.url ?? process.execPath);
  return require(spec);
}

let cached = null;

export function loadNative() {
  if (cached) return cached;
  if (process.platform !== 'win32') {
    throw new Error(
      "react-x11: the 'win32' backend is Windows-only. On this platform use " +
        'the X11 backend (the default when DISPLAY is set), or pass ' +
        "createRoot({ backend: 'x11' }).",
    );
  }
  const tried = [];
  const path = process.env.REACT_X11_WIN32_PATH;
  for (const spec of [path, PACKAGE].filter(Boolean)) {
    try {
      const mod = load(spec);
      cached = mod.native ?? mod;
      return cached;
    } catch (err) {
      tried.push(`  ${spec}: ${err.message}`);
    }
  }
  throw new Error(
    `react-x11: the win32 backend needs the ${PACKAGE} native bridge and ` +
      'none could be loaded:\n' +
      tried.join('\n') +
      `\nInstall it with \`npm install ${PACKAGE}\` (Windows; prebuilds ship ` +
      'for x64 and ARM64, and building from source needs Visual Studio with ' +
      'the "Desktop development with C++" workload). To use X11 instead, set ' +
      "DISPLAY and pass createRoot({ backend: 'x11' }).",
  );
}
