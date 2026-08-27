// A configure-to-order store page — the "does it look designed?" example.
//
//   npm run examples:configurator
//
// Every other example demonstrates a mechanism. This one demonstrates a
// *look*: the big-type, hairline-and-shadow language of a current marketing
// site, built from nothing but core primitives — `<box>`, `<text>`, `<svg>`
// — to answer the question a web developer asks first: can this toolkit
// look like something I would ship?
//
// What it leans on, and where to look:
//
//   Fonts from npm     three OFL families, pulled in as devDependencies
//                      (`@fontsource/*`) and loaded by file path through
//                      `loadFont` (#346) — never through fontconfig, so the
//                      page renders identically on any machine, including
//                      one with no fonts installed at all. They are not in
//                      git: a font binary is the file a repository is worst
//                      at keeping, and the lockfile pins the same bytes by
//                      hash without any of the history. Two are variable, so
//                      `fontWeight` drives a `wght` axis and one file is
//                      every weight here.
//                      The face is put on the root box rather than left to
//                      the palette, and that is not a detail: the floor a
//                      `<text>` falls back to is the **window's** theme, and
//                      the provider here is inside the window — so without
//                      it the nav and the body copy came out in the host's
//                      sans-serif while the headings used the shipped serif.
//                      It cost the promise above, and 450ms of the first
//                      paint in `fc-match` calls (docs/styling.md).
//   Display type       Instrument Serif at 52px for the headline and 24px
//                      for the section titles, with an italic span for the
//                      accent — `fontStyle` picks the second face of the
//                      family.
//   Hairlines + depth  1px borders everywhere, and `boxShadow` for the two
//                      jobs CSS uses it for: soft elevation under the cards
//                      and the artwork, and a 1px ring on the selected card
//                      (`0 0 0 1px $accent`) — a border would move the
//                      layout, a shadow paints outside it and moves nothing.
//   A real 3D panel    the product shot is a `<glarea>` — an OpenGL surface
//                      in the layout — and it is scrubbed by the scroll
//                      position of the configuration beside it: the laptop
//                      is shut at the top of the page and open, turned
//                      towards you, at the bottom. `laptop3d.jsx` has the
//                      scene and the reasons; the short version is that the
//                      surface clears to the same paper colour as the page,
//                      so it reads as part of it rather than as a viewport;
//                      that its edges are chamfered, which is what gives an
//                      aluminium case its highlight; that it supersamples
//                      itself because the direct backend's visual carries no
//                      sample buffers; and that a machine whose GL cannot run
//                      shaders gets the flat `<box>` laptop, still here.
//   Gradients          `backgroundImage: linear-gradient(...)` paints the
//                      laptop's wallpaper and the sheen on its hinge; the
//                      sheen is a translucent white ramp *over* a solid
//                      `backgroundColor`, which is what lets the finish
//                      colour underneath transition smoothly while the
//                      gradient stays put.
//   State blocks       every interactive thing answers the pointer with
//                      `:hover` and the press with `:active` (AGENTS.md:
//                      answer the input, not the outcome), plus a
//                      `transition` so the change starts on the press frame
//                      and still reads as calm.
//   Size queries       `@width` collapses the two-column layout to one and
//                      `@height` folds the artwork away, so the window can
//                      be dragged small without the design falling apart.
//   Keyboard           the option cards are plain focusable boxes, so
//                      Space/Enter click them for free; the groups are real
//                      radiogroups and the arrow keys rove through them.
//
// ## What to try
//
//   Scroll the options the laptop opens and turns as the panel on the right
//                      scrolls, one redraw per scroll event and no clock
//                      running when you stop — and the screen in the render
//                      is that panel, so the machine on the page is running
//                      the page — re-read on the frame clock while anything
//                      moves, at 32-35 updates a second. `SCREEN_REFRESH`
//                      has the numbers and the cheaper strategy beside them.
//   Pick a finish      the laptop repaints — body, hinge and screen — and on
//                      the flat fallback the same change is a 260ms colour
//                      transition; the summary line under it follows.
//   Hover a card       hairline darkens, a soft shadow appears. Hold the
//                      press: the surface tints on the *down*, the selection
//                      moves on the release.
//   Tab + arrows       Tab into a group, arrows move the choice, the focus
//                      ring is the theme's (`focusRing` tokens).
//   Resize             below 1020px wide the hero stacks over the options;
//                      below 720px tall the artwork bows out.
//   Add to Bag         the button acknowledges (a drawn check, since the
//                      latin subsets carry no U+2713), the bag chip in
//                      the top bar counts up, the price keeps following the
//                      configuration.
//
// ## What does not work
//
// **The 3D panel cannot be screenshotted.** GL renders where `GetImage`
// cannot read it (docs/glx.md), so a capture of this window has a hole where
// the laptop is — `gl.readPixels` inside `onDraw` is the only way to see it,
// which is what `examples/labs/direct-gl.jsx` is for. It also does not take
// part in hit testing yet, so the scroll position is its only input.
//
// `textBoxTrim` is the one thing this page pointedly does not use: a
// trimmed text inside an overflowing scroll pane makes the content floors
// ratchet until every section is astronomically tall (#411), so the big
// type here is spaced by padding rather than trimmed to its capitals. No
// `opacity` (NEXT_STEPS §3), so the press feedback tints colours instead of
// fading anything. There is no letter-spacing style axis yet, so the small
// caps "eyebrow" labels get their air from the mono face rather than from
// tracking. `boxShadow` does not transition (docs/styling.md) — the hover
// lift snaps, deliberately, while the border colour eases. And a shadow
// does not paint on the in-process X server (ntk#287), which is why
// `test/configurator.test.js` asserts selection state and prices, never
// shadow pixels.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRequire } from 'node:module';

import {
  ThemeProvider,
  createRoot,
  createStyles,
  loadFont,
  useApp,
  useSupports,
  useTopLevelWindow,
} from '../../src/index.js';
import { XK_DOWN, XK_LEFT, XK_RIGHT, XK_UP } from '../../src/keysyms.js';
import { LaptopGL, SCREEN_ASPECT } from './laptop3d.jsx';

