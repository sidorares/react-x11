// Style props → yoga setters (layout) and paint metadata. Flat, ink-style
// props: <box flexDirection="row" padding={8} backgroundColor="#eee">.
// Numbers are pixels; strings like '50%' / 'auto' pass through to yoga.
// Yoga comes from ntk (>= 3.1.0) so renderer and ntk widgets share one
// WASM instance and enum set.
import { Yoga } from 'ntk';

export { Yoga };

const FLEX_DIRECTION = {
  row: Yoga.FLEX_DIRECTION_ROW,
  'row-reverse': Yoga.FLEX_DIRECTION_ROW_REVERSE,
  column: Yoga.FLEX_DIRECTION_COLUMN,
  'column-reverse': Yoga.FLEX_DIRECTION_COLUMN_REVERSE,
};

const JUSTIFY = {
  'flex-start': Yoga.JUSTIFY_FLEX_START,
  center: Yoga.JUSTIFY_CENTER,
  'flex-end': Yoga.JUSTIFY_FLEX_END,
  'space-between': Yoga.JUSTIFY_SPACE_BETWEEN,
  'space-around': Yoga.JUSTIFY_SPACE_AROUND,
  'space-evenly': Yoga.JUSTIFY_SPACE_EVENLY,
};

const ALIGN = {
  auto: Yoga.ALIGN_AUTO,
  'flex-start': Yoga.ALIGN_FLEX_START,
  center: Yoga.ALIGN_CENTER,
  'flex-end': Yoga.ALIGN_FLEX_END,
  stretch: Yoga.ALIGN_STRETCH,
  baseline: Yoga.ALIGN_BASELINE,
  'space-between': Yoga.ALIGN_SPACE_BETWEEN,
  'space-around': Yoga.ALIGN_SPACE_AROUND,
};

const FLEX_WRAP = {
  nowrap: Yoga.WRAP_NO_WRAP,
  wrap: Yoga.WRAP_WRAP,
  'wrap-reverse': Yoga.WRAP_WRAP_REVERSE,
};

const POSITION = {
  static: Yoga.POSITION_TYPE_STATIC,
  relative: Yoga.POSITION_TYPE_RELATIVE,
  absolute: Yoga.POSITION_TYPE_ABSOLUTE,
};

const DISPLAY = {
  flex: Yoga.DISPLAY_FLEX,
  none: Yoga.DISPLAY_NONE,
};

const OVERFLOW = {
  visible: Yoga.OVERFLOW_VISIBLE,
  hidden: Yoga.OVERFLOW_HIDDEN,
  scroll: Yoga.OVERFLOW_SCROLL,
};

const pick = (map, value, name) => {
  if (value === undefined) return undefined;
  if (!(value in map)) {
    throw new Error(
      `react-x11: invalid ${name} "${value}" (expected one of ${Object.keys(map).join(', ')})`,
    );
  }
  return map[value];
};

