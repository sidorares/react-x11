// The display scale, as rendering code reads it.
//
// One number and it never changes — `createRoot` resolves it before the
// first window realizes and it is static for the life of the connection
// (src/scale.js explains why) — so this is the rare hook with nothing to
// subscribe to. It exists because the number is still *occasionally* an
// app's business even though every style, event and rect already speaks
// logical pixels: a `<canvas onDraw>` sizing its backing detail, a
// screenshot tool captioning what it captured, a settings pane showing
// "2x (from Xft.dpi)" the way it shows the DPI.

import { useApp } from './appcontext.js';
import { scaleOf } from './scale.js';

/**
 * Device pixels per logical pixel for this root — `1` on an ordinary
 * display, `2` on the retina panel this feature was built against,
 * fractional on the desktops that configure 1.25/1.5.
 *
 * Everything the renderer hands an app is already logical (styles, event
 * coordinates, `getClientRects`, `useScreens`), so multiply by this only
 * to reach *device* pixels deliberately — the `<canvas onDraw>` payload
 * carries the same number as `scale` for exactly that.
 */
export function useScale() {
  return scaleOf(useApp());
}
