// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { capBand, capTrim, rowRadius, useTheme } from './theme.js';
import { Icon, iconSize } from './Icon.js';
import {
  DEFAULT_LABEL_SIZE,
  anchorRect,
  measureLabel,
  movingToward,
  SAFE_HOVER_DELAY,
  screenOf,
  screenPoint,
  useAnchorTracking,
  useDismissOnWindowBlur,
} from './anchor.js';
import { typeAheadChar, useTypeAhead } from './typeahead.js';
import { useGlobalMenu } from '../globalmenu.js';
import {
  ariaKeyShortcuts,
  checkShortcut,
  formatShortcut,
  hasSubmenu,
  isEnabled,
  isSelectable,
  isSeparator,
  visibleItems,
} from '../menuitem.js';
import {
  XK_DOWN,
  XK_END,
  XK_ESCAPE,
  XK_HOME,
  XK_LEFT,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RETURN,
  XK_RIGHT,
  XK_UP,
} from './keys.js';

const h = React.createElement;

// A row is its label with even space all round: the same number left and
// right as above and below, measured to the letters rather than to the
// font's line box (`capTrim`). Which is why the height is derived — hard-code
// it and the vertical space is whatever the ascent happened to leave.
const MENU_ITEM_PAD = 8;
const menuRowHeight = (fontSize) => capBand(fontSize) + MENU_ITEM_PAD * 2;

const MENU_SEPARATOR_HEIGHT = 7;

const MENU_MIN_WIDTH = 140;

// The inset between the popup's edge and a row, which is what makes the
// highlight read as a *pill on* the menu rather than a band across it — and
// what keeps the first and last one clear of the sheet's rounded corners,
// where a full-width highlight would show a square shoulder outside the
// curve. It is also half of a pair: the pill's own radius is derived from it
// so the two corners share a centre (`rowRadius`).
const MENU_PAD = 4;

// A hairline, not `theme.borderWidth`: this border is there to give the sheet
// an edge where it meets the desktop behind it, and a theme that draws 2px
// borders on its *controls* does not mean a 2px outline around every menu.
const MENU_BORDER = 1;

// How far a bar item's pill sits inside the bar, taken out of its padding so
// the bar's height does not change. The strip carries the same inset at its
// two ends: a pill that starts in the window's own corner reads as part of
// the frame rather than as something on a strip, and the first menu is the
// one every pointer arrives at.
const BAR_INSET = 3;
// the gap between two pills, split between them
const BAR_GAP = 1;

// A bar item wears the same pill as a row in the menu it opens, so it takes
// the row's padding rather than numbers of its own: a title packed tighter
// than its own first row is the tell that the two were measured separately.
// Vertically that is `MENU_ITEM_PAD` exactly — same padding, same `capTrim`
// text — which makes the pill `menuRowHeight` tall, and the bar that much
// taller for it.
//
// Horizontally it takes a little more. A row's label is not `MENU_ITEM_PAD`
// from the pill's edge but a whole `MENU_GUTTER` in, past the check column,
// so matching the row's padding here would read as the cramped one: on a
// strip the pills sit shoulder to shoulder, with nothing but that padding
// between one label and the next.
const BAR_ITEM_PAD_X = MENU_ITEM_PAD + 4;

// The bar entry that stands for the titles that did not fit. A symbol rather
// than a `label`, because it is the one entry on the bar the application did
// not write: everything else about it — its popup, its rows, its keys — is
// the ordinary machinery, and a marker no menu object can collide with is
// what keeps it that way.
const OVERFLOW = Symbol('menubar overflow');
const isOverflow = (menu) => Boolean(menu?.[OVERFLOW]);
// A title is keyed by its label; the chevron has none, and a NUL is the one
// key no label can equal — so a menu actually called "More" keeps its
// identity across a resize instead of trading places with the chevron.
const OVERFLOW_KEY = '\0menubar-overflow';

// The horizontal gap between a menu and the submenu it opens, measured from
// the parent popup's outer edge — so `0` is flush against it, a positive
// value leaves the desktop showing between the two, and a negative one
// overlaps the parent the way the classic toolkits do. The pointer crosses
// this gap on its way to the submenu and the safe polygon covers it either
// way (`movingToward`), so this is a matter of taste rather than of reach.
const SUBMENU_GAP = 0;

const MENU_GUTTER = 24; // room for the check column
// what a self-drawing icon gets to fill, inside that column's 16px
const MENU_ICON_SIZE = 12;

const MENU_SHORTCUT_GAP = 24;
// menus size to their content rather than scrolling, so a page is a fixed
// stride — deriving one from the menu height would just equal Home/End
const MENU_PAGE_ROWS = 10;

/** Total popup height for a menu's items (separators are shorter). */
function menuListHeight(items, fontSize) {
  const row = menuRowHeight(fontSize);
  const body = visibleItems(items).reduce(
    (sum, item) => sum + (isSeparator(item) ? MENU_SEPARATOR_HEIGHT : row),
    0,
  );
  return body + (MENU_PAD + MENU_BORDER) * 2;
}

