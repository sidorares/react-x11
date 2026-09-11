// The Scrollable mixin: `overflow: 'scroll'` with the wheel, the keys, the
// bars and the a11y role wired. <box> and <window> use it, and a registered
// element can too — `class MyPane extends Scrollable(Node)`.

import { Yoga } from '../yoga.js';
import { WHEEL_NOTCH_PX } from '../events.js';
import { callHandler } from '../errors.js';
import {
  XK_HOME,
  XK_LEFT,
  XK_UP,
  XK_RIGHT,
  XK_DOWN,
  XK_PAGE_UP,
  XK_PAGE_DOWN,
  XK_END,
  XK_SPACE,
} from '../keysyms.js';
import { DAMAGE_SLOP, layoutDiff } from './damage.js';
import { describeSize, offsetInParent } from './layout.js';
import { insetRect, intersectRects, rectsOverlap } from './rects.js';
import {
  SCROLLBAR_WIDTH,
  scrollbarGeometry,
  along,
  scrollbarHit,
  paintScrollbarThumb,
} from './scrollbars.js';
import { BLIT_POISONED } from './scrollblit.js';

const clampScroll = (v, max) => Math.min(Math.max(0, v), max);

/**
 * One axis of a scroll request held for a pass
 * (`Scrollable._holdScrollTo`): `{ base, steps }`, the request the extent in
 * hand could not answer and the relative ones made after it. `to` is the new
 * request on this axis (null leaves the axis alone), `step` its delta when
 * it was relative.
 */
function holdAxis(held, to, step, owed, max) {
  if (to == null) return held ?? null;
  if (held && step != null) {
    return { base: held.base, steps: [...held.steps, step] };
  }
  return owed && to > max ? { base: to, steps: [] } : null;
}

/** Where a held axis lands against the extent a pass measured: the base,
 *  clamped, then each step from there, clamped in turn — the answers a pane
 *  that already had this extent would have given one request at a time. */
function replayHeld({ base, steps }, max) {
  let at = clampScroll(base, max);
  for (const step of steps) at = clampScroll(at + step, max);
  return at;
}

// Every box and every window now answers `_scrollbars()`, and almost none of
// them has any: the shared empty keeps that answer allocation-free on a path
// walked per node per hit test.
const EMPTY_SCROLLBARS = Object.freeze([]);

/**
 * Scrolling, as a style rather than as a species of node.
 *
 * `overflow: 'scroll'` turns a `<box>` — or a `<window>` — into a clipped
 * viewport over its own overflowing content: the offset is applied during
 * absolutize, so painting and hit testing see already-shifted rects. Wheel
 * events scroll the nearest one by default (see EventManager), and
 * `scrollTo`/`scrollBy`/`scrollIntoView` are on the ref.
 *
 * Everything here is **inert until the style says scroll**, which is what
 * lets it live on the ordinary container instead of behind an element of its
 * own: `_maxScroll` answers 0, so `scrollTo` is a no-op, no bar has geometry,
 * nothing is a tab stop, and `absolutize` takes the plain path. A second gate
 * sits behind the first — most of the visible behaviour also asks whether
 * there is anything to scroll *right now* — so a viewport whose content fits
 * really is an ordinary clipped box, and grows a thumb and a tab stop the
 * moment its content outgrows it.
 *
 * A mixin rather than a base class because the two elements that scroll do
 * not share one: `<box>` extends Node directly and `<window>` is its own
 * world. Deliberately not on Node itself — `<textinput>`/`<textarea>` carry
 * their own `_scrollbar` and `focusableByDefault` with different meanings,
 * and inheriting these would collide with both.
 */
