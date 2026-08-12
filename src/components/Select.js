// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useEffect, useRef, useState } from 'react';
import { capBand, capTrim, rowRadius, useTheme } from './theme.js';
import { Icon } from './Icon.js';
import { changeEvent } from './change.js';
import {
  anchorArea,
  measureLabel,
  useAnchor,
  useAnchorTracking,
  useDismissOnWindowBlur,
} from './anchor.js';
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

const MAX_MENU_HEIGHT = 220;

// The menu's chrome, named rather than inline because the width calculation
// and the layout have to agree: a measurement that drifts from the padding it
// is measuring for clips the very labels it exists to fit.
const ITEM_PAD = 10;
const ITEM_PAD_LEFT = ITEM_PAD;
const ITEM_PAD_RIGHT = ITEM_PAD;
// A row is its label with even space all round — the same number left and
// right as above and below, measured to the letters rather than to the
// font's line box (`capTrim`). The menus derive their rows the same way.
//
// A function of the palette's text size and not of a constant: the labels in
// these rows are unstyled `<text>`, which *inherits* that size, so a row
// sized against 14 under a theme that set 18 is a row its own label does not
// fit in.
const itemHeight = (fontSize) => capBand(fontSize) + ITEM_PAD * 2;
// The scrolling pane's own padding, and so the inset between the edge
// and an option — which is what makes the highlight read as a pill on the
// menu rather than a band across it, and what the pill's own corner radius
// is derived from so the two curves share a centre. The same number the
// menus use (`Menu.js`): a dropdown is the same kind of surface and there is
// no reading in which it wants a different one.
const MENU_PAD = 4;
// A hairline, not `theme.borderWidth`: this border gives the sheet an edge
// where it meets the desktop behind it, and a theme that draws 2px borders
// on its *controls* does not mean a 2px outline around every popup.
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
 * Labels are measured at the size they are painted: a `<text>` that names no
 * size of its own takes the palette's, so this is `theme.fontSize` and not
 * the size of whatever is in the trigger. The selected one is measured bold,
 * which is how `Option` draws it.
 *
 * The result is never narrower than the trigger it hangs off, and never wider
 * than the screen it has to open on — `anchorRect` can slide a popup left to
 * fit, but nothing can rescue one that is wider than the display.
 */
