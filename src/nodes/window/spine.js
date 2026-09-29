// Column spines: the scope a change outside every sized box can still be
// measured in (`WindowNode._floorsScope`), when what stands between it and a
// box that sizes itself is a run of columns whose height is their content's.
//
// A document, a log, a chat transcript, a feed: one scroll pane, one column
// in it, thousands of blocks in the column. A block that arrives or changes
// there is confined to nothing `isFloorBoundary` recognises, so it used to
// be measured with the whole tree — three layout passes over every block,
// each evicting the one yoga cached for the pass before — to learn the
// extents of one block and the column it sits in. A spine measures the
// block alone and sums the column: `columnHeightSpan` over the extents its
// other children already carry.
//
// Three facts make that the same answer the whole tree gives:
//
// - Down a column whose height is its content's, the measuring passes have
//   no free space to squash into, so a block in it is laid out at its
//   content height in every pass. What it holds is laid out in the height
//   the pass offers the column, though — none under a pane that scrolls,
//   and 0 under the window, which the collapse lays out at 0 and every box
//   on the way down passes on as a bound — and a bound is not nothing: a
//   pane in the block that names a floor is squashed to it, and a basis
//   counts. Laid out alone as the one item of a column that offers the
//   same (`frameFor`), the block comes out the same.
// - Across, a block stretched over its column is as wide as the column's
//   content box, in every pass: now, at the width the heights are measured
//   for, and in the width pass, whose width the way down from the root
//   decides (`widthPassWidth`).
// - Only heights travel up a spine. A column writes floors down its main
//   axis, and the box a spine stops at names its own size on both axes
//   (`isSpineStop`), so no width extent above the block is ever read. They
//   are left unmeasured, which is what the floors do with every extent
//   nobody reads (`collectFloorStale`).
//
// Anything else — a row on the way, a margin or a width that is not a
// length — is not a spine, and the tree is measured whole.

import {
  declaresOwnMinimum,
  inFlow,
  mainAxisOf,
  namesOwnFloor,
} from './floors.js';
import { Yoga } from '../../yoga.js';

const LENGTHS_ACROSS = [
  'margin',
  'marginHorizontal',
  'marginLeft',
  'marginRight',
  'marginStart',
  'marginEnd',
];
const MARGINS = [
  ...LENGTHS_ACROSS,
  'marginVertical',
  'marginTop',
  'marginBottom',
];
const PADDINGS = [
  'padding',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'paddingHorizontal',
  'paddingVertical',
  'paddingStart',
  'paddingEnd',
];

/**
 * A column a spine can sum (`columnHeightSpan`): laid out by flex down its
 * main axis without wrapping, and with a height that is its content's —
 * nothing named on the height axis (`declaresOwnMinimum`), so neither a
 * size, a floor, a ceiling nor a clip stands between its children and its
 * extent.
 */
export function isSummableColumn(node) {
  const style = node.style;
  return (
    node.yoga != null &&
    !node.isWindow &&
    node._host === null &&
    style.display !== 'none' &&
    mainAxisOf(node) === 'height' &&
    style.flexDirection !== 'column-reverse' &&
    (style.flexWrap == null || style.flexWrap === 'nowrap') &&
    !declaresOwnMinimum(node, 'height')
  );
}

/**
 * Where a change stops mattering on its way up: the window, or a column
 * whose extent on both axes is its style's — a scroll pane is the common
 * one — so that what changed inside it moves nothing above it. A column,
 * because it writes its children's floors down its main axis, and a spine
 * only works out heights.
 */
export function isSpineStop(node) {
  if (node.isWindow) return true;
  return (
    node.yoga != null &&
    node._host === null &&
    mainAxisOf(node) === 'height' &&
    declaresOwnMinimum(node, 'height') &&
    declaresOwnMinimum(node, 'width')
  );
}

/**
 * The spine scope of this frame's changes, or null when one of them has
 * none. `sources` are the nodes that changed and are inside no sized box;
 * `listOnly(node)` says whether all a node did was gain or lose children.
 *
 * A change is measured from the highest box on its way up that no column
 * above it can sum — a text inside a row inside a list is measured with the
 * row — and everything above that is summed. A column that only gained or
 * lost children is not measured itself: the children that are new or
 * changed are, and it is summed with the rest.
 *
 * Answers `{ roots, spine, stops }`: the boxes measured alone, with the
 * widths to measure each at (`rootWidths`); the columns summed, deepest
 * first; and the boxes each spine ends at, whose children's floors are
 * written.
 */
