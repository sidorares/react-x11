// The X11 half of the window manager: everything that talks to the server
// and to the applications being managed. It owns no pixels — it keeps a list
// of managed clients and tells React about it, and wm.jsx draws the frames.
//
// A window manager on X11 is an ordinary client with one privilege: it holds
// SubstructureRedirect on the root window, so when an application asks to be
// shown or resized the server asks *us* instead of doing it. Everything
// below follows from that one fact.

import { Pixmap } from 'ntk';

// X11 protocol constants, spelled out rather than imported: x11 is ntk's
// dependency, not this package's.
const SUBSTRUCTURE_NOTIFY = 0x00080000; // event masks
const SUBSTRUCTURE_REDIRECT = 0x00100000;
const BUTTON_PRESS_EVENT = 4; // event types, not mask bits
const MAPPING_NOTIFY = 34;
const MOD1 = 8; // modifiers: Alt, and the two locks that ride along with it
const LOCK = 2;
const MOD2 = 16;

// Frame geometry. The client window is reparented into the frame at
// (BORDER, BORDER + TITLE_H); everything outside that rect is ours to draw.
export const BORDER = 4;
export const TITLE_H = 26;
export const TASKBAR_H = 32;
export const ICON_SIZE = 16;

export const frameWidth = (clientWidth) => clientWidth + 2 * BORDER;
export const frameHeight = (clientHeight) =>
  clientHeight + 2 * BORDER + TITLE_H;

// ConfigureRequest value mask bits (X11 CWX, CWY, CWWidth, CWHeight)
const CW_X = 0x01;
const CW_Y = 0x02;
const CW_WIDTH = 0x04;
const CW_HEIGHT = 0x08;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// ---------------------------------------------------------------------------
// Application icons
//
// There are two standards and clients use one or the other. EWMH
// `_NET_WM_ICON` is the modern one: ARGB pixels in a property, in as many
// sizes as the application cares to offer, which is what GTK and Qt set.
// ICCCM `WM_HINTS` is what came before it: a pointer to a pixmap living on
// the server, which is what xterm and the rest of the classic clients still
// set. A window manager that only reads one of them shows blanks for half
// the windows on a normal desktop.
//
// (A third route exists on Linux desktops — match `WM_CLASS` against a
// freedesktop .desktop file and look the name up in an icon theme — which is
// how applications that ship no icon at all still get one. That is a
// filesystem convention rather than an X one, so it is out of scope here.)
// ---------------------------------------------------------------------------

const ICON_PIXMAP_HINT = 0x04; // WM_HINTS flags
const ICON_MASK_HINT = 0x20;

/** Prefer the smallest icon that is still at least `wanted` across. */
function betterFit(candidate, current, wanted) {
  if (!current) return true;
  const fits = candidate >= wanted;
  const fitted = current >= wanted;
  if (fits !== fitted) return fits;
  return fits ? candidate < current : candidate > current;
}

/**
 * `_NET_WM_ICON`: a run of [width, height, width*height ARGB pixels] blocks,
 * repeated once per size the application offers.
 */
export function parseNetWmIcon(words, wanted) {
  let best = null;
  for (let i = 0; i + 2 <= words.length;) {
    const width = words[i];
    const height = words[i + 1];
    const count = width * height;
    if (!width || !height || i + 2 + count > words.length) break;
    if (betterFit(width, best?.width, wanted)) {
      best = { width, height, pixels: words.slice(i + 2, i + 2 + count) };
    }
    i += 2 + count;
  }
  if (!best) return null;
  const data = Buffer.alloc(best.width * best.height * 4);
  for (let n = 0; n < best.pixels.length; n++) {
    const argb = best.pixels[n];
    data[n * 4] = (argb >>> 16) & 0xff;
    data[n * 4 + 1] = (argb >>> 8) & 0xff;
    data[n * 4 + 2] = argb & 0xff;
    data[n * 4 + 3] = (argb >>> 24) & 0xff;
  }
  return { width: best.width, height: best.height, data };
}

/** Bit (x, y) of a depth-1 image: rows padded to 32 bits, LSB leftmost. */
function bitAt(image, width, x, y) {
  const stride = Math.ceil(width / 32) * 4;
  return (image.data[y * stride + (x >> 3)] >> (x & 7)) & 1;
}

