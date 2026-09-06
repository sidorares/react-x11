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

/** Apple's four words as the ladder's. */
const STATUS = Object.freeze({
  authorized: 'granted',
  denied: 'denied',
  restricted: 'restricted',
  notDetermined: 'prompt',
});

export function statusFromBridge(status) {
  return STATUS[status] ?? 'unknown';
}

/** The bridge's options for a kind: `automation` carries its target. */
function bridgeOptions(kind, options = {}) {
  return kind === 'automation' && options.target != null
    ? { target: String(options.target) }
    : undefined;
}

export class CocoaPermissions {
  constructor(native) {
    this._native = native;
  }

  status(kind, options) {
    const opts = bridgeOptions(kind, options);
    return statusFromBridge(
      opts
        ? this._native.authorizationStatus(kind, opts)
        : this._native.authorizationStatus(kind),
    );
  }

  request(kind, options) {
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

  openSettings(kind) {
    if (kind == null) this._native.openPrivacySettings();
    else this._native.openPrivacySettings(kind);
    return true;
  }
}
