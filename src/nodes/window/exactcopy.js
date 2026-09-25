// Measuring a box alone without unsettling the tree around it.
//
// The renderer lays everything out in one yoga config, rounded to the pixel
// grid, and a measurement switches the rounding off (`measuringExactly`,
// styles.js), which yoga answers by treating every layout it has cached as
// stale: the pass after any measurement lays the whole tree out again. On a
// document of 13,000 boxes that pass is 58 ms, where one yoga answers from
// its cache is 0.05 ms. A measurement over the whole tree pays it anyway,
// having just laid everything out three times; a box measured alone — a
// card (`_measureBoundary`), a block on a column spine
// (`_measureSpineRoot`) — is a few dozen boxes, and made the pass after it
// cost the whole tree.
//
// So a box measured alone is measured on copies: its boxes and everything
// under them, copied into a config that is never rounded
// (`exactLayoutConfig`), laid out there, read, and freed. The config the tree
// is laid out in never changes, and yoga's record of the real boxes — their
// caches, what is dirty — is not touched.

import { Yoga } from '../../yoga.js';
import { exactLayoutConfig, measuringInExactConfig } from '../../styles.js';

/**
 * Run `measure` with `root` and everything under it standing on copies of
 * their boxes: every node's `yoga` is its copy for the duration, so the
 * floors code measures, reads and writes extents exactly as it would on the
 * real boxes.
 *
 * What a measurement writes on a node stays — its extents. What it writes on
 * a box — a floor taken off to measure what is under it, a shrink it
 * borrows, a width it pins — goes with the copy, so the floors' record of
 * what each real box holds (`_floorMinW`/`_floorMinH`) is put back, and the
 * floors written after the measurement are judged against the real box.
 */
export function onExactCopy(root, measure) {
  const swapped = [];
  const copy = (node) => {
    const real = node.yoga;
    const box = Yoga.Node.create(exactLayoutConfig());
    box.copyStyle(real);
    if (node._measureFn) box.setMeasureFunc(node._measureFn);
    swapped.push({ node, real, minW: node._floorMinW, minH: node._floorMinH });
    let at = 0;
    // the same children yoga has (`Node._joinsYoga`)
    if (node._host === null) {
      for (const child of node.children) {
        if (!child.yoga || child.isWindow) continue;
        box.insertChild(copy(child), at++);
      }
    }
    node.yoga = box;
    return box;
  };
  const top = copy(root);
  try {
    return measuringInExactConfig(measure);
  } finally {
    for (const { node, real, minW, minH } of swapped) {
      node.yoga = real;
      node._floorMinW = minW;
      node._floorMinH = minH;
    }
    top.freeRecursive();
  }
}
