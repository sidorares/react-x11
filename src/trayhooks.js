// `useTray()` — an icon in the system tray for as long as a component is
// mounted, on the backends that have one.
//
// Today that is the cocoa backend's menu-bar extra (`NSStatusItem`,
// src/cocoa/statusitem.js). The freedesktop counterpart, StatusNotifierItem
// over D-Bus, is react-x11#353's open question; until it lands the hook is
// inert on X11 and says so — `available: false`, and a one-time development
// note — rather than pretending, so an app can keep the feature behind the
// answer. The inert-props policy of docs/macos.md, for a hook.

import { useEffect, useRef, useState } from 'react';

import { useAppOrNull } from './appcontext.js';

let warnedInert = false;

/**
 * An icon in the system tray while this component is mounted.
 *
 * ```jsx
 * const { available } = useTray({
 *   icon: 'bell.badge',              // an SF Symbol name, or PNG bytes
 *   tooltip: 'Notifications',
 *   menu: [{ label: 'Open', onSelect: open }, { label: 'Quit', onSelect: quit }],
 * });
 * ```
 *
 * With `menu`, a click opens it — the same `items` vocabulary `MenuBar` and
 * `useDockMenu` take, an item's `onSelect` firing when picked. Without one,
 * `onClick` is called with the button and the item's screen rect, which is
 * where to anchor a popup of your own. `null` means no item. Every field
 * follows its value while mounted; the item is removed on unmount.
 *
 * `available` is whether this backend has a tray at all: false on X11
 * today (#353), and the honest answer to branch on.
 */
export function useTray(options) {
  const app = useAppOrNull();
  const available = typeof app?.createStatusItem === 'function';
  const itemRef = useRef(null);
  const [rect] = useState(null);

  // the options a click or a pick reads are the current render's, not the
  // ones the item was created with three minutes ago
  const live = useRef(options);
  live.current = options;

  useEffect(() => {
    if (!available) {
      if (process.env.NODE_ENV !== 'production' && !warnedInert && app) {
        warnedInert = true;
        console.warn(
          'react-x11: useTray() is inert on this backend — the freedesktop ' +
            'tray (StatusNotifierItem) is not implemented yet (#353). Read ' +
            '`available` to keep the feature behind the answer.',
        );
      }
      return undefined;
    }
    if (!options) return undefined;
    const item = app.createStatusItem({
      ...options,
      onClick: (ev) => live.current?.onClick?.(ev),
    });
    itemRef.current = item;
    return () => {
      itemRef.current = null;
      item.remove();
    };
    // Recreated only when the item comes or goes: the fields patch in
    // place below, and an `options` object rebuilt every render must not
    // rebuild the item every render.
  }, [app, available, options == null]);

  useEffect(() => {
    const item = itemRef.current;
    if (!item || !options) return;
    item.update({ ...options, onClick: (ev) => live.current?.onClick?.(ev) });
  }, [
    options?.icon,
    options?.title,
    options?.tooltip,
    options?.visible,
    options?.template,
    options?.length,
    options?.menu,
  ]);

  return { available, rect };
}