/**
 * Read a drawable as RGBA. A depth-1 icon is a stencil rather than a
 * picture — it carries no colour of its own, so it is drawn in the
 * titlebar's foreground with the unset bits left transparent, which is what
 * makes xlogo's outline read on a dark frame instead of arriving as a black
 * square. Deeper icons come back as four bytes per pixel, BGRX.
 */
function drawableToRgba(image, width, height) {
  const data = Buffer.alloc(width * height * 4);
  if (image.depth === 1) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const n = (y * width + x) * 4;
        data[n] = data[n + 1] = data[n + 2] = 0xff;
        data[n + 3] = bitAt(image, width, x, y) ? 0xff : 0x00;
      }
    }
    return data;
  }
  for (let n = 0; n < width * height; n++) {
    data[n * 4] = image.data[n * 4 + 2];
    data[n * 4 + 1] = image.data[n * 4 + 1];
    data[n * 4 + 2] = image.data[n * 4];
    data[n * 4 + 3] = 0xff;
  }
  return data;
}

/**
 * Where a resize drag leaves the window. `edges` is which sides the handle
 * moves ('n', 's', 'e', 'w' in any combination); the opposite side stays
 * exactly where it was, including when the size runs into a limit — which
 * is the whole reason this is one function and not four lines at each call
 * site. Pure, so the awkward part is the part that is easy to reason about.
 */
export function resizeRect(start, edges, dx, dy, limits) {
  const { minWidth, minHeight, maxWidth, maxHeight } = limits;
  let { x, y, width, height } = start;

  if (edges.includes('e')) {
    width = clamp(start.width + dx, minWidth, maxWidth);
  } else if (edges.includes('w')) {
    width = clamp(start.width - dx, minWidth, maxWidth);
    x = start.x + start.width - width; // right edge pinned
  }
  if (edges.includes('s')) {
    height = clamp(start.height + dy, minHeight, maxHeight);
  } else if (edges.includes('n')) {
    height = clamp(start.height - dy, minHeight, maxHeight);
    y = start.y + start.height - height; // bottom edge pinned
  }
  return { x, y, width, height };
}

// ---------------------------------------------------------------------------
// Live window contents
//
// A window manager can show what a window looks like without reading a
// single pixel back. The Composite extension redirects a window's drawing
// into an offscreen pixmap; `NameWindowPixmap` gives that pixmap an id, and
// react-x11's `<image drawable>` composites straight from it through
// XRender. The server does the scaling, so a 900x600 window shown 240px
// wide costs one composite per repaint and nothing at all on the socket.
//
// `Automatic` is the update type that keeps this a *reparenting* window
// manager rather than a compositing one: the server goes on painting the
// redirected window into its parent itself, so the desktop looks and
// behaves exactly as it did before the redirect. `Manual` is what a
// compositing manager asks for, and it takes on the job of putting every
// window on screen in return.
//
// Two things about a named pixmap decide the shape of the class below.
//
//  - **It is a generation, not a handle.** The server drops it when the
//    window is resized, so a resize has to name a new one — which is why
//    `invalidate` exists and why `setGeometry` calls it.
//  - **Naming it again is cheap and always current.** Every name refers to
//    the pixmap the window is drawing into *now*, so re-naming is how a
//    preview stays live: a new id is what tells `<image>` its source
//    changed. DAMAGE would say exactly when that is worth doing instead of
//    on a timer, and this example does not go that far — see the note in
//    wm.jsx.
//
// Not everywhere, though: XQuartz carries RENDER, DAMAGE, XFIXES and SHAPE
// but no Composite at all, and neither does node-x11's in-process server.
// So `wm.thumbnails` is null on those and everything else works unchanged.
// ---------------------------------------------------------------------------

/**
 * The offscreen pixmap behind each frame, named on demand.
 *
 * `WindowManager` takes the opener as a seam (`new WindowManager(app, {
 * openThumbnails })`) so a test can hand it a fake — the real one needs a
 * server with Composite, which the headless suite does not have.
 */
export class Thumbnails {
  /** The provider for `app`, or null where the server has no Composite. */
  static async open(app) {
    const composite = await app.composite?.();
    return composite ? new Thumbnails(app, composite) : null;
  }

  constructor(app, composite) {
    this.app = app;
    this.X = app.X;
    this.composite = composite;
    // client id -> { frameId, pixmap, retired, drawable }
    this._entries = new Map();
  }

