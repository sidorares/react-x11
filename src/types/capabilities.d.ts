/**
 * Feature discovery for the things an app does outside its own windows.
 * See docs/desktop.md "Feature discovery".
 */

/** Which mechanism answered. Named after the mechanism, never the platform. */
export type DesktopBackend =
  | 'dbus'
  | 'cocoa'
  | 'osascript'
  | 'notify-send'
  | 'statusnotifier'
  | 'launcherentry';

/** The capabilities {@link desktopCapability} can be asked about. */
export type DesktopCapabilityName = 'notifications' | 'tray' | 'launcher';

/**
 * What a notification can carry here.
 *
 * `actions`/`events` are the pair that decide whether a notification is a
 * conversation or a sign: false on the shell-out rungs and on a freedesktop
 * daemon that does not advertise `actions`, where buttons silently never
 * appear and nothing is ever reported back.
 */
export interface NotificationFeatures {
  actions: boolean;
  /** `onAction`/`onClose` will fire. Tracks `actions` on every rung. */
  events: boolean;
  /** `update()` replaces the banner in place rather than posting a new one. */
  update: boolean;
  close: boolean;
  body: boolean;
  bodyMarkup: boolean;
  bodyImage: boolean;
  icon: boolean;
  sound: boolean;
  /** The banner survives in a tray or centre rather than expiring unseen. */
  persistence: boolean;
  urgency: boolean;
}

export interface TrayFeatures {
  menu: boolean;
  /** An icon named in the desktop's theme (an SF Symbol on the cocoa rung). */
  iconName: boolean;
  iconBytes: boolean;
  attention: boolean;
  overlay: boolean;
  tooltip: boolean;
  title: boolean;
  click: boolean;
  clickPosition: boolean;
  /** The item's screen rect. False on the freedesktop rung, which has none. */
  clickRect: boolean;
  /** Modifier state on a click. False on the freedesktop rung. */
  clickModifiers: boolean;
  scroll: boolean;
}

export interface LauncherFeatures {
  badge: boolean;
  /** A string badge. macOS only — the launcher protocol carries a count. */
  badgeText: boolean;
  progress: boolean;
  urgent: boolean;
  /** The Dock menu / quicklist. */
  menu: boolean;
  /** The launcher needs an installed `.desktop` file to attach this to. */
  needsDesktopFile: boolean;
}

export interface DesktopCapabilityResult<F = Record<string, boolean>> {
  /** Whether there is any mechanism at all. Branch on `features` for detail. */
  available: boolean;
  backend: DesktopBackend | null;
  /** Empty when `available` is false. */
  features: Partial<F>;
  /**
   * Why not, when the `false` has a cause worth naming.
   *
   * `'no-app-id'` — the launcher needs `registerApplication({ appId })`, and
   * this one is a mistake in the source.
   * `'not-primary'` — it was called, and another copy of the app owns the
   * identity. Correct single-instance behaviour, not a bug: the first copy
   * owns the badge and the quicklist.
   */
  reason?: 'no-app-id' | 'not-primary';
}

export type DesktopCapabilityFor<N extends DesktopCapabilityName> =
  N extends 'notifications'
    ? DesktopCapabilityResult<NotificationFeatures>
    : N extends 'tray'
      ? DesktopCapabilityResult<TrayFeatures>
      : DesktopCapabilityResult<LauncherFeatures>;

export declare const CAPABILITIES: readonly DesktopCapabilityName[];

/** The "nothing here" answer: available false, no backend, no features. */
export declare const NO_CAPABILITY: DesktopCapabilityResult;

/**
 * What this desktop can do for one feature.
 *
 * Never cached — a panel restarting or an extension being enabled changes the
 * answer, and a cached `false` would outlive the fix. Throws only for an
 * unknown name, which is a mistake in the source.
 */
export declare function desktopCapability<N extends DesktopCapabilityName>(
  name: N,
  options?: { app?: unknown },
): Promise<DesktopCapabilityFor<N>>;

/**
 * {@link desktopCapability} as render state: {@link NO_CAPABILITY} on the
 * first frame, settling a tick later, and re-probed whenever a name appears
 * or vanishes on the session bus.
 *
 * Use it for the *pre-flight* question — a settings screen that must render a
 * "Show tray icon" checkbox without putting an icon in the tray. Where the
 * feature is actually mounted, the feature hook's own status is a measurement
 * rather than a prediction and should be preferred.
 */
export declare function useDesktopCapability<N extends DesktopCapabilityName>(
  name: N,
): DesktopCapabilityFor<N>;
