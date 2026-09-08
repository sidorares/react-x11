/**
 * Permissions: may this app use the camera, the microphone, the screen, the
 * accessibility APIs — and how does it ask? See docs/permissions.md.
 */

import type { NtkApp } from './nodes.js';

export type PermissionKind =
  | 'camera'
  | 'microphone'
  | 'screen-recording'
  | 'accessibility'
  | 'input-monitoring'
  | 'automation'
  | 'location'
  | 'calendars'
  | 'reminders';

/** The panes `openPrivacySettings` reaches: every kind, plus the two with no
 * API because reading the folder is the prompt. */
export type PrivacyPane =
  PermissionKind | 'files-and-folders' | 'full-disk-access';

/**
 * `'granted'`, `'denied'` and `'restricted'` (MDM or parental controls — the
 * user cannot grant it) are the platform's; `'prompt'` is not decided yet, a
 * request would ask; `'unknown'` is "nothing here can say", a fact about the
 * machine rather than the permission. `'write-only'` is macOS 14's partial
 * grant for `calendars`/`reminders`: a grant to a writer, a refusal to a
 * reader, and only the caller knows which it is.
 */
export type PermissionStatus =
  'granted' | 'denied' | 'restricted' | 'prompt' | 'write-only' | 'unknown';

export interface PermissionOptions {
  /** The connection whose backend to ask, when there are several. */
  app?: NtkApp;
  /** `automation` only: the bundle id of the app to send Apple Events to.
   * Only a running target has an answer. */
  target?: string;
  /** `calendars` only: which grant to ask for. `'write-only'` is macOS 14's
   * narrower prompt — the app may save events it cannot read. `reminders`
   * has no such grant and refuses one. */
  access?: 'full' | 'write-only';
}

/**
 * Nothing on this machine can ask. A **typed** rejection, so a caller keeps
 * the feature behind it rather than crashing; `usePermission().available`
 * is that branch as render state, and `permissionStatus()` foretells it
 * with `'unknown'`.
 */
export declare class NoPermissionServiceError extends Error {
  readonly name: 'NoPermissionServiceError';
  readonly cause?: unknown;
}

/** Which rung answers here: `'cocoa'`, or `null` where a status would be
 * `'unknown'` and a request would reject. Synchronous. */
export declare function permissionBackend(
  options?: Pick<PermissionOptions, 'app'>,
): 'cocoa' | null;

/** Whether this app may use `kind`, without prompting. Never rejects for
 * anything about the machine. */
export declare function permissionStatus(
  kind: PermissionKind,
  options?: PermissionOptions,
): Promise<PermissionStatus>;

/**
 * Ask for `kind` — the system's prompt where there is one — and resolve
 * with the status once the user has answered. Rejects with
 * {@link NoPermissionServiceError} where nothing can ask.
 */
export declare function requestPermission(
  kind: PermissionKind,
  options?: PermissionOptions,
): Promise<PermissionStatus>;

/**
 * System Settings › Privacy & Security › `pane`, or the Privacy pane with
 * none. Through the bridge where there is one, by `open` on any Mac
 * otherwise. Resolves to whether anything opened — `false` off macOS.
 */
export declare function openPrivacySettings(
  pane?: PrivacyPane | null,
  options?: Pick<PermissionOptions, 'app'>,
): Promise<boolean>;

export interface Permission {
  /** `'unknown'` until read; re-read after each `request()`. */
  status: PermissionStatus;
  /** Whether this backend has an authorization API at all. */
  available: boolean;
  /** Ask, and update `status`. A second call while one is in flight
   * returns the same promise. */
  request(): Promise<PermissionStatus>;
  /** Re-read the status on your own cue. */
  refresh(): Promise<PermissionStatus>;
  openSettings(): Promise<boolean>;
}

/** A permission for a component: the status as render state. */
export declare function usePermission(
  kind: PermissionKind,
  options?: Pick<PermissionOptions, 'target' | 'access'>,
): Permission;
