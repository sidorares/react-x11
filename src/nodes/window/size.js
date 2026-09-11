// Windows sized by their content: measuring the tree against its content
// floors, laying the root out, deferring floors during a live resize and
// catching up after, and refitting the window to what it holds.

import { measuringExactly } from '../../styles.js';
import { availableArea } from '../../screens.js';
import {
  captureLeafHeights,
  collectFloorStale,
  probeHeightFloors,
  setMeasuringShrink,
  restoreShrink,
  freezeWidths,
  restoreWidths,
  contentSpan,
  writeFloors,
} from './floors.js';
import {
  MAX_WINDOW_EXTENT,
  clampExtent,
  clampBound,
  screenOriginOf,
  CONTENT_BOUND_PROPS,
  isContentBound,
  numericBound,
  isAutoSize,
  scaleWindowGeometry,
} from './hints.js';

/** Content-sized windows, installed onto `WindowNode.prototype` by window.js. */
export class WindowSize {
  /**
   * One measuring pass over the tree, read back into the extents of every
   * node still to be measured (`contentSpan`), and the root's own span
   * returned — the number a `minWidth="auto"` window sends as its hint.
   *
   * `forWidth` is the width the heights are measured for; `probe` says
   * whether the widths that pass settles are still to be checked against
   * the ones the height floors were measured at (`probeHeightFloors`) —
   * they are when nothing has looked yet this frame, and a leaf the probe
   * finds moved has its floor taken off and the pass run again, since a
   * floor still on a node being measured would be read back as content.
   */
  _measureContentSpans(axis, forWidth, probe = false) {
    this._sweepLayoutHosts();
    const yoga = this.yoga;
    const dir = this._rootDirection;
    // The root carries whatever size the last pass pinned on it, and an
    // available size means nothing to a root that has one of its own.
    yoga.setWidth(undefined);
    yoga.setHeight(undefined);
    if (axis === 'width') {
      // the layout hosts' children first, tree by tree: what they can be
      // squeezed to is what the hosts answer the pass below with
      if (this._layoutHosts.size !== 0) this._measureHostChildWidths();
      const shrunk = [];
      setMeasuringShrink(this, axis, shrunk);
      this._layoutPasses += 1;
      yoga.calculateLayout(0, undefined, dir);
      const span = contentSpan(this, axis, null, this);
      restoreShrink(shrunk);
      return span;
    }
    // Height takes two passes. The first is the tree at its real width with
    // no bound on the height, which is where every leaf reports the height
    // it actually needs there — a wrapped paragraph's is settled by the
    // width, and no leaf can give any of it back. It runs before the shrink
    // is borrowed, since the widths it settles are the real ones. The second
    // is the one that collapses, and it squashes a leaf that a `row`
    // stretches: those are the ones the map above puts back. The widths the
    // first pass settled are held across the second (`freezeWidths`), which
    // is the only thing keeping it a collapse rather than a second opinion.
    this._layoutPasses += 1;
    yoga.calculateLayout(forWidth, undefined, dir);
    if (probe && this._probeHeightFloors().marked) {
      this._writeFloors('height');
      this._layoutPasses += 1;
      yoga.calculateLayout(forWidth, undefined, dir);
    }
    const intrinsic = new Map();
    captureLeafHeights(this, intrinsic);
    const frozen = [];
    freezeWidths(this, frozen);
    const shrunk = [];
    setMeasuringShrink(this, axis, shrunk);
    this._layoutPasses += 1;
    yoga.calculateLayout(forWidth, 0, dir);
    const span = contentSpan(this, axis, intrinsic, this);
    restoreWidths(frozen);
    restoreShrink(shrunk);
    return span;
  }

