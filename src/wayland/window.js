// A surface with a shell role — a toplevel or a popup — and the handshake
// that is the biggest single difference between this backend and X11.
//
// On X11 a client asks and the server answers: `GetGeometry` returns a size,
// `ConfigureWindow` sets one, and a request takes effect as issued. Here the
// client *requests* and the compositor *decides*. A window is created with no
// size at all; the compositor sends `configure` saying how big it should be
// and what state it is in, the client acknowledges that serial, and only then
// may it show a buffer at that size. Nothing about a window's position is
// knowable, ever.
//
// The sequence is strict and a compositor will disconnect a client that gets
// it wrong:
//
//   create wl_surface -> get_xdg_surface -> get_toplevel / get_popup
//   commit with NO buffer                       (asks for the first configure)
//   <- xdg_toplevel.configure(w, h, states)     (0x0 means "you choose")
//   <- xdg_surface.configure(serial)
//   ack_configure(serial) -> attach -> damage -> commit
//
// **The ack is deferred to the frame that adopts the state.** Acking as soon
// as the configure arrives is legal, but it tells the compositor the *next*
// commit is at the new size — and if that commit carries a buffer the
// renderer painted at the old size, the compositor shows it stretched. So the
// serial is held and `ackPending()` is called immediately before the commit
// of a frame painted at the configured size (glcontext.js does this), which
// is what makes an interactive resize look right.
//
// Everything here is synchronous through the library's `$` namespace, because
// React's commit phase is synchronous and `WindowNode.realize()` calls
// `createWindow` inside it. The one genuinely asynchronous step — binding
// globals — is done once by the app at startup.
//
// Two more things hang off the same class. A *layer surface* (layershell.js)
// is what a dock or a wallpaper is: no xdg_surface, a `zwlr_layer_surface_v1`
// whose configure carries a size and is acked through it. And a toplevel may
// carry a *decoration* object (ssd.js) whose mode — who draws the frame —
// rides the same configure sequence and is adopted just before 'configure'
// is emitted, so the frame that acks it is painted at the right insets.

import { EventEmitter } from 'node:events';
import { ServerDecoration } from './ssd.js';
import { createLayerSurface } from './layershell.js';
import { requestNullable } from './nullable.js';

/** `xdg_toplevel.state` values. */
export const TOPLEVEL_STATE = {
  MAXIMIZED: 1,
  FULLSCREEN: 2,
  RESIZING: 3,
  ACTIVATED: 4,
  TILED_LEFT: 5,
  TILED_RIGHT: 6,
  TILED_TOP: 7,
  TILED_BOTTOM: 8,
  SUSPENDED: 9,
};

/** `xdg_toplevel.resize_edge`. */
export const RESIZE_EDGE = {
  NONE: 0,
  TOP: 1,
  BOTTOM: 2,
  LEFT: 4,
  TOP_LEFT: 5,
  BOTTOM_LEFT: 6,
  RIGHT: 8,
  TOP_RIGHT: 9,
  BOTTOM_RIGHT: 10,
};

/** `xdg_positioner.anchor` / `.gravity` share one numbering. */
const ANCHOR = {
  NONE: 0,
  TOP: 1,
  BOTTOM: 2,
  LEFT: 3,
  RIGHT: 4,
  TOP_LEFT: 5,
  BOTTOM_LEFT: 6,
  TOP_RIGHT: 7,
  BOTTOM_RIGHT: 8,
};
/** `xdg_positioner.constraint_adjustment` bits. */
const ADJUST = {
  SLIDE_X: 1,
  SLIDE_Y: 2,
  FLIP_X: 4,
  FLIP_Y: 8,
  RESIZE_X: 16,
  RESIZE_Y: 32,
};

/** What a toplevel falls back to when the compositor says "you choose". */
const DEFAULT_SIZE = { width: 800, height: 600 };

/** fractional-scale-v1 reports scale × 120. */
const SCALE_DENOM = 120;