// ---------------------------------------------------------------------------
// The catalogue. Data, so the page is one map over it — and so the test can
// price a configuration without repeating the arithmetic by hand.
// ---------------------------------------------------------------------------

// Plain hyphens rather than U+2011: the latin subsets the fonts arrive in
// carry no non-breaking hyphen, so one would be drawn from whatever the
// machine has — a different glyph per desktop, and an `fc-match` on the first
// paint that uses it. Nothing here wraps at a hyphen anyway.
export const CATALOG = {
  base: 1599,
  finishes: [
    {
      id: 'fog',
      name: 'Fog',
      body: '#e7e5e0',
      edge: '#f7f6f3',
      well: '#d5d2ca',
      screen: ['#f6e6d2', '#8794ad'],
      wallpaper: 'linear-gradient(155deg, #f3e2cd, #c9a183 52%, #7d89a6)',
    },
    {
      id: 'graphite',
      name: 'Graphite',
      body: '#43413d',
      edge: '#5d5a55',
      well: '#33312e',
      screen: ['#5d688a', '#141726'],
      wallpaper: 'linear-gradient(155deg, #55607a, #272b3a 55%, #121420)',
    },
    {
      id: 'clay',
      name: 'Clay',
      body: '#b96e48',
      edge: '#d38a60',
      well: '#a05a38',
      screen: ['#f7d3ac', '#6b3350'],
      wallpaper: 'linear-gradient(155deg, #f2c8a2, #c2683d 55%, #63304c)',
    },
  ],
  groups: [
    {
      id: 'chip',
      eyebrow: 'Chip',
      title: 'Argon silicon.',
      caption: 'Pick your pace.',
      options: [
        {
          id: 'argon9',
          name: 'Argon 9',
          detail: '10-core CPU · 16-core GPU',
          price: 0,
        },
        {
          id: 'argon9pro',
          name: 'Argon 9 Pro',
          detail: '12-core CPU · 19-core GPU',
          price: 300,
        },
        {
          id: 'argon9max',
          name: 'Argon 9 Max',
          detail: '14-core CPU · 30-core GPU',
          price: 700,
        },
      ],
    },
    {
      id: 'memory',
      eyebrow: 'Memory',
      title: 'Room to think.',
      caption: 'Unified, and not upgradeable later — that is the one to size.',
      options: [
        { id: 'm16', name: '16 GB', detail: 'Unified memory', price: 0 },
        { id: 'm24', name: '24 GB', detail: 'Unified memory', price: 200 },
        { id: 'm48', name: '48 GB', detail: 'Unified memory', price: 500 },
      ],
    },
    {
      id: 'storage',
      eyebrow: 'Storage',
      title: 'Keep everything.',
      caption: 'Every drive here reads at 7 GB/s. Size is the only choice.',
      options: [
        { id: 's512', name: '512 GB', detail: 'Solid-state drive', price: 0 },
        { id: 's1tb', name: '1 TB', detail: 'Solid-state drive', price: 250 },
        { id: 's2tb', name: '2 TB', detail: 'Solid-state drive', price: 650 },
      ],
    },
  ],
  extras: [
    {
      id: 'care',
      name: 'Meridian Care+',
      detail: 'Priority repairs and a spare charger, for three years.',
      price: 199,
    },
    {
      id: 'aurora',
      name: 'Aurora keys',
      detail: 'Per-key backlight, tuned to the wallpaper.',
      price: 49,
    },
  ],
};

/**
 * How often the laptop's screen re-reads the page.
 *
 * `'live'` chases the page on the frame clock: while anything is moving, one
 * capture at a time, the next asked for from the frame that finished the
 * last. `'settled'` reads on a change and 140ms after the last scroll event.
 *
 * Live is the default because it was measured rather than assumed, over a
 * three-second scroll on a local connection:
 *
 * |                    | live          | settled       |
 * | ------------------ | ------------- | ------------- |
 * | screen updates     | 32-35/s       | 1.3/s         |
 * | read round trip    | 12-14ms mean  | 50ms mean     |
 * | client CPU         | 55-62% core   | 38% core      |
 * | pixels off the X   | 20-22 MB/s    | 0.9 MB/s      |
 * | scroll step        | 16.5ms mean   | 16.9ms mean   |
 *
 * The last row is the one that decided it: the gesture is no less smooth with
 * a capture on every frame, because the read is asynchronous and the client
 * is idle between steps anyway. What it costs is CPU while a gesture is
 * running — nothing at rest, since the pump only turns over when something
 * is dirty.
 *
 * Switch to `'settled'` on a **remote** connection, where 22 MB/s of pixels
 * is the difference between a smooth page and an unusable one, or on a
 * machine where the extra core matters more than a live screen.
 */
export const SCREEN_REFRESH = 'live';

export const DEFAULT_CONFIG = {
  finish: 'fog',
  chip: 'argon9',
  memory: 'm16',
  storage: 's512',
  extras: [],
};

/** The one price rule, shared with the test. */
export function priceOf(config) {
  let total = CATALOG.base;
  for (const group of CATALOG.groups) {
    const chosen = group.options.find((o) => o.id === config[group.id]);
    total += chosen?.price ?? 0;
  }
  for (const extra of CATALOG.extras) {
    if (config.extras.includes(extra.id)) total += extra.price;
  }
  return total;
}

/** Stock configurations ship at once; anything upgraded is built to order. */
export function deliveryOf(config) {
  const custom =
    config.chip !== DEFAULT_CONFIG.chip || config.storage === 's2tb';
  return custom ? 'Built to order · ships in 2–3 weeks' : 'Ships tomorrow';
}

const usd = (n) => '$' + n.toLocaleString('en-US');

// ---------------------------------------------------------------------------
// The shipped faces. `loadFont` reads each file once per connection and
// registers it under the family name *in* the file, ahead of fontconfig —
// which is the entire "identical on every machine" story: nothing below ever
// asks the system for a font. The italic registers into the same family, so
// `fontStyle: 'italic'` picks it; the two variable files serve every
// `fontWeight` from one face each.
// ---------------------------------------------------------------------------

