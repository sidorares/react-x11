# Theming, palettes and colour

react-x11's theme is a plain object of hex strings and numbers — see
[components](../components.md#theming) for the token list and
[styling](../styling.md#theme-tokens) for how `$token` resolves. Every
palette package here is used the same way: pick keys at theme-build time and
hand the result to `<ThemeProvider>` and `<window theme>`.

**ntk's colour parser accepts hex, `rgb()`, `rgba()`, `hsl()` and CSS colour
names, and returns null for anything else — and a null colour paints
nothing, silently.** Modern token sets are increasingly `oklch()`-first, so
convert them. That is the sharpest edge on this page.

CSS-in-JS (`styled-components`, `@emotion/styled`) fails — see the
[negative-results register](../ecosystem.md#what-does-not-work). Use
`createStyles` plus one of the palettes below.

## `@radix-ui/colors` {#radix-colors}

**Out of the box.** @radix-ui/colors@3.0.0.

Thirty named 12-step colour scales (plus dark, alpha and P3 variants) as
plain JS objects of hex strings. Each step has a documented job that lines
up with the token set almost step for step: 1–2 `background`, 3–5 `surface`
and its hover, 6–8 `border`, 9–10 solid fills, 11–12 text. Every scale has
the same structure, so one function produces any light/dark pairing.

```jsx
import {
  slate,
  slateDark,
  grass,
  grassDark,
  red,
  redDark,
  green,
  greenDark,
  amber,
  amberDark,
  blue,
  blueDark,
} from '@radix-ui/colors';
import { ThemeProvider, Button } from 'react-x11';

// step 11 is the readable-on-its-own-background text step of every scale,
// which is exactly what a status colour has to be here: ink as well as fill
const ink = (scale) => Object.values(scale)[10];

function radixTheme({ gray, accent, status }) {
  const g = Object.values(gray);
  const a = Object.values(accent);
  return {
    background: g[0],
    surface: g[2],
    text: g[11],
    textMuted: g[10],
    border: g[6],
    borderFocus: a[7],
    accent: a[8],
    accentHover: a[9],
    hoverBackground: a[8],
    surfaceHover: g[3],
    track: g[5],
    danger: ink(status.red),
    dangerHover: Object.values(status.red)[11],
    success: ink(status.green),
    warning: ink(status.amber),
    info: ink(status.blue),
    radius: 6,
    radiusSmall: 4,
    borderWidth: 1,
    fontSize: 14,
    paddingX: 16,
    paddingY: 10,
  };
}

const status = { red, green, amber, blue };
const statusDark = {
  red: redDark,
  green: greenDark,
  amber: amberDark,
  blue: blueDark,
};
const light = radixTheme({ gray: slate, accent: grass, status });
const dark = radixTheme({
  gray: slateDark,
  accent: grassDark,
  status: statusDark,
});

<ThemeProvider value={light}>
  <window>
    <Button primary>OK</Button>
  </window>
</ThemeProvider>;
```

- The dark scales are _separate exports_ (`slateDark`, not `slate.dark`).
- `Object.values()` ordering relies on the package's insertion order
  (`blue1`…`blue12`). It holds in 3.0.0, but indexing by key
  (``accent[`${name}9`]``) is sturdier if the scale name is handy.
- Nothing here names `accentText`, `hoverText` or the other `…Text` tokens:
  each is derived as the more legible of the palette's `text` and
  `background` on the fill it goes on. Steps 9 and 10 of yellow, lime,
  amber, sky and mint are light enough that a hard-coded `'#ffffff'` label
  fails contrast; the ratio decides instead. Name one to overrule it.
- The window needs no `backgroundColor`: with no style of its own it paints
  `background`.
- The alpha variants (`slateA`) are `#rrggbbaa`, which parses fine, but a
  translucent widget composites against the window background, not against
  whatever is behind the window.
- The P3 variants (`blueP3`) are `color(display-p3 …)` strings, which the
  parser rejects, so nothing paints. Stick to the sRGB exports.

## `@catppuccin/palette` {#catppuccin}

**Out of the box.** @catppuccin/palette@1.8.0.

Four flavours (latte is light; frappé, macchiato and mocha are dark), each
with 14 accents and a 12-step neutral ladder whose names _are_ UI roles —
`base`/`mantle`/`crust`, `surface0-2`, `overlay0-2`, `subtext0-1`, `text` —
so it maps most directly onto the theme shape. The accents are pastel, so on
dark flavours (`flavor.dark`) the readable text on an accent is _dark_.

```jsx
import { flavors } from '@catppuccin/palette';
import { ThemeProvider, Button } from 'react-x11';

function catppuccinTheme(flavor, accent = 'mauve') {
  const c = Object.fromEntries(
    Object.entries(flavor.colors).map(([k, v]) => [k, v.hex]),
  );
  const onAccent = flavor.dark ? c.crust : c.base;
  return {
    background: c.base,
    surface: c.surface0,
    text: c.text,
    textMuted: c.subtext0,
    border: c.surface1,
    borderFocus: c[accent],
    accent: c[accent],
    accentHover: c.lavender,
    accentText: onAccent,
    hoverBackground: c[accent],
    hoverText: onAccent,
    surfaceHover: c.surface1,
    track: c.surface2,
    // the four are named colours here, which is the whole appeal of this
    // package: `red` means the same thing in every flavour
    danger: c.red,
    dangerHover: c.maroon,
    success: c.green,
    warning: c.yellow,
    info: c.sapphire,
    radius: 6,
    radiusSmall: 4,
    borderWidth: 1,
    fontSize: 14,
    paddingX: 16,
    paddingY: 10,
  };
}

const mocha = catppuccinTheme(flavors.mocha);
const latte = catppuccinTheme(flavors.latte, 'blue');
```

- `accentHover` has no canonical Catppuccin answer — the palette has flat
  accents, not interaction ramps. A neighbouring accent, as above, is a
  taste call; a real hover shade is a one-liner with [colord](#colord) or
  [culori](#culori).
- ESM-first with an `exports` map, so un-exported subpaths fail; the root
  import is all you need.
- Latte's accents sit around 4:1 contrast on `base` — fine for fills,
  marginal for small accent-coloured _text_.

## `@material/material-color-utilities` {#material-color-utilities}

**Out of the box from a source colour.**
@material/material-color-utilities@0.4.0.

Google's Material 3 colour system: the HCT colour space, tonal palettes,
and `themeFromSourceColor(argb)`, which turns one seed colour into complete
light and dark schemes — the only package here that _generates_ a scheme.
M3 roles map nearly 1:1 onto the theme: `background`, `surface`,
`onSurface → text`, `outlineVariant → border`, `primary → accent`,
`onPrimary → accentText`, and `error` (M3's one status colour) → `danger`.

```jsx
import {
  themeFromSourceColor,
  argbFromHex,
  hexFromArgb,
} from '@material/material-color-utilities';
import { ThemeProvider, Button } from 'react-x11';

function materialTheme(scheme) {
  const c = Object.fromEntries(
    Object.entries(scheme.toJSON()).map(([k, v]) => [k, hexFromArgb(v)]),
  );
  return {
    background: c.background,
    surface: c.surface,
    text: c.onSurface,
    textMuted: c.onSurfaceVariant,
    border: c.outlineVariant,
    borderFocus: c.primary,
    accent: c.primary,
    accentHover: c.inversePrimary,
    accentText: c.onPrimary,
    hoverBackground: c.primary,
    hoverText: c.onPrimary,
    surfaceHover: c.surfaceVariant,
    danger: c.error,
    dangerText: c.onError,
    track: c.outlineVariant,
    radius: 8,
    radiusSmall: 4,
    borderWidth: 1,
    fontSize: 14,
    paddingX: 16,
    paddingY: 10,
  };
}

const m3 = themeFromSourceColor(argbFromHex('#6750A4'));
const light = materialTheme(m3.schemes.light); // accent #6750a4
const dark = materialTheme(m3.schemes.dark); //   accent #cfbcff
```

- **The published ESM uses extensionless relative imports**, so plain `node`
  fails with `ERR_MODULE_NOT_FOUND`. Under tsx (how react-x11 JSX runs
  anyway) or a bundler it resolves.
- `themeFromImage`/`sourceColorFromImage` call
  `document.createElement('canvas')` and fail here.
  `sourceColorFromImageBytes(rgbaBytes)` is pure: decode a PNG or JPEG with
  pngjs or jpeg-js and pass the RGBA array. Downscale first — the quantizer
  walks every opaque pixel, and skips pixels with alpha below 255.
- `accentHover` has no M3 role. `inversePrimary` is serviceable; a tone step
  via `theme.palettes.primary.tone(n)` is more faithful.
- npm releases are slow (0.4.0 has sat unchanged for a while) — pin it.

## colord {#colord}

**Out of the box.** colord@2.9.3.

A tiny immutable colour library: parse, `darken`/`lighten`/`alpha`/`mix`,
`isDark()`, output as hex/rgb/hsl; the `a11y` plugin adds WCAG `contrast()`
and `isReadable()`. It answers the colours no palette ships — `accentHover`,
`surfaceHover`, `dangerHover` — in a line each, turning one brand colour
into a complete theme.

You do not need it for the `…Text` inks: `resolveTheme` already picks the
more legible of the palette's `text` and `background` for every fill. The
explicit form below is what to write when those two candidates are not the
ones you want.

```jsx
import { colord, extend } from 'colord';
import a11yPlugin from 'colord/plugins/a11y';
extend([a11yPlugin]);

/** One brand colour -> the interactive slice of a react-x11 theme. */
function accentSlice(accent) {
  const c = colord(accent);
  const onAccent = c.contrast('#ffffff') >= 4.5 ? '#ffffff' : '#1b1b1b';
  return {
    accent,
    accentHover: c.darken(0.06).toHex(),
    borderFocus: accent,
    hoverBackground: accent,
    accentText: onAccent,
    hoverText: onAccent,
  };
}

const theme = { ...baseTheme, ...accentSlice('#1f883d') };
// colord('#1f883d').contrast('#ffffff') === 4.51 -> white text, just barely
```

- Plugins must be `extend`-ed before use; forgetting yields
  `c.contrast is not a function` at theme-build time.
- `darken()` works in HSL, which shifts saturated hues. Fine for a 6% hover
  nudge; for accent _ramps_ that must stay on-hue, use culori's OKLCH
  interpolation.
- Quiet (2.9.3 since 2023) but complete and dependency-free.

## culori {#culori}

**Out of the box.** culori@4.0.2.

Parses every CSS Color 4 syntax, converts between about thirty colour
spaces (OKLCH and OKLab included), interpolates in any of them, builds
scales, and computes WCAG contrast. Two jobs here:

1. **Gateway for modern colour strings.** Tailwind v4, Open Props' OKLCH
   variants and other CSS Color 4 token output are `oklch()`-first, which
   ntk's parser rejects. `formatHex(str)` is the one-call fix.
2. **Perceptual ramps.** Hover, active and disabled shades interpolated in
   OKLCH keep hue and perceived lightness where HSL drifts.

```jsx
import { formatHex, interpolate, wcagContrast } from 'culori';

// A perceptual ramp from one accent: 0 = accent, higher = lighter.
const ramp = interpolate(['#0969da', '#ffffff'], 'oklch');
const accent = '#0969da';

const theme = {
  ...baseTheme,
  accent,
  accentHover: formatHex(ramp(0.15)), // #3d81e2 — stays on-hue
  borderFocus: accent,
  track: formatHex(ramp(0.75)),
  accentText: wcagContrast(accent, '#fff') >= 4.5 ? '#ffffff' : '#1b1b1b',
};

// Gateway use: any CSS Color 4 string -> something ntk can paint.
formatHex('oklch(54.6% 0.245 262.881)'); // '#155dfc'
```

- The heavyweight of the pair: colord for "darken this a bit", culori for
  OKLCH, CSS Color 4 parsing or scales. Using both is fine.
- `formatHex` clips out-of-sRGB-gamut results channelwise; for scales from
  vivid P3-ish seeds, `clampChroma` first gives cleaner ramps.
- Dual-published: ESM source plus a bundled CJS. The `/fn` and `/css`
  subpaths for tree-shaken builds are ESM-only.

## `open-props` {#open-props}

**Out of the box for colours.** open-props@1.7.23.

A CSS-custom-properties design system whose root JS import is a flat frozen
object of about 1,830 entries keyed by property name (`'--gray-0'`,
`'--indigo-7'`), values as strings. Only the colour half is useful here, so
**prefer [`@radix-ui/colors`](#radix-colors)** for a palette alone (hex
throughout, documented steps, separate dark scales); Open Props fits a
project that already uses it.

The colour tokens — 13 hues × 13 steps — are plain hex, so a theme is
key-picking. Steps run roughly: 0–2 backgrounds, 3–5 borders and muted, 6–9
solids, 10–12 deep text.

```jsx
import OP from 'open-props';

const rem = (s) => Math.round(parseFloat(s) * 16); // '1.1rem' -> 18

const theme = {
  background: OP['--gray-0'],
  surface: OP['--gray-1'],
  text: OP['--gray-9'],
  textMuted: OP['--gray-6'],
  border: OP['--gray-3'],
  borderFocus: OP['--indigo-7'],
  accent: OP['--indigo-7'],
  accentHover: OP['--indigo-8'],
  accentText: '#ffffff',
  hoverBackground: OP['--indigo-7'],
  hoverText: '#ffffff',
  surfaceHover: OP['--gray-2'],
  track: OP['--gray-3'],
  danger: OP['--red-8'],
  dangerHover: OP['--red-9'],
  success: OP['--green-8'],
  warning: OP['--yellow-9'],
  info: OP['--blue-8'],
  radius: parseInt(OP['--radius-2']),
  radiusSmall: parseInt(OP['--radius-1']),
  borderWidth: 1,
  fontSize: rem(OP['--font-size-1']),
  paddingX: 16,
  paddingY: 10,
};
```

- **Sizes read in a style; the theme's own entries are numbers.** Open Props
  sizes are `rem` strings, which a style takes as written
  (`padding: OP['--size-3']` is `1rem`, and `rem` is the theme's
  `fontSize` — 16 above, so the scale matches the web). The widgets do arithmetic with `radius` and `fontSize`, so
  those are converted to numbers, as above. Easings are `cubic-bezier()`
  strings where react-x11 takes named easings, and shadows reference
  `var(--shadow-color)`; ignore the animation and shadow tokens.
- Key names include the `--` prefix, so it is bracket access everywhere;
  camelCase aliases exist too (`OP.gray0`).
- Unlike Radix there are no separate dark scales — a dark theme is your own
  key-picking (`--gray-12` background, `--gray-9` borders).

## `tailwindcss/colors` {#tailwind-colors}

**Adapter, ~3 lines — and the failure without it is silent.**
tailwindcss@4.3.3.

Tailwind's utility classes need a CSSOM, but the _palette_ — 22 named
scales × 11 steps — imports as plain JS from `tailwindcss/colors`. The
package has zero dependencies, so installing it for the colours costs about
770 KB unpacked and nothing else.

Since v4 every value is an `oklch()` string, which ntk's parser rejects, and
a null colour paints **nothing** — no error, just an invisible widget.
Convert at theme-build time:

```jsx
import colors from 'tailwindcss/colors';
import { formatHex } from 'culori';

// The whole adapter: one call per value.
const hex = (c) => formatHex(c); // 'oklch(54.6% …)' -> '#155dfc'

const theme = {
  background: hex(colors.slate[50]),
  surface: hex(colors.slate[100]),
  text: hex(colors.slate[900]),
  textMuted: hex(colors.slate[500]),
  border: hex(colors.slate[300]),
  borderFocus: hex(colors.blue[600]),
  accent: hex(colors.blue[600]),
  accentHover: hex(colors.blue[700]),
  accentText: '#ffffff',
  hoverBackground: hex(colors.blue[600]),
  hoverText: '#ffffff',
  surfaceHover: hex(colors.slate[200]),
  track: hex(colors.slate[300]),
  danger: hex(colors.red[600]),
  dangerHover: hex(colors.red[700]),
  success: hex(colors.green[700]),
  warning: hex(colors.amber[700]),
  info: hex(colors.blue[700]),
  radius: 6,
  radiusSmall: 4,
  borderWidth: 1,
  fontSize: 14,
  paddingX: 16,
  paddingY: 10,
};
```

- **Do not pass the raw values through.**
- `formatHex` gamut-clips, but Tailwind's vivid 500s survive sRGB
  conversion, so the hex closely matches what Tailwind v3 shipped.
- If installing a CSS framework for a data file grates, `@radix-ui/colors`
  does the same job natively in hex.

## `daltonize` {#daltonize}

**Adapter, ~4 lines. Niche — reach for it only if you are shipping an
explicit colour-vision variant; for everyday contrast work
[colord](#colord)'s `a11y` plugin is the tool.** daltonize@1.0.2.

One function: `daltonize([r, g, b], type)`, `type` being
`'protanope' | 'deuteranope' | 'tritanope'`, returns a corrected triplet
(classic LMS-space daltonization). Pure arithmetic, 9 KB, zero dependencies;
despite the README's image pitch, nothing touches a canvas. A theme is a
small closed set of colours, so map the correction over every value and
offer the result as an accessibility variant beside light and dark. The
adapter is hex ↔ triplet plumbing.

```jsx
import { daltonize } from 'daltonize';
import { colord } from 'colord';

const toRgb = (hex) => {
  const { r, g, b } = colord(hex).toRgb();
  return [r, g, b];
};
const toHex = (rgb) => colord({ r: rgb[0], g: rgb[1], b: rgb[2] }).toHex();

/** Colourblind-corrected variant of any react-x11 theme. */
function daltonizeTheme(theme, type = 'deuteranope') {
  return Object.fromEntries(
    Object.entries(theme).map(([k, v]) => [
      k,
      typeof v === 'string' && v.startsWith('#')
        ? toHex(daltonize(toRgb(v), type))
        : v, // radius, fontSize, … pass through
    ]),
  );
}

const accessible = daltonizeTheme(githubLight);
// '#1f883d' (GitHub green) -> '#1f7206' for deuteranopia
```

- **Correction, not validation.** It shifts colours so information carried
  by problem hues survives; it does not check or fix contrast. Pair it with
  colord's `a11y` plugin or culori's `wcagContrast`.
- Only the three dichromatic extremes are modelled, not the common mild
  anomalous trichromacy, so corrections can look aggressive; offer it as an
  opt-in variant, not a default.
- Opaque triplets only: run it on the RGB part and reattach alpha yourself
  for `#rrggbbaa`.
- Finished rather than maintained (last release 2023, placeholder
  `repository` field); vendoring the ~40 lines is a fair alternative.
