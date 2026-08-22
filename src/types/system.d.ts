/**
 * What the machine around the app is doing — the monitors, the window
 * manager, the keyboard, whether anyone is at the desk, and the conventions
 * the app was launched under. See docs/system.md.
 */

import type { RefObject } from 'react';

import type { WindowStateName } from './elements.js';
import type { DrawnNode, NtkApp, NtkWindow, Rect } from './nodes.js';

// --------------------------------------------------------------------------
// Screens
// --------------------------------------------------------------------------

/**
 * Which tier answered.
 *
 * `'xinerama'` is the geometry-only answer that resolves during
 * `createRoot()`; `'randr'` is the same geometry with names, the primary flag
 * and physical sizes, and lands a moment later. `'screen'` is one entry
 * covering the whole display, for a server with neither extension.
 */
export type ScreensSource = 'randr' | 'xinerama' | 'screen' | 'test' | null;

export interface Screen {
  /** `'HDMI-1'`, `'eDP-1'` — **null** until RandR answers, and on a server
   *  without it. Treat null as "not known yet" rather than persisting it. */
  readonly name: string | null;
  /** Every output driving this monitor. Two names means it is mirrored. */
  readonly outputs: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * The monitor minus the panels — where a window can actually go.
   *
   * An approximation: `_NET_WORKAREA` is published for the whole virtual
   * desktop rather than per monitor, so it is applied as a per-axis bound.
   * Exact on one head; on several it still takes a top or bottom panel off
   * the height.
   */
  readonly available: Rect;
  readonly primary: boolean;
  readonly widthMM: number | null;
  readonly heightMM: number | null;
  /** Hz to two decimals (`59.99`), or null. */
  readonly refreshRate: number | null;
  readonly rotation: 0 | 90 | 180 | 270;
  /**
   * This monitor's own device-pixels-per-logical-pixel (docs/scale.md).
   * Where the desktop configured one factor it is the root's on every
   * entry; where the hardware answered, a retina lid and an office monitor
   * really do differ, and an app that places windows can honour that.
   * Geometry above is logical, like every rect the renderer hands out.
   */
  readonly scale: number;
}

export interface Screens {
  readonly screens: readonly Screen[];
  /** The primary monitor — or the only one, where nothing is flagged. */
  readonly primary: Screen | null;
  /** The desktop-wide `_NET_WORKAREA`, or null. */
  readonly workArea: Rect | null;
  /** The whole virtual screen every monitor sits in. */
  readonly virtual: Rect | null;
  readonly source: ScreensSource;
}

/**
 * The monitors this display has, live — re-renders when one is plugged in or
 * unplugged, when the arrangement changes, and when a panel moves.
 *
 * ```tsx
 * const { screens, primary } = useScreens();
 * ```
 */
export function useScreens(): Screens;

/**
 * Device pixels per logical pixel for this root — `1` on an ordinary
 * display, `2` on a retina panel, fractional on desktops configured to
 * 1.25/1.5. Resolved once by `createRoot` (see `RootOptions.scale`,
 * docs/scale.md) and static for the life of the root, so there is nothing
 * to subscribe to.
 *
 * Everything the renderer hands an app is already logical; reach for this
 * only to talk about device pixels deliberately — sizing detail in a
 * `<canvas onDraw>` (whose payload carries the same number), or showing
 * the factor in a settings pane.
 */
export function useScale(): number;

// --------------------------------------------------------------------------
// Window state
// --------------------------------------------------------------------------

export interface WindowState {
  /** This window has the keyboard. */
  readonly focused: boolean;
  /** **The one to branch on**: not minimized, and not fully covered. */
  readonly visible: boolean;
  /**
   * Fully covered by other windows — **always false when a compositing
   * manager is running**, which it is on every stock GNOME and KDE session.
   * A composited window is redirected offscreen and the server considers it
   * entirely visible. Prefer `visible`.
   */
  readonly obscured: boolean;
  /** `_NET_WM_STATE_HIDDEN`: iconified, or shaded away. */
  readonly minimized: boolean;
  /** Both axes. One axis alone shows up in `states`. */
  readonly maximized: boolean;
  /** What the window manager actually did, not what `<window fullscreen>`
   *  asked for. */
  readonly fullscreen: boolean;
  /** The raw `_NET_WM_STATE` names, e.g. `['maximized_vert', 'focused']` —
   *  what the window manager put there, where `<window states>` is what was
   *  asked for. */
  readonly states: readonly WindowStateName[];
  /** The workspace index, or null. A sticky window shows up in `states`. */
  readonly desktop: number | null;
}

/**
 * What the window manager has done with a window, live.
 *
 * ```tsx
 * const { focused, visible, fullscreen } = useWindowState();
 * ```
 *
 * With no argument it reads the window the component is in, inferred the way
 * {@link useTopLevelWindow} infers it. Pass a ref to be exact.
 */
export function useWindowState(
  ref?: RefObject<NtkWindow | DrawnNode | null> | null,
): WindowState;

// --------------------------------------------------------------------------
// Idle and inhibition
// --------------------------------------------------------------------------

