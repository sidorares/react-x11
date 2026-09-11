// Content floors (#249, #445): the smallest size each box can take without
// clipping its content, measured bottom-up and written into yoga as
// minimums. Free functions over nodes; WindowNode drives them from size.js,
// and a layout host from layouthost.js.

import { Yoga } from '../../yoga.js';
import { NO_CHILDREN } from '../util.js';

/**
 * Record how tall every leaf in this subtree currently is, keyed by node.
 *
 * A leaf's height at a given width is not something it can give: a
 * paragraph wrapped to 300px is as tall as it is. But `align-items` defaults
 * to `stretch`, so a leaf inside a `row` takes the row's height — and in a
 * pass run with no height on offer the row came out at nothing, taking its
 * leaves down with it. A container in that position is recovered by looking
 * inside it; a leaf has nothing inside, which is what this is for.
 *
 * Only the leaves the measurement is going to ask about: the walk goes
 * through the nodes whose height extent is stale and no others.
 */
export function captureLeafHeights(node, out) {
  // a layout host is a leaf to the floors, as it is to yoga
  if (node._host !== null) {
    out.set(node, node.yoga.getComputedHeight());
    return;
  }
  let leaf = true;
  for (const child of node.children) {
    if (!child.yoga || child.isWindow) continue;
    if (child.style.display === 'none') continue;
    if (child.style.position !== 'absolute') leaf = false;
    if (child._floorH === undefined) captureLeafHeights(child, out);
  }
  if (leaf) out.set(node, node.yoga.getComputedHeight());
}

/**
 * Whether this node has **named a floor of its own** on `axis` — the cases
 * where CSS's `min-*: auto` is not the content-based minimum, so the node may
 * give way to whatever squeezes it and its contents stop counting:
 *
 * - it clips, so what overflows it is not something to make room for. CSS
 *   computes `min-*: auto` to `0` on anything whose overflow is not
 *   `visible`, and it is the escape hatch Qt spells `QScrollArea` and GTK
 *   spells `min-content-width`;
 * - the author wrote a number in `minWidth`/`minHeight`. `0` — "I can be any
 *   size" — is the one that matters and the one a scroll container gets
 *   given.
 *
 * This used to read "it was told it may shrink", back when `flexShrink`
 * defaulted to yoga's `0` and asking for `1` was therefore a statement. Every
 * node may shrink now (#249), so the clause carried no information and had to
 * go: `minWidth: 0` is how a style says "down to nothing", and `flexShrink`
 * is back to meaning only how eagerly the space *above* the floor is given
 * up.
 */
function namesOwnFloor(node, axis) {
  const style = node.style;
  if (style.overflow === 'scroll' || style.overflow === 'hidden') return true;
  return (
    typeof (axis === 'width' ? style.minWidth : style.minHeight) === 'number'
  );
}

/**
 * Whether this node's laid-out extent in a min-content pass is already the
 * answer, so there is no need to look inside it. Everything that names a
 * floor, plus the two other ways a style can bound itself: a **size**, which
 * a min-content measurement here keeps rather than shrinking past (see
 * `writeFloors`), and a **ceiling**, since CSS clamps the content
 * suggestion by the specified `max-*` too.
 */
export function declaresOwnMinimum(node, axis) {
  if (namesOwnFloor(node, axis)) return true;
  const style = node.style;
  const [size, max] =
    axis === 'width'
      ? [style.width, style.maxWidth]
      : [style.height, style.maxHeight];
  return typeof size === 'number' || typeof max === 'number';
}

/** In this node's parent's flow at all: an absolute or `display: 'none'`
 *  child is not a flex item and contributes nothing to what contains it —
 *  CSS says the same about both. */
export function inFlow(node) {
  return (
    node.yoga &&
    !node.isWindow &&
    node.style.position !== 'absolute' &&
    node.style.display !== 'none'
  );
}

/** Which axis this node lays its children out along. */
const mainAxisOf = (node) => {
  const direction = node.style.flexDirection ?? 'column';
  return direction === 'row' || direction === 'row-reverse'
    ? 'width'
    : 'height';
};