  /**
   * What the last measurement can no longer answer for, taken off the
   * nodes and listed (`collectFloorStale`). Run ahead of anything that lays
   * the tree out, since a pass clears yoga's record of what changed — and
   * cheap enough to run twice in a frame, because the second walk finds the
   * marks the first one left.
   */
  _collectFloorStale() {
    this._sweepLayoutHosts();
    const found = { width: false, height: false };
    this._floorsStale.clear();
    // the root's own children are written from here too, and its direction
    // can move like any node's
    this._floorsStale.add(this);
    collectFloorStale(this, this._floorsStale, found, !this._floorsSwept);
    return found;
  }

  /** The floors on the children of every node found stale, from the extents
   *  they carry — `writeFloors` for each. */
  _writeFloors(axis) {
    for (const node of this._floorsStale) {
      if (!node.destroyed) writeFloors(node, axis);
    }
  }

  /** `probeHeightFloors` over this window's tree. */
  _probeHeightFloors() {
    const hit = { marked: false, owed: false };
    probeHeightFloors(this, this, hit);
    return hit;
  }

  /**
   * Measure the width extents that are stale and write the width floors
   * from them. The floors on the nodes about to be measured come off first
   * (a stale extent writes the style's own minimum), which is what keeps a
   * floor from ratcheting: read back as content, it could only ever grow.
   */
  _measureWidthFloors() {
    this._writeFloors('width');
    const span = this._measureContentSpans('width');
    this._writeFloors('width');
    return span;
  }

  /** The same for the heights, at `forWidth`. */
  _measureHeightFloors(forWidth, probe) {
    this._writeFloors('height');
    const span = this._measureContentSpans('height', forWidth, probe);
    this._writeFloors('height');
    return span;
  }

  _measureMinimum(axis, forWidth) {
    // Measured from the styles alone: the stale nodes' own floors come off
    // in the measurement, and a clean node's extent was measured the same
    // way before it was floored.
    this._collectFloorStale();
    return measuringExactly(() =>
      Math.ceil(
        axis === 'width'
          ? this._measureWidthFloors()
          : this._measureHeightFloors(forWidth, true),
      ),
    );
  }

  /** The real layout pass: the tree at the window's size, on the pixel grid. */
  _layoutRoot(width, height) {
    this._sweepLayoutHosts();
    this._layoutPasses += 1;
    this.yoga.setWidth(width);
    this.yoga.setHeight(height);
    this.yoga.calculateLayout(width, height, this._rootDirection);
  }

  /**
   * Give every flex item in this window's tree the floor CSS calls its
   * automatic minimum size, so that `flexShrink`'s default of `1` squeezes a
   * row into the space it has without squeezing its contents out of
   * existence, and lay the tree out with them. See `writeFloors` for what
   * that means and why both halves are needed.
   *
   * Two measurements, in this order because they depend that way round: the
   * widths from a pass with no room on offer at all, then — with those floors
   * already applied — the heights at the width the window is about to be laid
   * out at, since a minimum height is always a height *for a width*.
   *
   * Nothing about this is per frame: the floors are content, so they survive
   * every frame that did not change any (`_floorsDirty`), which is what keeps
   * a wheel notch to the one layout pass it always was. And nothing about
   * it is per node either: every node keeps the extent it was last measured
   * at, and a measurement re-reads only the nodes whose subtree changed
   * (`collectFloorStale`), taking the rest at the number they carry. So a
   * padding change on a container measures the container and nothing
   * below it, a row that mounts measures itself alone, and a colour change
   * measures nothing.
   *
   * The passes are paid for only where a floor is going to be **written**
   * from what they find. The width pass runs when a stale node is one on a
   * row's main axis; and the heights are settled the other way round — the
   * real layout runs first, `probeHeightFloors` walks the nodes it moved
   * and asks each leaf whether its height at its new width is the height
   * it had, and only if one says otherwise (or content changed under a
   * node a floor is written on) do the two height passes run and the
   * layout with them. A relayout of a large tree whose labels all still
   * fit — a panel toggle, a theme switch, a resize that wraps nothing — is
   * one pass over yoga where it was four.
   */
  _applyContentFloors(width, height) {
    const found = this._collectFloorStale();
    measuringExactly(() => {
      if (found.width) this._measureWidthFloors();
      else this._writeFloors('width');
      // from the extents on hand; a stale one writes the style's minimum,
      // which is the floor coming off ahead of its measurement below
      this._writeFloors('height');
    });
    let heights = found.height;
    let probed = false;
    if (!heights) {
      this._layoutRoot(width, height);
      heights = this._probeHeightFloors().owed;
      probed = true;
    }
    if (heights) {
      measuringExactly(() => this._measureHeightFloors(width, !probed));
      this._layoutRoot(width, height);
    }
    this._floorsDirty = false;
    this._floorsContentDirty = false;
    this._floorsSwept = true;
    this._floorsWidth = width;
  }

