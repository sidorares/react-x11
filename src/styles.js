// Style props → yoga setters (layout) and paint metadata. Flat, ink-style
// props: <box flexDirection="row" padding={8} backgroundColor="#eee">.
// Numbers are pixels; strings like '50%' / 'auto' pass through to yoga.
// Yoga comes from ntk (>= 3.1.0) so renderer and ntk widgets share one
// WASM instance and enum set.
import { Yoga, cssColor } from 'ntk';

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
 * State blocks, lowest precedence first. These are *node* states, not
 * selectors: each one is something the node itself knows about, so
 * resolving them needs no cascade, no specificity and no tree walk.
 * Anything relational (`:hover > child`, `:focus-within`, `:nth-child`)
 * stays in React, where composition already answers it.
 */
export const STATE_KEYS = [':hover', ':focus', ':active', ':disabled'];

// What a state block may change. Deliberately paint-only: a state block that
// could set `padding` or `fontSize` would reflow the tree on pointer move,
// which is both a jitter bug and the end of the "hover is a repaint, not a
// React render" property that makes this worth having at all.
const STATE_PROPS = new Set([...PAINT_PROPS, 'color']);

const STYLE_PROPS = new Set([
  ...Object.keys(LAYOUT_APPLIERS),
  ...PAINT_PROPS,
  ...TEXT_LAYOUT_PROPS,
  'color',
  'borderStyle',
  'transition',
  // CSS concepts even though they read as behaviour; React Native has been
  // moving pointerEvents into style for the same reason
  'cursor',
  'pointerEvents',
]);

export const isStyleProp = (name) => STYLE_PROPS.has(name);

const isState = (key) => key.charCodeAt(0) === 58; /* ':' */

function validateStyle(style, where) {
  for (const key of Object.keys(style)) {
    if (isState(key)) {
      if (!STATE_KEYS.includes(key)) {
        throw new Error(
          `react-x11: unknown style state "${key}" in ${where} ` +
            `(expected one of ${STATE_KEYS.join(', ')})`,
        );
      }
      for (const inner of Object.keys(style[key] ?? {})) {
        if (STATE_PROPS.has(inner)) continue;
        throw new Error(
          `react-x11: "${inner}" is not allowed inside "${key}" in ${where}. ` +
            'State blocks may only change paint properties ' +
            `(${[...STATE_PROPS].join(', ')}) — anything that reflows the ` +
            'tree on hover belongs in React state.',
        );
      }
      continue;
    }
    if (!STYLE_PROPS.has(key)) {
      throw new Error(`react-x11: unknown style property "${key}" in ${where}`);
    }
  }
}

/**
 * Flatten a style prop — an object, or a nested array of them with falsy
 * entries skipped, later entries winning:
 *
 *   style={[styles.card, isWide && styles.wide, { padding: 4 }]}
 *
 * This is what replaces the cascade: precedence is written at the call
 * site instead of being resolved by specificity.
 */
export function flattenStyle(style, into) {
  if (!style) return into ?? EMPTY_STYLE;
  if (Array.isArray(style)) {
    const acc = into ?? {};
    for (const entry of style) flattenStyle(entry, acc);
    return acc;
  }
  // a lone object is returned as-is: no copy, and `===` still identifies a
  // hoisted style across renders
  if (!into) return style;
  for (const key of Object.keys(style)) {
    // a state block merges with one already collected rather than replacing
    // it, so [{':hover': {color}}, {':hover': {backgroundColor}}] keeps both
    into[key] =
      isState(key) && into[key] ? { ...into[key], ...style[key] } : style[key];
  }
  return into;
}

export const EMPTY_STYLE = Object.freeze({});

/**
 * Declare styles once, outside render. Identity is the point: a hoisted
 * style object lets the renderer skip an update with a `===` check, the
 * same reason RN's StyleSheet.create exists now that its id registry is
 * gone. It also validates keys, which a bare object literal cannot.
 */
export function createStyles(sheet) {
  for (const name of Object.keys(sheet)) {
    validateStyle(sheet[name], `styles.${name}`);
    Object.freeze(sheet[name]);
  }
  return Object.freeze(sheet);
}

/**
 * Overlay the active state blocks on a flattened style, lowest precedence
 * first (hover < focus < active < disabled — a disabled control must never
 * look hovered). Returns the base object itself when no state is active,
 * so the common case allocates nothing and stays `===`-comparable.
 */
export function resolveStyleStates(style, states) {
  let resolved = style;
  for (const key of STATE_KEYS) {
    const block = style[key];
    if (!block || !states[key]) continue;
    if (resolved === style) resolved = { ...style };
    Object.assign(resolved, block);
  }
  return resolved;
}

/** Does this style react to node state at all? */
export function hasStateStyles(style) {
  for (const key of STATE_KEYS) if (style[key]) return true;
  return false;
}