/**
 * Whether `child` is one the floors are **written on** along `axis`: a flex
 * item on its container's main axis whose author left the minimum to the
 * content. The same test `writeFloors` applies, asked ahead of time — it is
 * what decides whether a stale extent is one anybody will read.
 */
function receivesFloor(child, axis) {
  const parent = child.parent;
  if (
    !parent ||
    parent._host !== null ||
    mainAxisOf(parent) !== axis ||
    !inFlow(child)
  ) {
    return false;
  }
  const own = axis === 'width' ? 'minWidth' : 'minHeight';
  return typeof child.style[own] !== 'number';
}

/**
 * Find what the last measurement can no longer answer for, before a layout
 * pass clears the evidence.
 *
 * The floors are content, and yoga already keeps the exact record of which
 * content moved: a style setter that changed something, a child that came
 * or went, a text that asked to be re-measured all mark their node dirty
 * and every node above it, and the next `calculateLayout` clears the lot.
 * So this walks the dirty part of the tree — and only that part, since a
 * clean node has clean children — and takes the cached extents off every
 * node it finds (`_floorW`/`_floorH`), which is what "stale" means from
 * here on. The dirty nodes are listed for `writeFloors`: they are the
 * nodes whose children's floors can have moved — as is, later, every node
 * `contentSpan` measures a child of, since a window's natural-size
 * measurement (`_measure`) clears yoga's record before the first floors
 * pass, and a scroll pane's rows measured through a clean scroll pane still
 * need their floors written.
 *
 * `found` records whether any stale node is one a floor is written on: if
 * none is, no measurement is owed on that axis at all, whatever changed —
 * the extents that moved are ones nobody reads. An extent nobody read
 * stays unmeasured, on a clean node, for as long as nobody does; it is
 * asked for at the one moment it can start to matter, which is when its
 * parent changes (a column that turns into a row), and its parent is dirty
 * then. So the children of a dirty node are all looked at, and only the
 * dirty ones are descended into.
 *
 * Until the first floors pass has settled both axes (`sweep`), the walk
 * also goes down through nodes that were never measured, dirty or not: a
 * window's natural-size measurement (`_measure`) lays the tree out before
 * the first floors pass and clears yoga's record on the way, and a scroll
 * pane that names its own minimum receives no floor while the rows inside
 * it do. After that pass every reachable node has an extent on any axis
 * that had a floor to write, and the dirty path is the whole story.
 *
 * A `display: 'none'` subtree is marked and left: it takes part in no
 * layout, and a change inside it is still there when it is shown again,
 * because yoga clears a hidden node's own flag but never its children's.
 */
export function collectFloorStale(node, stale, found, sweep) {
  for (const child of node.children) {
    if (!child.yoga || child.isWindow) continue;
    const dirty = child.yoga.isDirty();
    if (dirty) {
      child._floorW = undefined;
      child._floorH = undefined;
      // the minimum yoga holds may not be ours any more: a style change on
      // this node went through `applyLayoutStyle`, which writes the
      // author's minimum over whatever floor was there
      child._floorMinW = null;
      child._floorMinH = null;
    }
    if (child.style.display === 'none') continue;
    // A layout host reads its children's min-content widths
    // (`LayoutChild.intrinsicSizes`), so an extent one of them is missing is a
    // width pass owed, though no flex floor is written from it.
    if (
      child._floorW === undefined &&
      (receivesFloor(child, 'width') || node._host != null)
    ) {
      found.width = true;
    }
    if (child._floorH === undefined && receivesFloor(child, 'height')) {
      found.height = true;
    }
    if (dirty) stale.add(child);
    else if (
      !sweep ||
      (child._floorW !== undefined && child._floorH !== undefined)
    ) {
      continue;
    }
    collectFloorStale(child, stale, found, sweep);
  }
}