export class WaylandWindow extends EventEmitter {
  constructor({ conn, surface, xdgSurface, role, kind, size, parent = null }) {
    super();
    this.conn = conn;
    /** the `wl_surface` — what a renderer attaches buffers to */
    this.surface = surface;
    this.xdgSurface = xdgSurface;
    /** the `xdg_toplevel` or `xdg_popup` */
    this.role = role;
    /** 'toplevel' | 'popup' */
    this.kind = kind;
    this.parent = parent;
    this.toplevel = kind === 'toplevel' ? role : null;
    this.popup = kind === 'popup' ? role : null;

    /** logical size, as the compositor last configured (or we chose) */
    this.width = size.width;
    this.height = size.height;
    /** popups: position relative to the parent, as configured */
    this.x = 0;
    this.y = 0;
    /**
     * Output scale. Integer from `preferred_buffer_scale`, refined to a
     * fraction by fractional-scale-v1 when the compositor has it. The buffer
     * is `logical × scale`; with a viewport the buffer scale stays 1.
     */
    this.scale = 1;
    this.states = new Set();
    /**
     * The `wl_output` proxies (by id) this surface currently overlaps, from
     * `wl_surface.enter`/`leave` — the only word a client gets on where it
     * is. Empty until the surface is mapped; outputs.js turns ids into
     * monitors.
     */
    this.outputs = new Set();
    /** `xdg_toplevel.configure_bounds`: the logical size to fit in, or null */
    this.bounds = null;
    /** a configure has arrived: a buffer may be committed once it is acked */
    this.configured = false;
    this.mapped = false;
    this.destroyed = false;

    this._pendingSerial = null;
    this._preferredBufferScale = null;
    this._configured = new Promise((resolve) => {
      this._onConfigured = resolve;
    });
    this._viewport = null;
    this._fractional = null;
    this._geometry = null;
    /** the xdg-decoration object, where the compositor has the protocol (ssd.js) */
    this.decoration = null;
    /** a layer surface's role (layershell.js); null on a toplevel or popup */
    this.layer = null;
    this.layerSurface = null;
    /** the last toplevel configure named a size: maximised, tiled, mid-resize */
    this.sizeImposed = false;
    /** a popup made with `commit: false`, waiting for its map to commit */
    this._initialCommitPending = false;
    /** a popup's setup is over — its initial commit went out — and so is its
     * chance to take a grab */
    this._setupDone = false;
    /** the placement asked for before that commit, sent right after it */
    this._pendingReposition = null;
  }

  // ---- creation --------------------------------------------------------------

  /**
   * A toplevel, built without waiting for anything.
   *
   * The window is not yet usable for painting: the first buffer may only be
   * attached after the first `configure` has been acked. `configured` says
   * when, and `whenConfigured` is the promise for anyone who can wait.
   *
   * @param {object} opts
   * @param {{ manager: object, prefer: 'server'|'client' }} [opts.decorations]
   *   the `zxdg_decoration_manager_v1` proxy and which side should draw the
   *   frame; omitted where the compositor has no such protocol
   */
  static createSync({
    conn,
    compositor,
    wmBase,
    title,
    appId,
    width,
    height,
    minSize,
    maxSize,
    parent = null,
    decorations = null,
  }) {
    wirePing(wmBase);
    const surface = compositor.$.create_surface();
    const xdgSurface = wmBase.$.get_xdg_surface(surface.id);
    const toplevel = xdgSurface.$.get_toplevel();

    const win = new WaylandWindow({
      conn,
      surface,
      xdgSurface,
      role: toplevel,
      kind: 'toplevel',
      parent,
      size: {
        width: width ?? DEFAULT_SIZE.width,
        height: height ?? DEFAULT_SIZE.height,
      },
    });
    win._wireCommon();
    win._wireToplevel();

    toplevel.$.set_title(title ?? 'react-x11');
    toplevel.$.set_app_id(appId ?? 'react-x11');
    if (parent?.toplevel) toplevel.$.set_parent(parent.toplevel.id);
    if (minSize) toplevel.$.set_min_size(minSize.width | 0, minSize.height | 0);
    if (maxSize) toplevel.$.set_max_size(maxSize.width | 0, maxSize.height | 0);
    // Who draws the frame is asked before the first commit; the answer rides
    // the first configure (ssd.js).
    if (decorations?.manager) {
      win.decoration = new ServerDecoration({
        manager: decorations.manager,
        toplevel,
        prefer: decorations.prefer,
      });
    }
    // the empty commit that asks for the first configure
    surface.$.commit();
    return win;
  }

