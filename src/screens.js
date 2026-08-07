/**
 * How big is a window allowed to get before anyone has asked for a size?
 *
 * `<window width="auto">` is sized from its content, and the one thing that
 * bound cannot be is "as large as the content wants" — a paragraph with no
 * line breaks in it is a window several metres wide. So the natural size is
 * clamped, and the honest clamp is *the usable area of the monitor the
 * window will open on*.
 *
 * Three tiers, because none of them is available everywhere:
 *
 * 1. **A monitor rect.** `screen.pixel_width` is the whole virtual desktop,
 *    so on a two-head setup it would let an auto window span both monitors —
 *    which nobody wants and no toolkit does. Xinerama's `QueryScreens`
 *    answers with one rect per monitor in a single round trip, and every X
 *    server that speaks RandR emulates it, so this is the cheap universal
 *    way to ask.
 * 2. **`_NET_WORKAREA`**, which is the desktop minus the panels and docks
 *    that reserved space with `_NET_WM_STRUT`. It is defined over the whole
 *    virtual screen rather than per monitor (an EWMH weakness), so it is
 *    taken as a *per-axis* bound on top of the monitor rect rather than as a
 *    rect in its own right: on one head that is exactly the work area, and
 *    on several it still takes a top or bottom panel off the height.
 * 3. **The screen**, which every server has.
 *
 * And a fourth answer, `null`, meaning "no clamp at all" — the headless mock
 * has no display to ask, and a test window that measures 4000px wide is more
 * useful than one silently cut to a screen that does not exist.
 *
 * Asked once per connection during `createRoot`, which is already async, so
 * by the time any window realizes the answer is known *synchronously* — the
 * natural size has to be resolved before `CreateWindow`, and there is no
 * round trip available at that point.
 *
 * What this deliberately does not model is the **window manager's frame**. A
 * window sized to exactly the work-area height is taller than that once it
 * has a titlebar, and the WM will shrink or shove it. EWMH's answer is
 * `_NET_REQUEST_FRAME_EXTENTS`, which a client sends *before* mapping and
 * the WM replies to by writing `_NET_FRAME_EXTENTS` — but that is a round
 * trip in the middle of a synchronous `realize()`, and plenty of window
 * managers never answer it. Letting the WM have the last word costs a
 * clamped-to-the-edge window one correction it would have made anyway.
 */

const sessions = new WeakMap();

const PROPERTY_NOTIFY = 28;
const PROPERTY_CHANGE_MASK = 4194304; // x11.eventMask.PropertyChange
const WORKAREA_PROPERTY = '_NET_WORKAREA';

/**
 * What a connection knows about its outputs. `monitors` is null until
 * Xinerama has answered (or for good, where it never does); `workArea` is
 * null until the desktop has published one. Both are advisory — `available()`
 * degrades through them in order and always has the screen to fall back on.
 */
class ScreenSession {
  constructor(app) {
    this.app = app;
    this.monitors = null;
    this.workArea = null;
    this.stopped = false;
    this._workAreaAtom = null;
  }

  stop() {
    this.stopped = true;
  }

  /** The screen's own size — the tier everything falls back to. */
  get screenRect() {
    const screen = (this.app?.display ?? this.app?.X?.display)?.screen?.[0];
    if (!screen?.pixel_width) return null;
    return {
      x: 0,
      y: 0,
      width: screen.pixel_width,
      height: screen.pixel_height,
    };
  }
}

/** The monitor a point is on, or the largest one when it is on none (a
 *  window whose owner the WM has not placed yet, or coordinates from a
 *  screen layout that has since changed). */
function monitorAt(monitors, point) {
  if (!monitors?.length) return null;
  if (point) {
    for (const m of monitors) {
      if (
        point.x >= m.x &&
        point.x < m.x + m.width &&
        point.y >= m.y &&
        point.y < m.y + m.height
      ) {
        return m;
      }
    }
  }
  let best = monitors[0];
  for (const m of monitors) {
    if (m.width * m.height > best.width * best.height) best = m;
  }
  return best;
}

/**
 * The rect an auto-sized window may grow into, or `null` where there is
 * nothing to ask. `near` is a screen-coordinate point the window will open
 * next to — a `transientFor` owner's origin, in practice — and picks the
 * monitor when there are several.
 */
export function availableArea(app, near = null) {
  const session = sessions.get(app);
  const screen = session?.screenRect ?? null;
  if (!session) return screen;
  const monitor = monitorAt(session.monitors, near) ?? screen;
  if (!monitor) return null;
  const work = session.workArea;
  if (!work) return monitor;
  // Per axis, not as a rect: `_NET_WORKAREA` spans the whole virtual screen,
  // so intersecting it with a monitor would only ever give the monitor back
  // on a multi-head desktop. Its *extent* is still the useful part.
  return {
    x: monitor.x,
    y: monitor.y,
    width: Math.min(monitor.width, work.width),
    height: Math.min(monitor.height, work.height),
  };
}

/**
 * Start reading the screen layout on `app`. Resolves once the first answer
 * is in, so `createRoot` can await it and every window realized afterwards
 * sizes against a settled value.
 *
 * Never rejects. A server with no Xinerama, a desktop with no work area, an
 * ntk too old to reach the raw connection and a headless mock all degrade to
 * the next tier down and stop there.
 */
