// The two inbound events, as rendering code sees them.
//
// Thin on purpose. `application.js` owns the bus, the buffer and the replay;
// this is the lid that lets a component take a deep link without the app
// author threading a callback down from the module scope where
// `registerApplication()` had to be called.
//
// There is **nothing to wrap** — the registration is process-global, because
// an application has one identity on the desktop — so these work in any tree,
// including a component library's.

import { useEffect, useRef } from 'react';

import { onAppActivate, onAppOpen } from './application.js';

/**
 * Subscribe without re-subscribing when the handler identity changes.
 *
 * The subscription must be installed **once**, on mount: a launch that arrived
 * before anything was listening is replayed to the first handler that
 * attaches, and re-subscribing on every render would keep re-arming a drain
 * that has already happened while doing nothing useful. The handler itself is
 * read at call time, so a link that arrives three minutes from now runs the
 * closure from the current render rather than the mounting one.
 */
function useLaunchSubscription(subscribe, handler) {
  const live = useRef(handler);
  live.current = handler;
  useEffect(() => subscribe((...args) => live.current?.(...args)), [subscribe]);
}

/**
 * The desktop handed this app URIs to open — a `myapp://` link clicked
 * somewhere else, or a document opened from a file manager.
 *
 * ```jsx
 * function App() {
 *   const win = useRef(null);
 *   useAppOpen((uris, ctx) => {
 *     activateWindow(win, { timestamp: ctx.timestamp });
 *     const code = new URL(uris[0]).searchParams.get('code');
 *     finishLogin(code);
 *   });
 *   return <window ref={win}>…</window>;
 * }
 * ```
 *
 * Fires for links that arrived **before the tree mounted** too, which is the
 * normal case when the bus started this process to deliver one: they are
 * buffered and replayed to the first handler that attaches.
 *
 * `uris` is attacker-controlled input from an unauthenticated local peer —
 * `Open` is callable by anything on the session bus. Validate before acting,
 * and never treat a URI's path as a filesystem path. See docs/uri-schemes.md.
 */
export function useAppOpen(handler) {
  useLaunchSubscription(onAppOpen, handler);
}

/**
 * The desktop asked this app to come forward with nothing to open — the user
 * launched it again from the panel while it was already running.
 *
 * ```jsx
 * useAppActivate((ctx) => activateWindow(win, { timestamp: ctx.timestamp }));
 * ```
 *
 * Nothing is raised for you: an app that answers a second launch by opening a
 * new document should not have to undo a raise first.
 */
export function useAppActivate(handler) {
  useLaunchSubscription(onAppActivate, handler);
}
