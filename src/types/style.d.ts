/**
 * The `style` prop: layout (yoga), paint, text, and the three block forms —
 * pseudo-states, window size queries, transitions. See docs/styling.md.
 */

/**
 * A CSS colour string (`'#2980b9'`, `'tomato'`, `'rgba(0,0,0,.5)'`), or a
 * `$token` resolved against the nearest `theme` prop — see
 * {@link https://github.com/sidorares/react-x11/blob/master/docs/styling.md#theme-tokens Theme tokens}.
 */
export type Color = string;

/** A yoga length: pixels, a percentage, or `'auto'`. */
export type Dimension = number | `${number}%` | 'auto';

/** A yoga length that has no `auto` form. */
export type Length = number | `${number}%`;

export type FlexDirection = 'row' | 'row-reverse' | 'column' | 'column-reverse';

export type Justify =
  | 'flex-start'
  | 'center'
  | 'flex-end'
  | 'space-between'
  | 'space-around'
  | 'space-evenly';

export type Align =
  | 'auto'
  | 'flex-start'
  | 'center'
  | 'flex-end'
  | 'stretch'
  | 'baseline'
  | 'space-between'
  | 'space-around';

export type FlexWrap = 'nowrap' | 'wrap' | 'wrap-reverse';
export type PositionType = 'static' | 'relative' | 'absolute';
export type Display = 'flex' | 'none';
export type Overflow = 'visible' | 'hidden' | 'scroll';
export type BorderStyle = 'solid' | 'dashed';
export type PointerEvents = 'auto' | 'none';
export type TextAlign = 'left' | 'right' | 'center' | 'start' | 'end';
export type FontStyle = 'normal' | 'italic' | 'oblique';
export type FontWeight = number | 'normal' | 'bold';

/**
 * Cursor names, as ntk maps them to the X cursor font. Any other string is
 * passed through to ntk, which may know shapes this list does not.
 */
export type Cursor =
  | 'default'
  | 'pointer'
  | 'text'
  | 'move'
  | 'crosshair'
  | 'wait'
  | 'progress'
  | 'help'
  | 'not-allowed'
  | 'grab'
  | 'grabbing'
  | 'ew-resize'
  | 'ns-resize'
  | 'nwse-resize'
  | 'nesw-resize'
  | 'col-resize'
  | 'row-resize'
  | 'none'
  | (string & {});

/**
 * Which way the boxes under this one run — CSS's `direction`.
 *
 * `'inherit'` is the default and means "whatever is around me"; the floor
 * under the whole tree is the palette's `direction`, which is seeded from the
 * locale. Setting it mirrors this subtree: rows run the other way, and every
 * `*Start`/`*End` edge below swaps sides with it.
 */
export type Direction = 'ltr' | 'rtl' | 'inherit';

/** Everything yoga lays out. */
export interface LayoutStyle {
  width?: Dimension;
  height?: Dimension;
  minWidth?: Length;
  minHeight?: Length;
  maxWidth?: Length;
  maxHeight?: Length;
  flexDirection?: FlexDirection;
  justifyContent?: Justify;
  alignItems?: Align;
  alignSelf?: Align;
  alignContent?: Align;
  flexWrap?: FlexWrap;
  /**
   * CSS's shorthand: `flex: 1` is `flexGrow: 1, flexShrink: 1,
   * flexBasis: 0` — take this share of what is left, from a base size of
   * nothing. `'auto'` grows and shrinks from the content's own size,
   * `'none'` does neither. A longhand written beside it wins.
   */
  flex?: number | 'auto' | 'none';
  flexGrow?: number;
  /** How eagerly this item gives up the space it has **above its content**;
   *  `1` by default, as in CSS. It never shrinks past what is inside it —
   *  say `minWidth: 0` (or an `overflow` that clips) for that. */
  flexShrink?: number;
  flexBasis?: Dimension;
  position?: PositionType;
  top?: Length;
  right?: Length;
  bottom?: Length;
  left?: Length;
  margin?: Dimension;
  marginTop?: Dimension;
  marginRight?: Dimension;
  marginBottom?: Dimension;
  marginLeft?: Dimension;
  padding?: Length;
  paddingTop?: Length;
  paddingRight?: Length;
  paddingBottom?: Length;
  paddingLeft?: Length;
  /**
   * The **logical** horizontal edges: the side the text starts at and the
   * side it ends at, whichever those are under the direction in force. They
   * override their physical counterparts even in LTR, the way CSS's
   * `padding-inline-start` overrides `padding-left`.
   */
  start?: Length;
  end?: Length;
  marginStart?: Dimension;
  marginEnd?: Dimension;
  paddingStart?: Length;
  paddingEnd?: Length;
  gap?: number;
  rowGap?: number;
  columnGap?: number;
  aspectRatio?: number;
  display?: Display;
  overflow?: Overflow;
  borderWidth?: number;
  /** Per-side widths override `borderWidth` the way `paddingTop` overrides
   *  `padding`. Layout properties: yoga sees each edge, so a 3px left bar
   *  insets content on the left only. */
  borderTopWidth?: number;
  borderRightWidth?: number;
  borderBottomWidth?: number;
  borderLeftWidth?: number;
  /** The logical sides, which win over the physical ones. */
  borderStartWidth?: number;
  borderEndWidth?: number;
  direction?: Direction;
}