export async function beginScreens(app) {
  let session = sessions.get(app);
  if (session) return session;
  session = new ScreenSession(app);
  sessions.set(app, session);

  const X = app?.X;
  if (!X || typeof X.GetProperty !== 'function') return session; // mock app

  try {
    session.monitors = await queryMonitors(app);
    session._workAreaAtom = await internAtom(X, WORKAREA_PROPERTY);
    session.workArea = await readWorkArea(session);
    watchLayout(session);
  } catch {
    // every failure here means "one tier less to work with", which is what
    // the nulls already say
  }
  return session;
}

/**
 * Both of these change while an app runs — a monitor is plugged in, a panel
 * is added or auto-hidden — and both announce themselves on the root window,
 * so one `PropertyChange` selection covers them. A window already on screen
 * keeps its size; this is for whatever opens next.
 *
 * RandR's own `ScreenChangeNotify` would be the direct signal for the first
 * one, but it needs the extension selected and an event mask on top of this,
 * and the WM republishes `_NET_WORKAREA` on a layout change anyway.
 */
function watchLayout(session) {
  const X = session.app.X;
  const root = X.display?.screen?.[0]?.root;
  if (root == null) return;
  // PropertyChange on a window we do not own. Legal and shared — every
  // panel-aware application on the desktop selects this same event.
  X.ChangeWindowAttributes(root, { eventMask: PROPERTY_CHANGE_MASK }, () => {});
  X.on('event', (ev) => {
    if (session.stopped) return;
    if (ev.type !== PROPERTY_NOTIFY || ev.wid !== root) return;
    if (ev.atom !== session._workAreaAtom) return;
    Promise.all([queryMonitors(session.app), readWorkArea(session)]).then(
      ([monitors, workArea]) => {
        if (session.stopped) return;
        if (monitors) session.monitors = monitors;
        session.workArea = workArea;
      },
      () => {},
    );
  });
}

/** One rect per monitor, or null where the server has no Xinerama — and null
 *  for the single fake screen a server with the extension present but
 *  inactive reports, which carries no more than `screenRect` already does. */
function queryMonitors(app) {
  return new Promise((resolve) => {
    try {
      app.X.require('xinerama', (err, ext) => {
        if (err || !ext?.QueryScreens) return resolve(null);
        ext.QueryScreens((screensError, screens) =>
          resolve(
            screensError || !screens?.length
              ? null
              : screens.map((s) => ({
                  x: s.x,
                  y: s.y,
                  width: s.width,
                  height: s.height,
                })),
          ),
        );
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * `_NET_WORKAREA` is four CARDINALs per desktop — x, y, width, height — and
 * the current desktop's is the one that matters. Reading only the first is
 * the common approximation and it is wrong on a desktop that reserves space
 * differently per workspace, so `_NET_CURRENT_DESKTOP` picks the entry.
 */
async function readWorkArea(session) {
  const X = session.app.X;
  const root = X.display?.screen?.[0]?.root;
  if (root == null || session._workAreaAtom == null) return null;
  const prop = await getProperty(X, root, session._workAreaAtom);
  const data = prop?.data;
  if (!data || data.length < 16) return null;
  const desktops = Math.floor(data.length / 16);
  const current = Math.min(await currentDesktop(session), desktops - 1);
  const off = Math.max(0, current) * 16;
  const width = data.readUInt32LE(off + 8);
  const height = data.readUInt32LE(off + 12);
  if (!(width > 0 && height > 0)) return null;
  return {
    x: data.readInt32LE(off),
    y: data.readInt32LE(off + 4),
    width,
    height,
  };
}

async function currentDesktop(session) {
  const X = session.app.X;
  const root = X.display?.screen?.[0]?.root;
  try {
    const atom = await internAtom(X, '_NET_CURRENT_DESKTOP');
    const prop = await getProperty(X, root, atom);
    return prop?.data?.length >= 4 ? prop.data.readUInt32LE(0) : 0;
  } catch {
    return 0;
  }
}

function internAtom(X, name) {
  return new Promise((resolve, reject) =>
    X.InternAtom(false, name, (err, atom) =>
      err ? reject(err) : resolve(atom),
    ),
  );
}

function getProperty(X, wid, atom) {
  return new Promise((resolve) =>
    X.GetProperty(0, wid, atom, 0, 0, 0x1fffffff, (err, prop) =>
      resolve(err ? null : prop),
    ),
  );
}

/** Tear down with the root that started it. */
export function endScreens(app) {
  const session = sessions.get(app);
  if (!session) return;
  session.stop();
  sessions.delete(app);
}

/**
 * Test seam: state a screen layout without an X server, the way
 * `setCompositingForTests` states a compositor. `null` for either argument
 * leaves that tier unknown, which is how the fallbacks are exercised.
 */
export function setScreensForTests(app, { monitors = null, workArea = null }) {
  let session = sessions.get(app);
  if (!session) {
    session = new ScreenSession(app);
    sessions.set(app, session);
  }
  session.monitors = monitors;
  session.workArea = workArea;
  return session;
}
