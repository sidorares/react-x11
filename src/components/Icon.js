// The system icon set: the affordance glyphs core's own widgets are drawn
// with, and the same ones an application or a third-party widget can reach
// for so that a Select it did not write and a toolbar it did lines up.
//
// ## Affordances, not nouns
//
// The set holds glyphs that mean something about *the control*: there is
// more here, this one is chosen, this closes, this is hidden. It holds no
// nouns — no folder, no document, no save, no printer. Those belong to an
// icon theme (lucide, an XDG icon theme, the app's own art), they are
// unbounded in number, and a widget set that starts shipping them has taken
// on a design system. That line is what keeps this file small enough to
// read, and it is the answer to "should X be added?".
//
// ## One shape per idea
//
// Before this existed, core drew a chevron four ways: a filled triangle in
// Select, Tree and Table, a stroked chevron in Calendar, and a `▸` text
// glyph in Menu — which is tofu on a machine without it, the very thing
// docs/components.md warns applications about. There is now one chevron and
// the filled caret is gone: a stroked chevron is what a modern control uses
// to say "more this way", and one idea drawn one way is the point of a set.
//
// ## How they are drawn, and why not a font
//
// A drawing per icon over `<canvas mono>`: the ink comes from `style.color`,
// so one drawing serves the resting row, the highlighted row, the disabled
// one and both colour schemes, and the paint cache keeps one rendered copy
// for every instance of it on screen. (A `mono` entry bakes its colour for
// now rather than caching coverage and tinting at composite time — see
// `CanvasNode.paintCachePlan` for why, and what it costs.) The draw
// functions are module-level, so their identity is stable across renders and
// a table of 500 twisties invalidates nothing when its rows re-render.
//
// A bundled icon *font* would work — ntk's FontManager takes font bytes, and
// glyphs composite through a solid source picture, so a whole column of
// chevrons would be one CompositeGlyphs. It loses on everything else: a
// binary artifact and a generation toolchain in a package that is otherwise
// pure JS, baseline rather than box alignment, unhinted mush at 12px, and an
// icon name routed through text layout and the accessibility tree. Revisit
// only if a profile of a large Tree shows composite count dominating.
//
// The drawings are also deliberately *not* themable. Colour and size are —
// see `Icon` — but the geometry is core's vocabulary, and an application
// that wants a different chevron wants an icon library, which is a separate
// thing it is welcome to bring.

import React from 'react';
import { useTheme } from './theme.js';

const h = React.createElement;

/**
 * Stroke weight for a glyph in a `size` box.
 *
 * `size / 12` is the 2-on-a-24-grid weight every modern outline set uses,
 * with a floor: below about 1.25 a stroke stops reading as a line at all,
 * and the twisty in a Tree is 10px.
 */
const weight = (size) => Math.max(1.25, size / 12);

/**
 * The live area: the ink runs corner to corner apart from this margin, so
 * **`size` is the size of the mark** rather than of a grid it sits in.
 *
 * That is the one place this set departs from how lucide and its
 * descendants draw, and it is deliberate. Their chevron spans half the width
 * and a quarter the height of its box, so a "24px" lucide icon carries about
 * 14px of ink and an author picks `size={20}` to sit beside 14px text. Every
 * call site here is a small number chosen as _how big the mark should be_ —
 * a `Select`'s chevron matches the capitals beside it, a `Checkbox`'s tick
 * fits its 16px well — and the grid convention silently made all of them
 * about 40% too small. The glyphs core drew before the set filled their
 * boxes the same way (the tick was 8×5.5 of ink in a 10×8 canvas), which is
 * what these proportions are matched against.
 *
 * The margin is half a stroke plus a hair: the stroke is centred on the
 * path, so ink at 0.0 would paint outside the box and `<canvas>` clips to
 * its bounds. 0.08 clears it at the smallest size anything is drawn at.
 */
const PAD = 0.08;
const END = 1 - PAD;

/**
 * Stroke a polyline given in fractions of the box.
 *
 * Fractions rather than a fixed design grid because the box is the only
 * thing the drawing is told about, and it is what the cache is keyed on: an
 * icon at 10px and the same icon at 16px are two entries either way, and
 * scaling here costs nothing while a transform would defeat the unscaled
 * blit the cache goes out of its way to keep.
 *
 * Never sets a colour: under `mono` the ink is preset from `style.color`,
 * and a drawing that named its own would collide with itself in the cache.
 */
