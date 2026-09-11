// A window anchored to a rect in another (#255, #280): where it goes, and
// following the anchor as it moves.

import { anchorOffscreen, anchorRect } from '../../anchor.js';

/** Anchoring, installed onto `WindowNode.prototype` by window.js. */
export class WindowAnchoring {
  // --- anchoring ----------------------------------------------------------
  //
  // A `<popup anchor={{to: ref, …}}>` works out its own position, because it
  // is the only thing that can: with `width="auto"` the size is settled
  // inside `realize()`, between `_measure()` and `CreateWindow`, which is
  // after the last moment React could have computed a rect for it — and the
  // placement *needs* the size, since which side it flips to and how far it
  // is pulled back from an edge are both functions of how big it is.
  //
  // So the same order the natural size already established: measure, place,
  // create. The popup is born the right size **and** in the right place,
  // rather than mapped somewhere provisional and corrected a frame later.
  // A widget that knows its own size has no such problem and stays on
  // `useAnchor` / `useAnchorTracking`; both call the same functions
  // (src/anchor.js), so the two agree by construction.

  /** A `to`/`alignTo` in an `anchor` prop: a ref, or the node itself. */
  _anchorTarget(target) {
    if (target == null || typeof target !== 'object') return null;
    const node = target.abs ? target : target.current;
    return node?.abs ? node : null;
  }

  /** Where this window goes at `size`, or null when there is nothing to
   *  anchor to yet — a ref whose node has not been laid out. */
  _anchorPlacement(size) {
    const anchor = this.props.anchor;
    const node = this._anchorTarget(anchor?.to);
    if (!node) return null;
    // `anchorRect` is public API and speaks logical pixels on both sides;
    // this caller's `size` came from `_measure` (device) and its result is
    // headed for CreateWindow (device), so both convert here.
    const s = this.scale;
    const rect = anchorRect(node, {
      ...anchor,
      alignTo: this._anchorTarget(anchor.alignTo) ?? undefined,
      width: size.width / s,
      height: size.height / s,
    });
    if (!rect || s === 1) return rect;
    return {
      ...rect,
      x: Math.round(rect.x * s),
      y: Math.round(rect.y * s),
      width: Math.round(rect.width * s),
      height: Math.round(rect.height * s),
    };
  }

  /**
   * Keep an anchored window over the thing it points at: the trigger's own
   * layout moving, an ancestor of it scrolling, the owner window being
   * dragged, or this window's content changing size under it.
   *
   * The first three arrive through the *owner* window's `onAnchorChange`
   * (`_watchAnchor`) — the same signal `useAnchorTracking` reads, since it
   * is the same set of things that can move a trigger. The fourth is
   * `_refit`, which knows the new size before the server does.
   *
   * **Out of view is not a position.** A popup is a real X window, not a
   * web element its ancestors clip, so a caret that has scrolled out of the
   * editor leaves a completion list floating over a document it no longer
   * points into. There is no placement that fixes that, so the window is
   * unmapped for as long as the anchor is gone and mapped again where it
   * belongs when it comes back — the one answer the renderer can give on
   * its own, since whether the popup should *close* is React state and
   * therefore the application's. (An app that would rather close it keeps
   * `useAnchorTracking`'s `onOutOfView`, which is exactly that seam.)
   */
  _followAnchor(size = this._requestedSize) {
    if (this.destroyed || !this.window || !this.props.anchor) return;
    const node = this._anchorTarget(this.props.anchor.to);
    // A ref that has not attached yet counts as gone, and for the same
    // reason: there is nowhere for the popup to be. Refs attach in the
    // commit phase a popup realizes in, so one written *above* its own
    // trigger in the JSX gets a frame of this — and waiting it out is
    // better than a frame in the corner of the screen.
    const lost = !node || anchorOffscreen(node, this.props.anchor.at);
    if (lost !== Boolean(this._anchorLost)) {
      this._anchorLost = lost;
      // The grab goes with it and comes back with it. X releases a pointer
      // grab whose window stops being viewable, so a menu that hid and
      // reappeared would be one no press outside could dismiss — the
      // `onDismiss` that reads as "click anywhere to close" would simply
      // stop happening. The re-take is `PopupNode._mapNow`'s, which is what
      // keeps it beside the map on every route back to the screen.
      if (lost) {
        if (this.props.grab) this.window.ungrabPointer?.();
        this.window.unmap?.();
      } else {
        this._mapNow();
      }
    }
    if (lost || !size) return;
    const rect = this._anchorPlacement(size);
    if (!rect) return;
    if (this._placedAt?.x === rect.x && this._placedAt?.y === rect.y) return;
    this._placedAt = { x: rect.x, y: rect.y };
    if (typeof this.window.setState === 'function') {
      this.window.setState({ x: rect.x, y: rect.y });
    } else {
      this.window.move?.(rect.x, rect.y);
    }
  }

  /**
   * Subscribe to whatever can move the anchor. On the **owner's** window,
   * not on this one: what moves is the trigger, and this window's own
   * layout passes say nothing about where it sits on screen.
   */
  _watchAnchor() {
    this._unwatchAnchor();
    if (!this.props.anchor) return;
    // The anchor's own window where the ref has attached, and the window
    // this popup was *written into* otherwise — which is the same one in
    // every case that matters, and is what makes an unattached ref a
    // one-frame wait rather than a popup nothing ever notifies again. The
    // notification is only ever a prompt to re-measure, so subscribing to a
    // window the anchor turns out not to be in costs a no-op.
    const root =
      this._anchorTarget(this.props.anchor.to)?.root ?? this.parent?.root;
    if (!root?.onAnchorChange || root === this) return;
    this._anchorWatch = root.onAnchorChange(() => this._followAnchor());
  }

  _unwatchAnchor() {
    this._anchorWatch?.();
    this._anchorWatch = null;
  }

  /**
   * Subscribe to "something this window's popups might be anchored to just
   * moved" — a real layout pass (a trigger's own position changing: text
   * wrapping, a sibling growing, an ancestor viewport scrolling — scroll
   * offset is applied during absolutize, so it is a layout change too) or a
   * fresh `_screenOrigin` (the window manager or a script moving this window).
   * Returns an unsubscribe function.
   *
   * Event-driven off the same signals `flush()` and `_refreshScreenOrigin()`
   * already track internally, rather than a polling loop: costs nothing
   * between real changes, and `useAnchor`'s tracking hook (`anchor.js`) is
   * what turns this into a popup that follows its trigger instead of hanging
   * over stale ground once opened.
   */
  onAnchorChange(cb) {
    (this._anchorListeners ??= new Set()).add(cb);
    return () => this._anchorListeners?.delete(cb);
  }

  _notifyAnchorChange() {
    if (!this._anchorListeners?.size) return;
    for (const cb of this._anchorListeners) cb();
  }
}
