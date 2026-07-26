// Opt-in React DevTools bridge. Enabled by setting REACT_X11_DEVTOOLS=1 in the
// environment; requires the `react-devtools-core` and `ws` packages (dev
// dependencies of this repo, not shipped with the library).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let connected = false;

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

export async function connect(renderer) {
  if (connected) {
    return;
  }
  connected = true;

  let connectToDevTools;
  try {
    if (!global.WebSocket) {
      global.WebSocket = (await import('ws')).default;
    }
    ({ connectToDevTools } = await import('react-devtools-core'));
  } catch (err) {
    console.warn(
      'react-x11: REACT_X11_DEVTOOLS is set but devtools could not be loaded. ' +
        'Install react-devtools-core and ws. Original error: ' +
        err.message,
    );
    return;
  }

  connectToDevTools({
    isAppActive: () => true,
    host: process.env.REACT_X11_DEVTOOLS_HOST || 'localhost',
  });

  renderer.injectIntoDevTools({
    bundleType: 1,
    version: require('../package.json').version,
    rendererPackageName: 'react-x11',
    findFiberByHostInstance: (instance) => instance._reactFiber,
  });

  watchForAgent();
}