function line(ctx, w, hgt, points) {
  ctx.lineWidth = weight(Math.min(w, hgt));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    if (i === 0) ctx.moveTo(x * w, y * hgt);
    else ctx.lineTo(x * w, y * hgt);
  }
  ctx.stroke();
}

/** A filled disc, in fractions of the box. */
function disc(ctx, w, hgt, cx, cy, r) {
  ctx.beginPath();
  ctx.arc(cx * w, cy * hgt, r * Math.min(w, hgt), 0, Math.PI * 2);
  ctx.fill();
}

/**
 * The eye's outline: two quadratics meeting at the corners, which is the
 * almond every peek toggle is drawn as. A quadratic reaches only half way to
 * its control point, so the lids are pushed past the box (`-0.15`, `1.15`)
 * to arrive at 0.175 and 0.825 — and the curve stays flatter than a circle,
 * which is what stops it reading as a lemon.
 */
function almond(ctx, w, hgt) {
  ctx.lineWidth = weight(Math.min(w, hgt));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(0.06 * w, 0.5 * hgt);
  ctx.quadraticCurveTo(0.5 * w, -0.15 * hgt, 0.94 * w, 0.5 * hgt);
  ctx.quadraticCurveTo(0.5 * w, 1.15 * hgt, 0.06 * w, 0.5 * hgt);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0.5 * w, 0.5 * hgt, 0.17 * Math.min(w, hgt), 0, Math.PI * 2);
  ctx.stroke();
}

/**
 * The set. Each entry is an `onDraw` — `(ctx, { width, height })` — with the
 * signature `<canvas>` already speaks, so an application can pass one
 * straight to `<canvas mono>` without going through `<Icon>`:
 *
 *   <canvas mono cacheKey="check" onDraw={icons.check} style={…} />
 *
 * Module-level and frozen: identity is the thing `CanvasNode` compares to
 * decide whether a re-render changed the picture, so these must never be
 * rebuilt per render.
 */
export const icons = Object.freeze({
  // The four chevrons are four drawings rather than one rotated, because a
  // rotation is a transform and the cache only composites unscaled,
  // unrotated surfaces — and because a 10px chevron's crispness is a
  // different problem per direction.
  //
  // Arms at 45°, so the ink is twice as wide as it is tall (or the other way
  // round): the long axis takes the whole live area and the short one half
  // of it, centred. A chevron is the flattest glyph in the set for that
  // reason, and it is why `size` for one reads as its *width*.
  chevronRight: (ctx, { width: w, height: hgt }) =>
    line(ctx, w, hgt, [
      [0.29, PAD],
      [0.71, 0.5],
      [0.29, END],
    ]),
  chevronLeft: (ctx, { width: w, height: hgt }) =>
    line(ctx, w, hgt, [
      [0.71, PAD],
      [0.29, 0.5],
      [0.71, END],
    ]),
  chevronDown: (ctx, { width: w, height: hgt }) =>
    line(ctx, w, hgt, [
      [PAD, 0.29],
      [0.5, 0.71],
      [END, 0.29],
    ]),
  chevronUp: (ctx, { width: w, height: hgt }) =>
    line(ctx, w, hgt, [
      [PAD, 0.71],
      [0.5, 0.29],
      [END, 0.71],
    ]),

  check: (ctx, { width: w, height: hgt }) =>
    line(ctx, w, hgt, [
      [PAD, 0.53],
      [0.34, 0.79],
      [END, 0.21],
    ]),
  // The mixed state of a checkbox and a menu's `toggleState === -1`: a bar,
  // because "some of these" is not "none of these" and an empty well says
  // the second.
  dash: (ctx, { width: w, height: hgt }) =>
    line(ctx, w, hgt, [
      [PAD, 0.5],
      [END, 0.5],
    ]),
  // A radio's mark, and a menu row standing in for one. Smaller than the
  // live area on purpose: a solid disc carries far more ink per pixel than
  // a stroke, and one drawn out to `PAD` reads as a blob beside a chevron
  // rather than as the same size.
  dot: (ctx, { width: w, height: hgt }) => disc(ctx, w, hgt, 0.5, 0.5, 0.26),

  // Inset past the live area, for the mirror of the same reason: an X that
  // reaches the corners measures longer on the diagonal than anything else
  // in the set measures on its side, and looks it.
  close: (ctx, { width: w, height: hgt }) => {
    line(ctx, w, hgt, [
      [0.13, 0.13],
      [0.87, 0.87],
    ]);
    line(ctx, w, hgt, [
      [0.87, 0.13],
      [0.13, 0.87],
    ]);
  },
  plus: (ctx, { width: w, height: hgt }) => {
    line(ctx, w, hgt, [
      [0.5, PAD],
      [0.5, END],
    ]);
    line(ctx, w, hgt, [
      [PAD, 0.5],
      [END, 0.5],
    ]);
  },
  // Overflow. Vertical because that is where it goes — at the end of a row,
  // opening a menu below it.
  moreVertical: (ctx, { width: w, height: hgt }) => {
    disc(ctx, w, hgt, 0.5, 0.15, 0.115);
    disc(ctx, w, hgt, 0.5, 0.5, 0.115);
    disc(ctx, w, hgt, 0.5, 0.85, 0.115);
  },

  eye: (ctx, { width: w, height: hgt }) => almond(ctx, w, hgt),
  eyeOff: (ctx, { width: w, height: hgt }) => {
    almond(ctx, w, hgt);
    line(ctx, w, hgt, [
      [0.1, 0.9],
      [0.9, 0.1],
    ]);
  },
});