export function spineScope(root, sources, listOnly) {
  const roots = new Map();
  const spine = new Set();
  const stops = new Set();
  const offered = new OfferedWidths(root);
  for (const source of sources) {
    const list = listOnly(source);
    // the way up to where the change stops mattering
    const path = [];
    let node = source;
    while (!isSpineStop(node)) {
      path.push(node);
      node = node.parent;
      if (!node) return null;
    }
    if (node !== root && node.root !== root) return null;
    // a stop changed in itself: its padding, its direction — everything it
    // holds is laid out anew, which is the whole tree's measurement
    if (path.length === 0 && !list) return null;
    stops.add(node);
    // the highest box on the way that a column above it cannot sum
    let top = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      const summed = i > 0 || list;
      if (!summed || !isSummableColumn(path[i])) {
        top = i;
        break;
      }
    }
    for (const column of path.slice(top + 1)) spine.add(column);
    const changed = top === -1 ? staleChildren(source) : [path[top]];
    for (const child of changed) {
      if (!child.yoga || child.isWindow || child.style.display === 'none') {
        continue;
      }
      const widths = rootWidths(child, offered, node);
      if (widths === null) return null;
      roots.set(child, widths);
    }
  }
  // A root inside another root is measured with it, and so is a column it
  // would have been summed through.
  const within = (node) => {
    for (let n = node.parent; n; n = n.parent) if (roots.has(n)) return true;
    return false;
  };
  for (const node of [...roots.keys()]) if (within(node)) roots.delete(node);
  // …and one that is not has to be laid out alone as the whole tree lays it
  // out, which only the pass knows for some (`frameFor`)
  for (const [node, widths] of roots) {
    if (!heightHolds(node, widths.frame)) return null;
  }
  for (const node of [...spine]) {
    if (roots.has(node) || within(node)) spine.delete(node);
  }
  // Every other child of a summed column answers from the extent it carries.
  for (const column of spine) {
    for (const child of column.children) {
      if (!child.yoga || child.isWindow) continue;
      if (roots.has(child) || spine.has(child)) continue;
      const flags = styleFlags(child.style);
      if (flags & OUT_OF_FLOW) continue;
      if (child._floorH === undefined || flags & RELATIVE_MARGIN) return null;
    }
  }
  const depth = (node) => {
    let d = 0;
    for (let n = node; n; n = n.parent) d += 1;
    return d;
  };
  return {
    roots,
    spine: [...spine].sort((a, b) => depth(b) - depth(a)),
    stops,
  };
}

/**
 * The column a root is laid out alone as the one item of, for its heights
 * (`_measureSpineRoot`): one that lays it out in what the collapse pass
 * over the whole tree offers the column it sits in.
 *
 * - `COLLAPSED` under the window, which that pass lays out at 0, and under
 *   a stop that only names its floors or clips when every box on the way
 *   up from it passes that 0 on (`passesBound`). Every column the spine
 *   sums passes it on too, having no height of its own — unless it names
 *   a basis or an aspect ratio to lay out what it holds in instead.
 * - `UNBOUNDED` in a column under a pane that scrolls, which measures what
 *   it holds with no bound. The column is laid out at its content's height,
 *   as long as the pane's own item on the way has no basis to start from.
 * - An item of the pane itself is laid out in the pane's height: 0 when
 *   the pane is squashed to nothing, as a pane under the window is, which
 *   the frame copies by scrolling too (`SQUASHED_PANE`); in any other
 *   pane's, which only the pass knows (`OPEN_PANE`).
 *
 * `null` where a box on the way lays out what it holds in a height of its
 * own, which only the pass knows too.
 */
function frameFor(column, stop) {
  if (stop.style.overflow === 'scroll') {
    if (column === stop) {
      return boundFrom(stop) ? SQUASHED_PANE : OPEN_PANE;
    }
    for (let node = column; node !== stop; node = node.parent) {
      if (node.style.aspectRatio > 0) return null;
      if (node.parent === stop && basisOf(node.style) !== 'auto') return null;
    }
    return UNBOUNDED;
  }
  for (let node = column; node !== stop; node = node.parent) {
    if (!passesBound(node)) return null;
  }
  return boundFrom(stop) ? COLLAPSED : null;
}

const COLLAPSED = Object.freeze({ height: 0, scrolls: false });
const UNBOUNDED = Object.freeze({ height: undefined, scrolls: false });
const SQUASHED_PANE = Object.freeze({ height: 0, scrolls: true });
// laid out with no bound, as `UNBOUNDED` — for the roots that nothing about
// the pane's height decides (`heightHolds`)
const OPEN_PANE = Object.freeze({ height: undefined, scrolls: false });

