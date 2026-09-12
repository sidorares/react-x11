// The pane a `<glarea>`'s children are drawn on, on the Cocoa backend: a
// transparent bitmap layer over the surface (src/gloverlay.js).
//
// A sublayer of the window's root layer like the surface's own
// (src/cocoa/glarea.js), one step above it: the GL layer sits at zPosition
// 1e7, over everything both presenters put on the root layer, and this one
// at 1e7 + 1, over that. Core Animation composites it, so what the children
// leave transparent shows the GL frame, and a translucent fill, an
// antialiased edge or a shadow blends with it — the one backend where the
// overlay is not opaque. Every surface's GL layer shares the one zPosition,
// so where two surfaces overlap, both overlays are above both frames.
//
// It speaks the verbs of a window the overlay drives on X11 — `setState`,
// `map`, `unmap`, `getContext`, `destroy` — plus `present`, which puts what
// was painted on the layer: ntk blits an X window's backing store on its
// own, where a layer's contents are a copy the bitmap has to be pushed to.
import { CocoaContext2D } from './context2d.js';

export const OVERLAY_Z = 1e7 + 1;

export class CocoaOverlayPane {
  constructor(app, options) {
    this.app = app;
    this.parent = options.parent;
    this._native = app._native;
    this.scale = this.parent.scale ?? app.scale ?? 1;
    this.destroyed = false;
    this.layer = this._native.createLayer();
    this._native.addSublayer(this.parent._layer, this.layer);
    this.rect = null;
    this._surface = null;
    this._surfaceSize = null;
    this._gen = 0;
    this._ctx = null;
    this._dirty = false;
    // Hidden until something is on it: a layer shows its contents from the
    // moment it is added, and before the first present there are none to
    // show, only whatever the render server makes of that.
    this._presented = false;
    this._hidden = false;
    this.setState({
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 1,
      height: options.height ?? 1,
    });
  }

  get width() {
    return this.rect?.width ?? 0;
  }

  get height() {
    return this.rect?.height ?? 0;
  }

  /** Geometry in device px, the unit the overlay's rects are in. */
  setState(rect) {
    if (this.destroyed) return;
    this.rect = rect;
    const s = this.scale;
    this._setLayerProps({
      frame: [rect.x / s, rect.y / s, rect.width / s, rect.height / s],
      zPosition: OVERLAY_Z,
      hidden: this._hidden || !this._presented,
    });
  }

  map() {
    this._hidden = false;
    if (this._presented) this._setLayerProps({ hidden: false });
  }

  unmap() {
    this._hidden = true;
    this._setLayerProps({ hidden: true });
  }

  /** Implicit animations off, for the reason `CocoaGLArea._setLayerProps`
   * gives: no frame's transaction covers a layer that is not a presenter's. */
  _setLayerProps(props) {
    if (this.destroyed) return;
    const native = this._native;
    native.txBegin({ disableActions: true });
    try {
      native.setLayerProps(this.layer, props);
    } finally {
      native.txCommit();
    }
  }

  /** The bitmap, the pane's size — a new size is a new bitmap, cleared, and
   * the old one freed now rather than by the handle's finalizer. */
  _ensureSurface() {
    const w = Math.max(1, this.rect?.width ?? 1);
    const h = Math.max(1, this.rect?.height ?? 1);
    const size = this._surfaceSize;
    if (!this._surface || size.width !== w || size.height !== h) {
      this._release();
      this._surface = this._native.createSurface(w, h, this.scale);
      this._native.ctxClearRect(this._surface, 0, 0, w, h);
      this._surfaceSize = { width: w, height: h };
      this._gen++;
    }
    return this._surface;
  }

  _release() {
    const surface = this._surface;
    this._surface = null;
    if (surface && typeof this._native.releaseSurface === 'function') {
      this._native.releaseSurface(surface);
    }
  }

  getContext() {
    if (!this._ctx) {
      this._ctx = new CocoaContext2D(
        this._native,
        () => this._ensureSurface(),
        () => {
          this._ensureSurface();
          return this._gen;
        },
      );
      this._ctx._fonts = this.app.fonts;
      this._ctx._onDirty = () => {
        this._dirty = true;
      };
    }
    return this._ctx;
  }

  /** What was painted, onto the layer — a copy, so the bitmap is free to be
   * painted again at once. */
  present() {
    if (this.destroyed || !this._dirty || !this._surface) return;
    this._dirty = false;
    const native = this._native;
    native.txBegin({ disableActions: true });
    try {
      native.surfaceToLayer(this._surface, this.layer);
      if (!this._presented) {
        this._presented = true;
        if (!this._hidden) native.setLayerProps(this.layer, { hidden: false });
      }
    } finally {
      native.txCommit();
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._release();
    this._ctx = null;
    this._native.removeFromSuperlayer(this.layer);
  }
}
