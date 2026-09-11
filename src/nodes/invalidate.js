// Invalidation: what a node damages when it changes, and how far its paint
// reaches (paint bounds, the opaque rect). WindowNode's half is the other
// end: how a window takes that damage in and clamps it to a frame.

import {
  FULL_DAMAGE,
  NO_DAMAGE,
  DAMAGE_SLOP,
  NO_BOUNDS_CACHE,
  INVALIDATE_REASONS,
  EMPTY_REASONS,
  MAX_DAMAGE_RECTS,
  addDamageRect,
  damageToPaint,
} from './damage.js';
import { insetRect, unionRect, rectsBounds, rectsOverlap } from './rects.js';
import { BLIT_POISONED } from './scrollblit.js';
import { DEV } from './util.js';
import { debugPaint } from './window/debugpaint.js';

/** Node's half of invalidation, installed onto `Node.prototype` by node.js. */
export class NodeInvalidate {
  /**
   * Ask the owning window to repaint. The damage lives on the window node,
   * which is the only node with a frame clock — this forwards there, so an
   * element says `this.invalidate(false, this, 'props')` and never has to
   * know that. Overridden by WindowNode, which *is* the collector.
   *
   * `damage` is the node or rect that changed. Passing one is the difference
   * between repainting a control and repainting the window, and `this` is
   * almost always the right answer (docs/extending.md). Before the node is
   * attached there is no window and nothing on screen, so this is a no-op —
   * the mount invalidates in full anyway.
   */
  invalidate(layoutChanged = false, damage = null, reason = null) {
    // a layout change may grow what an enclosing scroll pane has to scroll,
    // through a route yoga never sees (issue #405)
    if (layoutChanged) this._markScrollMeasureDirty();
    // a node that says its appearance changed may have changed how far it
    // reaches — a shadow, an outline, a scene element's ink — so its cached
    // paint reach goes with the claim
    if (damage === this || damage === null) this._clearPaintBounds();
    this.root?.invalidate(layoutChanged, damage, reason);
  }

  /**
   * The rect this paint pass is repainting, or null when it is repainting
   * the whole window — and null outside a paint, which reads the same way:
   * nothing is bounding you, so draw everything (issue #301).
   *
   * The other end of `invalidate`. A frame repaints one damage rect per
   * pass, clipped to it and with whole subtrees outside it culled, so an
   * element whose node *is* one node — a `<box>`, a `<text>` — never needs
   * this: being painted at all already means it is inside. An element that
   * draws a **scene** into one node does: without it, a `<flow>` handed a
   * pass over the 80×40 box a dragged node moved through redraws all three
   * hundred nodes, all seven hundred edges, the grid and the minimap into a
   * clip that throws almost all of it away. With it, the element culls the
   * same way core culls the tree.
   *
   * Window coordinates, the same space as `abs`, `contentBox()` and an
   * event's `x`/`y`. Read-only, like `abs`: it is this frame's own rect and
   * the clip is already set from it.
   *
   * Never inside `paintCached`, which draws into a surface in its own
   * coordinates: a cached copy culled against the window's damage is stored
   * half-drawn under a key claiming it is whole, and every later frame that
   * hits the key gets the hole.
   */
  paintDamage() {
    return this.root?._paintDamage ?? null;
  }

  /**
   * The rect this element writes opaque pixels over on every paint — in
   * window coordinates like `abs`, in whole pixels — or null, the default,
   * which promises nothing.
   *
   * What it buys: a pass that lies inside it is painted without the fills
   * that would be under it — the window's background, this node's own and
   * every ancestor's — because not one of those pixels survives. On the
   * Cocoa backend those fills are full-area CoreGraphics passes, and for a
   * streaming terminal they were a fifth of the frame; on X11 they are
   * composites the server ran for nothing. An element with a retained
   * surface it draws whole — a terminal, a media frame, a chart — answers
   * with the rect it covers, and claims its damage as a **rect inside it**
   * rather than as the node: a node claim is inflated by a pixel of slop,
   * which is outside the rect and so never covered.
   *
   * The promise is the element's to keep: every pixel of the rect, alpha
   * one, on every paint of this node, whatever the props. A translucent
   * element, or one that draws a background only sometimes, answers null.
   * The answer is read at paint time, so it may follow `contentBox()`, and
   * a fractional edge is not opaque — core takes the whole pixels inside.
   */
  opaqueRect() {
    return null;
  }

