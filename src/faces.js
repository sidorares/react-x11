// The faces the widgets set text in beyond the four a font source warms for
// a family by itself — regular, bold, italic and bold italic — so that a
// root can have them matched while it connects (`warmWidgetFaces`, from
// createRoot) rather than in the first frame that sets one.
//
// With fontconfig, a face nobody warmed is a synchronous `fc-match` inside
// that frame: a menu bar's titles, set in the medium below, cost 34 ms of a
// Linux desktop's first frame, and the matcher alone takes 80–150 ms on
// XQuartz. The weight is here rather than in components/Menu.js because the
// renderer is what warms it, and the renderer does not import widgets.
import { DefaultTheme } from './palette.js';

/** The weight a menu's titles and rows are set in (components/Menu.js). */
export const MENU_TEXT_WEIGHT = 500;

/**
 * Start matching the widget faces in the default family, off the event loop
 * (ntk's `FontManager#prewarm`). Fonts with nothing to look up — CoreText,
 * DirectWrite, faces handed over in memory — ignore it, as does an ntk older
 * than the method, and it never throws.
 */
export function warmWidgetFaces(app) {
  app.fonts?.prewarm?.(DefaultTheme.fontFamily, [{ weight: MENU_TEXT_WEIGHT }]);
}