/** Widest label + shortcut, measured, so the popup can be sized up front. */
function menuListWidth(node, items, fontSize) {
  let widest = 0;
  for (const item of visibleItems(items)) {
    if (isSeparator(item)) continue;
    const label = measureLabel(node, item.label ?? '', {
      size: fontSize,
    }).width;
    const accelerator = formatShortcut(item.shortcut);
    const shortcut = accelerator
      ? measureLabel(node, accelerator, { size: fontSize }).width +
        MENU_SHORTCUT_GAP
      : 0;
    widest = Math.max(widest, label + shortcut);
  }
  return Math.max(
    MENU_MIN_WIDTH,
    Math.ceil(widest) +
      MENU_GUTTER +
      (MENU_PAD + MENU_BORDER) * 2 +
      MENU_ITEM_PAD +
      2,
  );
}

/**
 * How much of the bar one title takes, margins included — the same
 * arithmetic the bar itself is laid out with, written next to
 * `menuListWidth` so the two cannot drift.
 */
function barItemWidth(node, label, fontSize) {
  const text = measureLabel(node, label ?? '', { size: fontSize }).width;
  return Math.ceil(text) + (BAR_ITEM_PAD_X + BAR_GAP) * 2;
}

/** The same, for the chevron: an icon box where a title has its label. */
const barOverflowWidth = (fontSize) =>
  iconSize(fontSize) + (BAR_ITEM_PAD_X + BAR_GAP) * 2;

/**
 * How many titles the bar can paint, and therefore where it is cut. The rest
 * go to the chevron.
 *
 * Two passes rather than Qt's one. Qt reserves the extension button's width
 * unconditionally, which spends it on every bar including the ones that
 * never overflow; asking first whether everything fits costs one extra sum
 * and gives the common case its full width back. It cannot oscillate — the
 * second pass only ever runs on a bar already known not to fit, and the
 * chevron is narrower than the title it displaces — which is the trap this
 * shape is usually avoided for.
 *
 * A title that is *partly* visible does not count as visible: half a word is
 * not a menu you can find, and the pointer cannot reach the half that is
 * off-window anyway.
 */
function barCut(node, menus, fontSize, width) {
  const widths = menus.map((menu) => barItemWidth(node, menu.label, fontSize));
  const inner = width - (BAR_INSET - BAR_GAP) * 2;
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (total <= inner) return menus.length;
  const room = inner - barOverflowWidth(fontSize);
  let used = 0;
  let count = 0;
  for (const w of widths) {
    if (used + w > room) break;
    used += w;
    count++;
  }
  return count;
}

/** Next selectable index in `dir`, wrapping, skipping separators/disabled. */
function nextSelectable(items, from, dir) {
  const n = items.length;
  if (!n) return -1;
  for (let step = 1; step <= n; step++) {
    const i = (from + dir * step + n * step) % n;
    if (isSelectable(items[i])) return i;
  }
  return -1;
}

/**
 * dbusmenu's `toggle-state` as ARIA's, which happens to have the same three.
 *
 * That correspondence is the reason `-1` is worth carrying rather than
 * flattening to off: `'mixed'` is how a screen reader says "on for part of
 * the selection", and it has no other way to hear it.
 */
function ariaChecked(state) {
  if (state === 1) return true;
  if (state === -1) return 'mixed';
  return false;
}

/**
 * The glyph for a `toggleType`/`toggleState` pair, or `null` for an item that
 * is not a toggle at all.
 *
 * Three states rather than two, because dbusmenu has three and the third is
 * not "off": `-1` is **indeterminate** — a "Bold" that is on for part of the
 * selection — and drawing it as unchecked would answer a question the item is
 * explicitly declining to answer. GTK draws a dash for it, so a dash it is.
 *
 * An item whose `toggleState` is 0 draws nothing and keeps its gutter, which
 * is what stops a menu of checkboxes from shuffling sideways as they are
 * ticked.
 *
 * These are system icons rather than the `✓`, `●` and `–` they used to be:
 * a text mark is only as good as the font it lands in, which is the exact
 * warning this file gives applications about string `icon`s two doc comments
 * down. Core taking its own advice is the point of the set.
 */
function toggleMark(item) {
  if (!item.toggleType) return null;
  if (item.toggleState === -1) return 'dash';
  if (item.toggleState !== 1) return null;
  return item.toggleType === 'radio' ? 'dot' : 'check';
}

/**
 * What goes in the column to the left of the label: a toggle mark, or the
 * item's `icon`.
 *
 * One column for both, because that is the choice every desktop toolkit
 * makes and the reason is layout rather than taste — a second column would
 * indent every label in the menu to reserve room for icons that most items
 * do not have. An item that is both checked and iconned shows the check,
 * since the check is state and the icon is only identity.
 *
 * Three forms, and the third is the one to reach for. A **string** is drawn
 * as text, which is a one-liner but only as good as the font: `✂` and `⏻`
 * are tofu in Arial, and a menu of empty boxes is worse than a menu with no
 * icons at all. An **element** renders as-is. A **function** is called with
 * the colour the row's label is being drawn in and the size the gutter
 * allows — which is what a `<canvas onDraw>` icon needs, since it has to
 * pick a stroke colour and nothing else can tell it whether its row is
 * highlighted, disabled or at rest.
 */
function gutterMark(item, { color, fontSize }) {
  const toggle = toggleMark(item);
  if (toggle) return h(Icon, { name: toggle, size: MENU_ICON_SIZE, color });
  const { icon } = item;
  if (icon == null) return null;
  if (typeof icon === 'string' || typeof icon === 'number') {
    return h('text', { style: { color, fontSize } }, String(icon));
  }
  return typeof icon === 'function'
    ? icon({ color, size: MENU_ICON_SIZE })
    : icon;
}

