// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useApp, useSupports } from '../appcontext.js';
import { interpolate } from '../styles.js';
import { ThemeProvider, useTheme } from './theme.js';
import {
  DEFAULT_LABEL_SIZE,
  measureLabel,
  movingToward,
  SAFE_HOVER_DELAY,
  screenOf,
  screenPoint,
  screenRect,
  useAnchor,
  useAnchorTracking,
} from './anchor.js';

const h = React.createElement;

const TOOLTIP_PADDING_X = 8;

const TOOLTIP_PADDING_Y = 4;

// The arrow, across the bubble's edge and out from it. Small on purpose: it
// is there to say *which* control the hint belongs to, and a big one starts
// to look like a speech balloon.
const ARROW_WIDTH = 12;
const ARROW_DEPTH = 6;

// The arrow's base sits this far *inside* the bubble. The two shapes are
// painted separately and antialiased separately, so meeting them exactly on
// the edge leaves a hairline of half-covered pixels between them.
const ARROW_OVERLAP = 1;

// What a `label` that is not text gets when the caller sizes nothing. A
// popup is a real X window: it needs its size before anything inside it can
// be laid out, so there is no measuring our way out of this one.
const RICH_WIDTH = 220;
const RICH_HEIGHT = 80;

const isText = (label) =>
  typeof label === 'string' || typeof label === 'number';

// Which sides `direction="auto"` tries, in order. Above first, because a
// hint above the thing it describes covers nothing you are about to click;
// then below, then out to the sides, which is where a control near the top
// or bottom of a screen has to put it.
const AUTO_SIDES = ['top', 'bottom', 'right', 'left'];

// Room the popup needs beyond its own size for a side to count as fitting:
// `anchorRect`'s own 2px gap, and enough left over that the hint is not
// jammed flush against the edge of the screen.
const AUTO_MARGIN = 8;

/**
 * The palette **inside** the bubble, which is the one outside it upside
 * down: a tooltip is drawn in the palette's ink so that it reads as a label
 * over the desktop rather than as another panel of the app, and that makes
 * its surface `text` and its own ink `background`.
 *
 * Content has to be told, or it cannot be written once and stay legible in
 * both schemes — a card that hard-codes light text is invisible on the light
 * bubble a dark palette gives it, which is what a naive component label
 * does. Published through `ThemeProvider`, so both routes agree: a `$token`
 * in the content and a `useTheme()` in it describe the surface the content
 * is actually on.
 *
 * `dim` is derived rather than swapped, because the palette's own is a mid
 * grey chosen against the *app's* background. Mixing the bubble's ink
 * towards its surface lands on the muted version of whichever ink this
 * turned out to be.
 */
const MUTED = 0.38;
const BORDERISH = 0.6;

// The provider's box fills the bubble and centres what is in it, so a
// string label still sits in the middle and an element with `flexGrow: 1`
// still gets the whole rectangle.
const BUBBLE_CONTENT = Object.freeze({
  flexGrow: 1,
  justifyContent: 'center',
});

function invertedSurface(theme) {
  return {
    background: theme.text,
    text: theme.background,
    dim: interpolate(theme.background, theme.text, MUTED) ?? theme.dim,
    border:
      interpolate(theme.background, theme.text, BORDERISH) ?? theme.border,
  };
}

/**
 * The one hint that is up, per connection.
 *
 * A tooltip belongs to where the pointer is, and there is one pointer — so
 * two of them on screen at once is never a state anything meant to produce.
 * It happens anyway without a rule like this, because each `Tooltip` only
 * watches its own trigger: the safe-polygon grace that lets a hint with
 * content in it be *reached* (docs/components.md) is exactly a window where
 * one stays up while the pointer has already moved on, and moving on can
 * mean arriving somewhere that shows another.
 *
 * So the trigger taking the hover dismisses whatever else is showing, and
 * showing claims the slot. Keyed by connection, not module-global: one
 * process can drive several roots on several displays, and each display has
 * its own pointer. A WeakMap, so a closed connection takes its entry with
 * it.
 */
const showing = new WeakMap();

/** Hide the hint that is up, unless it is this one. */
function dismissOthers(app, self) {
  const current = showing.get(app);
  if (!current || current === self) return;
  showing.delete(app);
  current();
}

