// What an app remembers between launches (#592): a store of JSON values in
// the per-user directory for this app, read once, written atomically, and
// coalesced so a slider's stream of changes is one write when it settles.
//
//   const settings = createSettings({
//     appId: 'com.example.Hush',
//     defaults: { noiseType: 'brown', volume: 0.5, dark: false },
//   });
//   const [volume, setVolume] = settings.use('volume');
//
// Every app that remembered anything did this by hand — a directory per
// platform, serialize, write, debounce — and the easy version of it is wrong
// in three quiet ways: a crash mid-write leaves half a file, a drag writes on
// every event, and quitting inside the debounce loses the last change.
//
// ## Where
//
// One JSON file, `settings.json`, in the app's own directory: under
// `~/Library/Application Support` on macOS and `$XDG_CONFIG_HOME` (`~/.config`)
// elsewhere. A file rather than `NSUserDefaults` on macOS, so the format and
// the behaviour are one thing on every platform. The directory is named by
// the app id, which is a reverse-DNS name like the one `registerApplication`
// takes — the store does not register anything, it only needs a name no
// other app is using.
//
// ## When it is read and written
//
// Read **synchronously**, the first time a value is asked for, so the first
// render already has what was saved: an asynchronous read would render the
// defaults and then jump. It is a small file read once. Written
// **asynchronously**, a quarter second after the last change and at least
// once a second while changes keep coming, through a temporary file and a
// rename, which is atomic: the file on disk is always the old one or the new
// one. Whatever is still waiting is written synchronously when the process
// exits, and `flush()` writes it now.
//
// Two processes of the same app share the file and the last write wins;
// nothing here watches for another process changing it.

import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { useCallback, useSyncExternalStore } from 'react';

/** A reverse-DNS app id: two or more dot-separated elements, the grammar
 *  `registerApplication` checks, which is also a safe directory name. */
const APP_ID_RE = /^[A-Za-z_-][A-Za-z0-9_-]*(\.[A-Za-z_-][A-Za-z0-9_-]*)+$/;

/** How long a change waits for the next one, and how long a stream of
 *  changes may put a write off. */
const DELAY_MS = 250;
const MAX_WAIT_MS = 1000;

/** The per-user directory apps keep their settings under, for a platform. */
export function settingsBaseDir({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support');
  }
  if (platform === 'win32') {
    return env.APPDATA || join(home, 'AppData', 'Roaming');
  }
  return env.XDG_CONFIG_HOME || join(home, '.config');
}

/** One store per file in a process, so a module evaluated twice — a hot
 *  reload — and two call sites naming the same app share their values
 *  rather than overwriting each other's writes. */
const stores = new Map();

/**
 * The settings store for `appId`: values read from and written to its
 * `settings.json`, with `defaults` for what was never saved.
 */
export function createSettings(options = {}) {
  const { appId, defaults = {}, directory, fs = nodeFs } = options;
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) {
    throw new Error(
      `react-x11: createSettings({ appId: ${JSON.stringify(appId)} }) — the ` +
        "app id names the app's settings directory, so it is a reverse-DNS " +
        'name no other app uses: two or more dot-separated elements of ' +
        '[A-Za-z_-][A-Za-z0-9_-]*, like "com.example.myapp".',
    );
  }
  if (defaults === null || typeof defaults !== 'object') {
    throw new Error(
      'react-x11: createSettings({ defaults }) — expected an object of each ' +
        "setting's value when nothing was saved, like { volume: 0.5 }.",
    );
  }
  const path = join(
    directory ?? join(settingsBaseDir(), appId),
    'settings.json',
  );
  let store = stores.get(path);
  if (!store) {
    store = new SettingsStore(path, fs, options);
    stores.set(path, store);
  }
  // the latest module's defaults win, as a reload's edit to them should
  store._defaults = { ...defaults };
  return store.api;
}

class SettingsStore {
  constructor(path, fs, { delay = DELAY_MS, maxWait = MAX_WAIT_MS }) {
    this.path = path;
    this.fs = fs;
    this.delay = delay;
    this.maxWait = maxWait;
    this._defaults = {};
    this._fallbacks = new Map(); // key -> the first object fallback asked with
    this._values = null; // what was saved, read on first use
    this._listeners = new Set();
    this._timer = null;
    this._firstPending = 0; // when the oldest unwritten change was made
    // Changes are counted, and a write records the count it wrote, so a
    // change is unsaved until a write *finished* with it in — which is what
    // the exit path asks, since a write still in flight when the process
    // exits never finishes.
    this._version = 0;
    this._savedVersion = 0;
    this._writing = null; // the write in flight
    this._onExit = () => this._flushSync();

    const store = this;
    this.api = {
      path,
      get: (key, fallback) => store.get(key, fallback),
      set: (key, value) => store.set(key, value),
      reset: (key) => store.reset(key),
      flush: () => store.flush(),
      subscribe: (listener) => store.subscribe(listener),
      /**
       * `[value, setValue]` for one setting, like `useState` — and every
       * component using the same key, in any window, sees the same value.
       */
      use(key, fallback) {
        const subscribe = useCallback(
          (listener) => store.subscribe(listener),
          [],
        );
        const value = useSyncExternalStore(subscribe, () =>
          store.get(key, fallback),
        );
        const setValue = useCallback(
          (next) =>
            store.set(
              key,
              typeof next === 'function'
                ? next(store.get(key, fallback))
                : next,
            ),
          [key, fallback],
        );
        return [value, setValue];
      },
    };
  }

