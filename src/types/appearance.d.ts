/**
 * What the desktop looks like — light or dark, the accent colour, contrast
 * and reduced motion. See docs/appearance.md.
 */

import type { Theme } from './components.js';
import type { NtkApp } from './nodes.js';

/**
 * `'no-preference'` is the desktop declining to say, which per the portal
 * spec means **use your own default** — not "use light".
 */
export type ColorScheme = 'light' | 'dark' | 'no-preference';

/** How the app should be pinned, or `'system'` to follow the desktop. */
export type ColorSchemePreference = 'system' | 'light' | 'dark';

/**
 * Which rung of the ladder answered, or null if nothing has yet.
 *
 * `'cache'` is the answer this machine gave last time, read off disk before
 * the first render so it does not start from the defaults. A real rung
 * replaces it a moment later.
 */
export type AppearanceSource =
  'portal' | 'xsettings' | 'macos' | 'cache' | null;

export interface SystemAppearance {
  readonly colorScheme: ColorScheme;
  /**
   * `'#ed5b00'`, or **null** — most portal backends do not implement the
   * accent colour, and XSETTINGS has no key for one at all. Fall back to your
   * own brand colour rather than to grey.
   */
  readonly accent: string | null;
  /**
   * The ink the desktop writes on its accent — `'#ffffff'` on macOS, whatever
   * the accent — or **null** where the source names a fill and nothing about
   * what goes on it (the portal). The built-in palette uses it as
   * `accentText`, and picks the legible ink by contrast where it is null.
   */
  readonly accentText: string | null;
  /**
   * The fill the desktop puts under a selected menu or list row — on macOS
   * `selectedContentBackgroundColor`, a darker cut of the accent — or
   * **null** where nothing names one. The built-in palette uses it as
   * `hoverBackground`, and the accent itself where it is null.
   */
  readonly selection: string | null;
  /**
   * The desktop's whole palette as react-x11 tokens, where the desktop can
   * name one: on macOS the semantic colours AppKit paints its own windows
   * and controls with, flattened over the window ground. The built-in
   * palette merges it over the scheme's own, so an app that says nothing
   * about colour comes up in the desktop's greys, inks and status colours.
   * Null from the portal and XSETTINGS, which name no such thing.
   */
  readonly palette: Readonly<Partial<Theme>> | null;
  readonly contrast: 'normal' | 'high';
  readonly reducedMotion: boolean;
  /**
   * Null distinguishes "nothing has answered yet" from a desktop that
   * answered `'no-preference'`, and `'cache'` marks the remembered answer the
   * first render starts from.
   */
  readonly source: AppearanceSource;
}

export interface SystemAppearanceOptions {
  /**
   * The ntk connection, so the XSETTINGS rung can run. Without one that rung
   * is skipped and only the portal and macOS are consulted — which is what a
   * call made before `createRoot()` resolves gets.
   */
  app?: NtkApp;
}

/**
 * The desktop's appearance, resolved. Never rejects: a machine with no
 * portal, no settings daemon and no Mac answers `'no-preference'` with a null
 * `source`.
 *
 * The imperative twin of `useSystemAppearance()`, and a **verified** answer
 * rather than the remembered one the first render starts from:
 *
 * ```ts
 * const [root] = await Promise.all([createRoot(), systemAppearance()]);
 * ```
 *
 * Most apps do not need this: the snapshot is seeded from the last run before
 * anything renders. It is for the first launch on a machine, and for anything
 * that must be exact rather than probably right.
 */
export function systemAppearance(
  options?: SystemAppearanceOptions,
): Promise<SystemAppearance>;

/**
 * What the desktop looks like, live — re-renders when the user changes it.
 *
 * ```tsx
 * const { colorScheme, accent, reducedMotion } = useSystemAppearance();
 * ```
 *
 * For the common case — an app that just wants to follow the desktop — reach
 * for `<ThemeProvider value={light} dark={dark}>` instead.
 */
export function useSystemAppearance(): SystemAppearance;
