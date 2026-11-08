// macOS privacy authorizations (TCC) on the cocoa backend, through
// @windowkit/appkit (>= 0.5): the rung that answers in src/permissions.js's
// ladder. `CocoaApp.permissions` is this object and its presence is the
// capability, the rule `filePanels` and `nativeBezels` follow.
//
// The bridge is mechanism — `authorizationStatus(kind, opts?)` never
// prompts, `requestAuthorization(kind, opts?, cb)` raises the system's
// prompt where a framework offers one and answers once, asynchronously,
// `openPrivacySettings(kind?)` deep-links — and its vocabulary is Apple's.
// What is decided here is the translation into the ladder's five words,
// and one thing worth knowing: a bare `node` process is attributed to its
// responsible process (the terminal, an IDE) or to `node` itself, and a
// bundled app must carry the usage-description keys
// (`NSCameraUsageDescription` and friends) or a request never prompts.
//
// A kind is newer than some bridges: `system-audio-recording` came with the
// process taps (appkit 0.32), and an older bridge throws on a kind it does
// not know. So a kind is asked only of a bridge that has it, and one that has
// not answers the ladder's `'unknown'` — nothing here can say — rather than
// a TypeError from inside the bridge.

import { NoPermissionServiceError } from '../permissions.js';

/** Apple's words as the ladder's. `writeOnly` is macOS 14's partial grant
 *  for EventKit — a grant to a writer, a refusal to a reader — and stays its
 *  own word for exactly that reason. */
const STATUS = Object.freeze({
  authorized: 'granted',
  denied: 'denied',
  restricted: 'restricted',
  notDetermined: 'prompt',
  writeOnly: 'write-only',
});

export function statusFromBridge(status) {
  return STATUS[status] ?? 'unknown';
}

/** The bridge's options for a kind: `automation` carries its target, and
 *  `calendars` the level being asked for (`reminders` has no write-only
 *  grant, and the bridge refuses one with a TypeError). */
function bridgeOptions(kind, options = {}) {
  if (kind === 'automation' && options.target != null) {
    return { target: String(options.target) };
  }
  if (kind === 'calendars' && options.access != null) {
    return { access: String(options.access) };
  }
  return undefined;
}

/** Whether the bridge knows `kind`: the kinds a bridge release added are
 *  known by the verbs that came with them. */
function bridgeKnows(native, kind) {
  if (kind === 'system-audio-recording') {
    return typeof native.openSystemAudio === 'function';
  }
  return true;
}

export class CocoaPermissions {
  constructor(native) {
    this._native = native;
  }

  status(kind, options) {
    if (!bridgeKnows(this._native, kind)) return 'unknown';
    const opts = bridgeOptions(kind, options);
    return statusFromBridge(
      opts
        ? this._native.authorizationStatus(kind, opts)
        : this._native.authorizationStatus(kind),
    );
  }

  request(kind, options) {
    if (!bridgeKnows(this._native, kind)) {
      return Promise.reject(new NoPermissionServiceError(kind));
    }
    const opts = bridgeOptions(kind, options);
    return new Promise((resolve, reject) => {
      const done = (granted, status) =>
        resolve(
          status != null
            ? statusFromBridge(status)
            : granted
              ? 'granted'
              : 'denied',
        );
      try {
        if (opts) this._native.requestAuthorization(kind, opts, done);
        else this._native.requestAuthorization(kind, done);
      } catch (err) {
        reject(err);
      }
    });
  }

  /** True once asked; null for a pane this bridge does not know, which the
   *  ladder then opens by its deep link. */
  openSettings(kind) {
    if (kind != null && !bridgeKnows(this._native, kind)) return null;
    if (kind == null) this._native.openPrivacySettings();
    else this._native.openPrivacySettings(kind);
    return true;
  }
}
