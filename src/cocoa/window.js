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
    this.width = Math.max(1, Math.round(attributes.width ?? 640));
    this.height = Math.max(1, Math.round(attributes.height ?? 480));
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
  }

  resize(width, height) {
    const s = this.scale;
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
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

  _ensureSurface() {
    const w = this.width;
    const h = this.height;
    if (
      !this._surface ||
      this._surfaceSize?.width !== w ||
      this._surfaceSize?.height !== h
    ) {
      this._surface = this._native.createSurface(w, h, this.scale);
      this._surfaceSize = { width: w, height: h };
      this._surfaceGen++;
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

  /** The scroll-blit fast path: move pixels inside the backing surface. */
  scrollRegion(rect, dx, dy) {
    if (!this._surface) return false;
    this._native.scrollSurface(
      this._surface,
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height),
      Math.round(dx),
      Math.round(dy),
    );
    this._dirty = true;
    return true;
  }

  frameInFlight() {
    return false;
  }

  requestAnimationFrame(cb) {
    return this.app._requestFrame(cb);
  }

  /** Push the backing surface at the WindowServer, if anything drew. */
  present() {
    if (this._presenter) return; // layers upload as they sync
    if (!this._dirty || !this._surface || this.destroyed) return;
    this._dirty = false;
    this._native.surfaceToLayer(this._surface, this._layer);
  }

  snapshot(path) {
    return this._native.snapshotWindow(this._h, path);
  }
}
