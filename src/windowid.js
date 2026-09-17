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
 * The window **object** behind anything `windowIdOf` accepts — ntk's on X11,
 * the cocoa backend's `CocoaWindow` — or `null`. The same walk, one step
 * short of the id: a `<window>` ref holds the object itself, a `<window>`
 * node has it as `window`, a drawn node reaches it through its `root`. A raw
 * XID resolves to nothing, because the number alone does not say which
 * connection issued it.
 *
 * Not public. The file dialog reaches the app a window belongs to through
 * it, which is how a call names the backend whose native panel it wants
 * without ever naming a backend.
 */
export function windowOf(target) {
  if (target == null || typeof target === 'number') return null;
  if (typeof target === 'object' && 'current' in target && !target.isWindow) {
    return windowOf(target.current);
  }
  if (typeof target.window?.id === 'number') return target.window;
  if (typeof target.root?.window?.id === 'number') return target.root.window;
  if (typeof target.id === 'number') return target;
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

/**
 * The root-level `<popup>`s this connection is currently rendering — the
 * half `topLevelWindows()` leaves out, in the order they were added.
 *
 * Only interesting when there are no top-level windows at all: a menu-bar
 * app whose whole UI is a popover a tray click opens has no `<window>` for
 * anything to belong to, and the popup *is* the top of that tree
 * (`useTopLevelWindow`). With a window in the tree these stay out of it, for
 * the reason they are out of `topLevelWindows()` — override-redirect is
 * never what a dialog should be transient for.
 */
function rootLevelPopups(app) {
  if (!app) return [];
  return (app._rootChildren ?? []).filter(
    (node) => node?.isWindow && node.isPopup && node.window?.id,
  );
}

let warnedAboutAmbiguity = false;

/**
 * One of several candidates, on the inference `useTopLevelWindow` documents:
 * one is exact, uniquely focused wins, and anything else is the most
 * recently opened plus a development warning that says so.
 */
function pickOwner(candidates, what) {
  if (candidates.length <= 1) return candidates[0] ?? null;

  const focused = candidates.filter((w) => w.events?.windowFocused);
  if (focused.length === 1) return focused[0];

  // Nothing separates them. `windowFocused` also defaults to true on an
  // ntk too old to report focus changes, so "all of them" is the same
  // answer as "none of them" and both land here.
  if (process.env.NODE_ENV !== 'production' && !warnedAboutAmbiguity) {
    warnedAboutAmbiguity = true;
    console.warn(
      `react-x11: this tree has ${candidates.length} ${what}, none of them ` +
        'uniquely focused, so the owner window is a guess (the most ' +
        'recently opened). Pass the window explicitly to be exact:\n' +
        '  const win = useRef(null);\n' +
        '  const { openFile } = useFileDialog({ parentWindow: win });\n' +
        '  return <window ref={win}>…</window>;',
    );
  }
  return candidates[candidates.length - 1];
}

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
 * - **no top-level window at all: the root-level `<popup>` that has the
 *   keyboard.** A menu-bar app is a tray item and a popover, and nothing
 *   else — there is no `<window>` for a shortcut, a file dialog or the
 *   global menu to belong to, and answering `null` made every one of them
 *   quietly do nothing (issue #616). A `grabKeyboard` popup is where the
 *   keys are by construction, so it is preferred over one that is merely
 *   up; among equals the same focus/most-recent inference applies.
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
        if (windows.length) return pickOwner(windows, 'top-level windows');

        // A popup-only tree — the tray popover. Not reached while the app
        // has a window, so nothing that already worked changes shape.
        const popups = rootLevelPopups(app);
        const keyboard = popups.filter((node) => node.props?.grabKeyboard);
        return pickOwner(
          keyboard.length ? keyboard : popups,
          'root-level popups and no window at all',
        );
      },
    }),
    [app],
  );
}
