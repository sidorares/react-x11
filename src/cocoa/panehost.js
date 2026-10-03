// The host's half of a Cocoa frame pane: one sublayer over the window
// content (the same stacking a glarea and an X11 foreign window get), whose
// contents are whatever IOSurface the pane process last presented. The pane
// owns its buffers and its drawing; this side owns the layer, the layout
// and the input — CPU offloading, not isolation (docs/frame.md).
//
// And the windows the pane makes besides its own — a menu, a dropdown's
// sheet, a tooltip, a dialog. A pane process runs no AppKit, so each is an
// NSWindow made here, showing the ring the pane draws it into the same way
// (`CocoaPaneSubwindow`, src/cocoa/panewindow.js), with its input sent back.
//
// And the players its `<video src>`s ask for, which a process with no
// AppKit would never hear from: each is a player here, its events and its
// frames sent back (`HostedPlayer`, src/cocoa/paneplayer.js).
import { HostedPlayer } from './paneplayer.js';
import { withoutActions } from './quiet.js';

/** One shared surface on glass: a sublayer of a window's root layer, its
 * contents the IOSurface the pane last presented into it. */
class PaneLayer {
  constructor(app, wnd) {
    this.app = app;
    this.wnd = wnd;
    this._native = app._native;
    this.layer = withoutActions(this._native, () => {
      const layer = this._native.createLayer();
      this._native.addSublayer(wnd._layer, layer);
      return layer;
    });
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
    // Actions off: the layer is ours, not a presenter's, so no frame's
    // transaction covers it, and a bare set tweens the pane into place at
    // mount and after every resize — the trap CocoaGLArea._setLayerProps
    // describes.
    const native = this._native;
    native.txBegin({ disableActions: true });
    try {
      native.setLayerProps(this.layer, {
        frame: [rect.x / s, rect.y / s, rect.width / s, rect.height / s],
        zPosition: 1e7,
        hidden: false,
      });
    } finally {
      native.txCommit();
    }
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
    if (this.destroyed) return false;
    try {
      this._native.setLayerContentsIOSurface(this.layer, iosurfaceId);
    } catch (err) {
      if (!/IOSurfaceLookup/.test(err?.message ?? '')) throw err;
      return false;
    }
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    withoutActions(this._native, () =>
      this._native.removeFromSuperlayer(this.layer),
    );
  }
}

/**
 * The input a window shows for the pane hands back, by the names its
 * events go by (`CocoaApp._route`). A managed window's moves, resizes and
 * close button go back as well (`_hostGeometry`).
 */
const FORWARDED = [
  'mousedown',
  'mouseup',
  'mousemove',
  'mouseout',
  'wheel',
  'keydown',
  'keyup',
  'focus',
  'blur',
];

/** An event as data: the channel carries structured clones, and a
 * `preventDefault` does not clone. */
function plain(ev) {
  const out = {};
  for (const key in ev) {
    const value = ev[key];
    if (value === null || typeof value !== 'object') {
      if (typeof value !== 'function') out[key] = value;
    }
  }
  return out;
}

export class CocoaPaneHost extends PaneLayer {
  /**
   * `send` is the pane's channel (`<Frame>`'s session): what the windows
   * shown here for the pane hear goes back down it.
   */
  constructor(app, wnd, { send } = {}) {
    super(app, wnd);
    this._send = send ?? null;
    /** @type {Map<number, object>} the pane's windows, by its id for them */
    this._windows = new Map();
    /** @type {Map<number, () => void>} the pane's open menus, by its id */
    this._menus = new Map();
    /** @type {Map<string, HostedPlayer>} the pane's players, by its id */
    this._players = new Map();
  }

  /**
   * A `pane-player` message: one of the pane's `<video src>`s made, steered
   * or let go of its player. A player that cannot be made says so the way
   * one that cannot play does, as a `player-error`.
   */
  player(msg) {
    if (this.destroyed) return;
    if (msg.op !== 'create') {
      this._players.get(msg.player)?.handle(msg);
      if (msg.op === 'release') this._players.delete(msg.player);
      return;
    }
    if (this._players.has(msg.player)) return;
    try {
      this._players.set(
        msg.player,
        new HostedPlayer(this.app, (m) => this._send?.(m), msg),
      );
    } catch (err) {
      this._send?.({
        type: 'pane-player-event',
        player: msg.player,
        ev: {
          type: 'player-error',
          id: msg.player,
          message: err?.message ?? String(err),
        },
      });
    }
  }

  /**
   * A `pane-menu` message: the pane's `<Select>` asked for the platform's
   * menu, which a process with no AppKit cannot drop (`CocoaApp.popUpMenu`).
   * Its frame is in the window it is in — the pane's own, laid out at this
   * layer's rect in the host's window, or one the pane made, shown here —
   * and the answer goes back as `pane-menu-answer`.
   */
  popUpMenu(msg) {
    if (this.destroyed || !msg.spec) return;
    const entry = msg.window != null ? this._windows.get(msg.window) : null;
    const [x, y, width, height] = msg.spec.frame;
    const at = entry ? { x: 0, y: 0 } : (this._rect ?? { x: 0, y: 0 });
    const cancel = this.app.popUpMenu(
      entry ? entry.wnd : this.wnd,
      { ...msg.spec, frame: [x + at.x, y + at.y, width, height] },
      (id) => {
        this._menus.delete(msg.menu);
        this._send?.({ type: 'pane-menu-answer', menu: msg.menu, id });
      },
    );
    this._menus.set(msg.menu, cancel);
  }

