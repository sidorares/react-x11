// The host's half of a Cocoa frame pane: one sublayer over the window
// content (the same stacking a glarea and an X11 foreign window get), whose
// contents are whatever IOSurface the pane process last presented. The pane
// owns its buffers and its drawing; this side owns the layer, the layout
// and the input — CPU offloading, not isolation (docs/frame.md).
export class CocoaPaneHost {
  constructor(app, wnd) {
    this.app = app;
    this.wnd = wnd;
    this._native = app._native;
    this.layer = this._native.createLayer();
    this._native.addSublayer(wnd._layer, this.layer);
    this.destroyed = false;
    this._rect = null;
  }

  /** Geometry in device px, the node's abs — points at the layer. */
  setRect(rect) {
    if (this.destroyed) return;
    const s = this.wnd.scale;
    const prev = this._rect;
    if (
      prev &&
      prev.x === rect.x &&
      prev.y === rect.y &&
      prev.width === rect.width &&
      prev.height === rect.height
    ) {
      return;
    }
    this._rect = { ...rect };
    this._native.setLayerProps(this.layer, {
      frame: [rect.x / s, rect.y / s, rect.width / s, rect.height / s],
      zPosition: 1e7,
      hidden: false,
    });
  }

  /**
   * A pane-present landed: scan out of the named shared surface.
   *
   * A present names a buffer the pane may since have retired. The channel
   * is a queue and nothing acknowledges a present, so a pane-rect that
   * changes the pane's size (or its scale — the host window moved to another
   * display during startup, which is how this was first hit) can cross a
   * present already in flight: the pane rebuilds its ring on that rect and
   * releases the old one (`CocoaPaneWindow._ensureSurface`), and by the
   * time the host looks the id up the surface is gone. That present is
   * stale by construction — the pane's full frame on the fresh ring is
   * queued behind it — so it is dropped, and the layer keeps the frame it
   * already holds a reference to. Nothing else here throws; any other
   * error is the bug it says it is.
   */
  present(iosurfaceId) {
    if (this.destroyed) return;
    try {
      this._native.setLayerContentsIOSurface(this.layer, iosurfaceId);
    } catch (err) {
      if (!/IOSurfaceLookup/.test(err?.message ?? '')) throw err;
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._native.removeFromSuperlayer(this.layer);
  }
}
