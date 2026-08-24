/**
 * The screen layout: how many monitors there are, where they are, and how
 * much of each one a window may actually use.
 *
 * Two callers with very different needs share it, which is what shapes the
 * whole module.
 *
 * ## The internal caller: how big may an auto-sized window get?
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
 * ## The application caller: `useScreens()`
 *
 * An app that remembers which monitor it was on, or offers to open a video
 * on the other one, needs more than rects: a **name** to store, and a
 * **primary** flag to default to. Xinerama has neither — its reply is four
 * numbers per screen and nothing else — so that detail comes from RandR,
 * which also carries physical size and refresh rate.
 *
 * **RandR is not on the startup path**, and that is the point. Xinerama
 * answers the geometry in one round trip; the RandR walk is
 * `GetScreenResourcesCurrent`, then a `GetOutputInfo` and a `GetCrtcInfo`
 * per output, then `GetOutputPrimary` — ten or more round trips on an
 * ordinary two-head desktop. Making `createRoot()` wait for that would cost
 * every app startup latency for a question most of them never ask. So the
 * cheap tier resolves first and the detailed one publishes over it a moment
 * later.
 *
 * That is only safe because the second answer **adds to** the first rather
 * than correcting it: Xinerama on any modern server is RandR's own
 * emulation, so the rects agree, and what arrives late is the name, the
 * primary flag, the millimetres and the refresh rate. A component that
 * rendered against the early answer sees fields appear, not move.
 *
 * ## What this deliberately does not model
 *
 * **The window manager's frame.** A window sized to exactly the work-area
 * height is taller than that once it has a titlebar, and the WM will shrink
 * or shove it. EWMH's answer is `_NET_REQUEST_FRAME_EXTENTS`, which a client
 * sends *before* mapping and the WM replies to by writing
 * `_NET_FRAME_EXTENTS` — but that is a round trip in the middle of a
 * synchronous `realize()`, and plenty of window managers never answer it.
 * Letting the WM have the last word costs a clamped-to-the-edge window one
 * correction it would have made anyway.
 *
 * **A per-monitor work area.** `_NET_WORKAREA` is one rect for the whole
 * virtual desktop. Deriving a real per-monitor one means reading
 * `_NET_WM_STRUT_PARTIAL` off every window on the screen and intersecting
 * the reservations that fall on each head — a full window-tree walk, redone
 * whenever any panel changes. `available` below is the per-axis
 * approximation instead, and says so.
 */

import { requireExtension } from './extensions.js';

const sessions = new WeakMap();

const PROPERTY_NOTIFY = 28;
const PROPERTY_CHANGE_MASK = 4194304; // x11.eventMask.PropertyChange
const WORKAREA_PROPERTY = '_NET_WORKAREA';
// Which entry of the work-area list applies: a desktop can lay its struts
// out differently per workspace.
const DESKTOP_PROPERTY = '_NET_CURRENT_DESKTOP';

/** RandR's `Connection` enum — an output with nothing plugged into it is
 *  reported as a resource that exists and is not connected. */
const RR_CONNECTED = 0;

/**
 * What a connection knows about its outputs. `monitors` is null until
 * something has answered (or for good, where nothing ever does); `workArea`
 * is null until the desktop has published one. Both are advisory —
 * `availableArea()` degrades through them in order and always has the screen
 * to fall back on.
 */
class ScreenSession {
  constructor(app) {
    this.app = app;
    this.monitors = null;
    this.workArea = null;
    /** Which tier `monitors` came from, and the public `source`. */
    this.source = null;
    this.stopped = false;
    this._workAreaAtom = null;
    this._desktopAtom = null;
    this._snapshot = null;
    this._listeners = new Set();
    /** Every `X.on('event')` handler installed here, so `stop()` can take
     *  them off again rather than leaving one per root on a shared client. */
    this._handlers = [];
  }

  stop() {
    this.stopped = true;
    const X = this.app?.X;
    if (X?.off) {
      for (const fn of this._handlers) {
        try {
          X.off('event', fn);
        } catch {
          // an ntk old enough to hand back a client with no `off`; the
          // `stopped` guard inside every handler is the real safety net
        }
      }
    }
    this._handlers.length = 0;
    this._listeners.clear();
  }

