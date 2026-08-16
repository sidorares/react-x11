// End-to-end: the supported hot-reload entry point (react-x11/refresh).
// A child process runs test/fixtures/refresh/entry.jsx — an ordinary app
// entry — under `node --import src/refresh/register.js`, rendering against
// the in-process X server. The test edits the hot module on disk and
// asserts three things off the child's stdout: the reload happened
// (onReload fired), the edited code is live (new VERSION token), and hook
// state survived (the same useState id).
//
// The fixture is copied to a scratch sibling first (same depth, so its
// relative imports still resolve inside the repo) because the test
// rewrites it while it runs.
import { test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const supported = typeof nodeModule.registerHooks === 'function';

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));
const registerUrl = pathToFileURL(
  fileURLToPath(new URL('../src/refresh/register.js', import.meta.url)),
).href;

test(
  'an edit re-renders in place: connection, window and hook state survive',
  { skip: supported ? false : 'module.registerHooks needs Node >= 22.15' },
  async () => {
    const dir = join(fixturesDir, `refresh-run-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    cpSync(join(fixturesDir, 'refresh'), dir, { recursive: true });

    const child = spawn(
      process.execPath,
      ['--import', registerUrl, join(dir, 'entry.jsx')],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    const waiters = new Set();
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (const check of [...waiters]) check();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    // Resolves once `pattern` matches the whole stdout so far.
    const waitFor = (pattern, what, timeoutMs = 30000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const match = stdout.match(pattern);
          if (match) {
            waiters.delete(check);
            clearTimeout(timer);
            resolve(match);
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(
              `timed out waiting for ${what}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
            ),
          );
        }, timeoutMs);
        waiters.add(check);
        check();
      });

    try {
      const first = await waitFor(/RENDER (\w+) v1/, 'the initial render');
      await waitFor(/READY/, 'the mount to finish');
      const id = first[1];

      // Let the file watcher settle on the freshly-copied tree before
      // editing, or the change event can race the watch registration.
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const appFile = join(dir, 'app.jsx');
      const edited = readFileSync(appFile, 'utf8').replace(
        `const VERSION = 'v1';`,
        `const VERSION = 'v2';`,
      );
      assert.notStrictEqual(
        edited,
        readFileSync(appFile, 'utf8'),
        'the fixture edit must change the file',
      );
      writeFileSync(appFile, edited);

      const second = await waitFor(/RENDER (\w+) v2/, 'the hot re-render');
      assert.strictEqual(
        second[1],
        id,
        'useState state should survive the reload',
      );
      await waitFor(/RELOAD refreshed=true count=1/, 'the onReload event');
      assert.ok(!stderr.includes('Error'), `child logged an error:\n${stderr}`);
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
