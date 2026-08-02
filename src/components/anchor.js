// Popup geometry: where to put a <popup> anchored to a drawn node, and
// how big to make it around a measured label.

import { useCallback } from 'react';

/** The X screen the node's window lives on, if reachable (the smoke-test
 *  mock app has no screen geometry — callers must cope with null). */
export function screenOf(node) {
  const app = node?.app;
  const screen = (app?.display ?? app?.X?.display)?.screen?.[0];
  return screen?.pixel_width ? screen : null;
}

/**
 * Where to put a `<popup>` anchored to a drawn node, in **screen**
 * coordinates: the owner window's position plus the node's laid-out rect.
 *
 * `placement` is a preference, not a promise — a menu near the bottom of
 * the screen flips above its trigger rather than opening off-screen, and
 * the result is clamped into the screen either way. The chosen side comes
 * back as `placement` so the caller can style accordingly.
 *
 * `alignTo` takes the two axes from **different** nodes: the placement edge
 * from `node`, the alignment from `alignTo`. A submenu is the case that
 * needs it — it belongs against the outer edge of the menu it comes out of,
 * but lined up with the row that spawned it, and that row is inset by the
 * menu's border and padding. Anchoring both to the row opens the submenu
 * *over* its parent by exactly that inset. Both nodes must be in the same
 * window, which is what lets one origin serve both.
 */
export function anchorRect(node, options = {}) {
  if (!node?.abs) return null;
  const {
    placement = 'bottom',
    align = 'start',
    offset = 2,
    width = node.abs.width,
    height = 0,
    alignTo,
  } = options;

  // `_screenOrigin` is what the server says; `x`/`y` are frame-relative
  // under a reparenting WM and are only a fallback (the headless mock has
  // no server to ask)
  const win = node.root?.window;
  const origin = win?._screenOrigin ?? { x: win?.x ?? 0, y: win?.y ?? 0 };
  const ax = origin.x + node.abs.x;
  const ay = origin.y + node.abs.y;
  const aw = node.abs.width;
  const ah = node.abs.height;
  // the rect the *alignment* reads, which is `node`'s own unless the caller
  // split the two axes
  const cross = alignTo?.abs ?? node.abs;
  const cx = origin.x + cross.x;
  const cy = origin.y + cross.y;

  const screen = screenOf(node);
  const sw = screen?.pixel_width;
  const sh = screen?.pixel_height;

  const alignAlong = (start, size, extent) =>
    align === 'center'
      ? start + (size - extent) / 2
      : align === 'end'
        ? start + size - extent
        : start;

  let side = placement;
  let x;
  let y;

  if (side === 'bottom' || side === 'top') {
    const below = ay + ah + offset;
    const above = ay - height - offset;
    if (side === 'bottom' && sh != null && below + height > sh && above >= 0) {
      side = 'top';
    } else if (
      side === 'top' &&
      above < 0 &&
      (sh == null || below + height <= sh)
    ) {
      side = 'bottom';
    }
    y = side === 'bottom' ? below : above;
    x = alignAlong(cx, cross.width, width);
  } else {
    const after = ax + aw + offset;
    const before = ax - width - offset;
    if (side === 'right' && sw != null && after + width > sw && before >= 0) {
      side = 'left';
    } else if (
      side === 'left' &&
      before < 0 &&
      (sw == null || after + width <= sw)
    ) {
      side = 'right';
    }
    x = side === 'right' ? after : before;
    y = alignAlong(cy, cross.height, height);
  }

  if (sw != null) x = Math.max(0, Math.min(x, sw - width));
  if (sh != null && height) y = Math.max(0, Math.min(y, sh - height));

  return { x: Math.round(x), y: Math.round(y), width, height, placement: side };
}

/**
 * Where to put a `<popup>` of this size **centred over the owner window**,
 * in screen coordinates, clamped into the screen. A dialog is anchored to
 * the window rather than to a widget, which is the one placement
 * `anchorRect` cannot express.
 */
export function centerRect(node, { width, height }) {
  if (!node) return null;
  const win = node.root?.window;
  const ww = win?.width ?? width;
  const wh = win?.height ?? height;
  // `_screenOrigin` for the same reason `anchorRect` uses it: `x`/`y` come
  // from ConfigureNotify, and under a reparenting window manager those can be
  // relative to the *frame* rather than the root — which would centre the
  // dialog off by the size of the decoration. The server's own answer is
  // right whatever the WM did. (quartz-wm happens to report root-relative
  // coordinates, so the two agree there; that is not something to rely on.)
  // The raw coordinates stay as the fallback, since the headless mock has no
  // server to ask.
  const origin = win?._screenOrigin ?? { x: win?.x ?? 0, y: win?.y ?? 0 };
  let x = origin.x + (ww - width) / 2;
  let y = origin.y + (wh - height) / 2;

  const screen = screenOf(node);
  if (screen) {
    x = Math.max(0, Math.min(x, screen.pixel_width - width));
    y = Math.max(0, Math.min(y, screen.pixel_height - height));
  }
  return { x: Math.round(x), y: Math.round(y), width, height };
}

/**
 * useAnchor(ref) — stable `measure(options)` returning `anchorRect` for the
 * referenced node. The anchoring math `Select` used to inline, shared with
 * `Tooltip` and anything else that hangs a `<popup>` off a drawn node.
 */
export function useAnchor(ref) {
  return useCallback((options) => anchorRect(ref.current, options), [ref]);
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
    family: style?.family ?? 'sans-serif',
    size,
    weight: style?.weight ?? 'normal',
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
