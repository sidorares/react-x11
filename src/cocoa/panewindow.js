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

// How long a pane counts on the host's `pane-shown` for a present before it
// stops waiting for one (`_answerOverdue`). A host that is only busy answers
// well inside it — in the browser example on a Mac, a present was looked up
// under a millisecond after it went at the median, and 180ms after at
// worst, the host laying out a page at each width of a drag on its first
// run — and one that never answers, a host stalled or gone, must not stop
// the pane drawing.
const ANSWER_TIMEOUT_MS = 250;

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
    // the window's own frame clock (`CocoaApp._frameDue`), at the app's
    // interval: a pane has no display of its own to pace by
    this._rafLast = 0;
    // The newest present the host has looked up (`pane-shown`), and the
    // buffers of retired rings still named by a present it has not: freed
    // as it does (`_releaseRing`).
    this._shownSeq = 0;
    this._shownAt = -Infinity;
    // what it had looked up before its latest answers, whose buffer the
    // screen may still show (`_takeBack`)
    this._shownBefore = 0;
    this._pollTimer = null;
    this._kickQueued = false;
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

  /** On this window's clock, which the clock asks before it runs a frame
   *  (`frameHeld`). */
  requestAnimationFrame(cb) {
    return this.app._requestFrame(cb, this);
  }

  /** A `<glarea>`'s frame, after this pane's own (`CocoaWindow`'s). */
  requestSurfaceFrame(cb) {
    return this.app._requestFrame(cb, null, true);
  }

  /** The clock's period (`CocoaApp._frameDue`): the app's, a pane having no
   *  display of its own. */
  get _frameInterval() {
    return this.app.frameIntervalFor(null);
  }

  /** What is on glass is the host's to know; a pane draws what it is
   *  asked to (`CocoaApp._tickFrames`). */
  _visible() {
    return true;
  }

  /**
   * Whether the host may still be showing the frame before the last one —
   * the gate `flushPendingFrames` (src/frames.js) is written around: a
   * discrete input paints on the spot only when the last frame has landed,
   * which is what folds a burst into one paced frame instead of a frame per
   * event. Without a gate here every message the host queued while the
   * pane was busy was answered with a full frame of its own: a forty-tick
   * resize of a pane whose frame costs 300ms stepped through forty sizes
   * for twelve seconds after the drag had ended, each one the previous
   * surface stretched to the layer.
   *
   * On X11 the server says when a present was shown. Here the host says
   * when it has looked one up (`pane-shown`), which is half of it: the host
   * commits on its own thread and the screen shows the frame at the
   * refresh after. So a present is in flight until it is answered, and for
   * a frame interval after it went: measured in the browser example on a
   * 120Hz panel, the answer alone answered an input 4ms sooner, and gave
   * input faster than the display a frame each — 245 a second at 250
   * inputs a second, 355 at 1000 — where the interval keeps it at 118, and
   * the frames that outran the WindowServer drew into buffers it still
   * read. Nothing the pane can ask says when a frame is on glass: a buffer
   * reads in use from the host's lookup, not from the refresh. And no frame
   * is drawn while one is held (`frameHeld`), whatever asks.
   */
  frameInFlight() {
    if (this.frameHeld()) return true;
    if (this._seq > this._shownSeq && !this._answerOverdue()) return true;
    return (
      performance.now() - this._presentedAt < this.app.frameIntervalFor(null)
    );
  }

  /**
   * Whether this pane's next frame has no buffer to go into, which holds it
   * on the clock (`CocoaApp._tickFrames`): every buffer but the one it last
   * presented is named by a present the host is showing or has yet to look
   * up, or the host is done with one and the WindowServer is still reading
   * it. A frame drawn into one of those anyway was a frame half drawn on
   * glass — the host showed the buffer the pane was drawing into, or looked
   * it up after the pane had started, and showed that.
   *
   * The second is the host coming back from a long frame of its own. Its
   * answers say it has looked the queued presents up, not that they are on
   * glass: that is its UI thread's commit and the refresh after, and until
   * then the buffer it showed all along is still what the screen shows —
   * and which buffer that is, the answers cannot say, since a host that
   * stalled between a lookup and its commit left the one before on glass.
   * The WindowServer can: a buffer is taken once it has let go of one, which
   * is asked every millisecond (`_pollHeld`), and for a frame interval after
   * the host's answer at most, since it reads a buffer it no longer shows
   * for as long as it likes and a pane must not wait on that.
   *
   * A new size is never held: it draws into a new ring, which nothing
   * names. Nor is a host that stopped answering (`_answerOverdue`).
   */
  frameHeld() {
    if (!this._ring || this._surface) return false;
    if (
      this._surfaceSize?.width !== this.width ||
      this._surfaceSize?.height !== this.height
    ) {
      return false;
    }
    let done = false;
    for (let i = 0; i < this._ring.length; i += 1) {
      const s = this._ring[i];
      if (i === this._shownIndex || !this._done(s)) continue;
      if (!this._held(s)) return false;
      done = true;
    }
    if (!done) return !this._answerOverdue();
    const wait =
      this._shownAt + this.app.frameIntervalFor(null) - performance.now();
    if (!(wait > 0)) return false;
    this._pollHeld();
    return true;
  }

  /**
   * Ask again in a millisecond whether the WindowServer has let go of a
   * buffer (`frameHeld`): it says so by no event, and the pump's next tick
   * is up to 8ms off — a frame held that long for a buffer let go of a
   * millisecond later was a frame late.
   */
  _pollHeld() {
    if (this._pollTimer) return;
    this._pollTimer = setTimeout(() => {
      this._pollTimer = null;
      const app = this.app;
      if (!this.destroyed && app._rafQueue.some((e) => e.wnd === this)) {
        app._tickFrames();
        app._presentAll();
      }
    }, 1);
    this._pollTimer.unref?.();
  }

  /** Whether the host has looked up a present after the last one that named
   *  `buffer`, or none ever did: nothing will show it again. */
  _done(buffer) {
    return !buffer.presentedSeq || buffer.presentedSeq < this._shownSeq;
  }

  /** A present the host has not answered for longer than it would if it
   *  were answering at all (`ANSWER_TIMEOUT_MS`). */
  _answerOverdue() {
    return (
      this._seq > this._shownSeq &&
      performance.now() - this._presentedAt >= ANSWER_TIMEOUT_MS
    );
  }

  // Three buffers, not two. A pane is cross-process: the host keeps
  // scanning the last buffer it was handed until it processes the next
  // present message. With two buffers the next paint (and the catch-up
  // copy) lands in the very buffer the host is still displaying — every
  // present tears it, the flash. With three, one present may be on its way
  // while the next frame draws: the buffer the host shows, the one the
  // present on its way names, and the one the host has let go of. A host
  // two presents behind leaves none, and the frame waits for its answer
  // (`frameHeld`, `_takeBack`). Same-process windows need only two because
  // Core Animation latches the front buffer.
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
    // the first of a run of answers: what was looked up before it
    if (!this._kickQueued) this._shownBefore = this._shownSeq;
    this._shownSeq = seq;
    this._shownAt = performance.now();
    if (this._retired.length > 0) {
      const release = this._native.releaseSurface;
      this._retired = this._retired.filter((s) => {
        if (s.presentedSeq > seq) return true;
        release.call(this._native, s.handle);
        return false;
      });
    }
    // A frame the clock held for want of a buffer (`frameHeld`) goes now,
    // not on the next pump tick — once every answer that came with this one
    // is in. A host back from a long frame answers a run of presents at
    // once, the channel hands them over in one turn, and a frame run on the
    // first found only the buffer the host had shown all along.
    if (this._kickQueued) return;
    this._kickQueued = true;
    queueMicrotask(() => {
      this._kickQueued = false;
      const app = this.app;
      if (!this.destroyed && app._rafQueue.some((e) => e.wnd === this)) {
        app._tickFrames();
        app._presentAll();
      }
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
    } else if (!this._surface) {
      this._takeBack();
    }
    return this._surface;
  }

  /**
   * The buffer the frame about to be drawn goes into, taken at its first
   * draw rather than at the present before it, so the host has had as long
   * as it can to answer — CocoaWindow's `_takeBack`, over a ring the host
   * reads from another process.
   *
   * One the host is done with (`_done`): a present after the last one that
   * named it has been looked up, so it is neither on the layer nor on its
   * way there. Of those, one the WindowServer has let go of as well —
   * `surfaceIsInUse` false: it reads a buffer for a refresh or two after
   * the layer has another, 8ms after the pane hears the answer at the
   * median and 22 at the 90th percentile in the browser example — and of
   * those the one presented longest ago. The clock holds a frame that would
   * find none (`frameHeld`). One that comes anyway, once the WindowServer
   * has held on for a frame interval, takes one it still reads — but the
   * one the screen showed before the host's latest answers last, which a
   * host back from a long frame has yet to commit the replacement for; and
   * once the host is overdue, it takes a buffer whose present the host has
   * yet to look up
   * rather than the one on the layer: a host that comes back looks up
   * everything queued in one turn, and only the last of it reaches glass,
   * where the buffer on the layer is on glass now.
   *
   * Then the frame just presented, copied across whole: in a ring of three
   * the buffer taken was last drawn two presents ago or more, and is stale
   * everywhere. After a full frame as much as a partial one: what a frame
   * was says nothing of what the next will be, and skipping the copy there
   * had a partial frame after a full one — a status line, a hover's
   * underline — drawn over the page as it was two frames back. The copy is
   * wasted only where the next frame is full as well.
   */
  _takeBack() {
    const ring = this._ring;
    const last = ring[this._shownIndex];
    let pick = -1;
    let rank = Infinity;
    for (let i = 0; i < ring.length; i += 1) {
      const s = ring[i];
      if (s === last) continue;
      // done and let go of, then done, then on its way, then on the layer:
      // the oldest of the best — but of the done, the one the screen showed
      // before the host's latest answers last
      const kind = this._done(s)
        ? this._held(s)
          ? 1 + Number(s.presentedSeq === this._shownBefore)
          : 0
        : s.presentedSeq > this._shownSeq
          ? 3
          : 4;
      const r = kind * 2 ** 32 + (s.presentedSeq ?? 0);
      if (r < rank) {
        rank = r;
        pick = i;
      }
    }
    const back = ring[pick];
    this._drawIndex = pick;
    this._surface = back.handle;
    // a different native surface owns the graphics state now — the context
    // re-syncs its sticky state off the generation
    this._surfaceGen++;
    this._native.surfaceLock(back.handle);
    if (last) this._native.copySurfaceRegion(last.handle, back.handle, null);
  }

  /** Whether the WindowServer still reads `buffer`: `IOSurfaceIsInUse`,
   *  which counts the host's render server from this process too. A bridge
   *  that cannot say (before 0.10) is answered no. */
  _held(buffer) {
    const inUse = this._native.surfaceIsInUse;
    return (
      typeof inUse === 'function' &&
      inUse.call(this._native, buffer.handle) === true
    );
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
    if (!this._ring) return false;
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) return false;
    // the frame's first draw, which takes its buffer (`_takeBack`)
    const surface = this._ensureSurface();
    const moved = this._native.scrollSurface(
      surface,
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
    // the buffer is named in the channel until the host says otherwise
    // (`_releaseRing`, `_done`)
    shown.presentedSeq = ++this._seq;
    this._presentedAt = performance.now();
    this._shownIndex = this._drawIndex;
    // the next frame takes its buffer when it draws (`_takeBack`)
    this._drawIndex = -1;
    this._surface = null;
    // last: the answer runs a held frame (`_shown`), which must find this
    // present made
    this._post({
      type: 'pane-present',
      seq: this._seq,
      id: shown.iosurfaceId,
      width: this.width,
      height: this.height,
    });
  }

  snapshot() {
    return false; // no window of our own to capture; the host's shows it
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.app._unregisterWindow(this);
    clearTimeout(this._pollTimer);
    this._pollTimer = null;
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
