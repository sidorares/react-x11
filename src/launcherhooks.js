// `useBadge()`, `useProgress()` and `useDockMenu()` — the launcher's view of
// the app, as things a component declares rather than manages.
//
// All three now have a rung on both backends except progress, which has one
// only on Linux (`NSDockTile` has no progress bar; see `setProgress`). Where
// a hook has no mechanism it is inert and silent: a mark on an icon is not a
// feature an app should branch on, and a development warning for every
// desktop that lacks one is a warning nobody can act on.
//
// The one that changed shape is `useDockMenu`. It used to be cocoa-only on
// the grounds that the freedesktop counterpart was an install step — see
// `launcher.js`, where that reasoning is corrected: the launcher protocol
// carries a `quicklist` dbusmenu, so the Dock menu is runtime code on both.

import { useEffect, useRef } from 'react';

import { useAppOrNull } from './appcontext.js';
import { setBadge, setProgress, setQuicklist } from './launcher.js';

/**
 * Show `value` on the app's icon while this component is mounted, and clear
 * it on unmount.
 *
 * ```jsx
 * useBadge(unread); // a count; 0 clears
 * ```
 *
 * A number shows on both backends; a string shows on macOS only — see
 * docs/desktop.md. Nothing is shown where nothing can show it, silently: a
 * badge is not a feature an app should branch on.
 */
export function useBadge(value) {
  const app = useAppOrNull();
  useEffect(() => {
    setBadge(value, { app }).catch(() => {});
  }, [value, app]);
  useEffect(() => {
    return () => {
      setBadge(null, { app }).catch(() => {});
    };
  }, [app]);
}

/**
 * A progress bar across the app's icon, `0`…`1`, cleared on unmount.
 *
 * ```jsx
 * useProgress(done / total); // null or undefined clears it
 * ```
 *
 * Linux launchers only — the Dock has no progress bar of its own.
 */
export function useProgress(value) {
  const app = useAppOrNull();
  useEffect(() => {
    setProgress(value, { app }).catch(() => {});
  }, [value, app]);
  useEffect(() => {
    return () => {
      setProgress(null, { app }).catch(() => {});
    };
  }, [app]);
}

/**
 * The menu behind a right-click on the app's icon in the Dock or launcher,
 * from the same `items` vocabulary `MenuBar` and `ContextMenu` take — an
 * item's `onSelect` fires when the user picks it.
 *
 * ```jsx
 * useDockMenu([
 *   { label: 'New Window', onSelect: openWindow },
 *   { type: 'separator' },
 *   { label: 'Recent', items: recent.map(toItem) },
 * ]);
 * ```
 *
 * Installed for as long as the component is mounted, replaced when `items`
 * changes, and taken down on unmount. `NSDockTile`'s menu on the cocoa
 * backend; the launcher protocol's `quicklist` on Linux, which needs the
 * identity `registerApplication({ appId })` establishes and a `.desktop` file
 * of that name for a launcher to attach it to.
 */
export function useDockMenu(items) {
  const app = useAppOrNull();
  // read at activation time, so a pick three minutes from now runs the
  // handler from the current render rather than the mounting one
  const live = useRef(items);
  live.current = items;

  useEffect(() => {
    setQuicklist(items ?? null, { app }).catch(() => {});
  }, [items, app]);

  useEffect(() => {
    return () => {
      setQuicklist(null, { app }).catch(() => {});
    };
  }, [app]);
}