  /**
   * Answer a live resize with the floors already in hand, and measure fresh
   * ones once the drag is over.
   *
   * The floors were half of a relayout on a large tree — three extra layout
   * passes and their walks, measured at 21 of a 44ms frame on 3,600 nodes
   * (`npm run bench:presenters -- --scenario=layout`) before they were
   * measured incrementally — and a resize is the one layout change they
   * cannot follow at input rate: AppKit's resize loop calls the frame for
   * every pointer move, from inside the event, and the next move waits for
   * the frame. So a tick of a drag lays the tree out against the floors the
   * last measurement left, which are exact along the main axis (a
   * min-content width is content, and the content did not move) and a
   * frame stale for wrapped text along the other, and the frame after the
   * release measures once and lays out again — "answer the input, then
   * catch up". Only while the window says it is being resized live
   * (`liveResizing`, set between AppKit's begin and end of the drag; an X
   * window has no such thing and takes the measured path every time), only
   * when the floors exist to reuse, and never over a content change the
   * floors have not seen — a row that mounted mid-drag has no floor at all,
   * and no floor is the collapse #249 exists to prevent.
   */
  _deferContentFloors(width) {
    // nothing to measure: `_applyContentFloors` returns at once, and a
    // catch-up frame would owe nothing
    if (!this._floorsDirty && this._floorsWidth === width) return false;
    return (
      this.window?.liveResizing === true &&
      this._floorsWidth != null &&
      !this._floorsContentDirty
    );
  }

  /**
   * The frame a deferred measurement owes: a full relayout with fresh
   * floors, run on the first frame tick after the live resize ends. One at
   * a time — a drag is many ticks, and the catch-up waits for the last of
   * them rather than following each.
   */
  _scheduleFloorsCatchUp() {
    if (this._floorsCatchUp) return;
    this._floorsCatchUp = true;
    const schedule =
      typeof this.window?.requestAnimationFrame === 'function'
        ? (cb) => this.window.requestAnimationFrame(cb)
        : (cb) => setImmediate(cb);
    const run = () => {
      if (this.destroyed || !this.window) {
        this._floorsCatchUp = false;
        return;
      }
      // still dragging — a drag that pauses has not ended: wait on
      if (this.window.liveResizing) {
        schedule(run);
        return;
      }
      this._floorsCatchUp = false;
      this._floorsDirty = true;
      this.invalidate(true, null, 'resize');
      this.flush();
    };
    schedule(run);
  }

