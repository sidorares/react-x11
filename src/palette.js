// The two built-in palettes, and which one is in force.
//
// Separate from `components/theme.js` because the palette is not a React
// concern. There are two routes into the tree — `useTheme()` through React
// context, and a `$token` resolved against the nearest `theme` **prop** by
// walking the node tree — and the second one lives in `nodes.js`, below the
// widget layer. Both have to agree on what "no theme was given" means, so the
// answer belongs underneath both of them.
//
// **The default follows the desktop.** A react-x11 app that says nothing
// about colour is dark on a dark desktop and light on a light one, the way a
// GTK or Qt app is; `<ThemeProvider>` and `colorScheme` are how an app that
// wants otherwise says so. See docs/appearance.md.

import { appearanceSnapshot } from './appearance.js';
import { stepBeyond } from './styles.js';

/**
 * The palette every widget reads, and the shape of the controls with it.
 * A theme overrides what it cares about and inherits the rest, so the
 * defaults here are the look the widgets have always had.
 *
 * The shape tokens are what let a theme be more than a recolour: corner
 * radius, border weight, text size and the padding inside a control are
 * most of what separates one platform's buttons from another's.
 */
export const DefaultTheme = {
  // colour
  border: '#b2bec3',
  borderFocus: '#2980b9',
  background: 'white',
  text: '#2d3436',
  dim: '#7f8c8d',
  hoverBackground: '#2980b9',
  hoverText: 'white',
  accent: '#2980b9',
  accentHover: '#1f6693',
  accentText: 'white',
  surfaceHover: '#f1f2f6',
  track: '#dfe6e9',
  // The pressed step of each fill family: rest → …Hover → …Active. Every
  // family that has a hover needs one, because a press is the state a
  // control has to show *before* it has done anything — the activation
  // itself only happens on the release, and half a second can pass in
  // between.
  //
  // Written out here, but a theme almost never sets them: `resolveTheme`
  // takes the step the palette's own hover made and takes it again. So a
  // palette that names `accentHover` and stops there — which is every theme
  // in `examples/themes.js` and every recipe in docs/ecosystem/theming.md —
  // gets a press that matches it rather than one inherited from these.
  accentActive: '#154c6d',
  surfaceActive: '#e3e5ed',
  dimActive: '#4c5a57',
  // The keyboard focus ring. Read by the renderer, not by the widgets: any
  // focusable node under this palette draws it on `:focus-visible`, so a
  // plain `<box focusable>` an application writes is indicated too, and a
  // theme restyles every ring in the app from here.
  focusRing: '#2980b9',
  focusRingWidth: 2,
  focusRingOffset: 1,
  // shape
  radius: 4,
  radiusSmall: 3,
  // Floating surfaces round on their own scale, and it is a wider one: a
  // menu is a sheet of paper laid over the window, where a button is a
  // control cut into it. Half the text size is the number every desktop
  // lands near — 7px at a 14px body — and tying it to the type rather than
  // to `radius` is what keeps a theme that only sets `fontSize` from
  // getting a 20px menu with a 4px corner.
  //
  // The two inside it step down from there, because a rounded thing inside
  // a rounded thing wants a *smaller* curve or the two read as concentric
  // rings: the highlight on a menu row, and the tooltip bubble, which is
  // the smallest floating surface there is and the one closest to text.
  radiusPopup: 7,
  radiusPopupItem: 5,
  radiusTooltip: 4,
  borderWidth: 1,
  fontSize: 14,
  paddingX: 16,
  paddingY: 8,
};

// Which pressed token is derived from which pair, when the palette does not
// name it: the resting colour of the family and the hover it steps to.
const PRESSED_FROM = {
  accentActive: ['accent', 'accentHover'],
  surfaceActive: ['background', 'surfaceHover'],
  dimActive: ['border', 'dim'],
};

// And the same for the floating-surface radii, which are a function of the
// text they wrap: a palette that sets `fontSize` and nothing else still gets
// menus in proportion to it.
const RADIUS_FROM_FONT = {
  radiusPopup: (size) => Math.round(size / 2),
  radiusPopupItem: (size) => Math.max(0, Math.round(size / 2) - 2),
  radiusTooltip: (size) => Math.max(0, Math.round(size / 2) - 3),
};

/**
 * Merge a partial palette, filling in the pressed step for any family whose
 * colours moved without it — and the popup radii for a palette that moved
 * the text size without them.
 *
 * The rule per token: an explicit value wins; otherwise, if this palette
 * touched either colour the step is measured between, it is re-derived; and
 * otherwise whatever was already in force stands. That last clause is what
 * keeps an inner `<ThemeProvider value={{ fontSize: 18 }}>` from throwing
 * away a pressed colour an outer one set by hand.
 *
 * The alternative was three more tokens every theme has to remember, and a
 * theme that forgets one does not fail loudly — it just stops answering
 * presses, in the one state a control has to show while nothing else can.
 */
export function resolveTheme(value, base = DefaultTheme) {
  if (!value) return base;
  const merged = { ...base, ...value };
  for (const [token, [rest, hover]] of Object.entries(PRESSED_FROM)) {
    if (value[token] != null) continue;
    if (value[rest] == null && value[hover] == null) continue;
    merged[token] = stepBeyond(merged[rest], merged[hover]);
  }
  if (value.fontSize != null) {
    for (const [token, from] of Object.entries(RADIUS_FROM_FONT)) {
      if (value[token] == null) merged[token] = from(merged.fontSize);
    }
  }
  return merged;
}

/**
 * The dark counterpart, as the *same design* in a dark scheme rather than a
 * second design: it is built by merging colour overrides over
 * {@link DefaultTheme}, so every shape token — radius, border width, font
 * size, the control padding — is shared by construction and cannot drift.
 *
 * `resolveTheme` derives the three pressed steps from the hovers named here,
 * and `stepBeyond` takes the direction from the colours themselves, so a
 * press in dark *lightens* where the light palette's darkens. Nothing has to
 * be told which scheme it is in.
 */
export const DarkTheme = resolveTheme({
  // A near-black with a little blue in it rather than #000: pure black shows
  // every seam between a window and the widgets on it, and no desktop's dark
  // theme uses it.
  background: '#1e2228',
  surfaceHover: '#2a3038',
  text: '#e6e9ed',
  dim: '#8b939c',
  border: '#454d55',
  track: '#3a4149',
  // The accent lifts off the darker ground instead of sinking into it, so
  // `accentHover` goes *up* from `accent` here and down in the light palette.
  accent: '#3d8bd4',
  accentHover: '#5aa4e6',
  accentText: 'white',
  hoverBackground: '#3d8bd4',
  hoverText: 'white',
  borderFocus: '#5aa4e6',
  focusRing: '#5aa4e6',
});

/**
 * The palette in force where nothing has been said — which is to say, the
 * desktop's.
 *
 * Read synchronously and cheaply: `appearanceSnapshot()` is a frozen object
 * seeded from disk before the first render, so this is a property lookup and
 * a comparison, and it is called from the paint path.
 *
 * `'no-preference'` means *use your own default*, which is the light one.
 */
export function baseTheme() {
  return appearanceSnapshot().colorScheme === 'dark' ? DarkTheme : DefaultTheme;
}
