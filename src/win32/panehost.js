// The host's half of a Windows frame pane: one visual over the window's
// content — the same stacking a `<glarea>` gets — whose content is the
// buffer the pane process is drawing into. The pane owns its buffers and its
// drawing; this side owns the visual, the layout and the input. CPU
// offloading, not isolation (docs/frame.md).
//
// The seam is `setRect` / `present` / `destroy`, the same three methods the
// Cocoa host implements, and the difference between the two backends lives
// entirely inside `present`. There a Cocoa host is told a **different**
// IOSurface every frame and points its layer at each one; here it is told
// the **same** composition surface handle every time, because the pane's
// swapchain flips inside that one handle. So this one attaches once and
// recognises the handle ever after — after which the pane's frames arrive
// with nothing at all crossing the process boundary.
export class Win32PaneHost {
  constructor(app, wnd) {
    this.app = app;
    this.wnd = wnd;
    this._native = app._native;
    this.destroyed = false;
    /** The bridge's id for the attached visual; 0 until the first present,
     *  because there is no buffer to attach before the pane names one. */
    this._view = 0;
    /** The handle that view was opened from, so the same one arriving again
     *  is recognised rather than re-opened. */
    this._handle = 0;
    this._rect = null;
  }

  /**
   * Where the pane goes, in the host window's device pixels — the node's
   * `abs`. The size is a **clip**, not a scale: the pane draws at whatever
   * size it was last told over the channel, and the two disagree for the
   * length of a round trip whenever the box changes. Bounding it here is
   * what keeps a pane that has not caught up from painting over its
   * neighbours (`paneSetRect`, windows/src/pane.cc).
   */
  setRect(rect) {
    if (this.destroyed || !rect) return;
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
    this._place();
  }

  _place() {
    const rect = this._rect;
    if (!this._view || !rect) return;
    this._native.paneSetRect(
      this._view,
      Math.round(rect.x),
      Math.round(rect.y),
      Math.max(0, Math.round(rect.width)),
      Math.max(0, Math.round(rect.height)),
    );
  }

  /**
   * The pane named the buffer its frames are in.
   *
   * On the first one this opens the handle and hangs it in the window's
   * visual tree; on every one after it there is nothing to do, and saying so
   * quickly is the point — the compositor is already scanning out of
   * whatever the pane last presented, so a frame reaches the screen without
   * this method being called at all.
   *
   * A *different* handle means a different pane behind the same host, which
   * is what a restart looks like from here: drop the old view and open the
   * new one, rather than leaving the window showing a buffer whose process
   * has gone.
   */
  present(handle) {
    if (this.destroyed || !handle) return;
    if (handle === this._handle && this._view) return;
    if (this._view) {
      this._native.paneDetach(this._view);
      this._view = 0;
    }
    const view = this._native.paneAttach(this.wnd.id, handle);
    if (!view) {
      // Nothing was shown and nothing was lost; the pane will say so again
      // with its next pane-rect, and a host window not yet composed is the
      // one way this happens.
      return;
    }
    this._handle = handle;
    this._view = view;
    this._place();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this._view) this._native.paneDetach(this._view);
    this._view = 0;
    this._handle = 0;
  }
}
