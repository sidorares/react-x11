// The pane process's "window" on the Windows backend — docs/frame.md's child
// half, with the composition engine standing in for the X server.
//
// On X11 a pane renders into a real window of its own and the host reparents
// it. There is no reparenting here, so the two processes share a **buffer**:
// the pane makes a DirectComposition surface handle, hangs a composition
// swapchain off it, and draws through the same verb table a window draws
// through; the host opens that handle and gives it to a visual of its own
// (src/win32/panehost.js). See docs/windows-embedding.md for why this rather
// than a shared DXGI texture — in one line, nothing here has to synchronise.
//
// **The present is the hand-off.** Once the host holds the handle the
// compositor scans out of whichever buffer this side presented last, so a
// frame costs no message, no fence and no copy. That is the one real
// difference from the Cocoa pane, which names a fresh IOSurface every frame;
// here `pane-present` carries the same handle every time and is therefore
// sent only when the host can be believed not to have it (`_publish`).
//
// What the node tree sees is the ordinary window contract — the Win32Window
// one, `presentFrame` and all, because a pane paints the way a window does.
// Geometry and input arrive as channel messages: the host owns layout and
// hit-testing, which is what makes this CPU offloading rather than isolation.
import { BackendContext2D } from '../backend/context2d.js';

// An id that is recognisably not an HWND, for the same reason the Cocoa pane
// has one: the ready handshake polls `windowIdOf`, which wants a number, and
// nothing on the host's side ever dereferences it. 'dc' for the composition
// device the buffer belongs to.
let nextPaneWindow = 1;
const PANE_ID_BASE = 0xdc0a0000;

/**
 * How many frames back a flip chain's back buffer is — and therefore how
 * much of the past a partial repaint has to cover.
 *
 * A flip chain does not hand out a persistent bitmap. `GetBuffer(0)` after a
 * present is the buffer that was on screen two presents ago, so a frame that
 * repaints only its own damage leaves the rest of the pane showing frame
 * N-2: every partial frame would jump two frames back and then forward
 * again. Painting this frame's damage *and* the previous frame's brings the
 * buffer current, which is the standard accumulation for a flip chain and is
 * why this number is the chain's depth rather than a tuning knob.
 *
 * Measured, not assumed: with five distinct frames presented and the fifth
 * painting only a corner, the rest of the pane came back as **frame three**.
 * The bridge's test/pane.js holds it there, because a deeper chain would
 * turn this into ghosting nobody would think to look for.
 */
const STALE_FRAMES = 2;

