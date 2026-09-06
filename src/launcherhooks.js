// `useBadge()` and `useDockMenu()` — the launcher's view of the app, as
// things a component declares rather than manages.
//
// The badge lives in `launcher.js` and is cross-backend; the Dock menu is
// the cocoa backend's alone, because its freedesktop counterpart — desktop
// actions in the `.desktop` file — is an install step and not runtime code.
// Where a hook has no mechanism it is inert, with a one-time development
// note naming the backend: the inert-props policy of docs/macos.md, so
// shared app code stays branch-free.

import { useEffect, useRef } from 'react';

import { useAppOrNull } from './appcontext.js';
import { setBadge } from './launcher.js';

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

let warnedInert = false;

/**
 * The menu behind a right-click on the Dock icon, from the same `items`
 * vocabulary `MenuBar` and `ContextMenu` take — an item's `onSelect` fires
 * when the user picks it.
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
 * changes, and taken down on unmount. Inert off the cocoa backend, with a
 * development note the first time.
 */
export function useDockMenu(items) {
  const app = useAppOrNull();
  // read at activation time, so a pick three minutes from now runs the
  // handler from the current render rather than the mounting one
  const live = useRef(items);
  live.current = items;

  useEffect(() => {
    if (typeof app?.setDockMenu !== 'function') {
      if (process.env.NODE_ENV !== 'production' && !warnedInert && app) {
        warnedInert = true;
        console.warn(
          'react-x11: useDockMenu() is inert on this backend — only the ' +
            'cocoa backend has a Dock. On a Linux desktop the counterpart ' +
            'is desktop actions in the .desktop file (docs/desktop.md).',
        );
      }
      return undefined;
    }
    app.setDockMenu(items ?? null);
    return () => app.setDockMenu(null);
  }, [items, app]);
}