  /**
   * A layout-affecting change confined to this node: claim the subtree as
   * it stands now, and queue it for a second claim once layout has run —
   * the same before/after protocol `_childListChanged` uses. Anything
   * *else* the reflow displaces claims itself through the layout diff in
   * `flush()`, so the frame stays bounded instead of collapsing to
   * FULL_DAMAGE the way a bare `invalidate(true, null)` would.
   */
  _invalidateLayout(reason) {
    this._markScrollMeasureDirty();
    const root = this.root;
    if (!root) return;
    // Same walk, same frame, same answer — see `_childListBefore`, whose
    // record this shares so that a reflow and a child-list change on one
    // node in one frame walk the subtree once between them.
    root.invalidate(true, this._childListBefore(), reason);
    root._reflowed.add(this);
  }

  /**
   * The region this node can put ink in: its own rect unioned with every
   * descendant's. Not the same as `abs` — a child of a node that does not
   * clip may stick out of it (absolute positioning, a negative margin), and
   * culling a subtree by the parent's rect alone would drop that child's
   * paint. Recomputed on demand rather than cached in `absolutize`, because
   * it is only ever asked for on the handful of nodes that invalidate.
   */
  paintBounds() {
    const bounds = this._subtreeBounds();
    // inflated once, here — doing it inside the recursion would compound the
    // slop by one pixel per level of nesting
    return {
      x: bounds.x - DAMAGE_SLOP,
      y: bounds.y - DAMAGE_SLOP,
      width: bounds.width + DAMAGE_SLOP * 2,
      height: bounds.height + DAMAGE_SLOP * 2,
    };
  }

  /**
   * How far this node's drawing actually reaches, itself and its descendants.
   *
   * A node that clips its children ends the walk at its own rect: whatever
   * they do beyond it never reaches the surface, so counting it would inflate
   * every bound built from here. That matters most for a scrolling box, whose
   * content is routinely thousands of pixels taller than the viewport — and
   * can be ninety thousand pixels away mid-scroll (see `_offscreen`). Without
   * this, damage claimed for a scrolled subtree covers the content extent
   * instead of the viewport, and culling tests against a rect that misses
   * almost nothing.
   */
  _subtreeBounds() {
    // Cached like the hit reach (`_hitBounds`), and for the same reason: a
    // bounded frame asks every subtree on the way to its rect whether it
    // reaches in, and answering by walking the subtree made a one-cell
    // repaint cost the whole tree — a millisecond at four thousand nodes,
    // five at fourteen thousand, every frame. The cache is dropped up the
    // chain by whatever changes a reach: a rect assigned by layout, a
    // child list mutation (`_clearHitBounds`), and every change a node
    // announces about itself (`invalidate`, `setStyleState`) — so a stale
    // answer would need a change nobody announced, which is already a
    // repaint bug.
    const cached = this._paintBoundsCache;
    if (cached && !NO_BOUNDS_CACHE) return cached;
    let bounds = this._ownPaintBounds();
    if (!this.clipsChildren()) {
      for (const child of this.children) {
        if (child.isWindow || !child.yoga || child.hidden) continue;
        if (child.style?.display === 'none') continue;
        bounds = unionRect(bounds, child._subtreeBounds());
      }
    }
    this._paintBoundsCache = bounds;
    return bounds;
  }

  /**
   * This node's paint reach changed: drop the cached union here and up the
   * chain, stopping where `_clearHitBounds` stops and for the same reasons
   * — a clipping ancestor's reach is its own rect, and an ancestor already
   * cleared has cleared the rest of the way up.
   */
  _clearPaintBounds() {
    this._paintBoundsCache = null;
    for (let n = this.parent; n; n = n.parent) {
      if (n.clipsChildren() || n._paintBoundsCache === null) return;
      n._paintBoundsCache = null;
    }
  }

