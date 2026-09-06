/**
 * The launcher's view of the app: a badge on its icon, and the Dock menu.
 * See docs/desktop.md "The launcher".
 */

import type { MenuItem } from './components.js';
import type { NtkApp } from './nodes.js';

/**
 * What a badge shows. A number shows on both backends; a string shows on
 * macOS and is a visible count of nothing on Linux, whose protocol carries
 * only a count. `0`, `null`, `''`, `false` and `undefined` all clear it.
 */
export type BadgeValue = number | string | null | false | undefined;

export interface SetBadgeOptions {
  /** The connection whose icon to badge, when there are several. */
  app?: NtkApp;
}

/**
 * Show `value` on the app's icon, or clear it.
 *
 * `NSDockTile.badgeLabel` on the cocoa backend; the
 * `com.canonical.Unity.LauncherEntry` signal on Linux, which needs the
 * identity `registerApplication({ appId })` establishes. Resolves to whether
 * a launcher was told, and never rejects for anything about the machine.
 */
export declare function setBadge(
  value: BadgeValue,
  options?: SetBadgeOptions,
): Promise<boolean>;

/** {@link setBadge} while mounted; cleared on unmount. */
export declare function useBadge(value: BadgeValue): void;

/**
 * The menu behind a right-click on the Dock icon, from the same item
 * vocabulary `MenuBar` takes; an item's `onSelect` fires when picked.
 * Installed while mounted, replaced when `items` changes, taken down on
 * unmount. Inert off the cocoa backend.
 */
export declare function useDockMenu(items: MenuItem[] | null): void;