  /**
   * A layer surface — a dock, a panel, a wallpaper, an overlay — where the
   * compositor has wlr-layer-shell. The body, and the meaning of the
   * options, live in layershell.js.
   */
  static createLayerSync(opts) {
    return createLayerSurface(WaylandWindow, opts);
  }

  /**
   * A popup, positioned relative to its parent surface.
   *
   * Where an X `<popup>` places itself at screen coordinates it had to
   * learn, an `xdg_popup` describes *where it wants to be relative to the
   * parent* and how it may be adjusted, and the compositor places it. The
   * flip/slide policy react-x11's `anchor.js` implements client-side on X11
   * is exactly the positioner's constraint adjustment, so the intent
   * transfers; the math moves to the other side of the socket.
   *
   * @param {object} opts
   * @param {WaylandWindow} opts.parent the toplevel or popup this hangs off
   * @param {number} opts.x anchor point, in the parent's surface coordinates
   * @param {number} opts.y
   * @param {number} opts.width requested size
   * @param {number} opts.height
   * @param {object} [opts.grab] `{ seat, serial }` to take an implicit grab
   *   (menus: the press outside that dismisses them arrives here)
   */
  static createPopupSync({
    conn,
    compositor,
    wmBase,
    parent,
    x,
    y,
    width,
    height,
    grab = null,
    anchorRect = null,
    commit = true,
  }) {
    if (!parent?.xdgSurface && !parent?.layerSurface)
      throw new Error('a popup needs a parent window on this connection');
    wirePing(wmBase);
    const positioner = wmBase.$.create_positioner();
    const w = Math.max(1, Math.round(width || 1));
    const h = Math.max(1, Math.round(height || 1));
    positioner.$.set_size(w, h);
    if (anchorRect) {
      positioner.$.set_anchor_rect(
        Math.round(anchorRect.x),
        Math.round(anchorRect.y),
        Math.max(1, Math.round(anchorRect.width)),
        Math.max(1, Math.round(anchorRect.height)),
      );
      positioner.$.set_anchor(ANCHOR.BOTTOM_LEFT);
      positioner.$.set_gravity(ANCHOR.BOTTOM_RIGHT);
    } else {
      // A point: the popup's top-left goes at (x, y), sliding and flipping
      // to stay on screen the way `anchor.js` would have done it.
      positioner.$.set_anchor_rect(Math.round(x), Math.round(y), 1, 1);
      positioner.$.set_anchor(ANCHOR.TOP_LEFT);
      positioner.$.set_gravity(ANCHOR.BOTTOM_RIGHT);
    }
    positioner.$.set_constraint_adjustment(
      ADJUST.SLIDE_X | ADJUST.SLIDE_Y | ADJUST.FLIP_Y,
    );
    if (positioner.version >= 3) positioner.$.set_reactive();

    const surface = compositor.$.create_surface();
    const xdgSurface = wmBase.$.get_xdg_surface(surface.id);
    // A layer surface is not an xdg_surface: its popups are created with no
    // parent and adopted by the layer surface before their first commit.
    const popup = parent.xdgSurface
      ? xdgSurface.$.get_popup(parent.xdgSurface.id, positioner.id)
      : requestNullable(xdgSurface, 'get_popup', null, positioner.id);
    positioner.$.destroy();
    if (!parent.xdgSurface) parent.layerSurface.$.get_popup(popup.id);

    const win = new WaylandWindow({
      conn,
      surface,
      xdgSurface,
      role: popup,
      kind: 'popup',
      parent,
      size: { width: w, height: h },
    });
    win.x = x;
    win.y = y;
    win._wireCommon();
    popup.on('configure', (px, py, pw, ph) => {
      win.x = px;
      win.y = py;
      if (pw > 0 && ph > 0) {
        const changed = pw !== win.width || ph !== win.height;
        win.width = pw;
        win.height = ph;
        if (changed) win.emit('resize', { width: pw, height: ph });
      }
    });
    popup.on('popup_done', () => win.emit('close'));
    popup.on('repositioned', () => {});
    if (grab?.seat && grab.serial != null) {
      popup.$.grab(grab.seat.id, grab.serial);
    }
    // `commit: false` leaves the initial commit to `commitInitial()`, so a
    // grab asked for later — the tree takes it when it maps the popup — can
    // still go out ahead of it (see `takeGrab`).
    if (commit) {
      surface.$.commit();
      win._setupDone = true;
    } else {
      win._initialCommitPending = true;
    }
    return win;
  }