  /**
   * This node's own rect, grown by anything it draws outside it — the
   * outline and the shadow, the only two. Per node rather than once at the
   * top, because either can belong to any node and the bound has to cover it
   * wherever it is; and the outline is counted even when the ring is
   * currently *off*, because the frame that erases it is claimed after the
   * state has already flipped back.
   *
   * A shadow cannot afford that trick — its extent is whatever the style
   * says rather than a theme constant, so inflating for one that is not
   * there would widen the claim of every node that has ever hovered. The
   * frame that *removes* a shadow claims the old extent from `_retarget`
   * instead, where both the old style and the new one are in hand.
   */
  _ownPaintBounds() {
    const extent = Math.max(this._outlineExtent(), this._shadowExtent());
    if (extent <= 0) return this.abs;
    return {
      x: this.abs.x - extent,
      y: this.abs.y - extent,
      width: this.abs.width + extent * 2,
      height: this.abs.height + extent * 2,
    };
  }
}

/** WindowNode's half of invalidation, installed onto `WindowNode.prototype` by window/window.js. */
export class WindowInvalidate {
  /**
   * Mark the window as needing work before the next frame.
   *
   * `damage` is an optional node whose *appearance* changed, and it is what
   * turns a full-window repaint into a partial one: the frame then repaints
   * only the region that node covers, and skips emitting drawing for
   * everything outside it. Two rules keep that safe:
   *
   *  - a layout change gets no damage bound. Layout can move anything, and
   *    a node that moved leaves stale pixels behind at its old rect, which
   *    the new rect does not cover;
   *  - a caller that names no node means "something, somewhere", so it also
   *    repaints in full. Partial painting is therefore opt-in per call
   *    site, and forgetting to pass a node costs speed rather than
   *    correctness.
   *
   * `reason` is one word from INVALIDATE_REASONS saying *why* — purely
   * diagnostic, collected per frame into `_lastReasons` so the frame log,
   * REACT_X11_DEBUG_PAINT=full and the tracer can attribute a repaint.
   * Omitting it costs nothing but attribution.
   */
  invalidate(layoutChanged, damage = null, reason = null) {
    if (this.destroyed || !this.window) return;
    if (!layoutChanged && damage === NO_DAMAGE) {
      // Nothing this node draws changed, so it contributes no region — and
      // contributing *nothing* is not the same as contributing "unknown".
      // Returning before `needsPaint` is what makes the difference: a commit
      // in which every node says this schedules no frame at all, where
      // falling through would have marked the window dirty with no region
      // recorded and so repainted all of it. That is the common case for a
      // React re-render whose output is identical — hovering a control whose
      // hover state it does not actually use, for instance. Whoever did
      // change records its own region and schedules its own frame.
      return;
    }
    if (reason) {
      if (DEV && !INVALIDATE_REASONS.has(reason)) {
        console.warn(
          `react-x11: invalidate() got unknown reason ${JSON.stringify(reason)}`,
        );
      }
      (this._frameReasons ??= new Set()).add(reason);
    }
    // A retained presenter keeps a per-node diff instead of damage rects,
    // and this is the one channel every change already announces itself on
    // (docs/macos.md §"One renderer, two presenters"). Feature-detected: an
    // ntk window has no ear here and the X11 path is byte-identical. A
    // presenter that answers `true` has taken the claim onto a layer of its
    // own (src/cocoa/promotion.js): the bitmap owes nothing for it, and the
    // frame that is still owed — for the presenter's half, `prepareFrame` —
    // paints nothing unless something else claims.
    const taken =
      this.window?.noteInvalidate?.(damage, layoutChanged, reason) === true;
    if (taken && !layoutChanged) {
      this._damage ??= [];
      this.needsPaint = true;
      this._scheduleFrame();
      return;
    }
    if (layoutChanged) {
      this.needsLayout = true;
      // The content floors are measured from the tree, so anything that
      // changed it has to give them up — and **scrolling does not**, which is
      // the whole reason this is not just `needsLayout`: a scroll moves an
      // offset applied during `absolutize` and leaves every yoga node exactly
      // as it was, at input rate, on the biggest trees in any app.
      if (reason !== 'scroll') this._floorsDirty = true;
      if (reason !== 'scroll' && reason !== 'resize') {
        this._floorsContentDirty = true;
      }
    }
    // A layout change with no bound named repaints everything, because a
    // reflow can move any node and one that moved leaves stale pixels at a
    // rect its new position does not cover. Naming a node alongside
    // `layoutChanged` is an assertion by the caller that the change is
    // confined to that node's subtree *and* that the node clips its children,
    // so both the old and the new position of anything that moved are inside
    // the bound. Scrolling is the case that matters: it reflows a viewport's
    // contents and nothing else, and it happens at input rate.
    if (!damage && this._damage !== FULL_DAMAGE && debugPaint === 'full') {
      // This call is what makes the coming frame unbounded, so this stack —
      // not flush's — is the one that answers "who repainted the window".
      // Captured only under the debug switch: stacks are not free.
      this._fullRepaintCause = {
        reason: reason ?? '(no reason given)',
        stack: new Error('invalidated here').stack,
      };
    }
    // A claim near a viewport that is waiting to blit makes that frame no
    // longer a pure scroll — checked here, at claim time, because once the
    // rects coalesce a change inside the viewport is indistinguishable from
    // the scroll's own claim. (Unbounded claims need no check: FULL_DAMAGE
    // fails the blit's damage gate by itself.)
    // The region this claim actually covers — a node's paint reach, clipped
    // to a blitting viewport above it (issue #398), or the bare rect a
    // caller handed over. Null when the clip left nothing (the node draws
    // where nothing can be seen, so it owes no pixels), and null on a frame
    // that is already unbounded, which owes neither a rect nor the subtree
    // walk that measures one — a blit cannot fire there either.
    const bounds =
      damage && damage !== NO_DAMAGE && this._damage !== FULL_DAMAGE
        ? damage._claimBounds
          ? damage._claimBounds()
          : damage
        : null;
    const pendingScrolls = this._pendingScrolls;
    if (pendingScrolls?.size && bounds && this._scrollClaim !== damage) {
      const rect = bounds;
      for (const sv of pendingScrolls) {
        // An element blitting a region of its own drawing (issue #303) is
        // waiting on that region, not on the whole node it lives in — and
        // it is waiting on it *exactly* (issue #309). Its claim is the rect
        // itself, and `_blitKeptDamage` recognises it as the rect itself, so
        // a foreign claim that could be swallowed by it has to overlap it:
        // the ring outside is beyond reach. A scroll container's claim is
        // its viewport plus slop and is recognised to that tolerance, so a
        // claim in that ring *can* merge into it without ever touching the
        // viewport — and the wider zone is what keeps it out.
        //
        // The difference is what lets an element carve furniture out of the
        // rect it blits — a minimap pinned to a corner, a strip it repaints
        // itself — and keep the pan at blit cost while that furniture
        // claims beside it.
        const contents = sv._pendingBlitContents;
        const waiting = contents
          ? contents.rect
          : sv.abs && insetRect(sv.abs, -(DAMAGE_SLOP * 2 + 1));
        if (!waiting || rectsOverlap(rect, waiting)) {
          // …unless this viewport is keeping a ledger of what changed
          // inside it (issue #398): the region goes in the ledger and
          // `_applyScrollBlits` repaints it after the blit, which is the
          // same pixels on screen for a fraction of the drawing. The
          // ledger says no when the frame stops paying, and then this
          // falls through to the poison exactly as before.
          if (sv._blitLedgerOpen() && sv._recordBlitClaim(rect)) {
            continue;
          }
          // Poison rather than disarm (react-x11#295): a null here would
          // let a second scrollTo in the same frame re-arm from a
          // mid-frame origin, and the blit would then move pixels that
          // were never repainted at that origin — a band displaced by the
          // first scroll's delta. The node stays in pendingScrolls so the
          // up-front clear in _applyScrollBlits resets the poison exactly
          // like a real origin.
          sv._pendingBlitFrom = BLIT_POISONED;
        }
      }
    }
    if (layoutChanged && !damage) this._damage = FULL_DAMAGE;
    else if (!layoutChanged && !damage) this._damage = FULL_DAMAGE;
    else if (!bounds) {
      // A layout change that names no region: either NO_DAMAGE, from a
      // caller with a finer claim already in flight, or a node whose reach
      // a clipping ancestor left nothing of (issue #398). Unlike `!damage`
      // neither is "something, somewhere", so neither costs a full repaint.
    } else if (this._damage !== FULL_DAMAGE) {
      // a node, or a bare rect for a caller that has a region rather than a
      // node — a subtree that is about to be removed, say. Claims accumulate
      // as a list of rects rather than one box around them all, so two changes
      // at opposite corners of the window no longer repaint everything
      // between them.
      this._damage = addDamageRect(this._damage, bounds, this._damageRectCap());
    }
    this.needsPaint = true;
    this._scheduleFrame();
  }

