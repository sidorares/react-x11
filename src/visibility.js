// `visibility: 'hidden'` — laid out, never drawn, never reached (docs/styling.md,
// "Visibility").
//
// A leaf with no imports, because every layer asks it: the paint walk, the
// hit test, the focus manager, the accessibility model, the surfaces that
// map and unmap with their subtree, and the test harness. One predicate, so
// none of them can disagree about what is hidden.
//
// Two decisions live in the predicate:
//
// - **The whole subtree goes, with no way back inside it.** CSS lets a
//   descendant say `visibility: 'visible'` and reappear inside a hidden
//   parent; here it cannot. That is what lets every walk stop at the hidden
//   node — the paint walk above all, which is the point of the property:
//   nothing under it runs its draw code, no `onDraw`, no text rasterized, no
//   paint cache consulted. A walk that had to look for a descendant showing
//   itself again would visit every node of every hidden subtree on every
//   frame, which is the cost `opacity: 0` already has.
// - **A window is not hidden by it.** `<window>` and `<popup>` are windows of
//   the display system, shown and hidden by their `hidden` prop; a style that
//   left one mapped and drew nothing in it would show whatever the server
//   had there. So a window's own `visibility` is ignored, and a `<popup>`
//   hanging off a hidden node is not hidden by it — the rule `display: 'none'`
//   already follows, since every walk stops at a window.

/** Whether `node` itself is `visibility: 'hidden'` — which hides it and
 *  everything under it. Ancestors are the caller's to walk. */
export function isInvisible(node) {
  return node.style?.visibility === 'hidden' && !node.isWindow;
}

/** Whether `node` is inside a `visibility: 'hidden'` subtree — itself or an
 *  ancestor, up to its window. */
export function inInvisibleSubtree(node) {
  for (let n = node; n; n = n.parent) {
    if (n.isWindow) return false;
    if (n.style?.visibility === 'hidden') return true;
  }
  return false;
}
