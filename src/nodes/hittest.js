// Hit testing, and the geometry a node reports about itself: containsPoint
// with and without slop, hitTest down the paint order, getClientRects, and
// the box-model measure DevTools reads.

import { resolveHitSlop } from '../styles.js';

/** Hit testing, installed onto `Node.prototype` by node.js. */
export class NodeHitTest {
  containsPoint(x, y) {
    return (
      x >= this.abs.x &&
      y >= this.abs.y &&
      x < this.abs.x + this.abs.width &&
      y < this.abs.y + this.abs.height
    );
  }

  /**
   * The same test grown by `hitSlop`. Deliberately separate from
   * `containsPoint`: slop belongs to *this* node's target and nothing else,
   * so it must not widen the rect that clips this node's children, must not
   * reach `paintBounds`, and must never touch yoga. A 16px slider with 4px
   * of slop top and bottom is a 24px target that still draws 16px tall,
   * which is the whole point — WCAG 2.2 SC 2.5.8 without a redesign.
   *
   * The slop can overlap a sibling's box. Hit testing is front-to-back over
   * paint order, so the sibling on top keeps its own pixels either way.
   */
  containsPointWithSlop(x, y) {
    if (this.containsPoint(x, y)) return true;
    const slop = resolveHitSlop(this.style.hitSlop);
    if (!slop) return false;
    return (
      x >= this.abs.x - slop.left &&
      y >= this.abs.y - slop.top &&
      x < this.abs.x + this.abs.width + slop.right &&
      y < this.abs.y + this.abs.height + slop.bottom
    );
  }

  /** DOM-ish rect accessor. React DevTools' Highlighter requires host
   * instances to expose getClientRects() with a non-empty rect before it
   * emits showNativeHighlight — without this, hovering the tree silently
   * no-ops. Anything with getClientRects is also measured at mount via
   * `instance.ownerDocument.documentElement` (see ownerDocument below). */
  getClientRects() {
    const r = this.abs;
    if (!(r.width > 0 || r.height > 0)) return [];
    // `abs` is device pixels; this is public API, which is logical — the
    // same conversion events make on the way out (src/scale.js)
    const s = this.scale;
    return [
      {
        x: r.x / s,
        y: r.y / s,
        left: r.x / s,
        top: r.y / s,
        width: r.width / s,
        height: r.height / s,
        right: (r.x + r.width) / s,
        bottom: (r.y + r.height) / s,
      },
    ];
  }

  /**
   * React Native's measure contract, which is what DevTools' style editor
   * calls to draw the box model beside the style it is editing:
   * `(x, y, width, height, left, top)` — position within the parent, size,
   * then position within the window. A node with no laid-out rect calls
   * back with nothing, the "unmeasurable" answer the editor checks for.
   */
  measure(callback) {
    if (typeof callback !== 'function') return;
    const r = this.abs;
    if (!(r.width > 0 || r.height > 0)) {
      callback();
      return;
    }
    const s = this.scale;
    const parent = this.parent?.abs;
    callback(
      (parent ? r.x - parent.x : r.x) / s,
      (parent ? r.y - parent.y : r.y) / s,
      r.width / s,
      r.height / s,
      r.x / s,
      r.y / s,
    );
  }

  /**
   * The rect a hit anywhere in this subtree must fall inside: this node's
   * rect grown by its own hitSlop, unioned with every child's reach —
   * except under a clipping node, whose children can only be hit while the
   * point is inside its rect (hitTest never descends from outside one).
   *
   * A conservative superset, and only ever that: hidden and
   * pointerEvents-none subtrees are counted anyway, and nothing shrinks a
   * cached bound before the next invalidation. A bound too big costs a
   * walk; one too small would drop real input. Every change that can
   * *grow* the true reach funnels through `_clearHitBounds`: `_assignAbs`
   * for whatever layout moves (mounts, reveals and scrolls all change
   * `abs`), `_retarget` for `hitSlop` and `overflow`, `_childListChanged`
   * for a subtree attached with its rect already laid out, and `flush`
   * for the root's own rect, which is written without `_assignAbs`.
   */
  _hitBounds() {
    let b = this._hitBoundsCache;
    if (b) return b;
    const abs = this.abs;
    const slop = resolveHitSlop(this.style.hitSlop);
    let left = abs.x;
    let top = abs.y;
    let right = abs.x + abs.width;
    let bottom = abs.y + abs.height;
    if (slop) {
      left -= slop.left;
      top -= slop.top;
      right += slop.right;
      bottom += slop.bottom;
    }
    if (!this.clipsChildren()) {
      for (const child of this.children) {
        if (child.isWindow || !child.yoga) continue;
        const cb = child._hitBounds();
        if (cb.left < left) left = cb.left;
        if (cb.top < top) top = cb.top;
        if (cb.right > right) right = cb.right;
        if (cb.bottom > bottom) bottom = cb.bottom;
      }
    }
    b = { left, top, right, bottom };
    this._hitBoundsCache = b;
    return b;
  }

  /**
   * This node's reach changed: drop the cached bounds here and up the
   * chain of ancestors whose unions embed them. The walk stops at a
   * clipping ancestor — its reach is its own rect, so nothing below it
   * changes what it or anything above it reports — or at one already
   * invalid, whose own clear walked the rest of the way up.
   */
  _clearHitBounds() {
    // what moves a hit reach moves the paint reach — first, because the
    // walk below returns from wherever it finds an ancestor already clear
    this._clearPaintBounds();
    this._hitBoundsCache = null;
    for (let n = this.parent; n; n = n.parent) {
      if (n.clipsChildren() || n._hitBoundsCache === null) return;
      n._hitBoundsCache = null;
    }
  }

  /** Front-to-back hit test. Returns the deepest hit node or null. */
  hitTest(x, y) {
    if (
      this.hidden ||
      this.style.display === 'none' ||
      this.style.pointerEvents === 'none'
    ) {
      return null;
    }
    // nothing in this subtree reaches the point: skip it whole, children
    // and all — this is what keeps a motion event from walking every node
    // in the window (issue #188)
    const b = this._hitBounds();
    if (x < b.left || y < b.top || x >= b.right || y >= b.bottom) {
      return null;
    }
    const inside = this.containsPoint(x, y);
    // the children are culled on the strict rect — slop grows this node's
    // target, not the region its clip lets through
    if (!inside && this.clipsChildren()) {
      return this.containsPointWithSlop(x, y) ? this : null;
    }
    const order = this.paintOrder();
    for (let i = order.length - 1; i >= 0; i--) {
      const hit = order[i].hitTest(x, y);
      if (hit) return hit;
    }
    return inside || this.containsPointWithSlop(x, y) ? this : null;
  }
}
