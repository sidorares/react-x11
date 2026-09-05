// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useEffect, useRef, useState } from 'react';
import { useAppOrNull } from '../appcontext.js';
import { capBand, capTrim, rowRadius, useTheme } from './theme.js';
import { Icon } from './Icon.js';
import {
  ABS_FILL,
  Bezel,
  NATIVE_MENU,
  NATIVE_RING,
  TITLE_BASELINE,
  bezelNatural,
  bezelShadow,
  nativeTitleStyle,
  pressWash,
  useNativeControls,
} from './native.js';
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

/**
 * The menu's geometry: the palette's, or — where the trigger is a native
 * popup bezel — NSMenu's, so the sheet that drops from it is the one the
 * bezel promises. The drawn menu marks the chosen option in bold; a native
 * popup's menu marks it with a check in the column every row reserves, at
 * regular weight, as the bezel's own menu does.
 */
function menuMetrics(theme, native) {
  if (native) {
    const padLeft = NATIVE_MENU.padLeft + NATIVE_MENU.markColumn;
    const cap = capBand(NATIVE_MENU.fontSize);
    return {
      ...NATIVE_MENU,
      padLeft,
      selectedWeight: 'normal',
      check: true,
      // Where a row's capitals end, from the row's top: the centred band,
      // at the whole pixel. Placed there by the row rather than centred by
      // layout — centring puts the band at 6.5pt, which floors to 6 at 1×
      // and is exact at 2×, and the menu that opens over the trigger is
      // aligned on this number, so it has to be the same one at every
      // scale.
      capsBottom: Math.floor((NATIVE_MENU.row - cap) / 2) + cap,
      // How far the menu hangs past the trigger: left, so the titles line
      // up (the menu's inset less the trigger's); right, past the arrow
      // capsule, read off the screen at 10pt.
      hang: {
        left: MENU_BORDER + NATIVE_MENU.pad + padLeft - TRIGGER_PAD_LEFT,
        right: 10,
      },
    };
  }
  return {
    fontSize: theme.fontSize,
    weight: 'normal',
    selectedWeight: 'bold',
    check: false,
    row: itemHeight(theme.fontSize),
    pad: MENU_PAD,
    padLeft: ITEM_PAD_LEFT,
    padRight: ITEM_PAD_RIGHT,
    radius: rowRadius(theme, MENU_BORDER, MENU_PAD),
  };
}
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
// Where a native popup bezel's title starts, from the trigger's left edge —
// and so what the menu's own inset is measured against when it opens over
// the trigger (`menuAnchorOptions`).
const TRIGGER_PAD_LEFT = 10;
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
function menuWidth(node, options, value, scrolls, metrics) {
  let widest = 0;
  for (const option of options) {
    const { width } = measureLabel(node, option.label, {
      size: metrics.fontSize,
      weight: option.value === value ? metrics.selectedWeight : 'normal',
    });
    if (width > widest) widest = width;
  }
  const chrome =
    (MENU_BORDER + metrics.pad) * 2 +
    metrics.padLeft +
    metrics.padRight +
    (scrolls ? SCROLLBAR_WIDTH : 0);
  // logical throughout: the trigger's rect divided out of device pixels,
  // the measured labels already logical (measureLabel), the area logical
  // A native popup's menu opens over its control and covers all of it,
  // the arrow capsule included — it hangs out on both sides (`hang`).
  const trigger =
    node.abs.width / node.scale +
    (metrics.hang?.left ?? 0) +
    (metrics.hang?.right ?? 0);
  const width = Math.max(trigger, Math.ceil(widest) + chrome);
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
  metrics,
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
        height: metrics.row,
        justifyContent: metrics.capsBottom ? 'flex-end' : 'center',
        paddingBottom: metrics.capsBottom
          ? metrics.row - metrics.capsBottom
          : 0,
        paddingLeft: metrics.padLeft,
        paddingRight: metrics.padRight,
        // the menus' pill, for the same reason and by the same rule: an
        // option list and a menu are one surface with rows in it, and two
        // shapes for that would only say the widgets were written apart
        borderRadius: metrics.radius,
        // nothing at rest — the sheet under it is already that colour, and a
        // rounded fill of the same colour is a coverage mask drawn to change
        // nothing, with four corners it deliberately leaves out
        backgroundColor: active ? theme.hoverBackground : 'transparent',
      },
    },
    // The native menu's check, in the mark column to the left of the title.
    // Drawn over the row's own left padding — NSMenu's mark sits inside the
    // highlight, between its edge and the title.
    metrics.check &&
      selected &&
      h(Icon, {
        name: 'check',
        size: capBand(metrics.fontSize),
        color: active ? theme.hoverText : theme.text,
        style: { position: 'absolute', left: metrics.markLeft },
      }),
    h(
      'text',
      {
        style: [
          capTrim,
          {
            color: active ? theme.hoverText : theme.text,
            fontSize: metrics.fontSize,
            fontWeight: selected ? metrics.selectedWeight : metrics.weight,
            // pinned to the whole-pixel cap band (see nativeTitleStyle)
            height: metrics.capsBottom ? capBand(metrics.fontSize) : undefined,
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
  native,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const app = useAppOrNull();
  const nativeControls = useNativeControls(native);
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
  // Rows are sized from the text size the labels inside them come out at:
  // the palette's, or NSMenu's under a native popup bezel.
  const metrics = menuMetrics(theme, nativeControls);
  const rowHeight = metrics.row;
  const contentHeight = normalized.length * rowHeight + metrics.pad * 2;
  const menuHeight = Math.min(contentHeight, MAX_MENU_HEIGHT);
  const scrolls = contentHeight > MAX_MENU_HEIGHT;

  // shared anchoring: also flips the menu above the trigger when there is
  // no room below, and slides it left when the menu is wider than the
  // trigger and would otherwise open off the right edge
  // A native popup button does not drop its menu below the control: it
  // opens the menu *over* it, with the chosen row on top of the control and
  // the two titles coincident — the menu's mark column hanging out to the
  // left, the rows above and below it stacked up and down. The menu's
  // title inset less the trigger's is how far left it starts. No flip: a
  // menu over its control has no other side, and is clamped into the
  // screen as AppKit's is.
  const menuAnchorOptions = () => {
    const height = menuHeight + 2;
    const width = menuWidth(
      triggerRef.current,
      normalized,
      value,
      scrolls,
      metrics,
    );
    if (!nativeControls) return { placement: 'bottom', height, width };
    const node = triggerRef.current;
    const scale = node?.scale ?? 1;
    const triggerHeight = node ? node.abs.height / scale : 0;
    const shadow = bezelShadow(app, 'popup');
    // Aligned on the *capitals*, which is what the eye lines up: the
    // trigger's sit on the title baseline (`TITLE_BASELINE` above the bezel
    // body's bottom), a row's on `capsBottom` — both whole pixels, both
    // placed rather than centred, so the two agree at every scale.
    const triggerCapsBottom =
      triggerHeight - shadow.bottom - TITLE_BASELINE.regular;
    const rowCapsBottom = metrics.capsBottom;
    const chosen = Math.max(
      0,
      normalized.findIndex((o) => o.value === value),
    );
    const chosenRowTop = MENU_BORDER + metrics.pad + chosen * metrics.row;
    const top = triggerCapsBottom - chosenRowTop - rowCapsBottom;
    return {
      placement: 'bottom',
      offset: 0,
      flip: false,
      at: { x: 0, y: top, width: node ? node.abs.width / scale : 0, height: 0 },
      alignOffset: -metrics.hang.left,
      height,
      width,
    };
  };

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
        nativeControls
          ? // The native popup bezel carries the border, the fill and the
            // arrow capsule, so the trigger keeps only its row layout and
            // AppKit's own height. The right padding clears the arrows.
            {
              cursor: 'pointer',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              height: bezelNatural(app, 'popup').height,
              paddingLeft: TRIGGER_PAD_LEFT,
              paddingRight: 26,
              // The title sits where NSPopUpButtonCell puts it — on the
              // same baseline as a push button's, above the body's bottom
              // edge, the shadow padded off (see Button).
              paddingTop: bezelShadow(app, 'popup').top,
              paddingBottom:
                bezelShadow(app, 'popup').bottom + TITLE_BASELINE.regular,
              // the keyboard ring hugs the bezel's corners (see Button)
              borderRadius: 6,
              ':focus-visible': {
                outlineWidth: NATIVE_RING.width,
                outlineOffset: NATIVE_RING.offset,
              },
            }
          : {
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
        // (In native mode the wash overlay below answers the press instead.)
        !nativeControls &&
          !open && {
            ':hover': { backgroundColor: theme.surfaceHover },
            ':active': { backgroundColor: theme.surfaceActive },
          },
        style,
      ],
    },
    // `pressed` while the menu is down: AppKit's popup answers being open
    // by highlighting the arrow capsule, which is the open look this
    // trigger otherwise lost with its borderFocus.
    nativeControls &&
      h(Bezel, {
        kind: 'popup',
        pressed: open,
        enabled: true,
        style: ABS_FILL,
      }),
    h(
      'text',
      {
        style: [
          capTrim,
          nativeControls && nativeTitleStyle('regular'),
          { color: current ? theme.text : theme.textMuted },
        ],
      },
      current ? current.label : placeholder,
    ),
    h('box', { style: { flexGrow: 1 } }),
    // The chevron is exactly as tall as the capitals it stands beside, and
    // for a reason a form depends on: a field, a dropdown and a button in one
    // row have to be one height, and they only are if the tallest thing in
    // each is measured the same way. A glyph taller than the cap band makes
    // the dropdown alone two pixels taller than everything next to it.
    // The native bezel draws its own arrow capsule instead.
    nativeControls
      ? h('box', {
          style: [
            ABS_FILL,
            { borderRadius: 6 },
            !open && { ':active': { backgroundColor: pressWash(theme) } },
          ],
        })
      : h(Icon, {
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
          // what this sheet *is* to the compositor: a menu dropping from a
          // control, not the bare `<popup>` default of `popup_menu`
          windowType: 'dropdown_menu',
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
              style: {
                flexGrow: 1,
                padding: metrics.pad,
                overflow: 'scroll',
              },
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
                metrics,
              }),
            ),
          ),
        ),
      ),
  );
}