  /**
   * Start redirecting `frame`, so its contents can be named later.
   *
   * Done for every frame rather than for the ones somebody looks at:
   * redirection only decides *where* the server draws, and under
   * `Automatic` it draws to both places, so the window that is never
   * previewed costs one request and nothing after it. Naming a pixmap is
   * the part that waits for a reason.
   */
  track(id, frame) {
    if (this._entries.has(id)) return;
    this.composite.RedirectWindow(frame.id, this.composite.Redirect.Automatic);
    this._entries.set(id, {
      frameId: frame.id,
      pixmap: null,
      retired: null,
      drawable: null,
    });
  }

  /** The descriptor `<image drawable>` takes, or null until `capture`. */
  get(id) {
    return this._entries.get(id)?.drawable ?? null;
  }

  /**
   * Name this frame's current pixmap and take ownership of it.
   *
   * Adopting is what confirms the name landed: `NameWindowPixmap` is a void
   * request against an id we allocated ourselves, so a frame that is not
   * viewable yet fails asynchronously, and an unchecked id reaches XRender
   * as a BadPixmap in the middle of a paint — a much worse place to find
   * out. ntk's `Pixmap.adopt` is built for exactly this handover and says
   * so; it also skips its round trip when the geometry is already known,
   * which is every refresh after the first in a generation.
   */
  async capture(id) {
    const entry = this._entries.get(id);
    if (!entry) return null;
    const name = this.X.AllocID();
    this.composite.NameWindowPixmap(entry.frameId, name);
    const known = entry.drawable;
    const pixmap = await Pixmap.adopt(
      this.app,
      name,
      known
        ? { width: known.width, height: known.height, depth: known.depth }
        : {},
    ).catch(() => null);
    // the client can be gone by the time a first adopt answers
    if (!pixmap || !this._entries.has(id)) {
      pixmap?.destroy();
      return null;
    }
    // One generation behind on purpose. React has already been handed
    // `entry.pixmap` and swapped its Picture over to it, so nothing is
    // compositing from `entry.retired` any more.
    entry.retired?.destroy();
    entry.retired = entry.pixmap;
    entry.pixmap = pixmap;
    entry.drawable = {
      id: pixmap.id,
      width: pixmap.width,
      height: pixmap.height,
      depth: pixmap.depth,
    };
    return entry.drawable;
  }

  /**
   * The frame changed size, so the pixmap the server was drawing into is
   * gone and the geometry we cached with it is wrong. The next `capture`
   * names the new generation and pays the round trip to measure it.
   */
  invalidate(id) {
    const entry = this._entries.get(id);
    if (!entry) return;
    entry.pixmap?.destroy();
    entry.retired?.destroy();
    entry.pixmap = null;
    entry.retired = null;
    entry.drawable = null;
  }

  /**
   * Stop tracking `id`.
   *
   * The redirect is not undone, and that is deliberate twice over. A
   * window's redirection dies with the window, and the only caller is the
   * one place a frame is about to be unmounted — so there is nothing left
   * to hand back. And `UnredirectWindow` could not do it anyway:
   * node-x11 encodes it eight bytes long with no `update` field where the
   * protocol says twelve with one, so the request is a BadLength on every
   * real server. See sidorares/node-x11#292.
   */
  forget(id) {
    if (!this._entries.has(id)) return;
    this.invalidate(id);
    this._entries.delete(id);
  }
}

/**
 * The managed-client registry. React subscribes to it with
 * useSyncExternalStore, so every change here — a new window, a new title, a
 * drag in progress — is one re-render of the frames.
 */
export class WindowManager {
  /**
   * `openThumbnails` is the seam: it is what talks to the server about
   * Composite, and the headless suite has no Composite to talk to. The
   * default is the real thing; a test passes a fake, or one that answers
   * null to drive the no-previews path.
   */
  constructor(app, { openThumbnails = Thumbnails.open } = {}) {
    this.app = app;
    this.X = app.X;
    this.root = app.rootWindow();
    this.screen = app.display.screen[0];
    this.clients = new Map(); // client window id -> record
    this.focused = null;
    this._listeners = new Set();
    this._snapshot = [];
    this._ourWindows = new Set(); // frames and the taskbar
    this._placed = 0;
    this._serial = 0;
    this._openThumbnails = openThumbnails;
    /** The Composite-backed preview store, or null where there is none. */
    this.thumbnails = null;
  }

  get workArea() {
    return {
      width: this.screen.pixel_width,
      height: this.screen.pixel_height - TASKBAR_H,
    };
  }

  // ---- the store React reads -------------------------------------------

