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
    this._chain = null;
    this._ctx = null;
    this._dirty = false;
    this._flushDamage = 'full';
    this._seq = 0;
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

  frameInFlight() {
    return false;
  }

  _ensureSurface() {
    const w = this.width;
    const h = this.height;
    if (
      !this._surface ||
      this._surfaceSize?.width !== w ||
      this._surfaceSize?.height !== h
    ) {
      const hadSurface = Boolean(this._surface);
      const a = this._native.createSurfaceIOSurface(w, h, this.scale, true);
      const b = this._native.createSurfaceIOSurface(w, h, this.scale, true);
      this._chain = { back: a, front: b };
      this._native.surfaceLock(a.handle);
      this._native.ctxClearRect(a.handle, 0, 0, w, h);
      this._native.ctxClearRect(b.handle, 0, 0, w, h);
      this._surface = a.handle;
      this._surfaceSize = { width: w, height: h };
      this._surfaceGen++;
      this._flushDamage = 'full';
      if (hadSurface) {
        queueMicrotask(() => {
          const node = this._reactX11Node;
          if (node && !node.destroyed) node.invalidate(true, null, 'resize');
        });
      }
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
    if (!this._dirty || !this._surface || this.destroyed) return;
    this._dirty = false;
    const shown = this._chain.back;
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
    this._chain.back = this._chain.front;
    this._chain.front = shown;
    this._surface = this._chain.back.handle;
    this._surfaceGen++;
    this._native.surfaceLock(this._surface);
    this._native.copySurfaceRegion(
      shown.handle,
      this._surface,
      damage === 'full' || !damage
        ? null
        : damage.flatMap((r) => [
            Math.floor(r.x),
            Math.floor(r.y),
            Math.ceil(r.width) + 1,
            Math.ceil(r.height) + 1,
          ]),
    );
  }

  snapshot() {
    return false; // no window of our own to capture; the host's shows it
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.app._unregisterWindow(this);
    this._chain = null;
    this._surface = null;
  }
}
