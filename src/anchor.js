// Popup geometry: where to put a `<popup>` that hangs off something else.
//
// Core rather than `src/components/`, because two callers need it and only
// one of them is a widget. A widget that knows its own size measures the
// rect itself and passes it as `x`/`y` (`useAnchor`, `useAnchorTracking` —
// `src/components/anchor.js`, which re-exports everything here). A `<popup>`
// that sizes itself from its content cannot: its size is settled inside
// `realize()`, between the measurement and `CreateWindow`, which is after
// the last moment React could have computed a position for it. So the
// window places *itself* from the same functions (`WindowNode._followAnchor`,
// nodes.js), and the two paths agree because they are the same code.

import { availableArea } from './screens.js';

/**
 * A node's laid-out rect in **screen** coordinates: the owner window's
 * position plus the node's own box.
 *
 * `_screenOrigin` is what the server says the window is at; `x`/`y` are
 * frame-relative under a reparenting window manager and are only a fallback
 * (the headless mock has no server to ask).
 *
 * Exported because a popup sometimes has to know where its *trigger* is and
 * not only where to put itself — a tooltip's arrow points at the middle of
 * the thing it annotates, which stops being the middle of the tooltip as
 * soon as a screen edge slides one of them.
 */
export function screenRect(node) {
  if (!node?.abs) return null;
  const origin = windowOrigin(node);
  return {
    x: origin.x + node.abs.x,
    y: origin.y + node.abs.y,
    width: node.abs.width,
    height: node.abs.height,
  };
}

/** Where the node's owner window is on the screen. */
function windowOrigin(node) {
  const win = node?.root?.window;
  return win?._screenOrigin ?? { x: win?.x ?? 0, y: win?.y ?? 0 };
}

/**
 * The rect within a node that a popup is anchored to, in the node's own
 * coordinates — a caret, a table cell, a chart datapoint, the span under a
 * text-range tooltip. `width`/`height` default to 0, so `{x, y}` alone is a
 * point.
 *
 * Node-relative rather than screen-relative because the caller measures it
 * against its own content, and because it then survives everything that
 * moves the node: the window being dragged, an ancestor scrolling, the
 * node's own layout shifting. That is what lets `useAnchorTracking` follow a
 * caret with no extra work — it re-reads the options and the node, and the
 * offset between them is still true.
 */
export function subRect(node, at) {
  if (!node?.abs) return null;
  if (!at) return node.abs;
  return {
    x: node.abs.x + (at.x ?? 0),
    y: node.abs.y + (at.y ?? 0),
    width: at.width ?? 0,
    height: at.height ?? 0,
  };
}

/**
 * Has the thing this popup points at scrolled out of view? The check paint
 * culling uses (`Node._offscreen`), asked about the sub-rect rather than
 * about the node: an editor scrolls its own text, so the caret leaves the
 * viewport a long time before the editor does.
 *
 * A degenerate rect counts as its own thinnest visible version — a caret is
 * a line with no width and a `{x, y}` anchor is a point with neither, and
 * having no area is not the same as being off screen.
 */
export function anchorOffscreen(node, at) {
  const rect = subRect(node, at);
  if (!rect || typeof node._offscreen !== 'function') return false;
  return node._offscreen({
    x: rect.x,
    y: rect.y,
    width: Math.max(rect.width, 1),
    height: Math.max(rect.height, 1),
  });
}

/**
 * The area a popup anchored to this node may be placed in: the usable part
 * of the monitor the node is on.
 *
 * The same answer `<window width="auto">` is capped by (`src/screens.js`) —
 * per-monitor, minus the panels — rather than `screen.pixel_width`, which is
 * the whole virtual desktop. On a two-head setup that difference is the
 * difference between a menu flipping at the edge of the monitor it is on and
 * a menu that only flips at the far edge of the *other* monitor, having
 * opened halfway across the seam. `null` where there is nothing to ask,
 * which is the headless mock and a server with no Xinerama and no screen:
 * placement then neither flips nor clamps.
 */
