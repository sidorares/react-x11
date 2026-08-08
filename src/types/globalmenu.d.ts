/**
 * The global menu — handing a window's menu bar to the desktop's panel.
 *
 * `MenuBar` does all of this itself. These names are for a component that
 * draws its own bar and wants the same behaviour. See docs/globalmenu.md.
 */

import type { MenuBarMenu, MenuItem } from './components.js';

export interface GlobalMenuOptions {
  /** Runs after the item's own `onSelect`, exactly as `MenuBar`'s does. */
  onSelect?: (item: MenuItem) => void;
  /**
   * A submenu is about to be shown. dbusmenu wants a synchronous answer that
   * React cannot give, so this is a notification rather than a chance to
   * fill the menu in time — update state from it and the new items reach the
   * panel one round trip later. See docs/globalmenu.md.
   */
  onAboutToShow?: (item: MenuItem) => void;
  /** `false` keeps the menu in the window. Defaults to `true`. */
  enabled?: boolean;
}

/**
 * Is this window's menu being drawn by the desktop?
 *
 * `false` until proven otherwise, and the proof is a registrar answering
 * `RegisterWindow` — so no bus, no panel, or a panel that refused the
 * registration all keep the menu where the app drew it.
 *
 * ```tsx
 * const exported = useGlobalMenu(menus, { onSelect });
 * if (exported) return null;
 * ```
 */
export function useGlobalMenu(
  menus: readonly MenuBarMenu[] | undefined,
  options?: GlobalMenuOptions,
): boolean;

/** The bus name a panel owns while it is showing application menus. */
export const REGISTRAR_NAME: string;