  /** Install an X event handler that this session owns. */
  onEvent(fn) {
    const X = this.app?.X;
    if (!X?.on) return;
    X.on('event', fn);
    this._handlers.push(fn);
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

  /**
   * Replace what is known and tell anyone watching. The snapshot is dropped
   * rather than rebuilt: nothing may need it, and `screensSnapshot()` is
   * what rebuilds it on demand.
   */
  publish({ monitors, workArea, source }) {
    if (monitors !== undefined) this.monitors = monitors;
    if (workArea !== undefined) this.workArea = workArea;
    if (source !== undefined) this.source = source;
    this._snapshot = null;
    for (const fn of [...this._listeners]) {
      try {
        fn();
      } catch {
        // one subscriber throwing must not take the others with it, nor the
        // X event loop this runs on
      }
    }
  }

  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
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
 * The monitor rect clamped per axis by `_NET_WORKAREA` — see the note on
 * per-monitor work areas at the top of the file.
 *
 * Always **only** a rect. A monitor record carries a name, a primary flag and
 * physical sizes as well, and spreading it here put all of that inside
 * `screen.available`, where it read as a rect that had somehow grown a name.
 */
function usable(monitor, work) {
  const rect = {
    x: monitor.x,
    y: monitor.y,
    width: monitor.width,
    height: monitor.height,
  };
  if (!work) return rect;
  rect.width = Math.min(rect.width, work.width);
  rect.height = Math.min(rect.height, work.height);
  return rect;
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
  return usable(monitor, session.workArea);
}

// --------------------------------------------------------------------------
// The public snapshot
// --------------------------------------------------------------------------

const EMPTY = Object.freeze({
  screens: Object.freeze([]),
  primary: null,
  workArea: null,
  virtual: null,
  source: null,
});

/** The union of every monitor rect — what the virtual screen must be at
 *  least, for a server that did not say. */
function union(monitors) {
  if (!monitors?.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const m of monitors) {
    x0 = Math.min(x0, m.x);
    y0 = Math.min(y0, m.y);
    x1 = Math.max(x1, m.x + m.width);
    y1 = Math.max(y1, m.y + m.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * What is known right now, as one frozen object.
 *
 * Frozen and cached because `useScreens()` reads it through
 * `useSyncExternalStore`, whose `getSnapshot` must return the *same* object
 * until something actually changes — building a fresh array per call is what
 * makes React loop.
 */
export function screensSnapshot(app) {
  const session = sessions.get(app);
  if (!session) return EMPTY;
  if (session._snapshot) return session._snapshot;

  const screen = session.screenRect;
  // Nothing answered, but there is still a screen: one monitor covering it
  // is a truer answer than an empty list, which reads as "no displays".
  const rects =
    session.monitors ??
    (screen ? [{ ...screen, name: null, primary: true }] : null);

  const screens = Object.freeze(
    (rects ?? []).map((m) =>
      Object.freeze({
        name: m.name ?? null,
        outputs: Object.freeze(m.outputs ? [...m.outputs] : []),
        x: m.x,
        y: m.y,
        width: m.width,
        height: m.height,
        available: Object.freeze(usable(m, session.workArea)),
        primary: m.primary === true,
        widthMM: m.widthMM ?? null,
        heightMM: m.heightMM ?? null,
        refreshRate: m.refreshRate ?? null,
        rotation: m.rotation ?? 0,
      }),
    ),
  );

  session._snapshot = Object.freeze({
    screens,
    // No output is flagged primary on a single-head desktop that never ran
    // `xrandr --primary`, and "the one monitor" is the useful answer there.
    primary:
      screens.find((s) => s.primary) ??
      (screens.length === 1 ? screens[0] : null),
    workArea: session.workArea ? Object.freeze({ ...session.workArea }) : null,
    virtual: Object.freeze(screen ?? union(rects) ?? null),
    source: session.source ?? (rects?.length ? 'screen' : null),
  });
  return session._snapshot;
}

/** Subscribe to the layout changing. Not public — `useScreens()` is. */
export function watchScreens(app, fn) {
  const session = sessions.get(app);
  if (!session) return () => {};
  return session.subscribe(fn);
}

// --------------------------------------------------------------------------
// Starting up
// --------------------------------------------------------------------------

/**
 * Start reading the screen layout on `app`. Resolves once the *cheap* answer
 * is in, so `createRoot` can await it and every window realized afterwards
 * sizes against a settled value. The RandR walk that names the monitors runs
 * behind it and is deliberately not awaited — see the note at the top.
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
    // This is the longest chain on the startup path, so it is the one that
    // sets how long the first CreateWindow waits. Neither atom name depends
    // on anything — not on the Xinerama probe, not on each other — so all
    // three go out together and the chain is the probe plus the two property
    // reads that genuinely need their atoms.
    const [monitors, workAreaAtom, desktopAtom] = await Promise.all([
      queryMonitors(app),
      internAtom(X, WORKAREA_PROPERTY),
      internAtom(X, DESKTOP_PROPERTY).catch(() => null),
    ]);
    session._workAreaAtom = workAreaAtom;
    session._desktopAtom = desktopAtom;
    session.publish({
      monitors,
      workArea: await readWorkArea(session),
      source: monitors ? 'xinerama' : null,
    });
    watchLayout(session);
  } catch {
    // every failure here means "one tier less to work with", which is what
    // the nulls already say
  }

  // Detail, behind the geometry. Never awaited, and its failure is not this
  // function's failure: a server with no RandR keeps the Xinerama answer.
  refreshOutputs(session).catch(() => {});
  return session;
}

/**
 * Both the layout and the work area change while an app runs — a monitor is
 * plugged in, a panel is added or auto-hidden — and they announce themselves
 * two different ways.
 *
 * `_NET_WORKAREA` is a root-window property, so a `PropertyChange` selection
 * catches the panels. RandR's own `SelectInput` catches the rest, and it is
 * needed rather than merely nice: a second monitor arriving beside the first
 * without moving any dock changes no property at all, so a `_NET_WORKAREA`
 * watch alone would never hear about it. Where RandR is missing the property
 * watch still covers the common case, because a WM that rearranges monitors
 * usually republishes the work area with it.
 */
function watchLayout(session) {
  const X = session.app.X;
  const root = X.display?.screen?.[0]?.root;
  if (root == null) return;
  session.onEvent((ev) => {
    if (session.stopped) return;
    if (ev.type !== PROPERTY_NOTIFY || ev.wid !== root) return;
    if (ev.atom !== session._workAreaAtom) return;
    relayout(session);
  });
  watchRandR(session);
  // PropertyChange on a window we do not own. Legal and shared — every
  // panel-aware application on the desktop selects this same event.
  //
  // Through ntk's root Window rather than as a raw ChangeWindowAttributes,
  // because an X event mask is absolute per client: whoever writes last wins
  // outright. ntk keeps selections additive by tracking the mask on a Window
  // it caches per id, and adopting the root — which the shared-glyph
  // directory does to hear MANAGER announcements — starts that tracked mask
  // at zero and writes StructureNotify over whatever was there. A raw write
  // is a value the next adopter silently overwrites, in either direction:
  // reversed, it is a window manager's SubstructureRedirect that goes.
  //
  // Last in this function on purpose. `rootWindow()` constructs a Window,
  // which can throw, and `beginScreens` calls this inside a bare catch — so
  // ahead of the two registrations above, a throw here would take the
  // work-area handler and the RandR watch with it rather than only the
  // selection it belongs to.
  session.app
    .rootWindow()
    .selectInput(PROPERTY_CHANGE_MASK)
    .catch(() => {});
}

/** Re-read everything the layout is built from and publish once. */
function relayout(session) {
  return Promise.all([queryMonitors(session.app), readWorkArea(session)]).then(
    ([monitors, workArea]) => {
      if (session.stopped) return;
      session.publish({
        // A failed re-query means "could not ask again", never "no monitors".
        monitors: monitors ?? session.monitors,
        workArea,
        source: monitors ? 'xinerama' : session.source,
      });
      return refreshOutputs(session);
    },
    () => {},
  );
}

async function watchRandR(session) {
  const randr = await requireExtension(session.app, 'randr');
  if (!randr || session.stopped) return;
  const X = session.app.X;
  const root = X.display?.screen?.[0]?.root;
  if (root == null) return;
  try {
    // ScreenChange alone misses a monitor that arrives without resizing the
    // virtual screen, so the CRTC and output masks go on too. node-x11 only
    // parses ScreenChangeNotify; the rest arrive as a bare `{type, seq}`,
    // which is all this needs — every one of them means "ask again".
    randr.SelectInput(
      root,
      randr.NotifyMask.ScreenChange |
        randr.NotifyMask.CrtcChange |
        randr.NotifyMask.OutputChange,
    );
  } catch {
    return;
  }
  const first = randr.firstEvent;
  session.onEvent((ev) => {
    if (session.stopped) return;
    if (ev.type !== first && ev.type !== first + 1) return;
    relayout(session);
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

// --------------------------------------------------------------------------
// RandR: the names, the primary flag, the millimetres and the refresh rate
// --------------------------------------------------------------------------

/**
 * Turn one RandR walk into monitor records.
 *
 * Pure, and exported for that reason: the in-process X server used by the
 * tests has no RandR at all, so the walk cannot be driven end to end there
 * and this is the part worth pinning.
 *
 * **Keyed by CRTC, not by output.** Two outputs showing the same pixels —
 * a laptop mirroring to a projector — share one CRTC and are one monitor,
 * however many cables are involved. RandR 1.5's `GetMonitors` is the
 * protocol's own answer to this and node-x11 does not implement it, so the
 * grouping happens here; `outputs` keeps both names so a mirrored pair is
 * still legible.
 */
export function monitorsFromRandR({ outputs, crtcs, modes, primary }) {
  const byMode = new Map((modes ?? []).map((m) => [m.id, m]));
  const byCrtc = new Map();

  for (const output of outputs ?? []) {
    // An output with no CRTC is a port with nothing plugged in, or a
    // connected screen the user has switched off. Neither is a monitor.
    if (output.connection !== RR_CONNECTED || !output.crtc) continue;
    const crtc = crtcs?.get?.(output.crtc) ?? null;
    if (!crtc?.width || !crtc?.height) continue;

    let monitor = byCrtc.get(output.crtc);
    if (!monitor) {
      monitor = {
        name: output.name || null,
        outputs: [],
        x: crtc.x,
        y: crtc.y,
        width: crtc.width,
        height: crtc.height,
        primary: false,
        // Physical size is per *output*, so a mirrored pair keeps the first
        // one's — there is no single honest answer for two panels at once.
        widthMM: output.widthMM || null,
        heightMM: output.heightMM || null,
        refreshRate: refreshRateOf(byMode.get(crtc.mode)),
        rotation: degreesOf(crtc.rotation),
      };
      byCrtc.set(output.crtc, monitor);
    }
    if (output.name) monitor.outputs.push(output.name);
    if (primary && output.id === primary) {
      monitor.primary = true;
      // The primary output names the monitor even when it is not the first
      // one the walk reached.
      if (output.name) monitor.name = output.name;
    }
  }

  const list = [...byCrtc.values()];
  // Left to right, then top to bottom: the order the desktop is laid out in,
  // rather than the order the server happened to enumerate resources in,
  // which is arbitrary and not stable across a replug.
  list.sort((a, b) => a.x - b.x || a.y - b.y);
  return list;
}

/**
 * Hz from a mode line, to two decimals — `dot_clock / (h_total * v_total)`.
 *
 * The rounding is not cosmetic. A 60Hz mode is 59.9986… and a caller
 * comparing rates, or printing one, wants `59.99` rather than a float whose
 * last digits are a property of the timing table.
 *
 * **A result outside a plausible range is null rather than the number.** An X
 * server that does not drive real hardware fills the timing fields in with
 * something rather than leaving them out: XQuartz's active mode reports a
 * `dot_clock` of exactly `h_total * v_total`, so the arithmetic is a
 * blameless 1 Hz — and an app showing "1 Hz" beside a monitor name looks
 * broken in a way that showing nothing does not. No panel a desktop is drawn
 * on refreshes below 20Hz, so a value under it is a server saying "I do not
 * know" in the only way the protocol lets it.
 */
export function refreshRateOf(mode) {
  if (!mode?.dot_clock || !mode.h_total || !mode.v_total) return null;
  const hz = mode.dot_clock / (mode.h_total * mode.v_total);
  if (!Number.isFinite(hz) || hz < 20 || hz > 1000) return null;
  return Math.round(hz * 100) / 100;
}

/** RandR's rotation bitmask → degrees. The reflection bits are ignored:
 *  they say the image is mirrored, not that it is turned. */
export function degreesOf(rotation) {
  if (rotation & 8) return 270;
  if (rotation & 4) return 180;
  if (rotation & 2) return 90;
  return 0;
}

/**
 * Walk RandR and publish the detail over whatever Xinerama said.
 *
 * Resolves to false wherever the walk cannot finish — no extension, an
 * ntk with no raw connection, a layout change mid-walk — leaving the
 * cheaper answer standing.
 */
async function refreshOutputs(session) {
  const app = session.app;
  const randr = await requireExtension(app, 'randr');
  if (!randr || session.stopped) return false;
  const X = app.X;
  const root = X.display?.screen?.[0]?.root;
  if (root == null) return false;

  const resources = await call(randr.GetScreenResourcesCurrent, root);
  if (!resources || session.stopped) return false;

  const primary = await call(randr.GetOutputPrimary, root);

  // Every output, then every CRTC one of them names. Issued together rather
  // than in sequence: they are independent reads on one connection, so the
  // whole walk costs one round trip's latency rather than one per output.
  const infos = await Promise.all(
    (resources.outputs ?? []).map((id) =>
      call(randr.GetOutputInfo, id, resources.config_timestamp).then(
        (info) => (info ? { ...info, id } : null),
        () => null,
      ),
    ),
  );
  if (session.stopped) return false;

  const wanted = new Set(infos.filter((o) => o?.crtc).map((o) => o.crtc));
  const crtcs = new Map();
  await Promise.all(
    [...wanted].map((id) =>
      call(randr.GetCrtcInfo, id, resources.config_timestamp).then(
        (info) => info && crtcs.set(id, info),
        () => {},
      ),
    ),
  );
  if (session.stopped) return false;

  const monitors = monitorsFromRandR({
    outputs: infos.filter(Boolean).map((o) => ({
      id: o.id,
      name: o.name,
      crtc: o.crtc,
      connection: o.connection,
      widthMM: o.mm_width,
      heightMM: o.mm_height,
    })),
    crtcs,
    modes: resources.modeinfos,
    primary,
  });
  // A walk that found nothing usable is a walk that failed, not a desktop
  // with no monitors — every head could have been unplugged between the two
  // requests, and Xinerama's answer is better than none.
  if (!monitors.length) return false;
  session.publish({ monitors, source: 'randr' });
  return true;
}

/** A node-x11 request as a promise that resolves to null on error. */
function call(fn, ...args) {
  return new Promise((resolve) => {
    try {
      fn(...args, (err, value) => resolve(err ? null : value));
    } catch {
      resolve(null);
    }
  });
}

// --------------------------------------------------------------------------
// _NET_WORKAREA
// --------------------------------------------------------------------------

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
    // Interned alongside the work-area atom in beginScreens, because this
    // read is only reached once the work-area reply has landed and a name
    // lookup discovered then is a round trip nothing was waiting to learn.
    const atom =
      session._desktopAtom ?? (await internAtom(X, DESKTOP_PROPERTY));
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
 *
 * `monitors` entries may carry the RandR fields (`name`, `primary`,
 * `widthMM`, `heightMM`, `refreshRate`, `rotation`) as well as the rect, so
 * a test can state a named two-head desktop without a server that has RandR.
 */
export function setScreensForTests(app, { monitors = null, workArea = null }) {
  let session = sessions.get(app);
  if (!session) {
    session = new ScreenSession(app);
    sessions.set(app, session);
  }
  session.publish({
    monitors,
    workArea,
    source: monitors ? 'test' : null,
  });
  return session;
}
