// Popup geometry, the React half: the hooks a widget hangs a `<popup>` off
// a node with, and the measurement a menu sizes itself around.
//
// The placement math itself is core (`src/anchor.js`), because a `<popup>`
// that sizes itself from its content places itself from the same functions
// — see the note there.

import { useCallback, useEffect, useRef } from 'react';

export {
  anchorArea,
  anchorOffscreen,
  anchorRect,
  centerRect,
  screenRect,
  subRect,
} from '../anchor.js';

import { anchorOffscreen, anchorRect } from '../anchor.js';

/**
 * useAnchor(ref) — stable `measure(options)` returning `anchorRect` for the
 * referenced node. The anchoring math `Select` used to inline, shared with
 * `Tooltip` and anything else that hangs a `<popup>` off a drawn node.
 */
export function useAnchor(ref) {
  return useCallback((options) => anchorRect(ref.current, options), [ref]);
}

function sameAnchorRect(a, b) {
  return (
    a === b ||
    (a != null &&
      b != null &&
      a.x === b.x &&
      a.y === b.y &&
      a.width === b.width &&
      a.height === b.height &&
      a.placement === b.placement)
  );
}

/**
 * useAnchorTracking(ref, active, getOptions, setRect, onOutOfView) — keeps a
 * popup's `anchorRect` live for as long as `active`, instead of the one-shot
 * measure every caller used to take at open time. A trigger inside a
 * scrolled viewport, one whose own layout moves it (a neighbouring field
 * wrapping to a second line), or an owner window nudged by the window
 * manager or a script all leave a popup that was only ever measured once
 * hanging over stale ground.
 *
 * Subscribes to the anchoring node's owner window (`WindowNode.onAnchorChange`,
 * `nodes.js`) rather than polling: that fires exactly on the events which
 * can actually move the rect — a layout pass and a fresh `_screenOrigin` —
 * so a still trigger costs nothing and a moved one is caught the same frame.
 * `getOptions` is read fresh through a ref on every notification, so callers
 * do not need to memoize it; returning a falsy value skips that tick (the
 * ref not being ready yet, say). `setRect` only runs when the measured rect
 * actually differs, so it will not re-render (or re-`ConfigureWindow` the
 * popup) for a change that turned out not to move anything.
 *
 * A popup is a real X window, not a web element clipped by its ancestors'
 * overflow — following a trigger that has scrolled out of view would leave
 * it floating over content it no longer belongs to, detached from anything
 * the user can see it points at. So once the trigger is entirely past a
 * clipping ancestor's own bounds or past the owner window itself
 * (`Node._offscreen()`, the same check paint culling uses), tracking calls
 * `onOutOfView` instead of measuring — closing the popup, or hiding it, is
 * the caller's call — and does not resume until re-opened. With no
 * `onOutOfView` this just stops updating rather than snapping to a rect
 * that no longer means anything.
 *
 * With an `at` in the options that test is about **the sub-rect**, not the
 * node: an editor scrolls its own text, so the caret leaves the viewport
 * long before the editor does, and a completion popup that waited for the
 * whole editor to scroll away would hang over the middle of a document it
 * had stopped pointing into.
 */
export function useAnchorTracking(
  ref,
  active,
  getOptions,
  setRect,
  onOutOfView,
) {
  const measure = useAnchor(ref);
  const getOptionsRef = useRef(getOptions);
  getOptionsRef.current = getOptions;
  const onOutOfViewRef = useRef(onOutOfView);
  onOutOfViewRef.current = onOutOfView;
  // Read during render, and read again inside the notification, because the
  // two do not happen in that order. Closing a popup sets its rect to null
  // and the *commit* destroys its window — and destroying a window is a
  // layout pass, which notifies from inside the commit, before React gets
  // to the effect cleanup that would have unsubscribed. A subscription that
  // only knew the `active` of the render it was made in would answer that
  // notification by measuring a fresh rect for the popup just closed, and
  // hand back a second window in place of the one that went away.
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!active) return undefined;
    const root = ref.current?.root;
    if (!root?.onAnchorChange) return undefined;
    return root.onAnchorChange(() => {
      if (!activeRef.current) return;
      const node = ref.current;
      // the options before the view test, because `at` is in them: what has
      // to still be visible is the rect the popup points at
      const options = getOptionsRef.current();
      if (!options) return;
      if (anchorOffscreen(node, options.at)) {
        onOutOfViewRef.current?.();
        return;
      }
      const next = measure(options);
      if (!next) return;
      setRect((prev) => (sameAnchorRect(prev, next) ? prev : next));
    });
  }, [active, ref, measure, setRect]);
}