/**
 * Properties that only affect painting, never geometry — the only ones a
 * `:hover`/`:focus`/`:active`/`:disabled`/`:drag-over`/`:dragging` block
 * may set, because a state block that could reflow the tree would jitter
 * on pointer move.
 */
export interface PaintStyle {
  backgroundColor?: Color;
  /**
   * A gradient behind the node, in the box the layout gave it:
   * `'linear-gradient(#2b5876, #4e4376)'`, `'linear-gradient(135deg, $accent,
   * $accentActive)'`, or `'none'`.
   *
   * CSS's grammar and CSS's geometry — an angle in degrees clockwise from
   * "up", the `to bottom right` keywords, `%`/`px` stop positions — with two
   * differences: only `linear-gradient` exists (a radial or conic one is a
   * `<canvas onDraw>`), and a colour stop may be a `$token`. It paints over
   * `backgroundColor`, which is the CSS order, so a translucent gradient
   * tints the colour underneath it.
   */
  backgroundImage?: string;
  /**
   * A shadow cast outside the box:
   * `'0 2px 8px rgba(0, 0, 0, .4)'`, `'0 1px 2px #0003, 0 8px 24px $shadow'`
   * (any `$token` the theme names), or `'none'`.
   *
   * `<x> <y> [blur] [spread] [colour]` per shadow, comma-separated, painted
   * first-on-top like CSS's. The colour may be left out, which means the
   * node's own `color`. Outer shadows only — `inset` throws — and ignored on
   * `<window>`/`<popup>`, which own no pixels outside themselves.
   */
  boxShadow?: string;
  borderColor?: Color;
  /** Per-side colours fall back to `borderColor`. Paint properties, legal in
   *  state blocks like it. */
  borderTopColor?: Color;
  borderRightColor?: Color;
  borderBottomColor?: Color;
  borderLeftColor?: Color;
  /** …and the logical sides, matching `borderStartWidth`/`borderEndWidth`. */
  borderStartColor?: Color;
  borderEndColor?: Color;
  /** Rounds the background, the border and the child clip. Requires uniform
   *  borders — same width and colour on all four sides; a non-uniform border
   *  paints square and ignores the radius. */
  borderRadius?: number;
  zIndex?: number;
  /**
   * The focus-ring family. Painted *outside* the border box and never seen
   * by yoga — which is why CSS grew `outline` separately from `border`, and
   * why switching one on cannot move the thing it surrounds.
   *
   * A focusable node draws one on `:focus-visible` with no styling at all;
   * these override it, and `outlineWidth: 0` opts out.
   */
  outlineWidth?: number;
  outlineColor?: Color;
  /** The gap between the border box and the ring. Default 1. */
  outlineOffset?: number;
}

/**
 * Which edges of the text a `<text>`'s box is measured to.
 *
 * `'cap-alphabetic'` is CSS's `text-box-trim: trim-both` with
 * `text-box-edge: cap alphabetic`: the box becomes the capitals down to the
 * last baseline, so padding around a label is measured from the letters
 * rather than from the font's ascent and descent — and centring centres what
 * you can see. `lineHeight` is not an alternative: it scales the line box
 * and the leading still splits evenly, moving both edges by the same amount.
 */
export type TextBoxTrim = 'none' | 'cap-alphabetic';
export type TextWrap = 'wrap' | 'nowrap';

export type TextRendering =
  'auto' | 'optimizeSpeed' | 'optimizeLegibility' | 'geometricPrecision';

