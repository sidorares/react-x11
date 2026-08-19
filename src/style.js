// `react-x11/style` — the style vocabulary, for code that has to speak it
// from outside the package: a registered element deciding whether a prop
// name is style (`isStyleProp`), resolving `$token` references against a
// theme, or flattening the same array/object `style` prop shape the
// built-ins take.
export {
  createStyles,
  flattenStyle,
  isStyleProp,
  isLayoutProp,
  isPaintProp,
  isAnimatableProp,
  resolveStyleStates,
  hasStateStyles,
  styleUsesTokens,
  tokenNames,
  resolveTokens,
  styleHasSizeQueries,
  styleHasSupportsQueries,
  resolveSizeQueries,
  resolveQueries,
  interpolate,
  tint,
  readableInk,
  transitionFor,
  animationsOf,
  sameAnimation,
  animationValueAt,
  ease,
  EASING_NAMES,
  EMPTY_STYLE,
  STATE_KEYS,
} from './styles.js';
