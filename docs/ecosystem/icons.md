# Icons

react-x11 has a real `<svg>` host, so icons get further than most DOM
libraries. Two renderer facts shape every entry on this page:

1. **ntk's `SvgView`, which rasterizes `<svg>`, ignores presentation
   attributes on the root element.** Inheritance starts from its own
   defaults, so an icon with `fill="none" stroke="currentColor"
stroke-width="2"` on the root renders as solid black blobs — wrong
   glyphs, not just the wrong colour. Moving those attributes onto an inner
   `<g>`, which does inherit, fixes it.
2. **Flat style props on `<svg>` throw.** `<svg width={24}>` is
   `react-x11: <svg width=…> is a style property — pass it in style`. Size
   with `style={{ width: 24 }}`; the `viewBox` keeps the aspect ratio.

Fact 2 is why `lucide-react`, `@tabler/icons-react` and
`@phosphor-icons/react` cannot work
([register](../ecosystem.md#render-time)); `@heroicons/react` is the
exception.

## The `iconSource` wrapper {#iconsource}

Four of the packages below ship whole SVG _strings_ with paint attributes on
the root. They all need the same twelve lines:

```js
// icon-source.js — re-root an icon's paint attributes onto a <g> so they
// survive SvgView, and pin `color` there so currentColor resolves.
const ROOT = /<svg([^>]*)>([\s\S]*)<\/svg>\s*$/;

export function iconSource(svgText, color = '#000') {
  const [, root, body] = ROOT.exec(svgText);
  const viewBox = /viewBox="[^"]*"/.exec(root)?.[0] ?? '';
  const paint = (
    root.match(
      /(?:fill|stroke|stroke-width|stroke-linecap|stroke-linejoin|fill-rule|clip-rule)="[^"]*"/g,
    ) ?? []
  ).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" ${viewBox}><g color="${color}" ${paint}>${body}</g></svg>`;
}
```

`currentColor` resolves to the inherited `color`, which defaults to `#000`,
so the `color` attribute on the `<g>` is what makes recolouring work.
`svgText.replaceAll('currentColor', color)` alone is _not_ enough: it fixes
the colour but not the dropped `fill="none"`, so stroke icons still paint as
filled blobs. Cache the wrapped strings per (name, style, colour).

## Iconify {#iconify}

**Out of the box.** @iconify/utils@3.1.4 with any `@iconify-json/*` set.

Iconify publishes every major icon set as JSON data — `@iconify-json/tabler`,
`@iconify-json/mdi`, `@iconify-json/ph`, `@iconify-json/lucide`,
`@iconify-json/heroicons` — plus `@iconify/utils`, which looks an icon up and
builds SVG markup from it. The highest-leverage route: one pipeline, 200,000+
icons, and the only string-SVG route that needs **no re-rooting adapter**,
because `iconToSVG` returns the body separately from the root attributes and
the paint attributes live inside the body.

```jsx
import { getIconData, iconToSVG, iconToHTML, replaceIDs } from '@iconify/utils';
import { icons as tabler } from '@iconify-json/tabler';

function iconSvg(name, color = '#000') {
  const data = getIconData(tabler, name); // null if unknown
  const built = iconToSVG(data, { height: 24 });
  return iconToHTML(replaceIDs(built.body), built.attributes).replaceAll(
    'currentColor',
    color,
  );
}

function Icon({ name, size = 24, color }) {
  return <svg source={iconSvg(name, color)} style={{ width: size }} />;
}

// <Icon name="home" color="#7c3aed" />
// <Icon name="settings" size={16} color="#0891b2" />
```

- `replaceIDs` matters for icons with gradients or clip paths, whose `id`s
  would collide inside one rasterized document. Harmless across separate
  `<svg>` nodes, but free to keep.
- Pick per-set packages (`@iconify-json/tabler` is about 5,000 icons in one
  JSON) rather than the monolithic `@iconify/json`, which is all 200,000+ and
  roughly 100 MB.
- There are no events inside a rasterized SVG. Wrap it in a
  `<box onClick>`.

## `@heroicons/react` {#heroicons-react}

**Out of the box — size it with `style`.** @heroicons/react@2.2.0.

The exception among the `*-react` icon packages: its components size
themselves with a Tailwind class name rather than flat `width`/`height`
attributes, so the `<svg>` host accepts them. lucide-react,
`@tabler/icons-react` and `@phosphor-icons/react` all throw.

```jsx
import { BeakerIcon } from '@heroicons/react/24/solid';

<box style={{ flexGrow: 1 }}>
  <BeakerIcon style={{ width: 24, height: 24 }} />
</box>;
```

The renderer ignores the `className`, so pass `style={{ width, height }}`
yourself — an icon with no size lays out at its natural size or collapses,
depending on the surrounding flex box. There is no recolour channel; for a
themed icon use the asset package below, or `@iconify-json/heroicons`.

## `lucide` {#lucide}

**Adapter, ~10 lines.** lucide@1.28.0.

Lucide's core package exports every icon as plain data — an array of
`[tag, attrs]` pairs — alongside the DOM-oriented `createIcons`.
Tree-shakeable per icon, and the best fit for react-x11: no string parsing,
each pair becomes a JSX child of `<svg>` (camelCase props serialize as
kebab-case attributes).

```jsx
import { createElement } from 'react';
import { House, Sun } from 'lucide';

function Icon({ icon, size = 24, color = '#000', strokeWidth = 2 }) {
  return (
    <svg viewBox="0 0 24 24" style={{ width: size, height: size }}>
      <g
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {icon.map(([tag, attrs], i) =>
          createElement(tag, { key: i, ...attrs }),
        )}
      </g>
    </svg>
  );
}

// <Icon icon={House} color="#16a34a" />
// <Icon icon={theme === 'dark' ? Sun : House} color={accent} />
```

Swapping `icon` or `color` in state repaints the icon.

- Omitting the `<g>` and putting `stroke`/`fill` on the `<svg>` silently
  renders black filled blobs.
- Function props on SVG children are dropped by the serializer, so there are
  no per-child events. Wrap the `<svg>` in a `<box onClick>` for a clickable
  icon.
- `className` on a child serializes to a `class-name` attribute — harmless,
  but do not rely on classes for styling.

## `lucide-static` {#lucide-static}

**Adapter — the [`iconSource` wrapper](#iconsource).** lucide-static@1.28.0.

Every Lucide icon as a named export holding an SVG markup string: 24×24,
stroke-based, `stroke="currentColor"` with round caps and joins — all on the
root element, hence the wrapper.

```jsx
import * as lucide from 'lucide-static';
import { iconSource } from './icon-source.js';

const Icon = ({ name, size = 24, color = '#000' }) => (
  <svg source={iconSource(lucide[name], color)} style={{ width: size }} />
);

// <Icon name="House" color="#e11d48" />
// <Icon name="Sun" size={16} color="#eab308" />
```

Prefer the `lucide` data package; use this one when you want the markup
string itself (asset pipelines, a pre-built sheet).

## `react-icons` {#react-icons}

**Adapter, ~15 lines.** react-icons@5.7.0.

The React icon aggregator — Font Awesome, Material, Lucide, Bootstrap,
Simple Icons and about fifty more behind one API. Unadapted it throws,
because `IconBase` always sets `height`/`width` (default `"1em"`) as flat
props on `<svg>`.

The adapter sidesteps `IconBase`. An icon component called with empty props
returns the `IconBase` element, whose props carry `attr` (the set's root
attributes — `viewBox`, and for stroke sets the paint attributes) and
`children` (the paths as React elements). Re-rooting `attr` onto an inner
`<g>` handles fact 1.

```jsx
import { FaHeart } from 'react-icons/fa';
import { LuHouse } from 'react-icons/lu';

// Works for both fill sets (fa, md, …) and stroke sets (lu, fi, …).
function RIcon({ icon: I, size = 24, color = '#000' }) {
  const { attr = {}, children } = I({}).props; // IconBase element
  const { viewBox = '0 0 24 24', ...paint } = attr;
  return (
    <svg viewBox={viewBox} style={{ width: size, height: size }}>
      <g
        color={color}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={0}
        {...paint}
      >
        {children}
      </g>
    </svg>
  );
}

// <RIcon icon={FaHeart} color="#e11d48" />   fill-based
// <RIcon icon={LuHouse} color="#2563eb" />   stroke-based
```

- `I({})` relies on each icon being a plain function component wrapping
  `GenIcon` — react-icons' shape since v4, but an internal one. `lucide` and
  the Iconify pipeline have no such seam.
- `IconContext` (global size/colour config) is bypassed; pass props instead.
- The `title` prop emits an SVG `<title>` child, which reaches no tooltip or
  assistive technology from a rasterized SVG. Omit it.
- react-icons bundles every set and is heavy on disk; for one style,
  `lucide` or `@iconify-json/<set>` is a much smaller install.

## `@tabler/icons` {#tabler-icons}

**Adapter — the [`iconSource` wrapper](#iconsource).** @tabler/icons@3.46.0.

5,000+ MIT icons as SVG files under `icons/outline/` (stroke-based, 24×24)
and `icons/filled/`, with an `exports` map that resolves file paths, plus
`tabler-nodes-outline.json`/`-filled.json` — per-icon node arrays like
`lucide`'s data exports.

```jsx
import fs from 'node:fs';
import { iconSource } from './icon-source.js';

const tabler = (name, style = 'outline') =>
  fs.readFileSync(
    new URL(import.meta.resolve(`@tabler/icons/${style}/${name}.svg`)),
    'utf8',
  );

const Icon = ({ name, style, size = 24, color = '#000' }) => (
  <svg
    source={iconSource(tabler(name, style), color)}
    style={{ width: size }}
  />
);

// <Icon name="home" color="#dc2626" />
// <Icon name="settings" style="filled" size={16} />
```

**Prefer `@iconify-json/tabler` + `@iconify/utils`**: identical art, no
adapter. Use this package when you want the files themselves or the JSON
node arrays.

- Outline icons start with a
  `<path stroke="none" d="M0 0h24v24H0z" fill="none"/>` bounds rect, which
  paints nothing. Harmless.
- `@tabler/icons-react` throws ([register](../ecosystem.md#render-time)).

## `@phosphor-icons/core` {#phosphor-icons}

**Adapter — the [`iconSource` wrapper](#iconsource).**
@phosphor-icons/core@2.1.1.

Raw SVG files under `assets/<weight>/<name>.svg` for six weights (`thin`,
`light`, `regular`, `bold`, `fill`, `duotone`), 256×256 viewBox,
fill-based. Because the default fill matches, the raw file renders legible
black glyphs; the wrapper is only needed for colour. `duotone`'s per-path
opacity survives either way.

```jsx
import fs from 'node:fs';
import { iconSource } from './icon-source.js';

const phosphor = (name, weight = 'regular') => {
  const file = weight === 'regular' ? name : `${name}-${weight}`;
  return fs.readFileSync(
    new URL(
      import.meta.resolve(`@phosphor-icons/core/assets/${weight}/${file}.svg`),
    ),
    'utf8',
  );
};

const Icon = ({ name, weight, size = 24, color = '#000' }) => (
  <svg
    source={iconSource(phosphor(name, weight), color)}
    style={{ width: size }}
  />
);

// <Icon name="house" color="#0ea5e9" />
// <Icon name="house" weight="fill" size={32} />
```

- Non-`regular` weights use suffixed filenames
  (`assets/bold/house-bold.svg`); the helper above handles it.
- `@iconify-json/ph` serves the same set with no adapter and no filesystem
  access. Prefer it unless you want the files.
- `@phosphor-icons/react` throws ([register](../ecosystem.md#render-time)).

## `heroicons` (the asset package) {#heroicons-assets}

**Adapter — the [`iconSource` wrapper](#iconsource).** heroicons@2.2.0.

The Tailwind set as plain SVG files, no JS: `24/outline/*.svg`
(stroke-based), `24/solid/`, `20/solid/` and `16/solid/`.

```jsx
import fs from 'node:fs';
import { iconSource } from './icon-source.js';

const heroicon = (name, style = '24/outline') =>
  fs.readFileSync(
    new URL(import.meta.resolve(`heroicons/${style}/${name}.svg`)),
    'utf8',
  );

const Icon = ({ name, style, size = 24, color = '#000' }) => (
  <svg
    source={iconSource(heroicon(name, style), color)}
    style={{ width: size }}
  />
);

// <Icon name="home" color="#f59e0b" />
// <Icon name="home" style="24/solid" color="#0ea5e9" />
```

Use this rather than `@heroicons/react` when you need to recolour. There is
no JS index, so enumerate the directory for a picker. **Prefer
`@iconify-json/heroicons`** through the [Iconify](#iconify) pipeline — same
art, no adapter, no filesystem access — unless you want the files.

## `feather-icons` {#feather-icons}

**Adapter, ~5 lines.** feather-icons@4.29.2.

The classic 24×24 stroke set, 287 icons. `.contents` is the inner SVG
markup without a root element, so the adapter is a template literal: build
the root and the `<g>` yourself and fact 1 never applies.

```jsx
import feather from 'feather-icons';

function featherSvg(name, color = '#000', strokeWidth = 2) {
  return `<svg viewBox="0 0 24 24"><g fill="none" stroke="${color}"
    stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"
    >${feather.icons[name].contents}</g></svg>`;
}

const Icon = ({ name, size = 24, color, strokeWidth }) => (
  <svg source={featherSvg(name, color, strokeWidth)} style={{ width: size }} />
);

// <Icon name="alert-circle" color="#f59e0b" />
```

- **Prefer Lucide**, Feather's actively developed fork with five times the
  coverage and the same look; Feather has had no new icons in years. Use it
  only to match an existing design.
- `feather.icons.x.toSvg()` into `<svg source>` renders wrong: `toSvg()`
  puts every paint attribute, and `toSvg({ color })`'s `color`, on the root,
  where they are ignored. Always go through `.contents`.
- `feather.replace()` (the DOM `<i data-feather>` swapper) is browser-only.