/**
 * The faces come from **npm**, not from this directory.
 *
 * Committing 1.3MB of font binaries put them in the history for good, and a
 * font is the kind of file git is worst at: opaque, large, and re-added whole
 * on every update. `@fontsource/*` publishes the same OFL families, so the
 * lockfile pins them by integrity hash, `npm ci` fetches them once, and CI
 * gets the same bytes a laptop does with no extra step. The promise this page
 * makes — that it renders identically anywhere — is kept by the lockfile
 * rather than by the repository.
 *
 * They are `.woff2`, which fontkit reads directly, and they are the **latin**
 * subsets, since everything on this page is latin. What the subset costs is
 * written down where it bites — see `Check` below.
 */
const require_ = createRequire(import.meta.url);

/**
 * The faces, by npm package rather than by path into this directory.
 *
 * **Static weights, not a variable font**, and the reason is a hard edge
 * rather than a preference: npm's font packages ship `.woff2` only, and
 * fontkit can parse a compressed font but cannot instantiate an axis out of
 * one — `loadFont` on a variable `.woff2` fails with exactly that, naming the
 * file and the fix. So Inter arrives as four faces at the weights this page
 * uses, all registered under the one family, and `fontWeight` picks between
 * them (docs/styling.md). Which is the other half of `loadFont`'s contract
 * and worth showing anyway.
 */
const FONT_FILES = {
  sans: {
    400: '@fontsource/inter/files/inter-latin-400-normal.woff2',
    500: '@fontsource/inter/files/inter-latin-500-normal.woff2',
    600: '@fontsource/inter/files/inter-latin-600-normal.woff2',
    700: '@fontsource/inter/files/inter-latin-700-normal.woff2',
  },
  serif:
    '@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2',
  serifItalic:
    '@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2',
  mono: '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2',
};

function useShippedFonts() {
  const app = useApp();
  return useMemo(() => {
    const resolve = (id) => {
      try {
        return require_.resolve(id);
      } catch (err) {
        throw new Error(
          `examples/configurator: ${id} is not installed. The fonts are ` +
            'devDependencies rather than files in the repository — run ' +
            '`npm install` in the root.',
          { cause: err },
        );
      }
    };
    // One family, four weights: the name comes off the file and every face
    // keeps it, so `fontWeight: 600` reaches the 600 face and nothing else
    // has to know there are four.
    let sans = null;
    for (const [weight, id] of Object.entries(FONT_FILES.sans)) {
      const face = loadFont(app, resolve(id), { weight: Number(weight) });
      sans ??= face;
    }
    const serif = loadFont(app, resolve(FONT_FILES.serif));
    // the same family, and `fontStyle: 'italic'` is what picks it
    loadFont(app, resolve(FONT_FILES.serifItalic), { style: 'italic' });
    const mono = loadFont(app, resolve(FONT_FILES.mono));
    return { sans: sans.family, serif: serif.family, mono: mono.family };
  }, [app]);
}

// ---------------------------------------------------------------------------
// The palette. Warm paper, white cards, one terracotta accent — and the
// shipped families as the theme's own faces, so `fontFamily` is written
// nowhere below except where a style *changes* face.
// ---------------------------------------------------------------------------

const PAPER = '#f2efe8';

const makePalette = (fonts) => ({
  fontFamily: fonts.sans,
  fontSize: 13,
  monoFamily: fonts.mono,
  serifFamily: fonts.serif,

  paper: PAPER,
  surface: '#ffffff',
  surfaceHover: '#fbf9f4',
  surfaceActive: '#f4f0e6',
  ink: '#221e18',
  inkSoft: '#6d6656',
  inkFaint: '#a29a86',
  hairline: '#e4ddcd',
  hairlineStrong: '#c9c0aa',
  accent: '#bd5d3a',
  accentHover: '#a84e2e',
  accentActive: '#8f4226',
  accentSoft: 'rgba(189, 93, 58, 0.11)',
  success: '#2f7a4d',
  successActive: '#276541',

  text: '#221e18',
  textMuted: '#6d6656',
  focusRing: '#bd5d3a',
  focusRingWidth: 2,
  focusRingOffset: 2,
});

// ---------------------------------------------------------------------------
// Styles. Hoisted once — identity is the update fast path — with the theme
// reaching them through `$tokens`.
// ---------------------------------------------------------------------------

