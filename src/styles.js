// Style props → yoga setters (layout) and paint metadata. Flat, ink-style
// props: <box flexDirection="row" padding={8} backgroundColor="#eee">.
// Numbers are pixels; strings like '50%' / 'auto' pass through to yoga.
// The engine is ours (`./yoga.js`) — the enum tables below are built at
// module scope, which is what that module's synchronous half is for.
import { cssColorStraight } from 'ntk';

import { parseBoxShadow, parseLinearGradient } from './decorations.js';
import { Yoga } from './yoga.js';

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

/**
 * CSS's `flex` shorthand, as the three properties it sets. A number is
 * `flex: <grow> 1 0` — "take this share of what is left, from a base size of
 * nothing" — which is what `flex: 1` means everywhere it is written; the two
 * keywords are CSS's own, `'auto'` for "grow and shrink from my content" and
 * `'none'` for "do neither".
 *
 * It is here rather than in `LAYOUT_APPLIERS` because a shorthand is not a
 * yoga property: it expands into three of them before the diff runs, so
 * `{ flex: 1, flexBasis: 'auto' }` resolves the way CSS does — the longhand
 * after the shorthand wins — and the applier for each still sees a plain
 * value changing.
 */
const FLEX_SHORTHAND = {
  none: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' },
  auto: { flexGrow: 1, flexShrink: 1, flexBasis: 'auto' },
};

const isFlexShorthand = (v) =>
  (typeof v === 'number' && Number.isFinite(v) && v >= 0) ||
  (typeof v === 'string' && v in FLEX_SHORTHAND);

const OVERFLOW = {
  visible: Yoga.OVERFLOW_VISIBLE,
  hidden: Yoga.OVERFLOW_HIDDEN,
  scroll: Yoga.OVERFLOW_SCROLL,
};

/**
 * CSS's `direction`. `'inherit'` is yoga's own default and the value every
 * node keeps having, so writing it is the same as leaving it out — it is
 * spelled anyway because "take it from the box around me" is a thing a style
 * has to be able to say back after saying `'rtl'`.
 */
const DIRECTION = {
  ltr: Yoga.DIRECTION_LTR,
  rtl: Yoga.DIRECTION_RTL,
  inherit: Yoga.DIRECTION_INHERIT,
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
  // Which way the boxes under this one run. Everything else in this file is
  // physical; this is the one property that decides what "start" means, and
  // yoga inherits it down its own tree — so a `<box>` that sets it mirrors
  // that subtree and nothing above it.
  direction: (n, v) =>
    n.setDirection(pick(DIRECTION, v, 'direction') ?? Yoga.DIRECTION_INHERIT),
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
  // The **logical** edges — the side the text starts on and the side it ends
  // on, whichever those turn out to be. A stylesheet written in these is the
  // same stylesheet in both directions, which is the whole reason `direction`
  // is worth having: a physical `paddingLeft` under `direction: 'rtl'` is a
  // gutter on the wrong side of the text it was meant to indent.
  //
  // Yoga's edge precedence is start/end over the physical side over
  // `EDGE_HORIZONTAL` over `EDGE_ALL` — so `paddingStart` beats `paddingLeft`
  // even in LTR where the two name the same edge, the way CSS's
  // `padding-inline-start` beats `padding-left`. Pinned in a test rather than
  // trusted, since it is the opposite of what the vertical shorthands do.
  start: (n, v) => n.setPosition(Yoga.EDGE_START, v),
  end: (n, v) => n.setPosition(Yoga.EDGE_END, v),
  marginStart: (n, v) => n.setMargin(Yoga.EDGE_START, v),
  marginEnd: (n, v) => n.setMargin(Yoga.EDGE_END, v),
  paddingStart: (n, v) => n.setPadding(Yoga.EDGE_START, v),
  paddingEnd: (n, v) => n.setPadding(Yoga.EDGE_END, v),
  gap: (n, v) => n.setGap(Yoga.GUTTER_ALL, v ?? 0),
  rowGap: (n, v) => n.setGap(Yoga.GUTTER_ROW, v ?? 0),
  columnGap: (n, v) => n.setGap(Yoga.GUTTER_COLUMN, v ?? 0),
  aspectRatio: (n, v) => n.setAspectRatio(v),
  display: (n, v) =>
    n.setDisplay(pick(DISPLAY, v, 'display') ?? Yoga.DISPLAY_FLEX),
  overflow: (n, v) =>
    n.setOverflow(pick(OVERFLOW, v, 'overflow') ?? Yoga.OVERFLOW_VISIBLE),
  borderWidth: (n, v) => n.setBorder(Yoga.EDGE_ALL, v ?? 0),
  // per-side widths resolve the way padding does: the side overrides the
  // shorthand, and yoga's own edge precedence (EDGE_TOP over EDGE_ALL) is
  // what implements the override
  borderTopWidth: (n, v) => n.setBorder(Yoga.EDGE_TOP, v),
  borderRightWidth: (n, v) => n.setBorder(Yoga.EDGE_RIGHT, v),
  borderBottomWidth: (n, v) => n.setBorder(Yoga.EDGE_BOTTOM, v),
  borderLeftWidth: (n, v) => n.setBorder(Yoga.EDGE_LEFT, v),
  borderStartWidth: (n, v) => n.setBorder(Yoga.EDGE_START, v),
  borderEndWidth: (n, v) => n.setBorder(Yoga.EDGE_END, v),
};