  subscribe = (onChange) => {
    this._listeners.add(onChange);
    return () => this._listeners.delete(onChange);
  };

  getSnapshot = () => this._snapshot;

  /** Rebuild the immutable snapshot and wake React. */
  _changed() {
    this._snapshot = [...this.clients.values()].map((client) => ({
      ...client,
      focused: client.id === this.focused,
      // null until something asks for one with `peek` — and null forever
      // on a server without Composite
      thumbnail: this.thumbnails?.get(client.id) ?? null,
    }));
    this.publishState();
    for (const listener of this._listeners) listener();
  }

  _update(id, patch) {
    const client = this.clients.get(id);
    if (!client) return null;
    Object.assign(client, patch);
    this._changed();
    return client;
  }

  // ---- becoming the window manager --------------------------------------

  /**
   * Claim the root and adopt whatever is already on screen. Rejects if
   * another window manager holds the redirect — only one client may.
   */
  async start() {
    try {
      await this.root.selectInput(SUBSTRUCTURE_REDIRECT | SUBSTRUCTURE_NOTIFY);
    } catch {
      throw new Error(
        'another window manager is already running on this display',
      );
    }

    this.root.on('map_request', (ev) => this.manage(ev.window));
    this.root.on('configure_request', (ev) => this.onConfigureRequest(ev));

    await this.announce();
    await this.internWatchedAtoms();
    // Before adoptExisting, which attaches no frames itself but is the
    // first thing that can lead to one: a provider that arrived late would
    // miss the redirect for every window already on screen.
    this.thumbnails = await this._openThumbnails(this.app);
    this.paintDesktop();
    this.watchClientClicks();

    // adoptExisting first: it round-trips, and ntk fills in the keyboard
    // map asynchronously right after connecting — grabbing before that
    // reply lands would find no keycode for Tab and silently do nothing
    await this.adoptExisting();
    await this.grabAltTab();
  }

  /**
   * The EWMH handshake. Toolkits look for _NET_SUPPORTING_WM_CHECK before
   * they believe a standards-aware window manager is running, and change
   * how they behave when they do not find one — so this is not decoration,
   * it is what makes GTK and Qt applications act normally.
   */
  async announce() {
    // the check window is a dummy that points at itself, which is how a
    // client tells a live window manager from a stale leftover property
    const check = this.app.createWindow({ width: 1, height: 1 });
    this._ourWindows.add(check.id);
    await check.setProperty('_NET_SUPPORTING_WM_CHECK', [check.id], {
      type: 'WINDOW',
    });
    await check.setProperty('_NET_WM_NAME', 'react-x11-wm');
    await this.root.setProperty('_NET_SUPPORTING_WM_CHECK', [check.id], {
      type: 'WINDOW',
    });

    const supported = await Promise.all(
      [
        '_NET_SUPPORTING_WM_CHECK',
        '_NET_CLIENT_LIST',
        '_NET_ACTIVE_WINDOW',
        '_NET_WM_NAME',
        '_NET_CLOSE_WINDOW',
        '_NET_WM_STATE',
        '_NET_WM_STATE_MAXIMIZED_HORZ',
        '_NET_WM_STATE_MAXIMIZED_VERT',
        '_NET_WM_STATE_HIDDEN',
      ].map((name) => this.root.atom(name)),
    );
    await this.root.setProperty('_NET_SUPPORTED', supported, { type: 'ATOM' });
  }

  /**
   * The properties worth reacting to when a client changes one. A
   * PropertyNotify names the atom that changed, so knowing these ids up
   * front turns "something changed, re-read everything" into one targeted
   * read — and applications change properties a lot.
   */
  async internWatchedAtoms() {
    const [wmName, netWmName, netWmIcon, wmHints] = await Promise.all(
      ['WM_NAME', '_NET_WM_NAME', '_NET_WM_ICON', 'WM_HINTS'].map((name) =>
        this.root.atom(name),
      ),
    );
    this._titleAtoms = new Set([wmName, netWmName]);
    this._iconAtoms = new Set([netWmIcon, wmHints]);
  }

  /**
   * Publish the client list and which window is active. Called on every
   * store change, including each motion event of a drag — so it compares
   * first: two X requests per pixel of mouse movement would be absurd.
   */
  publishState() {
    const ids = [...this.clients.keys()];
    const signature = `${ids.join(',')}|${this.focused}`;
    if (signature === this._published) return;
    this._published = signature;
    this.root.setProperty('_NET_CLIENT_LIST', ids, { type: 'WINDOW' });
    this.root.setProperty('_NET_ACTIVE_WINDOW', [this.focused ?? 0], {
      type: 'WINDOW',
    });
  }

