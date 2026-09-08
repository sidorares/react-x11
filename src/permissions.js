// Permissions: may this app use the camera, the microphone, the screen, the
// accessibility APIs — and how does it ask?
//
// The file dialog's ladder again (docs/filedialog.md), with one rung that
// answers and one that only points:
//
//   1. **the platform's own authorization** — the cocoa backend, where the
//      bridge reads macOS's privacy (TCC) status per kind and raises the
//      system prompt where a framework offers one (src/cocoa/permissions.js).
//      Found by the app the tree renders through carrying `permissions`,
//      never by naming a backend here.
//   2. **the Settings pane** — `open x-apple.systempreferences:…` on a Mac
//      with no bridge (the X11 backend under XQuartz). It cannot read a
//      status or raise a prompt; it can put the user in front of the switch,
//      which is what `openPrivacySettings` promises and no more.
//
// On Linux nothing answers yet. The freedesktop counterparts are the
// per-device portals (`org.freedesktop.portal.Camera`, `.Location`), which
// need no bridge and are react-x11#466's remaining half; until then a
// status query says `'unknown'` and a request rejects with a **typed**
// error, the `NoFileDialogError` rule — a signal to keep the feature behind
// the answer, not a crash.
//
// ## Two things the vocabulary decides
//
// - A status is one of six words. `'granted'`, `'denied'` and
//   `'restricted'` (MDM or parental controls: the user cannot grant it) are
//   the platform's; `'prompt'` is "not decided yet — a request would ask";
//   `'unknown'` is "nothing here can say", which is a fact about the machine
//   rather than about the permission, and the reason a query never throws.
//   `'write-only'` is the sixth and the odd one: macOS 14's partial grant
//   for `calendars` and `reminders`, where the app may save an item it
//   cannot read. It crosses as its own word rather than being flattened
//   into one of the other two, because it is a grant to a writer and a
//   refusal to a reader and only the caller knows which it is.
// - A request answers with the status **after** the user has, never with a
//   bare boolean, because `'restricted'` and `'denied'` want different UI —
//   one is a Settings switch the user can flip, the other is not.

import { liveApps } from './trace-registry.js';

/** The kinds a status can be asked for. `automation` wants `{ target }`;
 *  `calendars` takes `{ access: 'write-only' }` for the narrower grant. */
export const PERMISSION_KINDS = Object.freeze([
  'camera',
  'microphone',
  'screen-recording',
  'accessibility',
  'input-monitoring',
  'automation',
  'location',
  'calendars',
  'reminders',
]);

/** The Settings panes, the kinds above plus the two that have no API at all
 *  because reading the folder *is* the prompt. */
const SETTINGS_PANES = Object.freeze({
  camera: 'Privacy_Camera',
  microphone: 'Privacy_Microphone',
  'screen-recording': 'Privacy_ScreenCapture',
  accessibility: 'Privacy_Accessibility',
  'input-monitoring': 'Privacy_ListenEvent',
  automation: 'Privacy_Automation',
  location: 'Privacy_LocationServices',
  calendars: 'Privacy_Calendars',
  reminders: 'Privacy_Reminders',
  'files-and-folders': 'Privacy_FilesAndFolders',
  'full-disk-access': 'Privacy_AllFiles',
});

/**
 * Nothing on this machine can ask. A **typed** rejection, so a caller keeps
 * the feature behind it rather than crashing — `usePermission().available`
 * is that branch as render state.
 */
export class NoPermissionServiceError extends Error {
  constructor(kind, cause) {
    super(
      `react-x11: nothing here can ask for the ${kind} permission — this ` +
        'backend has no authorization API (the cocoa backend has; the ' +
        'freedesktop device portals are not implemented yet). Read ' +
        "permissionStatus() first: 'unknown' is this machine's answer.",
      { cause },
    );
    this.name = 'NoPermissionServiceError';
  }
}

