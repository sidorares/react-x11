// Opt-in React DevTools bridge. Enabled by setting REACT_X11_DEVTOOLS=1 in
// the environment; requires the `react-devtools-core` and `ws` dev
// dependencies. Start the standalone UI first (`npx react-devtools`), then
// run the app: REACT_X11_DEVTOOLS=1 npm run examples:dashboard
//
// Most of what DevTools can do costs this file nothing: the component tree,
// props/state/hooks, and every edit the frontend makes go through the
// renderer interface `injectIntoDevTools()` registers. What is left is the
// part a browser gets from the DOM and an X11 app has to answer for itself
// — the overlays (hover highlight, update outlines), the element picker,
// the style editor's measurements, and the storage a restart survives.
// Each of those is an agent listener or an option below.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setInspectHandler } from './events.js';
import { flattenStyle, isStyleProp, STYLE_PROP_NAMES } from './styles.js';

let api = null;
let connected = false;

// ---------------------------------------------------------------------------
// State that outlives the process
// ---------------------------------------------------------------------------

/**
 * The backend keeps its preferences in `localStorage` — component filters,
 * console patching, the "reload and profile" flags — and a browser hands it
 * one. Without it every DevTools setting resets on each run, and the
 * backend's own reload-and-profile support check fails on the first line.
 * A file in the cache directory is the same deal the appearance cache
 * takes (see appearance.js): ordinary user-writable JSON, absent on the
 * first run, and doing without it costs only persistence.
 */
function stateFile() {
  if (process.env.REACT_X11_DEVTOOLS_STATE) {
    return process.env.REACT_X11_DEVTOOLS_STATE;
  }
  let base = process.env.XDG_CACHE_HOME;
  if (!base) {
    let home;
    try {
      home = os.homedir();
    } catch {
      return null;
    }
    if (!home || home === '/') return null;
    base =
      process.platform === 'darwin'
        ? path.join(home, 'Library', 'Caches')
        : path.join(home, '.cache');
  }
  return path.join(base, 'react-x11', 'devtools.json');
}

/** A Storage that reads and writes one JSON object. `persist` false is
 * sessionStorage: same interface, nothing on disk. Exported for its own
 * test — a store that quietly stops persisting looks exactly like DevTools
 * settings that never stuck. */
export function createStorage(persist) {
  const file = persist ? stateFile() : null;
  let entries = new Map();
  if (file) {
    try {
      entries = new Map(Object.entries(JSON.parse(fs.readFileSync(file))));
    } catch {
      // absent, unreadable or not JSON — start from nothing
    }
  }
  const flush = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // a read-only or full disk costs persistence, not the session
    }
  };
  return {
    get length() {
      return entries.size;
    },
    key: (i) => [...entries.keys()][i] ?? null,
    getItem: (key) => entries.get(String(key)) ?? null,
    setItem(key, value) {
      entries.set(String(key), String(value));
      flush();
    },
    removeItem(key) {
      entries.delete(String(key));
      flush();
    },
    clear() {
      entries.clear();
      flush();
    },
    /** What a reload-and-profile restart carries into the child. */
    toJSON: () => Object.fromEntries(entries),
  };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Install the DevTools global hook. Must run before the first React commit
 * so mounted roots are observed — Reconciler.js awaits this at module load
 * when REACT_X11_DEVTOOLS is set.
 */
