/**
 * `react-x11/style` — the style vocabulary, for code outside the package
 * that has to speak it: a registered element asking whether a prop name is
 * style, resolving `$token` references against a theme, or flattening the
 * array/object `style` shape the built-ins accept.
 */
import type {
  Animation,
  AnimationSpec,
  Easing,
  Style,
  StyleProperties,
} from './types/style.js';

export type { Animation, AnimationSpec, Easing, Style, StyleProperties };

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
/**
 * A colour at a given opacity — the way to build a status *panel* out of a
 * status colour: `tint(theme.danger, 0.12)` is a wash of it that the ink on
 * top keeps its own contrast against, where an opaque tint would have to
 * have been chosen against an ink it does not own.
 */
export function tint(color: string, alpha: number): string;
/**
 * Which of `inks` can be read on `fill` — the highest WCAG contrast ratio.
 * The palette derives `accentText` and the status inks with this; an app
 * choosing ink for a fill of its own can use the same rule.
 */
export function readableInk(fill: string, inks: string[]): string;
export function transitionFor(
  style: StyleProperties,
  prop: string,
): { duration: number; delay?: number } | null;
export function ease(t: number): number;

/** A resolved loop declaration: `from` filled in from the style, both ends
 *  checked for a midpoint, the easing looked up. */
export interface ResolvedAnimation extends Required<
  Omit<AnimationSpec, 'easing' | 'alternate'>
> {
  prop: keyof StyleProperties;
  easing: Easing;
  alternate: boolean;
  ease(t: number): number;
}
/** The loops a style declares, or null. Throws on a declaration that could
 *  never run — see `style.animation` in docs/styling.md. */
export function animationsOf(
  style: StyleProperties,
  where?: string,
): ResolvedAnimation[] | null;
/** Whether two resolved loops describe the same motion — what decides
 *  between keeping a running loop's phase and starting it over. */
export function sameAnimation(
  a: ResolvedAnimation,
  b: ResolvedAnimation,
): boolean;
/** Where a loop is `elapsed` ms after it started. */
export function animationValueAt(
  spec: ResolvedAnimation,
  elapsed: number,
): unknown;
export const EASING_NAMES: readonly Easing[];

export const EMPTY_STYLE: Readonly<StyleProperties>;
export const STATE_KEYS: readonly string[];