function checkKind(kind) {
  if (!PERMISSION_KINDS.includes(kind)) {
    throw new TypeError(
      `react-x11: ${JSON.stringify(kind)} is not a permission kind. ` +
        `Expected one of ${PERMISSION_KINDS.join(', ')}.`,
    );
  }
}

/** The deep link into System Settings for a pane, or the Privacy pane. */
export function privacySettingsUrl(kind) {
  const pane = kind == null ? null : SETTINGS_PANES[kind];
  if (kind != null && !pane) {
    throw new TypeError(
      `react-x11: ${JSON.stringify(kind)} is not a privacy pane. Expected ` +
        `one of ${Object.keys(SETTINGS_PANES).join(', ')}.`,
    );
  }
  return (
    'x-apple.systempreferences:com.apple.preference.security' +
    (pane ? `?${pane}` : '?Privacy')
  );
}

/** The app whose authorization API to ask when the caller did not say. */
function soleApp() {
  const apps = liveApps();
  if (apps.length <= 1) return apps[0] ?? null;
  const showing = apps.filter((app) => (app._rootChildren ?? []).length > 0);
  return showing.length === 1 ? showing[0] : null;
}

function serviceFor({ app } = {}) {
  const target = app ?? soleApp();
  return target?.permissions ?? null;
}

/**
 * Which rung answers here, without asking anything: `'cocoa'` where the
 * tree's backend has an authorization API, `null` where a status would be
 * `'unknown'` and a request would reject. Synchronous — a capability, not
 * a probe.
 *
 * @returns {'cocoa' | null}
 */
export function permissionBackend(options = {}) {
  return serviceFor(options) ? 'cocoa' : null;
}

/**
 * Whether this app may use `kind`, without prompting.
 *
 * ```js
 * const status = await permissionStatus('camera');
 * // 'granted' | 'denied' | 'restricted' | 'prompt' | 'unknown'
 * ```
 *
 * Never rejects for anything about the machine: `'unknown'` is the answer
 * where nothing can say. `automation` asks about one target app, by bundle
 * id, and only a running one has an answer (`{ target }`).
 */
export async function permissionStatus(kind, options = {}) {
  checkKind(kind);
  const service = serviceFor(options);
  if (!service) return 'unknown';
  return service.status(kind, options);
}

/**
 * Ask for `kind`, raising the system's prompt where the platform has one,
 * and resolve with the status once the user has answered.
 *
 * ```js
 * const status = await requestPermission('microphone');
 * if (status === 'granted') startRecording();
 * else if (status === 'denied') await openPrivacySettings('microphone');
 * ```
 *
 * A status the user has already decided answers at once, without a prompt.
 * Where the platform's only "prompt" is a dialog that sends the user to
 * Settings (screen recording, accessibility) the request resolves as soon
 * as that dialog is up, with the status as it stands — `'denied'` until the
 * switch is flipped, and for screen recording a restart after it.
 *
 * Rejects with {@link NoPermissionServiceError} where nothing can ask —
 * which `permissionStatus` foretells with `'unknown'`.
 */
export async function requestPermission(kind, options = {}) {
  checkKind(kind);
  const service = serviceFor(options);
  if (!service) throw new NoPermissionServiceError(kind);
  return service.request(kind, options);
}

/**
 * Put the user in front of the switch: System Settings › Privacy & Security
 * › `kind`, or the Privacy pane itself with no kind. The two panes with no
 * API — `files-and-folders`, `full-disk-access` — are reachable here too.
 *
 * Through the bridge where there is one, and by `open` on any Mac
 * otherwise, since a deep link needs no framework. Resolves to whether
 * anything opened: `false` off macOS, where there is no such pane.
 */
export async function openPrivacySettings(kind, options = {}) {
  const url = privacySettingsUrl(kind);
  const service = serviceFor(options);
  if (service) return service.openSettings(kind);
  if (process.platform !== 'darwin') return false;
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    try {
      execFile('open', [url], (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}
