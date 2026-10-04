// The pane process's "window" on the Cocoa backend — docs/frame.md's child
// half, with the X server replaced by shared memory.
//
// On X11 a pane renders into a real window of its own and the host embeds
// it; here there is no server to share, so the pane paints into IOSurfaces
// created shared (kIOSurfaceIsGlobal) and presents by message: the host
// looks the id up and points the pane's sublayer at it. Same swapchain
// discipline as CocoaWindow — draw into back, flip, catch the new back up
// by the damage — because the host's WindowServer reads the shown buffer
// asynchronously either way.
//
// What the node tree sees is the ordinary window contract: getContext,
// present, scrollRegion, noteFrameDamage, requestAnimationFrame, events
// via emit. Geometry and input arrive as channel messages (the host owns
// layout and hit-testing — this is CPU offloading, not isolation), and what
// goes out is pane-present, and pane-cursor for the cursor the host shows.
//
// Every other window the pane's tree makes — a menu, a dropdown's sheet, a
// tooltip, a dialog — is a `CocoaPaneSubwindow`: the same ring and the same
// presents, naming the window, and an NSWindow the host makes for it
// (src/cocoa/panehost.js), because nothing in a pane process runs AppKit.
import { BackendContext2D } from '../backend/context2d.js';

let nextPaneId = 1;

export class CocoaPaneWindow {
  constructor(app, attributes = {}) {
    this.app = app;
    this._native = app._native;
    this.destroyed = false;
    // a real-looking id so the shared ready/handshake path (which polls
    // windowIdOf) fires; the host on this backend never dereferences it
    this.windowId = 0xc0c0a000 + nextPaneId++;
    // windowIdOf reads `.id` (the ntk Window field) — the ready handshake
    // polls it through the pane's ref, so both spellings answer
    this.id = this.windowId;
    this.windowNumber = this.windowId;
    this.scale = app.scale ?? 2;
    // Device pixels, as every window's attributes are (`windowAttributes`
    // multiplies the props through once): the size the pane is born at,
    // until the host's first pane-rect says what it is. Multiplied again
    // here, a pane was born twice its size, and a dialog it opened in its
    // first commit was centred over a window that was never there.
    this.width = Math.max(1, Math.round(attributes.width ?? 400 * this.scale));
    this.height = Math.max(
      1,
      Math.round(attributes.height ?? 300 * this.scale),
    );
    this._listeners = new Map();
    this._surface = null;
    this._surfaceGen = 0;
    this._surfaceSize = null;
    this._ring = null;
    this._drawIndex = 0;
    this._shownIndex = -1;
    this._ctx = null;
    this._dirty = false;
    this._flushDamage = 'full';
    this._seq = 0;
    this._presentedAt = -Infinity;
    // The newest present the host has looked up (`pane-shown`), and the
    // buffers of retired rings still named by a present it has not: freed
    // as it does (`_releaseRing`).
    this._shownSeq = 0;
    this._retired = [];
    this._reactX11Node = null;
    // Where the pane's corner is on the screen, in device pixels, as the
    // host last said (`setPaneSize`): what a popup the pane anchors to one
    // of its nodes is placed against (`windowOrigin`, src/anchor.js). The
    // pane has no window of its own to ask, so until the host says, a menu
    // dropped from the screen's corner.
    this.x = 0;
    this.y = 0;
    this._screenOrigin = { x: 0, y: 0 };
    // what the app's window map keys this window by, and the id the host
    // names it by in a pane-event (`CocoaApp.attachPaneChannel`)
    this._key = this.windowId;
    app._registerWindow(this);
  }

  // --- the channel-facing half --------------------------------------------

  /**
   * The host's layout answer: logical size plus the display scale, and
   * where the pane is on the screen — `screen`, device pixels, absent from
   * a host that does not say. A move alone is a `resize` that `moved`, the
   * event a window's own move is, so what is anchored here follows it.
   */
  setPaneSize(width, height, scale, screen) {
    if (this.destroyed) return;
    if (scale) this.scale = scale;
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    const moved =
      screen != null && (screen.x !== this.x || screen.y !== this.y);
    const resized = w !== this.width || h !== this.height;
    if (!moved && !resized) return;
    if (moved) {
      this.x = screen.x;
      this.y = screen.y;
      this._screenOrigin = { x: screen.x, y: screen.y };
    }
    this.width = w;
    this.height = h;
    this.emit('resize', {
      width: w,
      height: h,
      x: this.x,
      y: this.y,
      moved,
      resized,
    });
  }

  // --- the window contract -------------------------------------------------

