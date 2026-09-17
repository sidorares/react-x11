// `createSettings` (#592): what an app remembers between launches.
//
// The store's promises are about the file, so the file is what is checked,
// in a temporary directory: nothing is written until something changes; a
// stream of changes is one write, and a change that never stops is still
// written every second; a write is a temporary file and a rename, so a
// failure leaves the old file whole; what is unsaved when the process exits
// is written on the way out, which a child process shows. And the hook is a
// `useState` every component shares.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import {
  createSettings,
  resetSettingsForTests,
  settingsBaseDir,
} from '../src/settings.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'react-x11-settings-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  resetSettingsForTests();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

const APP = 'com.example.hush';
const readFile = (path) => JSON.parse(fs.readFileSync(path, 'utf8'));

test('the per-user directory for settings, per platform', () => {
  const home = '/home/u';
  assert.equal(
    settingsBaseDir({ platform: 'darwin', env: {}, home }),
    '/home/u/Library/Application Support',
  );
  assert.equal(
    settingsBaseDir({ platform: 'linux', env: {}, home }),
    '/home/u/.config',
  );
  assert.equal(
    settingsBaseDir({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/x' },
      home,
    }),
    '/x',
  );
  assert.equal(
    settingsBaseDir({ platform: 'win32', env: { APPDATA: 'C:/r' }, home }),
    'C:/r',
  );
  const settings = createSettings({ appId: APP });
  assert.equal(settings.path, join(settingsBaseDir(), APP, 'settings.json'));
});

test('the defaults until something is saved, and nothing written until then', async () => {
  const directory = tempDir();
  const settings = createSettings({
    appId: APP,
    directory,
    defaults: { volume: 0.5, noise: 'brown' },
  });
  assert.equal(settings.get('volume'), 0.5);
  assert.equal(settings.get('unset'), undefined);
  assert.equal(settings.get('unset', 3), 3);
  await settings.flush();
  assert.equal(fs.existsSync(settings.path), false);
});

test('a change is seen at once and saved a moment later, and a new launch reads it', async () => {
  const directory = tempDir();
  const settings = createSettings({ appId: APP, directory, delay: 20 });
  let heard = 0;
  settings.subscribe(() => heard++);
  settings.set('volume', 0.8);
  assert.equal(settings.get('volume'), 0.8);
  assert.equal(heard, 1);
  assert.equal(fs.existsSync(settings.path), false, 'not yet');
  // a moment later — how long the disk takes under a full test run is its own
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(settings.path) && Date.now() < deadline) {
    await sleep(10);
  }
  assert.deepEqual(readFile(settings.path), { volume: 0.8 });
  settings.set('volume', 0.8);
  assert.equal(heard, 1, 'the same value again is not a change');

  resetSettingsForTests(); // the next launch
  const again = createSettings({ appId: APP, directory });
  assert.equal(again.get('volume'), 0.8);
});

/** A filesystem in memory whose writes finish within a turn of microtasks —
 *  so under mocked timers, when a write happens is decided by the store and
 *  not by how busy the disk is. */
function memoryFs() {
  const files = new Map();
  const counts = { renames: 0 };
  const promises = {
    mkdir: async () => {},
    open: async (path) => ({
      writeFile: async (text) => files.set(path, String(text)),
      sync: async () => {},
      close: async () => {},
    }),
    rename: async (from, to) => {
      counts.renames++;
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    files,
    counts,
    fs: {
      promises,
      readFileSync: (path) => {
        if (!files.has(path)) throw missing();
        return files.get(path);
      },
      mkdirSync: () => {},
      writeFileSync: (path, text) => files.set(path, String(text)),
      renameSync: (from, to) => promises.rename(from, to),
    },
  };
}

test('a stream of changes is one write, and one that never stops is written every half second', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { fs: memory, files, counts } = memoryFs();
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const settings = createSettings({
    appId: APP,
    directory: '/memory',
    fs: memory,
    delay: 200,
    maxWait: 500,
  });
  for (let i = 0; i < 20; i++) settings.set('volume', i / 20);
  t.mock.timers.tick(199);
  await settle();
  assert.equal(counts.renames, 0, 'not before the delay');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(counts.renames, 1, 'twenty changes, one write');
  assert.equal(JSON.parse(files.get(settings.path)).volume, 19 / 20);

  // a drag: a change every 10ms for a second, each one putting the write
  // off — so the once-a-half-second bound is what writes, twice
  counts.renames = 0;
  for (let i = 0; i < 100; i++) {
    settings.set('volume', i);
    t.mock.timers.tick(10);
    await settle();
  }
  assert.equal(counts.renames, 2, 'written at 500ms and at 1000ms');
  await settings.flush();
  assert.equal(counts.renames, 2, 'and nothing was left over');
  assert.equal(JSON.parse(files.get(settings.path)).volume, 99);
});

