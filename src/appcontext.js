// Reaching the X connection from a component.
//
// `createRoot()` hands the app back to whoever called it, which is fine for
// an entry point and useless three components down — and a component
// library has no route to it at all without prop-drilling. So `render()`
// wraps the tree in a provider and `useApp()` reads it.
//
// Context rather than the ref walk `useWindowId`/`useAnchor` use: those
// answer *per-node* questions, and the ref is the question. The connection
// is app-scoped, so demanding a host ref to find it would be busywork with
// no information in it. A module-level global would be simpler still and
// wrong — one process can drive several roots on several connections, which
// the test suite does routinely.

import { createContext, useContext, useMemo } from 'react';

import { createClipboard } from './clipboard.js';

const AppContext = createContext(null);

/** Wraps the rendered element; not exported to applications. */
export const AppProvider = AppContext.Provider;

/**
 * The ntk connection this tree is rendering onto.
 *
 * Everything ntk exposes hangs off it — `app.fonts`, `app.cursors`,
 * `app.X` for raw protocol — so this is the escape hatch as much as it is
 * an API. Throws outside a react-x11 tree rather than returning null,
 * because every caller would have had to check.
 */
export function useApp() {
  const app = useContext(AppContext);
  if (!app) {
    throw new Error(
      'react-x11: useApp() must be called inside a tree rendered by createRoot()',
    );
  }
  return app;
}

/**
 * The clipboard, scoped to this tree's connection.
 *
 * ```jsx
 * const clipboard = useClipboard();
 * await clipboard.writeText(selection);        // stamped with the keystroke
 * const files = await clipboard.readFiles();   // parsed, or []
 * ```
 *
 * Stable for as long as the app is, so it is safe in a dependency array.
 */
export function useClipboard() {
  const app = useApp();
  return useMemo(() => createClipboard(app), [app]);
}