  /**
   * Click-to-focus for the client area. Each managed window gets a
   * synchronous button grab (see manage), which freezes the pointer and
   * delivers the press here first; we raise and focus, then hand the very
   * same click on to the application with allowEvents('replay').
   *
   * One subscription to the raw event stream rather than a listener per
   * window, because asking for the ButtonPress *mask* on a client window
   * would fail: only one client at a time may hold it, and the application
   * already does. The grab is what delivers these, not the mask.
   */
  watchClientClicks() {
    this.X.on('event', (ev) => {
      if (ev.type !== BUTTON_PRESS_EVENT || !this.clients.has(ev.wid)) return;
      this.focus(ev.wid);
      this.app.allowEvents('replay');
    });
  }

  /** A plain colour behind everything, so the desktop is not a black hole. */
  paintDesktop(color = 0x1b1d23) {
    this.X.ChangeWindowAttributes(this.root.id, { backgroundPixel: color });
    this.X.ClearArea(this.root.id, 0, 0, 0, 0, 0);
  }

  /**
   * Alt+Tab, the one keyboard gesture. A window manager cannot just listen
   * for keys — they go to the focused application — so it asks the server
   * for this one combination on the root, which leaves every other key
   * belonging to whoever is focused.
   *
   * Re-run whenever the keyboard map changes: the keycode that was Tab a
   * moment ago may not be any more, and a grab on the old one is a grab on
   * a key nobody presses.
   */
  async grabAltTab() {
    const TAB = 0xff09; // XK_Tab
    const { min_keycode: min, max_keycode: max } = this.app.display;
    // ask the server for the map rather than reading ntk's copy: that one
    // is filled in from a reply that may not have landed yet, and a keycode
    // guessed from a half-built map grabs the wrong key
    const map = await new Promise((resolve) =>
      this.X.GetKeyboardMapping(min, max - min, (err, list) =>
        resolve(err ? [] : list),
      ),
    );
    // a layout can put the same keysym on more than one keycode, and any of
    // them is a real Tab
    const keycodes = new Set(
      map.flatMap((syms, i) => (syms.includes(TAB) ? [min + i] : [])),
    );
    if (!keycodes.size) return;

    for (const keycode of this._tabKeycodes ?? []) {
      this.X.UngrabKey(this.root.id, keycode, 0x8000 /* AnyModifier */);
    }
    this._tabKeycodes = keycodes;

    // CapsLock and NumLock are part of the modifier state, and a grab only
    // fires on an exact match — so grab every combination of them, or
    // alt+tab silently stops working the moment either lock is on
    for (const keycode of keycodes) {
      for (const lock of [0, LOCK, MOD2, LOCK | MOD2]) {
        this.X.GrabKey(this.root.id, false, MOD1 | lock, keycode, 1, 1);
      }
    }
    if (this._watchingKeymap) return;
    this._watchingKeymap = true;
    this.X.on('event', (ev) => {
      if (ev.type === MAPPING_NOTIFY) this.grabAltTab();
    });
    this.root.on('keydown', (ev) => {
      if (this._tabKeycodes.has(ev.keycode)) this.focusNext();
    });
  }

  /**
   * Windows mapped before we started have no frame and will never send a
   * MapRequest — a window manager has to go and find them.
   */
  async adoptExisting() {
    const tree = await new Promise((resolve, reject) =>
      this.root.queryTree((err, res) => (err ? reject(err) : resolve(res))),
    );
    for (const window of tree.children) {
      const attributes = await window.getAttributes().catch(() => null);
      // override-redirect windows (menus, tooltips) opt out of management,
      // and an unmapped one will ask for itself when it is ready
      if (!attributes || attributes.overrideRedirect) continue;
      if (attributes.mapState !== 2) continue;
      await this.manage(window);
    }
  }

  // ---- the client lifecycle ---------------------------------------------