// Props that only affect painting, not geometry.
//
// `outline*` is here rather than beside `border*` in LAYOUT_APPLIERS for the
// reason CSS grew a second property at all: a focus ring must not move the
// thing it is drawn around. It is painted outside the border box and takes
// no part in yoga, so switching it on is a repaint of one node and nothing
// under it reflows.
const PAINT_PROPS = new Set([
  'backgroundColor',
  // The two decorations that are not a colour (issue #345, src/decorations.js).
  // Paint props like the rest of this set, which is what makes them legal in
  // a state block — a card that lifts on `:hover` is the case they exist for
  // — and what keeps them out of layout: a gradient is painted in the box the
  // layout already decided on, and a shadow is drawn outside it and moves
  // nothing.
  'backgroundImage',
  'boxShadow',
  'borderColor',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
  'borderStartColor',
  'borderEndColor',
  'borderRadius',
  'zIndex',
  'outlineWidth',
  'outlineColor',
  'outlineOffset',
]);

// Text style props. All affect measurement except color.
export const TEXT_LAYOUT_PROPS = new Set([
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  // a variable font's axes, `{ wght: 460 }` — the `wght` axis is already
  // driven by `fontWeight`, so this is for the rest. Compared by value, not
  // identity, since it is written as an object literal in a render
  'fontVariationSettings',
  'textAlign',
  'lineHeight',
  // read by TextNode rather than passed to ntk: it trims the box the layout
  // produced, it does not change the layout
  'textBoxTrim',
  // read by TextNode too, and it *is* the layout: `'nowrap'` measures at
  // unbounded width, so the text is one line and whatever contains it decides
  // what to do about the overflow
  'textWrap',
  // The truncation pair. Both are handed straight to ntk's TextLayout, which
  // does the careful version — the ellipsis in the cut run's own font, the
  // cut on a grapheme boundary with the tail re-shaped, and on the visually
  // last run rather than the logically last one. `textOverflow` changes what
  // fits on a line, so it is a measurement input like the rest of this set.
  'textOverflow',
  'maxLines',
]);

/**
 * Text style props that change how the text is **drawn** and provably not
 * where any of it lands. They still invalidate the cached layout — the value
 * rides on the spans inside it — but never the box, so changing one repaints
 * without reflowing.
 *
 * `textRendering` is CSS's, and picks the glyph path: `geometricPrecision`
 * puts glyph origins exactly where shaping asked, `optimizeSpeed` keeps them
 * on ntk's cached-bitmap path, `auto` lets size decide. Only rounding at
 * draw time differs — ntk's layout answers byte-identically for all three,
 * down to per-run offsets — which is what makes it safe to keep out of the
 * measurement set.
 */
export const TEXT_PAINT_PROPS = new Set(['textRendering']);

/**
 * The text properties that **inherit** — the ones a node hands down to
 * everything drawing text inside it, so `<box style={{ color: theme.textMuted }}>`
 * dims the labels under it the way it would in CSS.
 *
 * This is CSS's inherited set narrowed to what a *descendant* can act on: the
 * face, the size, the ink and the glyph rounding. `textAlign`, `lineHeight`,
 * `textWrap`, `textOverflow`, `maxLines` and `textBoxTrim` stay out even
 * though CSS inherits the first two — here they are read by the node that
 * owns the **box** the text flows in, and a box is not something a descendant
 * has. A `<box>` that wants its children aligned says so in the styles it
 * gives them.
 */
export const INHERITED_TEXT_PROPS = new Set([
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariationSettings',
  'textRendering',
  'color',
]);

/**
 * The text props that do **not** inherit — `TEXT_LAYOUT_PROPS` minus
 * `INHERITED_TEXT_PROPS`. They shape the box a node's own text flows in, so
 * no cascade can bring one in from above and the node that owns them is the
 * only one that has to react.
 */
export const LOCAL_TEXT_PROPS = new Set(
  [...TEXT_LAYOUT_PROPS].filter((key) => !INHERITED_TEXT_PROPS.has(key)),
);

/** Did anything that shapes this node's own text box change? */
export function localTextStyleChanged(style, before) {
  if (style === before) return false;
  for (const key of LOCAL_TEXT_PROPS) {
    if (style[key] !== before[key]) return true;
  }
  return false;
}

