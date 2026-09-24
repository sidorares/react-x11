// The damage model's vocabulary: the whole-window sentinel, the bounded list
// of rects a frame repaints and how it is merged, the reasons an
// invalidate() may give, and the diff a layout pass reports into. Data and
// pure functions only; the methods that feed it are in invalidate.js.

import { unionRect, rectArea, rectsBounds, rectsOverlap } from './rects.js';

// --- damage -------------------------------------------------------------
//
// A frame either repaints the whole window or a bounded region of it. The
// sentinel is deliberately not a rect: "the whole window" has to stay
// distinguishable from "a rect that happens to cover it", because the
// window can be resized between the invalidation and the paint.
export const FULL_DAMAGE = Symbol('full-damage');

// "I need a frame, but nothing I own changed appearance." Distinct from
// passing no node, which means "something changed and I cannot say where" —
// the safe reading, and the one that repaints everything.
export const NO_DAMAGE = Symbol('no-damage');

// Painting is not perfectly bounded by a node's rect — an antialiased
// rounded corner or glyph edge puts coverage a fraction of a pixel outside
// it — so damage grows by a pixel on each side before anything is culled
// against it.
export const DAMAGE_SLOP = 1;

/** Stale bounds are undebuggable, and every other cache here has an escape
 * hatch — see NO_SCROLL_BLIT and the paint cache's DISABLED. */
export const NO_BOUNDS_CACHE = process.env.REACT_X11_NO_BOUNDS_CACHE === '1';

// The two pieces of state a bounded frame's layout pass reports through.
// One object rather than two `let`s: the pass runs through more than one
// module, and a module cannot assign a binding it imported.
export const layoutDiff = {
  // While a bounded frame's layout pass runs, every node whose absolute rect
  // comes out different reports its old and new rects here (each already
  // inflated by that node's own paint reach) — which is what lets a layout
  // change stay a handful of rects instead of degrading the frame to
  // FULL_DAMAGE. Module state rather than a parameter because absolutize is
  // a hot recursive walk with overrides in three classes; null outside the
  // pass, and always restored through `finally`.
  sink: null,

  // The uniform translation the subtree currently being walked is riding: set
  // while a scroll container whose blit is armed lays its children out, so the
  // diff can tell "moved" from "scrolled" (issue #398). Every child of such a
  // container lands at its old rect plus this shift, which is precisely what
  // the blit is about to do to those pixels — so it is not a change, and the
  // diff reports only the children that landed somewhere else. Null everywhere
  // else, and restored through `finally` like the sink beside it.
  shift: null,

  // True when `shift` is a subtree's own move whose pixels a copy may carry,
  // rather than a scroll: a `<glarea>` child's, moved on its pane
  // (src/glnodes.js, `_absolutizeChild`, issue #644), or one the window may
  // copy in its backing (nodes/moveblit.js, issue #681). A node that lands
  // where it was plus the shift is carried by that copy. A node that turns
  // the diff off under a shift — a scroll pane laid out again, whose box
  // would have claimed its children — claims its own box instead, since the
  // move claimed nothing for it.
  ride: false,
};

// What an invalidate() may name as its reason — a small closed set, so the
// frame log, the tracer and the full-repaint warning can print "why" next
// to "where". A typo'd reason would silently vanish from every report, so
// DEV validates against this list.
export const INVALIDATE_REASONS = new Set([
  'props', // a React commit changed what a node draws
  'position', // an absolute box of a set size moved and changed nothing else
  'style-state', // :hover/:focus/:active/:disabled restyle
  'shadow', // a boxShadow got smaller: where it *was* still owes a repaint
  'outline', // …and the same for an outline a style swap took away
  'theme', // a theme/token change restyled a subtree
  'direction', // the reading direction moved: sides, glyph order, bar edge
  'scale', // a `scale` prop zoomed a subtree: every length in it moved
  'animation', // a transition frame
  'scroll', // scrollTo/scrollBy/scrollIntoView, textarea/textinput panning
  'text', // text content, input value or caret editing
  'selection', // the document selection lit or unlit a range of text
  'content', // async content arrived (image decode, rich-content reflow)
  'measure', // an element said its own size changed (invalidateMeasure)
  'child-list', // children were added, removed or reordered
  'focus', // focus moved: ring/caret handover between nodes
  'caret', // the caret blink timer
  'resize', // the window changed size
  'mount', // the window was just realized; its first frame
  'expose', // ntk asked for a redraw (backing store invalidated)
  'highlight', // DevTools hover highlight
  'trace-updates', // DevTools' outline of what just re-rendered
  'capabilities', // a compositor started or stopped: what the window may paint
  'layout', // a layout algorithm arrived, left, or has something new to read
]);

