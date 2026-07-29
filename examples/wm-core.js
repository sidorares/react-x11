// The X11 half of the window manager: everything that talks to the server
// and to the applications being managed. It owns no pixels — it keeps a list
// of managed clients and tells React about it, and wm.jsx draws the frames.
//
// A window manager on X11 is an ordinary client with one privilege: it holds
// SubstructureRedirect on the root window, so when an application asks to be
// shown or resized the server asks *us* instead of doing it. Everything
// below follows from that one fact.

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

export const frameWidth = (clientWidth) => clientWidth + 2 * BORDER;
export const frameHeight = (clientHeight) =>
  clientHeight + 2 * BORDER + TITLE_H;

// ConfigureRequest value mask bits (X11 CWX, CWY, CWWidth, CWHeight)
const CW_X = 0x01;
const CW_Y = 0x02;
const CW_WIDTH = 0x04;
const CW_HEIGHT = 0x08;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

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

/**
 * The managed-client registry. React subscribes to it with
 * useSyncExternalStore, so every change here — a new window, a new title, a
 * drag in progress — is one re-render of the frames.
 */
export class WindowManager {
  constructor(app) {
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
    window.on('property', () => this.refreshTitle(window.id));

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
    this.clients.delete(id);
    if (this.focused === id) {
      this.focused = null;
      this.focusTopmost();
    }
    this._changed();
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
