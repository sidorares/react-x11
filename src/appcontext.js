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

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';

import { createClipboard } from './clipboard.js';
import {
  argbVisual,
  compositingActive,
  watchCompositing,
} from './compositing.js';
import { hasDirectGL, watchDirectGL } from './glbackend.js';

const AppContext = createContext(null);

/** Wraps the rendered element; not exported to applications. */
export const AppProvider = AppContext.Provider;

/** `useApp()` without the throw, for components that can still render
 * something useful outside a tree. Not public. */
export function useAppOrNull() {
  return useContext(AppContext);
}

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

const SUPPORTS_FEATURES = new Set(['transparency', 'shaders']);

/**
 * Can this **display** do something, as a value a component can branch on?
 *
 * ```jsx
 * const canBlend = useSupports('transparency');
 * // a shadow has to be painted into a margin the popup owns, so the
 * // decision has to be made before the window is sized
 * const margin = canBlend ? 26 : 0;
 * ```
 *
 * `'transparency'` is true when the server has a 32-bit visual to draw on
 * *and* a compositor is running to blend it. It re-renders when a compositor
 * starts or stops. `REACT_X11_NO_TRANSPARENCY=1` answers false whatever the
 * display can do, so the fallback design can be looked at without stopping
 * the compositor for the whole session.
 *
 * The companion is the `'@supports transparency'` style block, and the two
 * answer deliberately different questions. This one is about the display, so
 * it can be asked before any window exists — which is what a caller sizing a
 * popup needs. The style block is about the window the node is actually in,
 * so a component nested in a plain `<window>` gets the opaque design there
 * and the translucent one inside a `<popup transparent>`, without being
 * told which it is. Reach for the style block first; this is for decisions
 * that are not styling.
 *
 * `'shaders'` is true when 3D can run your own GLSL — that is, when this
 * connection draws through the **direct** rendering backend. It is the
 * question to ask before rendering a `<shaderMaterial>`, which throws where
 * there is no pipeline to compile it:
 *
 * ```jsx
 * const shaders = useSupports('shaders');
 * <mesh>
 *   <boxGeometry args={[1, 1, 1]} />
 *   {shaders ? <shaderMaterial {...glsl} /> : <meshPhongMaterial color="#e0533d" />}
 * </mesh>
 * ```
 *
 * It needs `createRoot({ glPolicy: 'auto' })`: the default policy is the
 * indirect backend, which has no shaders at all, so this is false under it
 * whatever the machine could do. That is the line between this and
 * `app.glCapabilities()` — the hook answers which backend *this connection*
 * got, the capabilities answer what the machine could offer, and they
 * disagree exactly when the policy did not ask. The capabilities also say
 * *why* this is false; see docs/gl.md.
 *
 * Unlike `'transparency'`, which comes and goes with the compositor, this
 * settles once and then holds still: under a policy that could pick direct,
 * `createRoot()` waits for ntk's probe before handing the app back, so the
 * first render already reads the final answer. A policy raised after
 * connecting has missed that probe, and re-renders its readers when it
 * settles rather than leaving them with two different answers.
 */
export function useSupports(feature) {
  const app = useApp();
  if (!SUPPORTS_FEATURES.has(feature)) {
    throw new Error(
      `react-x11: useSupports(${JSON.stringify(feature)}) — unknown feature ` +
        `(expected one of ${[...SUPPORTS_FEATURES].join(', ')})`,
    );
  }
  // Both features go through the same store, so the hooks below run in the
  // same order whatever is being asked about. Where compositing comes and
  // goes for as long as the app runs, the backend settles at most once — and
  // watching that one moment is what keeps two components rendered either
  // side of it from disagreeing (see watchDirectGL).
  const subscribe = useCallback(
    (onChange) =>
      feature === 'shaders'
        ? watchDirectGL(app, onChange)
        : watchCompositing(app, onChange),
    [app, feature],
  );
  // a boolean, so the snapshot is stable for a given state — returning the
  // visual object here would tear on every render
  const snapshot = useCallback(
    () =>
      feature === 'shaders'
        ? hasDirectGL(app)
        : compositingActive(app) && Boolean(argbVisual(app)),
    [app, feature],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
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
