// What this desktop can actually do — feature discovery for the things an app
// does *outside* its own windows.
//
// ## Why this is not `useSupports()`
//
// `useSupports()` answers questions about the **display**: is there a
// compositor, is there a 32-bit visual, did this connection get the direct GL
// backend. All of them are local, synchronous, and knowable before the first
// frame.
//
// Everything on this page is the opposite on all three counts. Whether there
// is a notification daemon, a tray host or a launcher listening is a fact
// about **another process on a bus**, it takes a round trip to learn, and it
// changes while the app runs — a panel restarts, an extension is toggled, a
// user logs into a different session type. So the shape has to be render
// state that settles and then follows, not a boolean that is right on the
// first frame.
//
// ## Why a boolean is not enough
//
// "Does this desktop have notifications" is the wrong question, because the
// answer is yes on machines that mean four different things by it:
//
//   - a freedesktop daemon with `actions` — a banner with buttons that call
//     back into the app, updated in place, reporting what the user did;
//   - a freedesktop daemon **without** `actions` — GNOME's own for years,
//     and several minimal ones — where the same call shows a banner and the
//     buttons silently never appear;
//   - macOS's notification centre — actions and callbacks, but only for a
//     signed bundle, and a different vocabulary underneath;
//   - `notify-send` or `osascript` — one-way text with an urgency and an
//     icon, no update, no close, no events, ever.
//
// An app that wants "reply from the notification" has to know which of those
// it has, and the honest unit is therefore a **feature set**, not a flag. The
// freedesktop daemons already publish exactly this through `GetCapabilities`;
// this module's job is to translate every backend's answer into one portable
// vocabulary so an app branches on the feature and never on the platform.
//
// ## The rule for adding one
//
// A capability name is a *thing an app wants to do*, and its features are the
// parts of it that a backend can honestly lack. If a feature is missing
// everywhere but one backend it is still a feature — `badgeText` is macOS's
// alone and is listed — but if a "feature" is really a different way of doing
// the same thing, it belongs in `backend` instead. Backends are named after
// the mechanism (`statusnotifier`, `cocoa`, `notify-send`), never after the
// platform, so that a second Linux mechanism does not need a second name for
// Linux.

import { sessionBus } from './bus.js';
import { currentRegistration, currentRegistrationRole } from './application.js';
import {
  notificationBackend,
  NOTIFICATIONS_NAME,
  NOTIFICATIONS_PATH,
} from './notifications.js';
import { WATCHER_NAME } from './statusnotifier.js';
import { liveApps } from './trace-registry.js';

/** Every capability this module can answer for. */
export const CAPABILITIES = ['notifications', 'tray', 'launcher'];

/** The shape a probe resolves to when there is no mechanism at all. */
const NONE = Object.freeze({ available: false, backend: null, features: {} });

const frozen = (backend, features) =>
  Object.freeze({
    available: true,
    backend,
    features: Object.freeze(features),
  });