/**
 * After a pass that settled the widths: which of the height floors, each a
 * height *for a width*, were measured for a width their node no longer has.
 *
 * Walks down through every node whose width moved — a clean subtree whose
 * root is still the width it was measured at holds no surprises, so the
 * walk stops there — and asks each leaf it reaches the one question that
 * matters, in JavaScript rather than through a layout pass: is your height
 * at this width the height you had at the old one? A paragraph that still
 * fits on its line says no, and so does every unwrapped label in a grid
 * whose cells just moved a pixel, which is what makes a relayout of a large
 * tree one pass instead of four. A leaf that wraps differently is marked
 * stale with everything above it, and `hit.owed` says whether any of those
 * is a node a floor is written on.
 *
 * Widths are compared with a pixel of slack: the measuring passes run with
 * the pixel grid off and the real one with it on, so the same layout reads
 * a fraction apart between them.
 */
export function probeHeightFloors(node, root, hit) {
  for (const child of node.children) {
    if (!child.yoga || child.isWindow) continue;
    if (child.style.display === 'none') continue;
    const stale = child._floorH === undefined;
    const width = child.yoga.getComputedWidth();
    const at = child._floorAtW;
    if (!stale && at !== undefined && Math.abs(width - at) < 1) continue;
    if (child._measureFn) {
      if (
        !stale &&
        at !== undefined &&
        child._heightForWidth(width) !== child._heightForWidth(at)
      ) {
        markHeightStale(child, root, hit);
      }
    } else {
      probeHeightFloors(child, root, hit);
    }
    // whatever the extent is, it is the extent for this width now — a
    // stale one is about to be measured here, a clean one was just checked
    child._floorAtW = width;
  }
}

/** A leaf whose height moved takes every extent above it with it. */
function markHeightStale(node, root, hit) {
  hit.marked = true;
  for (let n = node; n && n !== root; n = n.parent) {
    if (n._floorH === undefined) continue;
    n._floorH = undefined;
    root._floorsStale.add(n);
    if (receivesFloor(n, 'height')) hit.owed = true;
  }
}

/**
 * Put the tree in the state a **min-content** measurement means: a node that
 * has said how small it can be is let go all the way down to it, and a node
 * that has not cannot give at all, because what it needs is the thing being
 * measured.
 *
 * This is what the layout pass with no room on offer used to get from yoga's
 * own `flexShrink: 0` default. Now that the default is CSS's `1` (#249) the
 * pass has to be told, or every node would shrink to nothing and answer that
 * the content needs no room — which is true of no content anywhere.
 *
 * Every child of a node being measured is told, so that the node's own
 * layout is the one it always was; below a child whose extent is still
 * good nothing is, since nothing in there is read. `out` collects what was
 * written so `restoreShrink` can put back exactly that.
 */
export function setMeasuringShrink(node, axis, out) {
  for (const child of node.children) {
    if (!child.yoga || child.isWindow) continue;
    // …and not into a `display: 'none'` subtree, which the measurement does
    // not read and the floors are not written back through
    if (child.style.display === 'none') continue;
    const shrink = namesOwnFloor(child, axis) ? 1 : 0;
    if ((child.style.flexShrink ?? 1) !== shrink) {
      child.yoga.setFlexShrink(shrink);
      out.push(child);
    }
    // not into a layout host's children: they are not flex items, and
    // their own floors are measured tree by tree
    if (floorStale(child, axis) && child._host === null) {
      setMeasuringShrink(child, axis, out);
    }
  }
}

/** …and back to the layout everything else is run from. */
export function restoreShrink(shrunk) {
  for (const child of shrunk) {
    child.yoga.setFlexShrink(child.style.flexShrink ?? 1);
  }
}

/** Whether `node`'s extent along `axis` has to be measured again. */
const floorStale = (node, axis) =>
  (axis === 'width' ? node._floorW : node._floorH) === undefined;