export const Scrollable = (Base) =>
  class extends Base {
    constructor(...args) {
      super(...args);
      this.scrollY = 0;
      this.scrollX = 0;
      this.contentHeight = 0;
      this.contentWidth = 0;
      // `measureScrollContent` owed a fresh answer — true until the first
      // layout pass measures, and re-raised by any change yoga cannot see
      // (`_markScrollMeasureDirty`, issue #405)
      this._scrollMeasureDirty = true;
    }

    /**
     * Does this node scroll what overflows it? The one gate everything below
     * reads, and the reason `overflow: 'scroll'` and `overflow: 'hidden'`
     * are now genuinely different things: both clip, only this one scrolls.
     *
     * The layout defaults that go with it — `flex-basis: 0`, `min-width: 0`,
     * `min-height: 0` — are folded into the resolved style by
     * `resolveComputedStyle` (styles.js), so they travel through the same
     * diff as any other style and come back off when the overflow does.
     */
    isScroller() {
      return this.style.overflow === 'scroll';
    }

    /**
     * Stopped being a scroll container: an offset nothing will clamp again
     * would otherwise keep the content shifted forever. CSS loses the scroll
     * position the same way when a box stops scrolling.
     */
    _overflowChanged() {
      // whichever way the style flipped, the next scrolling pass starts
      // from a fresh measurement
      this._scrollMeasureDirty = true;
      if (this.isScroller()) return;
      this._scrollIntoViewTarget = null;
      this._scrollToTarget = null;
      this._childOrigin = null;
      if (this.scrollX === 0 && this.scrollY === 0) return;
      this.scrollX = 0;
      this.scrollY = 0;
      this._invalidateLayout('scroll');
    }

    absolutize(originX, originY) {
      this._placed = true;
      if (!this.yoga) return;
      this._assignAbs(
        originX + this.yoga.getComputedLeft(),
        originY + this.yoga.getComputedTop(),
        this.yoga.getComputedWidth(),
        this.yoga.getComputedHeight(),
      );
      if (this.props.onLayout) this._reportLayout();
      this._absolutizeChildren(this.abs.x, this.abs.y);
    }

    /**
     * Place the children, shifted by the scroll offset when there is one.
     * Split out of `absolutize` because a `<window>` writes its own `abs`
     * during flush and then walks its children from (0, 0) — the same walk,
     * reached by a different route.
     */
    _absolutizeChildren(originX, originY) {
      if (!this.isScroller()) {
        // a layout host's children go where its algorithm put them
        if (this._host !== null) {
          this._absolutizeHostChildren();
          return;
        }
        for (const child of this.children) {
          if (!child.isWindow) child.absolutize(originX, originY);
        }
        return;
      }
      const rtl = this.direction === 'rtl';
      // A pure-scroll pass re-learns nothing by walking (issue #405): the
      // content reach and every child's place *inside* the pane only change
      // when layout inside the pane changes. Yoga's own has-new-layout flag
      // is the witness — consumed here and nowhere else — set by any pass
      // that laid this node or anything under it out again, and left clear
      // by one that merely scrolled. `_scrollMeasureDirty` covers the one
      // route yoga cannot see: an element that paints its own content
      // growing its extent (docs/extending.md), announced through
      // `invalidate(true, this, 'scroll')`. The root's yoga node re-flags
      // on every pass, so a `<window overflow='scroll'>` always takes the
      // full walk — the pane that holds an app's long list is a box.
      const clean =
        this._childOrigin != null &&
        !this._scrollMeasureDirty &&
        !this.yoga.hasNewLayout();
      if (!clean) {
        const size = this.measureScrollContent();
        if (!Number.isFinite(size?.width) || !Number.isFinite(size?.height)) {
          // A NaN here does not throw on its own: it becomes a NaN max
          // scroll, a NaN offset, and every child laid out at NaN — a whole
          // tree gone with nothing naming the element that did it.
          throw new Error(
            `react-x11: <${this.kind}>.measureScrollContent() must return ` +
              '{ width, height } as finite numbers; it returned ' +
              `${describeSize(size)}. Return { width: 0, height: 0 } for ` +
              'content that has not arrived yet.',
          );
        }
        this.contentWidth = size.width;
        this.contentHeight = size.height;
        this._scrollMeasureDirty = false;
        this.yoga.markLayoutSeen();
      }
      // The moves layout makes on its own, with nobody's call to report them
      // from: a `scrollTo` held for this pane's first pass landing, a
      // `scrollIntoView` resolving against the geometry this pass produced,
      // and the clamp pulling the offset back when the content shrank, or
      // the viewport grew, under it. A browser fires `scroll` for each, so
      // `onScroll` hears of them too, once the pass is over.
      const from = { x: this.scrollX, y: this.scrollY };
      // A scrollTo held for this pass lands first, so a node asked into view
      // in the same frame is brought in from where that scroll put the pane:
      // the order the two have on a laid-out pane, where scrollTo applies at
      // once and scrollIntoView waits for the pass.
      this._resolveScrollTo();
      this._resolveScrollIntoView();
      this.scrollY = clampScroll(this.scrollY, this._maxScroll('y'));
      this.scrollX = clampScroll(this.scrollX, this._maxScroll('x'));
      this._reportViewport();
      this._reportScrollTo(from);
      // `scrollX` is how far the content has moved **from its start**, which
      // is the right-hand edge in RTL — so scrolling shifts the children the
      // other way. Keeping it a distance rather than a coordinate is what
      // makes `scrollTo({x: 0})` mean "back to the beginning" in both
      // directions, and keeps every clamp and every max in one sign. What
      // moves pixels with the content does not share it: the scroll blit
      // asks `_blitShift`, which asks the direction.
      const ox = rtl ? originX + this.scrollX : originX - this.scrollX;
      const oy = originY - this.scrollY;
      // The layout diff and a scroll would double-report each other: a scroll
      // is a uniform shift of everything below this viewport, already claimed
      // as the viewport itself (or narrowed to the exposed strip by the blit),
      // and per-child old/new claims would re-widen the very frame the blit
      // narrows. So when the children's origin moved, the walk below runs
      // with the diff off. When it did not move, a child that moved did so by
      // real layout — claim it, but clipped to the viewport: ink below the
      // fold never reaches the surface, and an unclipped claim would repaint
      // whatever unrelated UI sits under this node's off-viewport extent.
      const wasOrigin = this._childOrigin;
      const shifted = wasOrigin && (wasOrigin.x !== ox || wasOrigin.y !== oy);
      this._childOrigin = { x: ox, y: oy };
      if (clean) {
        // The fast path (issue #405): nothing inside was laid out, so every
        // child sits exactly where the last pass put it, shifted by however
        // far the origin moved — one uniform translation instead of a
        // per-node yoga re-derivation. The layout diff is owed nothing by
        // construction: under a blit ledger the shifted diff's claims are
        // the deviations from this very translation, and a clean pane has
        // none — the walk below lands every node where the diff would have
        // reported silence.
        if (!shifted) return;
        const dx = ox - wasOrigin.x;
        const dy = oy - wasOrigin.y;
        for (const child of this.children) {
          if (!child.isWindow) child._shiftAbs(dx, dy);
        }
        return;
      }
      const outer = layoutDiff.sink;
      const outerShift = layoutDiff.shift;
      const ledger = shifted && this._blitLedgerOpen();
      if (outer) {
        if (ledger) {
          // The blit's own ledger takes this walk (issue #398). The shift
          // below is what makes the diff worth running under a scroll at
          // all: without it every child reports the move the blit is about
          // to make for them, and the claims add up to the viewport. What
          // is left is the virtualized list's real frame — the rows that
          // entered, the ones that left, a spacer that resized — and it
          // goes to the ledger rather than to `outer`, whose claims are
          // what `layoutMoved` reads as "this frame is not a pure scroll".
          const vp = insetRect(this.abs, -DAMAGE_SLOP);
          layoutDiff.sink = (rect) => {
            const clipped = intersectRects(rect, vp);
            if (clipped && !this._recordBlitClaim(clipped)) {
              this._pendingBlitFrom = BLIT_POISONED;
            }
          };
          layoutDiff.shift = { x: ox - wasOrigin.x, y: oy - wasOrigin.y };
        } else if (shifted) {
          layoutDiff.sink = null;
        } else {
          const vp = insetRect(this.abs, -DAMAGE_SLOP);
          layoutDiff.sink = (rect) => {
            const clipped = intersectRects(rect, vp);
            if (clipped) outer(clipped);
          };
        }
      }
      try {
        for (const child of this.children) {
          if (!child.isWindow) {
            child.absolutize(ox, oy);
          }
        }
      } finally {
        layoutDiff.sink = outer;
        layoutDiff.shift = outerShift;
      }
    }

    /**
     * A scroller inside a shifting subtree does not ride the translation
     * blindly: its box moves rigidly, but its children's origin also
     * carries the scroll offsets, which may have changed again this very
     * frame — a wheel on a nested pane while an outer one scrolls.
     * Re-entering `_absolutizeChildren` folds both into one delta, and
     * re-runs the gate, so a nested pane that is not clean still walks
     * properly. (Reached only under an outer pane's fast path, which
     * proved nothing in here was laid out — the nested gate can only
     * decline over its own `_scrollMeasureDirty`.)
     */
    _shiftChildren(dx, dy) {
      if (!this.isScroller()) return super._shiftChildren(dx, dy);
      this._absolutizeChildren(this.abs.x, this.abs.y);
    }

    /**
     * Tell the owner how big the viewport and the content turned out, when
     * either changes. Layout happens on the frame clock, *after* the commit
     * that mounted the node, so an effect cannot read this off the ref —
     * which is exactly what a list needs before it can decide how many rows
     * are worth building. Fired from layout rather than from scrolling, so
     * it also arrives for a list nobody has scrolled yet.
     */
    _reportViewport() {
      // logical, like onScroll's payload: finder.jsx divides this height by
      // a row height it wrote in a style
      const s = this.scale;
      const next = {
        width: this.abs.width / s,
        height: this.abs.height / s,
        contentWidth: this.contentWidth / s,
        contentHeight: this.contentHeight / s,
      };
      const last = this._lastViewport;
      if (
        last &&
        last.width === next.width &&
        last.height === next.height &&
        last.contentWidth === next.contentWidth &&
        last.contentHeight === next.contentHeight
      ) {
        return;
      }
      this._lastViewport = next;
      // during layout: defer, or a setState from the handler would re-enter
      // the pass that is still running
      const notify = this.props.onViewport;
      if (notify) setImmediate(() => !this.destroyed && notify(next));
    }

    /**
     * How far the content reaches — `scrollWidth`/`scrollHeight`, and what
     * everything below scrolls against: the maxima, the bars, the keys.
     *
     * The default measures the **children**, through the subtree rather than
     * off the direct ones. A row that stretches to the viewport while its own
     * cells overflow it — a table, in other words — reports the viewport
     * width at the top level and says nothing about the cells, so a shallow
     * measurement would find nothing to scroll. Anything that clips its own
     * children ends the walk: their overflow is that node's business.
     *
     * `width` is how far the content reaches from the edge it *starts* at,
     * which is the right-hand one under `direction: 'rtl'` — yoga lays an
     * overflowing RTL row out at negative offsets, so the reach that matters
     * there is how far left of zero it got, not how far right. An element
     * measuring its own drawing answers the same question and never has to
     * ask which direction it is in.
     *
     * **Override it when the content is pixels rather than nodes.** An
     * element that paints its own content — an editor drawing lines of text,
     * a terminal, a canvas-backed table — has no children to walk, so the
     * default measures 0 and the viewport clamps to nothing however far the
     * drawing actually goes. Answering here is the whole of joining in: the
     * wheel, the scrollbars, the scroll keys and the AT-SPI scroll pane all
     * read the numbers this returns (docs/extending.md).
     *
     * Called at most once per layout pass, from `absolutize`, so it may
     * read yoga geometry but must not invalidate or paint — and cached
     * across passes that laid nothing inside the pane out again (issue
     * #405): a pass that merely scrolled reuses the last answer, since a
     * scroll cannot change how far the content reaches. An element whose
     * extent changed by a route layout never saw — rows arrived, a line
     * was typed — announces it with `invalidate(true, this, 'scroll')`,
     * and the next pass asks again.
     */
    measureScrollContent() {
      const rtl = this.direction === 'rtl';
      const width = this.yoga.getComputedWidth();
      let start = 0;
      let bottom = 0;
      const walk = (node, dx, dy) => {
        for (const child of node.children) {
          if (child.isWindow || !child.yoga || child.hidden) continue;
          const offset = offsetInParent(child);
          const x = dx + offset.x;
          const y = dy + offset.y;
          const w = child.yoga.getComputedWidth();
          start = Math.max(start, rtl ? width - x : x + w);
          bottom = Math.max(bottom, y + child.yoga.getComputedHeight());
          if (!child.clipsChildren()) walk(child, x, y);
        }
      };
      walk(this, 0, 0);
      // the end padding is part of the content box a browser scrolls to, and
      // it is the one part of it yoga has already resolved for us — on the
      // left in RTL, since that is the end there
      return {
        width:
          start +
          this.yoga.getComputedPadding(rtl ? Yoga.EDGE_LEFT : Yoga.EDGE_RIGHT),
        height: bottom + this.yoga.getComputedPadding(Yoga.EDGE_BOTTOM),
      };
    }

    /**
     * How far this axis can scroll — 0 for a node the style does not make a
     * scroll container, which is the gate the whole public surface rests on:
     * `scrollTo` clamps to nothing, no bar has geometry, and nothing is a
     * tab stop, without any of them testing the style themselves.
     */
    _maxScroll(axis) {
      if (!this.isScroller()) return 0;
      return axis === 'x'
        ? Math.max(0, this.contentWidth - this.abs.width)
        : Math.max(0, this.contentHeight - this.abs.height);
    }

    /**
     * `scrollTo(y)` scrolls vertically, as it always has; `scrollTo({x, y})`
     * moves either axis, leaving out whichever is omitted.
     */
    /** Public entry, logical pixels — application code writes `scrollTo(120)`
     * in the same unit as its styles. Internal callers hold device offsets
     * and use `_scrollToDevice`/`_scrollByDevice` instead (src/scale.js). */
    scrollTo(to) {
      const s = this.scale;
      this._scrollToDevice(
        typeof to === 'number'
          ? { y: to * s }
          : {
              x: to?.x == null ? undefined : to.x * s,
              y: to?.y == null ? undefined : to.y * s,
            },
      );
    }

    _scrollToDevice(want, by = null) {
      const maxX = this._maxScroll('x');
      const maxY = this._maxScroll('y');
      const next = {
        x: want.x == null ? this.scrollX : clampScroll(want.x, maxX),
        y: want.y == null ? this.scrollY : clampScroll(want.y, maxY),
      };
      const moved = next.x !== this.scrollX || next.y !== this.scrollY;
      const holding = this._holdScrollTo(want, by, maxX, maxY);
      if (!moved && !holding) return;
      const root = this.root;
      // A pane no pass has placed arms nothing: its first pass is a layout
      // change rather than a pure scroll.
      if (root && this._childOrigin != null) {
        // Arming is the one moment the evidence still exists: the viewport
        // claim recorded below coalesces earlier claims into itself
        // (addDamageRect keeps the list disjoint), after which a change
        // inside the viewport is indistinguishable from the scroll's own
        // claim — the blind spot the claim-time cancel in
        // WindowNode.invalidate cannot cover (react-x11#295). The scroll
        // has not claimed yet, so damage already overlapping this viewport
        // is foreign by construction: poison the frame instead of arming,
        // and the full-viewport repaint below stays in force.
        const arming = this._pendingBlitFrom == null;
        // The ledger this frame's changes inside the viewport are written
        // to (issue #398). Opened with the blit and read by
        // _applyScrollBlits, which clears it beside the origin.
        if (arming) this._blitLedger = [];
        if (arming && Array.isArray(root._damage)) {
          const zone = insetRect(this.abs, -(DAMAGE_SLOP * 2 + 1));
          for (const rect of root._damage) {
            // Already coalesced, so these rects are as coarse as the frame
            // has made them — which the ledger reads conservatively: a blob
            // that swallowed the viewport says so and poisons, exactly as
            // this gate used to for every claim it saw.
            if (rectsOverlap(rect, zone) && !this._recordBlitClaim(rect)) {
              this._pendingBlitFrom = BLIT_POISONED;
              break;
            }
          }
        }
        // An element that also shifted its own drawing this frame
        // (`scrollContents`, issue #303) is two shifts of the same pixels,
        // and a frame can only have one.
        if (this._pendingBlitContents) this._pendingBlitFrom = BLIT_POISONED;
        // The offsets whose pixels are on screen, captured before the first
        // change of the frame: the frame's blit fast path (issue #138) shifts
        // from *these* to wherever layout settles, however many scrollTo
        // calls land in between.
        this._pendingBlitFrom ??= { x: this.scrollX, y: this.scrollY };
        (root._pendingScrolls ??= new Set()).add(this);
        // ... and the claim about to be recorded is the scroll itself, not a
        // reason to un-blit it
        root._scrollClaim = this;
      }
      this.scrollX = next.x;
      this.scrollY = next.y;
      if (moved) this.props.onScroll?.(this._scrollEvent());
      // A scroll reflows this viewport's contents and nothing else, and the
      // viewport clips them, so the damage is this node's own rect. It is a
      // layout change all the same — children's absolute positions move — hence
      // both arguments. Unbounded, every wheel notch repainted the whole window,
      // which is the whole cost of scrolling: the client work is negligible next
      // to what the server then has to redraw. (When the frame turns out to be
      // a *pure* scroll, _applyScrollBlits later narrows this claim to the
      // exposed strip and blits the rest — see WindowNode.)
      this.root?.invalidate(true, this, 'scroll');
      if (root) root._scrollClaim = null;
    }

    /**
     * Keep the part of a request the extent in hand cannot answer, for the
     * pass that will measure one that can. `_scrollToDevice` clamps against
     * `contentWidth`/`contentHeight` and `abs` as the last pass left them,
     * and two kinds of pane have nothing better there yet:
     *
     * - one no pass has placed as a scroller (`_childOrigin` is the
     *   witness): on mount those are still the zeros they were built with,
     *   and a box that starts scrolling in the same commit never measured
     *   them. Restoring a list's position from a mount-time effect is the
     *   case.
     * - one whose next pass is already owed (`needsLayout`): rows mounted in
     *   the commit the request comes from are not in the extent yet, so a
     *   follow to the end from a layout effect stopped at the old end.
     *
     * What the extent in hand can answer still lands at once, with its
     * `onScroll` and its blit origin. The request is kept as well, and
     * `_resolveScrollTo` answers it again against what the pass measures,
     * before anything is placed.
     *
     * Per axis, a request replaces whatever was held on that axis, and a
     * relative one (`by`) made while something is held is kept as a step
     * after it, so the pass replays the frame's requests the way a pane with
     * a fresh extent would have taken them. Returns whether anything is
     * held.
     */
    _holdScrollTo(want, by, maxX, maxY) {
      const root = this.root;
      const owed =
        this.isScroller() &&
        (this._childOrigin == null ||
          (root != null && root.needsLayout && !root._inFlush));
      const was = this._scrollToTarget;
      const x = holdAxis(was?.x, want.x, by?.x, owed, maxX);
      const y = holdAxis(was?.y, want.y, by?.y, owed, maxY);
      this._scrollToTarget = x || y ? { x, y } : null;
      if (!this._scrollToTarget) return false;
      if (root) (root._heldScrolls ??= new Set()).add(this);
      return true;
    }

    /**
     * Answer a held request (`_holdScrollTo`) against the extent this pass
     * has just measured: each held axis's base, clamped, then each step
     * after it, clamped in turn. Its `onScroll` is the pass's, like every
     * move layout makes (see `_absolutizeChildren`).
     */
    _resolveScrollTo() {
      const held = this._scrollToTarget;
      if (!held) return;
      this._scrollToTarget = null;
      this.root?._heldScrolls?.delete(this);
      if (held.x) this.scrollX = replayHeld(held.x, this._maxScroll('x'));
      if (held.y) this.scrollY = replayHeld(held.y, this._maxScroll('y'));
    }

    /**
     * `onScroll` for an offset a layout pass moved — a held `scrollTo`
     * landing, a `scrollIntoView` resolving, or the clamp when the content
     * shrank or the viewport grew (see `_absolutizeChildren`) — when the
     * pass left the pane somewhere other than `from`. Deferred like
     * `onViewport`, since a setState from the handler would re-enter the
     * pass, so it arrives after the frame that first shows the new offset.
     * The payload is read on delivery, not now: a wheel landing in between
     * has already reported where it went, and a payload from before it
     * would leave the handler behind the pane.
     */
    _reportScrollTo(from) {
      if (from.x === this.scrollX && from.y === this.scrollY) return;
      setImmediate(() => {
        const notify = this.props.onScroll;
        if (this.destroyed || !notify) return;
        callHandler(this, 'onScroll', notify, this._scrollEvent());
      });
    }

    /** `onScroll`'s payload, for the offsets in force. The handler is
     * application code, so it is logical like every payload: finder.jsx's
     * row virtualisation divides scrollY by a row height it wrote in a
     * style, and those must be the same unit. */
    _scrollEvent() {
      const s = this.scale;
      return {
        scrollX: this.scrollX / s,
        scrollY: this.scrollY / s,
        contentWidth: this.contentWidth / s,
        contentHeight: this.contentHeight / s,
        viewportWidth: this.abs.width / s,
        viewportHeight: this.abs.height / s,
      };
    }

    /**
     * Is there room to move on the axis this delta names? The first half of
     * the wheel's chain protocol (`canScroll` then `scrollBy`, see
     * docs/extending.md): a scroll container that fits its content answers
     * no and hands the gesture to the next one out, the way a browser does.
     *
     * Position is deliberately not part of the answer — a viewport scrolled
     * to its bottom still owns the wheel, rather than passing the rest of a
     * flick to whatever is behind it.
     */
    canScroll(dx, dy) {
      if (dx && this._maxScroll('x') > 0) return true;
      if (dy && this._maxScroll('y') > 0) return true;
      return false;
    }

    /** `scrollBy(dy)`, or `scrollBy({x, y})` for either axis. Logical, like
     * `scrollTo`. */
    scrollBy(by) {
      const s = this.scale;
      const step =
        typeof by === 'number'
          ? { y: by * s }
          : {
              x: by?.x == null ? undefined : by.x * s,
              y: by?.y == null ? undefined : by.y * s,
            };
      this._scrollToDevice(
        {
          x: step.x == null ? undefined : this.scrollX + step.x,
          y: step.y == null ? undefined : this.scrollY + step.y,
        },
        step,
      );
    }

    /** The wheel's and the key handler's entry: whole device pixels, which
     * is what keeps the scroll blit on the pixel grid at any scale. */
    _scrollByDevice(dx, dy) {
      this._scrollToDevice(
        {
          x: dx ? this.scrollX + dx : undefined,
          y: dy ? this.scrollY + dy : undefined,
        },
        { x: dx || undefined, y: dy || undefined },
      );
    }

    /**
     * A box with something to scroll is a tab stop, so a pane of
     * *unfocusable* content — a log, a long `<text>`, a rendered document —
     * can be read without a pointer. Before this the only way to scroll one was the
     * wheel, which is a WCAG 2.1.1 failure on the most ordinary layout the
     * library has.
     *
     * Conditional on purpose: a scroll box that fits its content is an
     * ordinary clipped box, and stopping Tab on it would be a tab stop that
     * does nothing. It is answered from the current layout, so a pane that
     * grows past its viewport becomes reachable the moment it does.
     */
    get focusableByDefault() {
      return this._scrollsWithKeys();
    }

    /** Is there anything here for the scroll keys to move? Separate from
     * `focusableByDefault` because a box can now be a focus target for
     * another reason — a `selectable` document is one (a11y.js) — and a
     * document that does not scroll must still leave the arrows alone. */
    _scrollsWithKeys() {
      return this._maxScroll('y') > 0 || this._maxScroll('x') > 0;
    }

    /**
     * The keys a scroll pane answers, matching what every desktop toolkit
     * does: arrows by a wheel notch, PageUp/PageDown by a viewport, Home/End
     * to the ends, Space and Shift+Space as a second pair of page keys
     * because that is what a reader's hand is already on.
     *
     * Runs after the application's own `onKeyDown`, and not at all if that
     * called `preventDefault` — the same contract `<textinput>` editing has.
     */
    defaultKeyDown(ev) {
      // nothing to scroll, nothing to swallow: a plain box must leave the
      // arrows and Page keys to whatever else would answer them
      if (!this._scrollsWithKeys()) return super.defaultKeyDown(ev);
      const step = SCROLL_KEY_STEP * this.scale;
      const page = Math.max(
        1,
        this.abs.height - SCROLL_KEY_PAGE_OVERLAP * this.scale,
      );
      // Left and Right are the directions on the *screen*, and `scrollX` runs
      // from the start of the content — so which of them moves it forward
      // depends on which way the content runs. Home/End and the Page keys
      // need no such rule: they already name the logical ends.
      const forward = this.direction === 'rtl' ? -step : step;
      switch (ev.keysym) {
        case XK_DOWN:
          return this._scrollByDevice(0, step);
        case XK_UP:
          return this._scrollByDevice(0, -step);
        case XK_RIGHT:
          return this._scrollByDevice(forward, 0);
        case XK_LEFT:
          return this._scrollByDevice(-forward, 0);
        case XK_PAGE_DOWN:
          return this._scrollByDevice(0, page);
        case XK_PAGE_UP:
          return this._scrollByDevice(0, -page);
        case XK_HOME:
          return this._scrollToDevice({ y: 0 });
        case XK_END:
          // the end the pass measures, if one is owed (`_holdScrollTo`)
          return this._scrollToDevice({ y: Infinity });
        case XK_SPACE:
          return this._scrollByDevice(0, ev.shiftKey ? -page : page);
        default:
          return super.defaultKeyDown(ev);
      }
    }

    /**
     * Scroll the minimum amount that brings a descendant fully into view.
     * The request is queued rather than applied immediately: absolute rects
     * only exist after a layout pass, so a caller reacting to a mount (a
     * list widget moving its selection, say) would otherwise measure a node
     * that has no geometry yet. `absolutize` resolves it against freshly
     * computed yoga positions, and `onScroll` reports the move once that
     * pass is over (`_reportScrollTo`).
     */
    scrollIntoView(node) {
      if (!node || !this.isScroller()) return;
      this._scrollIntoViewTarget = node;
      // whatever the resolved scroll moves is inside this clipped viewport,
      // so the viewport's own before/after rects bound the frame
      this._invalidateLayout('scroll');
    }

    _resolveScrollIntoView() {
      const target = this._scrollIntoViewTarget;
      if (!target) return;
      this._scrollIntoViewTarget = null;
      if (target.destroyed || !target.yoga) return;
      // offset of the target within our content box, summed up the chain so
      // targets nested below a direct child work too
      let top = 0;
      let left = 0;
      for (let n = target; n && n !== this; n = n.parent) {
        if (!n.yoga) return; // not (or no longer) inside this viewport
        const offset = offsetInParent(n);
        top += offset.y;
        left += offset.x;
        if (!n.parent) return;
      }
      const bottom = top + target.yoga.getComputedHeight();
      // Horizontally the two edges are measured from the content's **start**,
      // the same units `scrollX` is in — so under RTL the target's near edge
      // is its right one and both are counted back from the viewport's width.
      const w = target.yoga.getComputedWidth();
      const near =
        this.direction === 'rtl'
          ? this.yoga.getComputedWidth() - left - w
          : left;
      const far = near + w;
      if (bottom > this.scrollY + this.abs.height) {
        this.scrollY = bottom - this.abs.height;
      }
      if (top < this.scrollY) this.scrollY = top;
      if (far > this.scrollX + this.abs.width) {
        this.scrollX = far - this.abs.width;
      }
      if (near < this.scrollX) this.scrollX = near;
    }

    paint(ctx) {
      super.paint(ctx);
      this._paintScrollbars(ctx);
    }

    /** Over the content and outside the clip — a `<window>` reaches this by
     * its own route, since it paints through `_paintRegion` and never
     * through `Node.paint`. */
    _paintScrollbars(ctx) {
      for (const bar of this._scrollbars()) {
        paintScrollbarThumb(ctx, bar, this.props.scrollbarColor);
      }
    }

    /** null when this is not a scroll container, when the bar is switched
     * off, or when there is nothing to scroll on that axis. */
    _scrollbar(axis = 'y') {
      if (!this.isScroller() || this.props.scrollbar === false) return null;
      const horizontal = axis === 'x';
      // when both bars show, each stops short of the other's corner
      const other = horizontal
        ? this.contentHeight > this.abs.height
        : this.contentWidth > this.abs.width;
      return scrollbarGeometry({
        axis,
        start: horizontal ? this.abs.x : this.abs.y,
        viewport: horizontal ? this.abs.width : this.abs.height,
        content: horizontal ? this.contentWidth : this.contentHeight,
        across: horizontal ? this.abs.y : this.abs.x,
        crossSize: horizontal ? this.abs.height : this.abs.width,
        scroll: horizontal ? this.scrollX : this.scrollY,
        inset: 2 * this.scale,
        shorten: other ? (SCROLLBAR_WIDTH + 2) * this.scale : 0,
        direction: this.direction,
        scale: this.scale,
      });
    }

    _scrollbars() {
      if (!this.isScroller()) return EMPTY_SCROLLBARS;
      return [this._scrollbar('y'), this._scrollbar('x')].filter(Boolean);
    }

    /**
     * The bar belongs to the scroller, not to the content under it — the same
     * rule a browser applies. Without this a press on the thumb would be
     * delivered to whatever child happens to be painted beneath it.
     */
    hitTest(x, y) {
      if (this.isScroller()) {
        for (const bar of this._scrollbars()) {
          if (scrollbarHit(bar, x, y)) return this;
        }
      }
      return super.hitTest(x, y);
    }

    defaultMouseDown(ev) {
      // bar geometry is device pixels; the synthetic event is logical, so
      // the hit tests here read the native coordinates
      const nx = ev.nativeEvent?.x ?? ev.x * this.scale;
      const ny = ev.nativeEvent?.y ?? ev.y * this.scale;
      for (const bar of this._scrollbars()) {
        const hit = scrollbarHit(bar, nx, ny);
        if (!hit) continue;
        const at = along(bar, nx, ny);
        if (hit === 'thumb') {
          // remember where in the thumb it was grabbed, so it does not jump
          this._barGrab = { axis: bar.axis, offset: at - bar.thumbStart };
          ev.capturePointer();
          return;
        }
        // a press on the track pages towards it, like PageUp/PageDown — and
        // "towards it" is a visual direction, so it flips with the bar
        const page = bar.axis === 'x' ? this.abs.width : this.abs.height;
        const back = at < bar.thumbStart ? !bar.reversed : bar.reversed;
        const delta = back ? -page : page;
        if (bar.axis === 'x') this._scrollByDevice(delta, 0);
        else this._scrollByDevice(0, delta);
        return;
      }
      // no bar under the press: it belongs to whatever is behind the bars,
      // which for a `selectable` pane is the selection (issue #259)
      super.defaultMouseDown(ev);
    }

    defaultMouseDrag(ev) {
      if (this._barGrab == null) return super.defaultMouseDrag(ev);
      const bar = this._scrollbar(this._barGrab.axis);
      if (!bar || bar.travel <= 0) return;
      const nx = ev.nativeEvent?.x ?? ev.x * this.scale;
      const ny = ev.nativeEvent?.y ?? ev.y * this.scale;
      const at = along(bar, nx, ny) - this._barGrab.offset - bar.trackStart;
      const from = bar.reversed ? bar.travel - at : at;
      const to = (from / bar.travel) * bar.range;
      this._scrollToDevice(bar.axis === 'x' ? { x: to } : { y: to });
    }

    defaultMouseUp(ev) {
      if (this._barGrab != null) {
        this._barGrab = null;
        return;
      }
      super.defaultMouseUp(ev);
    }
  };

// An arrow key scrolls by a wheel notch — literally the one events.js
// converts a notch into, so the two input routes agree about what one step
// is however far a notch turns out to be.
const SCROLL_KEY_STEP = WHEEL_NOTCH_PX;
// A page keeps a sliver of the previous one on screen, so the eye has
// somewhere to land. Toolkits all keep a line or two; this is about that.
const SCROLL_KEY_PAGE_OVERLAP = 24;
