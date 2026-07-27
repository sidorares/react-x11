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
 */
export function anchorRect(node, options = {}) {
  if (!node?.abs) return null;
  const {
    placement = 'bottom',
    align = 'start',
    offset = 2,
    width = node.abs.width,
    height = 0,
  } = options;

  const win = node.root?.window;
  const ax = (win?.x ?? 0) + node.abs.x;
  const ay = (win?.y ?? 0) + node.abs.y;
  const aw = node.abs.width;
  const ah = node.abs.height;

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
    x = alignAlong(ax, aw, width);
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
    y = alignAlong(ay, ah, height);
  }

  if (sw != null) x = Math.max(0, Math.min(x, sw - width));
  if (sh != null && height) y = Math.max(0, Math.min(y, sh - height));

  return { x: Math.round(x), y: Math.round(y), width, height, placement: side };
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