/** Whether the collapse's 0 reaches what `node` holds: no box from it up to
 *  the window has a height of its own to replace it with, and none above
 *  it scrolls, measuring what it holds with no bound. */
function boundFrom(node) {
  for (let n = node; !n.isWindow; n = n.parent) {
    if (!n.parent) return false;
    if (n !== node && n.style.overflow === 'scroll') return false;
    if (!passesBound(n)) return false;
  }
  return true;
}

/**
 * Whether a box lays out what it holds in the bound it is laid out in
 * itself: no height of its own named, no floor above nothing, no basis but
 * 0 and no aspect ratio to take one from. Asked of the style, as everything
 * here is — yoga's getters are a call into the engine and an object each,
 * and a fling asks this of every box up to the window — and it is the
 * style's floor that counts: the one the floors wrote is taken off a box a
 * change is inside before anything is measured (`collectFloorStale`), and
 * every box asked here is one.
 */
function passesBound(node) {
  const style = node.style;
  if (style.height !== undefined && style.height !== 'auto') return false;
  if (style.minHeight !== undefined && style.minHeight !== 0) return false;
  const basis = basisOf(style);
  if (share(basis) || basis > 0) return false;
  return !(style.aspectRatio > 0);
}

/** A length given as a share of something — a percentage — rather than as
 *  a number or `auto`. */
const share = (value) => typeof value === 'string' && value !== 'auto';

/** The basis a style gives a flex item, as yoga takes it: the longhand, or
 *  the shorthand's — 0 for a number, `auto` for either keyword. */
function basisOf(style) {
  if (style.flexBasis !== undefined) return style.flexBasis;
  return typeof style.flex === 'number' ? 0 : 'auto';
}

/**
 * Whether a root laid out alone in `frame` comes out as the whole tree lays
 * it out: there is a frame; no length on its height axis is a share of the
 * column it is not laid out in here; and in a pane that is not squashed,
 * whose height only the pass knows, the root's own height is not decided
 * by it — it does not grow into it, give way to it with a floor, or start
 * from a basis.
 */
function heightHolds(root, frame) {
  if (frame === null) return false;
  const style = root.style;
  const basis = basisOf(style);
  if (
    share(style.height) ||
    share(style.minHeight) ||
    share(style.maxHeight) ||
    share(basis)
  ) {
    return false;
  }
  if (frame !== OPEN_PANE) return true;
  return !(
    root.yoga.getFlexGrow() > 0 ||
    namesOwnFloor(root, 'height') ||
    basis !== 'auto'
  );
}

const OUT_OF_FLOW = 1;
const RELATIVE_MARGIN = 2;
const STYLE_FLAGS = new WeakMap();

/**
 * What the summing asks of a block's style — out of its column's flow
 * (`inFlow`'s half that is style), or a margin that is not a length — kept
 * per style object. A resolved style is replaced when it changes, never
 * edited (`_retarget`), and a column of 1,704 blocks is a handful of
 * styles asked a dozen names each, most of them unset: 20,000 lookups of
 * properties no block has, on every edit to a long document.
 */
function styleFlags(style) {
  let flags = STYLE_FLAGS.get(style);
  if (flags === undefined) {
    flags =
      (style.position === 'absolute' || style.display === 'none'
        ? OUT_OF_FLOW
        : 0) |
      (MARGINS.some((key) => typeof style[key] === 'string')
        ? RELATIVE_MARGIN
        : 0);
    STYLE_FLAGS.set(style, flags);
  }
  return flags;
}

/** The children of a node that gained or lost some: the ones yoga has a
 *  change on record for, and the ones never measured. */
function staleChildren(node) {
  const out = [];
  for (const child of node.children) {
    if (!child.yoga || child.isWindow) continue;
    if (child.yoga.isDirty() || child._floorH === undefined) out.push(child);
  }
  return out;
}

/**
 * The widths a box is measured alone at, or null when it cannot be: in flow
 * and stretched across its column with no width or ceiling of its own
 * across it, so that it is as wide as the column's content box less its
 * margins across. `width` is that box now — the width its heights are for —
 * and `widthPass` the one the width pass over the whole tree would give it
 * (`widthPassWidth`), null where only a pass knows.
 *
 * Both are the width the box is laid out *in*, not its own: yoga lays a
 * root with no width of its own out at the width on offer less its margins,
 * which is what stretching it across the column does. So a margin across is
 * a number the layout takes off either way — a list whose rows are inset
 * from its edges, as a menu's are, is still a spine — and only a margin
 * that is not a length, a percentage or `auto`, ends one: `auto` centres the
 * box instead of stretching it.
 */