/** Every name in the set, for a runtime check or a gallery. */
export const iconNames = Object.freeze(Object.keys(icons));

/**
 * The size an icon takes when nothing says otherwise: a shade under the
 * text it sits beside, which at the default 14px body is the 12px the menu
 * gutter was already built around.
 *
 * Derived from `fontSize` rather than given a palette token of its own, for
 * the reason the popup radii are: a theme that scales the type wants the
 * glyphs to scale with it, and a theme that does not should not have to
 * remember a token to keep them in proportion. The per-call `size` prop is
 * the seam for the one icon that needs to be bigger.
 */
export const iconSize = (fontSize) => Math.round(fontSize * 0.85);

/**
 * <Icon name size color /> — one glyph from the system set.
 *
 * ```jsx
 * <Icon name="chevronDown" />
 * <Icon name="check" size={10} color={theme.accentText} />
 * ```
 *
 * ## Colour and size do not cascade — pass them
 *
 * There is no cascade in this renderer: `style` precedence is written at the
 * call site (docs/styling.md), and a `color` or `fontSize` on an ancestor
 * `<box>` reaches nothing below it. So an icon inside a highlighted row does
 * **not** pick the row's ink up by itself, and neither does one inside a
 * `<text>` — it is a sibling element, not a span.
 *
 * Two consequences worth knowing before reaching for one:
 *
 *  - `color` defaults to the palette's `text`, which *does* reach here,
 *    because `theme` is the one channel that walks the tree. A row that
 *    paints its label in `theme.hoverText` has to hand the icon the same
 *    colour explicitly — which is what every call site in core does, and
 *    what Menu's `icon({ color, size })` contract has always done.
 *  - `:hover` is resolved per node against the *ancestor* chain, so a
 *    hovered row lights up but its child icon does not. An icon that has to
 *    follow a hover follows it through React state, not through a style
 *    block.
 *
 * (Both of those are the current model rather than a settled verdict: a real
 * `color`/`fontSize` cascade is a live question, and if it lands, `color`
 * and `size` here become defaults that inheritance fills in rather than
 * things every call site repeats. Nothing in the set's shape would change.)
 *
 * Everything else is a `<canvas>`: `style` merges last, and the rest of the
 * props go straight through, so a clickable icon is `<Icon onClick focusable/>`.
 * `aria-hidden` defaults to true because an affordance glyph is decoration —
 * the meaning is already on the control, in its `role` and its
 * `aria-expanded`. Name it (`aria-hidden={false} aria-label="Close"`) only
 * when the icon *is* the control and nothing else says so.
 */
export function Icon({
  name,
  size,
  color,
  style,
  'aria-hidden': ariaHidden = true,
  ...canvasProps
}) {
  // Before the hook on purpose: a name outside the set never renders, so
  // there is no hook order to keep, and this way the check is reachable
  // without a tree — which is what makes it testable and what makes the
  // message land on the call site rather than inside a paint.
  const draw = icons[name];
  if (!draw) {
    throw new Error(
      `<Icon name="${name}">: not a system icon. One of: ${iconNames.join(', ')}`,
    );
  }
  const theme = useTheme();
  const px = size ?? iconSize(theme.fontSize);
  return h('canvas', {
    mono: true,
    // The size is already in the cache key — the plan carries the node's
    // width and height — so the name is the whole of what this adds, and
    // the colour is out of it on purpose: that is what `mono` buys.
    cacheKey: name,
    onDraw: draw,
    'aria-hidden': ariaHidden,
    ...canvasProps,
    style: [
      { width: px, height: px, flexShrink: 0, color: color ?? theme.text },
      style,
    ],
  });
}