  /**
   * What the content has to say about this window's size: the size it wants
   * for whichever of `width`/`height` is `'auto'`, and the numbers an
   * `'auto'` bound resolves to.
   *
   * The **natural** size is CSS shrink-to-fit, then height-for-width:
   *
   * 1. Lay the tree out with **no available width**, which is what yoga's
   *    `undefined` means: every measure function is asked in
   *    `MEASURE_MODE_UNDEFINED`, text does not wrap, and the root reports
   *    its max-content width.
   * 2. Clamp that into `[minWidth, min(maxWidth, the screen)]`.
   * 3. **Lay out again at the clamped width.** This is the pass that
   *    matters and the one it is tempting to skip: a paragraph that had to
   *    wrap at the clamped width is taller than the max-content pass said,
   *    and a window sized from that first height would cut its own text off.
   *
   * Where CSS and X part ways: shrink-to-fit is
   * `min(max(min-content, available), max-content)`, and that `max(...)`
   * means a CSS box never goes below its min-content size even when it
   * overflows. A window cannot be wider than the screen, so the clamp wins
   * and the content is cut instead.
   *
   * The two answers are the pair Qt and GTK both hand their toplevels —
   * `sizeHint()`/`minimumSizeHint()`, `gtk_widget_measure`'s
   * `(minimum, natural)` — which is why `'auto'` reads as the natural size
   * on a cap and as the minimum on a floor: it means "ask the content",
   * and the content's answer to *how big* is not its answer to *how small*.
   *
   * Runs before `CreateWindow`, so it must not need one: text measures
   * through `app.fonts`, which is the connection's, and the clamp was
   * resolved during `createRoot`. That is the whole point — the window is
   * *created* at its natural size rather than resized into it after mapping,
   * so nothing is ever on screen at the wrong size.
   *
   * Leaves the tree laid out at a size that is nobody's arrangement, so it
   * may only be called on a frame that goes on to lay out — `realize()`,
   * which invalidates, and `_refit()`, which `flush()` only calls when it
   * owes a layout pass anyway.
   */
  _measure() {
    // Every number below — yoga's answers, the monitor rects, the window's
    // live size — is device pixels, so the geometry props convert on entry
    // and the rest of the function never thinks about units again.
    const props = scaleWindowGeometry(this.props, this.scale);
    const autoW = isAutoSize(props.width);
    const autoH = isAutoSize(props.height);
    const yoga = this.yoga;
    // Where the window will open, for picking a monitor: next to its owner
    // where it has one, and wherever the WM puts it otherwise.
    const area = availableArea(this.app, screenOriginOf(props.transientFor));
    // An `'auto'` cap never bounds the pass that resolves it: `maxWidth`
    // there *is* the natural width, so letting it in would be the answer
    // bounding the question.
    const limit = (max, screen) =>
      Math.min(
        numericBound(max) ?? Infinity,
        screen ?? Infinity,
        MAX_WINDOW_EXTENT,
      );
    const availW = limit(props.maxWidth, area?.width);
    const availH = limit(props.maxHeight, area?.height);
    const hints = {};
    if (!yoga) {
      // Only reachable on a torn-down window, and a size still has to be a
      // size: fall back to the space on offer rather than handing `'auto'`
      // through to CreateWindow. Nothing left to measure a bound against.
      return {
        width: autoW
          ? clampExtent(availW, numericBound(props.minWidth), availW)
          : props.width,
        height: autoH
          ? clampExtent(availH, numericBound(props.minHeight), availH)
          : props.height,
        hints,
      };
    }

    // A numeric floor applies to the natural size as it always has; an
    // `'auto'` one is measured below. The height's needs a width to be
    // measured for, and it can never exceed the natural height anyway —
    // same width, every node at or below the size it settled at — so
    // nothing is lost by clamping the height without it.
    const minH = numericBound(props.minHeight);

    // Also run for an axis that is not `'auto'` but whose cap is: a
    // `maxWidth="auto"` on a window with a `width` still has to find out
    // what the content wanted.
    const needW = autoW || isContentBound(props.maxWidth);
    const needH = autoH || isContentBound(props.maxHeight);
    if (!needW && !needH) {
      // Both sizes are the app's, so there is nothing to measure but the
      // bounds — and nothing re-resolves `@width` blocks here: the styles
      // are the ones the window's real size resolved on the last frame,
      // which is the size the floors are wanted for.
      if (isContentBound(props.minWidth)) {
        hints.minWidth = clampBound(this._measureMinimum('width'), availW);
      }
      this._finishHeightFloor(
        hints,
        props,
        this.window?.width ?? props.width,
        availH,
      );
      return { width: props.width, height: props.height, hints };
    }

    const dir = this._rootDirection;
    const measure = () => {
      this._sweepLayoutHosts();
      // The root carries whatever size the last flush() pinned on it — and
      // whatever the floor pass below cleared — so this is re-stated per
      // call rather than hoisted: clearing an axis is what makes yoga
      // measure it rather than fill it.
      yoga.setWidth(needW ? undefined : props.width);
      yoga.setHeight(needH ? undefined : props.height);
      let naturalW;
      if (needW) {
        yoga.calculateLayout(undefined, needH ? undefined : props.height, dir);
        naturalW = clampExtent(yoga.getComputedWidth(), undefined, availW);
      }
      const width = autoW ? clampExtent(naturalW, minW, availW) : props.width;
      // The height-for-width pass. Run even when only the width is auto: it
      // is the layout the window is about to be created at, so leaving the
      // tree holding the max-content one would hand `flush()` a stale
      // arrangement.
      yoga.calculateLayout(width, needH ? undefined : props.height, dir);
      const naturalH = needH
        ? clampExtent(yoga.getComputedHeight(), undefined, availH)
        : undefined;
      const height = autoH ? clampExtent(naturalH, minH, availH) : props.height;
      return { width, height, naturalW, naturalH };
    };

    // `@width`/`@height` blocks and an auto size are mutually circular: the
    // query wants a size the measurement has not produced yet. Broken the way
    // CSS breaks the same cycle for container queries — measure against the
    // space on offer, then re-resolve against the answer, and measure once
    // more if that moved anything. **Once**: a second look settles the common
    // case (a block that turns on below the width the content would have
    // taken) and a third would only be chasing a layout that oscillates,
    // which no size can satisfy.
    this._resolveSizeQueries(
      autoW ? availW : props.width,
      autoH ? availH : props.height,
    );

    // The width floor, measured against the styles the pass below starts
    // from and before it, because it is what the natural width is clamped
    // into. Bounded by the same space the size is: a floor wider than the
    // screen is a window that cannot be put on it, and a floor past
    // `maxWidth` is a `WM_NORMAL_HINTS` that contradicts itself.
    const minW = isContentBound(props.minWidth)
      ? (hints.minWidth = clampBound(this._measureMinimum('width'), availW))
      : props.minWidth;

    let size = measure();
    if (this._resolveSizeQueries(size.width, size.height)) size = measure();
    // …and the container blocks against the arrangement that produced it,
    // so the window is created at the size its content will actually take
    if (this._containerQueryNodes.size !== 0) {
      this._settleContainerQueries(() => {
        size = measure();
      });
    }

    // A cap the content decides is its natural size, never below a floor
    // that was named as a number: `WM_NORMAL_HINTS` with a min above its own
    // max is a struct no window manager can honour.
    if (isContentBound(props.maxWidth)) {
      hints.maxWidth = Math.max(size.naturalW, minW ?? 0);
    }
    if (isContentBound(props.maxHeight)) {
      hints.maxHeight = Math.max(size.naturalH, minH ?? 0);
    }
    // Last, because it is a height *for a width*: the width the window is
    // about to have where the width is still ours to choose, and the one it
    // has where it is not.
    const forWidth =
      autoW && !this._userSized
        ? size.width
        : (this.window?.width ?? size.width);
    this._finishHeightFloor(hints, props, forWidth, availH);
    return { width: size.width, height: size.height, hints };
  }