/**
 * The side to hang a hint off when the caller has not named one.
 *
 * Measured against the **screen**, not the owner window: a popup is a real
 * X window, so the room a tooltip has is the room the display has. The
 * first side it fits on wins, in the order above, and if it fits nowhere
 * the roomiest side does — there the placement is going to be clamped
 * whatever we pick, and the most room is the least clamping.
 *
 * With no screen geometry to read (the headless mock) this is `'top'`,
 * which is where a tooltip went before there was anything to ask.
 */
function autoDirection(node, size) {
  const trigger = screenRect(node);
  const screen = screenOf(node);
  if (!trigger || !screen) return 'top';
  const room = {
    top: trigger.y,
    bottom: screen.pixel_height - (trigger.y + trigger.height),
    left: trigger.x,
    right: screen.pixel_width - (trigger.x + trigger.width),
  };
  const needed = (side) =>
    (side === 'top' || side === 'bottom' ? size.height : size.width) +
    AUTO_MARGIN;
  const fits = AUTO_SIDES.find((side) => room[side] >= needed(side));
  if (fits) return fits;
  return AUTO_SIDES.reduce((best, side) =>
    room[side] > room[best] ? side : best,
  );
}

/**
 * Where the arrow goes **inside the popup window**, and which way it points.
 *
 * Along the bubble's edge it wants the middle of the trigger, not the middle
 * of the bubble — the two are the same until a screen edge slides the popup
 * and leaves the trigger where it was. Clamped so the triangle stays on the
 * straight part of the edge: pushed into a rounded corner it would grow a
 * notch where the two curves cross.
 */
function arrowPlacement(side, rect, trigger, radius) {
  const vertical = side === 'top' || side === 'bottom';
  const span = vertical ? rect.width : rect.height;
  // the middle of the trigger, in the popup's own coordinates
  const wanted = !trigger
    ? span / 2
    : vertical
      ? trigger.x - rect.x + trigger.width / 2
      : trigger.y - rect.y + trigger.height / 2;
  const margin = radius + ARROW_WIDTH / 2 + 1;
  const center = Math.round(Math.max(margin, Math.min(span - margin, wanted)));
  // how far along the popup the bubble's outer edge is, on the axis the
  // arrow sticks out along
  const reach = (vertical ? rect.height : rect.width) - ARROW_DEPTH;

  const across = center - ARROW_WIDTH / 2;
  const out = reach - ARROW_OVERLAP;
  const thick = ARROW_DEPTH + ARROW_OVERLAP;
  if (side === 'top') {
    return { left: across, top: out, width: ARROW_WIDTH, height: thick, side };
  }
  if (side === 'bottom') {
    return { left: across, top: 0, width: ARROW_WIDTH, height: thick, side };
  }
  if (side === 'left') {
    return { left: out, top: across, width: thick, height: ARROW_WIDTH, side };
  }
  return { left: 0, top: across, width: thick, height: ARROW_WIDTH, side };
}

