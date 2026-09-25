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
//   content height in every pass. Laid out alone with no height on offer,
//   it comes out the same.
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
// Anything else — a row on the way, a margin across the block, a width
// that is not a length — is not a spine, and the tree is measured whole.

import { declaresOwnMinimum, inFlow, mainAxisOf } from './floors.js';
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
      const widths = rootWidths(child, root);
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
  for (const node of [...spine]) {
    if (roots.has(node) || within(node)) spine.delete(node);
  }
  // Every other child of a summed column answers from the extent it carries.
  for (const column of spine) {
    for (const child of column.children) {
      if (!inFlow(child) || roots.has(child) || spine.has(child)) continue;
      if (child._floorH === undefined) return null;
      if (MARGINS.some((key) => typeof child.style[key] === 'string')) {
        return null;
      }
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
 * and stretched across its column with no margin, width or ceiling of its
 * own across it, so that it is exactly as wide as the column's content box.
 * `width` is that box now — the width its heights are for — and
 * `widthPass` the one the width pass over the whole tree would give it
 * (`widthPassWidth`), null where only a pass knows.
 */
function rootWidths(node, root) {
  const style = node.style;
  const parent = node.parent;
  if (!parent || !inFlow(node) || node._host !== null) return null;
  if (style.width !== undefined || style.maxWidth !== undefined) return null;
  if (typeof style.minWidth === 'string') return null;
  if (!stretched(node)) return null;
  if (
    LENGTHS_ACROSS.some((key) => style[key] !== undefined && style[key] !== 0)
  ) {
    return null;
  }
  if (MARGINS.some((key) => typeof style[key] === 'string')) return null;
  if (PADDINGS.some((key) => typeof style[key] === 'string')) return null;
  return {
    width: contentWidth(parent),
    widthPass: widthPassContent(parent, root),
  };
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

/** A box's content width in the last pass. */
function contentWidth(node) {
  return Math.max(0, node.yoga.getComputedWidth() - insetAcross(node));
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
function widthPassWidth(node, root) {
  if (node === root) return insetAcross(node);
  const style = node.style;
  let width;
  if (typeof style.width === 'number') width = style.width;
  else if (style.width !== undefined) return null;
  else {
    if (!inFlow(node) || !stretched(node)) return null;
    if (MARGINS.some((key) => typeof style[key] === 'string')) return null;
    const inner = widthPassContent(node.parent, root);
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
  return Math.max(width, insetAcross(node));
}

/** …and the content box inside it. */
function widthPassContent(node, root) {
  const width = widthPassWidth(node, root);
  return width === null ? null : Math.max(0, width - insetAcross(node));
}