  // ---- events --------------------------------------------------------------

  _wireCommon() {
    this.xdgSurface?.on('configure', (serial) =>
      this._onShellConfigure(serial),
    );
    this.surface.on('preferred_buffer_scale', (scale) => {
      // Only authoritative when fractional scale is not in play.
      if (scale > 0) this._preferredBufferScale = scale;
      if (!this._fractional && scale > 0 && scale !== this.scale)
        this._setScale(scale);
    });
    this.surface.on('enter', (output) => {
      this.outputs.add(output);
      this.emit('outputs', this.outputs);
    });
    this.surface.on('leave', (output) => {
      if (this.outputs.delete(output)) this.emit('outputs', this.outputs);
    });
    this.surface.on('preferred_buffer_transform', () => {});
  }

  /**
   * The shell's configure — xdg_surface's, or the layer surface's with its
   * size already taken — holds the serial for the frame that adopts it. A
   * decoration mode that arrived with it is adopted first, so a listener
   * hears 'decorationmode' before 'configure' and paints at the new insets.
   */
  _onShellConfigure(serial) {
    this._pendingSerial = serial;
    if (this.decoration?.adopt()) {
      this.emit('decorationmode', this.decoration.mode);
    }
    const first = !this.configured;
    this.configured = true;
    if (first) this._onConfigured?.();
    this.emit('configure', {
      width: this.width,
      height: this.height,
      states: this.states,
      serial,
    });
  }

  _wireToplevel() {
    this.toplevel.on('configure', (width, height, states) => {
      // 0x0 is "pick your own" — the compositor is not imposing a size.
      this.sizeImposed = width > 0 && height > 0;
      if (width > 0 && height > 0) {
        const changed = width !== this.width || height !== this.height;
        this.width = width;
        this.height = height;
        if (changed) this.emit('resize', { width, height });
      }
      const next = decodeStates(states);
      const was = this.states;
      this.states = next;
      if (!sameSet(was, next)) this.emit('statechange', [...next]);
    });
    this.toplevel.on('close', () => this.emit('close'));
    this.toplevel.on('configure_bounds', (w, h) => {
      // The size the compositor recommends fitting in — a monitor less its
      // panels, on GNOME. 0×0 withdraws it. The closest thing this protocol
      // has to a work area, so outputs.js listens.
      this.bounds = w > 0 && h > 0 ? { width: w, height: h } : null;
      this.emit('bounds', this.bounds);
    });
    this.toplevel.on('wm_capabilities', (caps) => {
      this.wmCapabilities = decodeStates(caps);
    });
  }

  /** Attach fractional scale and a viewport, when the compositor offers them. */
  useScaling({ fractionalScaleManager, viewporter }) {
    if (viewporter && !this._viewport) {
      this._viewport = viewporter.$.get_viewport(this.surface.id);
    }
    if (fractionalScaleManager && !this._fractional) {
      this._fractional = fractionalScaleManager.$.get_fractional_scale(
        this.surface.id,
      );
      this._fractional.on('preferred_scale', (numerator) => {
        const scale = numerator / SCALE_DENOM;
        if (scale > 0 && scale !== this.scale) this._setScale(scale);
      });
    }
  }

  /**
   * The scale of the output(s) under the surface, as the last resort.
   *
   * Three sources, in order of authority: fractional-scale-v1 (a fraction,
   * per surface), `wl_surface.preferred_buffer_scale` (an integer, per
   * surface, wl_compositor 6), and this — the integer `wl_output.scale` of
   * whatever the surface has entered, which is all a compositor with neither
   * of the first two offers. Ignored the moment either of them has spoken.
   */
  noteOutputScale(scale) {
    if (this._fractional || this._preferredBufferScale != null) return;
    if (scale > 0 && scale !== this.scale) this._setScale(scale);
  }

  _setScale(scale) {
    this.scale = scale;
    this._applyScale();
    this.emit('scale', scale);
  }

