// The pane a `<glarea>`'s children are drawn on, on the Windows backend: a
// DirectComposition visual with a premultiplied surface of its own, above
// every swap chain in the window's tree (src/gloverlay.js; the bridge's
// src/layer.cc).
//
// Without it a pane was whatever `app.createWindow({ parent })` answers,
// which here is a GL surface (src/win32/glarea.js) — a WGL context and a
// swap chain per pane, and no 2D context at all. The children were laid out,
// claimed and painted nowhere, and a component that drew their cards under
// them had nothing left on screen where they were.
//
// Composited, like the Cocoa pane (src/cocoa/overlay.js): what the children
// leave transparent shows the GL frame, and a translucent fill, an
// antialiased edge or a shadow blends with it. Text on it is grayscale
// rather than ClearType, which Direct2D does on any surface with alpha
// (docs/windows.md §Text).
//
// Drawn like the window it lives in (src/win32/window.js): a DirectComposition
// surface hands out a context per `BeginDraw`, valid until `EndDraw`, so the
// overlay's passes come through `paintPasses` — one `BeginDraw` each — rather
// than through a context that is always there. `present` asks for the commit
// the window's own frame makes, so a pane and the window land together.
import { BackendContext2D } from '../backend/context2d.js';

export class Win32OverlayPane {
  constructor(app, options) {
    this.app = app;
    this.parent = options.parent;
    this._native = app._native;
    this.destroyed = false;
    this.rect = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width ?? 1,
      height: options.height ?? 1,
    };
    // the bridge's layer, made once the window has a composition tree to
    // hang it in — the tree renders before the window is ready
    this._layer = 0;
    this._visible = true;
    // non-zero only between a pass's BeginDraw and its EndDraw
    this._surface = 0;
    this._gen = 0;
    this._ctx = null;
    this._handlers = {};
    this._ensureLayer();
  }

  get width() {
    return this.rect.width;
  }

  get height() {
    return this.rect.height;
  }

  on(name, fn) {
    (this._handlers[name] ??= []).push(fn);
  }

  emit(name, ev) {
    for (const fn of this._handlers[name] ?? []) fn(ev);
  }

  _ensureLayer() {
    if (this._layer || this.destroyed) return this._layer;
    if (!this.parent?._composed || this.parent.destroyed) return 0;
    const { x, y, width, height } = this.rect;
    this._layer = this._native.layerCreate(
      this.parent.id,
      Math.round(x),
      Math.round(y),
      Math.max(1, Math.round(width)),
      Math.max(1, Math.round(height)),
    );
    if (this._layer && !this._visible) {
      this._native.layerSetVisible(this._layer, false);
    }
    return this._layer;
  }

  /** Geometry in device px, the unit the overlay's rects are in. */
  setState(rect) {
    if (this.destroyed) return;
    this.rect = rect;
    if (!this._layer) return;
    this._native.layerSetRect(
      this._layer,
      Math.round(rect.x),
      Math.round(rect.y),
      Math.max(1, Math.round(rect.width)),
      Math.max(1, Math.round(rect.height)),
    );
    this._owe();
  }

  map() {
    this._setVisible(true);
  }

  unmap() {
    this._setVisible(false);
  }

  _setVisible(on) {
    if (this._visible === on) return;
    this._visible = on;
    if (!this._layer || this.destroyed) return;
    this._native.layerSetVisible(this._layer, on);
    this._owe();
  }

  getContext() {
    if (!this._ctx) {
      this._ctx = new BackendContext2D(
        this._native,
        () => this._surface,
        () => this._gen,
      );
      this._ctx._fonts = this.app.fonts;
    }
    return this._ctx;
  }

  /**
   * The overlay's passes, each its own `BeginDraw` — `rect`s in window
   * coordinates, each painted by `paint(ctx, rect)` with the context drawing
   * in window coordinates too. A pass is grown to whole pixels first:
   * everything inside a `BeginDraw` rect is undefined until it is painted,
   * so the rect the painter clears and the rect the surface hands out have
   * to be the same one.
   */
  paintPasses(passes, paint) {
    if (this.destroyed) return;
    if (!this._ensureLayer()) {
      // Nothing to draw into yet. The overlay believes these passes landed,
      // so it is told they did not: all of the pane is owed, on the next
      // frame, when the window will have a tree to hang the layer in.
      setImmediate(() => {
        if (!this.destroyed) this.emit('draw', {});
      });
      return;
    }
    const ctx = this.getContext();
    const ox = Math.round(this.rect.x);
    const oy = Math.round(this.rect.y);
    let drawn = false;
    for (const pass of passes) {
      const x0 = Math.max(Math.floor(pass.x), ox);
      const y0 = Math.max(Math.floor(pass.y), oy);
      const x1 = Math.min(
        Math.ceil(pass.x + pass.width),
        ox + Math.max(1, Math.round(this.rect.width)),
      );
      const y1 = Math.min(
        Math.ceil(pass.y + pass.height),
        oy + Math.max(1, Math.round(this.rect.height)),
      );
      if (x1 <= x0 || y1 <= y0) continue;
      const handle = this._native.layerBeginDraw(
        this._layer,
        x0 - ox,
        y0 - oy,
        x1 - x0,
        y1 - y0,
      );
      if (!handle) continue;
      this._surface = handle;
      this._gen++;
      try {
        // the surface draws in the layer's own coordinates; the painter
        // draws in the window's
        ctx.save();
        try {
          ctx.translate(-ox, -oy);
          paint(ctx, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
        } finally {
          ctx.restore();
        }
        drawn = true;
      } finally {
        this._surface = 0;
        this._native.layerEndDraw(this._layer);
      }
    }
    if (drawn) this._owe();
  }

  /**
   * Move the pixels of `rect` (pane coordinates, device px) by (dx, dy) —
   * ntk `Window.scrollRegion`'s contract: the band that survives the shift
   * inside `rect` moves, the rest of it is left as it was, and false means
   * nothing moved, so the caller repaints instead (issue #644).
   */
  scrollRegion(rect, dx, dy) {
    if (this.destroyed || !this._layer) return false;
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) return false;
    const moved = this._native.layerScroll(
      this._layer,
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height),
      dx,
      dy,
    );
    if (moved) this._owe();
    return Boolean(moved);
  }

  /** What was painted or moved, onto the screen with the window's frame. */
  present() {
    this._owe();
  }

  /**
   * A commit is owed. The window's frame makes one after the overlay has
   * painted (`presentFrame`, src/win32/window.js), so a pane's pixels and
   * the window's land together; a change made outside a frame — a pane
   * hidden between two — is committed on a microtask instead, once.
   */
  _owe() {
    const wnd = this.parent;
    if (!wnd || wnd.destroyed) return;
    if (wnd._owesCommit) return;
    wnd._owesCommit = true;
    queueMicrotask(() => {
      if (!wnd._owesCommit) return;
      wnd._owesCommit = false;
      if (!wnd.destroyed) this._native.commit();
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._ctx = null;
    if (this._layer) {
      this._native.layerDestroy(this._layer);
      this._layer = 0;
      this._owe();
    }
  }
}
