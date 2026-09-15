// The launcher's view of the app: the badge on its icon, a progress bar
// across it, an attention flag, and the menu behind a right-click.
//
// A count on the Dock tile, a dot on the taskbar entry — the one thing an
// app says to the desktop that the user reads without opening it. Two
// desktops, two mechanisms, one call each:
//
//   1. **the app's own tile** — the cocoa backend's `NSDockTile`, reached
//      through the app object (`setDockBadge`, `setDockMenu`, src/cocoa/
//      app.js).
//   2. **`com.canonical.Unity.LauncherEntry`** over the session bus — the
//      protocol Unity defined and the KDE, elementary, Cairo-Dock and
//      Dash-to-Dock launchers still listen for. One signal,
//      `Update(app_uri, a{sv})`, attributed to the app by
//      `application://<id>.desktop` — which is why it needs the identity
//      `registerApplication({ appId })` established: with no app id there is
//      nothing for a launcher to pin anything to, and the calls resolve
//      false rather than guessing.
//
// The badge takes the stricter of the two shapes: a **count**. A number shows
// on both; a string shows on macOS and is a visible count of nothing on Linux
// (the protocol has no text field), so pass a string only where the Mac is
// the audience. `0`, `null` and `''` all clear it, because a badge of zero is
// the badge nobody wanted.
//
// ## The quicklist is not "desktop actions"
//
// This module used to say the freedesktop counterpart of the Dock menu was
// `Actions=` in the `.desktop` file — an install step, not runtime code — and
// that the hook was therefore cocoa-only. That was half the story and the
// wrong half. `LauncherEntry` carries a **`quicklist`** property: an object
// path to a `com.canonical.dbusmenu` tree, which is the same menu protocol
// the global menu and the tray already speak, built from the same items. It
// is runtime, it follows state, and Dash-to-Dock/ubuntu-dock, Plank and the
// Unity heritage launchers all render it.
//
// So `useDockMenu()` has a Linux rung after all, and the three menus an app
// puts on the desktop — panel, tray, launcher — are now one authoring model
// on both backends. `.desktop` actions are still the right place for entries
// that must work *while the app is not running*; they are a different feature
// wearing a similar hat.
//
// Nothing here imports react: `useBadge`/`useDockMenu` (launcherhooks.js) are
// the hooks, and these are the functions under them, callable from host-side
// code with no tree. The entry on the bus is held for as long as anything is
// shown and released when the last of it is cleared — a held bus ref is a
// ref()'d socket, and an app that cleared its badge on the way out should be
// free to exit.

import { currentRegistration } from './application.js';
import { loadTransport, sessionBus } from './bus.js';
import { DbusMenuExport } from './dbusmenuexport.js';
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

/**
 * What the launcher currently believes, so an `Update` can carry the whole of
 * it. The protocol's dict is a *patch* and every launcher merges it, but
 * sending the full state makes the call idempotent and means a launcher that
 * restarted and missed a patch is corrected by the next one of any kind.
 */
function blankState() {
  return {
    count: 0,
    countVisible: false,
    progress: 0,
    progressVisible: false,
    urgent: false,
  };
}

/** Is anything still being shown? When not, the entry can go. */
function stateIsEmpty(state, hasMenu) {
  return (
    !hasMenu && !state.countVisible && !state.progressVisible && !state.urgent
  );
}

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
  entry = {
    appUri,
    ref,
    dbus,
    iface,
    registration,
    state: blankState(),
    menu: null,
    menuRegistration: null,
    menuPath: `${launcherEntryPath(appUri)}/Menu`,
  };
  return entry;
}

async function releaseEntry() {
  const held = entry;
  entry = null;
  if (!held) return;
  await held.menuRegistration?.remove?.().catch(() => {});
  await held.registration?.remove?.().catch(() => {});
  await held.ref.release();
}

/** Emit the whole of the current state under the app's URI. */
function emit(held) {
  const V = held.dbus.Variant;
  const props = {
    count: new V('x', held.state.count),
    'count-visible': new V('b', held.state.countVisible),
    progress: new V('d', held.state.progress),
    'progress-visible': new V('b', held.state.progressVisible),
    urgent: new V('b', held.state.urgent),
  };
  // Only advertised when there is one: a path to an object that is not
  // exported makes a launcher build a menu client against nothing, and
  // Dash-to-Dock keeps the stale client until the path *changes*.
  if (held.menuRegistration) props.quicklist = new V('o', held.menuPath);
  held.iface.emit.Update(held.appUri, props);
}

/**
 * The shared half of every setter: find the identity, take or make the entry,
 * let `mutate` move the state, emit, and drop the entry if nothing is left.
 *
 * `mutate` returns false to mean "nothing changed and nothing was being
 * shown" — the case where clearing something that was already clear must not
 * dial the bus.
 */