  /**
   * Tell the compositor how the buffer maps onto the surface.
   *
   * With a viewport the buffer can be any size and the destination is the
   * logical size, which is how a fractional scale is expressed (a buffer
   * scale must be an integer). Without one, the buffer scale carries it.
   */
  _applyScale() {
    if (this._viewport) {
      this._viewport.$.set_destination(this.width, this.height);
      if (this.surface.version >= 3) this.surface.$.set_buffer_scale(1);
    } else if (this.surface.version >= 3) {
      this.surface.$.set_buffer_scale(Math.max(1, Math.round(this.scale)));
    }
  }

  /** The size the backing buffer has to be for the current scale. */
  get bufferWidth() {
    return Math.max(1, Math.round(this.width * this.scale));
  }

  get bufferHeight() {
    return Math.max(1, Math.round(this.height * this.scale));
  }

  /** Resolves once the first configure has arrived. */
  get whenConfigured() {
    return this._configured;
  }

  /**
   * Acknowledge the configure the next commit adopts, and record the surface
   * geometry it implies. Called by the frame that was painted at this size,
   * immediately before its commit.
   */
  ackPending() {
    if (this._pendingSerial != null) {
      (this.xdgSurface ?? this.layerSurface).$.ack_configure(
        this._pendingSerial,
      );
      this._pendingSerial = null;
    }
    const g = this._geometry;
    if (!g || g.width !== this.width || g.height !== this.height) {
      this._geometry = { width: this.width, height: this.height };
      // a layer surface has no window geometry: the surface is the window
      this.xdgSurface?.$.set_window_geometry(0, 0, this.width, this.height);
      this._applyScale();
    }
  }

  /** Who draws the frame: 'server' once a compositor has agreed to, else 'client'. */
  get decorationMode() {
    return this.decoration?.mode ?? 'client';
  }

  /** Whether the compositor has sent a configure we have not adopted yet. */
  get configurePending() {
    return this._pendingSerial != null;
  }

  // ---- frame clock ---------------------------------------------------------

  /**
   * Ask to be told when it is a good time to draw the next frame, and hand
   * back the promise that says so.
   *
   * **Call this before the frame's commit, and await it after.** A frame
   * request is only *delivered* by the next commit, so the canonical loop
   * puts the request and the buffer in the same commit. Committing
   * separately to deliver the request costs a whole refresh period — the
   * compositor takes the empty commit as the frame, and the next real one
   * lands a vblank late — which halves the frame rate with nothing in a
   * screenshot to show for it.
   *
   * The library writes a request's bytes synchronously before returning its
   * promise, so not awaiting this until after the commit is what sequences
   * the two.
   *
   * @returns {Promise<number>} the frame timestamp, in the compositor's
   *   millisecond clock
   */
  scheduleFrame() {
    if (this.destroyed) return Promise.resolve(0);
    const done = this.surface.frame().then((time) => {
      if (!this.destroyed) this.emit('frame', time);
      return time;
    });
    // The caller attaches its handlers after an await or two; a connection
    // dying in that window (process exit under Bun kills the reader thread
    // first) would otherwise surface as an unhandled rejection. Marking it
    // handled here changes nothing for a caller that does handle it.
    done.catch(() => {});
    return done;
  }

  // ---- requests ------------------------------------------------------------

  setTitle(title) {
    this.toplevel?.$.set_title(String(title ?? ''));
  }

  setAppId(appId) {
    this.toplevel?.$.set_app_id(String(appId ?? ''));
  }

  setMinSize(width, height) {
    this.toplevel?.$.set_min_size(
      Math.max(0, width | 0),
      Math.max(0, height | 0),
    );
  }

  setMaxSize(width, height) {
    this.toplevel?.$.set_max_size(
      Math.max(0, width | 0),
      Math.max(0, height | 0),
    );
  }

  setParent(parent) {
    if (!this.toplevel) return;
    // null clears the parent; nullable.js says why the plain call cannot
    requestNullable(this.toplevel, 'set_parent', parent?.toplevel ?? null);
  }

  maximize(on = true) {
    if (!this.toplevel) return;
    if (on) this.toplevel.$.set_maximized();
    else this.toplevel.$.unset_maximized();
  }

  fullscreen(on = true) {
    if (!this.toplevel) return;
    // a null output: whichever the compositor puts a fullscreen window on
    if (on) requestNullable(this.toplevel, 'set_fullscreen', null);
    else this.toplevel.$.unset_fullscreen();
  }

  minimize() {
    this.toplevel?.$.set_minimized();
  }

