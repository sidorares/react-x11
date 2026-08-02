// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from './theme.js';
import {
  DEFAULT_LABEL_SIZE,
  anchorRect,
  measureLabel,
  movingToward,
  SAFE_HOVER_DELAY,
  screenOf,
  screenPoint,
} from './anchor.js';
import { typeAheadChar, useTypeAhead } from './typeahead.js';
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

const MENU_ITEM_HEIGHT = 26;

const MENU_SEPARATOR_HEIGHT = 7;

const MENU_MIN_WIDTH = 140;

const MENU_PAD = 4;

const MENU_GUTTER = 24; // room for the check column

const MENU_SHORTCUT_GAP = 24;
// menus size to their content rather than scrolling, so a page is a fixed
// stride — deriving one from the menu height would just equal Home/End
const MENU_PAGE_ROWS = 10;

const isSelectable = (item) => item && !item.separator && !item.disabled;

/** Total popup height for a menu's items (separators are shorter). */
function menuListHeight(items) {
  const body = items.reduce(
    (sum, item) =>
      sum + (item.separator ? MENU_SEPARATOR_HEIGHT : MENU_ITEM_HEIGHT),
    0,
  );
  return body + MENU_PAD * 2 + 2;
}

/** Widest label + shortcut, measured, so the popup can be sized up front. */
function menuListWidth(node, items, fontSize) {
  let widest = 0;
  for (const item of items) {
    if (item.separator) continue;
    const label = measureLabel(node, item.label ?? '', {
      size: fontSize,
    }).width;
    const shortcut = item.shortcut
      ? measureLabel(node, item.shortcut, { size: fontSize }).width +
        MENU_SHORTCUT_GAP
      : 0;
    widest = Math.max(widest, label + shortcut);
  }
  return Math.max(
    MENU_MIN_WIDTH,
    Math.ceil(widest) + MENU_GUTTER + MENU_PAD * 2 + 12,
  );
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

function MenuRow({
  item,
  active,
  onHover,
  onMove,
  onSelect,
  fontSize,
  nodeRef,
}) {
  const theme = useTheme();
  if (item.separator) {
    return h(
      'box',
      {
        theme,
        style: { height: MENU_SEPARATOR_HEIGHT, justifyContent: 'center' },
      },
      h('box', { style: { height: 1, backgroundColor: theme.border } }),
    );
  }
  const dim = item.disabled;
  const hasSubmenu = item.items?.length > 0;
  return h(
    'box',
    {
      ref: nodeRef,
      onMouseEnter: dim ? undefined : onHover,
      onMouseMove: dim ? undefined : onMove,
      onClick: dim ? undefined : () => onSelect(item),
      style: {
        height: MENU_ITEM_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 8,
        paddingRight: 8,
        cursor: dim ? undefined : 'pointer',
        backgroundColor: active ? theme.hoverBackground : theme.background,
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
      { style: { width: MENU_GUTTER - 8, alignItems: 'center' } },
      item.checked &&
        h('text', {
          children: '\u2713',
          style: {
            color: active ? theme.hoverText : theme.text,
            fontSize: fontSize,
          },
        }),
    ),
    h(
      'text',
      {
        style: {
          color: dim ? theme.dim : active ? theme.hoverText : theme.text,
          fontSize: fontSize,
        },
      },
      item.label,
    ),
    h('box', { style: { flexGrow: 1 } }),
    item.shortcut &&
      h(
        'text',
        {
          style: {
            color: dim ? theme.dim : active ? theme.hoverText : theme.dim,
            fontSize: fontSize,
          },
        },
        item.shortcut,
      ),
    hasSubmenu &&
      h('text', {
        children: '\u25b8',
        style: {
          color: dim ? theme.dim : active ? theme.hoverText : theme.dim,
          fontSize: fontSize,
        },
      }),
  );
}

/** Items at `depth`, walking `path` down through nested `items`. */
function levelItems(rootItems, path, depth) {
  let items = rootItems;
  for (let d = 0; d < depth; d++) items = items[path[d]]?.items ?? [];
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
  const childItems = items[active]?.items;
  const childOpen = path.length > depth + 1 && childItems?.length > 0;

  const activeRowRef = useRef(null);
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
      anchorRect(node, {
        placement: 'right',
        align: 'start',
        offset: 0,
        width: menuListWidth(node, childItems, fontSize),
        height: menuListHeight(childItems),
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
    setPath(items[index]?.items?.length ? [...base, -1] : base);
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
    if (item.items?.length) {
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
      style: { backgroundColor: theme.background },
    },
    h(
      'box',
      {
        style: {
          flexGrow: 1,
          flexShrink: 1,
          padding: MENU_PAD,
          borderWidth: 1,
          borderColor: theme.border,
          backgroundColor: theme.background,
        },
      },
      items.map((item, index) =>
        h(MenuRow, {
          key: item.separator ? `sep-${index}` : (item.key ?? item.label),
          item,
          active: index === active,
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
    const sub = items[active]?.items;
    if (!sub?.length) return false;
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

  const openAt = (ev) => {
    const node = ref.current;
    if (!node || !items.length) return;
    const width = menuListWidth(node, items, fontSize);
    const height = menuListHeight(items);
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
    node.root?.events?.focus?.(node);
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
 */
export function MenuBar({
  menus = [],
  onSelect,
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

  const items = openIndex >= 0 ? (menus[openIndex]?.items ?? []) : [];

  const close = () => {
    setOpenIndex(-1);
    setRect(null);
    setPath([]);
  };

  const openMenu = (index) => {
    const node = refs.current[index];
    const menu = menus[index];
    if (!node || !menu?.items?.length) return;
    const width = menuListWidth(node, menu.items, fontSize);
    const height = menuListHeight(menu.items);
    const next = anchorRect(node, { placement: 'bottom', width, height });
    if (!next) return;
    setRect(next);
    setOpenIndex(index);
    setPath([-1]);
  };

  const select = (item) => {
    close();
    item.onSelect?.(item);
    onSelect?.(item);
  };

  const moveMenu = (dir) => {
    if (!menus.length) return;
    const n = menus.length;
    openMenu((openIndex + dir + n) % n);
  };

  return h(
    'box',
    {
      theme,
      ...boxProps,
      style: [
        {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: theme.surfaceHover,
        },
        style,
      ],
    },
    menus.map((menu, index) =>
      h(
        'box',
        {
          key: menu.label,
          ref: (node) => {
            refs.current[index] = node;
          },
          focusable: true,
          onClick: () => (openIndex === index ? close() : openMenu(index)),
          onMouseEnter: () => {
            if (openIndex >= 0 && openIndex !== index) openMenu(index);
          },
          onBlur: () => {
            if (openIndex === index) close();
          },
          onKeyDown: (ev) => {
            if (openIndex !== index) {
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
          style: {
            cursor: 'pointer',
            paddingLeft: 10,
            paddingRight: 10,
            paddingTop: 6,
            paddingBottom: 6,
            backgroundColor:
              openIndex === index ? theme.hoverBackground : undefined,
            ':hover': {
              backgroundColor:
                openIndex === index ? theme.hoverBackground : theme.background,
            },
            // the menu opens on the release, so this is the whole of the
            // answer to a held press on the bar
            ':active': {
              backgroundColor:
                openIndex === index ? theme.accentActive : theme.surfaceActive,
            },
          },
        },
        h(
          'text',
          {
            style: {
              color: openIndex === index ? theme.hoverText : theme.text,
              fontSize: fontSize,
            },
          },
          menu.label,
        ),
      ),
    ),
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