  on(name, fn) {
    let set = this._listeners.get(name);
    if (!set) this._listeners.set(name, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(name, ev) {
    for (const fn of [...(this._listeners.get(name) ?? [])]) fn(ev);
  }

  map() {}

  focus() {}

  setTitle() {}

  /**
   * The cursor this pane's tree names, sent to the host. A pane has no
   * window the pointer is over — the host's window is — so the host shows
   * it (`<Frame>`'s pane box, src/frame/index.js). Core asks only when the
   * cursor changes, so this is a message per change, not per motion.
   */
  setCursor(name) {
    if (this.destroyed) return;
    this._post({ type: 'pane-cursor', cursor: name ?? null });
  }

  /** A message about this window, to the host. The pane's own names none:
   * the host knows it as the pane (`CocoaPaneSubwindow` names itself). */
  _post(msg) {
    this.app._paneSend?.(msg);
  }

  requestAnimationFrame(cb) {
    return this.app._requestFrame(cb);
  }

  /** A `<glarea>`'s frame, after this pane's own (`CocoaWindow`'s). */
  requestSurfaceFrame(cb) {
    return this.app._requestFrame(cb, null, true);
  }

  /**
   * Whether the host may still be showing the frame before the last one —
   * the gate `flushPendingFrames` (src/frames.js) is written around: a
   * discrete input paints on the spot only when the last frame has landed,
   * which is what folds a burst into one paced frame instead of a frame per
   * event. On X11 the server says when a present was shown; a pane hears
   * nothing back from the host, which flips the layer on its next pump tick
   * and has Core Animation scan it out at the following refresh — so a
   * present counts as in flight for one frame interval. Without a gate here
   * every message the host queued while the pane was busy was answered
   * with a full frame of its own: a forty-tick resize of a pane whose frame
   * costs 300ms stepped through forty sizes for twelve seconds after the
   * drag had ended, each one the previous surface stretched to the layer.
   */
  frameInFlight() {
    return (
      performance.now() - this._presentedAt < this.app.frameIntervalFor(null)
    );
  }

  // Three buffers, not two. A pane is cross-process: the host keeps
  // scanning the last buffer it was handed until it processes the next
  // present message, and nothing here waits for that. With two buffers the
  // next paint (and the catch-up copy) lands in the very buffer the host is
  // still displaying — every present tears it, the flash. A third buffer is
  // always at least two presents behind what the host shows, so the pane
  // never writes a buffer the host might still be reading. Same-process
  // windows need only two because Core Animation latches the front buffer.
  static RING = 3;

  /**
   * Free the ring now, not when V8 collects the handles — CocoaWindow's
   * `_releaseBacking`, for three buffers instead of two: a host window
   * drag resizes the pane a tick at a time, and each tick retires a ring
   * that the finalizer would have held until a collection happened to run.
   * The host keeps its own reference to whichever buffer its layer shows,
   * so the frame on glass survives the free.
   *
   * All but a buffer a present names that the host has not looked up yet.
   * The host finds a buffer by its IOSurface id, and the system hands a
   * freed id to the next surface anyone makes — the three this ring's
   * successor is about to make, the ring of another pane resized in the
   * same layout, the host's own window. A present still in the channel
   * named the id, not the surface, so the host scanned out whatever had it
   * by the time it looked: a frame of this pane's next ring, cleared or
   * half drawn, or another tab's page, for a frame at every few steps of a
   * drag. So that buffer is kept (`_retired`) until the host says it has
   * looked it up (`pane-shown`, `_shown`), and only then freed: its id
   * stays its own until nothing can ask for it. That is the buffers of
   * the presents in flight — one, as a rule, since a present goes a frame
   * at a time and the host answers on its next turn — and never more than
   * a ring's worth: a host that stops answering has the oldest freed
   * anyway, the one it is likeliest to have looked up already.
   *
   * Bridges before 0.4 have no `releaseSurface`; there the finalizer is
   * still the only owner, and this is the drop it always was.
   */
  _releaseRing() {
    const ring = this._ring;
    this._ring = null;
    this._surface = null;
    if (!ring) return;
    const release = this._native.releaseSurface;
    if (typeof release !== 'function') return;
    for (const s of ring) {
      if (s.presentedSeq > this._shownSeq) this._retired.push(s);
      else release.call(this._native, s.handle);
    }
    while (this._retired.length > CocoaPaneWindow.RING) {
      release.call(this._native, this._retired.shift().handle);
    }
  }

  /**
   * The host has looked up every present up to `seq` (`pane-shown`): the
   * retired buffers they named are its now, or nobody's, and go.
   */
  _shown(seq) {
    if (!(seq > this._shownSeq)) return;
    this._shownSeq = seq;
    if (this._retired.length === 0) return;
    const release = this._native.releaseSurface;
    this._retired = this._retired.filter((s) => {
      if (s.presentedSeq > seq) return true;
      release.call(this._native, s.handle);
      return false;
    });
  }

  /** Every retired buffer, answered or not: the window is going, and so is
   *  the layer the host showed it on. */
  _releaseRetired() {
    const retired = this._retired;
    this._retired = [];
    const release = this._native.releaseSurface;
    if (typeof release !== 'function') return;
    for (const s of retired) release.call(this._native, s.handle);
  }

  _ensureSurface() {
    const w = this.width;
    const h = this.height;
    if (
      !this._ring ||
      this._surfaceSize?.width !== w ||
      this._surfaceSize?.height !== h
    ) {
      const hadSurface = Boolean(this._ring);
      this._releaseRing();
      this._ring = [];
      for (let i = 0; i < CocoaPaneWindow.RING; i += 1) {
        const s = this._native.createSurfaceIOSurface(w, h, this.scale, true);
        this._native.ctxClearRect(s.handle, 0, 0, w, h);
        this._ring.push(s);
      }
      this._drawIndex = 0;
      this._shownIndex = -1;
      this._native.surfaceLock(this._ring[0].handle);
      this._surface = this._ring[0].handle;
      this._surfaceSize = { width: w, height: h };
      this._surfaceGen++;
      this._flushDamage = 'full';
      // decided when the flush reports its rects — see CocoaWindow's
      // `_ensureSurface` for why not a queued full frame from here
      if (hadSurface) this._freshSurface = true;
    }
    return this._surface;
  }

  getContext() {
    if (!this._ctx) {
      this._ctx = new BackendContext2D(
        this._native,
        () => this._ensureSurface(),
        () => {
          this._ensureSurface();
          return this._surfaceGen;
        },
        // a CPU bitmap: a rounded box keeps its corners by reading it back
        { readback: true },
      );
      this._ctx._fonts = this.app.fonts;
      this._ctx._onDirty = () => {
        this._dirty = true;
      };
    }
    return this._ctx;
  }

  noteFrameDamage(rects) {
    if (this._freshSurface) {
      this._freshSurface = false;
      // a bounded flush onto a fresh ring leaves garbage outside its rects:
      // one full frame, and no present until it lands (CocoaWindow's rule)
      if (rects) {
        this._holdPresent = true;
        const node = this._reactX11Node;
        if (node && !node.destroyed) node.invalidate(false, null, 'resize');
      } else {
        this._holdPresent = false;
      }
    } else if (!rects) {
      this._holdPresent = false;
    }
    if (this._flushDamage === 'full') return;
    if (!rects) {
      this._flushDamage = 'full';
      return;
    }
    (this._flushDamage ??= []).push(...rects);
  }

  scrollRegion(rect, dx, dy) {
    if (!this._surface) return false;
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) return false;
    const moved = this._native.scrollSurface(
      this._surface,
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height),
      dx,
      dy,
    );
    if (moved) this._dirty = true;
    return Boolean(moved);
  }

