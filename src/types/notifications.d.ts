/**
 * Desktop notifications — a banner outside the app's own windows. See
 * docs/notifications.md.
 */

import type { NtkApp } from './nodes.js';

/** Which rung of the ladder answered — or would. */
export type NotificationBackend =
  'cocoa' | 'dbus' | 'osascript' | 'notify-send';

export type NotificationUrgency = 'low' | 'normal' | 'critical';

/** Why a banner went away: the freedesktop reasons. */
export type NotificationCloseReason =
  'expired' | 'dismissed' | 'closed' | 'unknown';

export interface NotificationAction {
  /** Reported to `onAction`. `'default'` is the click on the banner itself
   * and not a name for an action of your own. */
  key: string;
  label?: string;
}

export interface NotificationOptions {
  /** The one line every daemon shows. Required. */
  summary: string;
  body?: string;
  /** macOS only; folded into the body elsewhere. */
  subtitle?: string;
  /** An icon-theme name, or an absolute path to an image. Rungs that cannot
   * show one ignore it. */
  icon?: string;
  urgency?: NotificationUrgency;
  /** Milliseconds until it expires on its own; `0` never; absent is the
   * daemon's default. */
  timeout?: number;
  /** Buttons on the banner. Dropped, with a development warning, on a daemon
   * without the `actions` capability; never sent on the shell-out rungs. */
  actions?: NotificationAction[];
  onAction?: (key: string) => void;
  onClose?: (reason: NotificationCloseReason) => void;
  /** `true` posts without a sound on macOS. */
  silent?: boolean;
  /** A freedesktop category hint (`'transfer.complete'`, …). */
  category?: string;
  /** Keep the banner after an action is invoked (freedesktop `resident`). */
  resident?: boolean;
  /** The name a daemon shows for the sender; the process title otherwise. */
  appName?: string;
  /** The desktop-entry id the banner is attributed to; the registration's
   * `appId` otherwise. */
  appId?: string;
  /** Opaque data round-tripped on the macOS rung. */
  userInfo?: Record<string, unknown>;
  /** Force a rung, for kiosks and for tests. */
  backend?: NotificationBackend;
  /** The connection whose centre to post through, when there are several. */
  app?: NtkApp;
}

export interface NotificationHandle {
  /** The daemon's id, the centre's identifier, or `null` where the rung has
   * none (a shell-out). */
  readonly id: number | string | null;
  readonly backend: NotificationBackend;
  /** Replace the banner in place. On a shell-out rung without an id this
   * posts a fresh one. */
  update(patch: Partial<NotificationOptions>): Promise<NotificationHandle>;
  /** Take it down. Nothing on a shell-out rung. */
  close(): Promise<void>;
}

/**
 * Nothing on this machine can show a notification. A **typed** rejection,
 * the `NoFileDialogError` rule; `useNotifier().available` is that branch as
 * render state. A centre that exists and *refused* (the user turned the
 * app's notifications off) rejects with the platform's own error instead —
 * a refusal is not fallen through.
 */
export declare class NoNotificationServiceError extends Error {
  readonly name: 'NoNotificationServiceError';
  readonly cause?: unknown;
}

/** Show a notification on the best rung this machine has. */
export declare function notify(
  options: NotificationOptions,
): Promise<NotificationHandle>;

/** Which rung this machine lands on, without posting anything. `null`
 * means {@link notify} would reject. */
export declare function notificationBackend(
  options?: Pick<NotificationOptions, 'app' | 'backend'>,
): Promise<NotificationBackend | null>;

export interface Notifier {
  notify(
    options: Omit<NotificationOptions, 'app'>,
  ): Promise<NotificationHandle>;
  /** Settled once the ladder has been probed; false where `notify` would
   * reject. */
  available: boolean;
  backend: NotificationBackend | null;
}

/** Notifications for a component: `notify` bound to the tree's connection,
 * `available` and `backend` as render state. */
export declare function useNotifier(
  defaults?: Omit<NotificationOptions, 'app' | 'summary'> & {
    summary?: string;
  },
): Notifier;