test('a failed write leaves the saved file whole, and the next one tries again', async () => {
  const directory = tempDir();
  const settings = createSettings({ appId: APP, directory, delay: 100000 });
  settings.set('volume', 0.1);
  await settings.flush();

  resetSettingsForTests();
  let fail = true;
  const failing = {
    ...fs,
    promises: {
      ...fs.promises,
      open: async (path, flags) => {
        const handle = await fs.promises.open(path, flags);
        if (!fail) return handle;
        // half a file, then the disk gives out
        return {
          writeFile: async () => {
            await handle.writeFile('{"volu');
            throw new Error('ENOSPC: no space left on device');
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      },
    },
  };
  const broken = createSettings({
    appId: APP,
    directory,
    fs: failing,
    delay: 100000,
  });
  broken.set('volume', 0.9);
  await assert.rejects(broken.flush(), /ENOSPC/);
  assert.deepEqual(readFile(broken.path), { volume: 0.1 }, 'the old file');
  fail = false;
  await broken.flush();
  assert.deepEqual(readFile(broken.path), { volume: 0.9 }, 'and then the new');
});

test('what is unsaved when the process exits is written on the way out', () => {
  const directory = tempDir();
  const settingsModule = new URL('../src/settings.js', import.meta.url).href;
  const script = (mode) => `
    import { createSettings } from ${JSON.stringify(settingsModule)};
    const settings = createSettings({ appId: 'com.example.hush', directory: ${JSON.stringify(directory)} });
    settings.set('mode', ${JSON.stringify(mode)});
    ${mode === 'mid-write' ? 'settings.flush();' : ''}
    process.exit(0);
  `;
  for (const mode of ['pending', 'mid-write']) {
    const run = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script(mode)],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(
      readFile(join(directory, 'settings.json')),
      { mode },
      `saved when the exit came ${mode === 'pending' ? 'inside the delay' : 'during a write'}`,
    );
  }
});

test('a file that is not JSON gives the defaults, says so, and is replaced by the next change', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const directory = tempDir();
  fs.writeFileSync(join(directory, 'settings.json'), '{ not json');
  const settings = createSettings({
    appId: APP,
    directory,
    defaults: { volume: 0.5 },
  });
  assert.equal(settings.get('volume'), 0.5);
  assert.match(warnings[0] ?? '', /are not a JSON object/);
  settings.set('volume', 0.6);
  await settings.flush();
  assert.deepEqual(readFile(settings.path), { volume: 0.6 });
});

test('reset forgets the saved value, and the file with it', async () => {
  const directory = tempDir();
  const settings = createSettings({
    appId: APP,
    directory,
    defaults: { volume: 0.5 },
  });
  settings.set('volume', 0.9);
  settings.set('dark', true);
  settings.reset('volume');
  assert.equal(settings.get('volume'), 0.5);
  await settings.flush();
  assert.deepEqual(readFile(settings.path), { dark: true });
});

test('one store per file: the same app id shares its values', () => {
  const directory = tempDir();
  const a = createSettings({ appId: APP, directory });
  const b = createSettings({ appId: APP, directory, defaults: { x: 1 } });
  a.set('volume', 0.3);
  assert.equal(b.get('volume'), 0.3);
  assert.equal(a.get('x'), 1, 'the latest defaults stand for both');
});

test('what cannot be a setting says so', () => {
  assert.throws(() => createSettings({ appId: 'hush' }), /reverse-DNS/);
  assert.throws(
    () => createSettings({ appId: '../etc.passwd' }),
    /reverse-DNS/,
  );
  assert.throws(
    () => createSettings({ appId: APP, directory: tempDir(), defaults: 3 }),
    /expected an object/,
  );
  const settings = createSettings({ appId: APP, directory: tempDir() });
  assert.throws(() => settings.set('f', () => {}), TypeError);
  assert.throws(() => settings.set('n', 10n), TypeError);
  assert.throws(() => settings.set('u', undefined), /use reset/);
});

test('use is a useState every component shares', async () => {
  const directory = tempDir();
  const settings = createSettings({
    appId: APP,
    directory,
    defaults: { volume: 0.5 },
  });
  const seen = { a: [], b: [] };
  let setFromA;
  const A = () => {
    const [volume, setVolume] = settings.use('volume');
    setFromA = setVolume;
    seen.a.push(volume);
    return null;
  };
  const B = () => {
    const [volume] = settings.use('volume');
    const [shape] = settings.use('shape', { sides: 4 });
    seen.b.push([volume, shape.sides]);
    return null;
  };
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h('window', { width: 100, height: 100 }, h(A), h(B)));
  await tick();
  assert.equal(seen.a.at(-1), 0.5);
  setFromA(0.7);
  await tick();
  assert.equal(seen.b.at(-1)[0], 0.7, 'the other component sees it');
  setFromA((v) => Math.round((v + 0.1) * 10) / 10);
  await tick();
  assert.equal(seen.a.at(-1), 0.8, 'the updater form');
  settings.set('volume', 0.2);
  await tick();
  assert.equal(seen.b.at(-1)[0], 0.2, 'a set from outside React too');
  // an object literal as the fallback settles instead of rendering forever
  assert.ok(seen.b.length < 10, `rendered ${seen.b.length} times`);
  assert.equal(seen.b.at(-1)[1], 4);
  await root.unmount();
  await settings.flush();
  assert.deepEqual(readFile(settings.path), { volume: 0.2 });
});
