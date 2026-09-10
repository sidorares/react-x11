# Grid layout: what a `grid` on the layout seam would take

_Feasibility study, 2026-09-11. Written against the branch that adds the
layout seam ([custom-layout.md](custom-layout.md); react-x11 2.11 plus that
branch). Measured with a prototype on the seam, `scripts/bench/grid/`, in
the in-process X server with real text shaping (KaTeX Main), on one machine
(Apple M1 Pro, node 26). The outside facts in §7 are as of the date and
linked; they will drift._

---

## 0. TL;DR

**Feasible on the seam, without yoga's help, and not expensive once the seam
remembers what it asks a child.**

- **Performance** (§3). A prototype registered with `registerLayout('grid')`
  lays out a gallery of 300 cards in `repeat(auto-fill, minmax(200px, 1fr))`
  in 3.8 ms for a frame in which one card's text changed, and a 200-row
  `auto 1fr` form in 5.1 ms, against 13.4 ms and 14.2 ms for the nearest
  flexbox. The first cut was 3.4 times _slower_ than flexbox, and the reason
  was the seam, not grid: it asked every child the same questions every run,
  several runs a frame. The fix is in, and `masonry` and `equal-row` get it
  too.
- **API** (§2). `layout: { name: 'grid', columns: '120px 1fr' }` on the
  box, with `rows`, `areas` and `autoFlow` beside `columns`, and
  `layoutItem: { column: 'span 2' }` on a child: CSS's names and CSS's
  track grammar, in a string, because that is what can be copied from the
  web. Every other toolkit surveyed types its tracks instead (§7), and the
  option schema could take both.
- **Complexity** (§4). The prototype is 675 lines of code; the spec's track
  sizing algorithm is 218 of them. What it leaves out — subgrid, baselines,
  named lines, column flow, the second column pass — is where most of
  Taffy's 7,500 go. Subgrid cannot be built on this seam at all: a child's
  tree is its own.
- **Recommendation** (§6): ship `grid` as the third built-in layout, from
  the prototype, with the probe's cases as tests. Don't wait for yoga, whose
  grid has an API and no released algorithm, and don't take a second engine
  for it: Taffy's JS builds are four to six times yoga's size.

## 1. What grid is for here

Flexbox lines things up in one direction. The layouts an app here reaches
for that it cannot write:

- **A form.** Labels in a column as wide as the widest label, fields taking
  the rest. Flexbox does it with a fixed label width, which a translation
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
  style={{
    layout: { name: 'grid', columns: 'auto 1fr' },
    columnGap: 12,
    rowGap: 6,
  }}
>
  <text>Name</text>
  <textinput />
  <text>Postal address</text>
  <textarea />
</box>

<box
  style={{
    layout: {
      name: 'grid',
      columns: '200px 1fr',
      rows: 'auto 1fr auto',
      areas: ['head head', 'side main', 'foot foot'],
    },
  }}
>
  <box style={{ layoutItem: { area: 'head' } }} />
  <box style={{ layoutItem: { area: 'side' } }} />
  <box style={{ layoutItem: { area: 'main' } }} />
  <box style={{ layoutItem: { area: 'foot' } }} />
