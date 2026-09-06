// Desktop notifications — a banner outside the app's own windows, through
// whatever this machine actually has.
//
// The file dialog's ladder again (docs/filedialog.md), four rungs:
//
//   1. **the app's own notification centre** — the cocoa backend, where the
//      bridge posts through `UNUserNotificationCenter` (src/cocoa/
//      notifications.js). Found by the app carrying `notifications`, never
//      by naming a backend. The centre only delivers for a code-signed app
//      bundle with a bundle id, so a bare `node` process reports itself
//      unavailable and the ladder moves on.
//   2. **`org.freedesktop.Notifications`** over the session bus — the
//      desktop's daemon, with `replaces_id` for updating a banner in place,
//      `GetCapabilities` for what it can show, and the two signals that say
//      what the user did with it. What a Linux desktop should get.
//   3. **`osascript`** — `display notification`, on a Mac with neither of
//      the above (the X11 backend under XQuartz, or an unbundled cocoa
//      app). Posted under Script Editor's identity, with no actions, no
//      update and no report back.
//   4. **`notify-send`** — libnotify's CLI, for a Linux box where the bus
//      transport is missing (Node 20) but a daemon is running. The same
//      limits as `osascript`, though a new enough one prints an id, which
//      gives `update()` back.
//
// Nothing to draw at the floor: a banner outside the window is precisely
// what an app cannot draw itself, so where none of these answers the
// rejection is **typed** — `NoNotificationServiceError`, the
// `NoFileDialogError` rule — and an in-app toast is the app's own layout.
//
// ## What the handle promises, and where it cannot keep it
//
// `notify()` resolves to a handle: `update(patch)` replaces the banner in
// place, `close()` takes it down, and `onAction`/`onClose` report what the
// user did. The first two rungs keep all of it. The shell-out rungs cannot:
// their `update` posts a fresh banner (`notify-send` with an id excepted),
// their `close` does nothing, and their callbacks never fire — which is
// documented in `handle.backend` rather than hidden, so an app that cares
// can say "Open the app to see it" on those.
//
// ## The daemon's vocabulary is the API's
//
// `urgency` is `low | normal | critical`, actions are `{ key, label }` and
// a click on the banner is the action keyed `default`, a closed banner
// reports `expired | dismissed | closed | unknown` — the freedesktop words,
// because it is a published protocol with many daemons and we are one of
// many clients. The cocoa rung translates into them.

import { currentRegistration } from './application.js';
import { sessionBus } from './bus.js';
import { hasService } from './portal.js';
import { liveApps } from './trace-registry.js';

export const NOTIFICATIONS_NAME = 'org.freedesktop.Notifications';
export const NOTIFICATIONS_PATH = '/org/freedesktop/Notifications';

const URGENCY = Object.freeze({ low: 0, normal: 1, critical: 2 });
const CLOSE_REASONS = Object.freeze({
  1: 'expired',
  2: 'dismissed',
  3: 'closed',
  4: 'unknown',
});

/**
 * Nothing on this machine can show a notification. A **typed** rejection:
 * a caller falls back to its own UI rather than crashing, and
 * `useNotifier().available` is that branch as render state.
 */
export class NoNotificationServiceError extends Error {
  constructor(message, cause) {
    super(
      `react-x11: ${
        message ??
        'no way to show a notification here — no notification centre on ' +
          'this backend, no org.freedesktop.Notifications daemon on the ' +
          'session bus, and neither osascript nor notify-send to shell out to.'
      }`,
      { cause },
    );
    this.name = 'NoNotificationServiceError';
  }
}

function checkOptions(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('react-x11: notify() takes an options object.');
  }
  if (typeof options.summary !== 'string' || !options.summary) {
    throw new TypeError(
      'react-x11: notify({ summary }) — a notification needs a summary, ' +
        'the one line every daemon shows.',
    );
  }
  if (options.urgency != null && !(options.urgency in URGENCY)) {
    throw new TypeError(
      `react-x11: notify({ urgency }) is low, normal or critical — got ` +
        `${JSON.stringify(options.urgency)}.`,
    );
  }
  for (const action of options.actions ?? []) {
    if (!action || typeof action.key !== 'string' || !action.key) {
      throw new TypeError(
        'react-x11: notify({ actions }) — every action is { key, label }.',
      );
    }
  }
}

