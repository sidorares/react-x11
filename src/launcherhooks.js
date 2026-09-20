// `useBadge()`, `useProgress()` and `useLauncherMenu()` — the launcher's view of
// the app, as things a component declares rather than manages.
//
// All three now have a rung on both backends except progress, which has one
// only on Linux (`NSDockTile` has no progress bar; see `setProgress`). Where
// a hook has no mechanism it is inert and silent: a mark on an icon is not a
// feature an app should branch on, and a development warning for every
// desktop that lacks one is a warning nobody can act on.
//
// The one that changed shape is `useLauncherMenu`. It used to be cocoa-only on
// the grounds that the freedesktop counterpart was an install step — see
// `launcher.js`, where that reasoning is corrected: the launcher protocol
// carries a `quicklist` dbusmenu, so the Dock menu is runtime code on both.

import { useEffect, useRef } from 'react';

import { useAppOrNull } from './appcontext.js';
import { setBadge, setLauncherMenu, setProgress } from './launcher.js';

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
 * The menu behind a right-click on the app's **launcher icon** — the Dock on
 * macOS, the launcher on Linux — from the same `items` vocabulary `MenuBar`
 * and `ContextMenu` take. An item's `onSelect` fires when the user picks it.
 *
 * ```jsx
 * useLauncherMenu([
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
 *
 * It reads `useDesktopCapability('launcher').features.menu`, which is where
 * the name comes from: every desktop has one icon standing for this
 * application and calls it something different — Dock, taskbar, panel, dash —
 * and `launcher` is the one word that is none of their words and all of their
 * meanings (AGENTS.md, "Vocabulary").
 */
export function useLauncherMenu(items) {
  const app = useAppOrNull();
  // read at activation time, so a pick three minutes from now runs the
  // handler from the current render rather than the mounting one
  const live = useRef(items);
  live.current = items;

  useEffect(() => {
    setLauncherMenu(items ?? null, { app }).catch(() => {});
  }, [items, app]);

  useEffect(() => {
    return () => {
      setLauncherMenu(null, { app }).catch(() => {});
    };
  }, [app]);
}

/**
 * @deprecated Renamed to {@link useLauncherMenu}. "Dock" is one desktop's
 * word for the icon every desktop has; this hook drove the Linux launcher's
 * quicklist long before the name caught up. Kept working, and kept quiet —
 * an alias that warned would punish an app for code that is still correct.
 */
export const useDockMenu = useLauncherMenu;
