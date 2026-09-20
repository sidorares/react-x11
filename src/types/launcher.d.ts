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
 * The menu behind a right-click on the app's **launcher icon** — the Dock on
 * macOS, the launcher on Linux — from the same item vocabulary `MenuBar`
 * takes; an item's `onSelect` fires when picked. Installed while mounted,
 * replaced when `items` changes, taken down on unmount.
 *
 * `NSDockTile`'s menu on the cocoa backend; the launcher protocol's
 * **quicklist** on Linux — a `com.canonical.dbusmenu` tree, the same menu
 * protocol the tray and the global menu speak. Needs the identity
 * `registerApplication({ appId })` establishes and a `.desktop` file of that
 * name, like the badge.
 *
 * Reads `useDesktopCapability('launcher').features.menu`.
 */
export declare function useLauncherMenu(items: MenuItem[] | null): void;

/** @deprecated Renamed to {@link useLauncherMenu} — "Dock" is one desktop's
 *  word for the icon every desktop has. Still exported and still works. */
export declare function useDockMenu(items: MenuItem[] | null): void;

/**
 * A progress bar across the app's icon, `0`…`1`. `null` clears it; values
 * outside the range are clamped rather than refused.
 *
 * The launcher protocol's `progress`. **Linux launchers only** — `NSDockTile`
 * has no progress bar, so this is inert on the cocoa backend and
 * `useDesktopCapability('launcher').features.progress` is the honest answer.
 */
export declare function setProgress(
  value: number | null | false | undefined,
  options?: SetBadgeOptions,
): Promise<boolean>;

/** {@link setProgress} while mounted; cleared on unmount. */
export declare function useProgress(
  value: number | null | false | undefined,
): void;

/**
 * Ask the launcher for the user's attention, or stop asking.
 *
 * Distinct from `<window states={['demands_attention']}>`, which is the
 * *window's* urgency hint: this marks the app's icon in the launcher whether
 * or not any window is open. Inert on the cocoa backend, where the window
 * state is the mechanism.
 */
export declare function setUrgent(
  urgent: boolean,
  options?: SetBadgeOptions,
): Promise<boolean>;

/**
 * {@link useLauncherMenu}'s imperative twin, for code with no component.
 * `null` takes the menu down.
 */
export declare function setLauncherMenu(
  items: MenuItem[] | null,
  options?: SetBadgeOptions,
): Promise<boolean>;

/** @deprecated Renamed to {@link setLauncherMenu} — "quicklist" is the Unity
 *  launcher's word for the menu macOS calls the Dock menu, and this drove
 *  both all along. Still exported and still works. */
export declare function setQuicklist(
  items: MenuItem[] | null,
  options?: SetBadgeOptions,
): Promise<boolean>;
