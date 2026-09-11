// Layout: yoga's measure seam for a node's content, and the walk that turns
// yoga's offsets into absolute rects each pass (`absolutize`), reporting
// what moved to onLayout and to the layout diff.

import { Yoga } from '../yoga.js';
import { callHandler } from '../errors.js';
import { DAMAGE_SLOP, layoutDiff } from './damage.js';
import { insetRect } from './rects.js';
import { DEV } from './util.js';

export const MEASURE_MODES = [];
MEASURE_MODES[Yoga.MEASURE_MODE_UNDEFINED] = 'unconstrained';
MEASURE_MODES[Yoga.MEASURE_MODE_EXACTLY] = 'exactly';
MEASURE_MODES[Yoga.MEASURE_MODE_AT_MOST] = 'at-most';

/**
 * The pixels on offer on one axis, as a number an element can do arithmetic
 * with. Yoga says "no bound" with a null, so `Math.min(preferred, width)`
 * would answer 0 to the one question where the honest answer is `preferred`;
 * `Infinity` is what "no bound" means in that expression, and it makes the
 * mode something an element consults only when it has a reason to.
 */
export function measureOffer(value, mode) {
  return mode === Yoga.MEASURE_MODE_UNDEFINED || !Number.isFinite(value)
    ? Infinity
    : value;
}

/** What a measure function answered, for the error that rejects it. */
export function describeSize(size) {
  if (size === null || typeof size !== 'object') return String(size);
  return `{ width: ${size.width}, height: ${size.height} }`;
}

/**
 * Fit a natural size into what layout offered — the shape `<image>`, `<svg>`
 * and any other element whose content has a size of its own and an aspect
 * ratio to keep.
 *
 * **Which axes the style fixed is something layout already knows**, and says
 * in the measure modes: `'exactly'` on an axis means the style made it
 * definite. Working it out a second time by reading style back would be
 * duplication; working it out by reading *props* was issue #118 — `width` is
 * a style name, so `<image width={40}>` throws in development and only ever
 * reached that branch in production.
 *
 * - Both fixed: layout skips the measure entirely, so there is no
 *   fixed-size case to write here.
 * - Height fixed alone: scale the width with it, the way an `<img>` with
 *   only a height set does, rather than stretching to the container.
 * - Otherwise: natural size, shrunk to the width on offer, height following
 *   the aspect ratio.
 *
 * @param {{width: number, height: number}} natural the content's own size
 * @param {MeasureConstraints} constraints the argument of `measureContent`
 */
export function intrinsicSize(
  natural,
  { width, height, widthMode, heightMode },
) {
  const { width: natW, height: natH } = natural;
  if (heightMode === 'exactly' && widthMode !== 'exactly' && natH > 0) {
    return { width: (height * natW) / natH, height };
  }
  const w = width < natW ? width : natW;
  return { width: w, height: natW > 0 ? (w * natH) / natW : natH };
}

/**
 * Where layout put `node` inside its parent's border box — yoga's offset,
 * plus, for a child a layout algorithm placed, the slot it was placed in
 * (its own yoga tree is a root, and a root's offset is only its margin).
 * The one sum `absolutize`, `onLayout` and `scrollIntoView` all make.
 */
export function offsetInParent(node) {
  const slot =
    node.parent !== null && node.parent._host !== null ? node._hostSlot : null;
  const yoga = node.yoga;
  return {
    x: yoga.getComputedLeft() + (slot === null ? 0 : slot.x),
    y: yoga.getComputedTop() + (slot === null ? 0 : slot.y),
  };
}

/** Layout, installed onto `Node.prototype` by node.js. */
export class NodeLayout {
  /**
   * Give this node's box a measure function, keeping a reference that can be
   * asked again later.
   *
   * A leaf's content is recorded nowhere but in its measure function, and
   * the size yoga keeps for it is not always what that function said:
   * `align-items` defaults to `stretch`, so in a pass run with no room on
   * offer — which is how a content floor is measured, see `contentSpan` —
   * the cross size a leaf ends up at is the container's, not its own. A
   * container in that position is recovered by looking inside it. A leaf
   * has nothing inside, so it is asked again instead.
   */
  _setMeasureFunc(measure) {
    this._measureFn = measure;
    this.yoga.setMeasureFunc(measure);
  }