const s = createStyles({
  root: {
    flexGrow: 1,
    flexDirection: 'column',
    backgroundColor: '$paper',
    // The face, the size and the ink for everything below, by inheritance
    // (docs/styling.md). Without this, a `<text>` that names no family falls
    // back to the palette floor of the **outermost element** — the
    // `<window>`, which is above the provider — and that floor is
    // `sans-serif`: the nav, the labels and the body copy would all be drawn
    // in whatever the host machine calls sans-serif, which is the one thing
    // an example that ships its fonts must not do. It also costs an
    // `fc-match` per weight on the first paint, ~450ms of it here.
    fontFamily: '$fontFamily',
    fontSize: '$fontSize',
    color: '$ink',
  },

  // -- top bar ------------------------------------------------------------
  topbar: {
    height: 58,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingStart: 28,
    paddingEnd: 28,
    gap: 24,
    borderBottomWidth: 1,
    borderColor: '$hairline',
  },
  brandSide: { flexGrow: 1, flexBasis: 0, flexDirection: 'row' },
  brand: { fontFamily: '$serifFamily', fontSize: 25, color: '$ink' },
  brandDot: { color: '$accent' },
  nav: { flexDirection: 'row', gap: 26, alignItems: 'center' },
  navLink: {
    color: '$inkSoft',
    fontSize: 13.5,
    transition: { color: 120 },
    ':hover': { color: '$ink' },
  },
  bagSide: {
    flexGrow: 1,
    flexBasis: 0,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  bag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingStart: 13,
    paddingEnd: 13,
    paddingTop: 7,
    paddingBottom: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '$hairline',
    backgroundColor: '$surface',
    color: '$ink',
    transition: { borderColor: 150, backgroundColor: 150 },
    ':hover': { borderColor: '$hairlineStrong' },
  },
  bagCount: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '$accent',
    alignItems: 'center',
    justifyContent: 'center',
    transition: { backgroundColor: 150 },
  },
  bagCountText: { fontFamily: '$monoFamily', fontSize: 10.5, color: 'white' },
  bagLabel: { fontSize: 12.5 },

  // -- the two panes ------------------------------------------------------
  content: {
    flexGrow: 1,
    flexDirection: 'row',
    '@width < 1020': { flexDirection: 'column' },
  },
  hero: {
    flexGrow: 1,
    flexDirection: 'column',
    paddingStart: 56,
    paddingEnd: 56,
    paddingTop: 32,
    paddingBottom: 26,
    gap: 16,
    overflow: 'hidden',
    '@width < 1020': {
      flexGrow: 0,
      flexShrink: 0,
      paddingTop: 28,
      paddingBottom: 24,
      gap: 16,
    },
  },
  options: {
    width: 500,
    flexShrink: 0,
    overflow: 'scroll',
    flexDirection: 'column',
    gap: 30,
    paddingStart: 36,
    paddingEnd: 36,
    paddingTop: 40,
    paddingBottom: 44,
    borderStartWidth: 1,
    borderColor: '$hairline',
    '@width < 1020': {
      width: 'auto',
      flexGrow: 1,
      borderStartWidth: 0,
      borderTopWidth: 1,
    },
  },

  // -- hero type ----------------------------------------------------------
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  newPill: {
    paddingStart: 9,
    paddingEnd: 9,
    paddingTop: 4,
    paddingBottom: 4,
    borderRadius: 999,
    backgroundColor: '$accentSoft',
  },
  newPillText: { fontFamily: '$monoFamily', fontSize: 10, color: '$accent' },
  eyebrow: { fontFamily: '$monoFamily', fontSize: 11, color: '$inkFaint' },
  h1: {
    fontFamily: '$serifFamily',
    fontSize: 52,
    color: '$ink',
  },
  h1Accent: { fontStyle: 'italic', color: '$accent' },
  sub: {
    fontSize: 14,
    lineHeight: 1.45,
    color: '$inkSoft',
    maxWidth: 560,
  },

  // -- the laptop ---------------------------------------------------------
  stage: {
    // The render takes the height the hero has left, so the spec chips and
    // the summary sit at the bottom of the column rather than floating in
    // the middle of a tall window.
    //
    // `minHeight: 0` is load-bearing. A flex item's automatic minimum is its
    // content, and a `<glarea>` reports the size it was last given — so a
    // growing stage in a column whose content already overflows takes that
    // as a floor and ratchets: the panel came out 1210px tall inside a 691px
    // hero, anchored above the window. Naming a minimum is how an author
    // opts out of that (docs/styling.md), and the camera reframes the
    // laptop for whatever shape is left over, so there is no size this
    // cannot draw into.
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    flexDirection: 'column',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: 0,
    '@height < 720': { display: 'none' },
    '@width < 1020': { display: 'none' },
  },
  rim: {
    width: 424,
    height: 268,
    borderRadius: 20,
    padding: 4,
    boxShadow:
      '0 16px 28px rgba(46, 36, 22, 0.20), 0 3px 8px rgba(46, 36, 22, 0.09)',
    transition: { backgroundColor: 260 },
  },
  bezel: {
    flexGrow: 1,
    borderRadius: 16,
    backgroundColor: '#161512',
    padding: 9,
    paddingTop: 5,
    flexDirection: 'column',
  },
  cameraRow: { height: 8, alignItems: 'center', justifyContent: 'center' },
  camera: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#33312c' },
  wallpaper: {
    flexGrow: 1,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  wallClock: {
    fontFamily: '$serifFamily',
    fontSize: 34,
    color: 'rgba(255, 255, 255, 0.92)',
  },
  wallDate: {
    fontFamily: '$monoFamily',
    fontSize: 9.5,
    color: 'rgba(255, 255, 255, 0.6)',
  },
  hinge: {
    width: 496,
    height: 13,
    borderRadius: 7,
    marginTop: 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(46, 36, 22, 0.12)',
    backgroundImage:
      'linear-gradient(180deg, rgba(255,255,255,0.4), rgba(255,255,255,0) 60%)',
    boxShadow: '0 10px 22px rgba(46, 36, 22, 0.16)',
    transition: { backgroundColor: 260 },
  },
  groove: {
    width: 108,
    height: 5,
    borderRadius: 2,
    transition: { backgroundColor: 260 },
  },

  // The GL surface is a real X window stacked above everything the parent
  // paints, so it gets the stage to itself and the chips sit below it.
  stageGl: { flexGrow: 1, minHeight: 0 },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    '@width < 1020': { display: 'none' },
  },
  specChip: {
    paddingStart: 10,
    paddingEnd: 10,
    paddingTop: 5,
    paddingBottom: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '$hairline',
  },
  specChipText: { fontFamily: '$monoFamily', fontSize: 9.5, color: '$inkSoft' },
  summary: { fontFamily: '$monoFamily', fontSize: 11, color: '$inkFaint' },

  // -- sections -----------------------------------------------------------
  section: { flexDirection: 'column', gap: 14 },
  sectionEyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 2,
  },
  sectionIndex: { fontFamily: '$monoFamily', fontSize: 10.5, color: '$accent' },
  sectionEyebrow: {
    fontFamily: '$monoFamily',
    fontSize: 10.5,
    color: '$inkFaint',
  },
  rule: { height: 1, flexGrow: 1, backgroundColor: '$hairline' },
  sectionTitle: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  sectionTitleText: {
    fontFamily: '$serifFamily',
    fontSize: 24,
    color: '$ink',
  },
  sectionCaption: { fontSize: 12.5, color: '$inkSoft', lineHeight: 1.35 },

  // -- cards --------------------------------------------------------------
  group: { flexDirection: 'column', gap: 10 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingStart: 18,
    paddingEnd: 18,
    paddingTop: 14,
    paddingBottom: 14,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '$hairline',
    backgroundColor: '$surface',
    boxShadow: '0 1px 2px rgba(46, 36, 22, 0.05)',
    cursor: 'pointer',
    transition: { borderColor: 140, backgroundColor: 140 },
    ':hover': {
      borderColor: '$hairlineStrong',
      boxShadow:
        '0 7px 20px rgba(46, 36, 22, 0.10), 0 1px 3px rgba(46, 36, 22, 0.06)',
    },
    ':active': { backgroundColor: '$surfaceActive' },
  },
  cardOn: {
    borderColor: '$accent',
    boxShadow: '0 0 0 1px $accent, 0 8px 22px rgba(189, 93, 58, 0.14)',
    ':hover': {
      borderColor: '$accent',
      boxShadow: '0 0 0 1px $accent, 0 10px 26px rgba(189, 93, 58, 0.18)',
    },
  },
  cardBody: { flexGrow: 1, flexDirection: 'column', gap: 3 },
  cardName: { fontSize: 14, fontWeight: 600, color: '$ink' },
  cardDetail: { fontSize: 12, color: '$inkSoft' },
  cardPrice: {
    fontFamily: '$monoFamily',
    fontSize: 12,
    color: '$ink',
    textWrap: 'nowrap',
  },
  cardIncluded: { fontSize: 11.5, color: '$inkFaint', textWrap: 'nowrap' },

  // -- finishes -----------------------------------------------------------
  finishRow: { flexDirection: 'row', gap: 10 },
  finishCard: {
    flexGrow: 1,
    flexBasis: 0,
    flexDirection: 'column',
    alignItems: 'center',
    gap: 9,
    paddingTop: 16,
    paddingBottom: 13,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '$hairline',
    backgroundColor: '$surface',
    boxShadow: '0 1px 2px rgba(46, 36, 22, 0.05)',
    cursor: 'pointer',
    transition: { borderColor: 140, backgroundColor: 140 },
    ':hover': {
      borderColor: '$hairlineStrong',
      boxShadow:
        '0 7px 20px rgba(46, 36, 22, 0.10), 0 1px 3px rgba(46, 36, 22, 0.06)',
    },
    ':active': { backgroundColor: '$surfaceActive' },
  },
  swatch: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: 'rgba(46, 36, 22, 0.14)',
  },
  finishName: { fontSize: 12.5, fontWeight: 600, color: '$ink' },

  // -- extras -------------------------------------------------------------
  extraPriceCol: { alignItems: 'flex-end', gap: 6, flexDirection: 'column' },

  reassurance: { flexDirection: 'column', gap: 10, marginTop: 2 },
  reassuranceRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  reassuranceText: { fontSize: 12, color: '$inkSoft' },

  // -- footer -------------------------------------------------------------
  footer: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingStart: 32,
    paddingEnd: 32,
    paddingTop: 16,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderColor: '$hairline',
    backgroundColor: '$surface',
    boxShadow: '0 -4px 12px rgba(46, 36, 22, 0.06)',
  },
  totalCol: { flexDirection: 'column', gap: 4, flexGrow: 1 },
  totalRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  total: {
    fontSize: 24,
    fontWeight: 700,
    color: '$ink',
  },
  totalNote: { fontSize: 12, color: '$inkSoft' },
  deliveryNote: {
    fontFamily: '$monoFamily',
    fontSize: 10.5,
    color: '$inkFaint',
  },
  ghost: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingStart: 18,
    paddingEnd: 18,
    paddingTop: 10,
    paddingBottom: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '$hairlineStrong',
    color: '$ink',
    cursor: 'pointer',
    transition: { backgroundColor: 130, borderColor: 130 },
    ':hover': { backgroundColor: '$surfaceHover', borderColor: '$inkFaint' },
    ':active': { backgroundColor: '$surfaceActive' },
  },
  ghostText: { fontSize: 13.5, fontWeight: 500 },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingStart: 22,
    paddingEnd: 22,
    paddingTop: 11,
    paddingBottom: 11,
    borderRadius: 999,
    backgroundColor: '$accent',
    boxShadow: '0 3px 12px rgba(189, 93, 58, 0.30)',
    cursor: 'pointer',
    transition: { backgroundColor: 130 },
    ':hover': { backgroundColor: '$accentHover' },
    ':active': { backgroundColor: '$accentActive' },
  },
  primaryAdded: {
    backgroundColor: '$success',
    ':hover': { backgroundColor: '$success' },
    ':active': { backgroundColor: '$successActive' },
  },
  primaryText: {
    fontSize: 13.5,
    fontWeight: 600,
    color: 'white',
  },
});

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

