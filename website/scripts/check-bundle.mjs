// Sanity gate for the built playground runtime: imports the ESM bundle in
// node (no DOM at all — nothing in it may touch `document` at load time),
// asserts the public surface is intact, and then does the thing the whole
// bundle exists for: renders a react-x11 component tree into the bundled
// pure-JS X server and reads the pixels back.
//
// That last part is what catches the failures a shape check cannot: two
// React copies (invalid hook call), a yoga WASM that did not load, fonts
// that did not resolve, a stub that got aliased over something real.
//
//   node scripts/build-demo-bundles.mjs && node scripts/check-bundle.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';

const websiteDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const bundle = path.join(websiteDir, 'static', 'demo', 'react-x11-runtime.js');

if (!fs.existsSync(bundle)) {
  console.error('bundle missing — run: node scripts/build-demo-bundles.mjs');
  process.exit(1);
}

// Put node in the browser's position before loading the bundle. The bundle
// carries its own Buffer polyfill and installs it only when there is no
// Buffer global — which is always true in a browser and never true here, so
// without this the x11 client would build packets with the polyfill while
// node's `Buffer.isBuffer` rejects them ("pack template must return a
// Buffer"). Deleting the global makes the bundle self-consistent, which is
// the state it actually ships in.
const nodeBuffer = globalThis.Buffer;
delete globalThis.Buffer;

const rx = await import(pathToFileURL(bundle));

// --- shape -----------------------------------------------------------------
assert.strictEqual(typeof rx.reactX11.createRoot, 'function', 'createRoot');
assert.strictEqual(typeof rx.reactX11.createStyles, 'function', 'createStyles');
assert.strictEqual(typeof rx.reactX11.Button, 'function', 'Button');
assert.strictEqual(typeof rx.React.useState, 'function', 'React.useState');
assert.strictEqual(typeof rx.ntk.createClient, 'function', 'ntk.createClient');
assert.strictEqual(typeof rx.x11.registerDisplayProtocol, 'function', 'x11');
assert.strictEqual(typeof rx.xserver.createServer, 'function', 'createServer');
assert.strictEqual(typeof rx.createStreamPair, 'function', 'createStreamPair');
assert.strictEqual(typeof rx.CanvasPresenter, 'function', 'CanvasPresenter');
assert.strictEqual(typeof rx.keyboardEventToKeysym, 'function', 'domkeys');
assert.strictEqual(typeof rx.setupFonts, 'function', 'setupFonts');
assert.strictEqual(typeof rx.transformJsx, 'function', 'transformJsx');
assert.ok(rx.glx && typeof rx.glx.createGlxExtension === 'function', 'glx');
assert.ok(globalThis.Buffer, 'Buffer global installed by the bundle');
assert.notStrictEqual(globalThis.Buffer, nodeBuffer, "it is the bundle's own");
assert.ok(globalThis.process?.env, 'process global installed by the bundle');

// yoga is what react-x11 lays out with, and since ntk 8 it is react-x11's own
// (`react-x11/yoga`) rather than something ntk re-exports. Its enums are there
// on import and the WebAssembly arrives with loadLayout() — which createRoot()
// calls, and which is what keeps top-level await out of the bundle (see the
// repo's docs/packaging.md). Both halves are checked: constants first, then
// the assembly, which is what breaks if the WASM ever fails to load here.
assert.strictEqual(
  typeof rx.yoga.Yoga?.FLEX_DIRECTION_ROW,
  'number',
  'yoga enums on import',
);
assert.strictEqual(
  rx.yoga.layoutLoaded(),
  false,
  'and not loaded before asked',
);
await rx.yoga.loadLayout();
assert.strictEqual(
  typeof rx.yoga.Yoga?.Node?.create,
  'function',
  'yoga assembly after loadLayout()',
);
assert.strictEqual(rx.yoga.layoutLoaded(), true, 'layoutLoaded() agrees');

// --- JSX transform ---------------------------------------------------------
const compiled = rx.transformJsx(
  'const el = <box style={{ gap: 4 }}>hi</box>;',
);
assert.match(compiled, /React\.createElement/, 'JSX compiles to classic calls');
assert.doesNotMatch(compiled, /jsx-runtime/, 'no automatic-runtime import');

// --- fonts -----------------------------------------------------------------
// fetch() has no file:// support in node, so read the copied faces off disk
const fontDir = path.join(path.dirname(bundle), 'fonts');
const source = await rx.setupFonts({
  read: async (file) =>
    new Uint8Array(fs.readFileSync(path.join(fontDir, file))),
});
for (const family of ['sans-serif', 'serif', 'monospace'])
  assert.ok(source.matchSorted({ family }).length >= 1, `${family} resolves`);

// --- the real thing: render a tree and read the pixels back ----------------
const server = rx.xserver.createServer({ width: 200, height: 120 });
const [clientEnd, serverEnd] = rx.createStreamPair();
server.addClientStream(serverEnd);

const app = await rx.ntk.createClient({ stream: clientEnd });
const root = await rx.reactX11.createRoot({ app });
const React = rx.React;

function Demo() {
  const [n] = React.useState(7);
  return React.createElement(
    'window',
    {
      width: 200,
      height: 120,
      title: 'check',
      style: { backgroundColor: '#ffffff' },
    },
    React.createElement(
      'box',
      {
        style: {
          width: 60,
          height: 40,
          margin: 20,
          backgroundColor: '#2980b9',
        },
      },
      React.createElement('text', { style: { color: '#ffffff' } }, String(n)),
    ),
  );
}

root.render(React.createElement(Demo));
await new Promise((resolve) => setTimeout(resolve, 400));
server.compose();

const pixels = server.root.raster.data;
const blue = 0x2980b9;
let blueCount = 0;
for (let i = 0; i < pixels.length; i++)
  if ((pixels[i] & 0xffffff) === blue) blueCount++;
assert.ok(
  blueCount > 500,
  `the <box> painted ${blueCount} px of #2980b9, expected the 60x40 rect`,
);

// text: hooks ran, fonts resolved, yoga measured — so some white-on-blue
// glyph pixels must be inside the box
const white = 0xffffff;
let glyphCount = 0;
for (let y = 20; y < 60; y++)
  for (let x = 20; x < 80; x++)
    if ((pixels[y * 200 + x] & 0xffffff) === white) glyphCount++;
assert.ok(glyphCount > 0, 'no text rendered inside the box (fonts? yoga?)');

console.log(
  `bundle ok (${(fs.statSync(bundle).size / 1024).toFixed(0)} KB; ` +
    `rendered ${blueCount} px box + ${glyphCount} px of glyphs, glx present)`,
);
process.exit(0);