/** The smallest rect covering every list given, or null for "everything". */
function boundsOf(lists) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const rects of lists) {
    if (!rects) return null; // one unbounded frame makes the union unbounded
    for (const r of rects) {
      if (r.x < x0) x0 = r.x;
      if (r.y < y0) y0 = r.y;
      if (r.x + r.width > x1) x1 = r.x + r.width;
      if (r.y + r.height > y1) y1 = r.y + r.height;
    }
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export class Win32PaneWindow {
  constructor(app, attributes = {}) {
    this.app = app;
    this._native = app._native;
    this.attributes = attributes;
    this.destroyed = false;
    this.mapped = false;
    this.parent = null;
    this.cursor = null;
    this.x = 0;
    this.y = 0;
    this.title = attributes.title ?? '';

    // Device pixels on both sides of this boundary, as everywhere else on
    // this backend. The host sends its rect in logical units with the scale
    // it measured, and `setPaneSize` does the multiply.
    this.scale = app.scale ?? 1;
    this.width = Math.max(1, Math.round(attributes.width ?? 400));
    this.height = Math.max(1, Math.round(attributes.height ?? 300));

    this._handlers = {};
    this._surface = 0;
    this._gen = 0;
    this._ctx = null;
    this._reactX11Node = null;
    // The damage of the frames still standing between the back buffer and
    // now. All null to start: the buffers of a fresh swapchain hold nothing,
    // so the first frames have to be unbounded, and saying so here is what
    // makes `presentFrame`'s induction true from the very first one.
    this._recent = new Array(STALE_FRAMES - 1).fill(null);
    this._owesFull = true;
    this._drawn = false;

    this.id = PANE_ID_BASE + nextPaneWindow++;
    this.windowId = this.id;

    // The host's process, so the handle can be duplicated straight into it
    // and `paneAttach` is one step over there. A fork's parent *is* the
    // host; a pane run behind a custom transport has to say which process to
    // publish to, because `ppid` would be whatever launched the runner.
    const hostPid = app.options?.paneHostPid ?? process.ppid;
    const pane = this._native.paneCreate(this.width, this.height, hostPid);
    if (!pane) {
      throw new Error(
        'react-x11: this pane could not make a buffer to share with its ' +
          `host (pid ${hostPid}). A pane publishes frames by duplicating a ` +
          'composition surface handle into the host process, which needs ' +
          'the host to be this process’s parent — pass ' +
          '`win32: { paneHostPid }` to createRoot() if it is not.',
      );
    }
    this._pane = pane.id;
    this._handle = pane.handle;

    app._register(this);
  }

  // --- the channel-facing half ---------------------------------------------

  /**
   * The host's layout answer: the pane's size in logical units, plus the
   * scale of the display the *host* is on — which is the one that matters,
   * since these pixels are composited into the host's window.
   */
  setPaneSize(width, height, scale) {
    if (this.destroyed) return;
    if (scale) this.scale = scale;
    // The host is listening, which is the other half of `_publish`: a
    // pane-rect is the one message that arrives *after* the host has built
    // its pane view and subscribed, so it is the moment to say again which
    // buffer to show. It costs one message per resize, and it is what makes
    // a present that raced the host's subscription recoverable instead of a
    // pane that stays blank for good.
    this._publish();
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    if (!this._native.paneResize(this._pane, w, h)) return;
    // Fresh buffers, undefined contents — the same standing start the
    // constructor sets up, for the same reason.
    this._owesFull = true;
    this._recent.fill(null);
    this.emit('resize', {
      width: w,
      height: h,
      x: 0,
      y: 0,
      moved: false,
      resized: true,
    });
  }

  /** Tell the host which buffer is this pane's, once there is a frame in it.
   *  Idempotent on the far side — `Win32PaneHost.present` attaches the first
   *  time and recognises the handle every time after. */
  _publish() {
    if (this.destroyed || !this._drawn) return;
    this.app._paneSend?.({
      type: 'pane-present',
      id: this._handle,
      width: this.width,
      height: this.height,
    });
  }

  // --- the window contract -------------------------------------------------

  on(name, fn) {
    (this._handlers[name] ??= []).push(fn);
  }

  off(name, fn) {
    const list = this._handlers[name];
    if (!list) return;
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }

  emit(name, ev) {
    for (const fn of this._handlers[name] ?? []) fn(ev);
  }

  map() {
    this.mapped = true;
  }

  unmap() {
    this.mapped = false;
  }

  focus() {}

  setTitle(title) {
    this.title = title;
  }

  setSizeHints() {}

  /** The host sizes a pane, not the pane itself: a `<Frame>`'s box is laid
   *  out over there. A tree inside the pane asking to grow is answered by
   *  the size the host sends back through `setPaneSize`. */
  resize() {}

  move() {}

  grabKeyboard(options, cb) {
    cb?.(null, 0);
  }

  ungrabKeyboard() {}

  selectXI2() {
    return Promise.resolve(false);
  }

  requestAnimationFrame(cb) {
    return this.app._requestFrame(cb, this);
  }

  /** Nothing to wait for: the composition engine keeps the last presented
   *  buffer and the pane owns the next one outright, so a frame is never in
   *  flight in the sense the pacing gate means — the same answer
   *  Win32Window gives, for the same reason. */
  frameInFlight() {
    return false;
  }

  getContext() {
    if (this._ctx) return this._ctx;
    this._ctx = new BackendContext2D(
      this._native,
      () => this._surface,
      () => this._gen,
    );
    this._ctx._fonts = this.app.fonts;
    return this._ctx;
  }

  /**
   * The frame: one `BeginDraw` over the buffer, one `Present` for the lot.
   *
   * Unlike a window, a pane cannot take its damage rect by rect — a flip
   * chain hands out one whole back buffer, not a tile per update — so the
   * damage becomes a single clipped pass over the union of this frame's
   * rects and the previous frame's (see `STALE_FRAMES`). It is the union's
   * *bounding box* rather than the rects themselves, because a second pass
   * over a pixel a first pass already painted composites onto it twice, and
   * a translucent node painted twice is the wrong colour.
   */
  presentFrame(node, damage) {
    if (this.destroyed) return;
    if (process.env.REACT_X11_WIN32_FULL_REPAINT === '1') damage = null;
    if (this._owesFull) {
      this._owesFull = false;
      damage = null;
    }
    const rect = boundsOf([damage, ...this._recent]);
    this._recent.unshift(damage);
    this._recent.length = STALE_FRAMES - 1;

    const surface = this._native.paneBeginDraw(this._pane);
    if (!surface) return;
    this._surface = surface;
    this._gen++;
    try {
      // `_paintRegion` clips to the rect it is given, so the pass is bounded
      // by exactly what it was handed; a null rect is the whole pane.
      node._paintRegion(this.getContext(), rect, this.width, this.height);
    } finally {
      this._surface = 0;
      this._native.paneEndDraw(this._pane);
    }
    if (!this._drawn) {
      this._drawn = true;
      this._publish();
    }
  }

  /**
   * No scroll blit. The fast path moves a band of pixels *within the surface
   * being drawn into*, and this one is `STALE_FRAMES` frames behind — the
   * band it would move is the wrong picture, shifted. Answering false is not
   * a gap: the frame falls back to repainting the scrolled region, which is
   * what the union pass above does anyway.
   */
  scrollRegion() {
    return false;
  }

  present() {
    // Nothing to flip: presentFrame presented. Kept because the frame loop
    // calls it on every window it paced.
  }

  snapshot() {
    return false; // no window of our own; the host's is where these show
  }

  /**
   * What another process embeds to show this window — `windowHandleOf`'s
   * answer here (src/windowid.js).
   *
   * On X11 that is the window's own id, because an XID means the same thing
   * in every process on the display. Windows has no such number: a window
   * cannot be embedded at all, because a composition target stops presenting
   * the moment its window becomes a child (docs/windows-embedding.md, with
   * the measurements). What crosses instead is the **buffer** — the same
   * composition surface handle a `<Frame>` pane publishes — and the host
   * binds it to a visual of its own rather than reparenting anything.
   *
   * The handle is already valid in the host process: it was duplicated there
   * when the pane was made. Which host that is, is `paneHostPid` — the
   * parent by default, because a host starts its guest.
   */
  embedHandle() {
    return this.destroyed ? null : this._handle;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._native.paneDestroy(this._pane);
    this.app._unregister(this);
  }

  /** The union collapses to one box, so a longer damage list buys a tighter
   *  bound and never another pass. Sixteen is the window's, kept so the two
   *  paths are handed the same lists. */
  get damageRectCap() {
    return 16;
  }
}
