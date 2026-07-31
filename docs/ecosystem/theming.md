# Theming, palettes and colour

react-x11's theme is a plain object of hex strings and numbers — see
[components](../components.md#theming) for the token list and
[styling](../styling.md#theme-tokens) for how `$token` resolves. So every
palette package on this page is used the same way: pick keys at
theme-build time, hand the result to `<ThemeProvider>` and `<window theme>`,
and the renderer never knows the package exists.

One rule governs the whole page: **ntk's colour parser accepts hex, `rgb()`,
`rgba()`, `hsl()` and CSS colour names, and returns null for anything else —
and a null colour paints nothing, silently.** Modern token sets are
increasingly `oklch()`-first, so conversion is not optional. That is the
single sharpest edge here.

CSS-in-JS is not on this page at all. `styled-components` and
`@emotion/styled` both fail, in interestingly different ways, and are written
up in the [negative-results register](../ecosystem.md#what-does-not-work).
Use `createStyles` plus one of the palettes below.

## `@radix-ui/colors` {#radix-colors}

**Out of the box.** @radix-ui/colors@3.0.0.

Thirty named 12-step colour scales (plus dark, alpha and P3 variants) shipped
as plain JS objects of hex strings — no React, no DOM, no CSS. Each step has
a documented job: 1–2 app backgrounds, 3–5 component backgrounds, 6–8
borders, 9–10 solid fills, 11–12 text. That semantic contract is what makes
it a theme _generator_ rather than a swatch book.

Because every scale has identical structure, one function produces any
light/dark pairing.

```jsx
import { slate, slateDark, grass, grassDark } from '@radix-ui/colors';
import { ThemeProvider, Button } from 'react-x11';

function radixTheme({ gray, accent }, dark = false) {
  const g = Object.values(gray);
  const a = Object.values(accent);
  return {
    canvas: g[0],
    panel: g[1],
    background: g[2],
    text: g[11],
    dim: g[10],
    border: g[6],
    borderActive: a[7],
    accent: a[8],
    accentHover: a[9],
    accentText: dark ? g[11] : '#ffffff',
    hoverBackground: a[8],
    hoverText: '#ffffff',
    surfaceHover: g[3],
    track: g[5],
    radius: 6,
    radiusSmall: 4,
    borderWidth: 1,
    fontSize: 14,
    paddingX: 16,
    paddingY: 6,
  };
}

const light = radixTheme({ gray: slate, accent: grass });
const dark = radixTheme({ gray: slateDark, accent: grassDark }, true);

<window theme={light} style={{ backgroundColor: '$canvas' }}>
  <ThemeProvider value={light}>
    <Button primary>OK</Button>
  </ThemeProvider>
</window>;
```

- The dark scales are _separate exports_ (`slateDark`, not `slate.dark`).
- `Object.values()` ordering relies on the package's insertion order
  (`blue1`…`blue12`). It holds in 3.0.0, but indexing by key
  (``accent[`${name}9`]``) is sturdier if the scale name is handy.
- Steps 9 and 10 of some scales — yellow, lime, amber, sky, mint — are light
  enough that `accentText: '#ffffff'` fails contrast. Pick per scale, or
  compute it with [colord](#colord).
- The alpha variants (`slateA`) are `#rrggbbaa`, which parses fine, but
  remember a translucent widget composites against the window background, not
  against whatever is behind the window.
- The P3 variants (`blueP3`) are `color(display-p3 …)` strings. The parser
  returns null and nothing is painted. Stick to the sRGB exports.

## `@catppuccin/palette` {#catppuccin}

**Out of the box.** @catppuccin/palette@1.8.0.

Four flavours (latte is light; frappé, macchiato and mocha are dark), each
with 14 accents and a 12-step neutral ladder whose names _are_ UI roles —
`base`/`mantle`/`crust` for backgrounds, `surface0-2`, `overlay0-2`,
`subtext0-1`, `text`. Of all the palette packages this one maps most directly
onto the theme shape.

`flavor.dark` decides whether accent-coloured fills get dark or light text.
Catppuccin accents are pastel, so on dark flavours the readable text on an
accent is _dark_, not white.

```jsx
import { flavors } from '@catppuccin/palette';
import { ThemeProvider, Button } from 'react-x11';

function catppuccinTheme(flavor, accent = 'mauve') {
  const c = Object.fromEntries(
    Object.entries(flavor.colors).map(([k, v]) => [k, v.hex]),
  );
  const onAccent = flavor.dark ? c.crust : c.base;
  return {
    canvas: c.base,
    panel: c.mantle,
    background: c.surface0,
    text: c.text,
    dim: c.subtext0,
    border: c.surface1,
    borderActive: c[accent],
    accent: c[accent],
    accentHover: c.lavender,
    accentText: onAccent,
    hoverBackground: c[accent],
    hoverText: onAccent,
    surfaceHover: c.surface1,
    track: c.surface2,
    radius: 6,
    radiusSmall: 4,
    borderWidth: 1,
    fontSize: 14,
    paddingX: 16,
    paddingY: 6,
  };
}

const mocha = catppuccinTheme(flavors.mocha);
const latte = catppuccinTheme(flavors.latte, 'blue');
```

- `accentHover` has no canonical Catppuccin answer — the palette defines flat
  accents, not interaction ramps. Picking a neighbouring accent, as above, is
  a taste call; deriving a real hover shade is a one-liner with
  [colord](#colord) or [culori](#culori).
- The package is ESM-first with an `exports` map, so un-exported subpaths
  fail. The root import is all you need.
- Latte's accents sit around 4:1 contrast on `base` — fine for fills,
  marginal for small accent-coloured _text_. Same caveat as every pastel
  scheme.

## `@material/material-color-utilities` {#material-color-utilities}

**Out of the box from a source colour.**
@material/material-color-utilities@0.4.0.

Google's reference implementation of the Material 3 colour system: the HCT
colour space, tonal palettes, and `themeFromSourceColor(argb)`, which turns a
single seed colour into complete light and dark schemes. It is the only
package here that _generates_ a coherent scheme from one input, which is
exactly the shape `<window theme>` wants.

M3 roles map nearly 1:1 onto the theme shape: `surface → background`,
`onSurface → text`, `outlineVariant → border`, `primary → accent`,
`onPrimary → accentText`.

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
    canvas: c.background,
    panel: c.surfaceVariant,
    background: c.surface,
    text: c.onSurface,
    dim: c.onSurfaceVariant,
    border: c.outlineVariant,
    borderActive: c.primary,
    accent: c.primary,
    accentHover: c.inversePrimary,
    accentText: c.onPrimary,
    hoverBackground: c.primary,
    hoverText: c.onPrimary,
    surfaceHover: c.surfaceVariant,
    track: c.outlineVariant,
    radius: 8,
    radiusSmall: 4,
    borderWidth: 1,
    fontSize: 14,
    paddingX: 16,
    paddingY: 6,
  };
}

const m3 = themeFromSourceColor(argbFromHex('#6750A4'));
const light = materialTheme(m3.schemes.light); // accent #6750a4
const dark = materialTheme(m3.schemes.dark); //   accent #cfbcff
```

- **The published ESM uses extensionless relative imports**, so plain `node`
  fails with `ERR_MODULE_NOT_FOUND`. Under tsx — which is how react-x11 JSX
  runs anyway — or any bundler, it resolves fine.
- `themeFromImage`/`sourceColorFromImage` call `document.createElement('canvas')`
  and are dead here. `sourceColorFromImageBytes(rgbaBytes)` is exported and
  pure: decode a PNG or JPEG yourself with pngjs or jpeg-js and hand it the
  RGBA array. Downscale first — the Celebi quantizer walks every opaque
  pixel, and it skips pixels with alpha below 255.
- `accentHover` has no M3 role. `inversePrimary` is serviceable; a tone step
  via `theme.palettes.primary.tone(n)` is more faithful.
- 0.4.0 has sat unchanged for a while. The upstream repo is active but npm
  releases are slow — pin it.

## colord {#colord}

**Out of the box.** colord@2.9.3.

A tiny immutable colour-manipulation library: parse, `darken`/`lighten`/
`alpha`/`mix`, `isDark()`, output as hex/rgb/hsl. The `a11y` plugin adds WCAG
`contrast()` and `isReadable()`.

The theme shape wants colours no palette ships — `accentHover`,
`surfaceHover`, and the right `accentText` for an arbitrary accent. colord
answers all three in a line each, which turns any single brand colour into a
complete theme without hand-tuning.

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
    borderActive: accent,
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
- `darken()` works in HSL, which shifts saturated hues perceptibly. For a 6%
  hover nudge nobody notices; for accent _ramps_ that must stay on-hue, use
  culori's OKLCH interpolation.
- Maintenance is quiet (2.9.3 since 2023) but the library is complete and
  dependency-free. Low risk.

## culori {#culori}

**Out of the box.** culori@4.0.2.

Parses every CSS Color 4 syntax, converts between about thirty colour spaces
(OKLCH and OKLab included), interpolates in any of them, builds scales, and
computes WCAG contrast. Two distinct jobs here:

1. **Gateway for modern colour strings.** Growing amounts of design-token
   output — Tailwind v4, Open Props' OKLCH variants, design systems
   exporting CSS Color 4 — are `oklch()`-first, and ntk's parser returns null
   for those. `formatHex(str)` is the one-call fix.
2. **Perceptual ramps.** Hover, active and disabled shades interpolated in
   OKLCH keep hue and perceived lightness honest where HSL manipulation
   drifts.

```jsx
import { formatHex, interpolate, wcagContrast } from 'culori';

// A perceptual ramp from one accent: 0 = accent, higher = lighter.
const ramp = interpolate(['#0969da', '#ffffff'], 'oklch');
const accent = '#0969da';

const theme = {
  ...baseTheme,
  accent,
  accentHover: formatHex(ramp(0.15)), // #3d81e2 — stays on-hue
  borderActive: accent,
  track: formatHex(ramp(0.75)),
  accentText: wcagContrast(accent, '#fff') >= 4.5 ? '#ffffff' : '#1b1b1b',
};

// Gateway use: any CSS Color 4 string -> something ntk can paint.
formatHex('oklch(54.6% 0.245 262.881)'); // '#155dfc'
```

- It is the heavyweight of the pair. Prefer colord for "darken this a bit",
  culori when you need OKLCH, CSS Color 4 parsing, or scales. Using both is
  fine — neither touches the render path.
- `formatHex` clips out-of-sRGB-gamut results channelwise; for scales from
  vivid P3-ish seeds, `clampChroma` first gives cleaner ramps.
- Dual-published: ESM source plus a bundled CJS. The `/fn` and `/css`
  subpaths for tree-shaken builds are ESM-only.

## `open-props` {#open-props}

**Out of the box for colours.** open-props@1.7.23.

Open Props is a CSS-custom-properties design system, but it does have a JS
export: the root import resolves to a flat frozen object of about 1,830
entries keyed by custom-property name (`'--gray-0'`, `'--indigo-7'`), values
as strings. No DOM, no dependencies.

Only the colour half is worth having here, so **prefer
[`@radix-ui/colors`](#radix-colors)** if all you want is a palette — it is
hex throughout, has documented step semantics, and ships separate dark
scales. Open Props earns its place when a project already uses it and you
want the same swatches on both sides.

The colour tokens — 13 hues × 13 steps — are plain hex, so building a theme
is pure key-picking. The step convention is roughly: 0–2 backgrounds, 3–5
borders and muted, 6–9 solids, 10–12 deep text.

```jsx
import OP from 'open-props';

const rem = (s) => Math.round(parseFloat(s) * 16); // '1.1rem' -> 18

const theme = {
  canvas: OP['--gray-0'],
  panel: OP['--gray-1'],
  background: OP['--gray-1'],
  text: OP['--gray-9'],
  dim: OP['--gray-6'],
  border: OP['--gray-3'],
  borderActive: OP['--indigo-7'],
  accent: OP['--indigo-7'],
  accentHover: OP['--indigo-8'],
  accentText: '#ffffff',
  hoverBackground: OP['--indigo-7'],
  hoverText: '#ffffff',
  surfaceHover: OP['--gray-2'],
  track: OP['--gray-3'],
  radius: parseInt(OP['--radius-2']),
  radiusSmall: parseInt(OP['--radius-1']),
  borderWidth: 1,
  fontSize: rem(OP['--font-size-1']),
  paddingX: 16,
  paddingY: 6,
};
```

- **The non-colour tokens do not map onto react-x11 style.** Sizes are `rem`
  strings where react-x11 wants pixel numbers, easings are `cubic-bezier()`
  strings where react-x11 takes named easings, and shadows reference
  `var(--shadow-color)` and have no equivalent at all. Treat this as a colour
  library that happens to carry other tokens; convert what you use and ignore
  the animation and shadow tokens entirely.
- Key names include the `--` prefix, so it is bracket access everywhere;
  camelCase aliases exist too (`OP.gray0`).
- Unlike Radix there are no separate dark scales — a dark theme is your own
  key-picking (`--gray-12` canvas, `--gray-9` borders).

## `tailwindcss/colors` {#tailwind-colors}

**Adapter, ~3 lines — and the failure without it is silent.**
tailwindcss@4.3.3.

Tailwind-the-framework is a non-starter here: it emits CSS class utilities
for a CSSOM, and react-x11's style channel is a validated object system. The
_palette_ is a different story — 22 named scales × 11 steps, importable as
plain JS from `tailwindcss/colors` without touching any of the CSS
machinery, and it is the palette half your users already think in. The
package has zero dependencies, so installing it purely for the colours costs
about 770 KB unpacked and pulls in nothing else.

Since v4 every value is an `oklch()` string. ntk's parser returns null for
those, and a null colour paints **nothing** — no error, just an invisible
widget. Convert at theme-build time:

```jsx
import colors from 'tailwindcss/colors';
import { formatHex } from 'culori';

// The whole adapter: one call per value.
const hex = (c) => formatHex(c); // 'oklch(54.6% …)' -> '#155dfc'

const theme = {
  canvas: hex(colors.slate[50]),
  panel: hex(colors.slate[100]),
  background: hex(colors.slate[100]),
  text: hex(colors.slate[900]),
  dim: hex(colors.slate[500]),
  border: hex(colors.slate[300]),
  borderActive: hex(colors.blue[600]),
  accent: hex(colors.blue[600]),
  accentHover: hex(colors.blue[700]),
  accentText: '#ffffff',
  hoverBackground: hex(colors.blue[600]),
  hoverText: '#ffffff',
  surfaceHover: hex(colors.slate[200]),
  track: hex(colors.slate[300]),
  radius: 6,
  radiusSmall: 4,
  borderWidth: 1,
  fontSize: 14,
  paddingX: 16,
  paddingY: 6,
};
```

- **Do not pass the raw values through.** This is the sharpest edge on the
  page; everything else here is smooth.
- `formatHex` gamut-clips, but Tailwind's vivid 500s are chosen to survive
  sRGB conversion, so in practice the clipped hex closely matches what
  Tailwind v3 shipped.
- Installing a whole CSS framework for a data file is aesthetically odd; if
  that grates, `@radix-ui/colors` does the same job natively in hex. Zero
  dependencies means it is only odd, not costly.

## `daltonize` {#daltonize}

**Adapter, ~4 lines. Niche — reach for it only if you are shipping an
explicit colour-vision variant; for everyday contrast work
[colord](#colord)'s `a11y` plugin is the tool.** daltonize@1.0.2.

A single-function package: `daltonize([r, g, b], type)` where `type` is
`'protanope' | 'deuteranope' | 'tritanope'`, returning a corrected triplet.
It implements the classic LMS-space daltonization algorithm — simulate the
deficiency, take the error against the original, redistribute it into
channels the viewer _can_ see. Pure arithmetic, 9 KB, zero dependencies;
despite the README's image-oriented pitch, nothing in it touches a canvas.

Themes are small closed sets of colours, which makes whole-theme
daltonization trivial: map the correction over every value and offer it as an
accessibility variant next to light and dark. The adapter is only hex ↔
triplet plumbing.

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

- **Correction, not validation.** It shifts colours so information carried by
  problem hues survives; it does not check or fix contrast. A low-contrast
  theme stays low-contrast. Pair it with colord's `a11y` plugin or culori's
  `wcagContrast`.
- Only the three dichromatic extremes are modelled — anomalous trichromacy,
  which is the common mild case, is not. Corrections can look aggressive to a
  mildly affected viewer, so offer it as an opt-in variant rather than a
  default.
- Handles opaque triplets only. Run it on the RGB part and reattach alpha
  yourself if the theme uses `#rrggbbaa`.
- The package is small and finished rather than maintained (last release 2023) and its `repository` field is a placeholder. Vendoring the ~40 lines
  is a fair alternative to the dependency.