  /** The `minHeight="auto"` floor, measured for the width just settled. */
  _finishHeightFloor(hints, props, forWidth, availH) {
    if (!isContentBound(props.minHeight)) return;
    hints.minHeight = clampBound(
      this._measureMinimum('height', forWidth),
      availH,
    );
    if (isContentBound(props.maxHeight)) {
      hints.maxHeight = Math.max(hints.maxHeight ?? 0, hints.minHeight);
    }
  }

  /**
   * Keep an `'auto'` window the size of its content while it still owns its
   * own size. Called from `flush()` on any frame that lays out, which is
   * every frame where the natural size could have moved.
   *
   * One rule covers both kinds of window, which is why it is a rule and not
   * two behaviours: **auto tracks the content until something else sets the
   * size.** A `<window>` grows as rows are added to it and stops the moment
   * the user drags an edge — GTK's behaviour, and right for the same reason:
   * the size is the app's opinion until it is the user's. Nothing can ever
   * take a `<popup>`'s size over — it is override-redirect and has no
   * resize handles — so a menu tracks its items for good.
   *
   * The result is applied through the window rather than through props: an
   * auto size is not something React said, so nothing about it should read
   * as a prop change or wait for one.
   *
   * A **bound** the content decides is not covered by that rule and outlives
   * it: `minWidth="auto"` still means the same thing after the user has
   * taken the size over — it is what stops them taking it *too far* — and it
   * means it on a window with a `width` of its own, which never tracked
   * anything. So the floor is re-measured on every frame that lays out, and
   * the size only while it is still the window's to choose.
   */
  _refit() {
    if (this.destroyed) return;
    const wnd = this.window;
    if (!wnd) return;
    const props = this.props;
    const tracking =
      !this._userSized && (isAutoSize(props.width) || isAutoSize(props.height));
    const bounded = CONTENT_BOUND_PROPS.some((key) =>
      isContentBound(props[key]),
    );
    if (!tracking && !bounded) return;
    const asked = this._requestedSize;
    const next = this._measure();
    this._sendSizeHints(props, next.hints);
    if (!tracking) return;
    if (asked && next.width === asked.width && next.height === asked.height) {
      return;
    }
    this._requestedSize = { width: next.width, height: next.height };
    // Asked for, not assumed. `window.width` stays what the server last said
    // until the ConfigureNotify lands, and this frame lays out against that
    // — the echo brings `needsLayout` and an unbounded repaint with it (see
    // the 'resize' listener), which is the same one-frame settle a
    // controlled `width` prop change has always had. Writing the new size
    // onto the window here would be worse than the wait: ntk allocates the
    // backing pixmap from the resize event, so a frame painted at a size the
    // pixmap has not reached yet is a frame clipped to the old one.
    if (typeof wnd.setState === 'function') {
      wnd.setState({ width: next.width, height: next.height });
    } else {
      wnd.resize?.(next.width, next.height);
    }
    // A window that grew is a window whose *placement* moved with it, and
    // the anchored ones have to be told: a completion list that gains a row
    // near the bottom of the screen is one that now flips above the caret.
    // From `next` rather than from the window, which is still the size the
    // server last confirmed.
    this._followAnchor({ width: next.width, height: next.height });
  }

