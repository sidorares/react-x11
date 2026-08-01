/**
 * `react-x11/ntk` — the toolkit underneath, re-exported so an extension
 * package does not declare a second, independently-versioned `ntk`
 * dependency. Two copies in a process means two Yoga instances and two font
 * caches, and a node built against one cannot be painted by the other.
 *
 * ntk ships no types of its own, so these are deliberately loose rather
 * than a hand-written mirror that would drift out of date silently. The
 * named exports are the ones an extension actually reaches for; anything
 * else ntk has is still there at runtime.
 */
export const createClient: (
  options?: Record<string, unknown>,
) => Promise<unknown>;
export const StaticFontSource: new (...args: unknown[]) => unknown;
export const FontconfigFontSource: new (...args: unknown[]) => unknown;
export const Clipboard: new (...args: unknown[]) => unknown;
export const Path2D: new (...args: unknown[]) => unknown;
export const Image: new (...args: unknown[]) => unknown;
export const Pixmap: new (...args: unknown[]) => unknown;
export const Yoga: Record<string, unknown>;

declare const ntk: Record<string, unknown>;
export default ntk;
