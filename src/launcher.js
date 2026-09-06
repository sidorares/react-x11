// The launcher's view of the app: the badge on its icon.
//
// A count on the Dock tile, a dot on the taskbar entry — the one thing an
// app says to the desktop that the user reads without opening it. Two
// desktops, two mechanisms, one call:
//
//   1. **the app's own tile** — the cocoa backend's `NSDockTile.badgeLabel`,
//      reached through the app object (`setDockBadge`, src/cocoa/app.js).
//      Any string shows, and it is the whole of the API on a Mac.
//   2. **`com.canonical.Unity.LauncherEntry`** over the session bus — the
//      protocol Unity defined and the KDE, elementary and Cairo-Dock
//      launchers still listen for. One signal, `Update(app_uri, a{sv})`,
//      carrying a `count` and whether it is visible, attributed to the app
//      by `application://<id>.desktop` — which is why it needs the identity
//      `registerApplication({ appId })` established: with no app id there is
//      nothing for a launcher to pin the count to, and the call resolves
//      false rather than guessing.
//
// The two disagree on what a badge *is*, and the API takes the stricter
// shape: a **count**. A number shows on both; a string shows on macOS and is
// a visible count of nothing on Linux (the protocol has no text field), so
// pass a string only where the Mac is the audience. `0`, `null` and `''`
// all clear it, because a badge of zero is the badge nobody wanted.
//
// Nothing here imports react: `useBadge` (launcherhooks.js) is the hook, and
// this is the function under it, callable from host-side code with no tree.
// The entry on the bus is held for as long as the badge is shown and
// released when it is cleared — a held bus ref is a ref()'d socket, and an
// app that cleared its badge on the way out should be free to exit.

import { currentRegistration } from './application.js';
import { loadTransport, sessionBus } from './bus.js';
import { liveApps } from './trace-registry.js';

export const LAUNCHER_ENTRY_IFACE = 'com.canonical.Unity.LauncherEntry';

/**
 * The object path libunity exports an entry at: a djb2 hash of the app URI
 * under a fixed prefix. Launchers match on the signal's `app_uri` argument
 * rather than the path, so any unique path would do — this one is the
 * conventional one, and the tests read it to subscribe.
 */
export function launcherEntryPath(appUri) {
  let hash = 5381;
  for (const ch of String(appUri)) hash = (hash * 33 + ch.codePointAt(0)) >>> 0;
  return `/com/canonical/unity/launcherentry/${hash}`;
}

/** `application://<appId>.desktop`, the URI the desktop knows an app by. */
export function launcherAppUri(appId) {
  return `application://${appId}.desktop`;
}

/**
 * A badge value as the label a tile shows, or `null` for none: a number is
 * its digits, a string is itself, and zero, empty, false and nothing are all
 * "no badge".
 */
export function badgeLabel(value) {
  if (value == null || value === false || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value !== 0
      ? String(Math.trunc(value))
      : null;
  }
  return String(value);
}

/** The app to badge when the caller did not say: the one connection the
 *  renderer draws through, or the one of several still showing a window. */
function soleApp() {
  const apps = liveApps();
  if (apps.length <= 1) return apps[0] ?? null;
  const showing = apps.filter((app) => (app._rootChildren ?? []).length > 0);
  return showing.length === 1 ? showing[0] : null;
}

/** The one exported entry per process — an app has one icon. */
let entry = null;

async function launcherEntry(appUri) {
  if (entry && entry.appUri === appUri) return entry;
  if (entry) await releaseEntry();
  const ref = await sessionBus();
  if (!ref) return null;
  let dbus;
  try {
    dbus = await loadTransport();
  } catch {
    await ref.release();
    return null;
  }
  const iface = dbus.defineInterface({
    name: LAUNCHER_ENTRY_IFACE,
    methods: {},
    signals: {
      Update: { args: { app_uri: 's', properties: 'a{sv}' } },
    },
  });
  let registration;
  try {
    registration = await ref.bus.export(launcherEntryPath(appUri), iface);
  } catch {
    await ref.release();
    return null;
  }
  entry = { appUri, ref, dbus, iface, registration };
  return entry;
}

async function releaseEntry() {
  const held = entry;
  entry = null;
  if (!held) return;
  await held.registration?.remove?.().catch(() => {});
  await held.ref.release();
}

/**
 * Show `value` on the app's icon, or clear it.
 *
 * ```js
 * await setBadge(unread);        // 3 → "3"; 0 → cleared
 * await setBadge(null);          // cleared
 * ```
 *
 * Resolves to whether a launcher was told: `false` means there is nothing
 * on this machine to show a badge — no cocoa Dock tile, and no session bus
 * or no `registerApplication({ appId })` for the Linux protocol to attribute
 * it to. Never rejects for anything about the machine: a badge is not a
 * thing an app should have an error path for.
 *
 * `app` names the connection when there are several; the one the renderer
 * draws through is the default.
 */
export async function setBadge(value, { app } = {}) {
  const label = badgeLabel(value);
  const target = app ?? soleApp();

  // Rung 1: the app's own tile.
  if (typeof target?.setDockBadge === 'function') {
    target.setDockBadge(label);
    return true;
  }

  // Rung 2: the launcher protocol, which needs an identity to badge.
  const appId = currentRegistration()?.appId;
  if (!appId) {
    if (label === null) await releaseEntry();
    return false;
  }
  const appUri = launcherAppUri(appId);
  if (label === null && !entry) return false; // nothing shown, nothing to clear
  const held = await launcherEntry(appUri);
  if (!held) return false;
  const count =
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
  const V = held.dbus.Variant;
  held.iface.emit.Update(appUri, {
    count: new V('x', label === null ? 0 : count),
    'count-visible': new V('b', label !== null),
  });
  if (label === null) await releaseEntry();
  return true;
}

/** Test seam, not public: drop the exported entry without emitting. */
export async function _resetLauncher() {
  await releaseEntry();
}
