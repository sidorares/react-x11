// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from './theme.js';
import { measureLabel, screenOf, useAnchor } from './anchor.js';
import { DEFAULT_TEXT_STYLE } from '../styles.js';
import { typeAheadChar, useTypeAhead } from './typeahead.js';
import {
  XK_DOWN,
  XK_END,
  XK_ESCAPE,
  XK_HOME,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RETURN,
  XK_UP,
} from './keys.js';

const h = React.createElement;

const ITEM_HEIGHT = 28;

const MAX_MENU_HEIGHT = 220;

// The menu's chrome, named rather than inline because the width calculation
// and the layout have to agree: a measurement that drifts from the padding it
// is measuring for clips the very labels it exists to fit.
const ITEM_PAD_LEFT = 10;
const ITEM_PAD_RIGHT = 10;
const MENU_PAD = 4; // the scrollview's own padding
const MENU_BORDER = 1;
// the scrollbar is drawn *over* the content rather than insetting it
// (`nodes.js`, SCROLLBAR_WIDTH), so a menu that scrolls reserves the room
const SCROLLBAR_WIDTH = 6;

function normalizeOption(option) {
  return typeof option === 'object' && option !== null
    ? option
    : { value: option, label: String(option) };
}

/**
 * How wide the menu has to be to show its **longest** option, not merely the
 * selected one. Sizing it to the trigger — which is only ever as wide as the
 * current value — left every longer label to wrap inside a fixed 28px row and
 * overlap the option under it.
 *
 * Labels are measured at the size they are painted: a `<text>` resolves its
 * style against `DEFAULT_TEXT_STYLE` rather than inheriting from the boxes
 * around it, so the option rows are 14px whatever the trigger is set to. The
 * selected one is measured bold, which is how `Option` draws it.
 *
 * The result is never narrower than the trigger it hangs off, and never wider
 * than the screen it has to open on — `anchorRect` can slide a popup left to
 * fit, but nothing can rescue one that is wider than the display.
 */
function menuWidth(node, options, value, scrolls) {
  let widest = 0;
  for (const option of options) {
    const { width } = measureLabel(node, option.label, {
      size: DEFAULT_TEXT_STYLE.size,
      weight: option.value === value ? 'bold' : 'normal',
    });
    if (width > widest) widest = width;
  }
  const chrome =
    (MENU_BORDER + MENU_PAD) * 2 +
    ITEM_PAD_LEFT +
    ITEM_PAD_RIGHT +
    (scrolls ? SCROLLBAR_WIDTH : 0);
  const width = Math.max(node.abs.width, Math.ceil(widest) + chrome);
  const screen = screenOf(node);
  return screen ? Math.min(width, screen.pixel_width) : width;
}

function Option({ option, selected, active, onPick, onHover, nodeRef }) {
  const theme = useTheme();
  // one highlight, shared by pointer and keyboard: hovering moves the
  // active index rather than tracking a second, competing state
  return h(
    'box',
    {
      theme,
      ref: nodeRef,
      onMouseEnter: () => onHover?.(),
      onClick: () => onPick(option),
      style: {
        height: ITEM_HEIGHT,
        justifyContent: 'center',
        paddingLeft: ITEM_PAD_LEFT,
        paddingRight: ITEM_PAD_RIGHT,
        cursor: 'pointer',
        backgroundColor: active ? theme.hoverBackground : theme.background,
      },
    },
    h(
      'text',
      {
        style: {
          color: active ? theme.hoverText : theme.text,
          fontWeight: selected ? 'bold' : 'normal',
        },
      },
      option.label,
    ),
  );
}

/**
 * <Select value options onChange placeholder …boxProps> — a dropdown
 * built on <popup>. The menu is a real override-redirect X11 window
 * anchored below the trigger (owner window position + trigger rect).
 * Closes on pick, Escape, toggling the trigger, or focus loss within the
 * owner window.
 *
 * Keyboard (the trigger keeps focus while the menu is open — the popup is
 * override-redirect and never takes it): Up/Down open the menu, then move
 * the active option with wrapping; Home/End jump to the ends; Enter/Space
 * pick the active option (or open the menu when closed); Escape closes.
 * The active option is scrolled into view.
 */