// A frame with no recorded reasons shares one frozen empty list, so the
// per-frame cost of the reason machinery when nothing is reading it is a
// property write.
export const EMPTY_REASONS = Object.freeze([]);

// How many rectangles a frame's damage is allowed to hold.
//
// Kept much smaller than the equivalent cap in ntk, because a rectangle costs
// more here: ntk pays one extra CopyArea per rectangle, while this pays a whole
// extra pass over the tree — `paintOrder()` allocates and sorts per node — plus
// a clip. Four is enough for the shapes that actually occur (a ticker and a
// table row; a control and the status line it updates) and cheap enough that
// the worst case is not worth avoiding.
export const MAX_DAMAGE_RECTS = 4;

// How much of the box around them several rectangles have to save to be worth
// painting separately. Two adjacent tab headers describe nearly the same area
// either way and are better off as one pass; two corners of the window are not.
const SPLIT_SAVING = 0.75;

/**
 * Merge overlapping rects until none of them overlap.
 *
 * Disjointness is not tidiness here, it is correctness. Each rect gets its own
 * pass over the tree, and a node inside two of them would be painted twice —
 * harmless for opaque drawing, wrong for anything translucent, which would
 * blend over itself. Merging removes the question and saves the duplicated
 * pass at the same time.
 */
function coalesceRects(rects) {
  const out = [];
  for (const rect of rects) {
    let merged = rect;
    for (let i = out.length - 1; i >= 0; i--) {
      if (!rectsOverlap(out[i], merged)) continue;
      merged = unionRect(merged, out[i]);
      out.splice(i, 1);
      // start the scan again: having grown, the rect can now reach ones
      // already passed over
      i = out.length;
    }
    out.push(merged);
  }
  return out;
}

/**
 * Add one rect to a capped, disjoint damage list, returning a new list.
 */
export function addDamageRect(rects, add, cap = MAX_DAMAGE_RECTS) {
  return addDamageRects(rects, [add], cap);
}

/**
 * Add several rects to a capped, disjoint damage list at once, returning a
 * new list.
 *
 * Over the cap, the pair whose merge leaves the least area to paint is
 * merged, so neighbours go first and far-apart rects last. The merged rect
 * can overlap a third one, which it then swallows — and the grown rect a
 * fourth — so a pair is priced by the list it leaves once that has run its
 * course, not by the box around the two. Priced by the box alone, the
 * cheapest pair could be the one whose merge cascades: a rounded pane
 * panned left with furniture in both bottom corners merged its zoom
 * controls into a corner's repair, and the box grew through the minimap
 * and the exposed strip into nearly the whole pane — every frame of the
 * pan going one way was a full repaint (issue #691). Where no merge
 * cascades the two prices order the pairs the same way.
 *
 * Everything a caller has to add goes in one call where it can: added one
 * at a time, each rect is squeezed under the cap as it arrives, and a
 * small one arriving last can only join a box an earlier merge already
 * grew. Offered together, the small ones merge with their neighbours
 * first — an element blit's strips, furniture and corner repairs repaint
 * about a fifth of a pane that way where one at a time took half.
 */
export function addDamageRects(rects, adds, cap = MAX_DAMAGE_RECTS) {
  let out = coalesceRects(
    (rects ?? []).concat(
      adds.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
    ),
  );
  while (out.length > cap) {
    let best = null;
    let bestArea = Infinity;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const merged = coalesceRects(
          out
            .filter((_, k) => k !== i && k !== j)
            .concat([unionRect(out[i], out[j])]),
        );
        let area = 0;
        for (const r of merged) area += rectArea(r);
        if (area < bestArea) {
          bestArea = area;
          best = merged;
        }
      }
    }
    out = best;
  }
  return out;
}

/**
 * The rects a frame actually paints, given the ones that were claimed.
 *
 * Each one costs a pass over the tree and a clip, so a list whose pieces nearly
 * fill the box around them is better served by one pass over that box. Both
 * answers cover every claimed pixel, so this is a cost decision and never a
 * correctness one.
 */
export function damageToPaint(rects) {
  if (rects.length < 2) return rects;
  const box = rectsBounds(rects);
  let sum = 0;
  for (const r of rects) sum += rectArea(r);
  return sum > rectArea(box) * SPLIT_SAVING ? [box] : rects;
}