/** Did anything a descendant inherits change between two style bags? The
 * gate on re-resolving a subtree, so a commit that moved `padding` walks
 * nothing. */
export function inheritedTextChanged(style, before) {
  if (style === before) return false;
  for (const key of INHERITED_TEXT_PROPS) {
    if (key === 'fontVariationSettings') {
      if (!axesEqual(style[key], before[key])) return true;
    } else if (style[key] !== before[key]) return true;
  }
  return false;
}

/** What a change in resolved text style costs the node that draws with it:
 * a glyph may have moved. */
export const TEXT_REMEASURE = 2;
/** …or only the ink or the rounding did, so the box cannot have changed. */
export const TEXT_REPAINT = 1;

/**
 * Compare two **resolved** text styles (`textStyleFrom`'s shape, which is
 * ntk's) and price the difference.
 *
 * The split is what keeps a colour cascade off the layout path: `color` and
 * `textRendering` ride on the spans inside a cached layout, so the layout
 * still has to go — but neither moves a glyph, so nothing needs measuring
 * again. Conflating the two is why `:hover { color }` used to be able to
 * cost a full layout pass per pointer move.
 */
export function resolvedTextDelta(a, b) {
  if (a === b) return 0;
  if (
    a.family !== b.family ||
    a.size !== b.size ||
    a.weight !== b.weight ||
    a.style !== b.style ||
    !axesEqual(a.variations, b.variations)
  ) {
    return TEXT_REMEASURE;
  }
  if (a.color !== b.color || a.textRendering !== b.textRendering) {
    return TEXT_REPAINT;
  }
  return 0;
}

/**
 * Every text layout prop is a scalar and compares by value, except the one
 * that is a bag of axis coordinates. `fontVariationSettings` is written as
 * an object literal in a render, so a fresh one arrives on every commit and
 * `!==` would call it a change every time — re-shaping the paragraph and
 * re-rasterizing its glyphs to arrive at the same pixels. Small and flat, so
 * comparing it is cheaper than believing it.
 */
export function axesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export const isLayoutProp = (name) =>
  Object.prototype.hasOwnProperty.call(LAYOUT_APPLIERS, name);
export const isPaintProp = (name) => PAINT_PROPS.has(name);
export const isEventProp = (name) => /^on[A-Z]/.test(name);

/**
 * State blocks, lowest precedence first. These are *node* states, not
 * selectors: each one is something the node itself knows about, so
 * resolving them needs no specificity and no matching. Anything relational
 * — `:hover > child`, a sibling selector, `:nth-child` — stays in React,
 * where composition already answers it.
 *
 * The two that read as relational are not. `:hover` and `:active` mark the
 * whole ancestor chain because the node the pointer actually landed on is
 * whatever the control happens to be built out of, and `:focus-within` is
 * the same fact about the focus path — each of them is still "something
 * true of this node", diffed over a path the event manager has already
 * computed. What a child does about an ancestor's state is inheritance
 * rather than a selector: a `:hover` block that sets `color` reaches the
 * labels inside, the way it does in CSS.
 */
export const STATE_KEYS = [
  ':hover',
  // Focus is on this node or inside it — CSS's `:focus-within`. Below
  // `:focus` on purpose: it is the broader fact, so a node that is itself
  // focused should be able to say something narrower and win.
  ':focus-within',
  ':focus',
  // Focus that came from the keyboard rather than from a press — CSS's
  // `:focus-visible`, and for the same reason: a ring on every click is
  // noise, a ring on Tab is the only way a keyboard user can tell where
  // they are. `focus()` decides which it was; see EventManager.
  ':focus-visible',
  ':active',
  ':disabled',
  ':drag-over',
  ':dragging',
];

// What a state block may change. Deliberately paint-only: a state block that
// could set `padding` or `fontSize` would reflow the tree on pointer move,
// which is both a jitter bug and the end of the "hover is a repaint, not a
// React render" property that makes this worth having at all.
const STATE_PROPS = new Set([...PAINT_PROPS, 'color']);

const STYLE_PROPS = new Set([
  ...Object.keys(LAYOUT_APPLIERS),
  // the one layout property that is not a yoga property: a shorthand for
  // three of them, expanded by `resolveComputedStyle`
  'flex',
  ...PAINT_PROPS,
  ...TEXT_LAYOUT_PROPS,
  ...TEXT_PAINT_PROPS,
  'color',
  'borderStyle',
  'transition',
  // CSS concepts even though they read as behaviour; React Native has been
  // moving pointerEvents into style for the same reason
  'cursor',
  'pointerEvents',
  // How far outside the box the pointer still counts as hitting it. Neither
  // layout nor paint — the one thing it must never do is grow the visuals,
  // since the whole point is a 24px target under a 16px control.
  'hitSlop',
]);

export const isStyleProp = (name) => STYLE_PROPS.has(name);

