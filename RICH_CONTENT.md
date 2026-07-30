# Where rich content belongs: ntk, react-x11, or a module of its own

> **Status: this is the analysis, not the decision.** The decision and the
> staged plan live in
> [sidorares/ntk#106](https://github.com/sidorares/ntk/issues/106). It
> diverges from the recommendation below on three points: **mermaid is
> dropped outright** rather than extracted to a module, `<html>` and
> `<markdown>` **do move here** behind subpath exports once the provider
> weight is gone, and `<tex>` and `<svg>` stay in ntk. The measurements in
> this document still hold, and re-measuring in isolated install trees put
> mermaid's own closure at 155 MB rather than the 89 MB reported here — the
> difference is what npm hoisting hides. Mermaid removal shipped as
> sidorares/ntk#113.

`<tex>`, `<svg>`, `<markdown>`, `<html>` and mermaid fences are all
implemented in ntk today and wrapped by `src/richnodes.js`. This document
weighs three outcomes for each — **(1)** leave in ntk, **(2)** reimplement
here as host elements plus components, **(3)** extract to an external
module — with the two gaps that motivated the question as the forcing
requirements: **selectable text** and a **context menu**.

## Recommendation

|              | outcome                                                       | one-line reason                                                                                                                 |
| ------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `<tex>`      | **1 — leave in ntk**                                          | a pure layout function with no interaction surface; the extraction seam (`configureTex`) already exists                         |
| `<svg>`      | **1 for the rasterizer, 2 for the vocabulary — already done** | `SvgChildNode` already owns the element vocabulary here; ntk owns the path rasterizer. This is the split the others should copy |
| `<markdown>` | **1 + a hit-testing seam**                                    | reimplementing means owning `marked` + `highlight.js` and rebuilding the `TextLayout` wiring for no gain                        |
| `<html>`     | **1 + the same seam**                                         | 891 lines with its own CSS cascade and yoga tree; the least attractive rewrite of the five                                      |
| mermaid      | **3 — external module**                                       | 89 MB of dependency for a lazily-imported feature, and the only one of the five with no interaction requirement at all          |

So: **not a uniform answer, and mostly not a move.** The work that unblocks
selection and context menus is one small ntk API plus interaction code here.
The work that is genuinely worth relocating is a dependency problem, not an
architecture problem, and it is a different set of files than you'd guess.

## Why "which format" is the wrong axis

Every one of the five is really four layers stacked:

| layer        | what it needs                    | where it is                                                     |
| ------------ | -------------------------------- | --------------------------------------------------------------- |
| **parse**    | nothing — pure data in, tree out | `marked`, `htmlparser2` + `postcss`, `katex`, mermaid's grammar |
| **layout**   | fonts, no X11                    | `TextLayout`, Yoga, `dagre`, glyph path flattening              |
| **paint**    | a 2d context                     | `draw(ctx, x, y)`                                               |
| **interact** | events, focus, clipboard         | `linkAt`, `elementAt`, `scrollBy`                               |

Layers 1–3 are toolkit concerns. They are reusable from plain ntk with no
React anywhere, they have no opinion about reconciliation, and they are
correctly in ntk. Nothing about selectable text changes that.

Layer 4 is where the gaps are — and layer 4 is _already_ split badly. ntk's
`HtmlView` carries a whole second interaction model for "window mode":
`scrollY`, `scrollBy`, `scrollTo`, `render()`, `destroy()`. react-x11 uses
**none** of it — it wraps documents in `<scrollview>` and drives
`layout(width)` / `draw(ctx, x, y)` directly (`src/richnodes.js:111`). Every
`scrollBy`/`scrollTo` hit in this repo is `ScrollViewNode`'s own method, not
the widget's.

That is the actual finding: the seam is horizontal, not vertical. The
question isn't "should markdown live here" but "should ntk own document
_interaction_, given it already owns document _layout_ and react-x11 already
owns interaction for everything else".

Answer: no. Which is convenient, because it's also the cheap answer.

## What selection and context menus actually need

Almost all of it already exists, on both sides of the boundary.

**react-x11 already has**, in `TextInputNode`/`TextAreaNode`:

- caret + anchor, `_selection()`, word boundaries, select-all
- PRIMARY and CLIPBOARD ownership via ntk's clipboard helper
- an undo/redo stack with edit coalescing
- **a real right-click context menu** — `src/editmenu.js`, rendered as a
  `<popup>`, reusing the popup's pointer grab, dismissal and focus

**ntk's `TextLayout` already has** the exact two primitives selection needs,
and they are public and documented (`docs/text.md`):

- `caretPosition(index) → {x, y, height, line}`
- `indexAt(x, y) → logical code-point index`

both bidi- and grapheme-cluster-aware, which is the part nobody wants to
reimplement.

And the selection _painting_ loop is already written, in
`TextAreaNode._paintContent` (`src/nodes.js:2664`): walk `layout.lines[]`
from `caretPosition(a).line` to `caretPosition(b).line`, fill a rect per
line, special-case the bare-newline sliver. Fifteen lines, public API only.

Selecting text across a markdown document is **that loop, generalised from
one `TextLayout` to a list of them.** The only missing ingredient is a way to
enumerate a document's text layouts with their positions and document-order
offsets.

Today that data is private:

- `MarkdownView._items` — a flat display list of
  `{kind: 'rect'|'text'|'tex', x, y, layout}`; the `text` entries each hold a
  `TextLayout`. This is _already_ the right shape.
- `HtmlView._root` — a box tree; text boxes get their layout from
  `_textLayout(box, width)`.

So the ntk ask is one read-only accessor, something like
`textRuns() → [{x, y, layout, start, end}]` in document order — the same
information `linkAt` is already built from, exposed instead of consumed
internally. `MarkdownView` can implement it by filtering `_items`;
`HtmlView` by walking `_root`. Both are a handful of lines because the data
structures already exist.

Everything else — drag to select, shift-click to extend, double-click for a
word, painting the highlight, owning PRIMARY, the copy/select-all menu —
belongs here, next to the code that already does it for `<textarea>`.

**Corollary: reimplementing the documents in react-x11 buys nothing for the
feature that prompted the question.** Option 2's whole pitch is "we need
control of the interaction layer to add selection" — but we already have the
interaction layer, and we'd still be calling ntk's `TextLayout` for the
geometry. The rewrite is orthogonal to the gap.

## The dependency measurement

Run in this repo against ntk 3.10.0:

```
node_modules/ntk                492 KB
node_modules/mermaid         89,852 KB
node_modules/highlight.js     9,336 KB
node_modules/cytoscape        6,048 KB   ← via mermaid
node_modules/katex            4,416 KB
node_modules/@dagrejs         2,044 KB
node_modules/dompurify        1,760 KB   ← via mermaid
node_modules/d3                 868 KB   ← via mermaid
node_modules/marked             460 KB
node_modules/css-select         380 KB
node_modules/postcss            344 KB
node_modules/htmlparser2        300 KB
node_modules/domutils           212 KB
                            ─────────
                            116,020 KB
```

**The toolkit is 492 KB. Its document-rendering dependency closure is
116 MB — 236× the toolkit.** Of that, 89 MB is mermaid, which
`lib/widgets/mermaid.js:50` loads through a lazy `await import('mermaid')`,
so a hello-world app downloads it on install and never executes it.

This is the one genuinely compelling argument for moving something, and note
that it is **independent of the selection question**. It would be just as
true if selectable text were never built.

It also has a precedent inside ntk already: `configureTex({ katex, fonts })`
(`lib/widgets/tex.js:64`) exists precisely so a caller can inject katex
instead of ntk depending on it. The mechanism for "keep the layout code,
externalise the heavy parser" is written and shipped — it just wasn't applied
to mermaid, and katex is still a hard `dependencies` entry despite the hook.

## Per-format analysis

### `<tex>` — 682 lines, katex 4.4 MB

A pure function: `layoutTex(source, opts) → box`, synchronous, headless, no
children, no events, no async. It converts katex's HTML output into glyph
paths using ntk's own `path`/`rasterize`/`trapezoid`/`Font` primitives, and
draws through raw XRender.

- **(1) leave in ntk** ✅ — it is a text-layout primitive, and it is built on
  four other ntk primitives that are not exported. Moving it out means
  exporting `flatten`, `trapezoidize`, `parseSvgPath` and `Font` as public
  API, which is a bigger commitment than keeping 682 lines.
- **(2) reimplement here** ❌ — nothing to gain. There is no interaction
  surface to own. The formula is an opaque box by nature; you don't select
  half of an integral sign.
- **(3) external module** ⚠️ — only worth it for the 4.4 MB. But
  `configureTex` already lets an app inject katex, so the _right_ fix is to
  demote katex from `dependencies` to `optionalDependencies` and let the lazy
  `require` fail into its existing error message. Cheaper than a package.

**Do:** nothing structural. Demote katex. Optionally add baseline alignment
with surrounding `<text>` (already noted as open in NEXT_STEPS §1).

### `<svg>` — 528 lines, no heavy deps

The interesting case, because **the answer is already implemented and it's a
hybrid.** `SvgChildNode` (`src/richnodes.js:238`) makes `<circle>`,
`<path>`, `<text>` real host elements with React props, kebab-cases their
attributes DOM-style, and serialises the subtree into the htmlparser2-shaped
DOM that `SvgView` consumes. ntk keeps the rasterizer; react-x11 owns the
vocabulary and the reconciliation.

That means state-parametrised SVG already works the way you'd want:
`<circle r={value} />` from a slider is a normal React update.

- **(1) leave entirely in ntk** — that's not the status quo; the vocabulary
  is already here, and that's the part worth having here.
- **(2) reimplement the rasterizer here** ❌ — path flattening, trapezoid
  decomposition and gradients are exactly what a toolkit should own.
- **(3) external** ❌ — no dependency pressure at all (`domutils` +
  `htmlparser2` = 512 KB, shared with `HtmlView`).

**Do:** nothing. Use it as the template for what "the right split" looks
like. One inefficiency worth noting: `_textContentChanged` rebuilds the whole
`SvgView` on any prop change (`src/richnodes.js:356`), so a slider dragging
one `r` re-parses the entire subtree every frame. That's a react-x11-side
optimisation — and a good thing to measure with the demo app.

### `<markdown>` — 500 + 148 + 97 lines, marked 460 KB + highlight.js 9.3 MB

`parseMarkdown` (marked's lexer) → block layout → a flat display list of
rect/text/tex items, each text item holding a `TextLayout`.

- **(1) leave in ntk** ✅ — with `textRuns()` added. The display list is
  already exactly the structure selection wants to walk.
- **(2) reimplement here as elements + components** ⚠️ — the honest version
  of this is: React components that emit `<text>`/`<box>` per markdown block,
  from an AST parsed by `marked` in this repo. That's genuinely attractive
  for _composition_ — `components={{ h1: MyHeading }}` like react-markdown,
  per-node styling through the normal style channel, links as real focusable
  nodes with their own cursor (an open gap in §1). But it means owning block
  layout, table layout, and inline-run building — the bulk of
  `markdownview.js` — and it does **not** make selection easier, because
  selection across separate `<text>` nodes is _harder_ than across one
  display list, not easier. You'd be reinventing DOM range selection.
- **(3) external** ⚠️ — moves 9.8 MB. But highlight.js is only needed for
  fenced code, and ntk already exports `highlightCode` as public API, so an
  injection hook is the cheaper 90%.

**Do:** stay in ntk, add `textRuns()`. Keep option 2 on the shelf as a
_separate_ future feature (`components` overrides), not as a replacement.

### `<html>` — 891 lines, htmlparser2 + postcss + css-select ≈ 1 MB

The heaviest implementation and the lightest dependency load. Its own CSS
cascade (`css.js`, 673 lines), a real Yoga box tree, block and flex layout,
image loading, borders, list markers.

- **(1) leave in ntk** ✅ — with the same `textRuns()`. Also the place to
  delete the unused window-mode half (`scrollY`/`render`/`scrollBy`) or at
  least stop growing it.
- **(2) reimplement here** ❌❌ — the worst rewrite of the five. It would
  duplicate the renderer's own job (a box tree over Yoga) in a second,
  incompatible way, and react-x11 deliberately _doesn't_ have a selector
  cascade (NEXT_STEPS §6: "style objects as props, not a selector cascade").
  Bringing CSS selectors in through the back door contradicts a decision the
  project already made on purpose.
- **(3) external** ⚠️ — plausible on cohesion grounds: an HTML/CSS engine is
  a big, self-contained thing and 1.5k lines of ntk is a lot of surface for a
  feature many apps never touch. But the dependency argument is weak (1 MB),
  and it shares `TextLayout`, `Image`, `SvgView` and `cssColor` with the rest
  of ntk, so extraction means exporting all of those.

**Do:** stay in ntk, add `textRuns()`, stop extending window mode.

### mermaid — 720 lines, 89 MB + cytoscape/d3/dompurify

The outlier, and the one clear extraction.

- The **89 MB dependency** is 77% of the entire rich-content closure and
  18× everything else in it combined.
- It's a **lazy `await import()`**, so nobody pays the load cost and
  everybody pays the install cost — the worst of both.
- It's reachable **only through ```mermaid fences in markdown**; there is no
  `<mermaid>` element and NEXT_STEPS §1 already decided there shouldn't be.
- It uses the mermaid package **for parsing only** — the renderer needs a
  browser. So the 89 MB buys a grammar. The layout is `dagre` (1.4 MB) plus
  ntk's own drawing.
- It has **no interaction requirement**: a diagram is an image. Selection and
  context menus don't apply.

- **(1) leave in ntk** ❌ — makes every ntk install 180× larger than ntk for
  a feature behind a fence in a widget.
- **(2) reimplement here** ❌ — same dependency, wrong repo, and react-x11
  doesn't even expose an element for it.
- **(3) external module** ✅ — `ntk-mermaid`, or an injection hook exactly
  like `configureTex({ katex })`: `configureMermaid({ mermaid })`, with the
  fence falling back to a plain code block when nothing is injected. That
  fallback **already exists** — it's what a fence shows while the grammar
  loads (`markdownview.js:117`).

**Do:** move it. The injection-hook version is small, backwards-compatible,
and reuses a pattern the codebase already ships.

## Recommended plan, in order

1. **ntk: `configureMermaid({ mermaid })`,** and demote `mermaid` from
   `dependencies`. The lazy-import path and the code-block fallback both
   already exist; this is mostly package.json plus an injection point.
   Frees ~98 MB from every install. _(No react-x11 change; fences degrade to
   code blocks unless an app opts in.)_
2. **ntk: demote `katex`** the same way — `configureTex` is already there.
3. **ntk: `textRuns()` on `MarkdownView` and `HtmlView`** — read-only, in
   document order, exposing the `TextLayout`s that `linkAt` is already built
   from. This is the one new API the selection work needs.
4. **react-x11: document selection**, as a shared mixin factored out of
   `TextAreaNode`'s existing loop — drag/shift-click/double-click, highlight
   painting, PRIMARY ownership.
5. **react-x11: a read-only context menu** for documents — Copy, Select All,
   Copy Link Address — built on `src/editmenu.js`, which already renders,
   grabs and dismisses correctly.
6. _(Later, independent)_ `components` overrides for `<markdown>` as an
   additive feature, if per-block composition turns out to be wanted.

Steps 1–2 are pure dependency hygiene and can ship immediately. Steps 3–5
are the actual feature. Nothing in the list is a rewrite, and nothing moves
`<markdown>`, `<html>`, `<tex>` or `<svg>` anywhere.

## What would change this

- **If `components` overrides become a priority**, `<markdown>` moves toward
  option 2 for real — but as a _second_ rendering path alongside the widget,
  the way react-markdown and a WYSIWYG renderer can coexist, not a
  replacement.
- **If selection needs to span a document and surrounding `<text>` nodes**
  (select across a heading, a paragraph and a button label in one drag), then
  the display-list seam isn't enough and react-x11 needs a tree-wide range
  model. That's a much larger project and it argues for option 2 across the
  board. Worth deciding deliberately: browsers do this, and not having it is
  noticeable.
- **If ntk grows a second consumer that wants document interaction**, then
  layer 4 belongs in ntk after all and step 3 should be a full selection API
  there instead of an accessor.
