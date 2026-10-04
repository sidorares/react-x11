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
import { now } from '../nodes/animation.js';
import { HostedPlayer } from './paneplayer.js';
import { withoutActions } from './quiet.js';

/** The live-resize handshake's budget when the app names none
 *  (`RESIZE_WAIT_MS`, src/cocoa/app.js). */
const RESIZE_WAIT_MS = 50;

/** How many sizes asked of the pane are remembered until a frame of one
 *  answers them (`_asked`): a drag asks one a frame. */
const ASKED_KEPT = 16;

/** How long after the last size asked a new one starts a gesture of its
 *  own, which finds the pane keeping up until it shows otherwise: a pane
 *  whose layout at a width it was not dragged to took long — a long page
 *  laid out whole, as the first step of a drag is — keeps up with the
 *  drag itself. */
const GESTURE_GAP_MS = 500;

/** How far inside the budget a frame of a pane that fell behind has to
 *  come for its frames to be shown at their size again (`_answered`): a
 *  pane whose frames come near the budget keeps one look rather than taking
 *  the other at every frame. */
const KEPT_UP = 0.75;

/** How much of a frame's last pixel is carried over the layer past it
 *  (`_edgeProps`): its middle, a hundredth of a pixel wide. A centre the
 *  whole pixel wide stretches what the filter makes of it and the pixel
 *  before it, a blend of the two ramped across the gap, and Core Animation
 *  takes a centre of no width for none. */