  /**
   * Start an interactive move or resize.
   *
   * There is no other way to move a window: the client cannot place itself,
   * so a titlebar drag is a *request* that hands the gesture to the
   * compositor, which is also why it needs the serial of the button press
   * that started it.
   */
  startMove(seatProxy, serial) {
    this.toplevel?.$.move(seatProxy.id, serial);
  }

  startResize(seatProxy, serial, edges) {
    this.toplevel?.$.resize(seatProxy.id, serial, edges);
  }

  showWindowMenu(seatProxy, serial, x, y) {
    this.toplevel?.$.show_window_menu(seatProxy.id, serial, x | 0, y | 0);
  }

  /** Reposition a popup (xdg_popup v3): a new positioner, same surface. */
  reposition(wmBase, { x, y, width, height }) {
    if (!this.popup || this.popup.version < 3) return false;
    if (this._initialCommitPending) {
      // No placement to change yet. The latest one goes out right after the
      // initial commit — where a move before the map always went out.
      this._pendingReposition = { wmBase, rect: { x, y, width, height } };
      return true;
    }
    const p = wmBase.$.create_positioner();
    p.$.set_size(
      Math.max(1, Math.round(width)),
      Math.max(1, Math.round(height)),
    );
    p.$.set_anchor_rect(Math.round(x), Math.round(y), 1, 1);
    p.$.set_anchor(ANCHOR.TOP_LEFT);
    p.$.set_gravity(ANCHOR.BOTTOM_RIGHT);
    p.$.set_constraint_adjustment(
      ADJUST.SLIDE_X | ADJUST.SLIDE_Y | ADJUST.FLIP_Y,
    );
    p.$.set_reactive();
    this.popup.$.reposition(
      p.id,
      ++this._repositionToken || (this._repositionToken = 1),
    );
    p.$.destroy();
    return true;
  }

  /**
   * A popup's explicit grab. Only possible before its initial commit: the
   * compositor finishes a popup's setup on that commit, and a grab after it
   * is `invalid_grab` — a fatal protocol error, "tried to grab after popup
   * was mapped". Every `<popup grab>` hit it while the grab rode the tree's
   * map and the commit rode creation.
   *
   * @returns {boolean} whether the grab was sent
   */
  takeGrab(seat, serial) {
    if (!this.popup || this._setupDone || this.destroyed) return false;
    this.popup.$.grab(seat.id, serial);
    return true;
  }

  /** The initial commit of a popup made with `commit: false`. */
  commitInitial() {
    if (!this._initialCommitPending || this.destroyed) return;
    this._initialCommitPending = false;
    this._setupDone = true;
    this.surface.$.commit();
    const pending = this._pendingReposition;
    if (pending) {
      this._pendingReposition = null;
      this.reposition(pending.wmBase, pending.rect);
    }
  }

  /** Whether a popup is still waiting for its initial commit. */
  get initialCommitPending() {
    return this._initialCommitPending;
  }

  /** Hide without destroying: a null buffer unmaps the surface. */
  unmap() {
    if (this.destroyed || !this.mapped) return;
    this.surface.$.attach(0, 0, 0);
    this.surface.$.commit();
    this.mapped = false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    // Order matters: the decoration before the toplevel it decorates, the
    // role before the surface it wraps.
    try {
      this.decoration?.destroy();
      this._fractional?.$.destroy?.();
      this._viewport?.$.destroy?.();
      this.role.$.destroy?.();
      this.xdgSurface?.$.destroy?.();
      this.surface.$.destroy?.();
    } catch {
      /* the connection may already be gone */
    }
    this.emit('destroyed');
  }
}

/**
 * A compositor pings to check the client is alive and kills it if it does
 * not answer. Once per `xdg_wm_base`, which is once per connection.
 */
function wirePing(wmBase) {
  if (wmBase._pingWired) return;
  wmBase._pingWired = true;
  wmBase.on('ping', (serial) => wmBase.$.pong(serial));
}

/** `xdg_toplevel.configure`'s states arrive as a wl_array of uint32. */
function decodeStates(states) {
  const out = new Set();
  if (!states) return out;
  const bytes = states instanceof Uint8Array ? states : new Uint8Array(states);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 4 <= bytes.byteLength; i += 4)
    out.add(view.getUint32(i, true));
  return out;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