/** The app whose centre to post through when the caller did not say. */
function soleApp() {
  const apps = liveApps();
  if (apps.length <= 1) return apps[0] ?? null;
  const showing = apps.filter((app) => (app._rootChildren ?? []).length > 0);
  return showing.length === 1 ? showing[0] : null;
}

// --------------------------------------------------------------------------
// Rung 2: the freedesktop daemon
// --------------------------------------------------------------------------

/**
 * One session per process: the bus ref held while any banner is live, the
 * daemon's capabilities, and the signal subscription that routes what the
 * user did back to the handle it concerns.
 */
let session = null;

async function busSession() {
  if (session) return session;
  const ref = await sessionBus();
  if (!ref) return null;
  if (!(await hasService(NOTIFICATIONS_NAME, ref))) {
    await ref.release();
    return null;
  }
  const { bus } = ref;
  const handles = new Map();
  let capabilities = null;
  try {
    const caps = await bus.invoke(
      {
        destination: NOTIFICATIONS_NAME,
        path: NOTIFICATIONS_PATH,
        interface: NOTIFICATIONS_NAME,
        member: 'GetCapabilities',
        signature: '',
        body: [],
      },
      { timeout: 5_000 },
    );
    capabilities = new Set(Array.isArray(caps) ? caps : []);
  } catch {
    capabilities = new Set();
  }
  // The signals, subscribed once and matched by id: `ActionInvoked` and
  // `NotificationClosed` name the banner they concern, and a banner closed
  // by the user or the clock is the handle's last event.
  let subscription = null;
  try {
    subscription = await bus.watch(
      `type='signal',interface='${NOTIFICATIONS_NAME}'`,
    );
  } catch {
    subscription = null;
  }
  const onClosed = (body) => {
    const [id, reason] = body ?? [];
    const handle = handles.get(id >>> 0);
    if (!handle) return;
    handles.delete(id >>> 0);
    handle._closed(CLOSE_REASONS[reason] ?? 'unknown');
    maybeRelease();
  };
  const onAction = (body) => {
    const [id, key] = body ?? [];
    handles.get(id >>> 0)?._action(String(key));
  };
  const keys = {
    closed: bus.mangle(
      NOTIFICATIONS_PATH,
      NOTIFICATIONS_NAME,
      'NotificationClosed',
    ),
    action: bus.mangle(NOTIFICATIONS_PATH, NOTIFICATIONS_NAME, 'ActionInvoked'),
  };
  bus.signals.on(keys.closed, onClosed);
  bus.signals.on(keys.action, onAction);

  const maybeRelease = () => {
    if (handles.size > 0 || session !== current) return;
    void endSession();
  };
  const current = {
    ref,
    bus,
    handles,
    capabilities,
    subscription,
    keys,
    listeners: { closed: onClosed, action: onAction },
  };
  session = current;
  return current;
}

async function endSession() {
  const held = session;
  session = null;
  if (!held) return;
  held.bus.signals.removeListener(held.keys.closed, held.listeners.closed);
  held.bus.signals.removeListener(held.keys.action, held.listeners.action);
  try {
    await held.subscription?.remove?.();
  } catch {
    // the connection is what we are about to let go of anyway
  }
  await held.ref.release();
}

/** The daemon's `a{sv}` hints, and the `app_icon` beside them. */
function busHints(options, dbus) {
  const V = (sig, value) => [sig, value];
  const hints = [];
  const urgency = URGENCY[options.urgency ?? 'normal'];
  hints.push(['urgency', V('y', urgency)]);
  // What ties the banner to the app in the shell's own list of them — the
  // identity `registerApplication` established, filled in for the caller.
  const appId = options.appId ?? currentRegistration()?.appId;
  if (appId) hints.push(['desktop-entry', V('s', appId)]);
  let appIcon = '';
  if (typeof options.icon === 'string') {
    if (options.icon.startsWith('/') || options.icon.startsWith('file:')) {
      hints.push(['image-path', V('s', options.icon)]);
    } else {
      appIcon = options.icon;
    }
  }
  if (options.category) hints.push(['category', V('s', options.category)]);
  if (options.resident) hints.push(['resident', V('b', true)]);
  void dbus;
  return { hints, appIcon };
}

class BusHandle {
  constructor(sess, options) {
    this.backend = 'dbus';
    this.id = 0;
    this._session = sess;
    this._options = options;
    this._done = false;
  }

