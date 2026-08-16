// react-x11/refresh — the runtime half of state-preserving hot reload
// (Fast Refresh). The loader half is ./loader.js; `react-x11/refresh/register`
// wires both up for `node --import`. See docs/ecosystem/dev-tooling.md.
//
// Import order is what this module exists to own:
//
//   1. injectIntoGlobalHook must patch the DevTools global hook before any
//      renderer registers with it — so the renderer import below is dynamic,
//      after the patch;
//   2. injectIntoDevTools hands the reconciler's internals (dev build:
//      scheduleRefresh & friends) to the patched hook, which is how
//      react-refresh learns to re-render mounted roots. It must run before
//      the first commit or the root won't be tracked.
//
// A host app does not need to import this module at all: the loader injects
// an import of it into every hot module's prelude, and the entry is itself a
// hot module, so the patch always lands before the app's own imports
// evaluate React or the renderer. Importing it explicitly is only for the
// two exports — `onReload` and `performReactRefresh`.
//
// react-refresh/runtime lives in node_modules, outside the hot graph, so
// every reloaded module registers into this one runtime instance.
import RefreshRuntime from 'react-refresh/runtime';

RefreshRuntime.injectIntoGlobalHook(globalThis);

const ReactX11 = await import('../index.js');
// no argument: react-reconciler 0.33 takes none, and the renderer metadata
// comes from the host config in src/Reconciler.js
ReactX11.Renderer.injectIntoDevTools();

const listeners = new Set();

/**
 * Called after a hot-reload batch has been applied: the edited components
 * have re-rendered in place. The seam a dev tool sits on — log the reload,
 * clear an error state, update a workbench UI. Returns an unsubscribe.
 */
export function onReload(listener) {
  if (typeof listener !== 'function') {
    throw new TypeError(
      `react-x11/refresh: onReload takes a function, got ${typeof listener}.`,
    );
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Manual seam: apply pending component updates now. null = nothing pending. */
export function performReactRefresh() {
  return RefreshRuntime.performReactRefresh();
}

// A reload batch re-evaluates each module along the changed → accepting
// path as a separate dynamic import, and an editor save can fire the file
// watcher more than once — so the refresh is debounced. The delay is
// imperceptible next to the save itself; what it buys is one re-render and
// one onReload event per save instead of one per module.
const REFRESH_DEBOUNCE_MS = 30;
const pendingUrls = new Set();
let pendingTimer = null;

function flushRefresh() {
  pendingTimer = null;
  const urls = [...pendingUrls];
  pendingUrls.clear();
  const result = RefreshRuntime.performReactRefresh();
  const event = { urls, refreshed: result !== null };
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      console.error('react-x11/refresh: onReload listener threw', err);
    }
  }
}

// The loader's injected footer calls this at the end of every hot module's
// evaluation, handing over the module's exported values (or null when the
// exports cannot all be named statically — re-exports, an anonymous
// default). A module whose exports are all components is a refresh
// boundary: it self-accepts, so an edit to it (or to anything below it
// with no boundary of its own) re-evaluates up to here and no further,
// and the re-evaluation schedules the refresh. Anything else stays
// un-accepted and the change propagates to the nearest boundary above.
function moduleReady(hot, url, exportsMap) {
  const boundary =
    exportsMap !== null &&
    Object.values(exportsMap).every((value) =>
      RefreshRuntime.isLikelyComponentType(value),
    );
  if (boundary) {
    hot.accept();
  } else {
    // The hot context survives reloads, so an edit that adds a
    // non-component export must also retract the acceptance the previous
    // version registered — otherwise importers keep stale values forever.
    // hot-module-replacement has no public un-accept, hence the field.
    hot._selfAccepted = false;
  }
  const busted = /\?hmr=\d+$/.test(url);
  if (boundary && busted) {
    pendingUrls.add(url.replace(/\?hmr=\d+$/, ''));
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(flushRefresh, REFRESH_DEBOUNCE_MS);
  }
}

// The injected prelude and footer reach everything through this default
// export: inside a hot module, named imports are rewritten to live
// bindings that initialize in a microtask, and module-scope code runs
// before that — only the default binding is initialized synchronously.
export default {
  register(type, id) {
    RefreshRuntime.register(type, id);
  },
  createSignatureFunctionForTransform:
    RefreshRuntime.createSignatureFunctionForTransform,
  moduleReady,
  performReactRefresh,
  onReload,
};