export function anchorArea(node) {
  const app = node?.app;
  if (!app) return null;
  const at = screenRect(node);
  return availableArea(app, at ? { x: at.x, y: at.y } : null);
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
 * `at` anchors to a rect **inside** the node instead of to the node itself
 * (see `subRect`): the caret in an editor, a cell in a table, a point on a
 * chart. Everything else then reads that rect — the side it flips on, the
 * edge it aligns to, the gap `offset` leaves — so a popup anchored to a
 * caret behaves exactly like one anchored to a small widget that happens to
 * be there.
 *
 * `alignTo` takes the two axes from **different** nodes: the placement edge
 * from `node`, the alignment from `alignTo`. A submenu is the case that
 * needs it — it belongs against the outer edge of the menu it comes out of,
 * but lined up with the row that spawned it, and that row is inset by the
 * menu's border and padding. Anchoring both to the row opens the submenu
 * *over* its parent by exactly that inset. Both nodes must be in the same
 * window, which is what lets one origin serve both.
 *
 * `alignOffset` shifts the result along the *alignment* axis, where `offset`
 * moves it along the placement one — and it is applied before the clamp, so
 * a popup nudged towards a screen edge is still brought back from it. What
 * needs it is the difference between lining up a **surface** and lining up
 * what is drawn **in** it: a submenu whose top edge is level with the row
 * that opened it has its first item a border and a padding lower down, and
 * the eye lines up the items, not the boxes.
 *
 * ## Which side is which
 *
 * `placement: 'start'` and `'end'` are the **logical** sides, and they are
 * what a submenu wants: a menu opens away from the edge its rows begin at, so
 * it goes out to the right in an LTR menu and out to the left in an RTL one.
 * `'left'`/`'right'` stay available and stay physical, for the rare placement
 * that really is about the screen. `align: 'start'`/`'end'` mirror the same
 * way — but only when the popup is above or below its trigger, since with a
 * popup beside it the alignment axis is vertical and nothing about a vertical
 * axis mirrors.
 *
 * The direction comes from the anchoring node, so a menu inside a mirrored
 * panel opens the mirrored way without its widget being told.
 */
export function anchorRect(node, options = {}) {
  if (!node?.abs) return null;
  const {
    placement = 'bottom',
    align = 'start',
    alignOffset = 0,
    offset = 2,
    at,
    alignTo,
    direction = node.direction,
  } = options;
  const rtl = direction === 'rtl';

  // The anchor is the sub-rect where there is one, all the way through:
  // the side that flips, the edge that aligns, and — since a popup with no
  // size of its own is as wide as the thing it hangs off — the default
  // width.
  const anchor = subRect(node, at);
  const { width = anchor.width, height = 0 } = options;

  const origin = windowOrigin(node);
  const ax = origin.x + anchor.x;
  const ay = origin.y + anchor.y;
  const aw = anchor.width;
  const ah = anchor.height;
  // the rect the *alignment* reads, which is the anchor's own unless the
  // caller split the two axes — one origin serves both, since both nodes are
  // in the same window
  const cross = alignTo ? (subRect(alignTo) ?? anchor) : anchor;
  const cx = origin.x + cross.x;
  const cy = origin.y + cross.y;

  const area = anchorArea(node);
  const left = area?.x ?? 0;
  const top = area?.y ?? 0;
  const right = area ? area.x + area.width : null;
  const bottom = area ? area.y + area.height : null;

  // `mirrored` is only ever true on the horizontal axis: `alignAlong` serves
  // both, and a vertically-aligned popup's `start` is the top in every
  // direction there is.
  const alignAlong = (start, size, extent, mirrored) => {
    const edge =
      align === 'center'
        ? 'center'
        : (align === 'end') !== mirrored
          ? 'end'
          : 'start';
    return (
      alignOffset +
      (edge === 'center'
        ? start + (size - extent) / 2
        : edge === 'end'
          ? start + size - extent
          : start)
    );
  };

  let side =
    placement === 'start'
      ? rtl
        ? 'right'
        : 'left'
      : placement === 'end'
        ? rtl
          ? 'left'
          : 'right'
        : placement;
  let x;
  let y;

  if (side === 'bottom' || side === 'top') {
    const below = ay + ah + offset;
    const above = ay - height - offset;
    if (
      side === 'bottom' &&
      bottom != null &&
      below + height > bottom &&
      above >= top
    ) {
      side = 'top';
    } else if (
      side === 'top' &&
      above < top &&
      (bottom == null || below + height <= bottom)
    ) {
      side = 'bottom';
    }
    y = side === 'bottom' ? below : above;
    x = alignAlong(cx, cross.width, width, rtl);
  } else {
    const after = ax + aw + offset;
    const before = ax - width - offset;
    if (
      side === 'right' &&
      right != null &&
      after + width > right &&
      before >= left
    ) {
      side = 'left';
    } else if (
      side === 'left' &&
      before < left &&
      (right == null || after + width <= right)
    ) {
      side = 'right';
    }
    x = side === 'right' ? after : before;
    y = alignAlong(cy, cross.height, height, false);
  }

  if (right != null) x = Math.max(left, Math.min(x, right - width));
  if (bottom != null && height) y = Math.max(top, Math.min(y, bottom - height));

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

  const area = anchorArea(node);
  if (area) {
    x = Math.max(area.x, Math.min(x, area.x + area.width - width));
    y = Math.max(area.y, Math.min(y, area.y + area.height - height));
  }
  return { x: Math.round(x), y: Math.round(y), width, height };
}