function rootWidths(node, offered, stop) {
  const style = node.style;
  const parent = node.parent;
  if (!parent || !inFlow(node) || node._host !== null) return null;
  if (style.width !== undefined || style.maxWidth !== undefined) return null;
  if (typeof style.minWidth === 'string') return null;
  if (!stretched(node)) return null;
  if (MARGINS.some((key) => typeof style[key] === 'string')) return null;
  if (PADDINGS.some((key) => typeof style[key] === 'string')) return null;
  return offered.in(parent, stop);
}

/**
 * The widths a column offers the roots in it (`rootWidths`), worked out once
 * a column rather than once a root — and the column they are laid out in
 * for their heights (`frameFor`), the same for every root in it.
 *
 * Every root in a column is offered the same two, and working out the width
 * pass's walks the way up to the window, with four yoga reads a box for its
 * padding and border across (`insetAcross`). Asked afresh for each root, a
 * fling down a list of rows — a dozen arriving a frame, every one of them a
 * root in the same column — spent 1.8 ms of a 5.9 ms frame on it. Kept for
 * one `spineScope` call, which lays nothing out, so nothing it has read can
 * move under it.
 */
class OfferedWidths {
  constructor(root) {
    this.root = root;
    this.offers = new Map();
    this.insets = new Map();
    this.passWidths = new Map();
  }

  /** `{ width, widthPass, frame }` for a root in `column`: its content box
   *  now, and in the width pass over the whole tree; and the column it is
   *  laid out in, under `stop`. */
  in(column, stop) {
    let offer = this.offers.get(column);
    if (offer === undefined) {
      offer = {
        width: Math.max(0, column.yoga.getComputedWidth() - this.inset(column)),
        widthPass: this.passContent(column),
        frame: frameFor(column, stop),
      };
      this.offers.set(column, offer);
    }
    return offer;
  }

  inset(node) {
    let inset = this.insets.get(node);
    if (inset === undefined) {
      inset = insetAcross(node);
      this.insets.set(node, inset);
    }
    return inset;
  }

  /** `widthPassWidth`, once a box. */
  passWidth(node) {
    let width = this.passWidths.get(node);
    if (width === undefined) {
      width = widthPassWidth(node, this);
      this.passWidths.set(node, width);
    }
    return width;
  }

  /** …and the content box inside it. */
  passContent(node) {
    const width = this.passWidth(node);
    return width === null ? null : Math.max(0, width - this.inset(node));
  }
}

/** Stretched across its parent's column — `alignSelf`, or the column's
 *  `alignItems` when the box leaves it to them. */
function stretched(node) {
  const parent = node.parent;
  if (!parent || mainAxisOf(parent) !== 'height') return false;
  const self = node.style.alignSelf ?? 'auto';
  if (self === 'stretch') return true;
  return (
    self === 'auto' && (parent.style.alignItems ?? 'stretch') === 'stretch'
  );
}

/** Padding and border across, as the last pass resolved them. */
function insetAcross(node) {
  const yoga = node.yoga;
  return (
    yoga.getComputedPadding(Yoga.EDGE_LEFT) +
    yoga.getComputedPadding(Yoga.EDGE_RIGHT) +
    yoga.getComputedBorder(Yoga.EDGE_LEFT) +
    yoga.getComputedBorder(Yoga.EDGE_RIGHT)
  );
}

/**
 * How wide `node` is in the width pass over the whole tree
 * (`_measureContentSpans('width')`), worked out on the way down rather than
 * laid out: the root at nothing, and each box below it either the width its
 * style names or stretched over its column's content box — clamped as yoga
 * clamps it, and never narrower than its own padding and border. Null where
 * the way down is anything else: a row, whose children are as wide as the
 * pass decides.
 */
function widthPassWidth(node, offered) {
  if (node === offered.root) return offered.inset(node);
  const style = node.style;
  let width;
  if (typeof style.width === 'number') width = style.width;
  else if (style.width !== undefined) return null;
  else {
    if (!inFlow(node) || !stretched(node)) return null;
    if (MARGINS.some((key) => typeof style[key] === 'string')) return null;
    const inner = offered.passContent(node.parent);
    if (inner === null) return null;
    const yoga = node.yoga;
    width =
      inner -
      yoga.getComputedMargin(Yoga.EDGE_LEFT) -
      yoga.getComputedMargin(Yoga.EDGE_RIGHT);
  }
  if (typeof style.maxWidth === 'number')
    width = Math.min(width, style.maxWidth);
  else if (style.maxWidth !== undefined) return null;
  if (typeof style.minWidth === 'number')
    width = Math.max(width, style.minWidth);
  else if (style.minWidth !== undefined) return null;
  return Math.max(width, offered.inset(node));
}
