// Frames: asking the window's frame clock for one (through the frame pacer),
// and flush — layout, positions, the scroll blit, painting the damage.

import { addPendingFrame, clearPendingFrame } from '../../frames.js';
import { resolveFramePolicy } from '../../pacing.js';
import { paintCacheFor } from '../../paintcache.js';
import { hooks as traceHooks } from '../../trace-registry.js';
import { now } from '../animation.js';
import { FULL_DAMAGE, layoutDiff, addDamageRect } from '../damage.js';
import { BLIT_POISONED } from '../scrollblit.js';
import { debugPaint } from './debugpaint.js';

/** Frames, installed onto `WindowNode.prototype` by window.js. */
export class WindowFlush {
  /**
   * A frame, on the window's clock — after whatever wait the pacer asks
   * for (src/pacing.js). Off by default, the pacer answers "now" for one
   * property read; under an adaptive policy a claim that finds the window
   * in debt for its last frames is held on a one-shot, and every claim
   * until then folds into it. Nothing here changes what the frame paints:
   * the damage accumulates on the node exactly as it does between two
   * ticks of the clock.
   */
  _scheduleFrame() {
    // Recorded before either gate, not inside them: the debt is "this
    // window has damage", which a discrete event may pay off early (see
    // frames.js). Tying it to whether a callback is outstanding would hide
    // the second of two clicks a few milliseconds apart — the first one's
    // frame is still scheduled, so this returns here, and the early flush
    // would find nothing to paint. A held claim is a debt too: the early
    // flush paints it, and `flush` stands the wait down.
    addPendingFrame(this);
    // A claim the frame raises on itself — an animation stepping, a
    // container query settling, a promotion moving a node — is answered
    // once the frame is over, so the pacer prices the frame that raised it
    // and not the one before.
    if (this._inFlush) {
      this._claimAfterFlush = true;
      return;
    }
    if (this._scheduled) return;
    if (this._pacer.defer(() => this._requestFrame())) return;
    this._requestFrame();
  }

  /** The callback on the window's clock. */
  _requestFrame() {
    if (this._scheduled || this.destroyed || !this.window) return;
    this._scheduled = true;
    const schedule =
      typeof this.window.requestAnimationFrame === 'function'
        ? (cb) => this.window.requestAnimationFrame(cb)
        : (cb) => setImmediate(cb);
    schedule(() => {
      this._scheduled = false;
      this.flush();
    });
  }

  /**
   * The policy this window paces its frames by: the environment, then the
   * `frameRate` prop, then the root's `createRoot({ frameRate })`, then
   * `'display'` (src/pacing.js). A bad value throws here — at mount or at
   * the prop change — naming the value and the choices.
   */
  _syncFramePolicy() {
    const policy = resolveFramePolicy(
      this.props.frameRate,
      this.app,
      `<${this.kind} frameRate>`,
    );
    this._framePolicy = policy;
    this._pacer.configure(policy);
  }

  /**
   * The backend's half of a frame's cost, where it has one: the Cocoa
   * present — the swapchain flip and its catch-up copy — runs after the
   * flush returns, on the same thread, and is part of what the frame cost
   * (src/cocoa/window.js reports it). An ntk window's present is one
   * request, and reports nothing.
   */
  _notePresentCost(ms) {
    this._pacer.charge(ms);
  }

  /**
   * A frame: layout if owed, then the paint passes — or the presenter's
   * frame — then the backend's word. Runs on the window's clock through
   * `_scheduleFrame`, and early, synchronously, for a discrete input
   * (frames.js). Every route lands here, so this is where a frame is
   * priced: the pacer brackets the work, and what it cost is what the
   * next claim is judged against (src/pacing.js).
   */
  flush() {
    // Whatever this frame turns out to owe, it is this call's to pay — and
    // a window that returns below because it is destroyed or unrealized
    // owes nothing at all.
    clearPendingFrame(this);
    // …and a wait the pacer had armed for it has nothing left to wait for:
    // whichever route got here first pays the same debt.
    this._pacer.cancel();
    if (this.destroyed || !this.yoga || !this.window) return;
    const pacer = this._pacer;
    pacer.began();
    this._inFlush = true;
    let painted = false;
    try {
      painted = this._flushFrame();
    } finally {
      this._inFlush = false;
      pacer.ended(undefined, painted);
      if (this._claimAfterFlush) {
        this._claimAfterFlush = false;
        if (!this.destroyed) this._scheduleFrame();
      }
    }
  }