  /**
   * The rects this frame will repaint, or null for the whole window.
   *
   * Clamped to the window: damage is recorded when a node invalidates, and
   * the window may have been resized since. A region that no longer
   * intersects the window means there is nothing to do, but the frame still
   * has to clear the flag, so it degrades to a full repaint rather than
   * painting nothing.
   */
  /**
   * How many rects a frame's damage may hold before `addDamageRect` merges
   * the closest pair. Four on X11 (`MAX_DAMAGE_RECTS`), where every pass
   * costs the server a clip mask; a backend whose pass is a client-side
   * clip and a culled walk says so on its window (`damageRectCap`) and
   * keeps more of them — a clock, a graph and a status row ticking in one
   * frame stay three small rects instead of the box around all three.
   */
  _damageRectCap() {
    const cap = this.window?.damageRectCap;
    return Number.isInteger(cap) && cap > 0 ? cap : MAX_DAMAGE_RECTS;
  }

  _takeDamage(width, height) {
    const damage = this._damage;
    this._damage = null;
    // what the frame about to run settled on, for the tests and for
    // REACT_X11_DEBUG_LAYOUT to report; null means it repainted everything.
    // `_lastDamage` is the box around the rects, which is what a caller
    // wanting one number for "where did this frame paint" means by it.
    // `_lastReasons` is why: every reason invalidate() was given since the
    // previous frame, for the frame log and the full-repaint warning.
    this._lastDamage = null;
    this._lastDamageRects = null;
    const reasons = this._frameReasons;
    if (reasons?.size) {
      this._lastReasons = [...reasons];
      reasons.clear();
    } else {
      this._lastReasons = EMPTY_REASONS;
    }
    if (damage === FULL_DAMAGE || !damage) return null;
    // an empty list: every claim this frame made was answered on a layer of
    // its own (`invalidate`, the presenter's `true`), and the bitmap paints
    // nothing — which is not the same as nothing having been claimed
    if (damage.length === 0) {
      this._lastDamageRects = [];
      this._lastDamage = { x: 0, y: 0, width: 0, height: 0 };
      return [];
    }
    const rects = [];
    for (const claimed of damage) {
      const clamped = this._clampDamage(claimed, width, height);
      // one claim covering the window makes the whole frame unbounded, so
      // there is nothing to learn from the rest of the list
      if (clamped === FULL_DAMAGE) return null;
      if (clamped) rects.push(clamped);
    }
    if (!rects.length) return null;
    this._lastDamageRects = damageToPaint(rects);
    this._lastDamage = rectsBounds(this._lastDamageRects);
    return this._lastDamageRects;
  }

  /**
   * One claimed rect snapped to whole pixels inside the window: null when
   * nothing of it is left, `FULL_DAMAGE` when it covers the window.
   */
  _clampDamage(damage, width, height) {
    const x = Math.max(0, Math.floor(damage.x));
    const y = Math.max(0, Math.floor(damage.y));
    const right = Math.min(width, Math.ceil(damage.x + damage.width));
    const bottom = Math.min(height, Math.ceil(damage.y + damage.height));
    if (right <= x || bottom <= y) return null;
    // covering the window is the same as not being bounded at all, and the
    // full path is one fill instead of a clip plus a fill
    if (x === 0 && y === 0 && right >= width && bottom >= height) {
      return FULL_DAMAGE;
    }
    return { x, y, width: right - x, height: bottom - y };
  }
}
