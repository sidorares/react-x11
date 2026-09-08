// The cocoa backend's native-bridge loader (src/cocoa/native.js), under the
// one condition nothing else in this suite creates: a bundle with no
// `import.meta.url`. Node's single-executable format (docs/packaging.md,
// tier 3) runs its embedded main as CommonJS, and esbuild's `cjs` output
// leaves `import.meta` an empty object (its `empty-import-meta` warning), so
// a `createRequire(import.meta.url)` at module scope threw
// ERR_INVALID_ARG_VALUE the moment the backend loaded — every cocoa app
// shipped as a SEA, before the loader could say what it was looking for.
//
// The module is re-read here with esbuild's rewrite applied by hand —
// `import.meta` becomes an empty `import_meta` — which pins the same shape a
// bundler produces without needing one in the test: the module must import,
// `REACT_X11_CALAYERS_PATH` must still load, and with nothing to load the
// error must still be the backend's own, naming what it tried, rather than
// the loader's complaint about its missing URL.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const SOURCE = new URL('../src/cocoa/native.js', import.meta.url);

/**
 * `fn` as the loader sees a mac — it refuses any other platform before it
 * looks at a path, and CI runs this on Linux — with REACT_X11_CALAYERS_PATH
 * naming `path`. Both are restored: a developer's shell may already name a
 * bridge of its own.
 */
function asMac(path, fn) {
  const platform = process.platform;
  const env = process.env.REACT_X11_CALAYERS_PATH;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  process.env.REACT_X11_CALAYERS_PATH = path;
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: platform });
    if (env === undefined) delete process.env.REACT_X11_CALAYERS_PATH;
    else process.env.REACT_X11_CALAYERS_PATH = env;
  }
}

describe('src/cocoa/native.js in a CommonJS bundle, without import.meta.url', () => {
  let dir;
  let bundled;

  before(() => {
    const source = readFileSync(SOURCE, 'utf8');
    assert.ok(
      source.includes('import.meta.url'),
      'the loader is built from import.meta.url',
    );
    assert.doesNotMatch(
      source,
      /from\s+['"]\./,
      'the module is copied out of the tree, so it can have no relative imports',
    );
    dir = mkdtempSync(join(tmpdir(), 'react-x11-sea-'));
    writeFileSync(
      join(dir, 'native.mjs'),
      'const import_meta = {};\n' +
        source.replaceAll('import.meta', 'import_meta'),
    );
    // shaped like @windowkit/appkit's index.js: the addon under `native`
    writeFileSync(
      join(dir, 'bridge.cjs'),
      'module.exports = { native: { addon: true } };\n',
    );
    bundled = pathToFileURL(join(dir, 'native.mjs')).href;
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test('imports, and REACT_X11_CALAYERS_PATH still loads', async () => {
    const { loadNative } = await import(`${bundled}?loads`);
    assert.deepEqual(asMac(join(dir, 'bridge.cjs'), loadNative), {
      addon: true,
    });
  });

  test("with nothing to load, the error is the backend's, naming what it tried", async () => {
    const { loadNative } = await import(`${bundled}?nothing`);
    const missing = join(dir, 'missing.node');
    assert.throws(
      () => asMac(missing, loadNative),
      (err) => {
        assert.match(err.message, /needs the @windowkit\/appkit native bridge/);
        assert.ok(err.message.includes(`\n  ${missing}: `), err.message);
        assert.ok(err.message.includes('\n  @windowkit/appkit: '), err.message);
        // the loader's own complaint, which is what a SEA used to die with
        assert.doesNotMatch(err.message, /must be a file URL/);
        return true;
      },
    );
  });
});
