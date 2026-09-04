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
// GTK or Qt app is, and its accent is the desktop's where the desktop has
// one; `<ThemeProvider>` and `colorScheme` are how an app that wants
// otherwise says so. See docs/appearance.md.

import { appearanceSnapshot } from './appearance.js';
import { readableInk, stepBeyond } from './styles.js';

/**
 * The language subtags written right-to-left — CLDR's set, by the language
 * rather than by the script, because a locale name is what an environment
 * actually carries. Arabic and its neighbours, Hebrew, Persian and Dari,
 * Pashto, Urdu, Sindhi, Kashmiri, Uyghur, Yiddish, Sorani Kurdish, Dhivehi,
 * Syriac, N'Ko, and Adlam-written Fulah.
 */
const RTL_LANGUAGES = new Set([
  'ae',
  'ar',
  'arc',
  'bcc',
  'bqi',
  'ckb',
  'dv',
  'fa',
  'ff',
  'glk',
  'he',
  'iw',
  'khw',
  'ks',
  'ku',
  'mzn',
  'nqo',
  'pnb',
  'prs',
  'ps',
  'sd',
  'syr',
  'ug',
  'ur',
  'yi',
]);

/**
 * Which way this desktop reads, from the environment's locale.
 *
 * **This is the default, and it is a default rather than a setting on
 * purpose.** An app started under `LANG=ar_EG.UTF-8` is an Arabic app, and
 * the person who started it should not have to have been given a language
 * menu before the panels are on the right side. It is what GTK and Qt both
 * do — GTK asks the translation of `"default:LTR"`, Qt asks the system
 * locale — and it costs an app that never thinks about this exactly nothing,
 * because every locale not in the set above answers `'ltr'`.
 *
 * The overrides, nearest first: a `direction` style property on any node
 * mirrors that subtree, and `<ThemeProvider value={{ direction }}>` mirrors
 * everything under it *including the widgets*, which is the one an app with a
 * language menu wants — see docs/styling.md.
 *
 * There is no environment in the playground bundle, which runs this in a
 * browser — hence the guard rather than a bare `process.env`. A page has no
 * locale to read either way; what it has is whatever the app writes.
 *
 * Read once, at load: a locale does not change under a running process, and
 * this is on the path that resolves the palette for every node.
 */
export function localeDirection(env = ENV) {
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  // `ar_EG.UTF-8`, `he-IL`, `fa`, or `C`/`POSIX` — the language is whatever
  // comes before the territory, and the separator is either spelling
  const language = locale.split(/[._@-]/)[0].toLowerCase();
  return RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
}

const ENV = typeof process === 'undefined' ? {} : (process.env ?? {});