/**
 * How a row is drawn, which is three states and not two.
 *
 * `'active'` is the selection: this row is where the menus are being driven
 * from. `'path'` is a row whose submenu has taken that over — it is still
 * the way back to where you are, and it still has to look chosen, but two
 * selection-coloured rows in two menus would be claiming the same thing
 * twice. Every desktop resolves that the same way: the trail goes quiet and
 * only the live end of it stays lit.
 */
function rowState(index, active, handedOn) {
  if (index !== active) return undefined;
  return handedOn ? 'path' : 'active';
}

function MenuRow({
  item,
  state,
  onHover,
  onMove,
  onSelect,
  fontSize,
  nodeRef,
}) {
  const theme = useTheme();
  // only the live end of the trail takes the selection colour, and with it
  // the inverted label
  const active = state === 'active';
  if (isSeparator(item)) {
    return h(
      'box',
      {
        theme,
        role: 'separator',
        style: { height: MENU_SEPARATOR_HEIGHT, justifyContent: 'center' },
      },
      h('box', { style: { height: 1, backgroundColor: theme.border } }),
    );
  }
  const dim = !isEnabled(item);
  const submenu = hasSubmenu(item);
  const accelerator = formatShortcut(item.shortcut);
  if (process.env.NODE_ENV !== 'production') checkShortcut(item);
  return h(
    'box',
    {
      // dbusmenu's three toggle states map onto ARIA's three exactly, which
      // is the reason `toggleState: -1` is worth carrying: `'mixed'` is how a
      // screen reader says "on for part of the selection", and it has no
      // other way to hear it.
      role: item.toggleType
        ? item.toggleType === 'radio'
          ? 'menuitemradio'
          : 'menuitemcheckbox'
        : 'menuitem',
      // the label alone: without it, name-from-contents would read the
      // shortcut and the submenu arrow into the name ("New Ctrl+N")
      'aria-label': typeof item.label === 'string' ? item.label : undefined,
      'aria-keyshortcuts': ariaKeyShortcuts(item.shortcut),
      'aria-checked': item.toggleType
        ? ariaChecked(item.toggleState)
        : undefined,
      'aria-haspopup': submenu ? 'menu' : undefined,
      'aria-expanded': submenu ? state === 'path' : undefined,
      disabled: dim || undefined,
      ref: nodeRef,
      onMouseEnter: dim ? undefined : onHover,
      onMouseMove: dim ? undefined : onMove,
      onClick: dim ? undefined : () => onSelect(item),
      style: {
        height: menuRowHeight(fontSize),
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: MENU_ITEM_PAD,
        paddingRight: MENU_ITEM_PAD,
        cursor: dim ? undefined : 'pointer',
        // A pill inside the sheet: the row is inset from the popup edge by
        // the list's padding, and rounded so that its corner and the sheet's
        // share a centre — the two curves are then one shape rather than two
        // that nearly agree.
        borderRadius: rowRadius(theme, MENU_BORDER, MENU_PAD),
        // Nothing at rest: the sheet under it is already that colour, and
        // now that the row is rounded, repainting it per row would be a
        // coverage mask drawn to change nothing — with four corners it
        // deliberately leaves out.
        backgroundColor: active
          ? theme.hoverBackground
          : state === 'path'
            ? theme.surfaceActive
            : 'transparent',
        // the item is already highlighted by the time it can be pressed, so
        // the press is a further step down rather than a first one — without
        // it the command runs on the release out of a picture that never
        // changed
        ...(dim
          ? null
          : { ':active': { backgroundColor: theme.accentActive } }),
      },
    },
    h(
      'box',
      { style: { width: MENU_GUTTER - MENU_ITEM_PAD, alignItems: 'center' } },
      gutterMark(item, {
        color: dim ? theme.dim : active ? theme.hoverText : theme.text,
        fontSize,
      }),
    ),
    h(
      'text',
      {
        style: [
          capTrim,
          {
            color: dim ? theme.dim : active ? theme.hoverText : theme.text,
            fontSize: fontSize,
          },
        ],
      },
      item.label,
    ),
    h('box', { style: { flexGrow: 1 } }),
    accelerator &&
      h(
        'text',
        {
          style: [
            capTrim,
            {
              color: dim ? theme.dim : active ? theme.hoverText : theme.dim,
              fontSize: fontSize,
            },
          ],
        },
        accelerator,
      ),
    submenu &&
      h(Icon, {
        name: 'chevronRight',
        // The capitals of the row, not the gutter's 16px column: a chevron
        // stands as tall as its box, so `MENU_ICON_SIZE` would put an arrow
        // beside the label taller than the label.
        size: capBand(fontSize),
        color: dim ? theme.dim : active ? theme.hoverText : theme.dim,
      }),
  );
}

/**
 * Items at `depth`, walking `path` down through nested `items`.
 *
 * Hidden items are dropped **here**, at the single point every level is read
 * through, so `path` indexes the rows that exist. Filtering at the draw call
 * instead would leave the keyboard walking a list the eye cannot see.
 */
function levelItems(rootItems, path, depth) {
  let items = visibleItems(rootItems);
  for (let d = 0; d < depth; d++) items = visibleItems(items[path[d]]?.items);
  return items;
}

/**
 * One level of a menu: an override-redirect `<popup>` at `rect` holding the
 * items for `depth`, plus — recursively — its open submenu.
 *
 * Open state is a single `path` of active indices, one per level, rather
 * than a flat index: `path.length` is how many levels are open, `path[d]`
 * which row is active at level `d` (-1 for none). Moving the selection at
 * any level truncates the path, which closes deeper levels for free.
 */