const EDGE_SLIVER = 0.01;

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
    // How the frame the layer holds is shown while one of the size the
    // layer was just given is on its way (`_anchoredNow`, `_edgeProps`):
    // the sizes asked of the pane with when each was asked, whether the
    // pane has fallen behind them, the size of the frame it holds, and the
    // contents rects last set — Core Animation's own, the whole, until any
    // are.
    this._contentsScale = null;
    this._asked = [];
    this._askedAt = null;
    this._behind = false;
    this._frame = null;
    this._edgeKey = `${null}|${null}`;
    // when a frame last answered a size, and how many frames in a row came
    // later than the budget (`_answered`)
    this._answeredAt = -Infinity;
    this._late = 0;
  }

  /**
   * Whether a pane's last frame is shown at its size in its layer until a
   * frame of the layer's new size lands, or stretched to it. The host gives
   * the layer its new size the moment the window lays out, and the pane's
   * frame of that size comes a pane frame later: Core Animation stretches
   * the frame it has to the new bounds meanwhile, and a page's left column
   * was drawn scaled a little at every step of a window dragged wider, and
   * then at its size again. A pane that keeps up has its frame shown at its
   * size instead, its edge carried over what it does not cover yet
   * (`_edgeProps`); one that falls behind the budget is stretched, which is
   * the better picture for the long wait — a pane repainting at three
   * frames a second shows a squeezed page, not a page and a smeared strip.
   * The budget is the window's live-resize handshake's
   * (`createRoot({ cocoa: { resizeWait } })`), how long a frame of a new
   * size may take before the old one is shown in its place: 0 stretches
   * always, as before.
   *
   * Behind is a pane whose frames come later than the budget, not one with
   * a size waiting that long. `<Frame>` sends a pane the newest size once
   * it has painted the last, so the sizes a drag passes through while a
   * frame is being painted are never sent, and never answered: a size
   * waits until a frame of a later one lands, two pane frames at most. A
   * page that painted in 27 ms answered every size it was sent in 31, and
   * still had one 52 ms old at every step of the drag — so its layer was
   * stretched at every step and shown at its size again at every frame, the
   * page scaling and coming back thirty times a second. Here a size waiting
   * longer than the budget counts only when no frame has answered any size
   * in that time, which is a pane that stopped, and a frame that lands
   * decides the rest (`_answered`).
   */
  _anchoredNow() {
    const budget = this.app._resizeWait ?? RESIZE_WAIT_MS;
    if (!(budget > 0)) return false;
    // a size asked longer ago than the budget, and no frame of any since
    const oldest = this._asked[0];
    if (oldest && now() - Math.max(oldest.at, this._answeredAt) > budget) {
      this._behind = true;
    }
    return !this._behind;
  }

  /**
   * The props that show the frame the layer holds in bounds that are not
   * its size, where they changed. At its size and from the top left, as a
   * page sits in a window: an axis the layer shrank on is cropped
   * (`contentsRect`), and on one it grew on the frame's last pixel is
   * carried over the rest (`contentsCenter`, the part of the contents that
   * stretches while everything else keeps its size) — the last column
   * across a window dragged wider, the last row down one dragged taller,
   * and the corner pixel into the corner. Both rects are the whole when
   * the frame is stretched, and when it is the layer's size.
   *
   * Anchored by gravity alone, the strip the frame did not cover showed
   * whatever was under the pane, which is the `<Frame>`'s background: in
   * the browser example's dark mode a dark band 14 to 38 points wide down
   * the page's right edge, at every step of a fast drag. A page's edge is
   * mostly its background, so its last pixels continue it: Zen Garden's
   * about page has a vertical gradient there, which its last column carries
   * on exactly, where one colour read off the edge put a flat band across
   * it, three times as far from the page. Where the edge cuts through the
   * page's content — the bottom row, in a window dragged taller, usually
   * crosses a line of text — the glyphs run down the strip in thin lines
   * for the pane frame it lasts, where the settled page has its next line
   * of text: as far from it, measured, as the flat colour. A bridge that
   * predates the rects ignores them, and stretches.
   */
  _edgeProps() {
    const frame = this._frame;
    const rect = this._rect;
    let crop = null;
    let edge = null;
    if (frame && rect && this._anchoredNow()) {
      const w = Math.min(frame.width, rect.width);
      const h = Math.min(frame.height, rect.height);
      if (w < frame.width || h < frame.height) {
        crop = [0, 0, w / frame.width, h / frame.height];
      }
      // in the shown part's own unit square; an axis that did not grow is
      // all centre, stretched by one
      const wider = rect.width > w;
      const taller = rect.height > h;
      if (wider || taller) {
        edge = [
          wider ? (w - 0.5) / w : 0,
          taller ? (h - 0.5) / h : 0,
          wider ? EDGE_SLIVER / w : 1,
          taller ? EDGE_SLIVER / h : 1,
        ];
      }
    }
    const key = `${crop}|${edge}`;
    if (key === this._edgeKey) return null;
    this._edgeKey = key;
    return { contentsRect: crop, contentsCenter: edge };
  }

  /**
   * The props that say how many of the pane's pixels make a point of the
   * layer, where that changed: the window's scale, which the pane draws
   * at. A frame stretched to the bounds never asked, and one shown at its
   * size is shown at it — pixels over `contentsScale` points, so at the
   * default of 1 a page at 2x came out twice its size.
   */
  _scaleProps() {
    const scale = this.wnd.scale ?? 1;
    if (scale === this._contentsScale) return null;
    this._contentsScale = scale;
    return { contentsScale: scale };
  }

  /**
   * A frame of `width` by `height` device px landed: what it answers of
   * the sizes asked, and how long it took. Two frames in a row later than
   * the budget put the pane behind, and one well inside it — `KEPT_UP` of
   * it — brings it back: a frame the collector held up stretches nothing,
   * and a pane whose frames come near the budget is not stretched and
   * shown at its size by turns.
   */
  _answered(width, height) {
    const asked = this._asked;
    // the pane rounds the logical size it was sent back to device pixels
    const slack = Math.max(2, this.wnd.scale ?? 1);
    // the last time it was asked: a drag back and forth asks a size twice
    const at = asked.findLastIndex(
      (a) =>
        Math.abs(a.width - width) <= slack &&
        Math.abs(a.height - height) <= slack,
    );
    if (at < 0) return;
    const budget = this.app._resizeWait ?? RESIZE_WAIT_MS;
    const took = now() - asked[at].at;
    this._answeredAt = now();
    if (took > budget) {
      this._late += 1;
      if (this._late >= 2) this._behind = true;
    } else {
      this._late = 0;
      if (took <= budget * KEPT_UP) this._behind = false;
    }
    asked.splice(0, at + 1);
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
    // a size the pane is asked for, answered by the first frame of it
    if (prev && (prev.width !== rect.width || prev.height !== rect.height)) {
      const at = now();
      if (at - (this._askedAt ?? -Infinity) >= GESTURE_GAP_MS) {
        this._asked = [];
        this._behind = false;
        this._late = 0;
      }
      this._askedAt = at;
      if (this._asked.length === ASKED_KEPT) this._asked.shift();
      this._asked.push({ width: rect.width, height: rect.height, at });
    }
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
        ...this._scaleProps(),
        ...this._edgeProps(),
      });
    } finally {
      native.txCommit();
    }
  }

  /**
   * A pane-present landed: scan out of the named shared surface.
   *
   * A present names a buffer the pane may since have retired. The channel
   * is a queue, so a pane-rect that changes the pane's size (or its scale —
   * the host window moved to another display during startup, which is how
   * this was first hit) can cross a present already in flight: the pane
   * rebuilds its ring on that rect (`CocoaPaneWindow._ensureSurface`)
   * before the host has looked the id up. The id is all the present
   * carries, and the system gives a freed id to the next surface made, so
   * the pane keeps such a buffer until the host says it has looked it up
   * (`pane-shown`, which `CocoaPaneHost` sends once it has) — the lookup finds
   * the frame the present named, a size behind, and the full frame on the
   * fresh ring is queued behind it. Where the buffer is gone anyway — a
   * pane that freed it for want of an answer, or one that died with
   * presents in the channel — the present is dropped, and the layer keeps
   * the frame it already holds a reference to. Nothing else here throws;
   * any other error is the bug it says it is.
   */
  present(iosurfaceId, size = null) {
    if (this.destroyed) return false;
    const native = this._native;
    // The frame and the rects that show it in one transaction: a frame of
    // a new size shown by the last one's rects is cropped or carried over
    // by the wrong amount for a refresh.
    native.txBegin({ disableActions: true });
    try {
      try {
        native.setLayerContentsIOSurface(this.layer, iosurfaceId);
      } catch (err) {
        if (!/IOSurfaceLookup/.test(err?.message ?? '')) throw err;
        return false;
      }
      // how long the pane took to a frame of a size it was asked for, which
      // is what decides how the next is shown (`_anchoredNow`)
      if (size) {
        this._answered(size.width, size.height);
        this._frame = { width: size.width, height: size.height };
        const edge = this._edgeProps();
        if (edge) native.setLayerProps(this.layer, edge);
      }
    } finally {
      native.txCommit();
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
   * The pane's own present, scanned out (`PaneLayer.present`), and the pane
   * told: whatever the buffer it named holds is the layer's now, or was
   * dropped, so the pane may free it (`CocoaPaneWindow._releaseRing`).
   */
  present(iosurfaceId, size = null) {
    const shown = super.present(iosurfaceId, size);
    this._acknowledge(size?.seq, null);
    return shown;
  }

  /** `pane-shown`: the host has looked up the presents to `seq` of the
   *  pane's own window, or of the one `window` names. */
  _acknowledge(seq, window) {
    if (this.destroyed || seq == null) return;
    this._send?.({
      type: 'pane-shown',
      seq,
      ...(window != null && { window }),
    });
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
    if (!entry || this.destroyed) {
      this._acknowledge(msg.seq, msg.window);
      return;
    }
    entry.layer.setRect({ x: 0, y: 0, width: msg.width, height: msg.height });
    const shown = entry.layer.present(msg.id);
    // its ring is the pane's own ring, retired the same way
    this._acknowledge(msg.seq, msg.window);
    if (!shown) return;
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