const LOCALE_DIRECTION = localeDirection();

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
  // The ground and the things raised off it. `background` is what the window
  // *is* — the fill under everything, painted by the window itself — and
  // `surface` is what sits on it: a control's fill, a card, the sheet a menu
  // or a dialog is drawn on. They are the same colour here because a white
  // app on a white ground is what the light palette has always been; a theme
  // that gives the ground its own tint (GitHub's `#f6f8fa` under white cards,
  // and every macOS window) is exactly the case that had nowhere to say so.
  background: 'white',
  surface: 'white',
  text: '#2d3436',
  // Secondary ink: a placeholder, a caption, the label of a disabled
  // control. Named for the text it is rather than for how it looks, so that
  // `textMuted` and `text` read as one family.
  textMuted: '#7f8c8d',
  hoverBackground: '#2980b9',
  hoverText: 'white',
  accent: '#2980b9',
  accentHover: '#1f6693',
  accentText: 'white',
  surfaceHover: '#f1f2f6',
  track: '#dfe6e9',
  // What a screen has to be able to *say*: this failed, this worked, look at
  // this, here is a note. Without them every alert, badge and validation
  // message hard-codes a hex, which is the one thing `$token` exists to
  // prevent — and those are the colours most likely to be wrong on a dark
  // desktop, because a red that reads on white disappears on near-black.
  //
  // Each is picked to work as **ink as well as fill**: 4.5:1 against this
  // palette's ground, so "Password too short" under a field is legible
  // without a second token for the text form of the same idea.
  //
  // Only `danger` has the hover and pressed steps, because it is the only
  // one of the four you ever press — a destructive button. A success or a
  // warning is something the app says, not something the user clicks; when
  // one of them ends up on a control, the control is a `<Button>` with a
  // `danger`-shaped ramp of its own.
  //
  // `info` is a blue of its own rather than the accent, even here where the
  // accent is also blue: a theme with a green accent still gets a blue note,
  // because that is what a note looks like everywhere — and this one is a
  // step darker than `accent`, which is a fill first and only clears 4.3:1
  // as letters.
  danger: '#c0392b',
  dangerHover: '#a93226',
  dangerText: 'white',
  success: '#1e8449',
  successText: 'white',
  warning: '#9a6700',
  warningText: 'white',
  info: '#1c6ea4',
  infoText: 'white',
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
  textMutedActive: '#4c5a57',
  dangerActive: '#922b21',
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
  // The two faces an app has. `fontFamily` is what a `<text>` inherits where
  // nothing named one, so "this app is Inter" is a sentence said once here
  // rather than on every label; `monoFamily` is the one every code surface
  // reaches for — a `<Code>`, a log pane, a hex dump — and the reason it is a
  // token at all is that those are written by *different* components, which
  // would otherwise each grow their own prop for it and have to be set one by
  // one.
  //
  // CSS-style family lists, the same as the `fontFamily` style property:
  // `'"JetBrains Mono", monospace'` names a preference and a fallback, and
  // ntk's `fonts.match` splits the list itself.
  fontFamily: 'sans-serif',
  monoFamily: 'monospace',
  // Which way this app reads — `'ltr'` or `'rtl'`, seeded from the locale.
  //
  // In the palette rather than in a context of its own because both consumers
  // are already here: the widgets read it through `useTheme()` to decide which
  // way a slider travels or which side a submenu opens on, and the node tree
  // reads it as the floor under the `direction` style property. An app with a
  // language menu therefore switches the whole UI, layout and widgets
  // together, with the `<ThemeProvider>` swap it was already doing for
  // colours — and a `<ThemeProvider>` that names it plants the matching style
  // in the tree, so the two routes cannot disagree.
  direction: LOCALE_DIRECTION,
  paddingX: 16,
  // Measured from the **letters**, not from the font's line box: widget
  // labels are trimmed to the capitals down to the baseline, so this is the
  // space you actually see above and below the text — see `capTrim` in
  // components/theme.js for why a line box cannot give an even one. Larger
  // than it looks next to a CSS padding for that reason: 12 here is about
  // what 8 came to once a typical face's ascent had been added on.
  paddingY: 12,
  // Which scheme this palette *is* — 'light' or 'dark'. Not a colour but a
  // fact about the colours, for the consumers that have to match them with
  // something they do not paint themselves: the Cocoa backend picks the
  // AppKit appearance its native control bezels are rendered in from this,
  // so a pinned-light app gets light bezels on a dark desktop. A custom
  // dark palette built over the light base should say `scheme: 'dark'`.
  scheme: 'light',
  // How the core controls render where the backend offers the platform's
  // own: `'auto'` (native where supported — today the Cocoa backend),
  // `'native'` (ask for it; warns and falls back to drawn where there is
  // none) or `'drawn'` (always the themed rendering). Per-instance escape
  // hatch: `native={false}` on the one custom-branded control.
  controls: 'auto',
};

