// An ntk-window-shaped object over an NSWindow — the contract WindowNode
// realizes against (src/testing/mock-app.js is the reference shape; this
// file is that shape with real glass behind it).
//
// Units: everything crossing THIS object's boundary is device pixels, like
// an X window — attributes, reported width/height, event coordinates,
// _screenOrigin. The divide-by-scale into Cocoa points happens against the
// native layer and nowhere above it.
import { CocoaContext2D } from './context2d.js';
import { CocoaLayerPresenter } from './presenter.js';

let nextWindowId = 1;

export class CocoaWindow {
  constructor(app, attributes = {}) {
    this.app = app;
    this._native = app._native;
    this.attributes = attributes;
    this.scale = app.scale;
    this.id = nextWindowId++;
    this.X = app.X;
    this.destroyed = false;
    this.mapped = false;
    this._handlers = new Map();
    this._surface = null;
    this._surfaceGen = 0;
    this._ctx = null;
    this._dirty = false;

    const s = this.scale;
    // Snapped to whole POINTS: AppKit rounds window sizes to the point
    // grid, so an odd device-pixel request comes back one short in the
    // resize echo, the echo re-requests, and the backing surface churns —
    // each swap an uninitialized canvas only the next damage rect repaints.
    const snap = (v, fallback) =>
      Math.max(1, Math.round(Math.max(1, Math.round(v ?? fallback)) / s) * s);
    this.width = snap(attributes.width, 640);
    this.height = snap(attributes.height, 480);
    this.title = attributes.title ?? '';
    this._popup = attributes.overrideRedirect === true;

    const options = {
      width: this.width / s,
      height: this.height / s,
      title: this.title,
      kind: this._popup
        ? 'popup'
        : attributes.decorations === false
          ? 'borderless'
          : 'normal',
      resizable: attributes.resizable !== false,
    };
    if (typeof attributes.x === 'number' && typeof attributes.y === 'number') {
      options.x = attributes.x / s;
      options.y = attributes.y / s;
    }
    // `transparent` arrives as a 32-bit visual request on X; here every
    // window can composite, so the flag simply makes the glass clear.
    const transparent =
      attributes.visual !== undefined || attributes.transparent;
    this._transparentWindow = Boolean(transparent);
    if (transparent) options.opaque = false;
    // The root layer's background is the "what newly exposed area shows"
    // attribute an X window has — worth seeding on an opaque window so a
    // resize flashes the right colour. On a transparent one it would sit
    // OPAQUE behind the alpha the renderer paints (rounded corners went
    // square behind it), and the honest ground there is nothing at all.
    if (!transparent && attributes.backgroundColor !== undefined) {
      const parsed = app._parseColor(attributes.backgroundColor);
      if (parsed) options.backgroundColor = parsed;
    }
    this._h = this._native.createWindow2(options);
    this.windowNumber = this._native.windowNumber(this._h);
    this._layer = this._native.windowRootLayer(this._h);
    this._refreshOrigin();
    if (attributes.sizeHints) this.setSizeHints(attributes.sizeHints);

    // How many damage rects a frame may keep before merging them (nodes.js,
    // MAX_DAMAGE_RECTS is the X11 answer). A pass here costs one CoreGraphics
    // clip and a culled walk, where an X pass costs the server a clip mask,
    // so a frame in which a clock, a graph and a status row all ticked keeps
    // the three small rects instead of the box around them — which on a
    // large tree was most of the window, painted for three cells' worth of
    // change.
    this.damageRectCap = 16;

    // The retained layer presenter (docs/macos.md Tier L), behind
    // REACT_X11_COCOA_PRESENTER=layers while the surface path is the
    // measured default. Its two hooks exist only in this mode, so the
    // feature detection in nodes.js keeps the surface path byte-identical;
    // the scroll blit is shadowed off because a layer frame has no backing
    // bitmap to blit.
    if (app._presenterMode === 'layers') {
      this._presenter = new CocoaLayerPresenter(this);
      this.presentFrame = (windowNode) => this._presenter.frame(windowNode);
      this.noteInvalidate = (damage, layoutChanged) =>
        this._presenter.noteInvalidate(damage, layoutChanged);
      this.scrollRegion = null;
    }
    app._registerWindow(this);
  }

  // --- events --------------------------------------------------------------

  on(name, fn) {
    let list = this._handlers.get(name);
    if (!list) this._handlers.set(name, (list = []));
    list.push(fn);
  }

  emit(name, ev) {
    const list = this._handlers.get(name);
    if (!list) return;
    for (const fn of [...list]) fn(ev);
  }

  // --- geometry ------------------------------------------------------------