async function withEntry(mutate, { clearing }) {
  const appId = currentRegistration()?.appId;
  if (!appId) {
    if (clearing && entry) await releaseEntry();
    return false;
  }
  if (clearing && !entry) return false; // nothing shown, nothing to clear
  const held = await launcherEntry(launcherAppUri(appId));
  if (!held) return false;
  mutate(held.state);
  emit(held);
  if (stateIsEmpty(held.state, Boolean(held.menuRegistration))) {
    await releaseEntry();
  }
  return true;
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
  const count =
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
  return withEntry(
    (state) => {
      state.count = label === null ? 0 : count;
      state.countVisible = label !== null;
    },
    { clearing: label === null },
  );
}

/**
 * A progress bar across the app's icon: `0`…`1`, or `null` to clear it.
 *
 * ```js
 * await setProgress(downloaded / total);
 * await setProgress(null);           // done
 * ```
 *
 * The launcher protocol's `progress`, which ubuntu-dock, Plank and the
 * Unity-heritage launchers draw across the tile. **Inert on the cocoa
 * backend**: `NSDockTile` has no progress of its own — an app that wants one
 * on a Mac draws it into a custom tile view, which is app-side art rather
 * than a call. Resolves to whether a launcher was told.
 */
export async function setProgress(value, { app } = {}) {
  const target = app ?? soleApp();
  // No cocoa rung to try: the Dock has no progress. Left deliberately without
  // a `setDockProgress` probe so that adding one to the bridge later is the
  // only change needed here.
  void target;
  const clearing =
    value == null || value === false || !Number.isFinite(Number(value));
  const clamped = clearing ? 0 : Math.min(1, Math.max(0, Number(value)));
  return withEntry(
    (state) => {
      state.progress = clamped;
      state.progressVisible = !clearing;
    },
    { clearing },
  );
}

/**
 * Ask the launcher for the user's attention, or stop asking.
 *
 * The launcher protocol's `urgent`, which is the tile bouncing or glowing.
 * Distinct from `<window states={['demands_attention']}>`, which is the
 * *window's* urgency hint and what a taskbar blinks: this one marks the app's
 * icon in the launcher whether or not any window is open. On the cocoa
 * backend the window state is the mechanism and this is inert.
 */
export async function setUrgent(urgent, { app } = {}) {
  void (app ?? soleApp());
  return withEntry((state) => void (state.urgent = Boolean(urgent)), {
    clearing: !urgent,
  });
}

/**
 * The menu behind a right-click on the app's launcher icon — the quicklist.
 *
 * Takes `MenuBar`'s item vocabulary and exports it as a `com.canonical.dbusmenu`
 * tree, exactly as the tray and the global menu do. `null` takes it down.
 * Resolves to whether a launcher was told.
 *
 * The menu is exported **before** the property naming it is emitted, so a
 * launcher that builds its client the instant it sees `quicklist` finds an
 * object there.
 */
export async function setQuicklist(items, { app } = {}) {
  const target = app ?? soleApp();

  // Rung 1: the app's own tile menu.
  if (typeof target?.setDockMenu === 'function') {
    target.setDockMenu(items ?? null);
    return true;
  }

  const appId = currentRegistration()?.appId;
  if (!appId) {
    if (!items && entry) await releaseEntry();
    return false;
  }
  if (!items) {
    // Taking the menu down: drop the export, then say so.
    if (!entry?.menuRegistration) return false;
    const held = entry;
    const registration = held.menuRegistration;
    held.menuRegistration = null;
    held.menu = null;
    await registration?.remove?.().catch(() => {});
    // `quicklist` is omitted rather than set empty — there is no "no menu"
    // value in the protocol, and an object path to nothing is worse than a
    // property a launcher never saw.
    emit(held);
    if (stateIsEmpty(held.state, false)) await releaseEntry();
    return true;
  }

  const held = await launcherEntry(launcherAppUri(appId));
  if (!held) return false;

  if (held.menu) {
    // Already exported: this is a re-render, and the tree diffs itself.
    held.menu.update(items);
    return true;
  }

  const menu = new DbusMenuExport({
    getMenus: () => items,
    onSelect: (item) => item.onSelect?.(),
    onAboutToShow: (item) => item.onAboutToShow?.(),
  });
  const iface = menu.defineMenu(held.dbus);
  try {
    held.menuRegistration = await held.ref.bus.export(held.menuPath, iface);
  } catch {
    return false;
  }
  menu.iface = iface;
  menu.exported = true;
  held.menu = menu;
  emit(held);
  return true;
}

/** Test seam, not public: drop the exported entry without emitting. */
export async function _resetLauncher() {
  await releaseEntry();
}