  /** Flip and tell the host, instead of touching any layer of our own. */
  present() {
    if (!this._dirty || !this._ring || this.destroyed) return;
    if (this._holdPresent) return;
    this._dirty = false;
    const shown = this._ring[this._drawIndex];
    this._native.surfaceUnlock(shown.handle);
    this._flushDamage = null;
    this._post({
      type: 'pane-present',
      seq: ++this._seq,
      id: shown.iosurfaceId,
      width: this.width,
      height: this.height,
    });
    // the buffer is named in the channel until the host says otherwise
    // (`_releaseRing`)
    shown.presentedSeq = this._seq;
    this._presentedAt = performance.now();
    this._shownIndex = this._drawIndex;
    // the next buffer round the ring — two behind what the host will be
    // showing, so it is safe to write even before the host has switched
    this._drawIndex = (this._drawIndex + 1) % CocoaPaneWindow.RING;
    const next = this._ring[this._drawIndex];
    this._surface = next.handle;
    this._surfaceGen++;
    this._native.surfaceLock(next.handle);
    // The next frame may paint only its damage, so `next` must first hold
    // the last complete frame underneath — and the WHOLE of it, not just
    // this frame's rects, because in a three-buffer ring `next` was last
    // drawn two presents ago and is stale everywhere. A full copy of the
    // just-shown buffer is the complete background; the safe target is what
    // triple buffering buys. After a full frame as much as a partial one:
    // what a frame was says nothing of what the next will be, and skipping
    // the copy there had a partial frame after a full one — a status line,
    // a hover's underline — drawn over the page as it was two frames back.
    // The copy is wasted only where the next frame is full as well.
    this._native.copySurfaceRegion(shown.handle, next.handle, null);
  }

  snapshot() {
    return false; // no window of our own to capture; the host's shows it
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.app._unregisterWindow(this);
    this._releaseRing();
    this._releaseRetired();
  }
}

