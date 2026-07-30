// Builds the in-browser runtime bundle for the playground:
//   (virtual entry) → static/demo/react-x11-runtime.js  (ESM)
//
// The bundle contains the whole stack a react-x11 program needs, minus the
// operating system:
//   - react-x11 itself (../src/index.js) and React 19
//   - ntk (the toolkit react-x11 renders through) and node-x11 (the wire)
//   - node-x11's pure-JS X server, plus its browser presentation layer
//     (CanvasPresenter, DOM → keysym mapping) and its GLX emulator, which
//     replays indirect-GLX protocol onto a WebGL2 context — that is what
//     makes <glarea> and the 3D scene elements work on this page
//   - setupFonts(): a StaticFontSource over the DejaVu TTFs copied next to
//     the bundle (fetched at boot, not embedded — 3.6 MB of base64 was most
//     of the bundle)
//   - transformJsx(): sucrase, so the editor can hold real JSX
//
// Output is **ESM**, not an IIFE: ntk's module graph and yoga-layout's WASM
// loader both use top-level await, which esbuild can only emit in that
// format. The runner loads it with <script type="module">.
//
// Note the two things that are NOT stubbed out here but are in ntk's own
// playground bundle: yoga-layout (react-x11's layout engine — react-x11
// imports Yoga *from* ntk so renderer and widgets share one WASM instance)
// and node-x11's GLX emulator.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { FONT_FILES } from './demo-font-files.mjs';

const require = createRequire(import.meta.url);
const websiteDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repoRoot = path.resolve(websiteDir, '..');
const scriptsDir = path.join(websiteDir, 'scripts');
const shimsDir = path.join(scriptsDir, 'browser-shims');
const stubsDir = path.join(scriptsDir, 'stubs');
const outFile = path.join(websiteDir, 'static', 'demo', 'react-x11-runtime.js');

const x11Dir = path.join(repoRoot, 'node_modules', 'x11');
const hasGlx = fs.existsSync(path.join(x11Dir, 'browser', 'glx', 'index.js'));
const profiling = !!process.env.REACT_X11_DEMO_PROFILE;

// Virtual entry. resolveDir is website/scripts so ./demo-fonts.js and the
// website's own devDependencies (dejavu-fonts-ttf, sucrase) resolve there,
// while 'react-x11', 'ntk' and 'x11' go through the aliases below.
const entrySource = [
  "export * as reactX11 from 'react-x11';",
  "export { default as React } from 'react';",
  "export * as ntk from 'ntk';",
  "export { default as x11 } from 'x11';",
  "export * as xserver from 'x11/lib/xserver/index.js';",
  "export { createStreamPair } from 'x11/lib/xserver/index.js';",
  "export { CanvasPresenter } from 'x11/browser/compositor.js';",
  "export { keyboardEventToKeysym } from 'x11/browser/domkeys.js';",
  hasGlx
    ? "export * as glx from 'x11/browser/glx/index.js';"
    : 'export const glx = null;',
  "export { setupFonts } from './demo-fonts.js';",
  "export { transformJsx } from './demo-jsx.js';",
].join('\n');

// Reconciler.js dynamically imports these two behind env vars we never set;
// they need `ws` and node:child_process, so redirect them to an inert stub.
// esbuild's `alias` only matches whole import specifiers, and these are
// relative paths, so it takes a resolver plugin.
const nodeOnlyModules = {
  name: 'react-x11-node-only',
  setup(build) {
    build.onResolve(
      { filter: /(DevToolsIntegration|ClickToComponent)\.js$/ },
      () => ({
        path: path.join(stubsDir, 'node-only.js'),
      }),
    );
  },
};