</box>
```

| on the box, in `layout` | CSS                   |                                                                                                    |
| ----------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| `columns`, `rows`       | `grid-template-*`     | px (logical), %, fr, `auto`, `min-content`, `max-content`, `minmax()`, `fit-content()`, `repeat()` |
| `autoColumns/Rows`      | `grid-auto-*`         | the size of an implicit track                                                                      |
| `autoFlow`              | `grid-auto-flow`      | `'row'` or `'row dense'`                                                                           |
| `areas`                 | `grid-template-areas` | one string per row                                                                                 |
| `justifyItems`          | `justify-items`       | `stretch`, `start`, `center`, `end`                                                                |
| **on a child**          |                       |                                                                                                    |
| `column`, `row`         | `grid-column/row`     | `2`, `'2 / 4'`, `'span 2'`, `'2 / span 3'`                                                         |
| `area`                  | `grid-area`           | a name from `areas`                                                                                |
| **the box's own style** |                       |                                                                                                    |
| `gap`, `columnGap`, …   | `gap`                 | between tracks                                                                                     |
| `alignItems`            | `align-items`         | each item in its row                                                                               |

**`layout: 'grid'`, not `display: 'grid'`.** Here the property that names
the algorithm arranging a box's children is `layout`, and grid is one more
value of it: the same seam, the same `layoutItem`, the same floors, RTL and
error handling as `masonry`. `display` keeps its one job, whether the box
takes part at all.

**A string, or typed tracks.** Every other declarative toolkit surveyed
types its tracks instead of parsing them (§7): Flutter's
`flutter_layout_grid` (`[4.5.fr, 100.px, auto]`, with a string only for
named areas), Compose's `Grid` (`column(160.dp); row(1.fr)`), SwiftUI's
`LazyVGrid` (`[GridItem(.fixed(100)), GridItem(.flexible())]`). They have
no CSS to be compatible with; a React app has, and a string is what can be
copied from the web and read by anyone who has written CSS. The cost is
that TypeScript sees `string`: a template-literal type can check the simple
tracks but not `repeat()`. The option schema can take both, a string or an
array of tracks.

**One thing the seam did not have for this.** A `length` option arrives in
device pixels, but a length inside a track list is not an option the schema
can see. The prototype multiplies by `info.scale`, which the seam passed and
did not document; it is documented now
([extending.md](../extending.md#a-layout-algorithm-of-your-own)). A shipped
grid would do better with a `'tracks'` option type that core parses and
scales once, so no run repeats the parse.

## 3. Performance

Three scenarios, each against the nearest flexbox:

- **Form:** 200 rows of `auto 1fr` — a label, and a bordered field with
  text; 400 children. The flexbox is 200 rows with a fixed-width label.
- **Cards:** 300 cards of 9 yoga nodes each, with wrapping titles, in
  `repeat(auto-fill, minmax(200px, 1fr))`. The flexbox is a flex-wrap row
  with a 200px basis; `masonry` lays out the same cards for comparison.
- **Dashboard:** 120 tiles in `repeat(6, 1fr)` with dense flow, a third of
  them two columns wide and a fifth two rows tall.

Layout time is `WindowNode._layoutStep`'s, per frame. A change is one
item's text going from two words to forty and back; changes and resizes
are medians of nine.

| case                     | flexbox |    grid | masonry |
| ------------------------ | ------: | ------: | ------: |
| form — mount             | 38.8 ms | 32.5 ms |         |
| form — one text changed  | 14.2 ms |  5.1 ms |         |
| form — resized 1000↔900  |  5.4 ms |  3.1 ms |         |
| cards — mount            | 65.5 ms | 80.5 ms | 76.2 ms |
| cards — one text changed | 13.4 ms |  3.8 ms |  1.6 ms |
| cards — resized 1000↔900 | 21.5 ms |  6.9 ms |  4.4 ms |
| dashboard — mount        |         | 18.3 ms |         |
| dashboard — one changed  |         |  3.2 ms |         |
| dashboard — resized      |         |  3.6 ms |         |

Grid is faster than flexbox on the frames that happen after mount, for the
structural reason in [custom-layout.md](custom-layout.md#5-cost): each
item's tree is a containment boundary, so a change re-lays out one item and
the algorithm reads everyone else's sizes from what it was told last time.
Mount pays for every child's answers once.

**The first cut was slower, and it was the seam.** Before the seam
remembered anything, the cards' changed frame took 45.7 ms, 3.4 times
flexbox's, and the form's 20.8 ms. One frame, broken down
(`scripts/bench/grid/breakdown.mjs`):

- **The algorithm ran eight times.** Yoga asks a host's measure function in
  the floors pass (`exactly 0`, then `at-most 0`, the host's own floor), in
  the height floors pass and in the pass proper, and the placement makes
  one more call. None of that is grid's: `masonry` runs as often.
- **Each run asked every child two questions,** its intrinsic widths and its
  height at its column's width. Each answer was a `calculateLayout` on the
  child's tree, and the two questions evicted each other from the one layout
  yoga caches for a root: 4,800 full child layouts a frame for 300 cards, 40
  of the 50 ms.
- **A stretched item's rect names a height,** which the floors code took to
  mean a child that could be squeezed. It measured the item's height floors,
  off the pixel grid, and paid a whole extra pass for it.
- **The floors pass measures off the pixel grid,** which voids yoga's cached
  layouts, so the placement laid all 300 trees out again to find each one
  where it already was.

Three fixes to the seam, none of them grid's
([custom-layout.md](custom-layout.md#the-mechanism)):

1. **A child's answers are remembered** (`Node._hostSizesNow`) until
   something inside it changes. That shows as dirt on its root, because
   every layout of the root goes through `layoutHostChild` or the memo,
   which drop the memo when they find it dirty. Answers taken off the pixel
   grid are kept apart.
2. **A rect's height squeezes a child** only when it is less than the
   child's content takes at the rect's width. A stretched row, sized to fit
   its items, never squeezes them.
3. **The placement leaves a tree already at its rect** where it is, unless
   it is dirty.

Afterwards: 4 memo misses in 3,900 questions on a changed frame, and one
tree laid out at placement, the one that changed.

**What still costs:**

- **A new width asks every child again.** A resize measures each child at
  its new column width once; the resize rows above are that. So does the
  floor question when the widest word in any item changes, since the
  narrowest a column can be moves with it.
- **The first frame after mount** asks the off-grid questions for the first
  time.
- **The algorithm's own work** is one pass over the items per axis, plus a
  sort by span and a per-span-group distribution. At 300 items it is well
  under a millisecond a run, now that the children's answers cost a lookup.

That is the same shape of work Chromium's grid does: per item, a min/max
query, a measure pass and a layout pass, each cached (§7).

## 4. Complexity

The prototype is `scripts/bench/grid/grid-layout.js`: 675 lines of code,
comments aside.

| part                                                              | lines |
| ----------------------------------------------------------------- | ----: |
| track lists: the grammar, `repeat()`, auto-fill counts            |   141 |
| placement: lines, spans, areas, auto-placement (sparse and dense) |   121 |
| the track sizing algorithm (css-grid-2 §12.3–12.8)                |   218 |
| the layout: contributions, shrink-to-fit, alignment, registration |   195 |

Its probe (`scripts/bench/grid/probe.mjs`) has 13 cases worked by hand, all
passing:

- fixed and fr tracks; gaps;
- an auto column as wide as its widest label;
- auto-fill and auto-fit (collapsing the empty tracks);
- spans, with auto-placement flowing around a definite item; dense packing
  back-filling a hole;
- named areas;
- stretch, and an item with a height of its own keeping it;
- a spanning item growing the auto tracks it spans;
- shrink-to-fit;
- right to left;
- the floor.

The right-to-left case passes without a line of the prototype written for
it: the core mirrors what an algorithm answers.

**What it leaves out, and what each would take:**

- **Subgrid.** Impossible on this seam: a subgrid's items take part in the
  parent's track sizing, and the parent's algorithm sees a child only as a
  size. The seam would have to hand an algorithm its grandchildren. Taffy
  does not have subgrid either.
- **Baselines** (`alignItems: 'baseline'` within a row): yoga's baseline
  function, which the seam does not expose
  ([custom-layout.md](custom-layout.md#7-not-done)).
- **Named lines, `autoFlow: 'column'`, negative line numbers, and
  `justify-content`/`align-content` distribution:** mechanical, a few dozen
  lines each.
- **The second column pass** (§12.1 step 3): sizing the columns again when
  an item's min-content contribution changed once the rows were sized. It
  matters for items whose width follows their height, such as an aspect
  ratio or an orthogonal flow, and costs one more pass over the columns.
- **Distributing a spanning item's extra space** is simplified to an even
  split, up to the growth limits and then past them. The spec distributes
  to base sizes and growth limits in separate steps, with "infinitely
  growable" tracks. That is where most of the remaining difference from a
  browser lies.

For scale, Taffy's grid module is 7,508 lines (§7): the above, the spec's
corners and their tests.

## 5. What building it showed about the seam

- **The seam re-asked its children** (§3): the memo, the squeeze rule and
  the placement skip. Found here, fixed for every layout.
- **`info.scale`** was needed for lengths inside a string, and is documented
  now.
- **Min-content heights** are not handed to an algorithm
  ([custom-layout.md](custom-layout.md#7-not-done)). Grid does not need them
  in horizontal text: an item's block-axis min- and max-content are both
  its height at its column's width, which `measure({ width })` answers.
- **Nothing else.** Auto-placement, track sizing and alignment are the
  algorithm's; floors, right to left, absolutely positioned children, a
  throw, and running inside the pass are the core's, and a grid gets them
  without asking.

## 6. Recommendation

- **Ship `grid` as the third built-in** in `src/layouts.js`, from the
  prototype. The probe's cases become tests. Spanning items get the spec's
  full distribution, and `autoFlow: 'column'` and named lines come when
  someone asks for them. The box's options and a child's are typed through
  `CustomLayouts` and `CustomLayoutItem`, with a template-literal type for
  the simple track lists. An estimate: the prototype's 675 lines become
  about 900 with the distribution done properly, plus tests.
- **Don't wait for yoga.** Its grid landed in March 2026 as an API with no
  layout algorithm; the algorithm is in open PRs; and `yoga-layout` has not
  released on npm since December 2024. When it does ship, a `grid` on the
  seam can hand the work over without the style changing.
- **Don't take Taffy.** Its JS and WASM builds are third-party and 0.9–1.3
  MB, against `yoga-layout`'s 224 KB, and it would be a second layout engine,
  with its own text-measuring bridge, for one algorithm.

## 7. Outside facts

As of 2026-09-11.

- **Yoga.**
  - Grid has been requested since 2019
    ([react/yoga#867](https://github.com/react/yoga/issues/867)).
  - [#1865](https://github.com/react/yoga/pull/1865), opened 2025-11-17,
    leaves out areas, named lines, subgrid, auto-flow, `repeat()`,
    auto-fill/fit and `fit-content`.
  - It was split into nine parts. Part 1 (#1893: style types, the C/JS API,
    `Display.Grid`) landed on 2026-03-05 with no layout algorithm
    ([07524851f54b](https://github.com/react/yoga/commit/07524851f54b)).
  - The algorithm is in open PRs #1894, #1923 and
    [#1994](https://github.com/react/yoga/pull/1994). There is no
    experimental flag for it.
  - `yoga-layout` 3.2.1 (2024-12-13) is still the latest release on
    [npm](https://www.npmjs.com/package/yoga-layout).
- **Taffy.**
  - `src/compute/grid` is 7,508 lines at
    [a1c3f8f](https://github.com/DioxusLabs/taffy/tree/a1c3f8fb3e2c978c3a4f062873bdb16d5eaf6cfd/src/compute/grid);
    `track_sizing.rs` alone is 1,537, and its flexbox is 3,615.
  - It has dense placement, named lines and areas. Subgrid
    ([#468](https://github.com/DioxusLabs/taffy/issues/468)) and masonry
    ([#910](https://github.com/DioxusLabs/taffy/issues/910)) are open
    issues.
  - Its only published grid numbers are from 0.3: a 100×100 grid in 7.07 ms
    ([results](https://github.com/DioxusLabs/taffy/blob/main/benches/results-2023-02-08.md)).
  - There is no official JS package
    ([#394](https://github.com/DioxusLabs/taffy/pull/394)). Third-party
    builds: [`taffy-layout`](https://www.npmjs.com/package/taffy-layout),
    902 KB unpacked, and
    [`@taffyjs/wasm`](https://www.npmjs.com/package/@taffyjs/wasm), 1.34 MB.
- **The spec.** [css-grid-2 §12](https://www.w3.org/TR/css-grid-2/#algo-grid-sizing),
  the grid sizing algorithm: columns, then rows at the columns' widths,
  then each once more if a contribution changed, then alignment.
- **Chromium.**
  - LayoutNG caches a grid item's measure and layout passes
    ([LayoutNG](https://developer.chrome.com/docs/chromium/layoutng)).
  - An item whose width depends on its row sets `needs_additional_pass`
    ([grid_layout_algorithm.cc](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/layout/grid/grid_layout_algorithm.cc)).
  - Firefox's nested grids cost exponentially in their depth until
    measurement caches fixed it in 94 and 99
    ([1591366](https://bugzilla.mozilla.org/show_bug.cgi?id=1591366),
    [1682686](https://bugzilla.mozilla.org/show_bug.cgi?id=1682686)).
- **Other toolkits' APIs.**
  - [flutter_layout_grid](https://pub.dev/packages/flutter_layout_grid):
    typed track lists, with a string only for named areas.
  - Compose's `Grid`: a typed DSL, experimental in 1.11.0-alpha04 and
    stable in 1.13.0-alpha02
    ([release notes](https://developer.android.com/jetpack/androidx/releases/compose-foundation)).
  - SwiftUI's [`Grid`](https://developer.apple.com/documentation/swiftui/grid)
    takes its columns from its rows, and
    [`LazyVGrid`](https://developer.apple.com/documentation/swiftui/griditem)
    a typed array.
  - React Native has no grid in core;
    [FlashList](https://shopify.github.io/flash-list/docs/usage/) has a
    masonry mode and per-item spans.

## 8. The scripts

`scripts/bench/grid/`:

- `grid-layout.js` is the prototype.
- `probe.mjs` holds the cases in §4.
- `bench.mjs` is the table in §3 (`npm run bench:grid`).
- `breakdown.mjs` is one frame taken apart, run by run, with the memo's
  hits and misses.
