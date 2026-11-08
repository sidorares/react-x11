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
  | 'launcherentry'
  /** A Shell_NotifyIcon balloon. */
  | 'win32'
  /** The notify icon itself, as a tray. */
  | 'shellnotifyicon'
  /** `ITaskbarList3` and the jump list, as a launcher. */
  | 'taskbar'
  /** `GetImage` on the root window, as screen capture. */
  | 'x11'
  /** `fakeMediaDevices` from `react-x11/test`. */
  | 'fake';

/** The capabilities {@link desktopCapability} can be asked about. */
export type DesktopCapabilityName =
  | 'notifications'
  | 'tray'
  | 'launcher'
  | 'camera'
  | 'audioInput'
  | 'audioOutput'
  | 'screenCapture'
  | 'systemAudio';

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
  /**
   * A string badge rather than a count. False on the launcher protocol,
   * which carries a number; the taskbar draws the text into its overlay
   * icon, where about three glyphs fit before it becomes `99+`.
   */
  badgeText: boolean;
  progress: boolean;
  urgent: boolean;
  /**
   * The Dock menu / quicklist: entries that **call back into this process**.
   * False on the taskbar, whose menu is the jump list — see `tasks`.
   */
  menu: boolean;
  /** The launcher needs an installed `.desktop` file to attach this to. */
  needsDesktopFile: boolean;
  /**
   * Static entries on the icon's menu that start a **new process** with
   * arguments, rather than calling back into this one: the jump list's Tasks
   * category. A different feature from `menu`, and `useJumpList` drives it.
   */
  tasks: boolean;
  /**
   * Buttons under the icon's hover preview, which `useThumbnailToolbar`
   * drives. The taskbar's alone.
   */
  thumbnailToolbar: boolean;
  /**
   * The launcher keeps a Recent list this app can add to, through
   * `useRecentDocument`.
   */
  recentDocuments: boolean;
}

/** A camera's, where one can be opened (docs/media.md). */
export interface CameraFeatures {
  /** `useMediaDevices` follows cameras plugged in and out. */
  hotplug: boolean;
  /** Names are listed before any permission. */
  labelsBeforePermission: boolean;
  /** `<video srcObject>` shows the camera on a layer of its own, its frames
   * never crossing into JavaScript. */
  nativePreview: boolean;
}

export interface AudioInputFeatures {
  hotplug: boolean;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  /** Any `sampleRate` and `channelCount` asked is delivered as asked. */
  resample: boolean;
}

export interface AudioOutputFeatures {
  /** A sink can name an `audiooutput` device. */
  deviceSelection: boolean;
  /** What is played is the reference an echo-cancelled microphone
   * subtracts. */
  echoReference: boolean;
}

export interface ScreenCaptureFeatures {
  /** The system's own picker answers a `getDisplayMedia` with no source. */
  picker: boolean;
  /** `displaySources()` lists what there is. */
  enumerate: boolean;
  /** Whole screens can be captured. False on XQuartz, whose root window
   * holds nothing of what is on the screen. */
  screens: boolean;
  /** `getDisplayMedia` captures a stream. A backend can take screenshots
   * and not yet this: macOS, until ScreenCaptureKit's stream verbs. */
  streams: boolean;
  windows: boolean;
  cursor: boolean;
  /** A stream comes with the system's sound when `audio: 'system'` asks. */
  systemAudio: boolean;
  /** `<window excludeFromCapture>` keeps a window out of captures. */
  excludeWindows: boolean;
  /** `captureScreenshot()` reads the screen. */
  screenshot: boolean;
  thumbnails: boolean;
}

/** Other applications' sound, opened as a `'systemaudio'` device. */
export interface SystemAudioFeatures {
  /** One application's sound on its own: `system-audio:<appId>`. */
  applications: boolean;
  /** `system-audio` leaves this app's own sound out. */
  excludesSelf: boolean;
  /** Any `sampleRate` and `channelCount` asked is delivered as asked. */
  resample: boolean;
  /** The sources follow applications as they start and quit. */
  hotplug: boolean;
  /** A source says whether it is making a sound now (`playing`). */
  playing: boolean;
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
      : N extends 'camera'
        ? DesktopCapabilityResult<CameraFeatures>
        : N extends 'audioInput'
          ? DesktopCapabilityResult<AudioInputFeatures>
          : N extends 'audioOutput'
            ? DesktopCapabilityResult<AudioOutputFeatures>
            : N extends 'screenCapture'
              ? DesktopCapabilityResult<ScreenCaptureFeatures>
              : N extends 'systemAudio'
                ? DesktopCapabilityResult<SystemAudioFeatures>
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
): DesktopCapabilityState<N>;

/** {@link useDesktopCapability}'s answer, and whether it is one yet. */
export type DesktopCapabilityState<N extends DesktopCapabilityName> =
  DesktopCapabilityFor<N> & {
    /**
     * False until the first probe answers, and true from then on, re-probes
     * included — so an app can hold its fallback back rather than flash it.
     * True on the first frame where nothing had to be asked: the tray and
     * the Dock tile on macOS.
     */
    settled: boolean;
  };