const BAG_PATH =
  'M5.5 6.5V5a2.5 2.5 0 0 1 5 0v1.5M3.5 6.5h9l-.8 7a1.5 1.5 0 0 1-1.5 1.3H5.8a1.5 1.5 0 0 1-1.5-1.3z';

function BagIcon() {
  return (
    <svg viewBox="0 0 16 16" style={{ width: 15, height: 15 }}>
      <path
        d={BAG_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A check mark, drawn rather than typed.
 *
 * U+2713 lives in Dingbats, which the latin subsets above do not carry — so
 * `'✓ Added'` would be set from whatever the machine happens to have: a
 * different mark on every desktop, and an `fc-match` on the first paint that
 * uses it (~110ms, blocking, and the exact stall this page was profiled to
 * remove). A `<path>` is the same everywhere and resolves nothing.
 */
function Check({ size = 13, color = 'white' }) {
  return (
    <svg viewBox="0 0 16 16" style={{ width: size, height: size }}>
      <path
        d="M3 8.5l3.2 3L13 4.5"
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckDot({ on }) {
  return (
    <svg viewBox="0 0 22 22" style={{ width: 22, height: 22 }}>
      <circle
        cx={11}
        cy={11}
        r={10}
        fill={on ? '#bd5d3a' : 'none'}
        stroke={on ? '#bd5d3a' : '#c9c0aa'}
        strokeWidth={1.2}
      />
      {on ? (
        <path
          d="M6.5 11.5l3 3 6-6.5"
          fill="none"
          stroke="white"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}

function SectionHeader({ index, eyebrow, title, caption }) {
  return (
    <box style={{ flexDirection: 'column', gap: 7 }}>
      <box style={s.sectionEyebrowRow}>
        <text style={s.sectionIndex}>{index}</text>
        <text style={s.sectionEyebrow}>{eyebrow.toUpperCase()}</text>
        <box style={s.rule} />
      </box>
      <box style={s.sectionTitle}>
        <text style={s.sectionTitleText}>{title}</text>
      </box>
      {caption ? <text style={s.sectionCaption}>{caption}</text> : null}
    </box>
  );
}

/** The product out of boxes — the fallback, and what every machine without a
 *  shader-capable GL context sees. The finish sets three solid colours (which
 *  transition) and one gradient (which snaps — a wallpaper change reads as a
 *  change, not a fade). */
function LaptopFlat({ finish }) {
  return (
    <box style={s.stage} data-testname="stage" aria-hidden>
      <box style={[s.rim, { backgroundColor: finish.body }]}>
        <box style={s.bezel}>
          <box style={s.cameraRow}>
            <box style={s.camera} />
          </box>
          <box style={[s.wallpaper, { backgroundImage: finish.wallpaper }]}>
            <text style={s.wallClock}>9:41</text>
            <text style={s.wallDate}>TUE 26 AUG</text>
          </box>
        </box>
      </box>
      <box style={[s.hinge, { backgroundColor: finish.edge }]}>
        <box style={[s.groove, { backgroundColor: finish.well }]} />
      </box>
    </box>
  );
}

function OptionCard({ option, on, onSelect, nodeRef }) {
  return (
    <box
      ref={nodeRef}
      style={[s.card, on && s.cardOn]}
      focusable
      role="radio"
      aria-label={option.name}
      aria-checked={on}
      onClick={onSelect}
    >
      <box style={s.cardBody}>
        <text style={s.cardName}>{option.name}</text>
        <text style={s.cardDetail}>{option.detail}</text>
      </box>
      {option.price ? (
        <text style={s.cardPrice}>{`+${usd(option.price)}`}</text>
      ) : (
        <text style={s.cardIncluded}>Included</text>
      )}
    </box>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

// `ackMs` is how long the "Added" acknowledgment stands before the button
// offers itself
// again. A seam rather than a constant because a test has to hold the
// moment still — the in-process server is slower than 1.8 real seconds.
export function Configurator({
  initial = DEFAULT_CONFIG,
  onAddToBag,
  ackMs = 1800,
}) {
  const fonts = useShippedFonts();
  const palette = useMemo(() => makePalette(fonts), [fonts]);

  const [config, setConfig] = useState(initial);
  // The 3D panel, and the ladder down from it. `useSupports('shaders')` is
  // "could this connection run GLSL"; `glGone` is what the surface itself
  // said when it tried — an indirect backend, a refused visual, a shader that
  // would not compile. Either one puts the flat laptop back.
  const shaders = useSupports('shaders');
  const [glGone, setGlGone] = useState(null);
  const use3d = shaders && !glGone;
  // A ref rather than state on purpose: the scroll handler pushes straight
  // into the GL panel, so scrolling the options does not re-render them. The
  // screen capture goes the same way, for the same reason.
  const scrollBind = useRef({ set: null, setPage: null });
  const windowRef = useTopLevelWindow();
  const optionsRef = useRef(null);
  const captureSeq = useRef(0);
  const recapture = useRef(null);
  // The live pump: `dirty` is "the page has moved since the last read" and
  // `busy` is "a read is already on the wire". One capture at a time, and the
  // next one is asked for from the frame that finished the last — which is
  // what keeps this a chase rather than a queue.
  const screenDirty = useRef(true);
  const screenBusy = useRef(false);
  const pump = useRef(null);
  const [bag, setBag] = useState(0);
  const [added, setAdded] = useState(false);
  const [saved, setSaved] = useState(false);
  const addedTimer = useRef(null);
  const cardRefs = useRef(new Map());
  useEffect(
    () => () => {
      clearTimeout(addedTimer.current);
      clearTimeout(recapture.current);
    },
    [],
  );

  const total = priceOf(config);
  const finish = CATALOG.finishes.find((f) => f.id === config.finish);

  const choose = (groupId, optionId) =>
    setConfig((prev) => ({ ...prev, [groupId]: optionId }));
  const toggleExtra = (id) =>
    setConfig((prev) => ({
      ...prev,
      extras: prev.extras.includes(id)
        ? prev.extras.filter((x) => x !== id)
        : [...prev.extras, id],
    }));

  /**
   * Read the configuration panel back off the window and hand it to the
   * laptop, so the screen in the render is running the page it is part of.
   *
   * This is `getImageData` on the window's own 2d context, which works for
   * one reason worth stating: the panel is ordinary 2D content in the
   * window's backing pixmap. The GL child is the thing that cannot be read
   * this way — its pixels never live in an X drawable at all — so the
   * capture goes one way and never the other, and there is no recursion to
   * guard against. The rect is the pane's, which is also what keeps the
   * laptop out of its own screen: the render is in the hero, and the hero is
   * not in the rect.
   */
  const capture = useCallback(() => {
    const win = windowRef.current?.window;
    const pane = optionsRef.current;
    if (!win || !pane?.abs?.width || !use3d) return;
    // Only the band the screen will show: the shader crops to `SCREEN_ASPECT`,
    // so reading the whole pane pushes half the pixels across the wire to be
    // discarded. Centred, because that is where the crop is centred.
    const full = pane.abs;
    const width = full.width;
    const height = Math.min(full.height, Math.round(width / SCREEN_ASPECT));
    const x = full.x;
    const y = full.y + Math.round((full.height - height) / 2);
    let ctx;
    try {
      ctx = win.getContext('2d');
    } catch {
      return; // no context to read: the screen keeps its gradient
    }
    screenBusy.current = true;
    ctx.getImageData(x, y, width, height, (err, img) => {
      screenBusy.current = false;
      if (!err && img) {
        scrollBind.current.setPage?.({
          // a texture wants plain bytes, and `data` is a clamped view
          data: new Uint8Array(img.data.buffer ?? img.data),
          width,
          height,
          seq: ++captureSeq.current,
        });
      }
      // anything that moved while that was in flight gets the next frame
      if (screenDirty.current) pump.current?.();
    });
  }, [windowRef, use3d]);

  /**
   * Ask for a capture on the frame after the next one, if a read is owed and
   * none is running.
   *
   * **Two frames, not one, and the reason is ordering.** A scroll dispatches
   * `onScroll` and *then* invalidates, so a frame requested from the handler
   * is queued ahead of the repaint it was told about — capture there and the
   * pixels read are the ones from before the scroll. The laptop's screen then
   * trails the panel by one gesture, which looks like a stale texture and is
   * really a race. The second frame is after the paint, always.
   */
  pump.current = useCallback(() => {
    const win = windowRef.current?.window;
    if (!win?.requestAnimationFrame || screenBusy.current) return;
    win.requestAnimationFrame(() => {
      win.requestAnimationFrame(() => {
        if (!screenDirty.current || screenBusy.current) return;
        screenDirty.current = false;
        capture();
      });
    });
  }, [capture, windowRef]);

  /** Something on the page moved. */
  const screenChanged = useCallback(() => {
    screenDirty.current = true;
    if (SCREEN_REFRESH === 'live') pump.current?.();
    else {
      clearTimeout(recapture.current);
      recapture.current = setTimeout(capture, 140);
    }
  }, [capture]);

  // On the frame *after* a change, so the panel has already repainted into
  // the pixmap this reads: the renderer asked for that frame during the
  // commit, so a callback registered here runs behind its.
  useEffect(() => {
    screenChanged();
  }, [config, use3d, screenChanged]);

  /** Arrow keys rove the radio group: move the choice, move the focus. */
  const roving = (group) => (ev) => {
    const step =
      ev.keysym === XK_RIGHT || ev.keysym === XK_DOWN
        ? 1
        : ev.keysym === XK_LEFT || ev.keysym === XK_UP
          ? -1
          : 0;
    if (!step) return;
    ev.preventDefault();
    const ids = group.options.map((o) => o.id);
    const at = ids.indexOf(config[group.id]);
    const next = ids[(at + step + ids.length) % ids.length];
    choose(group.id, next);
    cardRefs.current.get(`${group.id}:${next}`)?.focus();
  };

  const addToBag = () => {
    setBag((n) => n + 1);
    setAdded(true);
    clearTimeout(addedTimer.current);
    addedTimer.current = setTimeout(() => setAdded(false), ackMs);
    onAddToBag?.(config, total);
  };

  const summary = [
    finish.name,
    ...CATALOG.groups.map(
      (g) => g.options.find((o) => o.id === config[g.id]).name,
    ),
  ]
    .join(' · ')
    .toUpperCase();

  return (
    // `colorScheme="light"` pins the design: this page is one deliberate
    // palette, and following the desktop's dark scheme would repaint it into
    // colours nobody chose. A raw `theme` prop is not enough here — see
    // "What does not work" above.
    <ThemeProvider value={palette} colorScheme="light">
      <box style={s.root}>
        {/* ------------------------------------------------ top bar ------- */}
        <box style={s.topbar}>
          <box style={s.brandSide}>
            <text style={s.brand}>
              Meridian
              <text style={s.brandDot}>.</text>
            </text>
          </box>
          <box style={s.nav} aria-hidden>
            {['Store', 'Meridian 14', 'Compare', 'Support'].map((label) => (
              <box key={label} style={{ cursor: 'pointer' }}>
                <text style={s.navLink}>{label}</text>
              </box>
            ))}
          </box>
          <box style={s.bagSide}>
            <box
              style={s.bag}
              role="status"
              aria-label={`${bag} in bag`}
              data-testname="bag"
            >
              <BagIcon />
              <text style={s.bagLabel}>Bag</text>
              {bag > 0 ? (
                <box style={s.bagCount}>
                  <text style={s.bagCountText}>{String(bag)}</text>
                </box>
              ) : null}
            </box>
          </box>
        </box>

        <box style={s.content}>
          {/* ---------------------------------------------- hero ---------- */}
          <box style={s.hero}>
            <box style={s.eyebrowRow}>
              <box style={s.newPill}>
                <text style={s.newPillText}>NEW</text>
              </box>
              <text style={s.eyebrow}>CONFIGURE YOUR MERIDIAN 14</text>
            </box>
            <box style={{ flexDirection: 'column', gap: 2 }}>
              <text style={s.h1}>The Meridian 14.</text>
              <text style={s.h1}>
                Made <text style={s.h1Accent}>yours.</text>
              </text>
            </box>
            <text style={s.sub}>
              Fourteen inches, 1.29 kilograms, a 3.2K OLED panel and a day of
              battery. Pick the silicon, the memory and the finish — the price
              follows along.
            </text>

            {use3d ? (
              <box style={s.stage} data-testname="stage" aria-hidden>
                <LaptopGL
                  finish={finish}
                  bind={scrollBind}
                  clearColor={PAPER}
                  style={s.stageGl}
                  onUnavailable={setGlGone}
                  // A wheel over the render scrolls the configuration, which
                  // is what the reader is looking at while they turn it. The
                  // surface is not inside the pane — it is the other column —
                  // so the default action has nothing to scroll, and this is
                  // where it goes instead.
                  onWheel={(ev) => optionsRef.current?.scrollBy(ev.deltaY)}
                />
              </box>
            ) : (
              <LaptopFlat finish={finish} />
            )}

            <box style={{ flexDirection: 'column', gap: 12 }}>
              <box style={s.chipsRow}>
                {[
                  '3.2K OLED · 120 HZ',
                  '78 WH BATTERY',
                  '1.29 KG',
                  'WI-FI 7',
                ].map((spec) => (
                  <box key={spec} style={s.specChip}>
                    <text style={s.specChipText}>{spec}</text>
                  </box>
                ))}
              </box>
              <text style={s.summary} data-testname="summary">
                {summary}
              </text>
            </box>
          </box>

          {/* ---------------------------------------------- options ------- */}
          <box
            style={s.options}
            ref={optionsRef}
            data-testname="options"
            // a hover moves a card's border, which is a repaint the screen
            // should show; ntk coalesces motion to one event per frame
            onMouseMove={screenChanged}
            onScroll={(ev) => {
              const travel = ev.contentHeight - ev.viewportHeight;
              scrollBind.current.set?.(travel > 0 ? ev.scrollY / travel : 0);
              screenChanged();
            }}
          >
            <box style={s.section}>
              <SectionHeader
                index="01"
                eyebrow="Finish"
                title="Anodized, three ways."
              />
              <box
                style={s.finishRow}
                role="radiogroup"
                aria-label="Finish"
                onKeyDown={roving({ id: 'finish', options: CATALOG.finishes })}
              >
                {CATALOG.finishes.map((f) => {
                  const on = config.finish === f.id;
                  return (
                    <box
                      key={f.id}
                      ref={(node) => {
                        if (node) cardRefs.current.set(`finish:${f.id}`, node);
                        else cardRefs.current.delete(`finish:${f.id}`);
                      }}
                      style={[s.finishCard, on && s.cardOn]}
                      focusable
                      role="radio"
                      aria-label={f.name}
                      aria-checked={on}
                      onClick={() => choose('finish', f.id)}
                    >
                      <box
                        style={[
                          s.swatch,
                          {
                            backgroundColor: f.body,
                            backgroundImage:
                              'linear-gradient(145deg, rgba(255,255,255,0.55), rgba(255,255,255,0) 55%)',
                          },
                        ]}
                      />
                      <text style={s.finishName}>{f.name}</text>
                    </box>
                  );
                })}
              </box>
            </box>

            {CATALOG.groups.map((group, i) => (
              <box key={group.id} style={s.section}>
                <SectionHeader
                  index={String(i + 2).padStart(2, '0')}
                  eyebrow={group.eyebrow}
                  title={group.title}
                  caption={group.caption}
                />
                <box
                  style={s.group}
                  role="radiogroup"
                  aria-label={group.eyebrow}
                  onKeyDown={roving(group)}
                >
                  {group.options.map((option) => (
                    <OptionCard
                      key={option.id}
                      option={option}
                      on={config[group.id] === option.id}
                      onSelect={() => choose(group.id, option.id)}
                      nodeRef={(node) => {
                        const key = `${group.id}:${option.id}`;
                        if (node) cardRefs.current.set(key, node);
                        else cardRefs.current.delete(key);
                      }}
                    />
                  ))}
                </box>
              </box>
            ))}

            <box style={s.section}>
              <SectionHeader
                index="05"
                eyebrow="Extras"
                title="Only if you want them."
              />
              <box style={s.group}>
                {CATALOG.extras.map((extra) => {
                  const on = config.extras.includes(extra.id);
                  return (
                    <box
                      key={extra.id}
                      style={[s.card, on && s.cardOn]}
                      focusable
                      role="checkbox"
                      aria-label={extra.name}
                      aria-checked={on}
                      onClick={() => toggleExtra(extra.id)}
                    >
                      <box style={s.cardBody}>
                        <text style={s.cardName}>{extra.name}</text>
                        <text style={s.cardDetail}>{extra.detail}</text>
                      </box>
                      <box style={s.extraPriceCol}>
                        <text
                          style={s.cardPrice}
                        >{`+${usd(extra.price)}`}</text>
                        <CheckDot on={on} />
                      </box>
                    </box>
                  );
                })}
              </box>
            </box>

            <box style={s.reassurance} aria-hidden>
              {[
                'Free delivery, and free returns for 30 days.',
                'Trade in your old laptop for credit.',
              ].map((line) => (
                <box key={line} style={s.reassuranceRow}>
                  <svg viewBox="0 0 16 16" style={{ width: 14, height: 14 }}>
                    <path
                      d="M3 8.5l3.2 3L13 4.5"
                      fill="none"
                      stroke="#2f7a4d"
                      strokeWidth={1.6}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <text style={s.reassuranceText}>{line}</text>
                </box>
              ))}
            </box>
          </box>
        </box>

        {/* ------------------------------------------------ footer -------- */}
        <box style={s.footer}>
          <box style={s.totalCol}>
            <box style={s.totalRow}>
              <text style={s.total} data-testname="total">
                {usd(total)}
              </text>
              <text style={s.totalNote}>
                {`or ${usd(Math.round(total / 12))}/mo. for 12 months`}
              </text>
            </box>
            <text style={s.deliveryNote} data-testname="delivery">
              {`${deliveryOf(config).toUpperCase()} · FREE RETURNS`}
            </text>
          </box>
          <box
            style={s.ghost}
            focusable
            role="button"
            aria-label="Save for later"
            onClick={() => setSaved((v) => !v)}
          >
            <text style={s.ghostText}>
              {saved ? 'Saved' : 'Save for later'}
            </text>
            {saved ? <Check size={12} color="#2f7a4d" /> : null}
          </box>
          <box
            style={[s.primary, added && s.primaryAdded]}
            focusable
            role="button"
            aria-label="Add to Bag"
            onClick={addToBag}
          >
            {added ? <Check /> : null}
            <text style={s.primaryText}>{added ? 'Added' : 'Add to Bag'}</text>
          </box>
        </box>
      </box>
    </ThemeProvider>
  );
}

export function App(props) {
  return (
    <window
      title="Meridian Store"
      width={1220}
      height={840}
      minWidth={680}
      minHeight={540}
      wmClass="com.example.x11configurator"
      style={{ backgroundColor: PAPER, flexDirection: 'column' }}
    >
      <Configurator {...props} />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN) {
  // `desktop: false` turns off the three followers that talk to the session
  // bus — appearance, the accessibility bridge and the global menu — and so
  // nothing dials it at startup (docs/desktop.md). This page owns its
  // palette outright (`colorScheme="light"` below), so following the
  // desktop's would only overwrite colours somebody chose; and on macOS the
  // bus lookup is a *synchronous* `launchctl` spawn, ~150ms of a first paint
  // spent on something this page never reads.
  //
  // Not a default to copy blindly: an app that wants to belong on the
  // desktop wants the opposite, and turning the bridge off is what a screen
  // reader would notice on a Linux desktop.
  // `glPolicy: 'direct'` rather than `'auto'`: this scene is GLSL and a
  // framebuffer object, so the indirect backend cannot draw it at all —
  // asking for direct and being told no is a cheaper, clearer answer than
  // getting an indirect context and discovering it in `onCreated`. Strict is
  // safe here: without direct, ntk reports no backend, the `<glarea>`'s
  // `onError` fires, and the flat laptop takes over. `createRoot` itself
  // never throws over it.
  const root = await createRoot({ desktop: false, glPolicy: 'direct' });
  root.render(<App />);
}