await esbuild.build({
  stdin: {
    contents: entrySource,
    resolveDir: scriptsDir,
    sourcefile: 'react-x11-demo-entry.js',
    loader: 'js',
  },
  bundle: true,
  outfile: outFile,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  // REACT_X11_DEMO_PROFILE=1 keeps names and emits a source map, so a V8
  // CPU profile of the playground names real functions instead of `mO`.
  // Never set in CI or on the deploy path.
  minify: !profiling,
  sourcemap: profiling ? 'inline' : false,
  logLevel: 'info',
  plugins: [nodeOnlyModules],
  // Development React: the playground is a place to learn the API, and the
  // messages that make a mistake obvious — react-x11 throwing "layout
  // property in a flat prop", React's key/hook warnings — only exist in the
  // development build. Both are routed to the console panel by the runner.
  define: { 'process.env.NODE_ENV': '"development"' },
  // Buffer/process globals for the bundled node-style code:
  inject: [path.join(shimsDir, 'globals.js')],
  alias: {
    // the renderer, the toolkit and the protocol client (single instances)
    'react-x11': path.join(repoRoot, 'src', 'index.js'),
    ntk: path.join(repoRoot, 'node_modules', 'ntk', 'lib', 'index.js'),
    x11: x11Dir,
    // ONE React. The entry resolves 'react' from website/node_modules
    // (docusaurus' copy) and react-x11 resolves it from the repo root —
    // two instances share no hook dispatcher, so every component would
    // throw "invalid hook call". Pin both to the repo's copy, which is the
    // one react-reconciler is built against.
    react: path.join(repoRoot, 'node_modules', 'react'),
    // real polyfills (installed as website devDependencies)
    buffer: require.resolve('buffer/'),
    'node:buffer': require.resolve('buffer/'),
    events: require.resolve('events/'),
    'node:events': require.resolve('events/'),
    process: require.resolve('process/browser'),
    'node:process': require.resolve('process/browser'),
    // inert stubs for node builtins reached only on node-only code paths
    net: path.join(shimsDir, 'net.js'),
    'node:net': path.join(shimsDir, 'net.js'),
    fs: path.join(shimsDir, 'fs.js'),
    'node:fs': path.join(shimsDir, 'fs.js'),
    os: path.join(shimsDir, 'os.js'),
    'node:os': path.join(shimsDir, 'os.js'),
    path: path.join(shimsDir, 'path.js'),
    'node:path': path.join(shimsDir, 'path.js'),
    util: path.join(shimsDir, 'util.js'),
    'node:util': path.join(shimsDir, 'util.js'),
    // createRequire, used by react-x11 to read its own package.json
    module: path.join(shimsDir, 'module.js'),
    'node:module': path.join(shimsDir, 'module.js'),
    // keysym reads its JSON tables with fs at load time; this build inlines them
    keysym: path.join(shimsDir, 'keysym.js'),
    // heavy optional ntk dep no demo needs
    pngjs: path.join(stubsDir, 'pngjs.js'),
  },
});

// The output is ESM in a .js file; say so, or node (which check-bundle.mjs
// imports it with) warns about reparsing it. Browsers ignore this file —
// they go by the <script type="module"> in the runner page.
fs.writeFileSync(
  path.join(path.dirname(outFile), 'package.json'),
  JSON.stringify({ type: 'module' }, null, 2) + '\n',
);

// The DejaVu faces sit next to the bundle, where demo-fonts.js fetches them
// from (relative to import.meta.url, so any base path works).
const fontDir = path.join(path.dirname(outFile), 'fonts');
fs.mkdirSync(fontDir, { recursive: true });
let fontBytes = 0;
for (const { file } of FONT_FILES) {
  const src = require.resolve(`dejavu-fonts-ttf/ttf/${file}`);
  fs.copyFileSync(src, path.join(fontDir, file));
  fontBytes += fs.statSync(src).size;
}

const kb = (n) => (n / 1024).toFixed(0);
console.log(
  `built ${path.relative(websiteDir, outFile)} ` +
    `(${kb(fs.statSync(outFile).size)} KB + ${kb(fontBytes)} KB fonts, ` +
    `glx: ${hasGlx ? 'included' : 'absent'})`,
);