  /**
   * The height this leaf takes at `width` with nothing bounding its height
   * — the answer yoga gets from the measuring pass that settles the height
   * floors, asked directly. `probeHeightFloors` asks it twice, for the width
   * a leaf was measured at and the one it has now, to find out whether a
   * relayout that moved the leaf changed what it needs; a paragraph answers
   * from its layout cache, and the elements whose height is not a function
   * of their width at all answer at once.
   */
  _heightForWidth(width) {
    if (this._host !== null) {
      return this._measureHost(
        width,
        this._floorMeasureMode === 'exactly'
          ? Yoga.MEASURE_MODE_EXACTLY
          : Yoga.MEASURE_MODE_AT_MOST,
        Number.NaN,
        Yoga.MEASURE_MODE_UNDEFINED,
      ).height;
    }
    return this.measureContent({
      width,
      height: Infinity,
      widthMode: this._floorMeasureMode ?? 'at-most',
      heightMode: 'unconstrained',
    })?.height;
  }

  /**
   * Hand `measureContent` to layout, translated: the modes arrive as words,
   * an axis with no bound arrives as `Infinity` rather than as yoga's null,
   * and what comes back is checked before it can turn a whole tree into
   * NaNs. Called by the constructor, so an element only writes the method.
   */
  _useMeasureContent() {
    this._setMeasureFunc((width, widthMode, height, heightMode) => {
      if (heightMode === Yoga.MEASURE_MODE_UNDEFINED) {
        this._floorMeasureMode = MEASURE_MODES[widthMode];
      }
      const size = this.measureContent({
        width: measureOffer(width, widthMode),
        height: measureOffer(height, heightMode),
        widthMode: MEASURE_MODES[widthMode],
        heightMode: MEASURE_MODES[heightMode],
      });
      if (!Number.isFinite(size?.width) || !Number.isFinite(size?.height)) {
        // Left to itself this is a destructuring TypeError from inside
        // yoga's wrapper, or — worse, because it does not throw at all — a
        // NaN that spreads through every ancestor's rect.
        throw new Error(
          `react-x11: <${this.kind}>.measureContent() must return ` +
            '{ width, height } as finite numbers; it returned ' +
            `${describeSize(size)}. Return { width: 0, height: 0 } for ` +
            'content that has not arrived yet.',
        );
      }
      return size;
    });
  }

  /**
   * The inputs to `measureContent` changed — a prop it reads, data that
   * loaded — so the next layout has to ask again instead of reusing the
   * answer it cached.
   *
   * `reason` joins the closed set the diagnostics print (docs/debugging.md);
   * the default says the measurement itself moved.
   */
  invalidateMeasure(reason = 'measure') {
    // Nothing to re-ask, and both halves matter: layout aborts the process
    // on a node that never had a measure function, and a destroyed node's
    // box has already been freed under it.
    if (this.destroyed || !this._measureFn) {
      // Said once, in development: an element that asks for a re-measure and
      // silently gets none looks broken rather than degraded, and there is
      // nothing in the frame to pull on.
      if (DEV && !this.destroyed && !this._measureNagged) {
        this._measureNagged = true;
        console.warn(
          `react-x11: <${this.kind}>.invalidateMeasure() has nothing to ` +
            're-measure — this element implements no measureContent(). ' +
            'Note it has to be a method on the class: assigning it in the ' +
            'constructor is too late, since the base Node constructor is ' +
            'what wires it to layout.',
        );
      }
      return;
    }
    this.yoga.markDirty();
    this._invalidateLayout(reason);
  }

  absolutize(originX, originY) {
    // before the yoga check, so a span — placed by its paragraph, no box of
    // its own — counts as on screen too
    this._placed = true;
    if (!this.yoga) return;
    this._assignAbs(
      originX + this.yoga.getComputedLeft(),
      originY + this.yoga.getComputedTop(),
      this.yoga.getComputedWidth(),
      this.yoga.getComputedHeight(),
    );
    if (this.props.onLayout) this._reportLayout();
    if (this._host !== null) {
      this._absolutizeHostChildren();
      return;
    }
    for (const child of this.children) {
      if (!child.isWindow) child.absolutize(this.abs.x, this.abs.y);
    }
  }