export async function prepare() {
  try {
    // react-devtools-core's backend bundle expects browser-ish globals
    global.self ??= global;
    global.window ??= global;
    if (!global.WebSocket) {
      global.WebSocket = (await import('ws')).default;
    }
    // The update-tracing overlay schedules its redraws on animation
    // frames, which Node does not have; without these the first traced
    // commit throws inside the backend. Unref'd, because an overlay must
    // not be a reason for the process to stay up.
    if (!global.requestAnimationFrame) {
      global.requestAnimationFrame = (callback) => {
        const timer = setTimeout(() => callback(Date.now()), 16);
        timer.unref?.();
        return timer;
      };
      global.cancelAnimationFrame = (timer) => clearTimeout(timer);
    }
    // Defined rather than assigned: *reading* `global.localStorage` first
    // is what makes node print "localStorage is not available because
    // --localstorage-file was not provided" on every DevTools run, and its
    // storage is an unrelated opt-in feature this has no business waiting
    // for.
    for (const [name, persist] of [
      ['localStorage', true],
      ['sessionStorage', false],
    ]) {
      Object.defineProperty(global, name, {
        value: createStorage(persist),
        configurable: true,
        writable: true,
      });
    }
    // A reload-and-profile restart is the one thing that should look like a
    // page reload rather than a new session: the selection and the
    // profiling flags are handed to the child through its environment (see
    // reloadAndProfile) and seeded back here.
    for (const [key, value] of Object.entries(readSession())) {
      global.sessionStorage.setItem(key, value);
    }
    const mod = await import('react-devtools-core');
    // v7 exposes the API on the default export under node ESM interop
    api = mod.default?.initialize ? mod.default : mod;
    // The hook settings the user last chose in the DevTools UI — console
    // patching and friends. `initialize()` takes them, `onSettingsUpdated`
    // (below) records them, so a setting survives a restart.
    api.initialize(readHookSettings());
  } catch (err) {
    api = null;
    console.warn(
      'react-x11: REACT_X11_DEVTOOLS is set but devtools could not be loaded. ' +
        'Install react-devtools-core and ws. Original error: ' +
        err.message,
    );
  }
}

const HOOK_SETTINGS_KEY = 'react-x11:hookSettings';

