// One supported way to turn a ref into the XID of the window it belongs to.
//
// The walk itself is not new — `anchor.js` has done it for popup placement
// since the beginning — but it was private, and two features need it at
// once: `transientFor` resolves its prop through this, and the
// xdg-desktop-portal work needs it to build a `parent_window` handle.

import { useCallback, useMemo } from 'react';

import { useAppOrNull } from './appcontext.js';

/**
 * The XID of the X11 window a ref points at, or `null` if there is not one
 * (yet). Accepts:
 *
 * - a `<window>` / `<popup>` ref — `getPublicInstance` hands back the live
 *   ntk window, so `ref.current.id` is the XID;
 * - a ref to any **drawn** node — resolved to the window that owns it;
 * - a raw XID, returned unchanged;
 * - the ref object itself, so `windowIdOf(ref)` works as well as
 *   `windowIdOf(ref.current)`.
 *
 * `null` is a real answer, not a failure: a ref is empty until the node
 * mounts, and a `<window>` has no XID until the commit phase realizes it.
 */
export function windowIdOf(target) {
  if (target == null) return null;
  if (typeof target === 'number') return target;
  // a ref object, so callers need not remember which one this takes
  if (typeof target === 'object' && 'current' in target && !target.isWindow) {
    return windowIdOf(target.current);
  }
  // an ntk Window (what a <window>/<popup> ref holds), or a WindowNode that
  // has been realized
  if (typeof target.id === 'number') return target.id;
  if (typeof target.window?.id === 'number') return target.window.id;
  // a drawn node: `root` is the WindowNode that owns it
  if (typeof target.root?.window?.id === 'number') return target.root.window.id;
  return null;
}

/**
 * `windowIdOf` bound to a ref: returns a **getter**, stable across renders,
 * the same shape `useAnchor` has. It is a getter rather than the id itself
 * because refs attach after the commit that created the window, so a value
 * read during render would be null on the render that matters.
 *
 * ```js
 * const windowId = useWindowId(anchorRef);
 * // …later, in an effect or a handler:
 * const parentWindow = `x11:${windowId().toString(16)}`; // xdg-desktop-portal
 * ```
 *
 * Note the format: lowercase hex, **no** `0x`. Both shipping portal backends
 * happen to tolerate a prefix, which is exactly why it is easy to get wrong
 * and never notice — and Qt's parser returns 0 on failure with no error
 * path, so a third backend would give an unparented, non-modal dialog rather
 * than an exception.
 */
export function useWindowId(ref) {
  return useCallback(() => windowIdOf(ref), [ref]);
}

/**
 * The top-level windows this connection is currently rendering, in the order
 * they were added.
 *
 * `createContainer(app, …)` passes the app as the container, so
 * `appendChildToContainer` records every top-level node on the app itself —
 * which makes "what windows does this tree have" answerable without the app
 * author wiring anything. Popups are excluded: a `<popup>` is
 * override-redirect and never what a dialog should be transient for.
 *
 * Not public: `useTopLevelWindow()` is the shape a component wants.
 * `activate.js` needs the list itself, to pick the window a raise with no
 * argument goes to.
 */
export function topLevelWindows(app) {
  if (!app) return [];
  return (app._rootChildren ?? []).filter(
    (node) => node?.isWindow && !node.isPopup && node.window?.id,
  );
}

let warnedAboutAmbiguity = false;

/**
 * The window a component belongs to, resolved when it is read.
 *
 * ```js
 * const owner = useTopLevelWindow();
 * // …later, in a handler, when everything is mounted:
 * const id = windowIdOf(owner);
 * ```
 *
 * **Why this is inference and not a lookup.** A hook has no position in the
 * host tree: React context cannot come from a host element, the host context
 * `getChildHostContext` builds reaches `createInstance` and not components,
 * and a `<window>` has no XID at all until the commit phase. Everything else
 * in this file walks *up from a node* — which is why the alternative is
 * `useRef` on the window and a line of wiring in every app that wants a
 * parented dialog.
 *
 * So it answers from what the renderer does know, at read time, when the tree
 * is mounted and realized:
 *
 * - **one top-level window — the overwhelmingly common case — is exact.** The
 *   component is in that window, because there is nowhere else to be.
 * - several, and one of them holds the X input focus: that one. You clicked
 *   in it a moment ago, which is why a dialog is opening.
 * - several with nothing to separate them: the most recently opened, and a
 *   development warning naming `parentWindow` as the way to be exact. A
 *   guess that says it is guessing beats a guess that does not.
 *
 * Returns a **ref-like object** rather than a number: the window is not
 * realized on the first render, so a value read then would be `null` on the
 * render that matters. It drops into anything that already takes a ref —
 * `parentWindow`, `transientFor` — and `windowIdOf()` resolves it.
 */
export function useTopLevelWindow() {
  const app = useAppOrNull();
  return useMemo(
    () => ({
      get current() {
        const windows = topLevelWindows(app);
        if (windows.length <= 1) return windows[0] ?? null;

        const focused = windows.filter((w) => w.events?.windowFocused);
        if (focused.length === 1) return focused[0];

        // Nothing separates them. `windowFocused` also defaults to true on an
        // ntk too old to report focus changes, so "all of them" is the same
        // answer as "none of them" and both land here.
        if (process.env.NODE_ENV !== 'production' && !warnedAboutAmbiguity) {
          warnedAboutAmbiguity = true;
          console.warn(
            `react-x11: this tree has ${windows.length} top-level windows and ` +
              'none of them is uniquely focused, so the owner window is a ' +
              'guess (the most recently opened). Pass the window explicitly ' +
              'to be exact:\n' +
              '  const win = useRef(null);\n' +
              '  const { openFile } = useFileDialog({ parentWindow: win });\n' +
              '  return <window ref={win}>…</window>;',
          );
        }
        return windows[windows.length - 1];
      },
    }),
    [app],
  );
}