  _post(patch) {
    const sess = this._session;
    const options = { ...this._options, ...patch };
    this._options = options;
    const wantsActions = (options.actions ?? []).length > 0;
    const canAct = sess.capabilities.has('actions');
    if (wantsActions && !canAct && process.env.NODE_ENV !== 'production') {
      console.warn(
        'react-x11: notify() — this notification daemon has no "actions" ' +
          'capability, so the actions were dropped rather than sent blind.',
      );
    }
    const actions = canAct
      ? (options.actions ?? []).flatMap((a) => [a.key, a.label ?? a.key])
      : [];
    const { hints, appIcon } = busHints(options);
    const timeout =
      typeof options.timeout === 'number' ? Math.trunc(options.timeout) : -1;
    return sess.bus
      .invoke(
        {
          destination: NOTIFICATIONS_NAME,
          path: NOTIFICATIONS_PATH,
          interface: NOTIFICATIONS_NAME,
          member: 'Notify',
          signature: 'susssasa{sv}i',
          body: [
            options.appName ?? process.title ?? 'react-x11',
            this.id >>> 0,
            appIcon,
            options.summary,
            options.body ?? '',
            actions,
            hints,
            timeout,
          ],
        },
        { timeout: 5_000 },
      )
      .then((id) => {
        this.id = Number(id) >>> 0;
        sess.handles.set(this.id, this);
        return this;
      });
  }

  update(patch = {}) {
    if (this._done) return Promise.resolve(this);
    return this._post(patch);
  }

  async close() {
    if (this._done || !this.id) return;
    try {
      await this._session.bus.invoke(
        {
          destination: NOTIFICATIONS_NAME,
          path: NOTIFICATIONS_PATH,
          interface: NOTIFICATIONS_NAME,
          member: 'CloseNotification',
          signature: 'u',
          body: [this.id],
        },
        { timeout: 5_000 },
      );
    } catch {
      // gone already; the daemon's NotificationClosed will not come either
      this._closed('closed');
    }
  }

  _action(key) {
    try {
      this._options.onAction?.(key);
    } catch (err) {
      console.error('react-x11: a notification action handler threw', err);
    }
  }

  _closed(reason) {
    if (this._done) return;
    this._done = true;
    this._session.handles.delete(this.id);
    try {
      this._options.onClose?.(reason);
    } catch (err) {
      console.error('react-x11: a notification close handler threw', err);
    }
  }
}

async function busNotify(options) {
  const sess = await busSession();
  if (!sess) return null;
  return new BusHandle(sess, options)._post({});
}

// --------------------------------------------------------------------------
// Rungs 3 and 4: the shell-outs
// --------------------------------------------------------------------------

/** AppleScript string literal. */
const as = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The `-e` lines of `display notification`. Exported for the tests. */
export function osascriptNotificationLines(options) {
  let line = `display notification ${as(options.body ?? '')} with title ${as(
    options.summary,
  )}`;
  if (options.subtitle) line += ` subtitle ${as(options.subtitle)}`;
  return ['-e', line];
}

/** `notify-send`'s arguments. `-p` asks for the id back (libnotify ≥ 0.7.9),
 *  which is what makes `update()` possible on this rung. Exported for the
 *  tests. */
export function notifySendArgs(options, replacesId = null) {
  const args = ['-p', '-u', options.urgency ?? 'normal'];
  if (typeof options.timeout === 'number') {
    args.push('-t', String(Math.trunc(options.timeout)));
  }
  if (typeof options.icon === 'string') args.push('-i', options.icon);
  if (options.appName) args.push('-a', options.appName);
  if (replacesId) args.push('-r', String(replacesId));
  args.push('--', options.summary, options.body ?? '');
  return args;
}

class ShellHandle {
  constructor(backend, options) {
    this.backend = backend;
    this.id = null;
    this._options = options;
  }

  async update(patch = {}) {
    this._options = { ...this._options, ...patch };
    await shellNotify(this.backend, this._options, this);
    return this;
  }

  async close() {
    // nothing a shell-out can take down
  }
}

async function run(file, args) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8' }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout ?? '')),
    );
  });
}

async function shellNotify(backend, options, handle = null) {
  const out = handle ?? new ShellHandle(backend, options);
  if (backend === 'osascript') {
    await run('osascript', osascriptNotificationLines(options));
  } else {
    const stdout = await run(
      'notify-send',
      notifySendArgs(options, out.id ?? null),
    );
    const id = Number.parseInt(stdout.trim(), 10);
    out.id = Number.isFinite(id) && id > 0 ? id : out.id;
  }
  return out;
}