  /** The frame itself. True when it painted or presented something. */
  _flushFrame() {
    // A frame is scheduled a tick before it is painted, and the connection
    // can go in between: an app closing its own client, a server exit, a
    // test closing the app it lent the root. Nothing unmounts the tree on
    // that route, so the frame arrives with a live window node and a dead
    // socket, and the first request it makes throws out of the frame clock
    // where there is nothing waiting to catch it. There is no screen left to
    // paint to, so this owes nothing either.
    if (this.app?.X?._closing) return false;
    // a transientFor whose owner was not realized yet at commit time. The
    // frame after the mount is the first moment refs have attached, so the
    // common "two <window>s in one tree" case resolves here rather than
    // waiting for the app to re-render for some unrelated reason.
    if (this._pendingTransientFor !== undefined) {
      this._applyTransientFor(this._pendingTransientFor);
    }
    // A window that realized after a loop registered has one now
    if (this._loopNodes.size && !this._loopWatch) this._watchLoops();
    this._advanceAnimations(now());
    if (this.needsLayout) {
      // before `_refit` lays anything out: a pass clears yoga's record of
      // which subtrees changed, and the floors are measured from that record
      this._collectFloorStale();
      this._refit();
    }
    const width = this.window.width ?? this._requestedSize?.width ?? 0;
    const height = this.window.height ?? this._requestedSize?.height ?? 0;
    let layoutMoved = false;
    // captured before the branch clears it: whether *this* flush ran a
    // layout pass is what decides whether an anchored popup needs a look,
    // not the flag's post-pass value
    const layoutRan = this.needsLayout;
    if (this.needsLayout) {
      // From here on a claim names where its content *landed*, not where it
      // sat before the scroll — which is what decides whether a blit
      // ledger's rect moves with the shift (issue #398).
      this._laidOut = true;
      this._resolveSizeQueries(width, height);
      this._layoutStep(width, height);
      // `@container` blocks are answered by the pass, not before it, and a
      // changed answer is one more pass — before `absolutize`, so the layout
      // diff below sees one arrangement against the last frame's
      if (this._containerQueryNodes.size !== 0) {
        this._settleContainerQueries(() => this._layoutStep(width, height));
      }
      this.abs = { x: 0, y: 0, width, height };
      this._placed = true;
      // the root's rect is written here, not through _assignAbs, so its
      // cached hit reach is dropped here too (children bubble their own)
      this._hitBoundsCache = null;
      this._paintBoundsCache = null;
      // A bounded frame watches the walk: whatever this pass actually moved
      // claims its old and new rects through the sink, and the frame stays
      // a few rects instead of the whole window. An unbounded frame skips
      // the bookkeeping — it repaints everything anyway.
      if (this._damage !== FULL_DAMAGE) {
        const cap = this._damageRectCap();
        layoutDiff.sink = (rect) => {
          if (this._damage === FULL_DAMAGE) return;
          layoutMoved = true;
          this._damage = addDamageRect(this._damage, rect, cap);
        };
      }
      try {
        // `_absolutizeChildren`, not the loop it wraps: a `<window
        // style={{overflow: 'scroll'}}>` is a scroll container like any box,
        // and this is where its offset gets applied to the children
        this._absolutizeChildren(0, 0);
      } finally {
        layoutDiff.sink = null;
      }
      // …and placed nodes against the arrangement that walk produced: where
      // one goes depends on where its pane and its parent landed
      if (this._placedNodes.size !== 0) this._placeNodes();
      // A held scroll request the walk never reached goes, rather than
      // landing on some later pass. A pane no pass has placed yet keeps it:
      // its first placement is the pass it is waiting for.
      if (this._heldScrolls?.size) {
        for (const node of this._heldScrolls) {
          if (node._childOrigin != null) node._scrollToTarget = null;
        }
        this._heldScrolls.clear();
      }
      this.needsLayout = false;
      this.needsPaint = true;
      // The other half of a contained reflow: the pre-mutation arrangement was
      // claimed when the child list changed, and this is the arrangement that
      // replaced it. Claimed after layout because an inserted child has no
      // rect before it.
      for (const node of this._reflowed) {
        // …and the pre-mutation walk this frame reused goes with it
        node._reflowBefore = null;
        if (node.destroyed || this._damage === FULL_DAMAGE) continue;
        // clipped to a blitting viewport above it, like every other claim
        // this frame, and written to that viewport's ledger too (issue
        // #398): the claim would otherwise coalesce into the scroll's own
        // and be dropped with it, leaving the band the blit kept holding
        // this node's pixels from before the reflow.
        const after = node._claimBounds();
        if (!after) continue;
        const sv = node._blitViewport();
        if (sv && !sv._recordBlitClaim(after)) {
          sv._pendingBlitFrom = BLIT_POISONED;
        }
        this._damage = addDamageRect(
          this._damage,
          after,
          this._damageRectCap(),
        );
      }
      this._reflowed.clear();
    } else if (this._reflowed.size) {
      for (const node of this._reflowed) node._reflowBefore = null;
      this._reflowed.clear();
    }
    // An animated placement asked for this frame and nothing laid out: its
    // pass runs on its own, against the arrangement the last one left
    if (!layoutRan && this._placementsDue && this._placeNodes()) {
      this.needsPaint = true;
    }
    // A presenter compositing part of the tree on layers of its own — the
    // surface presenter's promoted nodes (src/cocoa/promotion.js) — gets
    // its word in here: after layout, so it sees where everything landed,
    // and before the damage is taken, so a node it moves onto or off a
    // layer claims the bitmap under it in this very frame. Feature-detected
    // like `presentFrame`; an ntk window has no such half.
    this.window.prepareFrame?.(this, layoutRan);
    // any node this pass laid out may be what an open popup is anchored to
    if (layoutRan) this._notifyAnchorChange();
    // after layout (the claims above included), before the damage is taken:
    // a frame that turns out to be a pure scroll blits the surviving band
    // and narrows its claim to the exposed strip
    this._applyScrollBlits(width, height, layoutMoved);
    // …and the next commit's claims name the arrangement this frame leaves
    // behind again, from before whatever scroll comes with them
    this._laidOut = false;
    if (!this.needsPaint) return false;
    this.needsPaint = false;
    const damage = this._takeDamage(width, height);
    if (debugPaint === 'full' && !damage && width > 0 && height > 0) {
      // Silent full-window repaints are the perf bug class this renderer
      // actually has (see AGENTS.md); this is what surfaces them. The stack
      // is the invalidate() call that made the frame unbounded, not this
      // flush — flush is always the same place.
      const cause = this._fullRepaintCause;
      console.warn(
        `react-x11: full-window repaint (${width}x${height}) ` +
          `reasons=${this._lastReasons?.join('+') || '(none)'}` +
          (cause ? `\n${cause.stack}` : ''),
      );
    }
    this._fullRepaintCause = null;
    // A retained presenter takes the frame from here: the model half above —
    // animations, layout, absolutize, the scroll offsets — is shared, and
    // what changes per backend is how a frame reaches the screen. The damage
    // list was still taken (its bookkeeping is what keeps the two paths one
    // code) and is simply not consumed; the presenter diffs at the layer.
    if (typeof this.window.presentFrame === 'function') {
      this.window.presentFrame(this, damage);
      this.app._reactX11Startup?.painted();
      return true;
    }
    if (typeof this.window.getContext !== 'function') return false; // headless mock
    // ntk getContext creates a fresh context (with window-event
    // subscriptions) on every call — cache one per window
    const ctx = (this._ctx ??= this.window.getContext('2d'));
    const frameHook = traceHooks.frame;
    const started = frameHook ? performance.now() : 0;
    if (debugPaint) this._flashTick = (this._flashTick ?? 0) + 1;
    // One pass per damage rect, and a single pass over the whole window when
    // there is no bound. Each pass clips to one rect rather than to all of
    // them at once, which is what keeps ntk's server-side rectangular-clip
    // fast path: a clip path holding several rects is not a rectangle, and
    // falls back to rasterizing a full-surface mask.
    this._paintCache ??= paintCacheFor(this.app);
    this._paintCache?.beginFrame();
    for (const rect of damage ?? [null]) {
      this._paintRegion(ctx, rect, width, height);
    }
    // after every region: an entry drawn in one damage rect must not be
    // evicted before the next rect of the same frame asks for it
    this._paintCache?.endFrame();
    // The swapchain seam: a backend presenting from double buffers has to
    // know exactly which pixels each flush touched — several flushes can
    // land between two presents, so reading only the last frame's rects
    // would leave the flipped-in back buffer stale where an earlier flush
    // painted. Feature-detected like presentFrame; null means everything.
    this.window.noteFrameDamage?.(damage ?? null);
    if (frameHook) {
      frameHook({
        root: this,
        rects: damage,
        reasons: this._lastReasons,
        start: started,
        end: performance.now(),
        // ntk's `frameLatency`: how long the previous frame took to be
        // answered. On the vertical-blank clock that is time-to-display and
        // reads about a refresh period; on the fence clock it is the server
        // round trip that drained the frame's requests. Client work and
        // server work separate cleanly in a trace only when both are in it —
        // a slow virtualized GPU shows up here, not in `end`.
        landed: this.window.frameLatency,
        // how long the pacer held this frame's claim, ms; 0 when it did not
        waited: this._pacer.pendingWait,
      });
    }
    // A frame that actually painted, which is the moment the app is up
    // (src/startup.js). One property read once the sequence is over — the
    // session clears itself off the app — which is the same bargain the
    // trace hook above makes with the frame loop.
    this.app._reactX11Startup?.painted();
    return true;
  }
}