// Which pressed token is derived from which pair, when the palette does not
// name it: the resting colour of the family and the hover it steps to.
//
// `textMutedActive` is measured from `border` because that is the ramp it
// belongs to: a `<Switch>` that is off has a `border`-coloured track, and
// the muted ink is the step it takes on hover. The ink and the track share a
// colour rather than a job.
const PRESSED_FROM = {
  accentActive: ['accent', 'accentHover'],
  surfaceActive: ['surface', 'surfaceHover'],
  textMutedActive: ['border', 'textMuted'],
  dangerActive: ['danger', 'dangerHover'],
};

// And which ink goes on which fill. A palette that names a fill and stops
// there gets the more legible of its own two inks — see `readableInk`.
//
// This is what makes the status family cheap to theme: naming four colours
// is a design decision, and naming the letters that go on top of each of
// them is bookkeeping that a contrast ratio can do. It is the same for
// `accent`, where it fixes a real trap — a palette whose accent is a yellow
// or a lime inherits `accentText: 'white'` and paints an invisible label.
const TEXT_FROM = {
  accentText: 'accent',
  hoverText: 'hoverBackground',
  dangerText: 'danger',
  successText: 'success',
  warningText: 'warning',
  infoText: 'info',
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
 *
 * **`surface` follows `background` unless it is named**, which is the same
 * bargain from the other end: a palette that has one ground has one ground,
 * and only a design that actually raises its cards off it has to say so. Any
 * other rule would leave a theme that names a `#1f1f23` background with the
 * built-in dark palette's surface on its controls — a colour from a palette
 * it had replaced.
 */
export function resolveTheme(value, base = DefaultTheme) {
  if (!value) return base;
  // What this palette said, with that one implication written in, so
  // everything measured from `surface` below is measured from the right
  // colour and re-derived when it moved.
  const named =
    value.surface == null && value.background != null
      ? { ...value, surface: value.background }
      : value;
  const merged = { ...base, ...named };
  for (const [token, [rest, hover]] of Object.entries(PRESSED_FROM)) {
    if (named[token] != null) continue;
    if (named[rest] == null && named[hover] == null) continue;
    merged[token] = stepBeyond(merged[rest], merged[hover]);
  }
  // The ink follows the fill it goes on, and also the two inks it is chosen
  // between: a palette that moves only `background` has moved what "the
  // legible one" means.
  for (const [token, fill] of Object.entries(TEXT_FROM)) {
    if (named[token] != null) continue;
    if (named[fill] == null && named.text == null && named.background == null)
      continue;
    merged[token] = readableInk(merged[fill], [merged.text, merged.background]);
  }
  if (named.fontSize != null) {
    for (const [token, from] of Object.entries(RADIUS_FROM_FONT)) {
      if (named[token] == null) merged[token] = from(merged.fontSize);
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
 * `resolveTheme` derives the pressed steps from the hovers named here, and
 * `stepBeyond` takes the direction from the colours themselves, so a press
 * in dark *lightens* where the light palette's darkens. Nothing has to be
 * told which scheme it is in. The status inks are derived too — this palette
 * names four fills and none of the letters on them, which is what every
 * theme after it gets to do.
 */
export const DarkTheme = resolveTheme({
  scheme: 'dark',
  // A near-black with a little blue in it rather than #000: pure black shows
  // every seam between a window and the widgets on it, and no desktop's dark
  // theme uses it.
  background: '#1e2228',
  // Here the ground and the surface part company, which is the whole point
  // of their being two tokens: a card at the ground's own colour is a card
  // you cannot see, and dark designs raise by lightening because there is no
  // shadow to cast on near-black.
  surface: '#252a31',
  surfaceHover: '#2a3038',
  text: '#e6e9ed',
  textMuted: '#8b939c',
  border: '#454d55',
  track: '#3a4149',
  // Lighter and less saturated than the light palette's: the same four
  // meanings, re-picked to clear 4.5:1 against near-black rather than
  // against white. `#c0392b` on this ground is a bruise.
  danger: '#ec6a5e',
  dangerHover: '#f28d80',
  success: '#2ecc71',
  warning: '#f0b429',
  info: '#5aa4e6',
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
 * `#rrggbb` moved `amount` of the way toward `toward`. The one colour
 * operation the desktop palette needs, on the one shape the ladder
 * guarantees an accent has (`sanitize`, `accentFromPortal`).
 */
function mixHex(hex, toward, amount) {
  const channel = (c, i) => parseInt(c.slice(1 + 2 * i, 3 + 2 * i), 16);
  return (
    '#' +
    [0, 1, 2]
      .map((i) => {
        const a = channel(hex, i);
        const b = channel(toward, i);
        return Math.round(a + (b - a) * amount)
          .toString(16)
          .padStart(2, '0');
      })
      .join('')
  );
}

/**
 * The built-in palette with the desktop's accent on it.
 *
 * Only the accent family moves — `accent`, its hover, the menu-row highlight
 * that is the same colour in both built-in palettes, and the focus ring —
 * and the steps are taken the way each palette takes them: the hover sinks
 * into a light ground and lifts off a dark one, and `resolveTheme` derives
 * the press from the pair. `info` stays its own blue, as it does under a
 * theme with a green accent: a note looks like a note everywhere.
 *
 * The ink is the desktop's where the desktop named one — AppKit writes white
 * on every accent a Mac offers, including the ones a contrast ratio would
 * put dark letters on, and the point of following the desktop is to look
 * like the controls beside ours. Where the source has no ink (the portal)
 * `resolveTheme` picks the legible one, as it does for any theme that names
 * a fill and stops there.
 */
function withDesktopAccent(scheme, accent, ink) {
  const dark = scheme.scheme === 'dark';
  const accentHover = dark
    ? mixHex(accent, '#ffffff', 0.2)
    : mixHex(accent, '#000000', 0.22);
  const focus = dark ? accentHover : accent;
  const value = {
    accent,
    accentHover,
    hoverBackground: accent,
    borderFocus: focus,
    focusRing: focus,
  };
  if (ink) {
    value.accentText = ink;
    value.hoverText = ink;
  }
  return resolveTheme(value, scheme);
}

// One palette per desktop answer, so the unprovided palette keeps the
// identity `useTheme()` and the `$token` resolution cache both count on: a
// fresh object per read would re-resolve every token in the tree on every
// paint. Bounded because a desktop's accent changes a handful of times in the
// life of a process, never per frame.
const desktopPalettes = new Map();

/**
 * The built-in palette for a desktop that looks like `appearance` — the
 * scheme's own, with the desktop's accent on it where the desktop named one.
 *
 * **The default follows the accent as well as the scheme.** An app that says
 * nothing about colour is asking to look like it belongs on this desktop, and
 * on the one that reports an accent every native control beside it is already
 * that colour — the Cocoa backend draws its bezels with AppKit, so the app's
 * own checkbox is orange while its `<Tabs>` indicator stayed blue. An app
 * with a brand names `accent` in its `<ThemeProvider>` and keeps it; a pinned
 * `colorScheme` follows nothing, the accent included.
 *
 * `'no-preference'` means *use your own default*, which is the light one.
 */
export function paletteFor(appearance) {
  const scheme = appearance.colorScheme === 'dark' ? DarkTheme : DefaultTheme;
  const { accent, accentText } = appearance;
  if (!accent) return scheme;
  const key = `${scheme.scheme} ${accent} ${accentText ?? ''}`;
  let palette = desktopPalettes.get(key);
  if (!palette) {
    if (desktopPalettes.size >= 8) desktopPalettes.clear();
    palette = withDesktopAccent(scheme, accent, accentText);
    desktopPalettes.set(key, palette);
  }
  return palette;
}

/**
 * The palette in force where nothing has been said — which is to say, the
 * desktop's.
 *
 * Read synchronously and cheaply: `appearanceSnapshot()` is a frozen object
 * seeded from disk before the first render, so this is a property lookup, a
 * comparison and a map hit, and it is called from the paint path.
 */
export function baseTheme() {
  return paletteFor(appearanceSnapshot());
}
