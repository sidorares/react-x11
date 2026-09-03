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
// layout and hit-testing — this is CPU offloading, not isolation), and the
// only outbound traffic is pane-present.
import { CocoaContext2D } from './context2d.js';

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
    this.width = Math.max(
      1,
      Math.round((attributes.width ?? 400) * this.scale),
    );
    this.height = Math.max(
      1,
      Math.round((attributes.height ?? 300) * this.scale),
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
    this._reactX11Node = null;
    app._registerWindow(this);
  }

  // --- the channel-facing half --------------------------------------------

  /** The host's layout answer: logical size plus the display scale. */
  setPaneSize(width, height, scale) {
    if (this.destroyed) return;
    if (scale) this.scale = scale;
    const w = Math.max(1, Math.round(width * this.scale));
    const h = Math.max(1, Math.round(height * this.scale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.emit('resize', {
      width: w,
      height: h,
      x: 0,
      y: 0,
      moved: false,
      resized: true,
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

  requestAnimationFrame(cb) {
    return this.app._requestFrame(cb);
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

  _ensureSurface() {
    const w = this.width;
    const h = this.height;
    if (
      !this._ring ||
      this._surfaceSize?.width !== w ||
      this._surfaceSize?.height !== h
    ) {
      const hadSurface = Boolean(this._ring);
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
      this._ctx = new CocoaContext2D(
        this._native,
        () => this._ensureSurface(),
        () => {
          this._ensureSurface();
          return this._surfaceGen;
        },
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
    const damage = this._flushDamage;
    this._flushDamage = null;
    this.app._paneSend?.({
      type: 'pane-present',
      seq: ++this._seq,
      id: shown.iosurfaceId,
      width: this.width,
      height: this.height,
    });
    this._presentedAt = performance.now();
    this._shownIndex = this._drawIndex;
    // the next buffer round the ring — two behind what the host will be
    // showing, so it is safe to write even before the host has switched
    this._drawIndex = (this._drawIndex + 1) % CocoaPaneWindow.RING;
    const next = this._ring[this._drawIndex];
    this._surface = next.handle;
    this._surfaceGen++;
    this._native.surfaceLock(next.handle);
    // A full-repaint frame overwrites everything next, so no catch-up is
    // needed. A partial frame paints only its damage, so `next` must first
    // hold the last complete frame underneath — and the WHOLE of it, not
    // just this frame's rects, because in a three-buffer ring `next` was
    // last drawn two presents ago and is stale everywhere. A full copy of
    // the just-shown buffer is the complete background; the safe target is
    // what triple buffering buys.
    if (damage !== 'full' && damage) {
      this._native.copySurfaceRegion(shown.handle, next.handle, null);
    }
  }

  snapshot() {
    return false; // no window of our own to capture; the host's shows it
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.app._unregisterWindow(this);
    this._ring = null;
    this._surface = null;
  }
}