function readHookSettings() {
  try {
    const raw = global.localStorage?.getItem(HOOK_SETTINGS_KEY);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function readSession() {
  try {
    return JSON.parse(process.env.REACT_X11_DEVTOOLS_SESSION ?? '{}') ?? {};
  } catch {
    return {};
  }
}

/** The profiling a restart was asked to start with, or null for a normal
 * run. Set by reloadAndProfile() in the process that asked for the
 * restart, read here in the one that came back. */
function readProfilingOnStart() {
  try {
    const raw = process.env.REACT_X11_DEVTOOLS_PROFILING;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * DevTools' "Reload and start profiling": profiling that covers the initial
 * mount cannot be turned on in a running app, so the app restarts with it
 * already on. A browser reloads the page; here that is re-exec'ing this
 * process with the same node flags, the same argv and two extra
 * environment variables — the profiling settings, and the session storage
 * a reload would have kept.
 */
export function reloadAndProfile(recordChangeDescriptions, recordTimeline) {
  const child = spawn(
    process.execPath,
    [...process.execArgv, ...process.argv.slice(1)],
    {
      stdio: 'inherit',
      detached: true,
      env: {
        ...process.env,
        REACT_X11_DEVTOOLS: '1',
        REACT_X11_DEVTOOLS_PROFILING: JSON.stringify({
          recordChangeDescriptions,
          recordTimeline,
        }),
        REACT_X11_DEVTOOLS_SESSION: JSON.stringify(
          global.sessionStorage?.toJSON?.() ?? {},
        ),
      },
    },
  );
  // Only stand down once the replacement is actually running: a spawn that
  // fails must leave the app the user was profiling alive.
  child.on('spawn', () => {
    child.unref();
    process.exit(0);
  });
  child.on('error', (err) => {
    console.warn(
      'react-x11: DevTools asked for a restart to profile, but re-exec ' +
        `failed (${err.code ?? err.message}). The app is still running; ` +
        'profile from here instead.',
    );
  });
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

/** Connect the backend to the standalone DevTools app and register the
 * renderer. Called by Reconciler.js right after the renderer is created. */
export function connect(renderer) {
  if (!api || connected) return;
  connected = true;
  const profiling = readProfilingOnStart();

  api.connectToDevTools({
    isAppActive: () => true,
    host: process.env.REACT_X11_DEVTOOLS_HOST || 'localhost',
    port: Number(process.env.REACT_X11_DEVTOOLS_PORT) || 8097,
    // The style editor: `style` is a react-x11 style prop (an object, or a
    // nested array of them), which is the shape DevTools' own resolver
    // expects to be handed flat. `validAttributes` is what it offers to
    // add to an element.
    resolveRNStyle: resolveStyle,
    nativeStyleEditorValidAttributes: STYLE_PROP_NAMES,
    // Hook settings (console patching and so on) are the user's, not the
    // run's: keep them where the next run will find them.
    onSettingsUpdated: (settings) => {
      try {
        global.localStorage?.setItem(
          HOOK_SETTINGS_KEY,
          JSON.stringify(settings),
        );
      } catch {
        // an unwritable store is not worth a warning per keystroke
      }
    },
    // The backend's own check for this asks whether synchronous XHR works,
    // which is a browser question — the honest answer for a node process
    // that can re-exec itself is yes.
    isReloadAndProfileSupported: true,
    isProfiling: profiling != null,
    onReloadAndProfile: reloadAndProfile,
    onReloadAndProfileFlagsReset: () => {
      delete process.env.REACT_X11_DEVTOOLS_PROFILING;
      delete process.env.REACT_X11_DEVTOOLS_SESSION;
    },
  });

  // No argument: react-reconciler 0.33 takes none, and the object this used
  // to pass was discarded in silence. The renderer's name and version now
  // come from the host config, where Reconciler.js already sets them
  // (`rendererPackageName`, `rendererVersion`).
  //
  // Unless it is already registered: `react-x11/test`'s inspect() drives
  // the same backend in-process and may have injected first — a second
  // inject would register a duplicate renderer with the hook, and the
  // standalone app would show two copies of every tree.
  if (!global.__REACT_DEVTOOLS_GLOBAL_HOOK__?.rendererInterfaces?.size) {
    renderer.injectIntoDevTools();
  }
  if (profiling) startProfiling(profiling);

  watchForAgent();
}

/**
 * Turn profiling on before the first commit, which is the whole point of
 * the restart: registering a renderer does not start it (the agent only
 * does that when the frontend asks), so the run that came back from
 * `reloadAndProfile` starts it itself.
 */
function startProfiling({ recordChangeDescriptions, recordTimeline }) {
  const interfaces = global.__REACT_DEVTOOLS_GLOBAL_HOOK__?.rendererInterfaces;
  const ri = interfaces && [...interfaces.values()].at(-1);
  try {
    ri?.startProfiling?.(recordChangeDescriptions, recordTimeline);
  } catch (err) {
    console.warn(
      `react-x11: could not start profiling after restart: ${err.message}`,
    );
  }
}

/** A style prop as the style editor wants it: flat, and only the properties
 * that are really style properties — a state block (`:hover`) or a query is
 * neither editable nor a value, and listing them among the rest would
 * invite editing something that cannot be edited. */
export function resolveStyle(style) {
  const flat = flattenStyle(style);
  const resolved = {};
  for (const key of Object.keys(flat)) {
    if (isStyleProp(key)) resolved[key] = flat[key];
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// The overlays and the picker
// ---------------------------------------------------------------------------

// One highlight at a time, whoever asked for it: the tree hover and the
// picker share the window's single tint, and the loser of a race would
// otherwise leave its tint behind forever.
let highlightedRoot = null;

/** The retained node behind whatever DevTools handed us — public instances
 * are ntk windows for `<window>`/`<popup>`, nodes everywhere else. */
function nodeOf(target) {
  const value = Array.isArray(target) ? target[0] : target;
  return value?._reactX11Node ?? value ?? null;
}

function showHighlight(target) {
  const node = nodeOf(target);
  const root = node?.root;
  if (!root || typeof root.setHighlight !== 'function') return;
  if (highlightedRoot && highlightedRoot !== root) {
    highlightedRoot.setHighlight(null);
  }
  highlightedRoot = root;
  root.setHighlight(node);
}

function hideHighlight() {
  highlightedRoot?.setHighlight(null);
  highlightedRoot = null;
}

/**
 * Wire a DevTools backend agent's element-hover events to the renderer:
 * hovering an element in the DevTools tree tints its rect in the window.
 * Exported separately so it can be tested without react-devtools-core.
 */
export function attachHighlightAgent(agent) {
  agent.addListener?.('showNativeHighlight', showHighlight);
  agent.addListener?.('hideNativeHighlight', hideHighlight);
  agent.addListener?.('shutdown', hideHighlight);
}

/**
 * "Highlight updates when components render". The backend counts the
 * updates, picks each rect's colour off its own ramp and expires them on
 * its own clock; all it wants from a host is somewhere to draw. It hands
 * over the host instances that re-rendered — every live one, every time —
 * so this replaces the overlay rather than adding to it.
 */
export function attachTraceUpdatesAgent(agent) {
  let painted = new Set();

  const draw = (entries) => {
    const byRoot = new Map();
    for (const entry of entries ?? []) {
      const node = nodeOf(entry?.node);
      const root = node?.root;
      if (!root || root.destroyed) continue;
      if (typeof root.setTraceUpdates !== 'function') continue;
      const rect = node.abs;
      if (!rect?.width) continue;
      const rects = byRoot.get(root) ?? [];
      rects.push({ ...rect, color: entry.color });
      byRoot.set(root, rects);
    }
    for (const root of painted) {
      if (!byRoot.has(root) && !root.destroyed) root.setTraceUpdates(null);
    }
    for (const [root, rects] of byRoot) root.setTraceUpdates(rects);
    painted = new Set(byRoot.keys());
  };

  const clear = () => {
    // a window that closed while its outlines were up has nothing to clear
    // and nothing to repaint
    for (const root of painted) {
      if (!root.destroyed) root.setTraceUpdates(null);
    }
    painted = new Set();
  };

  agent.addListener?.('drawTraceUpdates', draw);
  agent.addListener?.('disableTraceUpdates', clear);
  agent.addListener?.('shutdown', clear);
}

/**
 * The element picker — the crosshair in the DevTools toolbar. In a browser
 * the backend listens on the page itself; with no DOM to listen to it says
 * `startInspectingNative` and leaves the pointer to the host. While it is
 * on, the pointer belongs to DevTools (see setInspectHandler in events.js):
 * motion tints whatever is under it, a press selects that element in the
 * tree, Escape gives up.
 */
export function attachPickerAgent(agent) {
  let picking = false;

  const stop = () => {
    if (!picking) return;
    picking = false;
    setInspectHandler(null);
    hideHighlight();
  };

  const onPointer = (kind, node) => {
    if (kind === 'move') {
      if (node) showHighlight(node);
      else hideHighlight();
      return;
    }
    if (kind === 'select' && node) {
      // select first: the frontend leaves picking mode on the second
      // message, and an element that arrives after it is ignored
      agent.selectNode?.(node);
      stop();
      agent.stopInspectingNative?.(true);
      return;
    }
    stop();
    agent.stopInspectingNative?.(false);
  };

  const start = () => {
    if (picking) return;
    picking = true;
    setInspectHandler(onPointer);
  };

  agent.addListener?.('startInspectingNative', start);
  agent.addListener?.('shutdown', stop);
  // Giving up from the DevTools side is a bridge message the backend
  // answers by hiding its overlay, with nothing left for a host listener —
  // so this reads the bridge directly rather than leave a picker running
  // that swallows every event the app would have had.
  agent._bridge?.addListener?.('stopInspectingHost', stop);
}

/**
 * Select a node in the DevTools tree, if DevTools is attached and knows it.
 * Click-to-component calls this: an Alt+Click that opens the source is also
 * the click that says "this element", and saying it twice is silly.
 */
export function selectInDevTools(node) {
  const agent = global.__REACT_DEVTOOLS_GLOBAL_HOOK__?.reactDevtoolsAgent;
  if (!agent || !node) return false;
  try {
    // an element DevTools has no id for is one its filters hid; selecting
    // it would be a message the frontend drops
    if (!agent.getIDForHostInstance?.(node)) return false;
    agent.selectNode(node);
    return true;
  } catch {
    return false;
  }
}

function attachAgent(agent) {
  attachHighlightAgent(agent);
  attachTraceUpdatesAgent(agent);
  attachPickerAgent(agent);
}

function watchForAgent() {
  const hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return;
  try {
    if (hook.reactDevtoolsAgent) {
      attachAgent(hook.reactDevtoolsAgent);
    } else if (typeof hook.on === 'function') {
      // the backend emits 'react-devtools' once the agent is initialized
      hook.on('react-devtools', (agent) => attachAgent(agent));
    }
  } catch {
    // the overlays are best-effort; the tree view still works without them
  }
}