/**
 * Any other window a pane's tree makes: a `<popup>` — a menu, a dropdown's
 * sheet, a tooltip, the edit menu — or a managed one, a dialog (#824).
 *
 * A pane process runs no AppKit (`CocoaApp.start`): no NSApplication, no
 * event pump. An NSWindow made here exists and is never shown, so a
 * `<Select>` in a pane took the press, opened, and showed nothing. This
 * window paints into a shared ring exactly as the pane does, and the host
 * makes the NSWindow and shows the ring in it (`CocoaPaneHost`,
 * src/cocoa/panehost.js) — the split the pane already has: the pane draws,
 * the host owns glass and input.
 *
 * Its place is the pane's to decide and the host's to take as given: `x`
 * and `y` are the screen position the pane's own anchoring worked out,
 * against the origin the host sends with every pane-rect. What goes out is
 * the window's life as `pane-window` messages and its frames as
 * `pane-present`s naming it; what comes back is the input on the host's
 * window, as `pane-event`s naming it, and for a managed window the moves
 * and the resizes the user made and the close button.
 */
export class CocoaPaneSubwindow extends CocoaPaneWindow {
  constructor(app, attributes = {}) {
    super(app, attributes);
    this.attributes = attributes;
    this._popup = attributes.overrideRedirect === true;
    this.mapped = false;
    // device pixels, as every window's attributes are — unlike the pane's
    // own, whose size is the host's to say
    const size = this.snapSize(attributes.width ?? 1, attributes.height ?? 1);
    this.width = size.width;
    this.height = size.height;
    this.x = Math.round(attributes.x ?? 0);
    this.y = Math.round(attributes.y ?? 0);
    this._screenOrigin = { x: this.x, y: this.y };
    this._send({
      op: 'create',
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      popup: this._popup,
      // an ARGB visual is a transparent window here, as in `CocoaWindow`
      transparent:
        attributes.visual !== undefined || Boolean(attributes.transparent),
      grabKeyboard: attributes.grabKeyboard === true,
      dragPreview: Boolean(attributes.dragPreview),
      title: attributes.title ?? '',
      decorations: attributes.decorations,
      resizable: attributes.resizable,
      sizeHints: attributes.sizeHints,
    });
  }

  /** Named, and held until the host is listening (`CocoaApp._postWindow`). */
  _post(msg) {
    this.app._postWindow({ ...msg, window: this.windowId });
  }

  _send(msg) {
    if (this.destroyed) return;
    this._post({ type: 'pane-window', ...msg });
  }

  /** `CocoaWindow`'s rule, so the size this window records is the size the
   * host's NSWindow will take: whole points, rounded up. */
  snapSize(width, height) {
    const s = this.scale;
    const up = (v) =>
      Math.max(1, Math.ceil(Math.max(1, Math.round(v)) / s) * s);
    return { width: up(width), height: up(height) };
  }

  map() {
    this.mapped = true;
    this._send({ op: 'map' });
  }

  unmap() {
    this.mapped = false;
    this._send({ op: 'unmap' });
  }

  move(x, y) {
    this.x = Math.round(x);
    this.y = Math.round(y);
    this._screenOrigin = { x: this.x, y: this.y };
    this._send({ op: 'move', x: this.x, y: this.y });
  }

  resize(width, height) {
    const size = this.snapSize(width, height);
    this.width = size.width;
    this.height = size.height;
    this._send({ op: 'resize', width: this.width, height: this.height });
  }

  setTitle(title) {
    this._send({ op: 'title', title: String(title ?? '') });
  }

  setSizeHints(hints = {}) {
    this._send({ op: 'size-hints', hints: { ...hints } });
  }

  /** The grab is the host's: a press anywhere in its windows comes here,
   * outside this window, which is the dismissal (`CocoaApp._grabTarget`). */
  grabPointer(options, cb) {
    this._send({ op: 'grab' });
    cb?.(null, 0);
  }

  ungrabPointer() {
    this._send({ op: 'ungrab' });
  }

  /**
   * Where the host's window went for a reason of its own — the user moved a
   * dialog, or resized it — which a `resize` here says as a window's own
   * move or resize does. A size comes only from the user (`resized`): the
   * pane's own resizes come back as the host's echo, and one taken as news
   * would read as the user taking an `'auto'` window over.
   */
  _hostGeometry(ev) {
    if (this.destroyed) return;
    const moved = ev.x !== this.x || ev.y !== this.y;
    const resized =
      Boolean(ev.resized) &&
      (ev.width !== this.width || ev.height !== this.height);
    if (!moved && !resized) return;
    this.x = ev.x;
    this.y = ev.y;
    this._screenOrigin = { x: ev.x, y: ev.y };
    if (resized) {
      this.width = ev.width;
      this.height = ev.height;
    }
    this.emit('resize', {
      width: this.width,
      height: this.height,
      x: this.x,
      y: this.y,
      moved,
      resized,
    });
  }

  destroy() {
    if (this.destroyed) return;
    this._send({ op: 'destroy' });
    super.destroy();
  }
}