  /** `pane-menu-cancel`: the pane's `<Select>` went, or closed it. */
  cancelMenu(menu) {
    this._menus.get(menu)?.();
  }

  /**
   * A `pane-window` message: one of the pane's other windows was made,
   * mapped, moved, grabbed with or destroyed. `x`/`y` are the screen
   * position the pane worked out — its anchoring ran against the origin
   * this side sent it — so the window goes where it says.
   */
  paneWindow(msg) {
    if (this.destroyed) return;
    if (msg.op === 'create') {
      this._create(msg);
      return;
    }
    const entry = this._windows.get(msg.window);
    if (!entry) return;
    const { wnd } = entry;
    switch (msg.op) {
      case 'map':
        // on the first frame rather than now: a window mapped before the
        // pane has drawn it is a window of nothing, for a frame or two
        if (entry.presented) wnd.map();
        else entry.mapOnPresent = true;
        break;
      case 'unmap':
        entry.mapOnPresent = false;
        wnd.unmap();
        break;
      case 'move':
        wnd.move(msg.x, msg.y);
        break;
      case 'resize':
        // the layer follows on the present drawn at the new size
        wnd.resize(msg.width, msg.height);
        break;
      case 'grab':
        wnd.grabPointer();
        break;
      case 'ungrab':
        wnd.ungrabPointer();
        break;
      case 'title':
        wnd.setTitle(msg.title);
        break;
      case 'size-hints':
        wnd.setSizeHints(msg.hints);
        break;
      case 'destroy':
        this._drop(entry);
        break;
      default:
        break;
    }
  }

  /** A pane-present naming one of the pane's other windows. */
  presentWindow(msg) {
    const entry = this._windows.get(msg.window);
    if (!entry || this.destroyed) return;
    entry.layer.setRect({ x: 0, y: 0, width: msg.width, height: msg.height });
    if (!entry.layer.present(msg.id)) return;
    entry.presented = true;
    // a transparent window's shadow is the shape of what it shows
    entry.wnd._shadowAfterFlip?.();
    if (entry.mapOnPresent) {
      entry.mapOnPresent = false;
      entry.wnd.map();
    }
  }

  /** The cursor a tree names for one of the pane's other windows: the
   * pointer is over the window shown here, so this side sets it. */
  windowCursor(msg) {
    this._windows.get(msg.window)?.wnd.setCursor(msg.cursor ?? 'default');
  }

  _create(msg) {
    if (this._windows.has(msg.window)) return;
    const wnd = this.app.createWindow({
      overrideRedirect: msg.popup,
      x: msg.x,
      y: msg.y,
      width: msg.width,
      height: msg.height,
      transparent: msg.transparent,
      grabKeyboard: msg.grabKeyboard,
      dragPreview: msg.dragPreview,
      title: msg.title,
      decorations: msg.decorations,
      resizable: msg.resizable,
      sizeHints: msg.sizeHints,
    });
    const entry = {
      id: msg.window,
      wnd,
      layer: new PaneLayer(this.app, wnd),
      presented: false,
      mapOnPresent: false,
    };
    this._windows.set(msg.window, entry);
    const forward = (name, ev) => {
      if (this.destroyed || entry.dropped) return;
      this._send?.({ type: 'pane-event', window: entry.id, name, ev });
    };
    for (const name of FORWARDED) {
      wnd.on(name, (ev) => forward(name, plain(ev)));
    }
    // A popup goes where the pane puts it and no one else moves it. A
    // managed window is the user's to move, resize and close as well, and
    // the pane hears of each — of a resize only the user's, since the
    // pane's own come back as AppKit's echo of the frame it was asked for.
    if (!msg.popup) {
      wnd.on('resize', (ev) =>
        forward('resize', {
          x: ev.x,
          y: ev.y,
          width: ev.width,
          height: ev.height,
          resized: Boolean(ev.resized && wnd.liveResizing),
        }),
      );
      wnd.on('close', () => forward('close', {}));
    }
  }

  _drop(entry) {
    if (entry.dropped) return;
    entry.dropped = true;
    this._windows.delete(entry.id);
    entry.wnd.ungrabPointer();
    entry.layer.destroy();
    entry.wnd.destroy();
  }

  /** The pane is going, and every window it had here goes with it — a pane
   * that crashed with a menu open leaves no menu behind, and one that
   * crashed playing leaves no sound. */
  destroy() {
    if (this.destroyed) return;
    for (const cancel of [...this._menus.values()]) cancel();
    this._menus.clear();
    for (const entry of [...this._windows.values()]) this._drop(entry);
    for (const hosted of this._players.values()) hosted.release();
    this._players.clear();
    super.destroy();
  }
}