function MenuLevel({
  rect,
  rootItems,
  path,
  depth,
  setPath,
  onSelect,
  onDismiss,
  fontSize,
}) {
  const theme = useTheme();
  const items = levelItems(rootItems, path, depth);
  const active = path[depth] ?? -1;
  const childItems = visibleItems(items[active]?.items);
  const childOpen = path.length > depth + 1 && childItems.length > 0;
  // Has this level's selection handed over to the one below it? A submenu
  // opened with nothing selected in it yet has not: the pointer is still on
  // the row that opened it, and that row is still where the keys go.
  const handedOn = childOpen && (path[depth + 1] ?? -1) >= 0;

  const activeRowRef = useRef(null);
  const listRef = useRef(null);
  const [childRect, setChildRect] = useState(null);

  useEffect(() => {
    if (!childOpen) {
      setChildRect(null);
      return;
    }
    const node = activeRowRef.current;
    // the parent popup is always laid out by the time a submenu can be
    // reached (it has to be hovered or arrowed into first), but guard
    // anyway rather than anchoring off a zero rect
    if (!node?.abs?.width) return;
    setChildRect(
      anchorRect(listRef.current ?? node, {
        placement: 'right',
        // The edge comes from the list box, which fills the popup, and the
        // alignment from the row. Anchoring both to the row put the submenu
        // a border and a padding *inside* its parent's right edge, so the
        // two menus overlapped by five pixels.
        alignTo: node,
        align: 'start',
        // Lined up on the *items*, not on the boxes: the submenu's own
        // border and padding come before its first row, so a popup whose
        // top edge is level with the parent row opens that row's
        // continuation six pixels lower than the row itself. Shifting by
        // the inset puts the first item exactly beside the item it came
        // out of, which is where the eye is already looking.
        alignOffset: -(MENU_BORDER + MENU_PAD),
        offset: SUBMENU_GAP,
        width: menuListWidth(node, childItems, fontSize),
        height: menuListHeight(childItems, fontSize),
      }),
    );
  }, [childOpen, active, depth, fontSize, rect.x, rect.y]);

  // "safe polygon" hover: while a submenu is open, the triangle between the
  // pointer and the submenu's near edge counts as still hovering the parent
  // row, so moving diagonally across the rows in between does not close the
  // submenu being aimed at (docs/components.md).
  const apexRef = useRef(null);
  const pendingRef = useRef(null);

  const cancelPending = () => {
    if (pendingRef.current) {
      clearTimeout(pendingRef.current);
      pendingRef.current = null;
    }
  };

  // any change to the open path — including the pointer reaching the
  // submenu — retires a deferred switch: it would close what was reached
  useEffect(() => cancelPending, []);
  useEffect(cancelPending, [path.join(','), childOpen]);

  const applyHover = (index) => {
    const base = [...path.slice(0, depth), index];
    // hovering a parent row opens its submenu with nothing selected inside
    setPath(hasSubmenu(items[index]) ? [...base, -1] : base);
  };

  const hover = (index, ev) => {
    const point = screenPoint(ev);
    if (
      index !== active &&
      childOpen &&
      childRect &&
      movingToward(point, apexRef.current, childRect)
    ) {
      // heading for the open submenu: hold the switch, but not forever —
      // a pointer that stops inside the triangle still meant this row
      cancelPending();
      pendingRef.current = setTimeout(() => {
        pendingRef.current = null;
        applyHover(index);
      }, SAFE_HOVER_DELAY);
      return;
    }
    cancelPending();
    applyHover(index);
  };

  const move = (index, ev) => {
    // over the row that owns the open submenu: remember where the pointer
    // is, so its exit point becomes the apex of the polygon
    if (index === active) {
      apexRef.current = screenPoint(ev) ?? apexRef.current;
      return;
    }
    // over another row: mouseEnter only fired once, but the pointer is
    // still moving — re-decide, so leaving the polygon switches at once
    // instead of waiting out the delay
    hover(index, ev);
  };

  const choose = (item) => {
    if (hasSubmenu(item)) {
      setPath([...path.slice(0, depth), items.indexOf(item), -1]);
      return;
    }
    onSelect(item);
  };

  return h(
    'popup',
    {
      theme,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      windowType: 'popup_menu',
      grab: depth === 0,
      onDismiss: depth === 0 ? onDismiss : undefined,
      // ARGB where the display has it, so the corners the sheet gives up are
      // the desktop rather than a colour. The window paints nothing itself
      // when it can be seen through — the list box below is the whole of the
      // menu, and a square fill under it would put the corners straight back.
      // Without a compositor the window is the opaque rectangle it always
      // was, and the list box's rounding is gated off to match.
      transparent: true,
      style: {
        backgroundColor: theme.background,
        '@supports transparency': { backgroundColor: 'transparent' },
      },
    },
    h(
      'box',
      {
        ref: listRef,
        role: 'menu',
        style: {
          flexGrow: 1,
          flexShrink: 1,
          padding: MENU_PAD,
          borderWidth: MENU_BORDER,
          borderColor: theme.border,
          backgroundColor: theme.background,
          '@supports transparency': { borderRadius: theme.radiusPopup },
        },
      },
      items.map((item, index) =>
        h(MenuRow, {
          key: isSeparator(item) ? `sep-${index}` : (item.key ?? item.label),
          item,
          state: rowState(index, active, handedOn),
          fontSize,
          nodeRef: index === active ? activeRowRef : undefined,
          onHover: (ev) => hover(index, ev),
          onMove: (ev) => move(index, ev),
          onSelect: choose,
        }),
      ),
    ),
    childOpen &&
      childRect &&
      h(MenuLevel, {
        rect: childRect,
        rootItems,
        path,
        depth: depth + 1,
        setPath,
        onSelect,
        fontSize,
      }),
  );
}

