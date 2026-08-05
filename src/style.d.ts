/**
 * `react-x11/style` — the style vocabulary, for code outside the package
 * that has to speak it: a registered element asking whether a prop name is
 * style, resolving `$token` references against a theme, or flattening the
 * array/object `style` shape the built-ins accept.
 */
import type { Style, StyleProperties } from './types/style.js';

export type { Style, StyleProperties };

/** Freeze a stylesheet object, the `StyleSheet.create` of this renderer. */
export function createStyles<T extends Record<string, Style>>(sheet: T): T;

/** Collapse an array/nested `style` prop into one object. */
export function flattenStyle(
  style: Style | Style[] | null | undefined,
): StyleProperties;

/** Is this prop name part of the style vocabulary? The question a
 * registered element asks before treating a prop as its own semantics. */
export function isStyleProp(name: string): boolean;
export function isLayoutProp(name: string): boolean;
export function isPaintProp(name: string): boolean;
export function isAnimatableProp(name: string): boolean;

/** Overlay the `:hover` / `:focus` / `:active` / `:disabled` blocks that
 * the given states select. */
export function resolveStyleStates(
  style: StyleProperties,
  states: Record<string, boolean>,
): StyleProperties;
export function hasStateStyles(style: StyleProperties): boolean;

/** Does this style reference any `$token`? */
export function styleUsesTokens(style: StyleProperties): boolean;
export function tokenNames(
  style: StyleProperties,
  out?: Set<string>,
): Set<string>;
/** Replace `$token` references with values from the theme. */
export function resolveTokens(
  style: StyleProperties,
  theme: Record<string, unknown> | null | undefined,
  where?: string,
  strict?: boolean,
): StyleProperties;

export function styleHasSizeQueries(style: StyleProperties): boolean;
/** Does the style carry a `'@supports …'` block? Those are re-resolved when
 *  the server's answer changes, not when the window is laid out. */
export function styleHasSupportsQueries(style: StyleProperties): boolean;
/** `resolveQueries` with only the size half — the shape this had before
 *  capability blocks existed. */
export function resolveSizeQueries(
  style: StyleProperties,
  size: { width: number; height: number },
): StyleProperties;
/** Merge every matching `@` block — size and capability alike — in
 *  declaration order. `supports` maps feature name to whether the window can
 *  actually do it; a missing map matches nothing, which is the safe way
 *  round. */
export function resolveQueries(
  style: StyleProperties,
  context?: {
    size?: { width: number; height: number } | null;
    supports?: Record<string, boolean> | null;
  },
): StyleProperties;

export function interpolate(from: unknown, to: unknown, t: number): unknown;
export function transitionFor(
  style: StyleProperties,
  prop: string,
): { duration: number; delay?: number } | null;
export function ease(t: number): number;

export const EMPTY_STYLE: Readonly<StyleProperties>;
export const STATE_KEYS: readonly string[];