export function Select({
  value,
  options = [],
  onChange,
  placeholder = 'Select…',
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef(null);
  const scrollRef = useRef(null);
  const activeRef = useRef(null);

  const measureAnchor = useAnchor(triggerRef);
  const typeAhead = useTypeAhead();

  const normalized = options.map(normalizeOption);
  const current = normalized.find((o) => o.value === value);
  const contentHeight = normalized.length * ITEM_HEIGHT + MENU_PAD * 2;
  const menuHeight = Math.min(contentHeight, MAX_MENU_HEIGHT);
  const scrolls = contentHeight > MAX_MENU_HEIGHT;

  const close = () => setOpen(false);
  const openMenu = () => {
    const node = triggerRef.current;
    if (!node) return;
    // shared anchoring: also flips the menu above the trigger when there is
    // no room below, and slides it left when the menu is wider than the
    // trigger and would otherwise open off the right edge
    const rect = measureAnchor({
      placement: 'bottom',
      height: menuHeight + 2,
      width: menuWidth(node, normalized, value, scrolls),
    });
    if (!rect) return;
    setAnchor(rect);
    const selected = normalized.findIndex((o) => o.value === value);
    setActiveIndex(selected >= 0 ? selected : 0);
    setOpen(true);
  };
  const toggle = () => (open ? close() : openMenu());

  const pick = (option) => {
    close();
    if (option.value !== value) onChange?.(option.value);
  };

  const move = (delta) => {
    const count = normalized.length;
    if (!count) return;
    setActiveIndex((i) => (i < 0 ? 0 : (i + delta + count) % count));
  };

  const onKeyDown = (ev) => {
    const count = normalized.length;
    switch (ev.keysym) {
      case XK_ESCAPE:
        if (open) close();
        return;
      case XK_DOWN:
      case XK_UP:
        if (open) move(ev.keysym === XK_DOWN ? 1 : -1);
        else openMenu();
        return;
      case XK_HOME:
      case XK_END:
        if (open && count)
          setActiveIndex(ev.keysym === XK_HOME ? 0 : count - 1);
        return;
      case XK_PAGE_UP:
      case XK_PAGE_DOWN: {
        // a page is what the menu shows at once, so paging lines up with
        // what the user can see rather than an arbitrary count
        if (!open || !count) return;
        const page = Math.max(1, Math.floor(MAX_MENU_HEIGHT / ITEM_HEIGHT));
        const dir = ev.keysym === XK_PAGE_DOWN ? 1 : -1;
        const from = activeIndex < 0 ? 0 : activeIndex;
        setActiveIndex(Math.min(count - 1, Math.max(0, from + dir * page)));
        return;
      }
      default:
        break;
    }
    if (ev.codepoint === 32 || ev.keysym === XK_RETURN) {
      const option = open ? normalized[activeIndex] : null;
      if (option) pick(option);
      else toggle();
      return;
    }

    // type-ahead: with the menu open it moves the highlight; closed, it
    // changes the value outright, the way a native select does
    const char = typeAheadChar(ev);
    if (!char) return;
    const current = open
      ? activeIndex
      : normalized.findIndex((o) => o.value === value);
    const i = typeAhead(char, normalized, current, (o) => o.label);
    if (i < 0) return;
    if (open) setActiveIndex(i);
    else if (normalized[i].value !== value) onChange?.(normalized[i].value);
  };

  // keep the highlighted option visible while arrowing through a menu that
  // overflows MAX_MENU_HEIGHT (resolved on the popup's next layout pass)
  useEffect(() => {
    if (open) scrollRef.current?.scrollIntoView(activeRef.current);
  }, [open, activeIndex]);

  return h(
    'box',
    {
      theme,
      ref: triggerRef,
      focusable: true,
      onClick: toggle,
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false);
        close();
      },
      onKeyDown,
      ...boxProps,
      style: [
        {
          cursor: 'pointer',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          padding: 8,
          paddingLeft: 10,
          paddingRight: 10,
          borderWidth: theme.borderWidth,
          borderRadius: theme.radius,
          borderColor: focused || open ? theme.borderActive : theme.border,
          backgroundColor: theme.background,
        },
        style,
      ],
    },
    h(
      'text',
      { style: { color: current ? theme.text : theme.dim } },
      current ? current.label : placeholder,
    ),
    h('box', { style: { flexGrow: 1 } }),
    h('canvas', {
      onDraw: (ctx, { width: w, height: hgt }) => {
        ctx.fillStyle = theme.dim;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(w, 0);
        ctx.lineTo(w / 2, hgt);
        ctx.closePath();
        ctx.fill();
      },
      style: { width: 10, height: 6 },
    }),
    open &&
      anchor &&
      h(
        'popup',
        {
          x: anchor.x,
          y: anchor.y,
          width: anchor.width,
          height: menuHeight + 2,
          grab: true,
          onDismiss: close,
          style: { backgroundColor: theme.background },
        },
        h(
          'box',
          {
            style: {
              flexGrow: 1,
              flexShrink: 1,
              borderWidth: MENU_BORDER,
              borderColor: theme.border,
              backgroundColor: theme.background,
            },
          },
          h(
            'scrollview',
            { ref: scrollRef, style: { flexGrow: 1, padding: MENU_PAD } },
            normalized.map((option, index) =>
              h(Option, {
                key: String(option.value),
                option,
                selected: option.value === value,
                active: index === activeIndex,
                nodeRef: index === activeIndex ? activeRef : undefined,
                onHover: () => setActiveIndex(index),
                onPick: pick,
              }),
            ),
          ),
        ),
      ),
  );
}