/**
 * Keyboard handling shared by every menu, operating on the deepest open
 * level: Up/Down move the active item (skipping separators and disabled
 * entries, wrapping), Home/End jump to the ends, Right enters a submenu,
 * Left leaves one, Enter/Space activate, Escape closes one level.
 *
 * Returns true when the key was consumed. Left and Right fall through when
 * there is no submenu to enter or leave, so `MenuBar` can walk the bar.
 */
function handleMenuKey(
  ev,
  { rootItems, path, setPath, select, close, typeAhead },
) {
  const depth = path.length - 1;
  if (depth < 0) return false;
  const items = levelItems(rootItems, path, depth);
  const active = path[depth];
  const setActive = (i) => setPath([...path.slice(0, depth), i]);
  const enterSubmenu = () => {
    const sub = visibleItems(items[active]?.items);
    if (!sub.length) return false;
    setPath([...path, nextSelectable(sub, -1, 1)]);
    return true;
  };

  switch (ev.keysym) {
    case XK_ESCAPE:
      if (depth > 0) setPath(path.slice(0, -1));
      else close();
      return true;
    case XK_DOWN:
      setActive(nextSelectable(items, active, 1));
      return true;
    case XK_UP:
      setActive(nextSelectable(items, active, -1));
      return true;
    case XK_HOME:
      setActive(nextSelectable(items, -1, 1));
      return true;
    case XK_END:
      setActive(nextSelectable(items, items.length, -1));
      return true;
    case XK_PAGE_UP:
    case XK_PAGE_DOWN: {
      // step a viewport's worth of rows, then settle on the nearest
      // selectable entry in the direction of travel so a page never lands
      // on a separator or a disabled row
      const dir = ev.keysym === XK_PAGE_DOWN ? 1 : -1;
      const page = MENU_PAGE_ROWS;
      const from = active < 0 ? (dir > 0 ? -1 : items.length) : active;
      const target = Math.min(items.length - 1, Math.max(0, from + dir * page));
      setActive(
        isSelectable(items[target])
          ? target
          : nextSelectable(items, target - dir, dir),
      );
      return true;
    }
    case XK_RIGHT:
      return enterSubmenu();
    case XK_LEFT:
      if (depth > 0) {
        setPath(path.slice(0, -1));
        return true;
      }
      return false;
    default:
      break;
  }
  if (ev.codepoint === 32 || ev.keysym === XK_RETURN) {
    if (enterSubmenu()) return true;
    const item = items[active];
    if (isSelectable(item)) select(item);
    return true;
  }

  const char = typeAheadChar(ev);
  if (char && typeAhead) {
    const i = typeAhead(char, items, active, (it) => it.label, isSelectable);
    if (i >= 0) setActive(i);
    return true;
  }
  return false;
}

/**
 * <ContextMenu items>…</ContextMenu> — right-click anywhere in the children
 * to open a menu at the pointer.
 *
 * The wrapper is focusable and takes focus when the menu opens, because the
 * popup is override-redirect and never gets focus itself — the same trick
 * `Select` uses to keep arrow keys working while its menu is open.
 */
export function ContextMenu({
  items = [],
  children,
  onSelect,
  fontSize = DEFAULT_LABEL_SIZE,
  style,
  ...boxProps
}) {
  const ref = useRef(null);
  const [rect, setRect] = useState(null);
  const [path, setPath] = useState([]);
  const typeAhead = useTypeAhead();

  const close = () => {
    setRect(null);
    setPath([]);
  };
  const select = (item) => {
    close();
    item.onSelect?.(item);
    onSelect?.(item);
  };

  // the wrapper keeps the focus the right-click gave it, so `onBlur` below
  // never fires when the *window* loses focus — and the menu is holding a
  // pointer grab until something closes it
  useDismissOnWindowBlur(ref, Boolean(rect), close);

  const openAt = (ev) => {
    const node = ref.current;
    if (!node || !items.length) return;
    const width = menuListWidth(node, items, fontSize);
    const height = menuListHeight(items, fontSize);
    const screen = screenOf(node);
    // anchored at the pointer rather than at a widget: clamp by hand, since
    // there is no anchor rect to flip around
    const x = ev.nativeEvent?.rootx ?? ev.x;
    const y = ev.nativeEvent?.rooty ?? ev.y;
    setRect({
      x: screen ? Math.max(0, Math.min(x, screen.pixel_width - width)) : x,
      y: screen ? Math.max(0, Math.min(y, screen.pixel_height - height)) : y,
      width,
      height,
    });
    setPath([-1]);
    // `'pointer'`, so no ring: this only ever opens from a right-click, and
    // the wrapper is the whole content area — a focus ring around all of it
    // says nothing a keyboard user needs and quite a lot nobody wants.
    node.root?.events?.focus?.(node, 'pointer');
  };

  return h(
    'box',
    {
      ref,
      focusable: true,
      onMouseDown: (ev) => {
        if (ev.button !== 3 && rect) close();
      },
      onContextMenu: (ev) => {
        // this menu replaces whatever the element under the pointer would
        // have opened on its own — without the preventDefault a
        // <textinput> in here would show its edit menu underneath ours
        ev.preventDefault();
        openAt(ev);
      },
      onKeyDown: (ev) => {
        if (!rect) return;
        handleMenuKey(ev, {
          rootItems: items,
          path,
          setPath,
          select,
          close,
          typeAhead,
        });
      },
      onBlur: close,
      ...boxProps,
      style,
    },
    children,
    rect &&
      path.length > 0 &&
      h(MenuLevel, {
        rect,
        rootItems: items,
        path,
        depth: 0,
        setPath,
        fontSize,
        onSelect: select,
        onDismiss: close,
      }),
  );
}