/**
 * Pin every box under `node` at the width the pass just settled it at, so
 * that the collapse which follows can only take **height** away.
 *
 * A minimum height is always a height *for a width* (`_applyContentFloors`),
 * and the width it is for is the one the first pass settled — the tree at the
 * size it is really about to be laid out at. The collapsing pass is asked
 * only how much of that height the tree can give back, and it has no business
 * re-deciding the widths on the way. Left to itself it does, because offering
 * no height at all is not a small layout but a degenerate one: yoga answers a
 * box measured against a zero cross size out of its bounds, without laying
 * its children out at all, and where the width on offer was *also* undefined
 * that bound is the node's `min-width` — the min-content floor this same
 * routine wrote a moment earlier. Under a horizontally scrolling box the
 * width is exactly what is undefined, a scroll container withholding its
 * main-axis size from a child's flex basis the way browsers do. So the
 * subtree was laid out at min-content **width**, where a label takes two
 * lines, and the two-line height became the floor of the row around it: one
 * line of text in a box that reserved two (issue #311).
 *
 * Pinning is enough because that answer is only wrong where there was no
 * width to answer with — a box that names its own is measured at it whatever
 * else the pass is doing, and its children are laid out inside that. It costs
 * nothing either: every leaf is offered the width it was already measured at,
 * so the paragraphs the first pass shaped come back out of the layout cache.
 *
 * Pinned as far as the measurement reads, like the shrink: the children of
 * every node whose extent is being measured, and no further.
 */
export function freezeWidths(node, out) {
  for (const child of node.children) {
    if (!child.yoga || child.isWindow) continue;
    // as in `setMeasuringShrink`: a `display: 'none'` subtree was not laid
    // out, so there is no width in there to keep
    if (child.style.display === 'none') continue;
    child.yoga.setWidth(child.yoga.getComputedWidth());
    out.push(child);
    if (child._floorH === undefined && child._host === null) {
      freezeWidths(child, out);
    }
  }
}

/** …and back to the width the style asks for, on exactly what was pinned. */
export function restoreWidths(frozen) {
  for (const child of frozen) child.yoga.setWidth(child.style.width);
}

/**
 * How far this node's content actually reaches along one axis, in its own
 * coordinate space — the reading of a layout the root was given no room for,
 * where `getComputedWidth()` says nothing (a root offered 0 is clamped to 0)
 * but the children still sit where their own styles put them.
 *
 * A **span** rather than a rightmost edge, because a `center` or
 * `space-around` row given less room than it needs overflows *both* sides —
 * exactly as CSS says it should — and its first child's edge lands at a
 * negative offset. The padding and border are added back on both sides
 * because the span is measured between the children, inside them.
 *
 * Out-of-flow children are skipped, as they are in CSS: an absolutely
 * positioned node contributes nothing to what contains it, and a
 * `display: 'none'` one is not there at all.
 *
 * `intrinsic` carries what the leaves measured to before the pass being read
 * squashed them — see `_measureContentSpans`, which is the only caller that
 * needs it. A container that came out at nothing is recovered by looking
 * inside it; a leaf has nothing inside, so it has to be remembered.
 *
 * What every node contributes to the box around it — which is exactly that
 * node's automatic minimum size — is written onto the node (`_floorW`,
 * `_floorH`), so one pass and one walk give the whole tree its floors (#249)
 * instead of a measurement per node, and so that the next measurement can
 * **read it back instead of looking again**: a child whose extent is still
 * there is taken at that number, and nothing under it is visited. The
 * extent is a function of the subtree alone — its content and its styles —
 * which is what makes the cache honest: `collectFloorStale` takes it off
 * every node whose subtree changed, and for a height the width it was
 * measured at is kept beside it (`_floorAtW`) for `probeHeightFloors` to
 * check. The recursion is therefore over the stale children only, and
 * still through the ones whose own content does not count towards this
 * one's: a scroll pane contributes nothing to the floor above it and still
 * needs floors written *inside* it, or the column of rows it holds would
 * shrink to the viewport and there would be nothing left to scroll.
 */
