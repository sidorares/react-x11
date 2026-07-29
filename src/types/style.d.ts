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
  flexGrow?: number;
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
  gap?: number;
  rowGap?: number;
  columnGap?: number;
  aspectRatio?: number;
  display?: Display;
  overflow?: Overflow;
  borderWidth?: number;
}

/**
 * Properties that only affect painting, never geometry — the only ones a
 * `:hover`/`:focus`/`:active`/`:disabled` block may set, because a state
 * block that could reflow the tree would jitter on pointer move.
 */
export interface PaintStyle {
  backgroundColor?: Color;
  borderColor?: Color;
  borderRadius?: number;
  zIndex?: number;
}

/** Text properties. All affect measurement except `color`. */
export interface TextStyle {
  color?: Color;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: FontWeight;
  fontStyle?: FontStyle;
  textAlign?: TextAlign;
  lineHeight?: number;
}

/** What a pseudo-state block may change: paint properties, plus `color`. */
export interface StateStyle extends PaintStyle {
  color?: Color;
}

/** Every property a style may set, before the block forms. */
export interface StyleProperties extends LayoutStyle, PaintStyle, TextStyle {
  borderStyle?: BorderStyle;
  cursor?: Cursor;
  pointerEvents?: PointerEvents;
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
  ':focus'?: StateStyle;
  ':active'?: StateStyle;
  ':disabled'?: StateStyle;
}

/**
 * A style: the properties themselves, the state blocks, and any number of
 * size-query blocks keyed `'@width >= 600'`.
 */
export type Style = StyleProperties &
  StyleBlocks & { [K in SizeQuery]?: StyleProperties };

/**
 * What a `style` prop accepts: an object, or a nested array of them with
 * falsy entries skipped and later entries winning. This is what replaces
 * the cascade — precedence is written at the call site.
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
