/**
 * Is a compositing manager running?
 *
 * It matters because per-pixel transparency is not something the X server
 * does. A depth-32 window's alpha channel is only meaningful to a compositor
 * that blends it; with nothing composited, the server shows the raw pixels
 * and a cleared corner is a *black* corner. So `<window transparent>` on a
 * bare `startx`, a plain remote X server, or a session whose compositor was
 * switched off looks worse than a square opaque window, not better.
 *
 * EWMH names the answer: the owner of the `_NET_WM_CM_Sn` selection, one per
 * screen. Asking is one round trip, and it is asked once per connection
 * during `createRoot`, which is already async — so by the time any window
 * realizes, the answer is known synchronously and nothing has to block.
 *
 * The answer also changes while an app runs: compositors are started and
 * stopped, and on some desktops that is a checkbox. XFixes reports it —
 * `SelectSelectionInput` on the same selection — which is how this stays
 * live rather than being a startup guess. That matters more than it sounds:
 * a window's *visual* is fixed at CreateWindow and cannot follow, but
 * whether the window paints its alpha channel or fills itself opaque is a
 * paint-time decision, and paint-time decisions can change.
 */

const sessions = new WeakMap();

/**
 * What a connection currently knows. `supported` is null until the first
 * probe answers — callers treat that as "no", because the fallback design is
 * the one that works everywhere and a popup that flashes from square to
 * rounded is better than one that flashes black.
 */
class CompositingSession {
  constructor(app) {
    this.app = app;
    this.supported = null;
    this.listeners = new Set();
    this.stopped = false;
    this._window = null;
    this._selection = null;
  }

  _set(supported) {
    const next = Boolean(supported);
    if (this.supported === next) return;
    this.supported = next;
    for (const fn of [...this.listeners]) {
      try {
        fn(next);
      } catch {
        // a subscriber that throws must not take the others with it, nor
        // the X event loop this runs on
      }
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  stop() {
    this.stopped = true;
    this.listeners.clear();
  }
}

/** The atom name for a screen's compositing-manager selection. */
const selectionName = (screen) => `_NET_WM_CM_S${screen}`;

/**
 * Start watching. Resolves once the first answer is in, so `createRoot` can
 * await it and every window realized afterwards sees a settled value.
 * Never rejects: a server without XFixes, or a mock with no X connection at
 * all, simply reports "no compositor" and stops there.
 */
export async function beginCompositing(app, screen = 0) {
  let session = sessions.get(app);
  if (session) return session;
  session = new CompositingSession(app);
  sessions.set(app, session);

  const X = app?.X;
  if (!X || typeof X.GetSelectionOwner !== 'function') {
    // headless mock, or an ntk too old to reach the raw connection
    session._set(false);
    return session;
  }

  try {
    const atom = await internAtom(X, selectionName(screen));
    session._selection = atom;
    session._set(await selectionOwner(X, atom));
    // Live updates are a bonus, not a requirement: without XFixes the
    // startup answer simply stands for the life of the connection.
    await watchSelection(app, session, atom);
  } catch {
    if (session.supported === null) session._set(false);
  }
  return session;
}

function internAtom(X, name) {
  return new Promise((resolve, reject) =>
    X.InternAtom(false, name, (err, atom) =>
      err ? reject(err) : resolve(atom),
    ),
  );
}

function selectionOwner(X, atom) {
  return new Promise((resolve, reject) =>
    X.GetSelectionOwner(atom, (err, owner) =>
      // owner 0 is "nobody", which is exactly "no compositor"
      err ? reject(err) : resolve(Boolean(owner)),
    ),
  );
}

/**
 * XFixes selection notifications, delivered to a window we own. One event
 * covers both directions: `owner` is the compositor's window when one takes
 * over, and 0 when it goes away, whether it released the selection, closed
 * the window or died.
 */
async function watchSelection(app, session, atom) {
  const fixes = await requireFixes(app);
  if (!fixes || session.stopped) return;
  const X = app.X;
  // A 1x1 InputOnly window off-screen, never mapped: XFixes addresses the
  // notifications to a window, and this one exists only to be that address.
  const id = X.AllocID();
  X.CreateWindow(id, app.display.screen[0].root, -10, -10, 1, 1, 0, 0, 2, 0, {
    eventMask: 0,
  });
  session._window = id;
  const mask =
    fixes.SelectionEventMask.SetSelectionOwner |
    fixes.SelectionEventMask.SelectionWindowDestroy |
    fixes.SelectionEventMask.SelectionClientClose;
  X.on('event', (ev) => {
    if (session.stopped) return;
    // XFixes events carry a server-assigned type above the core range, so
    // this cannot be confused with core SelectionNotify (31)
    if (ev.type !== fixes.firstEvent) return;
    if (ev.selection !== atom) return;
    session._set(Boolean(ev.owner));
  });
  fixes.SelectSelectionInput(id, atom, mask);
}

function requireFixes(app) {
  return new Promise((resolve) => {
    try {
      app.X.require('fixes', (err, fixes) =>
        resolve(err || !fixes ? null : fixes),
      );
    } catch {
      resolve(null);
    }
  });
}

/** Is a compositor running on this connection? False while unknown. */
export function compositingActive(app) {
  return sessions.get(app)?.supported === true;
}

/** Subscribe to the answer changing. Returns an unsubscribe function. */
export function watchCompositing(app, fn) {
  const session = sessions.get(app);
  if (!session) return () => {};
  return session.subscribe(fn);
}

/** Tear down with the root that started it. */
export function endCompositing(app) {
  const session = sessions.get(app);
  if (!session) return;
  session.stop();
  sessions.delete(app);
}

/**
 * Test seam: force the answer without an X server, the way `setDebugPaint`
 * and the animation clock are driven from tests. Also what the headless mock
 * uses to model a display with or without a compositor.
 */
export function setCompositingForTests(app, supported) {
  let session = sessions.get(app);
  if (!session) {
    session = new CompositingSession(app);
    sessions.set(app, session);
  }
  session._set(supported);
  return session;
}