export function contentSpan(node, axis, intrinsic, root) {
  const yoga = node.yoga;
  const horizontal = axis === 'width';
  const own = horizontal ? yoga.getComputedWidth() : yoga.getComputedHeight();
  const [startEdge, endEdge] = horizontal
    ? [Yoga.EDGE_LEFT, Yoga.EDGE_RIGHT]
    : [Yoga.EDGE_TOP, Yoga.EDGE_BOTTOM];
  const axisIsMain = mainAxisOf(node) === axis;
  let start = Infinity;
  let end = -Infinity;
  // What the children after this one were laid out too early by. A node the
  // pass squashed is one its siblings were packed in behind, so recovering
  // its extent without moving them along would lose exactly what was
  // recovered — the span would come out the same as before.
  let shift = 0;
  // A layout host is a leaf here, as it is to yoga: its children are its
  // algorithm's to size, and what it contributes is what the algorithm
  // answers — the leaf case below, which asks its measure function.
  for (const child of node._host === null ? node.children : NO_CHILDREN) {
    // the same set that joins the flex tree: a nested <window> is laid out
    // by itself, and a <text> span has no box of its own
    if (!child.yoga || child.isWindow) continue;
    if (child.style.display === 'none') continue;
    const laidOut = horizontal
      ? child.yoga.getComputedWidth()
      : child.yoga.getComputedHeight();
    let extent = horizontal ? child._floorW : child._floorH;
    if (extent === undefined) {
      const span = contentSpan(child, axis, intrinsic, root);
      // What the child needs from this box. A node that has said how small
      // it can be is taken at its word — the measuring pass already let it
      // shrink to exactly that — and anything else is asked what is inside
      // it. Its laid-out size is deliberately *not* a floor under that
      // answer: nothing shrank in this pass, so a box that measures its own
      // content is sitting at its **max**-content size, which is the width
      // a label would like to be rather than the width it can be squeezed
      // to.
      extent = declaresOwnMinimum(child, axis) ? laidOut : span;
      if (horizontal) child._floorW = extent;
      else {
        child._floorH = extent;
        child._floorAtW = child.yoga.getComputedWidth();
      }
      root._floorsMeasured += 1;
      // a fresh extent is a floor to write, whether or not this node was
      // dirty: see `collectFloorStale`
      root._floorsStale.add(node);
    }
    if (child.style.position === 'absolute') continue;
    const at =
      (horizontal
        ? child.yoga.getComputedLeft()
        : child.yoga.getComputedTop()) + shift;
    // Only along the axis the children are packed on: on the other one they
    // all start from the same edge, so nothing follows anything.
    if (axisIsMain) shift += extent - laidOut;
    start = Math.min(start, at);
    end = Math.max(end, at + extent);
  }
  if (start === Infinity) {
    // A leaf: nothing inside to look at, and what the pass did to it may
    // have been a stretch rather than a measurement. So it is asked again.
    //
    // **Across**, a leaf that measures itself answers outright: the width it
    // gives when offered none is its min-content width, which for a
    // paragraph is its longest word. That *replaces* the laid-out width
    // rather than joining it in a `max`, because a measured leaf's base size
    // is its max-content width — the whole line, unwrapped — and taking the
    // larger of the two would floor every label at the width it would like
    // to be. A leaf that measures nothing has only its own box to report.
    //
    // **Down**, it is what the leaf measured before the collapse squashed
    // it: a height at a settled width is not a leaf's to give.
    if (horizontal) {
      const measured = node._measureFn?.(
        0,
        Yoga.MEASURE_MODE_AT_MOST,
        undefined,
        Yoga.MEASURE_MODE_UNDEFINED,
      )?.width;
      return measured ?? own;
    }
    return Math.max(own, intrinsic?.get(node) ?? 0);
  }
  const edges =
    yoga.getComputedPadding(startEdge) +
    yoga.getComputedPadding(endEdge) +
    yoga.getComputedBorder(startEdge) +
    yoga.getComputedBorder(endEdge);
  return end - start + edges;
}

