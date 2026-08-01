// Opt-in React DevTools bridge. Enabled by setting REACT_X11_DEVTOOLS=1 in
// the environment; requires the `react-devtools-core` and `ws` dev
// dependencies. Start the standalone UI first (`npx react-devtools`), then
// run the app: REACT_X11_DEVTOOLS=1 npm run examples:dashboard
let api = null;
let connected = false;

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
    const mod = await import('react-devtools-core');
    // v7 exposes the API on the default export under node ESM interop
    api = mod.default?.initialize ? mod.default : mod;
    api.initialize();
  } catch (err) {
    api = null;
    console.warn(
      'react-x11: REACT_X11_DEVTOOLS is set but devtools could not be loaded. ' +
        'Install react-devtools-core and ws. Original error: ' +
        err.message,
    );
  }
}

/** Connect the backend to the standalone DevTools app and register the
 * renderer. Called by Reconciler.js right after the renderer is created. */
export function connect(renderer) {
  if (!api || connected) return;
  connected = true;

  api.connectToDevTools({
    isAppActive: () => true,
    host: process.env.REACT_X11_DEVTOOLS_HOST || 'localhost',
    port: Number(process.env.REACT_X11_DEVTOOLS_PORT) || 8097,
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

  watchForAgent();
}

/**
 * Wire a DevTools backend agent's element-hover events to the renderer:
 * hovering an element in the DevTools tree tints its rect in the window.
 * Exported separately so it can be tested without react-devtools-core.
 */
export function attachHighlightAgent(agent) {
  let highlightedRoot = null;

  const show = (payload) => {
    // newer devtools versions pass an array of public instances
    const target = Array.isArray(payload) ? payload[0] : payload;
    // public instances are ntk windows for <window>/<popup>, nodes otherwise
    const node = target?._reactX11Node ?? target;
    const root = node?.root;
    if (!root || typeof root.setHighlight !== 'function') return;
    if (highlightedRoot && highlightedRoot !== root) {
      highlightedRoot.setHighlight(null);
    }
    highlightedRoot = root;
    root.setHighlight(node);
  };

  const hide = () => {
    highlightedRoot?.setHighlight(null);
    highlightedRoot = null;
  };

  agent.addListener?.('showNativeHighlight', show);
  agent.addListener?.('hideNativeHighlight', hide);
  agent.addListener?.('shutdown', hide);
}

function watchForAgent() {
  const hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return;
  try {
    if (hook.reactDevtoolsAgent) {
      attachHighlightAgent(hook.reactDevtoolsAgent);
    } else if (typeof hook.on === 'function') {
      // the backend emits 'react-devtools' once the agent is initialized
      hook.on('react-devtools', (agent) => attachHighlightAgent(agent));
    }
  } catch {
    // highlight support is best-effort; the tree view still works without it
  }
}
