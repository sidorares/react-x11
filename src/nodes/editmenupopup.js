// The built-in edit menu's popup: a <popup> with a canvas in it, opened at
// the caret or the pointer. The menu's items, geometry and painting are in
// src/editmenu.js; this is the node half that shows them.

import { deviceAnchorArea, windowOrigin } from '../anchor.js';
import { armPasteState, canPaste } from '../pastestate.js';
import {
  XK_RETURN,
  XK_KP_ENTER,
  XK_UP,
  XK_DOWN,
  XK_ESCAPE,
} from '../keysyms.js';
import {
  editMenuColors,
  editMenuGeometry,
  editMenuIndexAt,
  editMenuItems,
  editMenuStep,
  paintEditMenu,
} from '../editmenu.js';
import { CanvasNode } from './canvas.js';
import { PopupNode } from './window/popup.js';

// --- the standard edit menu ------------------------------------------------
//
// Right-click gets Undo/Cut/Copy/Paste with no wiring, the way a browser
// gives `<input>` one. The rows cannot be `Menu` components — those are
// React over the nodes, and a node cannot mount one — so the menu is a
// `<popup>` built here with a `<canvas>` child that paints the rows
// (src/editmenu.js) and handles its own pointer and key events. That reuses
// the popup's pointer grab, dismissal and focus rather than reinventing
// them.
//
// `<textinput>` is a *caller* of this, not its owner (issue #256): the
// enablement rules, the PRIMARY/CLIPBOARD subtleties and the menu's keyboard
// handling are the parts a second editable element would otherwise have to
// re-debug, so they live here, once, behind a verb interface anything can
// speak.

/** Where the popup goes: at `at`, which is in the owner window's coordinates
 * the way a synthetic event's `x`/`y` are, pulled back inside the monitor
 * when the menu would hang off an edge of it. */
function editMenuOrigin(node, at, size) {
  const origin = windowOrigin(node);
  let x = origin.x + (Number.isFinite(at?.x) ? at.x : (node.abs?.x ?? 0));
  let y = origin.y + (Number.isFinite(at?.y) ? at.y : (node.abs?.y ?? 0));
  // the monitor's work area rather than the whole virtual desktop, so a menu
  // near a seam flips back onto the screen it was opened on — the same
  // answer `<ContextMenu>` clamps a pointer-anchored menu into. Clamped, not
  // flipped: there is no anchor rect to flip around.
  const area = deviceAnchorArea(node);
  if (area) {
    x = Math.max(area.x, Math.min(x, area.x + area.width - size.width));
    y = Math.max(area.y, Math.min(y, area.y + area.height - size.height));
  }
  return { x, y };
}

/**
 * Open the standard edit menu on `node`, for a target that speaks a small
 * verb interface.
 *
 * This is what `<textinput>`'s own right-click menu is, and the reason it is
 * exported is that everything about it except the verbs is worth having
 * once: which rows are enabled, Paste watching selection ownership rather
 * than asking the server on the way to opening a menu, the arrow keys and
 * Escape, the pointer grab that dismisses it, and handing the keyboard back
 * where it came from afterwards.
 *
 * ```js
 * openEditMenu(node, { x: ev.x, y: ev.y }, {
 *   canUndo: this.canUndo,  undo: () => this.undo(),
 *   canRedo: this.canRedo,  redo: () => this.redo(),
 *   hasSelection: this.hasSelection(),
 *   cut: () => this.cut(),
 *   copy: () => this.copy(),
 *   paste: () => this.paste(),
 *   selectAll: () => this.selectAll(),
 * });
 * ```
 *
 * **A verb you leave out is a row that is not there**, rather than a greyed
 * one — see `editMenuItems`. A read-only surface passes `hasSelection`,
 * `copy` and `selectAll` and gets a two-row menu; a password field passes no
 * `copy` and no `cut` and gets a menu that offers neither. Leave out every
 * verb and nothing opens at all.
 *
 * @param {Node} node the element the menu belongs to. The popup hangs off it
 *   in the tree, so it goes away with the element and counts as inside it
 *   for `:focus-within`.
 * @param {{x: number, y: number}} at where the pointer was, in the owner
 *   window's coordinates — `ev.x`/`ev.y` from the event that asked for the
 *   menu. A surface with no caret has nothing else to offer, and this is
 *   what it already has.
 * @param {object} actions the verbs, and what each is worth right now:
 *   `hasSelection` (Cut and Copy follow it), `canUndo`, `canRedo`,
 *   `canSelectAll` (defaults to true), and the functions `undo`, `redo`,
 *   `cut`, `copy`, `paste`, `selectAll`.
 */
