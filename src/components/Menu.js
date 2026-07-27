// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from './theme.js';
import {
  DEFAULT_LABEL_SIZE,
  anchorRect,
  measureLabel,
  screenOf,
} from './anchor.js';
import { typeAheadChar, useTypeAhead } from './typeahead.js';
import {
  XK_DOWN,
  XK_END,
  XK_ESCAPE,
  XK_HOME,
  XK_LEFT,
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

function MenuRow({ item, active, onHover, onSelect, fontSize, nodeRef }) {
  const theme = useTheme();
  if (item.separator) {
    return h(
      'box',
      { height: MENU_SEPARATOR_HEIGHT, justifyContent: 'center' },
      h('box', { height: 1, backgroundColor: theme.border }),
    );
  }
  const dim = item.disabled;
  const hasSubmenu = item.items?.length > 0;
  return h(
    'box',
    {
      ref: nodeRef,
      height: MENU_ITEM_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: 8,
      paddingRight: 8,
      cursor: dim ? undefined : 'pointer',
      backgroundColor: active ? theme.hoverBackground : theme.background,
      onMouseEnter: dim ? undefined : onHover,
      onClick: dim ? undefined : () => onSelect(item),
    },
    h(
      'box',
      { width: MENU_GUTTER - 8, alignItems: 'center' },
      item.checked &&
        h('text', {
          color: active ? theme.hoverText : theme.text,
          fontSize,
          children: '\u2713',
        }),
    ),
    h(
      'text',
      {
        color: dim ? theme.dim : active ? theme.hoverText : theme.text,
        fontSize,
      },
      item.label,
    ),
    h('box', { flexGrow: 1 }),
    item.shortcut &&
      h(
        'text',
        {
          color: dim ? theme.dim : active ? theme.hoverText : theme.dim,
          fontSize,
        },
        item.shortcut,
      ),
    hasSubmenu &&
      h('text', {
        color: dim ? theme.dim : active ? theme.hoverText : theme.dim,
        fontSize,
        children: '\u25b8',
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

  const hover = (index) => {
    const base = [...path.slice(0, depth), index];
    // hovering a parent row opens its submenu with nothing selected inside
    setPath(items[index]?.items?.length ? [...base, -1] : base);
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
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      windowType: 'popup_menu',
      backgroundColor: theme.background,
    },
    h(
      'box',
      {
        flexGrow: 1,
        flexShrink: 1,
        padding: MENU_PAD,
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: theme.background,
      },
      items.map((item, index) =>
        h(MenuRow, {
          key: item.separator ? `sep-${index}` : (item.key ?? item.label),
          item,
          active: index === active,
          fontSize,
          nodeRef: index === active ? activeRowRef : undefined,
          onHover: () => hover(index),
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
        if (ev.button === 3) openAt(ev);
        else if (rect) close();
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
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.surfaceHover,
      ...boxProps,
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
          cursor: 'pointer',
          paddingLeft: 10,
          paddingRight: 10,
          paddingTop: 6,
          paddingBottom: 6,
          backgroundColor:
            openIndex === index ? theme.hoverBackground : undefined,
          onClick: () => (openIndex === index ? close() : openMenu(index)),
          // with a menu already open, hovering the bar switches menus —
          // standard pull-down behaviour
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
        },
        h(
          'text',
          {
            color: openIndex === index ? theme.hoverText : theme.text,
            fontSize,
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
      }),
  );
}
