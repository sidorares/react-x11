// The seam between the renderer and the optional debug module.
//
// Reconciler.js and nodes.js import this file, so it has to stay safe to
// bundle for the browser playground: no node builtins, no side effects,
// nothing but a registry of live connections and a pair of hook slots. The
// heavy half (protocol parsing, sinks, file writing) lives in debug.js and
// is only loaded when the user imports `react-x11/debug` or sets
// REACT_X11_TRACE.

/** ntk Apps the renderer currently draws through. */
const apps = new Set();
const appListeners = new Set();

export function registerApp(app) {
  if (!app || apps.has(app)) return;
  apps.add(app);
  for (const fn of [...appListeners]) fn(app);
}

/** A root that owned its connection closed it; stop offering it to traces. */
export function unregisterApp(app) {
  apps.delete(app);
}

/**
 * Call `fn` for every current connection and every future one, until the
 * returned function is called. This is how a trace with no explicit `app`
 * follows the renderer: `createRoot()` may not have connected yet when the
 * trace starts.
 */
export function onApp(fn) {
  appListeners.add(fn);
  for (const app of apps) fn(app);
  return () => appListeners.delete(fn);
}

/**
 * Hook slots the hot paths poll. A slot is null almost always, and the cost
 * of an unset hook is one property read — which is the whole design: the
 * frame loop must not pay for a tracer nobody started.
 *
 *  - `frame({ root, rects, reasons, start, end })` — after a window painted.
 *    `rects` is the damage list, null for a full repaint; times come from
 *    `performance.now()`.
 *  - `commitStart()` / `commitEnd()` — around a React commit.
 */
export const hooks = {
  frame: null,
  commitStart: null,
  commitEnd: null,
};