/** Text properties. All affect measurement except `color`. */
export interface TextStyle {
  color?: Color;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: FontWeight;
  fontStyle?: FontStyle;
  /** A variable font's axes, by OpenType tag: `{ wdth: 87.5, slnt: -8 }`.
   *  The `wght` axis is already driven by `fontWeight`, so this is for the
   *  rest. Axes the font does not have are ignored and values clamp to each
   *  axis's range. Compared by value, so an object literal is fine. */
  fontVariationSettings?: Record<string, number>;
  /** CSS's `text-rendering`, picking the glyph path (ntk >= 7.2.0).
   *  `'geometricPrecision'` puts glyph origins exactly where shaping asked —
   *  what display text and animated variable fonts want, since cached glyphs
   *  can only land on whole pixels. `'optimizeSpeed'` keeps the cached path
   *  at any size. `'auto'` (default) lets size decide. Changing it repaints
   *  without reflowing: it cannot move anything. */
  textRendering?: TextRendering;
  textAlign?: TextAlign;
  lineHeight?: number;
  /** CSS's `text-wrap`. `'nowrap'` measures the text at unbounded width, so
   *  it stays on one line and overflows its box horizontally rather than
   *  wrapping to fit — what a fixed-height row wants, since a wrapped line in
   *  one is sliced rather than shown. Default `'wrap'`. */
  textWrap?: TextWrap;
  /** Default `'none'`. Applies to `<text>`; the editable controls keep their
   *  full line box, which their caret and selection geometry are measured
   *  against. */
  textBoxTrim?: TextBoxTrim;
}

/** What a pseudo-state block may change: paint properties, plus `color`. */
export interface StateStyle extends PaintStyle {
  color?: Color;
}

/** How far outside the box the pointer still counts as hitting it. A number
 * grows every side; the object form grows only the sides it names. */
export type HitSlop =
  number | { top?: number; right?: number; bottom?: number; left?: number };

/** Every property a style may set, before the block forms. */
export interface StyleProperties extends LayoutStyle, PaintStyle, TextStyle {
  borderStyle?: BorderStyle;
  cursor?: Cursor;
  pointerEvents?: PointerEvents;
  /**
   * Hit testing only: it never grows the drawing and never reaches yoga, so
   * a 16px control can have a 24px target without the layout moving.
   */
  hitSlop?: HitSlop;
}

/**
 * How long a change takes: one duration in ms for everything animatable, or
 * a duration per property. Enums, percentages, `'auto'` and `zIndex` snap
 * rather than animate.
 */
export type Transition = number | { [K in keyof StyleProperties]?: number };

/**
 * A window size query — the X11 analogue of `@media`, asking about the
 * window a style is laid out in: `'@width >= 600'`, `'@height < 400'`.
 * Unlike a state block, a size query may set layout properties.
 */
export type SizeQuery = `@${'width' | 'height'} ${string}`;

/** The named blocks a style may carry, beside its own properties. */
export interface StyleBlocks {
  transition?: Transition;
  ':hover'?: StateStyle;
  /** Set while focus is on this node **or inside it** — CSS's
   * `:focus-within`, and the way a row highlights while the field in it is
   * being typed into. Lower precedence than `:focus`, which is the narrower
   * statement. */
  ':focus-within'?: StateStyle;
  ':focus'?: StateStyle;
  /** Focus that arrived from the keyboard rather than from a press — CSS's
   * `:focus-visible`. This is where a focus ring belongs: a ring on every
   * click is noise, and a ring on Tab is the only cue a keyboard user has. */
  ':focus-visible'?: StateStyle;
  ':active'?: StateStyle;
  ':disabled'?: StateStyle;
  /** Set while a drag is over this node or a descendant — the same
   * ancestor-path rule `:hover` follows, and like it, not filtered by
   * whether the node would accept the drop. */
  ':drag-over'?: StateStyle;
  /** Set on a drag source for the duration of the drag. */
  ':dragging'?: StateStyle;
}

/**
 * A style: the properties themselves, the state blocks, and any number of
 * size-query blocks keyed `'@width >= 600'`.
 */
export type Style = StyleProperties &
  StyleBlocks & { [K in SizeQuery]?: StyleProperties };

/**
 * What a `style` prop accepts: an object, or a nested array of them with
 * falsy entries skipped and later entries winning. This is what replaces the
 * *selector* cascade — precedence is written at the call site rather than
 * resolved by specificity. Inheritance is a separate thing and does happen:
 * the ink, the face and the size travel down the tree (`INHERITED_TEXT_PROPS`).
 */
export type StyleProp = Style | false | null | undefined | readonly StyleProp[];

/** A sheet of named styles, as returned by `createStyles`. */
export type StyleSheet<T> = { readonly [K in keyof T]: Readonly<Style> };

/**
 * Declare styles once, outside render. Identity is the point: a hoisted
 * style object lets the renderer skip an update with a `===` check. It also
 * validates keys, which a bare object literal cannot — and so does this
 * signature: the parameter is mapped rather than a bare type parameter so
 * each value keeps `Style` as its contextual type, which is what makes
 * TypeScript reject an unknown property instead of widening it away.
 */
export function createStyles<T extends Record<string, unknown>>(sheet: {
  [K in keyof T]: Style;
}): StyleSheet<T>;

/** Flatten a `StyleProp` into a single style object. */
export function flattenStyle(style: StyleProp): Style;