/** The app to ask when the caller did not say. Mirrors `launcher.js`. */
function soleApp() {
  const apps = liveApps();
  if (apps.length <= 1) return apps[0] ?? null;
  const showing = apps.filter((app) => (app._rootChildren ?? []).length > 0);
  return showing.length === 1 ? showing[0] : null;
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

/**
 * The freedesktop daemon's own `GetCapabilities`, translated.
 *
 * The daemon publishes a flat list of strings; the names below are the ones
 * that change what an app may do. Anything not in the list is absent, which
 * is why every field is read with `includes` rather than defaulted true —
 * a daemon that lists nothing supports nothing but a banner.
 */
function fromDaemonCaps(caps) {
  const has = (name) => caps.includes(name);
  return {
    // The two that decide whether a notification is a conversation or a sign.
    actions: has('actions'),
    events: has('actions'),
    // Every fd.o daemon can replace and close by id; neither is advertised
    // as a capability because the protocol requires both.
    update: true,
    close: true,
    body: has('body'),
    bodyMarkup: has('body-markup'),
    bodyImage: has('body-images'),
    icon: has('icon-static') || has('icon-multi'),
    sound: has('sound'),
    // The banner survives in a tray/centre rather than expiring unseen.
    persistence: has('persistence'),
    urgency: true,
  };
}

async function probeNotifications({ app } = {}) {
  const backend = await notificationBackend({ app });
  if (!backend) return NONE;

  if (backend === 'dbus') {
    const ref = await sessionBus();
    if (!ref) return NONE;
    try {
      const iface = await ref.bus.getInterface(
        NOTIFICATIONS_NAME,
        NOTIFICATIONS_PATH,
        NOTIFICATIONS_NAME,
      );
      const caps = await new Promise((resolve) => {
        iface.GetCapabilities((err, list) => resolve(err ? [] : (list ?? [])));
      });
      return frozen('dbus', fromDaemonCaps(caps));
    } catch {
      // The name is there but the object will not answer. A banner will
      // probably still post; nothing richer should be promised.
      return frozen('dbus', fromDaemonCaps([]));
    } finally {
      await ref.release();
    }
  }

  if (backend === 'cocoa') {
    return frozen('cocoa', {
      actions: true,
      events: true,
      update: true,
      close: true,
      body: true,
      bodyMarkup: false, // the centre renders plain text
      bodyImage: true,
      icon: true,
      sound: true,
      persistence: true,
      urgency: true, // mapped onto interruption levels
    });
  }

  // `osascript` and `notify-send`: one way, and that is the whole of it.
  // `notify-send -p` prints an id on newer libnotify, which is why `update`
  // is not flatly false there — see notifications.js.
  return frozen(backend, {
    actions: false,
    events: false,
    update: backend === 'notify-send',
    close: false,
    body: true,
    bodyMarkup: false,
    bodyImage: false,
    icon: true,
    sound: false,
    persistence: false,
    urgency: backend === 'notify-send',
  });
}

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------

async function probeTray({ app } = {}) {
  const target = app ?? soleApp();
  if (typeof target?.createStatusItem === 'function') {
    return frozen('cocoa', {
      menu: true,
      iconName: true, // SF Symbols
      iconBytes: true,
      attention: false, // no NeedsAttention equivalent on a status item
      overlay: false,
      tooltip: true,
      title: true,
      click: true,
      clickPosition: true,
      clickRect: true,
      clickModifiers: true,
      scroll: false,
    });
  }

  const ref = await sessionBus();
  if (!ref) return NONE;
  try {
    // A **live owner**, not an activatable name — see `statusnotifier.js`.
    if (!(await ref.bus.nameHasOwner(WATCHER_NAME))) return NONE;
  } catch {
    return NONE;
  } finally {
    await ref.release();
  }
  return frozen('statusnotifier', {
    menu: true,
    iconName: true, // themed icon names, which is the good path here
    iconBytes: true, // ARGB pixmaps
    attention: true,
    overlay: true,
    tooltip: true,
    title: true,
    click: true,
    clickPosition: true,
    // The protocol carries none of these — see `statusnotifier.js`.
    clickRect: false,
    clickModifiers: false,
    scroll: true,
  });
}

// ---------------------------------------------------------------------------
// launcher
// ---------------------------------------------------------------------------

async function probeLauncher({ app } = {}) {
  const target = app ?? soleApp();
  if (typeof target?.setDockBadge === 'function') {
    return frozen('cocoa', {
      badge: true,
      badgeText: true, // the tile takes any label
      progress: false, // NSDockTile has no progress bar
      urgent: true, // requestUserAttention, via window states
      menu: typeof target.setDockMenu === 'function',
      // The Dock always shows the app; nothing has to be installed for it.
      needsDesktopFile: false,
    });
  }

  // The Linux rung needs two things that are not the bus: an app id to
  // attribute the entry to, and a `.desktop` file of that name for the
  // launcher to hang it on. The first is knowable here; the second is not
  // (it is a file on a path the launcher chooses), which is why it is
  // reported as a *requirement* rather than as availability.
  const ref = await sessionBus();
  if (!ref) return NONE;
  await ref.release();
  if (!currentRegistration()?.appId) {
    return Object.freeze({
      available: false,
      backend: null,
      features: {},
      // Two different "no"s, and only one is a mistake. A **secondary**
      // instance called `registerApplication()` and lost the race for the
      // name — the first copy owns the badge and the quicklist, which is the
      // whole point of single-instance — so telling its author to call a
      // function they already called sends them after a bug that is not
      // there. The launcher is genuinely unavailable *to this process*
      // either way; only the advice differs.
      reason:
        currentRegistrationRole() === 'secondary' ? 'not-primary' : 'no-app-id',
    });
  }
  return frozen('launcherentry', {
    badge: true,
    badgeText: false, // the protocol carries a count and nothing else
    progress: true,
    urgent: true,
    menu: true, // the quicklist
    needsDesktopFile: true,
  });
}

// ---------------------------------------------------------------------------

const PROBES = {
  notifications: probeNotifications,
  tray: probeTray,
  launcher: probeLauncher,
};

/**
 * What this desktop can do for one feature, as a promise.
 *
 * ```js
 * const n = await desktopCapability('notifications');
 * if (n.features.actions) postWithReplyButton();
 * else postPlainBanner();
 * ```
 *
 * Resolves to `{ available, backend, features }`. `available` false means
 * there is no mechanism at all and `features` is empty; otherwise `backend`
 * names the mechanism — `'dbus'`, `'cocoa'`, `'statusnotifier'`,
 * `'launcherentry'`, `'notify-send'`, `'osascript'` — and `features` is the
 * portable vocabulary for this capability.
 *
 * **Never cached.** A panel restarting, an extension being enabled or a
 * daemon being installed all change the answer, and a cached "no" would
 * outlive every one of them. {@link useDesktopCapability} re-probes on the same
 * events that would change it.
 */
export async function desktopCapability(name, options = {}) {
  const probe = PROBES[name];
  if (!probe) {
    throw new TypeError(
      `react-x11: desktopCapability(${JSON.stringify(name)}) — no such ` +
        `capability. Expected ${CAPABILITIES.join(', ')}.`,
    );
  }
  try {
    return await probe(options);
  } catch {
    // A probe that throws is a desktop that could not be asked, which is the
    // same outcome for a caller as one that answered no.
    return NONE;
  }
}

/** The "nothing here" answer, exported so a caller can compare against it and
 *  so the hook has something stable to return on the first frame. */
export const NO_CAPABILITY = NONE;