  _refreshOrigin() {
    const f = this._native.getWindowFrame(this._h);
    const s = this.scale;
    this.x = Math.round(f.x * s);
    this.y = Math.round(f.y * s);
    this._screenOrigin = { x: this.x, y: this.y };
  }

  /** Native geometry changed (delegate event, points). */
  _nativeResized(points) {
    const s = this.scale;
    this.width = Math.max(1, Math.round(points.width * s));
    this.height = Math.max(1, Math.round(points.height * s));
    this.x = Math.round(points.x * s);
    this.y = Math.round(points.y * s);
    this._screenOrigin = { x: this.x, y: this.y };
    // AppKit's inLiveResize, as the delegate reported it: the renderer
    // answers a live tick with the layout floors it has and measures fresh
    // ones after the drag (nodes.js, `_deferContentFloors`). Cleared by
    // the pump (`_endLiveResizes`), because the pump cannot run while the
    // resize loop owns the thread — a tick of it is the drag being over.
    if (points.live === true) this.liveResizing = true;
  }

  resize(width, height) {
    const s = this.scale;
    this.width = Math.max(1, Math.round(Math.round(width) / s) * s);
    this.height = Math.max(1, Math.round(Math.round(height) / s) * s);
    this._native.setWindowFrame(
      this._h,
      null,
      null,
      this.width / s,
      this.height / s,
    );
  }

  move(x, y) {
    const s = this.scale;
    this.x = Math.round(x);
    this.y = Math.round(y);
    this._native.setWindowFrame(this._h, x / s, y / s, null, null);
    this._screenOrigin = { x: this.x, y: this.y };
  }

  // --- lifecycle -----------------------------------------------------------

  map() {
    if (this.destroyed) return;
    this.mapped = true;
    // A popup must not take the keyboard from its owner; a toplevel's first
    // map is the app coming up and takes it.
    this._native.showWindow(this._h, !this._popup);
    this._refreshOrigin();
  }

  unmap() {
    if (this.destroyed) return;
    this.mapped = false;
    this._native.hideWindow(this._h);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mapped = false;
    this.app._unregisterWindow(this);
    this._native.destroyWindow2(this._h);
    this._surface = null;
  }

  // --- window-manager-ish surface (feature-detected by nodes.js) -----------

  setTitle(title) {
    this.title = title;
    this._native.setWindowTitle(this._h, String(title ?? ''));
  }

  setSizeHints(hints = {}) {
    const s = this.scale;
    const box = {};
    if (typeof hints.minWidth === 'number') box.minWidth = hints.minWidth / s;
    if (typeof hints.minHeight === 'number')
      box.minHeight = hints.minHeight / s;
    if (typeof hints.maxWidth === 'number') box.maxWidth = hints.maxWidth / s;
    if (typeof hints.maxHeight === 'number')
      box.maxHeight = hints.maxHeight / s;
    if (Object.keys(box).length) this._native.setWindowMinMax(this._h, box);
  }

  setClass() {}

  setWindowType() {}

  setActions() {}

  setTransientFor() {
    // addChildWindow attachment comes with the layer presenter phase; a
    // managed dialog already floats via its own window today.
  }

  setCursor(name) {
    this._native.setCursor(String(name ?? 'default'));
  }

  grabPointer(options, cb) {
    this.app._grabWindow = this;
    cb?.(null, 0);
  }

  ungrabPointer() {
    if (this.app._grabWindow === this) this.app._grabWindow = null;
  }

  selectXI2() {
    // AppKit's precise scroll deltas are already flowing; nothing to select.
    return Promise.resolve(true);
  }

  // --- drawing -------------------------------------------------------------

  /**
   * The backing store is a two-buffer IOSurface swapchain: painters draw
   * into the back buffer's CG bitmap, and presenting is `layer.contents =
   * iosurface` — zero-copy, where the plain-surface path paid a
   * window-sized CGImage copy per dirty frame (12ms at 900x700@2x — the
   * presenter bench's whole surface-vs-layers gap on bounded damage).
   * After a flip the new back buffer is one frame stale, so present copies
   * the just-shown frame's damage across — a damage-sized memcpy replacing
   * a window-sized upload. Falls back to the single plain surface where
   * IOSurface creation fails.
   */
  _ensureSurface() {
    const w = this.width;
    const h = this.height;
    if (
      !this._surface ||
      this._surfaceSize?.width !== w ||
      this._surfaceSize?.height !== h
    ) {
      const hadSurface = Boolean(this._surface);
      this._chain = null;
      try {
        const a = this._native.createSurfaceIOSurface(w, h, this.scale);
        const b = this._native.createSurfaceIOSurface(w, h, this.scale);
        this._chain = { back: a, front: b };
        this._native.surfaceLock(a.handle);
        this._native.ctxClearRect(a.handle, 0, 0, w, h);
        this._native.ctxClearRect(b.handle, 0, 0, w, h);
        this._surface = a.handle;
      } catch {
        this._surface = this._native.createSurface(w, h, this.scale);
        this._native.ctxClearRect(this._surface, 0, 0, w, h);
      }
      this._surfaceSize = { width: w, height: h };
      this._surfaceGen++;
      this._flushDamage = 'full';
      // A replaced backing surface holds nothing but what the flush now
      // painting puts on it. Whether that is enough is decided when the
      // flush reports its rects (`noteFrameDamage`) — not here, and not by
      // queueing a full frame behind this one. That used to be the answer,
      // and it made every tick of a live resize two full frames: the resize
      // event's own unbounded repaint, then this one, painting the same
      // pixels again. Worse, inside AppKit's resize loop no microtask runs
      // until the drag ends, so a drag of forty ticks queued forty full
      // frames that all ran on the mouse release — the freeze after a
      // resize, measured at seconds on a large tree.
      if (hadSurface) this._freshSurface = true;
    }
    return this._surface;
  }