// --------------------------------------------------------------------------
// The ladder
// --------------------------------------------------------------------------

function centreFor(options) {
  const app = options.app ?? soleApp();
  return app?.notifications ?? null;
}

/**
 * Which rung this machine lands on, without posting anything.
 *
 * `'cocoa'` needs the app's centre to be *available* — a bundle id, see
 * docs/notifications.md — so this asks it, which is one asynchronous read.
 * The bus probe acquires a reference and releases it. `null` means
 * {@link notify} would reject.
 *
 * @returns {Promise<'cocoa'|'dbus'|'osascript'|'notify-send'|null>}
 */
export async function notificationBackend(options = {}) {
  const backend = options.backend;
  const want = (rung) => !backend || backend === rung;
  if (want('cocoa')) {
    const centre = centreFor(options);
    if (centre && (await centre.available())) return 'cocoa';
    if (backend === 'cocoa') return null;
  }
  if (want('dbus')) {
    const ref = await sessionBus();
    if (ref) {
      try {
        if (await hasService(NOTIFICATIONS_NAME, ref)) return 'dbus';
      } finally {
        await ref.release();
      }
    }
    if (backend === 'dbus') return null;
  }
  if (want('osascript') && (process.platform === 'darwin' || backend)) {
    return 'osascript';
  }
  if (want('notify-send') && (process.platform !== 'darwin' || backend)) {
    return 'notify-send';
  }
  return null;
}

/**
 * Show a notification, on the best rung this machine has.
 *
 * ```js
 * const banner = await notify({
 *   summary: 'Export finished',
 *   body: 'report.pdf — 2.4 MB',
 *   actions: [{ key: 'open', label: 'Open' }],
 *   onAction: (key) => key === 'open' && reveal(path),
 *   onClose: (reason) => {},
 * });
 * await banner.update({ body: 'opened' }); // in place, where the rung can
 * await banner.close();
 * ```
 *
 * Resolves to a handle — `id`, `backend`, `update(patch)`, `close()`.
 * Rejects with {@link NoNotificationServiceError} where nothing can show
 * one, and with the platform's own error where the centre exists and
 * **refused** (the user denied the app's notifications): a refusal is not
 * fallen through, because a banner the user turned off must not come back
 * through a side door.
 *
 * `app` names the connection when there are several — `useNotifier()`
 * passes the tree's.
 */
export async function notify(options = {}) {
  checkOptions(options);
  const backend = options.backend;
  const want = (rung) => !backend || backend === rung;

  if (want('cocoa')) {
    const centre = centreFor(options);
    if (centre && (await centre.available())) {
      const handle = await centre.post(options);
      if (handle) return handle;
      // The bundle is right and the centre is there, but the system never
      // put the prompt in front of anybody, so nobody declined: not the
      // refusal above, and no reason to stop. The ladder moves on.
      if (backend === 'cocoa') {
        throw new NoNotificationServiceError(
          "backend: 'cocoa' — the centre could not ask for authorization " +
            '(the status is still notDetermined). A bundle macOS has not ' +
            'registered never gets the prompt (docs/notifications.md).',
        );
      }
    } else if (backend === 'cocoa') {
      throw new NoNotificationServiceError(
        "backend: 'cocoa' — no notification centre here: the tree is not " +
          'on the cocoa backend, the bridge is older than 0.5, or this ' +
          'process is not an app bundle (docs/notifications.md).',
      );
    }
  }

  if (want('dbus')) {
    const handle = await busNotify(options);
    if (handle) return handle;
    if (backend === 'dbus') {
      throw new NoNotificationServiceError(
        `backend: 'dbus' — no ${NOTIFICATIONS_NAME} on the session bus.`,
      );
    }
  }

  const shell =
    want('osascript') && (process.platform === 'darwin' || backend)
      ? 'osascript'
      : want('notify-send') && (process.platform !== 'darwin' || backend)
        ? 'notify-send'
        : null;
  if (shell) {
    try {
      return await shellNotify(shell, options);
    } catch (err) {
      if (err?.code === 'ENOENT')
        throw new NoNotificationServiceError(undefined, err);
      throw new Error(
        `react-x11: ${shell} could not show the notification — ${err.message}`,
        { cause: err },
      );
    }
  }
  throw new NoNotificationServiceError();
}

/** Test seam, not public: drop the bus session without waiting on it. */
export async function _resetNotifications() {
  await endSession();
}