/**
 * useDismissOnWindowBlur(ref, active, onDismiss) — shut a popup when the
 * **window** it belongs to loses focus.
 *
 * A node's `onBlur` does not fire for this, deliberately: a window losing
 * focus leaves the node inside it focused and merely stops it looking
 * active, so the trigger a menu closes on never hears anything. What is left
 * is a menu still open over an application the user has switched away from
 * — and, for the ones that grab, still holding the pointer grab that came
 * with it, so the first click anywhere goes to dismissing it.
 *
 * The window manager's own focus, then, rather than anything in the tree:
 * `WindowNode.onWindowFocusChange` (nodes.js), which the event manager
 * notifies from the same place it suspends the caret.
 */
export function useDismissOnWindowBlur(ref, active, onDismiss) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!active) return undefined;
    const root = ref.current?.root;
    if (!root?.onWindowFocusChange) return undefined;
    return root.onWindowFocusChange((focused) => {
      if (!focused) onDismissRef.current?.();
    });
  }, [active, ref]);
}

/** Measured size of a single-line label, for sizing a popup around it.
 *  Falls back to a rough estimate where no font stack is available. */
export function measureLabel(node, text, style) {
  const fonts = node?.app?.fonts;
  const size = style?.size ?? DEFAULT_LABEL_SIZE;
  if (!fonts?.layout) {
    return { width: String(text).length * size * 0.55, height: size * 1.4 };
  }
  const layout = fonts.layout(String(text), {
    // The face **this node inherits**, not the literal `sans-serif`: the
    // labels these popups are sized around name no family of their own, so
    // the one they are drawn in is the palette's. Measuring in a different
    // face is measuring the wrong label — a menu sized in sans-serif for a
    // row that paints in a wider mono is a menu whose own options wrap.
    family: style?.family ?? node?.inheritedTextStyle?.family ?? 'sans-serif',
    size,
    weight: style?.weight ?? 'normal',
    // dropping this would measure a different face from the one drawn, and
    // the popup sized here would be the wrong width for its own label
    variations: style?.variations,
  });
  return { width: layout.width, height: layout.height };
}

export const DEFAULT_LABEL_SIZE = 13;

/** How long a hover change is held back while the pointer crosses the
 *  polygon — long enough to be forgiving, short enough not to feel stuck. */
export const SAFE_HOVER_DELAY = 320;

/**
 * "Safe polygon" hover, after
 * [floating-ui](https://floating-ui.com/docs/usehover#safepolygon).
 *
 * A submenu opens to the side of its parent row, so reaching it means
 * moving the pointer *diagonally* across the rows in between — and those
 * rows would each take the hover and close the submenu being aimed at. The
 * fix is to treat the triangle between where the pointer was and the near
 * edge of the child surface as "still hovering the parent": while the
 * pointer is inside it, hover changes are held back.
 *
 * `apex` is where the pointer was while it was still over the parent (its
 * exit point, near enough), `rect` the child popup — both in **screen**
 * coordinates, because parent and child are different X windows.
 */
export function movingToward(point, apex, rect, buffer = 8) {
  if (!point || !apex || !rect?.width) return false;
  return pointInPolygon(point, safePolygon(apex, rect, buffer));
}

/** The triangle from `apex` to the child's near edge, grown by `buffer`. */
export function safePolygon(apex, rect, buffer = 8) {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;

  // the edge the pointer has to cross to reach the child
  let a;
  let b;
  if (apex.x <= left) {
    a = { x: left, y: top - buffer };
    b = { x: left, y: bottom + buffer };
  } else if (apex.x >= right) {
    a = { x: right, y: top - buffer };
    b = { x: right, y: bottom + buffer };
  } else if (apex.y <= top) {
    a = { x: left - buffer, y: top };
    b = { x: right + buffer, y: top };
  } else {
    a = { x: left - buffer, y: bottom };
    b = { x: right + buffer, y: bottom };
  }
  return [apex, a, b];
}

/** Ray casting; the polygon is a triangle here but the test is general. */
export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    const straddles = pi.y > point.y !== pj.y > point.y;
    if (
      straddles &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Pointer position of an event in screen coordinates, or null. */
export function screenPoint(ev) {
  const native = ev?.nativeEvent;
  if (native?.rootx == null || native?.rooty == null) return null;
  return { x: native.rootx, y: native.rooty };
}
