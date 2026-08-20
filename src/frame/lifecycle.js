// The pane's side of the frame lifecycle — the two things a module loaded
// into a `<Frame>` can ask about the world it landed in. Its own file so a
// pane (and the components it imports) can use these without pulling in the
// parent-side supervisor or the child bootstrap, neither of which belongs in
// a bundle of UI code.

import { useEffect } from 'react';

/**
 * Whether this process is a `<Frame>` pane. An environment fact rather
 * than a hook, so a module can branch at load time — the usual reason to
 * ask is "am I my own application?", and a pane module's
 * `import.meta.main`-style autorun guard is where that question is asked.
 *
 * The env var is what the fork sets and what load-time code reads; the
 * flag beside it is `runFrameChild` saying so directly, which is what
 * makes a pane run behind a custom transport — no fork, no env — answer
 * the same.
 */
let framed = false;
export function isFramed() {
  return framed || process.env.REACT_X11_FRAME === '1';
}

/** `runFrameChild`'s mark. Internal. */
export function markFramed() {
  framed = true;
}

/** What `runCloseHandlers` drains. Module state, like the compose table:
 * one pane process has one close, however many components listen for it. */
const closeHandlers = new Set();

/**
 * `handler` runs when the host is letting this pane go — the `<Frame>`
 * unmounted, the host app is exiting — and the pane has a moment to flush
 * what it would mind losing. It may return a promise; the host's patience
 * is bounded (the parent escalates to SIGTERM), so "a moment" is meant
 * literally: hundreds of milliseconds, not a sync.
 *
 * Not called when the pane crashes, and not called when the host is killed
 * outright — a close handler is a courtesy, and anything that must survive
 * a crash belongs on disk before the close.
 *
 * Outside a frame it registers nothing and the handler never runs.
 */
export function useFrameClose(handler) {
  useEffect(() => {
    if (!isFramed() || typeof handler !== 'function') return undefined;
    closeHandlers.add(handler);
    return () => closeHandlers.delete(handler);
  }, [handler]);
}

/**
 * Run every close handler, bounded by `timeout`. The bootstrap calls this
 * on the `unmount` message, before unmounting the root — so a handler still
 * has its tree, its connection and its state.
 */
export async function runCloseHandlers(timeout = 800) {
  if (closeHandlers.size === 0) return;
  const pending = [...closeHandlers].map(async (handler) => handler());
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => setTimeout(resolve, timeout).unref?.()),
  ]);
}