function menuWidth(node, options, value, scrolls, fontSize) {
  let widest = 0;
  for (const option of options) {
    const { width } = measureLabel(node, option.label, {
      size: fontSize,
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
  const area = anchorArea(node);
  return area ? Math.min(width, area.width) : width;
}

function Option({
  option,
  selected,
  active,
  onPick,
  onHover,
  nodeRef,
  posinset,
  setsize,
}) {
  const theme = useTheme();
  // one highlight, shared by pointer and keyboard: hovering moves the
  // active index rather than tracking a second, competing state
  return h(
    'box',
    {
      theme,
      role: 'option',
      'aria-selected': selected,
      'aria-posinset': posinset,
      'aria-setsize': setsize,
      ref: nodeRef,
      onMouseEnter: () => onHover?.(),
      onClick: () => onPick(option),
      style: {
        height: itemHeight(theme.fontSize),
        justifyContent: 'center',
        paddingLeft: ITEM_PAD_LEFT,
        paddingRight: ITEM_PAD_RIGHT,
        cursor: 'pointer',
        // the menus' pill, for the same reason and by the same rule: an
        // option list and a menu are one surface with rows in it, and two
        // shapes for that would only say the widgets were written apart
        borderRadius: rowRadius(theme, MENU_BORDER, MENU_PAD),
        // nothing at rest — the sheet under it is already that colour, and a
        // rounded fill of the same colour is a coverage mask drawn to change
        // nothing, with four corners it deliberately leaves out
        backgroundColor: active ? theme.hoverBackground : 'transparent',
      },
    },
    h(
      'text',
      {
        style: [
          capTrim,
          {
            color: active ? theme.hoverText : theme.text,
            fontWeight: selected ? 'bold' : 'normal',
          },
        ],
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
 * The menu opens on the **press**, not the release — the one control here
 * whose answer to a press is more than a tint, and the one where waiting
 * for the release is most obviously wrong: every desktop toolkit drops the
 * list under a held button, and the whole point of a dropdown is to be
 * looking at the options. A press while the menu is up dismisses it through
 * the popup's pointer grab rather than reaching this handler at all, so the
 * two do not fight over the toggle.
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
  name,
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
  // Rows are sized from the palette's text size, because that is the size
  // the labels inside them come out at.
  const rowHeight = itemHeight(theme.fontSize);
  const contentHeight = normalized.length * rowHeight + MENU_PAD * 2;
  const menuHeight = Math.min(contentHeight, MAX_MENU_HEIGHT);
  const scrolls = contentHeight > MAX_MENU_HEIGHT;

  // shared anchoring: also flips the menu above the trigger when there is
  // no room below, and slides it left when the menu is wider than the
  // trigger and would otherwise open off the right edge
  const menuAnchorOptions = () => ({
    placement: 'bottom',
    height: menuHeight + 2,
    width: menuWidth(
      triggerRef.current,
      normalized,
      value,
      scrolls,
      theme.fontSize,
    ),
  });

  const close = () => setOpen(false);
  const openMenu = () => {
    const node = triggerRef.current;
    if (!node) return;
    const rect = measureAnchor(menuAnchorOptions());
    if (!rect) return;
    setAnchor(rect);
    const selected = normalized.findIndex((o) => o.value === value);
    setActiveIndex(selected >= 0 ? selected : 0);
    setOpen(true);
  };
  const toggle = () => (open ? close() : openMenu());

  // keeps the menu under the trigger for as long as it is open: a scrolled
  // ancestor, the trigger's own layout moving it (a neighbouring field
  // wrapping to a second line), or the owner window being nudged by the
  // window manager or a script would otherwise leave it hanging in place.
  // If the trigger itself scrolls out of view, the menu closes instead of
  // following it there — a popup is a real window, not something clipped
  // by the trigger's ancestors, so it would otherwise hang over content it
  // no longer points at.
  useAnchorTracking(triggerRef, open, menuAnchorOptions, setAnchor, close);
  // and shut it when the whole window loses focus: the trigger keeps the
  // focus it has, so its own `onBlur` never fires for this
  useDismissOnWindowBlur(triggerRef, open, close);

  const emit = (next) => onChange?.(changeEvent('select-one', name, next));

  const pick = (option) => {
    close();
    if (option.value !== value) emit(option.value);
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
        const page = Math.max(1, Math.floor(MAX_MENU_HEIGHT / rowHeight));
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
    else if (normalized[i].value !== value) emit(normalized[i].value);
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
      role: 'combobox',
      'aria-expanded': open,
      'aria-haspopup': 'listbox',
      ref: triggerRef,
      focusable: true,
      onMouseDown: toggle,
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
          // The vertical padding is the palette's, the same one a `<Button>`
          // takes, because these are controls of one family and a form puts
          // them in a row together. Horizontally it is its own, tighter
          // number: a dropdown is a field with a value in it, not a button
          // with a word centred on it.
          paddingTop: theme.paddingY,
          paddingBottom: theme.paddingY,
          paddingLeft: 10,
          paddingRight: 10,
          borderWidth: theme.borderWidth,
          borderRadius: theme.radius,
          borderColor: focused || open ? theme.borderFocus : theme.border,
          backgroundColor: theme.surface,
        },
        // Hover and press belong to the trigger while it is *shut*: they say
        // "this opens". Once the menu is down that is answered, and the
        // trigger's job is to read as one surface with the popup hanging off
        // it — so the pointer wandering back over it must not re-tint it.
        //
        // Declaring them conditionally is the mechanism, not a shortcut: a
        // state block always outranks the base style, so there is no colour
        // the open state could put in `backgroundColor` that `:hover` would
        // not overwrite. The only way for open to win is to not be competing.
        !open && {
          ':hover': { backgroundColor: theme.surfaceHover },
          ':active': { backgroundColor: theme.surfaceActive },
        },
        style,
      ],
    },
    h(
      'text',
      { style: [capTrim, { color: current ? theme.text : theme.textMuted }] },
      current ? current.label : placeholder,
    ),
    h('box', { style: { flexGrow: 1 } }),
    // The chevron is exactly as tall as the capitals it stands beside, and
    // for a reason a form depends on: a field, a dropdown and a button in one
    // row have to be one height, and they only are if the tallest thing in
    // each is measured the same way. A glyph taller than the cap band makes
    // the dropdown alone two pixels taller than everything next to it.
    h(Icon, {
      name: 'chevronDown',
      size: capBand(theme.fontSize),
      color: theme.textMuted,
    }),
    open &&
      anchor &&
      h(
        'popup',
        {
          theme,
          x: anchor.x,
          y: anchor.y,
          width: anchor.width,
          height: menuHeight + 2,
          grab: true,
          onDismiss: close,
          // ARGB where the display has it, so the corners the sheet gives up
          // are the desktop rather than a colour — as the menus are. The
          // window paints nothing itself when it can be seen through: the
          // box below is the whole of the dropdown, and a square fill under
          // it would put the corners straight back.
          transparent: true,
          style: {
            backgroundColor: theme.surface,
            '@supports transparency': { backgroundColor: 'transparent' },
          },
        },
        h(
          'box',
          {
            style: {
              flexGrow: 1,
              flexShrink: 1,
              borderWidth: MENU_BORDER,
              borderColor: theme.border,
              backgroundColor: theme.surface,
              '@supports transparency': { borderRadius: theme.radiusPopup },
            },
          },
          h(
            'box',
            {
              ref: scrollRef,
              role: 'listbox',
              // Not a tab stop, and not a focus target for a press either.
              // A scroll box becomes focusable the moment its content
              // overflows, so a menu long enough to scroll would take focus
              // on mousedown — blurring the trigger, whose onBlur closes the
              // menu, which unmounts the row under the pointer before the
              // release can turn into a click. The trigger owns the keyboard
              // for a Select; this pane is scrolled by wheel and by the
              // arrow keys the trigger already handles.
              focusable: false,
              style: { flexGrow: 1, padding: MENU_PAD, overflow: 'scroll' },
            },
            normalized.map((option, index) =>
              h(Option, {
                key: String(option.value),
                option,
                selected: option.value === value,
                active: index === activeIndex,
                posinset: index + 1,
                setsize: normalized.length,
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