/** Every style property, by name. DevTools' style editor takes this list as
 * `nativeStyleEditorValidAttributes` — what it offers to add to an element
 * — so it is the same set `isStyleProp` answers for rather than a second
 * list that could drift from it. */
export const STYLE_PROP_NAMES = Object.freeze([...STYLE_PROPS].sort());

const isState = (key) => key.charCodeAt(0) === 58; /* ':' */

/**
 * Window size queries: `'@width >= 600'`. The X11 analogue of `@media` —
 * what a style can usefully ask about here is the window it is being laid
 * out in, not the screen.
 *
 * Unlike a state block, a size query *may* set layout properties. That is
 * not an inconsistency: pointer state changes must never reflow the tree,
 * but a size query is only ever re-evaluated during a layout pass that a
 * resize has already triggered, so it costs nothing extra.
 */
const SIZE_QUERY = /^@(width|height)\s*(>=|<=|>|<)\s*(\d+(?:\.\d+)?)$/;

/**
 * Capability queries: `'@supports transparency'`. Where a size query asks
 * about the window, this asks about the *server* — what will actually be
 * shown if the style asks for it.
 *
 * `transparency` is true only when the window really has an alpha channel
 * (it was created on a 32-bit visual) *and* a compositor is running to
 * blend it. Either half missing and a transparent corner is a black corner,
 * so the honest answer is no. It is per window, not per display: a plain
 * `<window>` never composites anything, so the same component nested in one
 * gets the opaque design without being told twice.
 */
const SUPPORTS_QUERY = /^@supports\s+(transparency)$/;
const SUPPORTS_FEATURES = ['transparency'];
const isQuery = (key) => key.charCodeAt(0) === 64; /* '@' */

const parsedQueries = new Map();
function parseQuery(key) {
  let q = parsedQueries.get(key);
  if (q === undefined) {
    const size = SIZE_QUERY.exec(key);
    const supports = size ? null : SUPPORTS_QUERY.exec(key);
    q = size
      ? { kind: 'size', axis: size[1], op: size[2], value: Number(size[3]) }
      : supports
        ? { kind: 'supports', feature: supports[1] }
        : null;
    parsedQueries.set(key, q);
  }
  return q;
}

function sizeMatches(q, size) {
  const v = size?.[q.axis];
  if (v == null) return false;
  return q.op === '>='
    ? v >= q.value
    : q.op === '<='
      ? v <= q.value
      : q.op === '>'
        ? v > q.value
        : v < q.value;
}

const hasQueryOfKind = (style, kind) => {
  for (const key of Object.keys(style)) {
    if (isQuery(key) && parseQuery(key)?.kind === kind) return true;
  }
  return false;
};

/** Re-resolved when the window is laid out at a new size. */
export const styleHasSizeQueries = (style) => hasQueryOfKind(style, 'size');

/** Re-resolved when the server's answer changes — a compositor starting or
 *  stopping — rather than on every layout. The two registries are kept
 *  apart because the triggers are: a resize must not walk every node that
 *  only ever asked about transparency. */
export const styleHasSupportsQueries = (style) =>
  hasQueryOfKind(style, 'supports');

/**
 * Merge the query blocks that match, in declaration order, over the base.
 * Size and capability blocks resolve in one pass so that ordering between
 * them is the order they were written in. Returns the style itself when
 * nothing matches, so the identity fast path survives the common case.
 *
 * `supports` is the map of capability answers, or null while they are still
 * unknown — in which case a capability block does not apply, which is the
 * safe way round: the fallback design is the one that works everywhere.
 */
/**
 * `resolveQueries` with only the size half, the shape this had before
 * capability blocks existed. Kept because `react-x11/style` is a public
 * entry and a registered element outside the package may be calling it.
 */
export function resolveSizeQueries(style, size) {
  return size ? resolveQueries(style, { size }) : style;
}

export function resolveQueries(style, { size = null, supports = null } = {}) {
  let out = style;
  for (const key of Object.keys(style)) {
    if (!isQuery(key)) continue;
    const q = parseQuery(key);
    if (!q) continue;
    const hit =
      q.kind === 'size'
        ? size && sizeMatches(q, size)
        : Boolean(supports?.[q.feature]);
    if (!hit) continue;
    if (out === style) out = { ...style };
    Object.assign(out, style[key]);
  }
  return out;
}

/**
 * The two style values that are a small language rather than a number, and
 * therefore the two that can be *wrong* rather than merely absent. Parsed in
 * development wherever they are written — including inside a state block,
 * which is the half of the surface a `continue` used to skip — so the error
 * naming the property and the expected spelling arrives at the call site
 * instead of as a blank panel three commits later.
 *
 * Tokens are still unresolved here (`$accent` is a colour as far as the
 * grammar is concerned), so this checks the shape and never the colours.
 */