/**
 * Whether the user has been away from the keyboard for `timeout`
 * milliseconds.
 *
 * ```tsx
 * const away = useIdle(5 * 60_000);
 * ```
 *
 * Idleness is the whole display's, not this window's — it counts input on
 * every device, whichever application it went to. For "has the user ignored
 * *my* window", read `useWindowState().focused`.
 *
 * Costs no timer where the X server carries an `IDLETIME` counter (Xorg
 * does): a SYNC alarm fires on each crossing. Falls back to polling
 * MIT-SCREEN-SAVER, and stays `false` on a display with neither.
 */
export function useIdle(timeout: number): boolean;

/**
 * Keep the screen awake while `active` is true, releasing on unmount.
 *
 * ```tsx
 * useKeepAwake(playing, 'Playing a video');
 * ```
 *
 * Inhibits **screen blanking only** — nothing here stops a suspend. Silent
 * where no rung is available.
 */
export function useKeepAwake(active: boolean, reason?: string): void;

export interface KeepAwakeOptions {
  /** Shown by desktops that list what is holding the screen on. */
  reason?: string;
  /** The ntk connection, so the `ScreenSaverSuspend` rung can run — the one
   *  that needs no session bus. */
  app?: NtkApp;
}

/**
 * The imperative twin of {@link useKeepAwake}: resolves to the release.
 *
 * Never rejects — a machine with no portal, no screensaver service and no
 * MIT-SCREEN-SAVER hands back a release that does nothing.
 */
export function keepAwake(options?: KeepAwakeOptions): Promise<() => void>;

// --------------------------------------------------------------------------
// Keyboard
// --------------------------------------------------------------------------

export interface KeyboardState {
  /** On or off **now** — not "was on for the last key", which is what an
   *  event's modifier state can tell you. */
  readonly capsLock: boolean;
  readonly numLock: boolean;
  /** The active XKB group, 0–3. */
  readonly group: number;
  /** That group's layout code — `'ru'` — or null. */
  readonly layout: string | null;
  /** Every configured layout, `['us', 'ru']`. Empty where XKB could not be
   *  asked, which is what distinguishes "off" from "not known". */
  readonly layouts: readonly string[];
}

/**
 * The keyboard's locks and layout, live.
 *
 * ```tsx
 * const { capsLock, layout } = useKeyboardState();
 * ```
 *
 * True of the keyboard rather than of an event, so a password field can warn
 * about Caps Lock before the first character is typed. Needs XKB; the locks
 * read false without it.
 */
export function useKeyboardState(): KeyboardState;

// --------------------------------------------------------------------------
// Desktop interaction settings
// --------------------------------------------------------------------------

export interface DesktopSettings {
  /** **False means do not blink at all** — an accessibility setting, not a
   *  preference. Draw the caret solid rather than not at all. */
  readonly caretBlink: boolean;
  /** How long a caret stays in each state. The XSETTINGS key is a full
   *  cycle; this is half of it, which is what goes into a timer. */
  readonly caretBlinkMs: number;
  readonly doubleClickMs: number;
  readonly doubleClickDistance: number;
  /** How far a press moves before it is a drag rather than a click. */
  readonly dragThreshold: number;
  /** `'xsettings'`, or null where no settings daemon answered and these are
   *  the renderer's own defaults. */
  readonly source: 'xsettings' | 'test' | null;
}

/**
 * How this desktop wants an application to feel, live.
 *
 * ```tsx
 * const { doubleClickMs, dragThreshold } = useDesktopSettings();
 * ```
 *
 * The built-in controls already follow these. This is for an app drawing its
 * own — a `<canvas>` with a text cursor, a custom gesture — so that one
 * widget on the screen does not feel unlike every other.
 */
export function useDesktopSettings(): DesktopSettings;

// --------------------------------------------------------------------------
// Locale
// --------------------------------------------------------------------------

export interface SystemLocale {
  /** A BCP-47 tag: `'en-GB'`, `'ru-RU'`. */
  readonly locale: string;
  readonly direction: 'ltr' | 'rtl';
  /** `0` Sunday … `6` Saturday, from CLDR. */
  readonly weekStartsOn: number;
  readonly timeZone: string | null;
  /** `'env'` when `LANG` and friends said, `'intl'` when ICU did. */
  readonly source: 'env' | 'intl' | 'test' | null;
}

/**
 * Which language and conventions this app was started in.
 *
 * ```tsx
 * const { locale, weekStartsOn } = useLocale();
 * ```
 *
 * `LC_ALL`/`LC_MESSAGES`/`LANG` win over `Intl`'s own answer. **This does not
 * change while the app runs** and there is no subscription behind it — a
 * process's environment is fixed at exec.
 *
 * For text direction inside a component prefer `useDirection()`, which also
 * honours `<ThemeProvider direction>` and the `direction` style property.
 */
export function useLocale(): SystemLocale;

/** The imperative twin of {@link useLocale}, for code outside a tree. */
export function systemLocale(): SystemLocale;
