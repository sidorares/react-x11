/**
 * `react-x11/ntk` — the toolkit underneath, re-exported so an extension
 * package does not declare a second, independently-versioned `ntk`
 * dependency. Two copies in a process means two font caches and two glyph
 * atlases, and a node built against one cannot be painted by the other.
 *
 * The layout engine is not here: react-x11 owns Yoga now, and an element
 * never needs it — `measureContent` states its constraints in words so that
 * yoga's ABI stays out of the extension seam.
 *
 * Documents are not here either: ntk 8 removed `MarkdownView`, `HtmlView` and
 * `layoutTex` with the engine. Use `@react-x11/components` for those;
 * `SvgView` remains, since a drawing is not a document.
 *
 * ntk ships no types of its own, so these are deliberately loose rather
 * than a hand-written mirror that would drift out of date silently. The
 * named exports are the ones an extension actually reaches for; anything
 * else ntk has is still there at runtime.
 *
 * `Surface` is the exception, typed in full: it is react-x11's own class,
 * answering ntk's pixmap on an X connection and a CG bitmap on the cocoa
 * backend, so its shape is this package's to declare.
 */
import type { Context2D } from './node.js';

export const createClient: (
  options?: Record<string, unknown>,
) => Promise<unknown>;
export const StaticFontSource: new (...args: unknown[]) => unknown;
export const FontconfigFontSource: new (...args: unknown[]) => unknown;
export const Clipboard: new (...args: unknown[]) => unknown;
export const Path2D: new (...args: unknown[]) => unknown;
export const Image: new (...args: unknown[]) => unknown;
export const Pixmap: new (...args: unknown[]) => unknown;

/** What `new Surface(app, options)` takes: a size in device pixels. */
export interface SurfaceOptions {
  width: number;
  height: number;
  /**
   * `'argb32'` (the default) on every backend. `'a8'`, a coverage surface
   * that composites as a mask for the fill style, is X11-only today and
   * throws on the cocoa backend.
   */
  format?: 'argb32' | 'a8';
}

/** A rectangle in surface coordinates — what `copyWithin` shifts. */
export interface SurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * An offscreen surface: draw once, composite many — and, for an element
 * that scrolls a retained buffer, `copyWithin(src, dx, dy)` shifts the
 * surviving band in place. On an X connection it is ntk's pixmap and
 * Picture; on the cocoa backend a CG bitmap; the same object shape either
 * way, and `ctx.drawImage(surface, …)` takes it as a source on both. See
 * [extending.md](../docs/extending.md) "Scrolling the pixels, not just the
 * offset".
 */
export interface Surface {
  readonly app: unknown;
  readonly width: number;
  readonly height: number;
  readonly format: 'argb32' | 'a8';
  readonly depth: 8 | 32;
  /** Bytes of backing storage — what a cache budgets against. */
  readonly bytes: number;
  /**
   * A 2d context on the surface. The caller owns it and owes it a
   * `destroy()` — real on X11 (a GC and a Picture), a no-op on cocoa, where
   * a surface has one context for its whole life.
   */
  getContext(name: '2d', ...args: unknown[]): Context2D;
  /** Draw through a context that exists for the call. */
  render(fn: (ctx: Context2D) => void): this;
  /** Reset every pixel to fully transparent. */
  clear(): this;
  /**
   * Shift `src` by a whole-pixel delta in place; true when a band survived
   * the shift and was copied, false when the caller should repaint `src`.
   */
  copyWithin(src: SurfaceRect, dx: number, dy: number): boolean;
  /** X11 only — the server-side Picture, for `<image picture>`. Throws on the cocoa backend. */
  picture(app?: unknown): unknown;
  destroy(): void;
  [Symbol.dispose](): void;
}
export const Surface: new (app: unknown, options: SurfaceOptions) => Surface;
/** `code` values on a failed GL setup — see `<glarea onError>`. */
export const GLXError: {
  NO_EXTENSION: 'GLX_NO_EXTENSION';
  INDIRECT_DISABLED: 'GLX_INDIRECT_DISABLED';
  NO_CONFIG: 'GLX_NO_CONFIG';
  CONTEXT_FAILED: 'GLX_CONTEXT_FAILED';
};

declare const ntk: Record<string, unknown>;
export default ntk;
