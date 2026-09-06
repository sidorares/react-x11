/**
 * The system tray: `useTray()`. See docs/desktop.md "The tray".
 */

import type { MenuItem } from './components.js';

export interface TrayClickEvent {
  button: 'left' | 'right' | 'middle';
  /** The item's screen rect, global top-left coordinates in points — the
   * anchor for a popup of your own. */
  x: number;
  y: number;
  width: number;
  height: number;
  clickCount: number;
  shift: boolean;
  control: boolean;
  option: boolean;
  command: boolean;
}

export interface TrayOptions {
  /** An SF Symbol name (`'bell.badge'`), or the bytes of a PNG. Drawn as a
   * template image so it follows the bar's light and dark. */
  icon?: string | Uint8Array | null;
  /** Text beside the icon, or alone. */
  title?: string | null;
  tooltip?: string | null;
  /** The menu a click opens — `MenuBar`'s item vocabulary. Without one,
   * clicks reach `onClick`. */
  menu?: MenuItem[] | null;
  onClick?: (event: TrayClickEvent) => void;
  visible?: boolean;
  /** `false` keeps a PNG's own colours instead of drawing it as a template. */
  template?: boolean;
  /** `'variable'` (default) | `'square'` | a width in points. */
  length?: 'variable' | 'square' | number;
  /** The image's size in points, `[width, height]`. */
  iconSize?: [number, number];
}

export interface TrayState {
  /** Whether this backend has a tray at all — false on X11 today (#353). */
  available: boolean;
  /** Reserved. */
  rect: null;
}

/**
 * An icon in the system tray while this component is mounted; every field
 * follows its value, and the item is removed on unmount. `null` means no
 * item. Inert off the cocoa backend, with `available: false`.
 */
export declare function useTray(options: TrayOptions | null): TrayState;
