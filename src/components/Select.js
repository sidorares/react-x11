// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from './theme.js';
import { useAnchor } from './anchor.js';
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

function normalizeOption(option) {
  return typeof option === 'object' && option !== null
    ? option
    : { value: option, label: String(option) };
}

function Option({ option, selected, active, onPick, onHover, nodeRef }) {
  const theme = useTheme();
  // one highlight, shared by pointer and keyboard: hovering moves the
  // active index rather than tracking a second, competing state
  return h(
    'box',
    {
      ref: nodeRef,
      height: ITEM_HEIGHT,
      justifyContent: 'center',
      paddingLeft: 10,
      cursor: 'pointer',
      backgroundColor: active ? theme.hoverBackground : theme.background,
      onMouseEnter: () => onHover?.(),
      onClick: () => onPick(option),
    },
    h(
      'text',
      {
        color: active ? theme.hoverText : theme.text,
        fontWeight: selected ? 'bold' : 'normal',
      },
      option.label,
    ),
  );
}

/**
 * <Select value options onChange placeholder width …boxProps> — a dropdown
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
  width,
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
  const menuHeight = Math.min(
    normalized.length * ITEM_HEIGHT + 8,
    MAX_MENU_HEIGHT,
  );

  const close = () => setOpen(false);
  const openMenu = () => {
    const node = triggerRef.current;
    if (!node) return;
    // shared anchoring: also flips the menu above the trigger when there is
    // no room below, instead of opening off the bottom of the screen
    const rect = measureAnchor({ placement: 'bottom', height: menuHeight + 2 });
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
      ref: triggerRef,
      focusable: true,
      cursor: 'pointer',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      width,
      padding: 8,
      paddingLeft: 10,
      paddingRight: 10,
      borderWidth: 1,
      borderRadius: 4,
      borderColor: focused || open ? theme.borderActive : theme.border,
      backgroundColor: theme.background,
      onClick: toggle,
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false);
        close();
      },
      onKeyDown,
      ...boxProps,
    },
    h(
      'text',
      { color: current ? theme.text : theme.dim },
      current ? current.label : placeholder,
    ),
    h('box', { flexGrow: 1 }),
    h('canvas', {
      width: 10,
      height: 6,
      onDraw: (ctx, { width: w, height: hgt }) => {
        ctx.fillStyle = theme.dim;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(w, 0);
        ctx.lineTo(w / 2, hgt);
        ctx.closePath();
        ctx.fill();
      },
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
          backgroundColor: theme.background,
          // a press anywhere else closes the menu, the window frame
          // included — see PopupNode's `grab`
          grab: true,
          onDismiss: close,
        },
        h(
          'box',
          {
            flexGrow: 1,
            // yoga's default flexShrink is 0: without this the frame keeps
            // its content height, the scrollview inside it never shrinks to
            // the viewport, and a menu longer than MAX_MENU_HEIGHT gets
            // clipped by the popup's edge instead of scrolling
            flexShrink: 1,
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.background,
          },
          h(
            'scrollview',
            { ref: scrollRef, flexGrow: 1, padding: 4 },
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
