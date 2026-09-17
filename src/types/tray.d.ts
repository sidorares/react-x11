/**
 * The system tray: `useTray()`. See docs/desktop.md "The tray".
 */

import type { MenuItem } from './components.js';
import type { DesktopBackend, TrayFeatures } from './capabilities.js';

export interface TrayClickEvent {
  button: 'left' | 'right' | 'middle';
  /** Where the click was: global top-left screen coordinates in **logical
   * pixels**, the unit a `<popup>`'s `x`/`y` and `anchor={{ rect }}` take —
   * the anchor for a popup of your own. The freedesktop protocol names no
   * unit for its point and hosts differ, so there it is read against the
   * monitors and the pointer; docs/desktop.md "The tray" says where that
   * cannot tell. */
  x: number;
  y: number;
  /** The item's rect. `0` on the freedesktop rung, whose protocol has none —
   * read `features.clickRect` rather than testing for zero. */
  width: number;
  height: number;
  /** `1` on the freedesktop rung, which does not count clicks. */
  clickCount: number;
  /** All `false` on the freedesktop rung, which carries no modifier state.
   * `features.clickModifiers` is the honest answer. */
  shift: boolean;
  control: boolean;
  option: boolean;
  command: boolean;
}

export interface TrayOptions {
  /** A themed icon name — an SF Symbol on the cocoa rung (`'bell.badge'`),
   * an icon-theme name on a freedesktop one (`'mail-unread'`) — or the bytes
   * of a PNG. On the cocoa rung bytes are drawn as a template image so they
   * follow the bar's light and dark. */
  icon?: string | Uint8Array | null;
  /** Shown instead of `icon` while `attention` is set. Freedesktop only. */
  attentionIcon?: string | Uint8Array | null;
  /** A small badge drawn over the icon. Freedesktop only. */
  overlayIcon?: string | Uint8Array | null;
  /** Ask the panel to mark the item — `Status = NeedsAttention`.
   * Freedesktop only; `features.attention` says so. */
  attention?: boolean;
  /** The spec's item category: `'ApplicationStatus'` (default),
   * `'Communications'`, `'SystemServices'` or `'Hardware'`. Freedesktop
   * only, and mostly affects where a panel sorts the icon. */
  category?: string;
  /** A directory to look `icon` up in, for icons shipped beside the app
   * rather than installed in a theme. Freedesktop only. */
  iconThemePath?: string;
  /** A scroll over the icon. Freedesktop only. */
  onScroll?: (event: { delta: number; orientation: string }) => void;
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
  /**
   * Whether **this item** was taken by a tray.
   *
   * A measurement, not a prediction: the hook tried. It **settles** — false
   * on the first frame, true a tick later if a host is there — so render the
   * fallback first and upgrade. It follows the host, so a panel that exits
   * flips it back.
   */
  available: boolean;
  /**
   * Whether `available` is an answer yet: true on the first frame on macOS,
   * where the status item is made there and then, and for `null` options;
   * on the freedesktop tray, once the host has taken or refused the item. An
   * app whose whole UI is its tray renders nothing until this, instead of a
   * fallback window that flashes on every start.
   */
  settled: boolean;
  /** Which mechanism took it, or null. */
  backend: DesktopBackend | null;
  /** What that mechanism can do. Empty until `available` settles. */
  features: Partial<TrayFeatures>;
  /**
   * A tray that answered and then **refused**, which is a different fact from
   * a desktop with no tray — and the only one of the two with a fix. Null
   * when there is simply no tray.
   */
  error: Error | null;
  /** Reserved. */
  rect: null;
}

/**
 * An icon in the system tray while this component is mounted; every field
 * follows its value, and the item is removed on unmount. `null` means no
 * item.
 *
 * `NSStatusItem` on the cocoa backend; `org.kde.StatusNotifierItem` over
 * D-Bus on a freedesktop session, which needs something hosting a tray —
 * Plasma and most panels do, GNOME needs an AppIndicator extension. Where
 * neither answers, `available` stays false and nothing is logged.
 */
export declare function useTray(options: TrayOptions | null): TrayState;