  /**
   * The per-flush painted rects (nodes.js's swapchain seam), accumulated
   * until the next present: they are what the flip's catch-up copy covers.
   * `'full'`/null collapse the set — one full copy beats bookkeeping.
   */
  noteFrameDamage(rects) {
    if (this._presenter) return;
    if (this._freshSurface) {
      this._freshSurface = false;
      // A full flush painted every pixel of the new surface, and a resize
      // event's flush is one (nodes.js, the 'resize' listener). A bounded
      // one left garbage outside its rects: hold the present until the full
      // frame asked for here lands, so the garbage is never on glass.
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

  /**
   * Whether anyone can see this window: mapped by the renderer, and not
   * ordered out or miniaturized by the user. A window that fails this owes
   * no frames — its callbacks wait in the app's queue (`_tickFrames`) and
   * its last paint stays unpresented until it is back on glass, where one
   * catch-up frame covers everything that changed in between.
   *
   * Occlusion by another application's window is not read here yet: AppKit
   * reports it through `windowDidChangeOcclusionState`, which the bridge
   * does not forward. When it does, this is the one place to add it.
   */
  _visible() {
    if (this.destroyed || !this.mapped) return false;
    return this._native.windowIsVisible(this._h) !== false;
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

  /** The scroll-blit fast path: move pixels inside the backing surface,
   * with ntk Window.scrollRegion's contract — the shift happens WITHIN the
   * rect, and a delta that leaves no surviving band reports false so the
   * caller falls back to the plain repaint. */
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
    if (moved) {
      this._dirty = true;
      // The band moved inside the BACK buffer only. After the flip the
      // other buffer still holds the band where it was, and the catch-up
      // copy only covers what the flush painted — the strips the shift
      // exposed — so the next frame would blit a band one frame stale.
      // Record the shifted rect as painted, and the flip's copy carries it.
      this.noteFrameDamage([
        {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      ]);
    }
    return Boolean(moved);
  }

  frameInFlight() {
    return false;
  }

  requestAnimationFrame(cb) {
    return this.app._requestFrame(cb, this);
  }

  /** Push the backing surface at the WindowServer, if anything drew. */
  present() {
    if (this._presenter) return; // layers upload as they sync
    if (!this._dirty || !this._surface || this.destroyed) return;
    // …and if anyone would see it. `_dirty` stays set, so the pump asks
    // again next tick and the frame goes out the moment the window is back.
    if (this._holdPresent || !this._visible()) return;
    this._dirty = false;
    if (this._chain) {
      const shown = this._chain.back;
      this._native.surfaceUnlock(shown.handle);
      this._native.setLayerContentsIOSurface(this._layer, shown.iosurfaceId);
      this._chain.back = this._chain.front;
      this._chain.front = shown;
      this._surface = this._chain.back.handle;
      // a different native surface owns the graphics state now — the
      // context re-syncs its sticky state off the generation
      this._surfaceGen++;
      this._native.surfaceLock(this._surface);
      const damage = this._flushDamage;
      this._flushDamage = null;
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
      if (this._transparentWindow) this.app._shadowStale.add(this);
      return;
    }
    this._native.surfaceToLayer(this._surface, this._layer);
    // AppKit derives a transparent window's shadow from the content's
    // opaque shape and does not recompute it on repaints — a popup whose
    // card lands a frame after the map keeps the full-frame square AppKit
    // guessed first. Recompute — but only once this present's transaction
    // has actually flushed to the render server, or the recompute reads
    // the frame BEFORE this one and keeps the square rim for menus that
    // paint once and are only hovered after.
    if (this._transparentWindow) this.app._shadowStale.add(this);
  }

  snapshot(path) {
    return this._native.snapshotWindow(this._h, path);
  }
}
