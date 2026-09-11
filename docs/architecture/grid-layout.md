# Grid layout: CSS grid on the layout seam

_Design record, 2026-09-11. It began the same day as a feasibility study
with a prototype, on the branch that added the layout seam
([custom-layout.md](custom-layout.md)); this is the record of what was
built from it. Measured in the in-process X server with real text shaping
(KaTeX Main), on one machine (Apple M1 Pro, node 26), and against Chrome 152. The outside facts in §8 are as of the date and linked; they will
drift._

_[styling.md](../styling.md#grid) is the reference for the style
properties; this is why they are the shape they are._

---

## 0. TL;DR

- **What:** `display: 'grid'` lays a box's children out by CSS Grid's
  placement algorithm (css-grid-2 §8.5) and its track sizing algorithm
  (§12), inside the layout pass, as a layout on the seam. `layout: 'grid'`
  is the same request; a box whose `display` and `layout` disagree is
  reported and laid out as flexbox.
- **The style is CSS's, and flat** (§2): `gridTemplateColumns`,
  `gridTemplateRows`, `gridTemplateAreas`, `gridAutoColumns`,
  `gridAutoRows`, `gridAutoFlow` and `justifyItems` on the box; `gridColumn`,
  `gridRow`, `gridArea` and `justifySelf` on a child. The names every
  CSS-in-JS library and React DOM write, and the ones yoga's own grid uses.
- **Held to Chrome** (§4): a 400-case corpus Chrome laid out is part of the
  test suite and lays out here within a pixel of it, but for one case where
  Chrome parts ways with the spec and this grid keeps to the spec.
- **Cheaper than the flexbox that does the nearest thing** on every frame
  measured (§3) — 300 cards: mount 59 ms against 63, one card's text
  changing 2.1 ms against 13.1, a live resize 20.3 ms against 25.8.
- **Left out** (§5): subgrid, which this seam cannot carry; baselines;
  named lines; the `grid` and `grid-template` shorthands; the second column
  pass.

## 1. What grid is for here

Flexbox lines things up in one direction. The layouts an app here reached
for and could not write:

- **A form.** Labels in a column as wide as the widest label, fields taking
  the rest. Flexbox did it with a fixed label width, which a translation
  breaks, or by measuring in an effect, a frame late
  ([custom-layout.md](custom-layout.md#1-why-the-core)).
- **A dashboard.** Tiles spanning columns and rows, packed densely.
- **A gallery.** As many columns as fit, each row as tall as its tallest
  item. `flexWrap` nearly does it, but the last row's items stretch across
  the whole width.

Those are the three cases measured in §3.

## 2. API

```jsx
<box
  style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12 }}
>
  <text>Name</text>
  <textinput />
  <box style={{ gridColumn: '1 / -1' }} />
</box>
```

### Flat, and CSS's names

The study proposed the shape a registered layout has —
`layout: { name: 'grid', columns: 'auto 1fr' }` on the box and
`layoutItem: { column: 'span 2' }` on a child — and it read as heavy,
because it is the one thing nobody else does. The prior art (§8) splits in
two:

- **Style objects use CSS's own names, flat.** Objects in emotion and
  styled-components, StyleX, vanilla-extract, MUI's `sx`, Chakra's and
  Panda's style props, and React DOM's `style` all write
  `display: 'grid', gridTemplateColumns: '…'` and `gridColumn: 'span 2'`.
  None of them shortens anything inside the object. Yoga's own grid,
  unreleased, names its style `gridTemplateColumns` too, and CSS's masonry
  shipped as `display: grid-lanes`, reusing grid's properties.
- **What is short lives a layer up**: Tailwind's `grid-cols-3` and
  `col-span-2`, or a component's props — Radix's `<Grid columns="3">`,
  Chakra's `<SimpleGrid columns={3}>`, Panda's `grid({ columns: 3 })`.

So the style here is CSS's longhands, flat. A grid copied from a React DOM
codebase lays out as written; a style array or a query block can change one
property without restating the rest — `flattenStyle` replaces a `layout`
object whole, so with the options bag a block that changed the columns had
to restate the name and the areas too; and the day yoga's grid ships,
handing it the work changes no style. The terse spelling belongs in the
class-string layer the compact-styles prototype proposes, where Tailwind's
names carry over as they are.

**`display: 'grid'`, and `layout: 'grid'` beside it.** Every system
above turns grid on with `display` — CSS, Tailwind's `grid` class, React
DOM, yoga's `Display.Grid`, `display: grid-lanes` — so `display` does here
too. `layout` stays the name every layout goes by, the Houdini role
(`display: layout(name)` in CSS), and `layout: 'grid'` asks for the same
grid. They disagree when `display: 'grid'` stands beside another layout, or
`layout: 'grid'` beside `display: 'flex'`; the box is reported and laid out
as flexbox until they agree (`layoutOf`, src/layouts.js). `display: 'flex'`
beside `masonry` is no disagreement: it says the box is shown, which is all
`display` said before grid was one of its values, and the docs' own
`'@container …': { display: 'flex' }` to show a box again relies on it.

A registered layout keeps `layout: { name, … }` and `layoutItem`: it cannot
claim global style names. That is the asymmetry flexbox already has, whose
properties are flat because they are CSS's.

### The values

| on the box                                | CSS                   |                                                                                                    |
| ----------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| `gridTemplateColumns`, `gridTemplateRows` | `grid-template-*`     | px (logical), %, fr, `auto`, `min-content`, `max-content`, `minmax()`, `fit-content()`, `repeat()` |
| `gridTemplateAreas`                       | `grid-template-areas` | one quoted string per row, or an array of the rows                                                 |
| `gridAutoColumns`, `gridAutoRows`         | `grid-auto-*`         | the sizes an implicit track takes, in turn                                                         |
| `gridAutoFlow`                            | `grid-auto-flow`      | `row`, `column`, and `dense`                                                                       |
| `justifyItems`                            | `justify-items`       | `stretch`, `flex-start`, `center`, `flex-end`                                                      |
| **on a child**                            |                       |                                                                                                    |
| `gridColumn`, `gridRow`                   | `grid-column/row`     | `2`, `'2 / 4'`, `'span 2'`, `'2 / span 3'`, `'1 / -1'`                                             |
| `gridArea`                                | `grid-area`           | a name from `gridTemplateAreas`, or four lines                                                     |
| `justifySelf`                             | `justify-self`        | `auto`, and `justifyItems`' values                                                                 |

`gap`, `columnGap`, `rowGap`, `alignItems`, `alignSelf`, `justifyContent`
and `alignContent` are the box's and the child's own flex properties, and
mean for a grid what they mean in CSS.

- **A number is a count in a template**: `gridTemplateColumns: 3` is
  `repeat(3, minmax(0, 1fr))`. Every layer that shortens grid means that by
  a number, and compiles it to exactly that string — Tailwind's
  `grid-cols-3`, Radix's `columns="3"`, Chakra's and Mantine's
  `SimpleGrid`, Panda's `grid()` pattern. A number that is not a length is
  no stranger here than `maxLines: 3` or `flex: 1`, and CSS gives a bare
  number no meaning in a track list. On `gridAutoRows` a number is a length
  — an implicit track has a size and never a count — and on `gridColumn` a
  line, as in CSS and in React DOM, which never gives it `px`.
- **The alignment keywords are this renderer's**, the ones `alignItems`
  takes: `flex-start` and `flex-end` where CSS grid writes `start` and
  `end`. One spelling per concept; the error names the one to write.
- **Checked where written.** The style validator runs the layout's own
  parsers in development (`validateValue`, src/styles.js), so a track list
  that would not lay out is an error naming the property and the fix — a
  unitless length says to write `px` and that a bare number is a count — not
  a layout that throws and falls back to flexbox.

### What the seam gained

Two things, both general:

- **`LayoutChild.style`**, the child's resolved style: what a grid places a
  child by and aligns it with. A registered layout can read a child's
  `alignSelf` the same way.
- **`info.report(message, consequence)`**, to say a mistake the algorithm
  can lay out around — a `gridArea` naming no area, `layoutItem` on a grid's
  child — once, the way a bad style value is said. A throw stays for what
  cannot be laid out.

And one thing the funnel had to learn: a grid's properties are not yoga's,
so nothing dirtied a grid whose `gridTemplateColumns` changed.
`_retarget` compares `GRID_CONTAINER_PROPS` and `GRID_ITEM_PROPS` and asks
the host again, as it already did for `layoutItem`.

## 3. Performance

`npm run bench:grid`: layout time per frame, `WindowNode._layoutStep`'s.
The changes are an item's text going from two words to forty and back;
changes and resizes are medians.

| case                     | flexbox |    grid | masonry |
| ------------------------ | ------: | ------: | ------: |
| form — mount             | 36.4 ms | 28.6 ms |         |
| form — one text changed  | 13.9 ms |  3.5 ms |         |
| form — resized 1000↔900  |  5.2 ms |  2.9 ms |         |
| form — live resize       |  7.6 ms |  6.8 ms |         |
| cards — mount            | 63.0 ms | 59.3 ms | 75.3 ms |
| cards — one text changed | 13.1 ms |  2.1 ms |  1.8 ms |
| cards — resized 1000↔900 | 20.2 ms |  5.2 ms |  4.3 ms |
| cards — live resize      | 25.8 ms | 20.3 ms | 27.9 ms |
| dashboard — mount        |         | 15.2 ms |         |
| dashboard — one changed  |         |  2.2 ms |         |
| dashboard — live resize  |         |  4.5 ms |         |

The form is 200 rows of `auto 1fr` against flexbox rows with a fixed label
width; the cards 300 cards of 9 yoga nodes each in
`repeat(auto-fill, minmax(200px, 1fr))` against a flex-wrap row with a 200px
basis; the dashboard 120 tiles in `repeat(6, 1fr)`, dense, a third two
columns wide and a fifth two rows tall.

**Two resizes, and the difference matters.** The study measured only the
first: a window resized back and forth between two widths, which the seam
answers from what each child said at those widths before. A live resize —
a width nothing has been asked at, every frame, which is what a drag is —
asks every child again; there grid is level with flexbox rather than four
times cheaper. 801 child-tree layouts a frame for the 300 cards, under
three a card.

**Why it is cheaper than the prototype**, whose cards took 92 ms to mount
and 36 ms a live-resize frame: a track asks its children for sizes only
when its sizing function is intrinsic, as the spec has it. The gallery's
`minmax(200px, 1fr)` has a fixed minimum, so its columns ask nothing — no
max-content layout of any card — and each card is asked its height once,
at the snapped width it is then laid out at, which is the question the
placement's own check asks.

**What the seam still costs**, found building this and left for changes of
their own:

- `probeHeightFloors` asks a host its height at its **border-box** width
  (`_heightForWidth`), where yoga's measure is given the content box: a
  grid with padding is asked at widths nothing is drawn at, each a layout
  of every child. Masonry's four layouts a card a live-resize frame are
  mostly that.
- `intrinsicSizes()` lays a child out unconstrained for its max-content
  width even when only the minimum is read.
- The floors pass asks a host its height at its narrowest, which lays
  every child out at a width no frame uses.

## 4. Held to Chrome

`test/grid-conformance.test.js` lays out 400 grids that Chrome laid out
first (`scripts/grid-fixture.mjs`, into `test/fixtures/grid-chrome.json`)
and compares every item's rect, within a pixel. The grids are seeded and
text-free — an item holds a box of a fixed size or a wrapping row of fixed
chips — so both engines agree on every content size and the fixture is the
same on any machine. Half the cases pile features together; the other half
add exactly one of the harder ones — negative lines, a span wider than the
grid, a line past it, self and content alignment, a definite height, column
flow — to a case otherwise made of plain ones, so each feature has cases of
its own.

**399 of 400 match.** The one that does not is a case where Chrome and the
spec part ways, and this grid keeps to the spec: an auto-placed item whose
span in the flow's direction reaches several tracks past the explicit grid.
The spec's cursor finds it room across the grid's edge; Chrome puts it
after everything placed. Probed on its own: a straddle of one track lays
out as Chrome does, in either flow; the cases that differ reach four or
five tracks past it.

Built against three more corpora of the same kind — 1,000 cases — it
matched all but three, and those three are the one difference snapping the
lines makes: Chrome lays a track out at 94.66 px and wraps a row of chips
that fits in the 95 px here. The prototype, on the first two of those
corpora, matched 97–99% of the cases using only what it claimed and 59–70%
overall: negative lines threw, and neither self nor content alignment nor
column flow was there.

**The lines are snapped, not the items.** Tracks are sized exactly, and
each track line is rounded to a whole pixel (`trackLines`); an item's rect
runs from one rounded line to another. Rounding each item's own position
and width, which the prototype did, left a seam of a pixel between
neighbours in `1fr 1fr 1fr` and drew a 7px gap as 6. It would also lay a
child's tree out at a fraction, the input yoga divides a rounding residue
by (issue #411).

`test/grid.test.js` holds the cases worth a name — and the renderer's
side: the style, the disagreement between `display` and `layout`,
validation, the reports, a grid following its style from frame to frame.
Each of fifteen deliberate breaks of the implementation fails one of them.

## 5. What is left out

- **Subgrid.** Impossible on this seam: a subgrid's items take part in the
  parent's track sizing, and an algorithm sees a child only as something to
  measure. The seam would have to hand an algorithm its grandchildren. A
  table whose rows share their columns is where it would pay.
- **Baselines** (`alignItems: 'baseline'` in a row): yoga's baseline
  function, which the seam does not expose. Treated as `flex-start`.
- **Named lines** (`[full-start] 1fr`): an error naming them; an area is
  the way to name a place.
- **The `grid`, `grid-template` and `place-*` shorthands**: one spelling
  per concept, and the longhands are the ones every CSS-in-JS library
  writes.
- **The second column pass** (§12.1 step 3): sizing the columns again when
  an item's min-content contribution changed once the rows were sized. It
  matters for items whose width follows their height.
- **An auto repeat counted against a maximum width**: CSS counts
  `repeat(auto-fill, …)` against `max-width` when the width is indefinite;
  here it repeats once there.
- **Percentage gaps**, and `order`.

## 6. Complexity

`src/grid.js` is about 1,400 lines of code, 1,650 with its comments: the
parsers, placement with implicit tracks on both sides, the track sizing
algorithm with the spec's distribution of a spanning item's space —
base sizes and growth limits in their separate steps, infinitely growable
tracks, `fit-content()` caps — and alignment. For scale, Taffy's grid
module is 7,508 lines (§8): the above, its corners and their tests.

## 7. Why not an engine

- **Not yoga's.** Its grid landed in March 2026 as an API with no layout
  algorithm, the algorithm is in open PRs, and `yoga-layout` has not
  released on npm since December 2024. When it ships, a grid named with
  CSS's properties can hand it the work without a style changing.
- **Not Taffy.** Its JS and WASM builds are third-party and 0.9–1.3 MB,
  against `yoga-layout`'s 224 KB, and it would be a second layout engine,
  with its own text-measuring bridge, for one algorithm.

## 8. Outside facts

As of 2026-09-11.

- **The spec.** [css-grid-2 §12](https://www.w3.org/TR/css-grid-2/#algo-grid-sizing),
  the grid sizing algorithm, and §8.5, placement.
- **Prior art for the style.**
  - Tailwind v4: `grid-cols-<n>` compiles to `repeat(<n>, minmax(0, 1fr))`,
    `col-span-full` to `1 / -1`; arbitrary track lists are
    `grid-cols-[200px_1fr]`; there are no area utilities in core
    ([grid-template-columns](https://tailwindcss.com/docs/grid-template-columns),
    [grid-column](https://tailwindcss.com/docs/grid-column),
    [discussion #2634](https://github.com/tailwindlabs/tailwindcss/discussions/2634)).
  - Radix Themes' `<Grid columns="3">` compiles a count to
    `repeat(3, minmax(0, 1fr))`
    ([grid.props.tsx](https://github.com/radix-ui/themes/blob/HEAD/packages/radix-ui-themes/src/components/grid.props.tsx));
    so do Chakra's `SimpleGrid`
    ([simple-grid.tsx](https://github.com/chakra-ui/chakra-ui/blob/HEAD/packages/react/src/components/simple-grid/simple-grid.tsx)),
    Mantine's `SimpleGrid` and Panda's `grid()` pattern
    ([patterns](https://panda-css.com/docs/concepts/patterns)); Chakra's
    and Panda's own docs write `gridTemplateColumns` in full in a style
    object. Theme UI's `<Grid width={128}>` is
    `repeat(auto-fit, minmax(128px, 1fr))`
    ([Grid](https://theme-ui.com/components/grid)).
  - Yoga's grid, unreleased, names its style `gridTemplateColumns`
    (`yoga/style/Style.h` on react/yoga's main).
  - CSS's masonry shipped in Safari 26 as `display: grid-lanes`, reusing
    `grid-template-columns`, `gap` and `grid-column: span`
    ([WebKit](https://webkit.org/blog/17660/introducing-css-grid-lanes/)).
- **Yoga.** Grid has been requested since 2019
  ([react/yoga#867](https://github.com/react/yoga/issues/867)). Part 1 of
  nine (#1893: style types, the C and JS API, `Display.Grid`) landed on
  2026-03-05 with no layout algorithm
  ([07524851f54b](https://github.com/react/yoga/commit/07524851f54b)); the
  algorithm is in open PRs #1894, #1923 and
  [#1994](https://github.com/react/yoga/pull/1994). `yoga-layout` 3.2.1
  (2024-12-13) is still the latest release on
  [npm](https://www.npmjs.com/package/yoga-layout).
- **Taffy.** `src/compute/grid` is 7,508 lines at
  [a1c3f8f](https://github.com/DioxusLabs/taffy/tree/a1c3f8fb3e2c978c3a4f062873bdb16d5eaf6cfd/src/compute/grid);
  subgrid ([#468](https://github.com/DioxusLabs/taffy/issues/468)) is an
  open issue. There is no official JS package
  ([#394](https://github.com/DioxusLabs/taffy/pull/394)); third-party
  builds are [`taffy-layout`](https://www.npmjs.com/package/taffy-layout),
  902 KB unpacked, and
  [`@taffyjs/wasm`](https://www.npmjs.com/package/@taffyjs/wasm), 1.34 MB.
- **Chromium.** LayoutNG caches a grid item's measure and layout passes
  ([LayoutNG](https://developer.chrome.com/docs/chromium/layoutng)); Firefox's
  nested grids cost exponentially in their depth until measurement caches
  fixed it ([1591366](https://bugzilla.mozilla.org/show_bug.cgi?id=1591366),
  [1682686](https://bugzilla.mozilla.org/show_bug.cgi?id=1682686)).

## 9. The scripts

- `scripts/grid-fixture.mjs` regenerates the Chrome fixture (`CHROME=` to
  point it at a browser).
- `scripts/bench/grid/bench.mjs` is the table in §3 (`npm run bench:grid`).
- `scripts/bench/grid/breakdown.mjs` is one frame taken apart, run by run,
  with what the seam remembered for each child and what it had to ask
  again.