function validateValue(key, value, where) {
  if (key !== 'backgroundImage' && key !== 'boxShadow') return;
  try {
    if (key === 'backgroundImage') parseLinearGradient(value);
    else parseBoxShadow(value);
  } catch (err) {
    // the parser names the property and the grammar; only the call site is
    // missing, and it is what turns the message into a place to look
    err.message += `\n  in ${where}`;
    throw err;
  }
}

function validateStyle(style, where) {
  for (const key of Object.keys(style)) {
    if (isQuery(key)) {
      if (!parseQuery(key)) {
        throw new Error(
          `react-x11: bad query "${key}" in ${where} (expected a size query ` +
            'like "@width >= 600", or a capability query like ' +
            `"@supports ${SUPPORTS_FEATURES.join('" / "@supports ')}")`,
        );
      }
      validateStyle(style[key] ?? {}, `${where} ${key}`);
      continue;
    }
    if (isState(key)) {
      if (!STATE_KEYS.includes(key)) {
        throw new Error(
          `react-x11: unknown style state "${key}" in ${where} ` +
            `(expected one of ${STATE_KEYS.join(', ')})`,
        );
      }
      for (const inner of Object.keys(style[key] ?? {})) {
        if (STATE_PROPS.has(inner)) {
          validateValue(inner, style[key][inner], `${where} ${key}`);
          continue;
        }
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
    validateValue(key, style[key], where);
    if (key === 'flex' && !isFlexShorthand(style[key])) {
      throw new Error(
        `react-x11: invalid flex ${JSON.stringify(style[key])} in ${where} ` +
          '(expected a number — flex: 1 is flexGrow: 1, flexShrink: 1, ' +
          "flexBasis: 0 — or 'auto' / 'none')",
      );
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
  // Both are strings that describe several numbers and a colour at once, and
  // `interpolate` works on one value. They snap, which for a state change is
  // what the shorter durations look like anyway; a card that wants to *rise*
  // on hover transitions its `borderColor` or its background beside them.
  'backgroundImage',
  'boxShadow',
  'zIndex',
  'direction',
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
  // nothing is drawn from it, so there is no frame in which a halfway value
  // would be visible — and it may be an object, which does not lerp
  'hitSlop',
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
 *
 * The colours are parsed **straight**, not premultiplied. The result is
 * formatted back into an `rgba()` string, and that round trip only closes on
 * unassociated components: premultiplied ones get scaled by alpha a second
 * time when the paint path parses the string again, so a midpoint of a
 * translucent colour would come out darker than either end.
 */
export function interpolate(from, to, t) {
  if (typeof from === 'number' && typeof to === 'number') {
    return from + (to - from) * t;
  }
  if (typeof from === 'string' && typeof to === 'string') {
    const a = cssColorStraight(from);
    const b = cssColorStraight(to);
    if (!a || !b) return null;
    // Interpolate *premultiplied*, then divide the alpha back out, which is
    // what CSS does and for the same reason. `transparent` is black at zero
    // alpha, so lerping straight channels drags the colour towards black on
    // the way: half way from `transparent` to a near-white hover fill lands on
    // mid grey — 0.736 against 0.973 — and the curve is not even monotonic,
    // it darkens and then lightens again. That is the rectangle that flashes
    // when hover crosses two adjacent tabs, one fading out as the other fades
    // in, both passing through grey together.
    const alpha = a[3] + (b[3] - a[3]) * t;
    if (alpha <= 0) return 'rgba(0, 0, 0, 0)';
    const channel = (i) => {
      const from0 = a[i] * a[3];
      return (from0 + (b[i] * b[3] - from0) * t) / alpha;
    };
    return rgba([channel(0), channel(1), channel(2), alpha]);
  }
  return null;
}

/**
 * One more step in the direction `from` → `to`, clamped to the gamut.
 *
 * This is how a palette that named a hover and stopped there still gets a
 * pressed colour (`theme.js`): the press is the hover step taken twice. It
 * reads the *direction* rather than assuming one, so it darkens a light
 * theme and lightens a dark one without being told which it is — which is
 * the whole reason it is not a `darken(colour, 0.1)`.
 *
 * Straight components, like `interpolate`, and for the same round-trip
 * reason. Clamping is what extrapolation needs and interpolation does not:
 * two steps out of a near-white hover leaves the cube.
 */
export function stepBeyond(from, to) {
  const a = cssColorStraight(from);
  const b = cssColorStraight(to);
  if (!a || !b) return to;
  const step = (i) => Math.min(1, Math.max(0, b[i] + (b[i] - a[i])));
  return rgba([step(0), step(1), step(2), step(3)]);
}

/**
 * WCAG relative luminance — the perceptual lightness contrast is measured
 * in, which is not the mean of the channels: green carries most of it and
 * blue almost none, so `#0000ff` and `#00ff00` are worlds apart here and
 * three pixels apart in a channel average.
 */
function luminance(c) {
  const linear = (v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
}

/**
 * Which of `inks` can be read on `fill` — the one with the most contrast,
 * WCAG's ratio.
 *
 * This is what keeps a palette from having to name the ink on every fill it
 * names. The two candidates a palette always has are its own `text` and its
 * own `background`, and one of them is readable on any fill by construction:
 * a fill light enough to swallow the light one is dark enough to show the
 * dark one. So `resolveTheme` derives `accentText` and the status inks from
 * the family colour, and a theme that names a yellow warning gets dark
 * letters on it without having thought about it.
 *
 * Ratio rather than a lightness threshold because a threshold is exactly the
 * thing that fails on the mid-tones: an accent at L*55 is on whichever side
 * of 50% the theme's own ink is not, and only a comparison knows which.
 *
 * Returns the first ink where a colour will not parse, which is the same
 * "keep going with what you were given" the rest of this file does.
 */
export function readableInk(fill, inks) {
  const bg = cssColorStraight(fill);
  if (!bg) return inks[0];
  const lb = luminance(bg);
  let best = inks[0];
  let bestRatio = -1;
  for (const ink of inks) {
    const c = cssColorStraight(ink);
    if (!c) continue;
    const li = luminance(c);
    const ratio = (Math.max(lb, li) + 0.05) / (Math.min(lb, li) + 0.05);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = ink;
    }
  }
  return best;
}

/**
 * A colour at a given opacity — `tint('#2980b9', 0.3)`.
 *
 * For fills that are drawn *under* text whose colour they do not control: a
 * selection highlight is the case, and an opaque one has to be chosen to
 * contrast with the ink on top of it, which cannot be done once for both a
 * light and a dark palette. A translucent one is chosen against the surface
 * instead, and the ink keeps whatever contrast it already had.
 */
export function tint(color, alpha) {
  const c = cssColorStraight(color);
  if (!c) return color;
  return rgba([c[0], c[1], c[2], c[3] * alpha]);
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
 *
 * A token also resolves **inside** a value that is a small language of its
 * own — `linear-gradient($accent, $accentActive)`, `boxShadow: '0 2px 8px
 * $shadow'`. Those two are the whole reason: the point of the palette is
 * that a colour is named once, and a decoration that could not name one
 * would push every gradient in an app back into `useTheme()` and out of a
 * hoisted style. It is the same substitution either way, so the value that
 * *is* a token keeps its fast path and the value that *mentions* one goes
 * through the regexp.
 */
const isToken = (v) => typeof v === 'string' && v.charCodeAt(0) === 36; /* $ */
/** `$name`, anywhere in a string. Deliberately the same grammar as a whole
 * token, so `'$accent'` and `'linear-gradient($accent, #000)'` cannot
 * disagree about what a name is. */
const TOKEN_IN_VALUE = /\$[A-Za-z_][A-Za-z0-9_-]*/g;
const mentionsToken = (v) =>
  typeof v === 'string' && v.charCodeAt(0) !== 36 && v.includes('$');

export function styleUsesTokens(style) {
  for (const key of Object.keys(style)) {
    const v = style[key];
    if (isToken(v) || mentionsToken(v)) return true;
    if (key.charCodeAt(0) === 58 && v && styleUsesTokens(v)) return true;
  }
  return false;
}

/** Every `$name` a style mentions. Not used internally any more — a token
 * that does not resolve now throws, naming itself — but it is part of the
 * style surface `src/style.js` publishes for tooling. */
export function tokenNames(style, out = new Set()) {
  for (const key of Object.keys(style)) {
    const v = style[key];
    if (isToken(v)) out.add(v);
    else if (mentionsToken(v))
      for (const m of v.match(TOKEN_IN_VALUE) ?? []) out.add(m);
    else if (key.charCodeAt(0) === 58 && v) tokenNames(v, out);
  }
  return out;
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
    // a value that *mentions* a token goes too, and whole: half a gradient
    // is not a gradient, and the node restyles on attach either way
    if (isToken(v) || mentionsToken(v)) continue;
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
    } else if (mentionsToken(v)) {
      let unknown = null;
      const substituted = v.replace(TOKEN_IN_VALUE, (token) => {
        const name = token.slice(1);
        if (name in theme) return theme[name];
        unknown ??= token;
        return token;
      });
      // Same rule as a whole-value token, one level down: unknown is a
      // mistake once the ancestry is complete, and provisional before that —
      // and a half-substituted gradient is dropped rather than painted,
      // since `$accent` is not a colour and the parse would fail at the
      // frame instead of at the style.
      if (!unknown) out[key] = substituted;
      else if (strict) {
        throw new Error(
          `react-x11: unknown theme token "${unknown}" in ${where} ${key} ` +
            `(theme has ${Object.keys(theme).join(', ') || 'nothing'})`,
        );
      }
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
 * The style the layout is actually run from: the `flex` shorthand expanded,
 * and the defaults `overflow: 'scroll'` implies folded in. Both are things a
 * style *means* rather than things it says, and doing them here — once, on
 * the resolved object — is what lets everything downstream stay a flat diff
 * of yoga properties.
 *
 * Returns `style` itself when there is nothing to add, so identity comparisons
 * upstream keep meaning "the style did not change".
 *
 * The scroll-container half, property by property:
 *
 * - **`min-width/height: 0`** is the spec's own rule, not an invention: CSS
 *   computes `min-*: auto` to `0` on a flex item whose overflow is not
 *   `visible`. It is the one place the automatic minimum size (`Node`'s
 *   content floors) does not apply, and the reason a viewport can be smaller
 *   than what is inside it — which is what scrolling is.
 * - **`flexBasis: 0`** — what CSS's `flex: 1` means — only when the author
 *   asked it to grow and gave it no size of its own. A flex item's base size
 *   is its content, and a window whose scrolling pane holds more rows than
 *   fit grew *past* the window, pushing the footer out of view however small
 *   the window got. Zeroing the basis fixes the whole ancestor chain at once,
 *   since the content stops counting towards any of their heights.
 */
export function resolveComputedStyle(style) {
  const scrolls = style.overflow === 'scroll';
  if (style.flex === undefined && !scrolls) return style;
  const out = {};
  if (style.flex !== undefined) {
    const expansion =
      typeof style.flex === 'number'
        ? { flexGrow: style.flex, flexShrink: 1, flexBasis: 0 }
        : FLEX_SHORTHAND[style.flex];
    if (!expansion) {
      throw new Error(
        `react-x11: invalid flex ${JSON.stringify(style.flex)} ` +
          "(expected a number, 'auto' or 'none')",
      );
    }
    Object.assign(out, expansion);
  }
  // after the expansion, so a longhand written beside the shorthand wins
  for (const key of Object.keys(style)) {
    if (key !== 'flex') out[key] = style[key];
  }
  if (scrolls) {
    if (out.minWidth === undefined) out.minWidth = 0;
    if (out.minHeight === undefined) out.minHeight = 0;
    if (
      out.flexBasis === undefined &&
      out.width === undefined &&
      out.height === undefined &&
      (out.flexGrow ?? 0) > 0
    ) {
      out.flexBasis = 0;
    }
  }
  return out;
}

/**
 * The renderer's own yoga config — one for the process, shared by every node
 * — which exists so that a **measurement** can be taken off the pixel grid.
 *
 * Yoga rounds a finished layout to whole pixels, and does it on absolute
 * positions, so a box 36.4 tall reads back as 36 or 37 depending on where it
 * landed. Summing those with exact paddings is how a min-content measurement
 * of 36.4 comes out as 37 — and a floor of 37 does not hold a box at the size
 * it already was, it *grows* it, one pixel per nesting level, all the way up
 * the tree. Measuring with the grid switched off is what keeps a floor a
 * promise not to shrink rather than an instruction to grow.
 *
 * The final layout — the one that decides where anything is actually drawn —
 * always runs rounded, which is what keeps a border on a whole pixel.
 */
let config = null;
const layoutConfig = () => (config ??= Yoga.Config.create());

/** A yoga node in the renderer's config. */
export const createLayoutNode = () => Yoga.Node.create(layoutConfig());

/**
 * Run `measure` with the pixel grid switched off, and put it back however
 * that goes: a throw here would otherwise leave every later layout in the
 * process unrounded, which is a class of blurry-by-a-half-pixel bug nothing
 * would connect back to this.
 */
export function measuringExactly(measure) {
  const cfg = layoutConfig();
  cfg.setPointScaleFactor(0);
  try {
    return measure();
  } finally {
    cfg.setPointScaleFactor(1);
  }
}

/**
 * The yoga defaults that are not CSS's, written once per node.
 *
 * `applyLayoutStyle` only calls a setter for a property that **changed**, so
 * a style that never mentions `flexShrink` never reaches the `?? 1` in its
 * applier and yoga's own `0` would stand. A default that only exists in the
 * reset path is not a default; this is where it actually happens.
 *
 * The pair to it is the automatic minimum size — a flex item that may shrink
 * still cannot shrink below its content unless it says so. Yoga has no such
 * rule, so the renderer measures the floors itself; see `Node`'s content
 * floors in nodes.js.
 */
export function applyLayoutDefaults(yogaNode) {
  yogaNode.setFlexShrink(1);
}

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
  // `color` and `borderStyle` paint but are deliberately not in PAINT_PROPS:
  // that set also decides what a state block is allowed to set, and widening
  // it would change validation rather than just this comparison
  return (
    props.color !== oldProps.color || props.borderStyle !== oldProps.borderStyle
  );
}

/** Resolved text style (TextLayout base style) from props + inherited. */
export function textStyleFrom(props, inherited) {
  return {
    family: props.fontFamily ?? inherited.family,
    size: props.fontSize ?? inherited.size,
    weight: props.fontWeight ?? inherited.weight,
    style: props.fontStyle ?? inherited.style,
    // ntk's name for it is `variations`; the prop is spelled after the CSS
    // property, like every other name in this vocabulary
    variations: props.fontVariationSettings ?? inherited.variations,
    textRendering: props.textRendering ?? inherited.textRendering,
    color: props.color ?? inherited.color,
  };
}

/**
 * The floor under `Node.inheritedTextStyle`, which is what text actually
 * reads: the ink, the face and the size all come from the palette in force,
 * and these are only what is left when there is no palette at all — a node
 * that has not been attached yet, or a bare `theme` prop naming neither.
 *
 * `family`, `size` and `color` therefore mirror `DefaultTheme.fontFamily`,
 * `.fontSize` and `.text`; the rest have no token because no theme has ever
 * wanted to set the weight of every label in an app at once.
 */
export const DEFAULT_TEXT_STYLE = {
  family: 'sans-serif',
  size: 14,
  weight: 'normal',
  style: 'normal',
  variations: undefined,
  textRendering: undefined,
  color: 'black',
};

/**
 * The focus ring a focusable node draws when nothing asked it to.
 *
 * WCAG 2.4.7 is not something an application should have to opt into, and
 * the vocabulary alone would not have delivered it: `outlineWidth` in a
 * `:focus-visible` block is a thing every widget author would then have to
 * remember, on every focusable, forever. So this is the default and
 * `outlineWidth: 0` is the opt-out. A theme overrides the three values with
 * `focusRing`, `focusRingWidth` and `focusRingOffset`.
 *
 * The offset is what keeps it legible against a control whose own border is
 * already coloured — the ring is outside the box with a gap, not a second
 * border on it.
 */
export const DEFAULT_FOCUS_RING = {
  color: '#2980b9',
  width: 2,
  offset: 1,
};

/**
 * Per-side hit slop from `hitSlop: 4` or `hitSlop: { top: 4, bottom: 4 }`,
 * or null when there is none. Sides left out are 0, so the object form only
 * has to name what it grows.
 */
/**
 * Which physical side each logical edge lands on. The one function that knows
 * what `start` means, so a widget or a paint path never has to spell the
 * conditional out again.
 */
export const physicalSides = (direction) =>
  direction === 'rtl'
    ? { start: 'right', end: 'left' }
    : { start: 'left', end: 'right' };

/**
 * Per-side border widths, resolved the way padding resolves: the side
 * property overrides the `borderWidth` shorthand, and a **logical** side
 * overrides the physical one — `borderStartWidth` beats `borderLeftWidth` in
 * LTR, the way `border-inline-start-width` beats `border-left-width` in CSS.
 * This is the paint-side reading of the rule yoga applies on the layout side
 * (EDGE_START over EDGE_LEFT over EDGE_ALL), kept in one place so the two
 * cannot disagree — a border that lays out one width and paints another is a
 * gap along the edge of the box.
 *
 * `direction` is the resolved direction of the node being painted, so this is
 * also where a `borderStartWidth` crosses to the other side of the box.
 */
export function resolveBorderWidths(style, direction) {
  const all = style.borderWidth ?? 0;
  const { start, end } = physicalSides(direction);
  const sides = {
    top: style.borderTopWidth ?? all,
    right: style.borderRightWidth ?? all,
    bottom: style.borderBottomWidth ?? all,
    left: style.borderLeftWidth ?? all,
  };
  if (style.borderStartWidth !== undefined)
    sides[start] = style.borderStartWidth;
  if (style.borderEndWidth !== undefined) sides[end] = style.borderEndWidth;
  return sides;
}

/** …and the same rule for the colours those widths are stroked in. */
export function resolveBorderColors(style, direction) {
  const all = style.borderColor;
  const { start, end } = physicalSides(direction);
  const sides = {
    top: style.borderTopColor ?? all,
    right: style.borderRightColor ?? all,
    bottom: style.borderBottomColor ?? all,
    left: style.borderLeftColor ?? all,
  };
  if (style.borderStartColor !== undefined)
    sides[start] = style.borderStartColor;
  if (style.borderEndColor !== undefined) sides[end] = style.borderEndColor;
  return sides;
}

export function resolveHitSlop(value) {
  if (value == null) return null;
  if (typeof value === 'number') {
    if (!(value > 0)) return null;
    return { top: value, right: value, bottom: value, left: value };
  }
  const slop = {
    top: value.top ?? 0,
    right: value.right ?? 0,
    bottom: value.bottom ?? 0,
    left: value.left ?? 0,
  };
  return slop.top || slop.right || slop.bottom || slop.left ? slop : null;
}