export function openEditMenu(node, at, actions = {}) {
  closeEditMenu(node);
  if (!node?.root || node.destroyed) return;
  const app = node.app;
  const clipboard = app?.clipboard ?? null;
  // From here on the menu knows whether there is anything to paste. This
  // first open still shows the row enabled — the answer arrives after it
  // is drawn — which is the pre-tracking behaviour, and correct far more
  // often than not.
  if (typeof actions.paste === 'function') armPasteState(app, clipboard);
  const items = editMenuItems(actions, {
    // greyed only when the server has told us the selection is unowned
    // (pastestate.js). Never a round trip on the way to opening a menu.
    canPaste: Boolean(clipboard) && canPaste(app),
  });
  if (items.length === 0) return;

  const style = node.resolvedTextStyle();
  // `at` is `{x: ev.x, y: ev.y}` per the doc above — logical, like every
  // coordinate a handler reads — and everything below is device: the
  // geometry takes the scale so its chrome lands on the same grid as the
  // device-sized text it measures.
  const s = node.scale;
  const geometry = editMenuGeometry(
    items,
    (text) => app?.fonts?.layout(text, style)?.width,
    s,
  );
  const deviceAt = at && {
    ...at,
    ...(Number.isFinite(at.x) && { x: at.x * s }),
    ...(Number.isFinite(at.y) && { y: at.y * s }),
  };
  const { x, y } = editMenuOrigin(node, deviceAt, geometry);
  const colors = editMenuColors(node.theme);
  const state = { active: -1 };
  const choose = (id) => {
    closeEditMenu(node);
    // the target's own entry point, so the row can never drift from what
    // the equivalent shortcut does
    if (id) actions[id]?.();
  };

  const canvas = new CanvasNode(
    {
      focusable: true,
      style: { flexGrow: 1 },
      onDraw: (ctx) =>
        paintEditMenu(ctx, {
          geometry,
          active: state.active,
          colors,
          radius: node.theme?.radius ?? 4,
          layoutOf: (text, color) =>
            app?.fonts?.layout([{ text, ...style, color }], style),
        }),
      onMouseMove: (mv) => {
        const next = editMenuIndexAt(geometry, mv.nativeEvent?.y ?? mv.y * s);
        if (next === state.active) return;
        state.active = next;
        popup.invalidate(false, null, 'style-state');
      },
      onMouseUp: (mv) => {
        const i = editMenuIndexAt(geometry, mv.nativeEvent?.y ?? mv.y * s);
        if (i !== -1) choose(geometry.rows[i].id);
        else closeEditMenu(node);
      },
      onKeyDown: (k) => {
        if (k.keysym === XK_ESCAPE) return closeEditMenu(node);
        if (k.keysym === XK_UP || k.keysym === XK_DOWN) {
          state.active = editMenuStep(
            geometry,
            state.active,
            k.keysym === XK_DOWN ? 1 : -1,
          );
          popup.invalidate(false, null, 'style-state');
          return;
        }
        if (k.keysym === XK_RETURN || k.keysym === XK_KP_ENTER) {
          const row = geometry.rows[state.active];
          if (row && !row.separator) choose(row.id);
        }
      },
    },
    app,
  );

  const popup = new PopupNode(
    app,
    {
      x,
      y,
      width: geometry.width,
      height: geometry.height,
      windowType: 'popup_menu',
    },
    {
      // **The size goes in the props, not only in the attributes.** A
      // `<window>`/`<popup>` size is `'auto'` when the props do not name one,
      // and `realize()` then *measures* the content and overwrites whatever
      // the attributes said (issue #248) — which for a canvas that only
      // `flexGrow`s is nothing at all, so this popup opened 1x1 and the menu
      // was invisible. Every other popup in the tree comes from React, where
      // one props object is both, so nothing else could reach it.
      // Props are the logical contract (`_measure` multiplies them back);
      // the attributes above carry the same size already in device pixels.
      width: geometry.width / s,
      height: geometry.height / s,
      grab: true,
      // a press outside the menu closes it and goes no further, which is
      // what the grab is for
      onDismiss: () => closeEditMenu(node),
    },
  );
  popup.insertBefore(canvas, null);
  node.insertBefore(popup, null);
  popup.realize(null);
  // the rows as they were built, for a test to read: they are painted into a
  // canvas, so there is no tree for `screen` to query them out of
  popup._editMenuRows = geometry.rows;
  node._editMenu = popup;
  // read *before* the menu takes the keyboard, and handed back on close
  node._editMenuRestore = node._focusManager()?.focused ?? null;
  // the menu takes the keyboard so arrows and Escape reach it rather than
  // the element behind it
  popup.events?.focus?.(canvas);
}

/** Whether `node` has the standard edit menu open. An element that paints a
 * selection asks: the popup holds the keyboard, so the element is not
 * focused, and the text the menu is about to act on has to stay visibly
 * selected. */
export function editMenuOpen(node) {
  return Boolean(node?._editMenu);
}

/** Close it, if it is open. The menu closes itself on a choice, a press
 * outside and Escape; this is for an element that has decided the menu no
 * longer applies — its content changed underneath it, or it scrolled. */
export function closeEditMenu(node) {
  const popup = node?._editMenu;
  if (!popup) return;
  node._editMenu = null;
  const restore = node._editMenuRestore;
  node._editMenuRestore = null;
  // the popup is a child, so a node destroyed while its menu was up took the
  // menu with it: there is nothing left to remove and nowhere to hand the
  // keyboard back to
  if (node.destroyed) return;
  node.removeChild(popup);
  const events = node._focusManager();
  if (!events) return;
  // focus goes back where the menu took it from, so typing carries on where
  // it left off — as a pointer focus, since a right-click is what opened the
  // menu and a ring appearing on the way back would be news to nobody. A
  // surface that was not focusable in the first place, or that stopped being
  // on screen while the menu was up, gets nothing back rather than the
  // destroyed menu canvas keeping the keyboard.
  events.focus(events._canRestoreTo(restore) ? restore : null, 'pointer');
}
