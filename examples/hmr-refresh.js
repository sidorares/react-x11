// The runtime half of Fast Refresh (the transform half lives in
// hmr-register.mjs). Import this FIRST in a hot entry:
//
//   1. injectIntoGlobalHook must patch the DevTools global hook before
//      any renderer registers with it — so the renderer import below is
//      dynamic, after the patch. Being the entry's first import puts all
//      of this before React evaluates anywhere else;
//   2. injectIntoDevTools hands the reconciler's internals (dev build:
//      scheduleRefresh & friends) to the patched hook, which is how
//      react-refresh learns to re-render mounted roots. It must run
//      before the first commit or the root won't be tracked.
//
// After a reload, call performReactRefresh(): components re-render in
// place, keeping hook state wherever the edit left the component's hook
// signature unchanged (a changed signature remounts just that component).
//
// react-refresh/runtime is in node_modules, outside the hot graph, so
// every reloaded module registers into the same runtime instance.
import RefreshRuntime from 'react-refresh/runtime';

RefreshRuntime.injectIntoGlobalHook(globalThis);

const ReactX11 = await import('../src/index.js');
ReactX11.Renderer.injectIntoDevTools({
  bundleType: 1, // dev
  version: '0.0.1', // display metadata only
  rendererPackageName: 'react-x11',
  findFiberByHostInstance: (instance) => instance._reactFiber,
});

export function performReactRefresh() {
  // null = nothing pending (no component re-registered with new code)
  return RefreshRuntime.performReactRefresh();
}
