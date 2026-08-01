// One supported way to turn a ref into the XID of the window it belongs to.
//
// The walk itself is not new — `anchor.js` has done it for popup placement
// since the beginning — but it was private, and two features need it at
// once: `transientFor` resolves its prop through this, and the
// xdg-desktop-portal work needs it to build a `parent_window` handle.

import { useCallback } from 'react';

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
