// ntk's package root — the X11 client, ntk's windows and their contexts —
// loads with the X11 backend rather than with react-x11 (src/ntkroot.js).
// The other backends use a handful of ntk's modules, each from a subpath of
// its own, and importing the root for them was ~210 ms of module loading on
// Windows before the first window of an app that never opens an X
// connection.
//
// Each case runs in a process of its own, under a loader hook that records
// every module loaded, so what it loaded is what it alone asked for.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url);

/** Every module URL a fresh process loaded running `code` (an ES module). */
function modulesLoadedBy(code) {
  const dir = mkdtempSync(join(tmpdir(), 'react-x11-lazy-ntk-'));
  try {
    const out = join(dir, 'loaded.txt');
    writeFileSync(
      join(dir, 'hooks.mjs'),
      `import { appendFileSync } from 'node:fs';
export async function load(url, context, next) {
  appendFileSync(${JSON.stringify(out)}, url + '\\n');
  return next(url, context);
}
`,
    );
    writeFileSync(
      join(dir, 'register.mjs'),
      `import { register } from 'node:module';
register(${JSON.stringify(pathToFileURL(join(dir, 'hooks.mjs')).href)});
`,
    );
    writeFileSync(out, '');
    execFileSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(join(dir, 'register.mjs')).href,
        '--input-type=module',
        '-e',
        code,
      ],
      { cwd: ROOT, env: { ...process.env, REACT_X11_NO_AUTORUN: '1' } },
    );
    return readFileSync(out, 'utf8').split('\n').filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ntkRoot = (urls) => urls.some((u) => /\/ntk\/lib\/index\.js$/.test(u));
const xClient = (urls) => urls.some((u) => /\/x11\/lib\/index\.js$/.test(u));

test('importing react-x11 loads neither ntk’s root nor the X11 client', () => {
  const urls = modulesLoadedBy(
    `await import(${JSON.stringify(new URL('src/index.js', ROOT).href)});`,
  );
  assert.ok(urls.length > 50, 'the import ran');
  assert.ok(!ntkRoot(urls), 'ntk’s root was loaded');
  assert.ok(!xClient(urls), 'the X11 client was loaded');
});

test('react-x11/ntk hands over the root it imports', async () => {
  const { ntkRoot: rootOf } = await import('../src/ntkroot.js');
  const ntk = await import('../src/ntk.js');
  const root = rootOf();
  assert.ok(root, 'the root is known once the subpath is imported');
  assert.strictEqual(root.cssColorStraight, ntk.cssColorStraight);
});