  /**
   * `onLayout`: the rect a layout pass gave this node, reported when it
   * changed — React Native's contract, and the seam for a decision that is
   * not a style (docs/react-features.md): how many columns to build, which
   * component to render. Where the decision *is* a style, a container
   * query answers it in the same frame instead (docs/styling.md).
   *
   * `x`/`y` are the position **within the parent as laid out** — yoga's
   * answer, which a scroll does not move — rather than the window
   * coordinates `abs` holds: a list scrolling under the pointer must not
   * re-render every row on every notch. Logical pixels, this node's own,
   * the same division `measure()` makes.
   *
   * Deferred, like `onViewport`: this runs inside the layout pass, and a
   * `setState` from the handler would re-enter it. One report per frame,
   * because `absolutize` runs once, after the container blocks have
   * settled — a card whose block changed its height reports the height it
   * ended the frame at, not the one it had between passes.
   */
  _reportLayout() {
    const s = this.scale;
    const offset = offsetInParent(this);
    const next = {
      x: offset.x / s,
      y: offset.y / s,
      width: this.abs.width / s,
      height: this.abs.height / s,
    };
    const last = this._lastLayout;
    if (
      last &&
      last.x === next.x &&
      last.y === next.y &&
      last.width === next.width &&
      last.height === next.height
    ) {
      return;
    }
    this._lastLayout = next;
    setImmediate(() => {
      // the handler as it is *now*: React may have re-rendered in between
      const notify = this.props.onLayout;
      if (this.destroyed || !notify) return;
      callHandler(this, 'onLayout', notify, next);
    });
  }

  /**
   * absolutize's write to `abs`, funneled through one place so a bounded
   * frame's layout diff sees every node the pass actually moved or resized.
   * The old and new rects are claimed separately (not their union box —
   * a node crossing the window would drag everything between them along),
   * each grown by this node's own paint reach. A rect that was or became
   * zero-area claims nothing: there were, or will be, no pixels there.
   */
  _assignAbs(x, y, width, height) {
    const old = this.abs;
    if (
      old.x === x &&
      old.y === y &&
      old.width === width &&
      old.height === height
    ) {
      return;
    }
    this.abs = { x, y, width, height };
    // moving or resizing changes where this subtree can be hit, and the
    // cached unions all the way up with it
    this._clearHitBounds();
    if (layoutDiff.sink) {
      const grow = this._outlineExtent() + DAMAGE_SLOP;
      const shift = layoutDiff.shift;
      const had = old.width > 0 && old.height > 0;
      if (shift) {
        // Riding a blit (issue #398): the rect this node *would* have had if
        // nothing but the scroll had happened. Landing there is the blit's
        // own translation and claims nothing — claiming it would repaint the
        // band the blit exists to keep. Landing anywhere else is a real move,
        // and both ends of it are claimed in post-blit coordinates, which is
        // where the frame will paint them.
        const was = {
          x: old.x + shift.x,
          y: old.y + shift.y,
          width: old.width,
          height: old.height,
        };
        if (
          had &&
          was.x === x &&
          was.y === y &&
          old.width === width &&
          old.height === height
        ) {
          return;
        }
        if (had) layoutDiff.sink(insetRect(was, -grow));
        if (width > 0 && height > 0) {
          layoutDiff.sink(insetRect(this.abs, -grow));
        }
        return;
      }
      if (had) {
        layoutDiff.sink(insetRect(old, -grow));
      }
      if (width > 0 && height > 0) {
        layoutDiff.sink(insetRect(this.abs, -grow));
      }
    }
  }