  /** Take a client window under management. The frame follows from React. */
  async manage(window) {
    if (this.clients.has(window.id)) return;
    if (window.id === this.root.id || this._ourWindows.has(window.id)) return;

    const hints = await window.getSizeHints().catch(() => ({}));
    const title = (await window.getTitle().catch(() => null)) ?? 'untitled';
    // WM_TRANSIENT_FOR marks a dialog belonging to another window: it stays
    // above its parent and stays out of the taskbar, which is where the
    // application itself belongs
    const transientFor = (
      await window
        .getProperty('WM_TRANSIENT_FOR', { as: 'numbers' })
        .catch(() => null)
    )?.[0];
    const icon = await this.readIcon(window).catch(() => null);

    const minWidth = Math.max(hints.minWidth ?? 0, 80);
    const minHeight = Math.max(hints.minHeight ?? 0, 40);
    // a window may not open larger than there is room for, frame included —
    // clients routinely ask for more than the screen has
    const area = this.workArea;
    const width = clamp(
      window.width || 400,
      minWidth,
      Math.max(minWidth, area.width - 2 * BORDER),
    );
    const height = clamp(
      window.height || 300,
      minHeight,
      Math.max(minHeight, area.height - 2 * BORDER - TITLE_H),
    );

    const client = {
      id: window.id,
      window,
      title,
      icon,
      ...this.placeWindow(width, height),
      width,
      height,
      minWidth,
      minHeight,
      maxWidth: hints.maxWidth || Infinity,
      maxHeight: hints.maxHeight || Infinity,
      transientFor: transientFor || null,
      maximized: false,
      minimized: false,
      restore: null,
      serial: ++this._serial,
      frame: null, // the ntk window of the React <window>, once realized
    };
    this.clients.set(window.id, client);

    // If we exit, the server puts the client back where it found it instead
    // of destroying it along with our frame.
    window.addToSaveSet();

    // A click anywhere in the client raises and focuses it. The grab is
    // synchronous, so we see the press before the application does and
    // decide what happens to it (see watchClientClicks).
    window.grabButton({ button: 1, pointerMode: 0 });

    window.on('destroy', () => this.forget(window.id, { gone: true }));
    // a client unmapping itself is withdrawing (ICCCM); ours stay mapped
    // while minimized, because minimizing unmaps the frame instead
    window.on('unmap', () => this.forget(window.id, { gone: false }));
    // a client may retitle itself or swap its icon at any time; re-read only
    // the property that actually changed
    window.on('property', (ev) => {
      if (this._titleAtoms?.has(ev.atom)) this.refreshTitle(window.id);
      else if (this._iconAtoms?.has(ev.atom)) this.refreshIcon(window.id);
    });

    // no focus yet: the client is still unmapped and unframed, and
    // SetInputFocus on a window that is not viewable is a BadMatch.
    // attachFrame takes the focus once it is really on screen.
    this._changed();
  }

  /**
   * Stop managing a window. Unless it is already gone, it goes back to
   * being a child of the root — our frame is about to be unmounted, and
   * children die with their parent.
   */
  forget(id, { gone }) {
    const client = this.clients.get(id);
    if (!client) return;
    if (!gone) {
      client.window.reparentTo(this.root, client.x, client.y);
      client.window.removeFromSaveSet();
    }
    this.thumbnails?.forget(id);
    this.clients.delete(id);
    if (this.focused === id) {
      this.focused = null;
      this.focusTopmost();
    }
    this._changed();
  }

  /** GetImage as a promise. */
  _getImage(drawable, width, height) {
    return new Promise((resolve, reject) =>
      this.X.GetImage(
        2,
        drawable,
        0,
        0,
        width,
        height,
        0xffffffff,
        (err, image) => (err ? reject(err) : resolve(image)),
      ),
    );
  }

  _getGeometry(drawable) {
    return new Promise((resolve, reject) =>
      this.X.GetGeometry(drawable, (err, geometry) =>
        err ? reject(err) : resolve(geometry),
      ),
    );
  }

  /**
   * The application's icon as RGBA, at whatever size it offers closest to
   * `wanted`. `_NET_WM_ICON` first, then the ICCCM pixmap, then nothing —
   * plenty of windows have no icon at all and that is not an error.
   */
  async readIcon(window, wanted = ICON_SIZE) {
    const words = await window
      .getProperty('_NET_WM_ICON', { as: 'numbers' })
      .catch(() => null);
    const modern = words?.length ? parseNetWmIcon(words, wanted) : null;
    if (modern) return modern;
    return this.readPixmapIcon(window).catch(() => null);
  }