  _load() {
    if (this._values) return this._values;
    this._values = {};
    let text;
    try {
      text = this.fs.readFileSync(this.path, 'utf8');
    } catch (err) {
      // never saved is the ordinary first launch; anything else is worth a line
      if (err?.code !== 'ENOENT') {
        console.warn(
          `react-x11: settings at ${this.path} could not be read ` +
            `(${err.message}); the defaults stand.`,
        );
      }
      return this._values;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this._values = parsed;
        return this._values;
      }
      throw new Error('not an object');
    } catch (err) {
      console.warn(
        `react-x11: settings at ${this.path} are not a JSON object ` +
          `(${err.message}); the defaults stand, and the next change ` +
          'replaces the file.',
      );
    }
    return this._values;
  }

  get(key, fallback) {
    const values = this._load();
    if (Object.hasOwn(values, key)) return values[key];
    if (Object.hasOwn(this._defaults, key)) return this._defaults[key];
    // An object literal is a new object every render, and a hook's snapshot
    // that changes every time it is read never settles: the first one stands.
    if (fallback !== null && typeof fallback === 'object') {
      if (!this._fallbacks.has(key)) this._fallbacks.set(key, fallback);
      return this._fallbacks.get(key);
    }
    return fallback;
  }

  set(key, value) {
    let text;
    try {
      text = JSON.stringify(value);
    } catch (err) {
      throw new TypeError(
        `react-x11: settings.set(${JSON.stringify(key)}) — the value has to ` +
          `be JSON: ${err.message}`,
      );
    }
    if (text === undefined) {
      throw new TypeError(
        `react-x11: settings.set(${JSON.stringify(key)}) — ${typeof value} is ` +
          'not a value JSON can keep; use reset() to go back to the default.',
      );
    }
    const values = this._load();
    if (Object.hasOwn(values, key) && values[key] === value) return;
    this._values = { ...values, [key]: value };
    this._changed();
  }

  reset(key) {
    const values = this._load();
    if (!Object.hasOwn(values, key)) return;
    const rest = { ...values };
    delete rest[key];
    this._values = rest;
    this._changed();
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  get _unsaved() {
    return this._savedVersion !== this._version;
  }

  _changed() {
    for (const listener of [...this._listeners]) listener();
    if (!this._unsaved) {
      this._firstPending = Date.now();
      process.once('exit', this._onExit);
    }
    this._version++;
    clearTimeout(this._timer);
    const waited = Date.now() - this._firstPending;
    const wait = Math.max(0, Math.min(this.delay, this.maxWait - waited));
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch((err) => {
        console.warn(
          `react-x11: settings at ${this.path} could not be written ` +
            `(${err.message}).`,
        );
      });
    }, wait);
    // a pending write must not be what keeps the process alive
    this._timer.unref?.();
  }

  /** Write what is waiting now. Resolves when it is on disk. */
  async flush() {
    clearTimeout(this._timer);
    this._timer = null;
    // one write at a time, and a change made during one is written after it;
    // the one before failing is that write's to report, not this one's
    while (this._writing) await this._writing.catch(() => {});
    if (!this._unsaved) return;
    const version = this._version;
    const text = `${JSON.stringify(this._values, null, 2)}\n`;
    this._writing = this._write(text).finally(() => {
      this._writing = null;
    });
    await this._writing;
    this._savedVersion = version;
    // saved, unless something changed while it was written
    if (!this._unsaved) process.removeListener('exit', this._onExit);
  }

  async _write(text) {
    const fs = this.fs.promises;
    const temp = `${this.path}.${process.pid}.tmp`;
    await fs.mkdir(dirname(this.path), { recursive: true });
    const handle = await fs.open(temp, 'w');
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, this.path);
  }

  /** The exit path, where nothing asynchronous runs any more. */
  _flushSync() {
    if (!this._unsaved) return;
    this._savedVersion = this._version;
    try {
      const temp = `${this.path}.${process.pid}.tmp`;
      this.fs.mkdirSync(dirname(this.path), { recursive: true });
      this.fs.writeFileSync(temp, `${JSON.stringify(this._values, null, 2)}\n`);
      this.fs.renameSync(temp, this.path);
    } catch (err) {
      console.warn(
        `react-x11: settings at ${this.path} could not be written on exit ` +
          `(${err.message}).`,
      );
    }
  }
}

/** Forget every store — for tests that create stores over temporary
 *  directories and want the next `createSettings` to read afresh. */
export function resetSettingsForTests() {
  for (const store of stores.values()) {
    clearTimeout(store._timer);
    process.removeListener('exit', store._onExit);
  }
  stores.clear();
}