  /** One layout pass at the window's size, with the content floors it
   *  needs: fresh ones when something changed them, the ones in hand during
   *  a live resize, none when nothing moved them. */
  _layoutStep(width, height) {
    // whether this step keeps the content floors: a live resize lays out
    // against the ones in hand, and the layout hosts' children follow suit
    let floors = true;
    if (!this._floorsDirty && this._floorsWidth === width) {
      this._layoutRoot(width, height);
    } else if (this._deferContentFloors(width)) {
      this._scheduleFloorsCatchUp();
      this._layoutRoot(width, height);
      floors = false;
    } else {
      this._applyContentFloors(width, height);
    }
    // The layout hosts' final calls, now the pass has given each its box —
    // before anything reads a child's size (the container queries settle on
    // what this leaves) — and, if an algorithm threw, the same step again
    // with it turned off, so the frame it threw in is already the flexbox
    // one.
    if (this._layoutHosts.size !== 0) {
      // A child's height floors are measured after the pass, at the width it
      // was placed at, and off the pixel grid (`measuringExactly`), which
      // leaves yoga holding a tree laid out under a grid it no longer has:
      // the next pass would lay the whole of it out again, a scroll's
      // included. One more pass now, on the grid, and the frame ends where
      // every other frame does.
      if (this._placeLayoutHosts(floors)) {
        this._layoutRoot(width, height);
        this._placeLayoutHosts(false);
      }
      if (this._abandonFailedHosts()) this._layoutStep(width, height);
    }
  }
}
