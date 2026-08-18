/**
 * Font files an application opens for itself — reading one, and registering
 * one so `fontFamily` can name it. See docs/styling.md#a-font-file-of-your-own.
 */

import type { NtkApp } from './nodes.js';

/**
 * ntk's `Font`, as much of it as is worth declaring by hand.
 *
 * Deliberately loose, for the same reason `react-x11/ntk` is: ntk ships no
 * types, and a full mirror written here would drift out of date silently.
 * The members below are the ones an application reads; everything else the
 * class has is still there at runtime.
 */
export interface Font {
  /** The family the file calls itself — not necessarily what it is
   *  registered as; see {@link loadFont}. */
  readonly familyName: string;
  readonly postscriptName: string;
  readonly unitsPerEm: number;
  /** Stable cache key — the same file opened twice has the same one. */
  readonly key: string;
  /** The path it was opened from, or null for a font opened from bytes. */
  readonly path: string | null;
  /** fontkit's own font object, for what this interface does not cover
   *  (`namedVariations`, the raw tables). */
  readonly fk: Record<string, unknown> & {
    namedVariations?: Record<string, Record<string, number>>;
  };
  /**
   * `{}` for a static face, so `Object.keys(font.variationAxes).length` is
   * the whole of "is this variable?".
   */
  readonly variationAxes: Record<
    string,
    { name?: string; min: number; default: number; max: number }
  >;
  /** Scaled to a pixel size. A metric the face never declared is `null`
   *  rather than 0 — a cap height it did not state is not a cap height of
   *  zero. */
  metrics(size: number): {
    ascent: number;
    descent: number;
    lineGap: number;
    capHeight: number | null;
    xHeight: number | null;
    [key: string]: number | null;
  };
  hasGlyph(codepoint: number): boolean;
  /** This face at a point in its design space: `variation({ wght: 460 })`. */
  variation(settings: Record<string, number>): Font;
}

export interface OpenFontOptions {
  /** Which face of a `.ttc` collection; the first otherwise. */
  postscriptName?: string;
}

export interface LoadFontOptions extends OpenFontOptions {
  /** Register under this name instead of the font's own, and use it
   *  verbatim. */
  family?: string;
  /** Override the weight the file declares. */
  weight?: number | string;
  /** `'italic'` / `'oblique'`, overriding what the file declares. */
  style?: string;
}

export interface LoadedFont {
  readonly font: Font;
  /** What to put in `fontFamily` — the font's own name, scoped to
   *  `Inter 2` only where a second file would otherwise be unreachable. */
  readonly family: string;
}

/**
 * Read a font file — metrics, coverage, variation axes — through the
 * connection's font cache, so it is read once however often this is called.
 *
 * ```ts
 * const font = openFont(app, '/usr/share/fonts/truetype/inter/Inter.ttf');
 * font.metrics(30);
 * font.variationAxes;
 * ```
 *
 * Nothing about the app changes: the face is not registered, so it is
 * neither a `fontFamily` candidate nor part of the fallback chain. Use
 * {@link loadFont} to draw with it.
 */
export function openFont(
  app: NtkApp,
  source: string | Uint8Array,
  opts?: OpenFontOptions,
): Font;

/**
 * Read a font file and register it, returning the face and the family name
 * to draw it with.
 *
 * ```tsx
 * const { family } = loadFont(app, '/path/to/Inter.ttf');
 * <text style={{ fontFamily: family }}>Handgloves</text>;
 * ```
 */
export function loadFont(
  app: NtkApp,
  source: string | Uint8Array,
  opts?: LoadFontOptions,
): LoadedFont;

/**
 * {@link loadFont} from a component, memoized per app and file. Null when
 * `source` is null, so a picker can call it before anything is picked.
 *
 * ```tsx
 * const picked = useFont(path);
 * <text style={{ fontFamily: picked?.family }}>{sample}</text>;
 * ```
 */
export function useFont(
  source?: string | Uint8Array | null,
  opts?: LoadFontOptions,
): LoadedFont | null;