/**
 * Write CSS's **automatic minimum size** onto the flex items in `node`: a
 * floor of the extent each needs, along the axis its container lays out on.
 *
 * This is the other half of `flexShrink` defaulting to `1` (#249), and
 * neither half is any good without the other. Yoga implements the shrink and
 * not the floor, so a default of `1` on its own shrinks everything to
 * nothing — a scroll pane's content collapses into its viewport and there is
 * nothing left to scroll — while a default of `0` never squeezes a row into
 * the space it has. CSS has both, and what makes its `flex-shrink: 1` safe is
 * that `min-width: auto` on a flex item resolves to the item's min-content
 * size. That is what this writes.
 *
 * Only the **main** axis, as in CSS: shrinking happens along the axis the
 * container packs on, and on the other one an item is stretched or fits its
 * content either way. On the other axis the child gets its style's minimum
 * back — which is what takes a floor off a child whose container turned
 * from a column into a row, since the floor it needs now is on the other
 * axis.
 *
 * Where this deliberately parts company with CSS is a node that named a
 * size: CSS floors that at `min(the size, the content)`, so a `height: 40`
 * box with nothing in it still squashes to nothing in a column too short for
 * it. That rule is survivable on the web because a `<div>` is a *block*
 * container and its children are not flex items at all; here every box lays
 * its children out with flex, so it would apply to the whole tree — and a
 * row of 40px cells silently 8px tall is not what anyone wrote. **A size
 * that was named is a size that is kept**, and `minHeight: 0` is how an
 * author says otherwise.
 *
 * One node's children, from the extents on them (`contentSpan`): the
 * callers run it over every node whose children's extents may have moved,
 * and nothing else — a floor that did not change is not written again, so a
 * clean subtree is neither visited nor dirtied. What was written is kept
 * (`_floorMinW`/`_floorMinH`) so that the next write can tell; a stale
 * extent writes the style's own minimum, which is how a floor comes off a
 * node that is about to be measured, and which is why measuring a node
 * that carries one cannot read it back as content the tree cannot give up.
 *
 * A floor is written **unrounded**, and the measurement it came from ran
 * with the pixel grid off (`measuringExactly`) for the reason given there:
 * rounding a floor grows the tree a pixel per nesting level. What that
 * leaves is a sharp edge in yoga worth knowing about before writing a
 * measure function. A line whose items are all held at their floors is one
 * yoga freezes item by item, subtracting each item's shrink factor from the
 * line's total as it goes; the total only cancels to zero if the sizes add
 * up exactly in binary. Three items of, say, 239.28 in a column that
 * overflows do not, and yoga divides the overflow by the rounding residue
 * instead of skipping the division — the items come back a billion pixels
 * tall (issue #411). Whole pixels cancel exactly, which is why the text
 * measures here answer in them (`TextNode._trim`).
 */
export function writeFloors(node, axis) {
  // a layout host's children are sized by its algorithm, never by a flex
  // line's shrink, so there is no floor to hold them at
  if (node._host !== null) return;
  const horizontal = axis === 'width';
  const axisIsMain = mainAxisOf(node) === axis;
  const own = horizontal ? 'minWidth' : 'minHeight';
  for (const child of node.children) {
    if (!child.yoga || child.isWindow) continue;
    let floor;
    // A floor of 0 is what yoga does anyway, and an author who named their
    // own `minWidth`/`minHeight` has already answered — overwriting it would
    // put a measurement of ours above a number they wrote.
    if (axisIsMain && inFlow(child) && typeof child.style[own] !== 'number') {
      const extent = horizontal ? child._floorW : child._floorH;
      if (extent > 0) floor = extent;
    }
    if ((horizontal ? child._floorMinW : child._floorMinH) === floor) continue;
    const value = floor ?? child.style[own];
    if (horizontal) {
      child.yoga.setMinWidth(value);
      child._floorMinW = floor;
    } else {
      child.yoga.setMinHeight(value);
      child._floorMinH = floor;
    }
  }
}

/** `writeFloors` over the stale nodes of one subtree — a layout host's
 *  child, whose height floors are measured tree by tree
 *  (`Node._measureHostChildHeights`). */
export function writeFloorsWithin(node, axis, stale) {
  if (stale.has(node)) writeFloors(node, axis);
  for (const child of node.children) {
    if (child.yoga && !child.isWindow) writeFloorsWithin(child, axis, stale);
  }
}

/** Take every height extent under `node` off, and list its nodes to be
 *  written again: its width moved, and a height is a height for a width. */
export function forgetHeightFloors(node, stale) {
  node._floorH = undefined;
  stale.add(node);
  for (const child of node.children) {
    if (child.yoga && !child.isWindow) forgetHeightFloors(child, stale);
  }
}
