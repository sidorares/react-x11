// The frame environment: which context values cross into a `<Frame>`.
//
// React context cannot cross a process boundary — a context object is
// process-local, and React has no API for enumerating "the providers above
// this node". Both halves of that problem are answered here with one
// structure:
//
//  - **Identity** is a string key plus a module both sides import. A pane's
//    components read a context by importing the module that created it, and
//    creating it (`createFrameContext`) is what registers it — so by the
//    time the child bridge has a value to recreate, the context it belongs
//    to is in the registry *by construction*. A key that arrives with no
//    registration means the pane never imported the module, which means
//    nothing in the pane reads it: skipped, silently.
//
//  - **Enumeration** is an accumulator: every bridging provider also merges
//    its value into `FrameEnv`, a single internal context holding a
//    `Map(key → value)`. `<Frame>` reads that one context at its own tree
//    position and gets exactly the values an in-process child would have
//    seen there — and re-renders when any of them changes, which is the
//    entire subscription mechanism. Map insertion order is the parent's
//    provider nesting order (outermost first), v8's structured clone
//    preserves it, and the child recreates providers in that order.
//
// What deliberately does not cross: functions. Props run the callback
// bridge because props are visible per-frame wiring; a context is ambient,
// and bridging a `{ state, dispatch }` pair would hand live RPC stubs to
// every pane under the provider — invisible IPC, with an unanswerable
// question about which incarnation of a restarted child holds which stub.
// A bridged value that fails structured clone is dropped with a warning
// naming the key (src/frame/index.js), and dispatchers travel in `props`.
//
// The other line this file draws: bridge what the **app** defines, and let
// each process resolve what the **desktop** defines. Appearance, locale,
// desktop settings and fonts are read from the environment identically on
// both sides of the boundary, so bridging them would only add a stale copy.
// The theme is the one ambient thing the app authors, which is why
// `ThemeProvider` publishes here by default (src/components/theme.js).

import React, { useContext, useMemo } from 'react';

const h = React.createElement;

const EMPTY = new Map();

/** `Map(key → serialized value)` of every bridged context above here. */
export const FrameEnv = React.createContext(EMPTY);

/** The env a `<Frame>` at this position would hand its child. */
export function useFrameEnv() {
  return useContext(FrameEnv);
}

/**
 * key → how the child recreates the provider:
 * `{ Context, revive }` from `createFrameContext`, or `{ render }` from
 * `registerFrameProvider`. Last registration wins, which is what lets a
 * hot-reloaded module re-register itself without a guard.
 */
const registry = new Map();

/** The child bridge's lookup (src/frame/childmain.js). */
export function registeredFrameContext(key) {
  return registry.get(key) ?? null;
}

/**
 * Register how the child side recreates `key` — for a provider that is more
 * than `Context.Provider`, like `ThemeProvider`, which also plants the
 * palette on a node so `$token` styles resolve. `render(value, children)`
 * returns the wrapped element.
 */
export function registerFrameProvider(key, render) {
  registry.set(key, { render });
}

/**
 * Publish one `key → value` into the frame environment. Used by
 * `createFrameContext`'s Provider and by `ThemeProvider`; not part of the
 * public API.
 */
export function EnvValue({ k, value, children }) {
  const env = useContext(FrameEnv);
  const next = useMemo(() => new Map(env).set(k, value), [env, k, value]);
  return h(FrameEnv.Provider, { value: next }, children);
}

/**
 * A React context whose value follows the app into its `<Frame>` panes.
 *
 * ```js
 * // contexts.js — imported by the app *and* by the pane's components
 * export const Session = createFrameContext('session', null);
 *
 * // app side
 * <Session.Provider value={{ user, database }}>
 *   <Frame src={paneUrl} … />
 * </Session.Provider>
 *
 * // pane side — no wiring; the value was in force where the Frame stood
 * const { user } = Session.use();
 * ```
 *
 * In-process it is an ordinary context. Across a `<Frame>` the value is
 * snapshotted with structured clone, sent with the frame's props, and
 * recreated as a real Provider around the pane — one direction, data only.
 *
 * `key` names the value on the wire and must be unique per app;
 * `serialize`/`revive` are for values structured clone cannot carry
 * (a class instance), and default to identity.
 */
export function createFrameContext(key, defaultValue, options = {}) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('react-x11: createFrameContext needs a string key');
  }
  const { serialize, revive } = options;
  const Context = React.createContext(defaultValue);
  registry.set(key, { Context, revive });
  function Provider({ value, children }) {
    return h(
      EnvValue,
      { k: key, value: serialize ? serialize(value) : value },
      h(Context.Provider, { value }, children),
    );
  }
  return {
    key,
    Context,
    Provider,
    use: () => useContext(Context),
  };
}