  /**
   * Move an already-laid-out subtree by a constant, without asking yoga
   * anything — the scroll fast path's walk (issue #405).
   *
   * A pure-scroll frame changes nothing about the arrangement inside a
   * viewport: every descendant sits exactly where the last pass put it,
   * shifted by the scroll delta. `absolutize` would re-derive each rect
   * through four wasm-boundary getters to learn what one addition already
   * says, so the scroller calls this instead — only after proving nothing
   * inside was laid out this pass (see `_absolutizeChildren`).
   *
   * `abs` is adjusted in place rather than replaced: its identity is
   * already long-lived (`_assignAbs` keeps the object whenever a rect is
   * unchanged), and everything that records a rect for later copies it.
   * The cached hit bounds ride along instead of being dropped — a uniform
   * translation is the one change a cached union survives — which keeps a
   * wheel flick from rebuilding the pane's whole hit-bounds tree per notch.
   *
   * No layout diff runs here, and none is owed: under a blit ledger the
   * shifted diff's claims are the *deviations* from exactly this
   * translation, and a subtree nothing laid out again has none.
   */
  _shiftAbs(dx, dy) {
    if (!this.yoga) return;
    const abs = this.abs;
    abs.x += dx;
    abs.y += dy;
    // the paint reach rides along the same way — unless it *is* `abs`,
    // which just moved
    const p = this._paintBoundsCache;
    if (p && p !== abs) {
      p.x += dx;
      p.y += dy;
    }
    const b = this._hitBoundsCache;
    if (b) {
      b.left += dx;
      b.right += dx;
      b.top += dy;
      b.bottom += dy;
    }
    this._shiftChildren(dx, dy);
  }

  /** Split from `_shiftAbs` so a scroller can reroute its children through
   * its own offset bookkeeping — the box moves rigidly, but the children's
   * origin also carries scroll offsets that may have changed again this
   * same frame (`Scrollable._shiftChildren`). */
  _shiftChildren(dx, dy) {
    for (const child of this.children) {
      if (!child.isWindow) child._shiftAbs(dx, dy);
    }
  }

  /**
   * A layout-affecting change at this node may change how far the content
   * of an enclosing scroll pane reaches through a route yoga never
   * witnesses — an element that paints its own content growing its extent
   * announces it with `invalidate(true, this, 'scroll')`
   * (docs/extending.md), and no yoga node is dirtied by that. Mark every
   * scroller whose measurement can see this node, so the next pass asks
   * `measureScrollContent` again instead of reusing the cached reach
   * (issue #405). The walk stops where the measurement does: at the first
   * ancestor that clips its children, whose overflow is its own business.
   */
  _markScrollMeasureDirty() {
    for (let n = this; n; n = n.parent) {
      // only a Scrollable carries the flag; a stale `true` on a box that is
      // not currently a scroller costs nothing and re-measures correctly if
      // its style later makes it one
      if (n._scrollMeasureDirty === false) n._scrollMeasureDirty = true;
      if (n !== this && n.clipsChildren()) return;
    }
  }

  /**
   * The rectangle this node's **content** goes in — `abs` inset by the
   * border and the padding, in the owning window's coordinates. Every text
   * element in core paints inside it, and so should anything a registered
   * element draws that the padding is meant to hold off.
   *
   * Public (docs/extending.md) because the arithmetic is not reproducible
   * from `this.style`: the insets come off the yoga node, which is where
   * percentages, the per-side overrides and the border widths have already
   * been resolved against this frame's size. An element deriving them from
   * the style bag instead re-implements a resolution order it cannot see,
   * and silently disagrees with `<text>` the day the vocabulary grows
   * another edge — the per-side border widths (#262) were the last one.
   */
  contentBox() {
    // A node with no yoga node (`{ yoga: false }`) has no resolved insets,
    // so its box is its content box.
    if (!this.yoga) return { ...this.abs };
    const padL =
      this.yoga.getComputedPadding(Yoga.EDGE_LEFT) +
      this.yoga.getComputedBorder(Yoga.EDGE_LEFT);
    const padT =
      this.yoga.getComputedPadding(Yoga.EDGE_TOP) +
      this.yoga.getComputedBorder(Yoga.EDGE_TOP);
    const padR =
      this.yoga.getComputedPadding(Yoga.EDGE_RIGHT) +
      this.yoga.getComputedBorder(Yoga.EDGE_RIGHT);
    const padB =
      this.yoga.getComputedPadding(Yoga.EDGE_BOTTOM) +
      this.yoga.getComputedBorder(Yoga.EDGE_BOTTOM);
    return {
      x: this.abs.x + padL,
      y: this.abs.y + padT,
      width: Math.max(0, this.abs.width - padL - padR),
      height: Math.max(0, this.abs.height - padT - padB),
    };
  }
}