  /**
   * The ICCCM route: WM_HINTS names a pixmap, and optionally a 1-bit mask
   * saying which of its pixels count. Both live on the server, so this is a
   * read back rather than a property parse.
   */
  async readPixmapIcon(window) {
    const hints = await window
      .getProperty('WM_HINTS', { as: 'numbers' })
      .catch(() => null);
    if (!hints || hints.length < 9 || !(hints[0] & ICON_PIXMAP_HINT))
      return null;

    const { width, height } = await this._getGeometry(hints[3]);
    const image = await this._getImage(hints[3], width, height);
    const data = drawableToRgba(image, width, height);

    // A separate mask says which pixels of a colour icon count. A depth-1
    // icon needs none — its own bits already are the shape — and a client
    // that names one anyway points it back at the icon itself.
    const maskId = hints[0] & ICON_MASK_HINT ? hints[7] : 0;
    if (image.depth > 1 && maskId && maskId !== hints[3]) {
      const mask = await this._getImage(maskId, width, height).catch(
        () => null,
      );
      if (mask?.depth === 1) {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (!bitAt(mask, width, x, y)) data[(y * width + x) * 4 + 3] = 0;
          }
        }
      }
    }
    return { width, height, data };
  }

  async refreshIcon(id) {
    const client = this.clients.get(id);
    if (!client) return;
    const icon = await this.readIcon(client.window).catch(() => null);
    if (icon !== client.icon) this._update(id, { icon });
  }

  async refreshTitle(id) {
    const client = this.clients.get(id);
    if (!client) return;
    const title =
      (await client.window.getTitle().catch(() => null)) ?? 'untitled';
    if (title !== client.title) this._update(id, { title });
  }

  /**
   * The frame's X window, handed over once React has realized it: the
   * client is reparented inside and both are shown.
   */
  attachFrame(id, frame) {
    const client = this.clients.get(id);
    if (!client || client.frame === frame) return;
    client.frame = frame;
    this._ourWindows.add(frame.id);
    // Before the reparent, so the client's very first paint already lands
    // in the frame's offscreen pixmap rather than only in the one after it.
    this.thumbnails?.track(id, frame);

    // Redirect the frame *before* reparenting into it. A window's requests
    // are redirected by whoever holds SubstructureRedirect on its parent —
    // and after the reparent that is this frame, not the root. Without
    // this, a client resizing itself would silently do it behind our back,
    // and its window would no longer match the frame drawn around it.
    frame.on('configure_request', (ev) => this.onConfigureRequest(ev));
    frame.on('map_request', (ev) => ev.window.map());

    client.window.reparentTo(frame, BORDER, BORDER + TITLE_H);
    client.window.resize(client.width, client.height);
    client.window.map();
    this.notifyGeometry(client);
    // now that it is really on screen it can take the keyboard
    this.focus(id);
  }

  /**
   * A client asking to move or resize itself. The value mask says which
   * fields it actually set — the rest carry the window's current values and
   * mean nothing.
   */
  onConfigureRequest(ev) {
    const client = this.clients.get(ev.window.id);
    if (!client) {
      // not ours yet: let it have what it asked for, so its geometry is
      // already right by the time it maps and we frame it
      const values = {};
      if (ev.mask & CW_X) values.x = ev.x;
      if (ev.mask & CW_Y) values.y = ev.y;
      if (ev.mask & CW_WIDTH) values.width = ev.width;
      if (ev.mask & CW_HEIGHT) values.height = ev.height;
      if (Object.keys(values).length) {
        this.X.ConfigureWindow(ev.window.id, values);
      }
      return;
    }
    // a maximized window does not get to resize itself; ICCCM says tell it
    // so, or it waits forever for a ConfigureNotify that is not coming
    if (client.maximized) return this.notifyGeometry(client);
    this.setGeometry(client.id, {
      width: ev.mask & CW_WIDTH ? ev.width : client.width,
      height: ev.mask & CW_HEIGHT ? ev.height : client.height,
    });
  }

  // ---- geometry ----------------------------------------------------------

  /** Cascade new windows so they do not all land on top of each other. */
  placeWindow(width, height) {
    const step = 28;
    const slot = this._placed++ % 8;
    const area = this.workArea;
    return {
      x: Math.max(
        0,
        Math.min(40 + slot * step, area.width - frameWidth(width)),
      ),
      y: Math.max(
        0,
        Math.min(40 + slot * step, area.height - frameHeight(height)),
      ),
    };
  }

  /**
   * Apply a frame rect. Callers that drag an edge have already decided the
   * exact rect (see resizeRect); everything else gets its size clamped here.
   */
  setGeometry(id, rect) {
    const client = this.clients.get(id);
    if (!client) return;
    const next = {
      x: Math.round(rect.x ?? client.x),
      y: Math.round(rect.y ?? client.y),
      width: clamp(
        Math.round(rect.width ?? client.width),
        client.minWidth,
        client.maxWidth,
      ),
      height: clamp(
        Math.round(rect.height ?? client.height),
        client.minHeight,
        client.maxHeight,
      ),
    };
    const resized =
      next.width !== client.width || next.height !== client.height;
    // Before `_update`, which is what rebuilds the snapshot: the server
    // drops the named pixmap when the frame resizes, and a snapshot still
    // carrying it hands React an id that is already a BadPixmap. Dropping
    // it here means the worst a preview does across a resize is disappear
    // for the round trip it takes to name the next generation.
    if (resized) this.thumbnails?.invalidate(id);
    const updated = this._update(id, next);
    // a plain move does not touch the client: it rides along inside the
    // frame, and one ConfigureWindow per motion event is enough
    if (resized) updated.window.resize(next.width, next.height);
    this.notifyGeometry(updated);
  }

  toggleMaximize(id) {
    const client = this.clients.get(id);
    if (!client) return;
    const area = this.workArea;
    const next = client.maximized
      ? { ...client.restore, maximized: false, restore: null }
      : {
          restore: {
            x: client.x,
            y: client.y,
            width: client.width,
            height: client.height,
          },
          maximized: true,
          x: 0,
          y: 0,
          width: area.width - 2 * BORDER,
          height: area.height - 2 * BORDER - TITLE_H,
        };
    // before `_update`, for the reason setGeometry gives
    this.thumbnails?.invalidate(id);
    const updated = this._update(id, next);
    updated.window.resize(updated.width, updated.height);
    this.notifyGeometry(updated);
  }

  minimize(id) {
    const client = this._update(id, { minimized: true });
    // unmap the frame rather than unmounting it: the client is a child of
    // the frame now, and children are destroyed with their parent
    client?.frame?.unmap();
    if (this.focused === id) {
      this.focused = null;
      this.focusTopmost();
      this._changed();
    }
  }

  restore(id) {
    const client = this._update(id, { minimized: false });
    client?.frame?.map();
    this.focus(id);
  }

  // ---- focus and stacking -------------------------------------------------

  focus(id) {
    const client = this.clients.get(id);
    if (!client || client.minimized || this.focused === id) return;
    this.focused = id;
    // raise the frame, not the client: the client lives inside it now
    client.frame?.raise();
    // dialogs belonging to this window ride above it
    for (const other of this.clients.values()) {
      if (other.transientFor === id) other.frame?.raise();
    }
    client.window.focus();
    this._changed();
  }

  focusTopmost() {
    const next = [...this.clients.values()]
      .filter((client) => !client.minimized)
      .sort((a, b) => b.serial - a.serial)[0];
    if (next) this.focus(next.id);
  }

  /** Alt+Tab: the next window in the list, wrapping. */
  focusNext() {
    const open = [...this.clients.values()].filter(
      (client) => !client.minimized,
    );
    if (!open.length) return;
    const index = open.findIndex((client) => client.id === this.focused);
    const next = open[(index + 1) % open.length];
    // bump it to the top of the focus order so repeated Alt+Tab keeps moving
    next.serial = ++this._serial;
    this.focus(next.id);
  }

  /**
   * Refresh the preview for `id` and wake React with it.
   *
   * Called by whatever is showing one, on its own cadence: naming a pixmap
   * for a window nobody is looking at buys nothing, and naming it again is
   * how the preview stays current (see Thumbnails). A no-op where the
   * server has no Composite, which is what makes the caller's "is there a
   * thumbnail?" the only check it needs.
   */
  async peek(id) {
    if (!this.thumbnails || !this.clients.has(id)) return;
    if (await this.thumbnails.capture(id)) this._changed();
  }

  async close(id) {
    await this.clients.get(id)?.window.close();
  }

  /**
   * ICCCM 4.1.5: a reparented client's own ConfigureNotify carries
   * coordinates relative to its frame, which is not what it asked about.
   * Tell it where it really is, in root coordinates.
   */
  notifyGeometry(client) {
    client?.window.sendConfigureNotify({
      x: client.x + BORDER,
      y: client.y + BORDER + TITLE_H,
      width: client.width,
      height: client.height,
    });
  }

  /** Windows we created ourselves — never candidates for management. */
  claim(window) {
    this._ourWindows.add(window.id);
  }
}