/**
 * Style properties a transition can animate: numbers and colours. Enums
 * (`flexDirection`), `zIndex` (restacking every frame is not an animation)
 * and `transition` itself are excluded — a change to those snaps.
 */
const NOT_ANIMATABLE = new Set([
  'transition',
  'zIndex',
  'flexDirection',
  'justifyContent',
  'alignItems',
  'alignSelf',
  'alignContent',
  'flexWrap',
  'position',
  'display',
  'overflow',
  'cursor',
  'pointerEvents',
  'borderStyle',
  'fontFamily',
  'fontWeight',
  'fontStyle',
  'textAlign',
]);

export const isAnimatableProp = (name) =>
  STYLE_PROPS.has(name) && !NOT_ANIMATABLE.has(name);

/**
 * `transition: 150` — every animatable property that changes, over 150ms.
 * `transition: { backgroundColor: 150 }` — only these, with their own
 * durations. Returns a lookup of prop -> ms, or null.
 */
export function transitionFor(style, prop) {
  const t = style.transition;
  if (t == null || !isAnimatableProp(prop)) return 0;
  if (typeof t === 'number') return t;
  return t[prop] ?? 0;
}

const rgba = (c) =>
  c &&
  `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3]})`;

/**
 * Interpolate one style value. Numbers lerp; colours lerp per channel
 * through ntk's own CSS colour parser, so anything the paint path accepts
 * animates. Anything else — a percentage string, `auto`, an enum — has no
 * meaningful midpoint and returns null, which the caller treats as a snap.
 */
export function interpolate(from, to, t) {
  if (typeof from === 'number' && typeof to === 'number') {
    return from + (to - from) * t;
  }
  if (typeof from === 'string' && typeof to === 'string') {
    const a = cssColor(from);
    const b = cssColor(to);
    if (!a || !b) return null;
    return rgba(a.map((v, i) => v + (b[i] - v) * t));
  }
  return null;
}

// ease-out cubic: fast to start, settles gently — the shape almost every UI
// toolkit defaults to for state changes
export const ease = (t) => 1 - (1 - t) ** 3;

/**
 * Theme tokens. A style value of `'$name'` resolves against the nearest
 * `theme` prop above the node, so a style can be hoisted — declared once,
 * outside render, with no access to React context — and still follow the
 * theme. The sigil is what keeps it unambiguous: `'red'` is a CSS colour,
 * `'$red'` is a token.
 */
const isToken = (v) => typeof v === 'string' && v.charCodeAt(0) === 36; /* $ */

export function styleUsesTokens(style) {
  for (const key of Object.keys(style)) {
    const v = style[key];
    if (isToken(v)) return true;
    if (key.charCodeAt(0) === 58 && v && styleUsesTokens(v)) return true;
  }
  return false;
}

// (style object, theme object) -> resolved style. Two hoisted styles under
// one theme therefore keep their identity across renders, which is what the
// `===` fast path in applyProps relies on.
const resolvedCache = new WeakMap();

/**
 * Before a node is attached it has no ancestors and so no theme yet — one
 * commit tick, but long enough for yoga to be handed a `'$gutter'`. Drop
 * the token-valued properties until the real value is known; the node
 * restyles on attach.
 */
export function stripTokens(style) {
  const out = {};
  for (const key of Object.keys(style)) {
    const v = style[key];
    if (isToken(v)) continue;
    out[key] = key.charCodeAt(0) === 58 && v ? stripTokens(v) : v;
  }
  return out;
}

/**
 * `strict` says the node's ancestry is complete, so a token that does not
 * resolve is a mistake. While a subtree is still being built its nodes can
 * see only part of their ancestry — the theme two levels up does not exist
 * for them yet — so resolution there is provisional: unknown tokens are
 * dropped and the node restyles when it attaches.
 */
export function resolveTokens(style, theme, where = 'style', strict = true) {
  if (!theme) return stripTokens(style);
  let byTheme = strict ? resolvedCache.get(style) : null;
  if (strict && !byTheme) resolvedCache.set(style, (byTheme = new WeakMap()));
  const hit = byTheme?.get(theme);
  if (hit) return hit;

  const out = {};
  for (const key of Object.keys(style)) {
    const v = style[key];
    if (isToken(v)) {
      const name = v.slice(1);
      if (name in theme) {
        out[key] = theme[name];
        continue;
      }
      if (!strict) continue;
      throw new Error(
        `react-x11: unknown theme token "${v}" in ${where} ` +
          `(theme has ${Object.keys(theme).join(', ') || 'nothing'})`,
      );
    } else if (key.charCodeAt(0) === 58 && v) {
      out[key] = resolveTokens(v, theme, `${where} ${key}`, strict);
    } else {
      out[key] = v;
    }
  }
  byTheme?.set(theme, out);
  return out;
}

export { validateStyle };

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
