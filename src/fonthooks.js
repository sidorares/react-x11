// `useFont()` — a font file, from a component.
//
// The imperative half lives in `fonts.js` and is where the reasoning is. The
// hook is thin on purpose: `loadFont` is already idempotent per app and
// file, so the memo here saves a map lookup rather than a file read, and a
// component that re-renders sixty times a second still parses nothing.
//
// It reads `useApp()` rather than taking the connection, since a component
// three levels down has one and does not have the app.

import { useMemo } from 'react';

import { useApp } from './appcontext.js';
import { loadFont } from './fonts.js';

/**
 * The font in `source`, registered and ready to draw with.
 *
 * ```jsx
 * const { family } = useFont(fontPath);
 *
 * <text style={{ fontFamily: family, fontSize: 32 }}>Handgloves</text>;
 * ```
 *
 * `font` is ntk's `Font` — `metrics(size)`, `variationAxes`, `hasGlyph(cp)` —
 * and `family` is the name to put in `fontFamily`, read off the file rather
 * than invented here. See {@link loadFont} for what that name is and when it
 * is scoped.
 *
 * **Returns null when `source` is null**, so a picker can call it before
 * anything is picked without a branch around the hook:
 *
 * ```jsx
 * const picked = useFont(path); // path may be null
 * <text style={{ fontFamily: picked?.family }}>{sample}</text>;
 * ```
 *
 * The file is read on the render that first names it, and never again: the
 * face is cached in the connection's font manager, which is also where a
 * `openFont`/`loadFont` call outside the tree would find it.
 *
 * **A file that cannot be read throws during render**, which is an error
 * boundary's business — right for a font the app ships and wrong for one a
 * user just picked in a dialog, where the app wants to say so in its own UI.
 * Call `loadFont(app, path)` in the handler that picked it for that case, and
 * catch there.
 *
 * @param {string|Uint8Array|Buffer|null} [source] path, or the file's bytes
 * @param {{ family?: string, weight?: number|string, style?: string,
 *   postscriptName?: string }} [opts]
 */
export function useFont(source, opts) {
  const app = useApp();
  // The options are folded into the memo key rather than listed as
  // dependencies: an inline `{ family: 'preview' }` is a fresh object every
  // render and would defeat the memo on identity alone.
  const key = `${opts?.family ?? ''}|${opts?.weight ?? ''}|${opts?.style ?? ''}|${
    opts?.postscriptName ?? ''
  }`;
  return useMemo(
    () => (source == null ? null : loadFont(app, source, opts)),
    [app, source, key],
  );
}