/**
 * <MenuBar menus={[{ label, items }]}/> — a horizontal bar of pull-down
 * menus. Click or Enter opens; with one open, hovering another switches to
 * it and Left/Right walk the bar; the usual menu keys work inside.
 *
 * **On a desktop with a global menu, this renders nothing** and the panel
 * shows the menu instead — automatically, with no configuration, because the
 * `menus` array is a plain data prop and serialises to `com.canonical.dbusmenu`
 * unchanged (`src/globalmenu.js`). `globalMenu={false}` keeps the bar in the
 * window on a desktop that would otherwise take it.
 */
export function MenuBar({
  menus = [],
  onSelect,
  globalMenu = true,
  onGlobalMenuChange,
  fontSize = DEFAULT_LABEL_SIZE,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const [openIndex, setOpenIndex] = useState(-1);
  const [rect, setRect] = useState(null);
  const [path, setPath] = useState([]);
  const refs = useRef([]);
  const typeAhead = useTypeAhead();

  // Which menu is open, readable from a handler that is running *inside*
  // the call that changed it. Switching menus focuses the item taking over,
  // which blurs the one handing off, and that blur handler would otherwise
  // see the `openIndex` of the render it was created in — still itself —
  // and close the menu the switch had just opened.
  const openRef = useRef(-1);

  // Drawn from the visible menus, exported from all of them: dbusmenu carries
  // `visible` as a property, so hiding one there is a patch the panel applies
  // rather than a structural change that renumbers everything after it.
  const bar = useMemo(() => visibleItems(menus), [menus]);
  const delegated = useGlobalMenu(menus, { onSelect, enabled: globalMenu });

  // What the bar turned out to be, which is the one thing here that cannot
  // be worked out in a render: layout runs on the frame clock, after the
  // commit that mounted the box, so `onViewport` is the supported way to
  // hear about a size (docs/react-features.md) — and it is what makes the
  // box a scroll container, which is also what clips a bar mid-cut.
  //
  // `0` means "not measured yet", and an unmeasured bar shows everything:
  // that is what every bar did before this, and it is right for every bar
  // that fits. The window narrower than its titles is one frame late, not
  // wrong.
  const barRef = useRef(null);
  const [barWidth, setBarWidth] = useState(0);
  const [fits, setFits] = useState(-1);
  useEffect(() => {
    if (!barWidth || !barRef.current) return;
    setFits(barCut(barRef.current, bar, fontSize, barWidth));
  }, [bar, fontSize, barWidth]);

  // The bar as it is actually drawn: the titles that fit, then the chevron
  // standing for the rest. Everything downstream — the open index, the
  // anchor, Left/Right, the popup — reads this rather than `menus`, which
  // is the whole of what keeps the keyboard on what the eye can see.
  const entries = useMemo(() => {
    if (fits < 0 || fits >= bar.length) return bar;
    return [
      ...bar.slice(0, fits),
      { [OVERFLOW]: true, items: bar.slice(fits) },
    ];
  }, [bar, fits]);

  // The one thing about this an app cannot find out for itself: calling
  // `useGlobalMenu` a second time would export the menu twice, on two paths,
  // with the second registration displacing the first. So the answer is
  // reported rather than left to be re-derived. It is worth having — a window
  // sized to its content is a menu bar shorter when the panel takes it, and
  // copy that says "the bar above" is wrong the moment there is not one.
  const notifyDelegation = useRef(onGlobalMenuChange);
  notifyDelegation.current = onGlobalMenuChange;
  useEffect(() => {
    notifyDelegation.current?.(delegated);
  }, [delegated]);

  const items = openIndex >= 0 ? (entries[openIndex]?.items ?? []) : [];

  const close = () => {
    openRef.current = -1;
    setOpenIndex(-1);
    setRect(null);
    setPath([]);
  };

  // A panel taking the menu over while one is pulled down would otherwise
  // leave `openIndex` set, so the bar would come back open if the panel later
  // went away — and the popup holds a pointer grab until something closes it.
  useEffect(() => {
    if (delegated) close();
  }, [delegated]);

  // Narrowing the window while a menu is down can take the item it hangs
  // off the bar. Anchor tracking follows a trigger that *moves*; one that
  // stopped existing leaves the popup where it was, hanging under nothing
  // and still holding its grab, so it is shut here instead. Reopening the
  // same menu from the chevron is one click, and guessing which of the two
  // the user meant is worse than either.
  useEffect(() => {
    if (openIndex >= entries.length) close();
  }, [entries.length, openIndex]);

  /**
   * `reason` is the gesture that opened the menu, and it decides the ring.
   * A menu opened with the pointer already tells you where you are — the
   * menu itself is hanging off the item — so a ring on top of that is the
   * noise `:focus-visible` exists to remove. Walking the bar with the arrow
   * keys is the opposite case: the ring is the only thing saying which item
   * the keyboard is on.
   */
  const openMenu = (index, reason = 'key') => {
    const node = refs.current[index];
    const menu = entries[index];
    if (!node || !hasSubmenu(menu)) return;
    const width = menuListWidth(node, menu.items, fontSize);
    const height = menuListHeight(menu.items, fontSize);
    const next = anchorRect(node, { placement: 'bottom', width, height });
    if (!next) return;
    openRef.current = index;
    setRect(next);
    setOpenIndex(index);
    setPath([-1]);
    // Take focus **deliberately**, the way `ContextMenu` does, and for the
    // same reason: the popup is override-redirect and never gets the X
    // focus, so something in the owner window has to hold it or keys go
    // nowhere the menu can hear them.
    //
    // Both ways out of an open menu hang off this one thread. Escape is a
    // key, so it arrives at the focused node; clicking away closes through
    // `onBlur`, which only fires on a node that was focused to begin with.
    // Leaving that to whatever the press happened to focus made both
    // depend on the gesture that opened the menu — and a menu you cannot
    // dismiss is worse than one that never opened, because it is holding a
    // pointer grab while you try.
    node.root?.events?.focus?.(node, reason);
  };

  // keeps the pulled-down menu under its bar item for as long as it is
  // open: a scrolled ancestor, the item's own layout moving it, or the
  // owner window being nudged by the window manager or a script would
  // otherwise leave it stranded. `openRef` (not `openIndex`) both because
  // it is already the live index a handler mid-call reads, and because a
  // stable ref keeps `activeTriggerRef`'s identity fixed across renders. If
  // the bar item itself scrolls out of view, the menu closes rather than
  // following it there.
  const activeTriggerRef = useMemo(
    () => ({
      get current() {
        return refs.current[openRef.current] ?? null;
      },
    }),
    [],
  );
  useAnchorTracking(
    activeTriggerRef,
    openIndex >= 0,
    () => {
      const node = refs.current[openRef.current];
      const menu = entries[openRef.current];
      if (!node || !hasSubmenu(menu)) return null;
      return {
        placement: 'bottom',
        width: menuListWidth(node, menu.items, fontSize),
        height: menuListHeight(menu.items, fontSize),
      };
    },
    setRect,
    close,
  );
  // and shut it when the whole window loses focus. The bar item keeps the
  // focus it took, so its own `onBlur` never fires for this — and a menu
  // left open over an application the user has switched away from is still
  // holding the pointer grab it opened with.
  useDismissOnWindowBlur(activeTriggerRef, openIndex >= 0, close);

  const select = (item) => {
    close();
    item.onSelect?.(item);
    onSelect?.(item);
  };

  const moveMenu = (dir) => {
    if (!entries.length) return;
    const n = entries.length;
    openMenu((openIndex + dir + n) % n);
  };

  // The desktop is drawing this menu, so we must not. After every hook, and
  // only on evidence — `delegated` is false until the registrar has answered
  // `RegisterWindow`, so a machine with no panel, no bus, or a panel that
  // refused the registration all keep the bar where the app put it.
  if (delegated) return null;

  return h(
    'box',
    {
      theme,
      role: 'menubar',
      ref: barRef,
      scrollbar: false,
      ...boxProps,
      // Layout is the only thing that knows how wide the bar came out, and
      // it says so here. Width alone: `contentWidth` changes as the cut is
      // applied, and storing that would be reacting to our own answer.
      //
      // After the spread and chained rather than before it and overridable:
      // an application is welcome to watch its own menu bar resize, and a
      // handler of its own taking this one's place would quietly leave the
      // bar unable to measure itself — a prop that turns a feature off by
      // accident.
      onViewport: (v) => {
        setBarWidth(v.width);
        boxProps.onViewport?.(v);
      },
      style: [
        {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: theme.surfaceHover,
          paddingLeft: BAR_INSET - BAR_GAP,
          paddingRight: BAR_INSET - BAR_GAP,
          // `scroll` is what makes a box report its viewport, and the clip
          // that comes with it is wanted in its own right: it is what holds
          // the one frame before the first measurement — and any bar whose
          // own titles cannot be cut down far enough — inside the window
          // instead of letting it run off the edge. Nothing is ever left to
          // scroll to once the cut lands, so the bar answers no keys and
          // takes no wheel (docs/elements.md).
          overflow: 'scroll',
          // A scroll container brings `flexShrink: 1`; a menu bar is not a
          // thing that gives up height when the window is short.
          flexShrink: 0,
        },
        style,
      ],
    },
    entries.map((menu, index) => {
      // The bar is the first level of the same trail: while its menu is open
      // with nothing chosen in it the item is the selection, and the moment a
      // row down there takes over it goes quiet — the same handover, drawn
      // the same way, one level up (`rowState`).
      const barState = rowState(index, openIndex, (path[0] ?? -1) >= 0);
      const overflow = isOverflow(menu);
      return h(
        'box',
        {
          key: overflow ? OVERFLOW_KEY : menu.label,
          role: 'menuitem',
          // The glyph is decoration — `<Icon>` is `aria-hidden` by default —
          // so the chevron is the one bar item with nothing to read out, and
          // it says how many titles are behind it because "more" without a
          // number is the question rather than the answer. The hidden menus
          // themselves are simply not in the tree: AT-SPI has no notion of
          // "laid out past the edge", and the fix for reaching them is the
          // same for a screen reader as for a pointer — this item.
          'aria-label': overflow
            ? `More menus (${menu.items.length})`
            : undefined,
          'aria-haspopup': 'menu',
          'aria-expanded': openIndex === index,
          ref: (node) => {
            refs.current[index] = node;
          },
          focusable: true,
          // on the press, as `Select` opens: a pull-down that waits for the
          // button to come back up spends the whole of a held click saying
          // nothing, and a menu is there to be read
          onMouseDown: () =>
            openIndex === index ? close() : openMenu(index, 'pointer'),
          onMouseEnter: () => {
            if (openIndex >= 0 && openIndex !== index) {
              openMenu(index, 'pointer');
            }
          },
          // read live: by the time a hand-off blurs this item, the item
          // taking over has already claimed the bar
          onBlur: () => {
            if (openRef.current === index) close();
          },
          onKeyDown: (ev) => {
            if (openIndex !== index) {
              // Escape shuts an open menu from any item on the bar, not
              // only the one it belongs to. A menu holds a pointer grab, so
              // the key that gets rid of it is the one thing that must not
              // depend on which node the keystroke happened to reach. The
              // item that *owns* the menu falls through to `handleMenuKey`
              // instead, where Escape leaves one submenu level at a time.
              if (ev.keysym === XK_ESCAPE && openIndex >= 0) {
                close();
                return;
              }
              if (ev.codepoint === 32 || ev.keysym === XK_RETURN) {
                openMenu(index);
              } else if (ev.keysym === XK_LEFT) moveMenu(-1);
              else if (ev.keysym === XK_RIGHT) moveMenu(1);
              return;
            }
            // the menu gets first refusal: Left leaves a submenu and Right
            // enters one, and only when there is no submenu to move through
            // do they walk the bar
            const consumed = handleMenuKey(ev, {
              rootItems: items,
              path,
              setPath,
              select,
              close,
              typeAhead,
            });
            if (consumed) return;
            if (ev.keysym === XK_LEFT) moveMenu(-1);
            else if (ev.keysym === XK_RIGHT) moveMenu(1);
          },
          style: [
            {
              cursor: 'pointer',
              paddingLeft: BAR_ITEM_PAD_X,
              paddingRight: BAR_ITEM_PAD_X,
              // The same pill the rows inside the menu wear, at the same
              // radius: the bar item and the first row of the menu it opens
              // are one gesture, and a square title over rounded rows reads
              // as two widgets that have not met.
              //
              // The margin is what a radius needs to be seen — a rounded
              // rect flush against the strip's own edges reads as a cut
              // corner rather than a pill. It sits *outside* the padding, so
              // the bar is a menu row plus its two insets tall: the item and
              // the row below it are then the same pill in the same size,
              // which is the whole point of giving the bar one.
              marginTop: BAR_INSET,
              marginBottom: BAR_INSET,
              marginLeft: BAR_GAP,
              marginRight: BAR_GAP,
              paddingTop: MENU_ITEM_PAD,
              paddingBottom: MENU_ITEM_PAD,
              borderRadius: rowRadius(theme, MENU_BORDER, MENU_PAD),
              backgroundColor:
                barState === 'active'
                  ? theme.hoverBackground
                  : barState === 'path'
                    ? theme.surfaceActive
                    : undefined,
              // No ring while this item's menu is up. Walking the bar with
              // the arrow keys opens each menu as it arrives, so the item is
              // already inverted with a menu hanging off it — a ring on top
              // of that is saying a third time what two things already say,
              // and it is the least specific of the three.
              //
              // Only while it is up, though: an item that has been tabbed to
              // and *not* opened has nothing else to show for it, and a
              // keyboard user who cannot see where they are is exactly the
              // reader the ring exists for.
              outlineWidth: openIndex === index ? 0 : undefined,
            },
            // Only while this menu is shut, as in `Select`: an open one is
            // already showing the answer, and a state block would outrank
            // the base colour that says so. The menu opens on the release,
            // so `:active` is the whole of the answer to a held press.
            openIndex !== index && {
              ':hover': { backgroundColor: theme.background },
              ':active': { backgroundColor: theme.surfaceActive },
            },
          ],
        },
        overflow
          ? h(Icon, {
              // The set's own overflow mark, rather than the `»` Qt and
              // Firefox draw or the `⋯` a modern toolbar does: both are text
              // glyphs, and a text glyph is only as good as the font it
              // lands in — tofu on a machine without it, which is the exact
              // warning docs/components.md gives applications about string
              // `icon`s. One drawing, every font, both colour schemes.
              name: 'moreVertical',
              size: iconSize(fontSize),
              color: barState === 'active' ? theme.hoverText : theme.text,
            })
          : h(
              'text',
              {
                style: [
                  capTrim,
                  {
                    color: barState === 'active' ? theme.hoverText : theme.text,
                    fontSize: fontSize,
                  },
                ],
              },
              menu.label,
            ),
      );
    }),
    openIndex >= 0 &&
      rect &&
      path.length > 0 &&
      h(MenuLevel, {
        rect,
        rootItems: items,
        path,
        depth: 0,
        setPath,
        fontSize,
        onSelect: select,
        onDismiss: close,
      }),
  );
}