// Each entry: prop name -> (yogaNode, value) applier. `undefined` resets.
const LAYOUT_APPLIERS = {
  width: (n, v) => n.setWidth(v),
  height: (n, v) => n.setHeight(v),
  minWidth: (n, v) => n.setMinWidth(v),
  minHeight: (n, v) => n.setMinHeight(v),
  maxWidth: (n, v) => n.setMaxWidth(v),
  maxHeight: (n, v) => n.setMaxHeight(v),
  flexDirection: (n, v) =>
    n.setFlexDirection(
      pick(FLEX_DIRECTION, v, 'flexDirection') ?? Yoga.FLEX_DIRECTION_COLUMN,
    ),
  justifyContent: (n, v) =>
    n.setJustifyContent(
      pick(JUSTIFY, v, 'justifyContent') ?? Yoga.JUSTIFY_FLEX_START,
    ),
  alignItems: (n, v) =>
    n.setAlignItems(pick(ALIGN, v, 'alignItems') ?? Yoga.ALIGN_STRETCH),
  alignSelf: (n, v) =>
    n.setAlignSelf(pick(ALIGN, v, 'alignSelf') ?? Yoga.ALIGN_AUTO),
  alignContent: (n, v) =>
    n.setAlignContent(pick(ALIGN, v, 'alignContent') ?? Yoga.ALIGN_FLEX_START),
  flexWrap: (n, v) =>
    n.setFlexWrap(pick(FLEX_WRAP, v, 'flexWrap') ?? Yoga.WRAP_NO_WRAP),
  flexGrow: (n, v) => n.setFlexGrow(v ?? 0),
  flexShrink: (n, v) => n.setFlexShrink(v ?? 1),
  flexBasis: (n, v) => n.setFlexBasis(v),
  position: (n, v) =>
    n.setPositionType(
      pick(POSITION, v, 'position') ?? Yoga.POSITION_TYPE_RELATIVE,
    ),
  top: (n, v) => n.setPosition(Yoga.EDGE_TOP, v),
  right: (n, v) => n.setPosition(Yoga.EDGE_RIGHT, v),
  bottom: (n, v) => n.setPosition(Yoga.EDGE_BOTTOM, v),
  left: (n, v) => n.setPosition(Yoga.EDGE_LEFT, v),
  margin: (n, v) => n.setMargin(Yoga.EDGE_ALL, v),
  marginTop: (n, v) => n.setMargin(Yoga.EDGE_TOP, v),
  marginRight: (n, v) => n.setMargin(Yoga.EDGE_RIGHT, v),
  marginBottom: (n, v) => n.setMargin(Yoga.EDGE_BOTTOM, v),
  marginLeft: (n, v) => n.setMargin(Yoga.EDGE_LEFT, v),
  padding: (n, v) => n.setPadding(Yoga.EDGE_ALL, v),
  paddingTop: (n, v) => n.setPadding(Yoga.EDGE_TOP, v),
  paddingRight: (n, v) => n.setPadding(Yoga.EDGE_RIGHT, v),
  paddingBottom: (n, v) => n.setPadding(Yoga.EDGE_BOTTOM, v),
  paddingLeft: (n, v) => n.setPadding(Yoga.EDGE_LEFT, v),
  gap: (n, v) => n.setGap(Yoga.GUTTER_ALL, v ?? 0),
  rowGap: (n, v) => n.setGap(Yoga.GUTTER_ROW, v ?? 0),
  columnGap: (n, v) => n.setGap(Yoga.GUTTER_COLUMN, v ?? 0),
  aspectRatio: (n, v) => n.setAspectRatio(v),
  display: (n, v) =>
    n.setDisplay(pick(DISPLAY, v, 'display') ?? Yoga.DISPLAY_FLEX),
  overflow: (n, v) =>
    n.setOverflow(pick(OVERFLOW, v, 'overflow') ?? Yoga.OVERFLOW_VISIBLE),
  borderWidth: (n, v) => n.setBorder(Yoga.EDGE_ALL, v ?? 0),
};

// Props that only affect painting, not geometry.
const PAINT_PROPS = new Set([
  'backgroundColor',
  'borderColor',
  'borderRadius',
  'zIndex',
]);

// Text style props. All affect measurement except color.
export const TEXT_LAYOUT_PROPS = new Set([
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'textAlign',
  'lineHeight',
]);

export const isLayoutProp = (name) =>
  Object.prototype.hasOwnProperty.call(LAYOUT_APPLIERS, name);
export const isPaintProp = (name) => PAINT_PROPS.has(name);
export const isEventProp = (name) => /^on[A-Z]/.test(name);

/**
 * Apply changed layout props to a yoga node.
 * @returns true if any layout-affecting prop changed
 */
export function applyLayoutStyle(yogaNode, props, oldProps = {}) {
  let changed = false;
  for (const key of Object.keys(LAYOUT_APPLIERS)) {
    if (props[key] !== oldProps[key]) {
      LAYOUT_APPLIERS[key](yogaNode, props[key]);
      changed = true;
    }
  }
  return changed;
}

/** @returns true if any paint-only prop changed */
export function paintPropsChanged(props, oldProps = {}) {
  for (const key of PAINT_PROPS) {
    if (props[key] !== oldProps[key]) return true;
  }
  return props.color !== oldProps.color;
}

/** Resolved text style (TextLayout base style) from props + inherited. */
export function textStyleFrom(props, inherited) {
  return {
    family: props.fontFamily ?? inherited.family,
    size: props.fontSize ?? inherited.size,
    weight: props.fontWeight ?? inherited.weight,
    style: props.fontStyle ?? inherited.style,
    color: props.color ?? inherited.color,
  };
}

export const DEFAULT_TEXT_STYLE = {
  family: 'sans-serif',
  size: 14,
  weight: 'normal',
  style: 'normal',
  color: 'black',
};