/** The triangle itself, pointing away from the bubble it grows out of. */
function paintArrow(ctx, { width, height }, side, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (side === 'top') {
    ctx.moveTo(0, 0);
    ctx.lineTo(width, 0);
    ctx.lineTo(width / 2, height);
  } else if (side === 'bottom') {
    ctx.moveTo(0, height);
    ctx.lineTo(width, height);
    ctx.lineTo(width / 2, 0);
  } else if (side === 'left') {
    ctx.moveTo(0, 0);
    ctx.lineTo(0, height);
    ctx.lineTo(width, height / 2);
  } else {
    ctx.moveTo(width, 0);
    ctx.lineTo(width, height);
    ctx.lineTo(0, height / 2);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * <Tooltip label direction delay>…</Tooltip> — a hover hint in a `<popup>`,
 * so it can extend past the owner window's bounds.
 *
 * Wraps its children in a row box that carries the hover handlers and the
 * anchor ref. Shows after `delay` ms of hover, hides immediately on leave
 * (and on mousedown — a tooltip lingering over a menu you just opened is
 * the classic annoyance).
 *
 * `direction` is which side of the trigger it goes on, and it defaults to
 * `'auto'`: the first side the hint fits on, preferring above. Naming one —
 * `'top'`, `'bottom'`, `'left'`, `'right'` — is a preference rather than a
 * promise either way, since a named side still flips to its opposite rather
 * than opening off-screen, via the same `useAnchor` math `Select` uses.
 * (`placement` is the older name for the same thing and still wins where it
 * is given, so that nothing that named a side has to change.)
 *
 * `label` is usually a string, and then the popup is sized from the
 * **measured** text — not because a `<popup>` cannot size itself (it can,
 * see "Natural size" in docs/elements.md) but because `anchorRect` needs the
 * size to decide which side of the trigger the hint fits on, and that is
 * decided during the render that opens it. It can equally be an element — a
 * swatch and a hex code, a shortcut in its own type, a whole card — and then
 * the caller says how big with `width`/`height`, for the same reason. The
 * element fills the bubble and draws its own padding; a string gets the
 * bubble's.
 *
 * On a display that composites, the popup is a real ARGB window: a rounded
 * bubble with a small arrow pointing back at the trigger, and everything the
 * two do not cover left empty. Without a compositor it degrades to the
 * square opaque rectangle it has always been — an arrow there would be a
 * black triangle in a black notch, which is worse than no arrow.
 */
export function Tooltip({
  label,
  children,
  direction = 'auto',
  placement,
  delay = 500,
  fontSize = DEFAULT_LABEL_SIZE,
  width,
  height,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const app = useApp();
  const ref = useRef(null);
  const measureAnchor = useAnchor(ref);
  const [rect, setRect] = useState(null);
  const timer = useRef(null);
  // Whether there is an arrow at all has to be settled *before* the popup
  // exists — it is part of how big the window is — so this is the display
  // question (`useSupports`) rather than the per-window style block.
  const composited = useSupports('transparency');
  // memoized for identity, not for the arithmetic: a fresh palette every
  // render would re-resolve every `$token` under it
  const surfacePalette = useMemo(() => invertedSurface(theme), [theme]);

  // `cancel` and `hide` touch nothing but refs and a state setter, so they
  // can hold still across renders — and `hide` has to: it is this tooltip's
  // identity in the `showing` registry, and one that changed every render
  // would leave the registry holding a stale closure.
  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const hide = useCallback(() => {
    cancel();
    if (showing.get(app) === hide) showing.delete(app);
    setRect(null);
  }, [app, cancel]);

  // safe-polygon hover (docs/components.md): leaving the trigger *toward*
  // the tooltip keeps it up, so a tooltip with content in it can be
  // reached instead of vanishing the moment the pointer moves
  const apex = useRef(null);
  const hideSoon = () => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      hide();
    }, SAFE_HOVER_DELAY);
  };
  const onMouseMove = (ev) => {
    apex.current = screenPoint(ev) ?? apex.current;
  };
  const onMouseLeave = (ev) => {
    if (rect && movingToward(screenPoint(ev), apex.current, rect)) hideSoon();
    else hide();
  };

  // neither a pending timer nor a claim on the one visible hint may outlive
  // the component
  useEffect(() => {
    return () => {
      cancel();
      if (showing.get(app) === hide) showing.delete(app);
    };
  }, [app, cancel, hide]);

  // The bubble, which is the popup minus whatever the arrow takes.
  const bubbleSize = (node) => {
    if (!isText(label)) {
      return { width: width ?? RICH_WIDTH, height: height ?? RICH_HEIGHT };
    }
    const text = measureLabel(node, label, { size: fontSize });
    return {
      width: width ?? Math.ceil(text.width) + TOOLTIP_PADDING_X * 2,
      height: height ?? Math.ceil(text.height) + TOOLTIP_PADDING_Y * 2,
    };
  };

  const tooltipAnchorOptions = () => {
    const node = ref.current;
    // `!label` would have thrown away `0`, which is a hint like any other;
    // an empty string is not one
    if (!node || label == null || label === false || label === '') return null;
    const bubble = bubbleSize(node);
    const grow = composited ? ARROW_DEPTH : 0;
    const want = placement ?? direction;
    const side =
      want === 'auto'
        ? autoDirection(node, {
            width: bubble.width + grow,
            height: bubble.height + grow,
          })
        : want;
    const vertical = side === 'top' || side === 'bottom';
    return {
      placement: side,
      align: 'center',
      width: bubble.width + (vertical ? 0 : grow),
      height: bubble.height + (vertical ? grow : 0),
    };
  };

  const show = () => {
    const options = tooltipAnchorOptions();
    if (!options) return;
    const next = measureAnchor(options);
    if (!next) return;
    // claim the slot at the moment there is something to see, so a hint
    // that never made it past its delay never took anything away
    dismissOthers(app, hide);
    showing.set(app, hide);
    setRect(next);
  };

  // keeps the tooltip pinned to its trigger for as long as it is shown: a
  // scrolled ancestor, the trigger's own layout moving it, or the owner
  // window being nudged by the window manager or a script would otherwise
  // leave it pointing at empty space. If the trigger scrolls out of view
  // entirely, the tooltip hides instead of following it there — unlike a
  // web tooltip it is a real window and can drift past the edge of the
  // document it annotates, which reads as a stray popup rather than a hint.
  useAnchorTracking(ref, Boolean(rect), tooltipAnchorOptions, setRect, hide);

  const onMouseEnter = () => {
    // The pointer has arrived somewhere else, so whatever is still up
    // belongs to where it *was* — drop it now rather than at the end of
    // this one's delay, which would leave two on screen for half a second
    // saying different things about the same pointer.
    //
    // This does not fight the safe polygon. A trigger under an open hint
    // cannot be hovered — the popup is a window above it — so reaching for
    // a hint never crosses the trigger this would fire for.
    dismissOthers(app, hide);
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      show();
    }, delay);
  };

  /**
   * The popup, in two absolutely-positioned pieces: the bubble, and the
   * arrow beside it. Absolute rather than a flex column, because the two are
   * placed by the same arithmetic that decided how big the window is, and
   * that arithmetic has to run before there is a window to lay anything out
   * in. Whatever neither covers is the transparent margin the arrow needs to
   * point through.
   */
  const surface = () => {
    // the side `anchorRect` settled on, which is the one it was asked for
    // unless a screen edge flipped it
    const side = rect.placement ?? 'top';
    const vertical = side === 'top' || side === 'bottom';
    const arrow = composited
      ? arrowPlacement(side, rect, screenRect(ref.current), theme.radiusTooltip)
      : null;
    const inset = arrow ? ARROW_DEPTH : 0;
    const bubble = {
      // the arrow is always on the side facing the trigger, so the bubble is
      // pushed off that edge and fills the rest
      left: side === 'right' ? inset : 0,
      top: side === 'bottom' ? inset : 0,
      width: rect.width - (vertical ? 0 : inset),
      height: rect.height - (vertical ? inset : 0),
    };

    return h(
      'popup',
      {
        theme,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        windowType: 'tooltip',
        transparent: true,
        style: {
          backgroundColor: theme.text,
          '@supports transparency': { backgroundColor: 'transparent' },
        },
      },
      h(
        'box',
        {
          role: 'tooltip',
          onMouseEnter: cancel,
          onMouseLeave: hide,
          style: {
            position: 'absolute',
            left: bubble.left,
            top: bubble.top,
            width: bubble.width,
            height: bubble.height,
            justifyContent: 'center',
            backgroundColor: theme.text,
            // No border. On a hint this small a 1px outline in a colour
            // close to the fill is a smudge on the corners and nothing
            // anywhere else; the arrow is what tells you where it belongs.
            ...(isText(label)
              ? {
                  paddingLeft: TOOLTIP_PADDING_X,
                  paddingRight: TOOLTIP_PADDING_X,
                }
              : null),
            '@supports transparency': { borderRadius: theme.radiusTooltip },
          },
        },
        // the content is on the inverted surface, and is given the palette
        // that says so — both routes at once, which is what `ThemeProvider`
        // is for. The filling box it plants keeps a string label centred.
        h(
          ThemeProvider,
          { value: surfacePalette, style: BUBBLE_CONTENT },
          isText(label)
            ? h('text', { style: { color: '$text', fontSize } }, label)
            : label,
        ),
      ),
      arrow &&
        h('canvas', {
          style: {
            position: 'absolute',
            left: arrow.left,
            top: arrow.top,
            width: arrow.width,
            height: arrow.height,
          },
          onDraw: (ctx, info) => paintArrow(ctx, info, arrow.side, theme.text),
        }),
    );
  };

  return h(
    'box',
    {
      theme,
      ref,
      onMouseEnter,
      onMouseMove,
      onMouseLeave,
      onMouseDown: hide,
      ...boxProps,
      style: [{ flexDirection: 'row', alignItems: 'center' }, style],
    },
    children,
    rect && surface(),
  );
}

// --- menus ------------------------------------------------------------------
