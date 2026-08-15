// The layout engine react-x11 owns (src/yoga.js).
//
// It used to be ntk's, because ntk's document widgets laid out with flexbox
// too and two WASM instances would have meant nodes from one engine mixed
// with nodes from the other. Those widgets are gone; the renderer is the
// only layout consumer left, and this is where the engine lives now.
//
// Two things are pinned here. The **enum names**, because `styles.js` builds
// its lookup tables from flat SCREAMING_CASE constants derived from yoga's
// typed enums — a rename upstream would otherwise yield `undefined` in a
// setter rather than an error. And the **shape**: enums synchronously,
// assembly behind `loadLayout()`, so that no top-level await enters the
// module graph (see the bundling test at the bottom, and docs/packaging.md).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { loadYoga } from 'yoga-layout/load';

import { Yoga, loadLayout, layoutLoaded } from '../src/yoga.js';

test('enum constants are readable without loading anything', () => {
  // styles.js builds its lookup tables at module scope and must not have to
  // await first
  assert.equal(typeof Yoga.FLEX_DIRECTION_ROW, 'number');
  assert.equal(typeof Yoga.JUSTIFY_SPACE_EVENLY, 'number');
  assert.equal(typeof Yoga.ALIGN_BASELINE, 'number');
  assert.equal(typeof Yoga.EDGE_TOP, 'number');
  assert.equal(typeof Yoga.DIRECTION_LTR, 'number');
  assert.equal(typeof Yoga.MEASURE_MODE_UNDEFINED, 'number');
  assert.equal(typeof Yoga.WRAP_NO_WRAP, 'number');
});

test('using the assembly before it is loaded says so', async () => {
  // a fresh module instance, because the rest of this file loads the engine
  const fresh = await import('../src/yoga.js?before-load');
  assert.equal(fresh.layoutLoaded(), false);
  assert.throws(
    () => fresh.default.Node.create(),
    /layout engine is not loaded/,
  );
});

test('loadLayout() makes it functional, and is idempotent', async () => {
  const loaded = await loadLayout();
  assert.equal(loaded, Yoga, 'resolves with the object it filled in');
  assert.equal(await loadLayout(), Yoga, 'a second call is the same instance');
  assert.equal(layoutLoaded(), true);

  const node = Yoga.Node.create();
  node.setWidth(100);
  node.calculateLayout(100, 100, Yoga.DIRECTION_LTR);
  assert.equal(node.getComputedWidth(), 100);
  node.free();
});

test('every constant react-x11 generates matches the assembly', async () => {
  await loadLayout();
  const real = await loadYoga();
  const names = Object.keys(real).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
  assert.ok(
    names.length > 50,
    `expected yoga's constants, found ${names.length}`,
  );
  for (const name of names)
    assert.equal(Yoga[name], real[name], `constant ${name}`);
});

// --- bundling ---------------------------------------------------------------
//
// react-x11 must stay bundleable as CommonJS. Node's single-executable format
// runs its embedded main as CommonJS, and esbuild refuses to emit CommonJS for
// a module graph containing top-level await ("Top-level await is currently not
// supported with the cjs output format"). One import can take that away from
// every app: `yoga-layout`'s default entry is
// `const Yoga = wrapAssembly(await loadYoga())`. `src/yoga.js` exists to keep
// it out of the graph — see docs/packaging.md. Carried over from ntk, which
// held this line while the engine was still its.

const srcDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src');

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
}

test('nothing in src/ imports the top-level-await yoga entry', () => {
  const offenders = sources(srcDir)
    .filter((path) =>
      /from\s+['"]yoga-layout['"]|import\(['"]yoga-layout['"]\)/.test(
        readFileSync(path, 'utf8'),
      ),
    )
    .map((path) => path.slice(srcDir.length + 1));
  assert.deepEqual(
    offenders,
    [],
    "import from 'yoga-layout/load' instead — the default entry is a " +
      'top-level await, which makes every bundle containing react-x11 ESM-only',
  );
});
