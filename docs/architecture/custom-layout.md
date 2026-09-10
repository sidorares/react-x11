# Custom layout: layouts and positions that run inside the pass

_Design record, 2026-09-10. Written against `master` at 91e1d1c (react-x11
2.11, `src/nodes.js` @ 13.5k lines) and the branch that adds the two seams.
The yoga numbers are from a standalone spike (§6) run in-process on one
machine (Apple M1 Pro, node 26); file references are to that branch and will
drift._

_[styling.md](../styling.md#custom-layouts) is the reference for the style
properties and [extending.md](../extending.md#a-layout-algorithm-of-your-own)
for the two registration contracts; this is why they are the shape they are._

---

## 0. TL;DR

**Two seams, both run by the core inside the frame's layout pass:**

- **A layout** arranges a box's children: `registerLayout(name, { layout })`,
  then `style={{ layout: name }}` on any box. The algorithm is asked how big
  the box's content is for the room on offer, and — once the pass has given
  the box its size — where each child goes. `masonry` and `equal-row` are
  built in.
- **A position** moves one node after the pass, by an offset, resizing
  nothing: `registerPosition(name, { place })`, then
  `style={{ position: name }}`. It is CSS's positioning scheme opened up, and
  `position: 'sticky'` is now the built-in one, written against the same
  context a registered one is handed.

**Why in the core rather than in an effect** (§1): an arrangement that
depends on a layout output has to be computed inside the pass that produces
the output. `onLayout` hears about a pass after it painted, `useLayoutEffect`
runs before the pass it would need to read, and the passes a scroll, a
resize, a live resize or a layout-property transition run never reach React
at all.

**How** (§3): a box with a `layout` is a measured leaf in yoga's tree, and
each of its children a yoga tree of its own. The measure function is the
algorithm's sizing answer; after the pass, the algorithm's final call places
the children, each laid out at the size its rect names, and `absolutize`
reads the slot. The content floors are measured tree by tree inside those
children (§4). A layout that throws is reported and the box is laid out as
flexbox in the same frame.

## 1. Why the core

What one change costs when an arrangement is done in React, with
`onLayout` → `setState`:

1. **Commit.** The nodes change and a frame is scheduled. `useLayoutEffect`
   runs here, before yoga has run for this commit: `abs` holds the previous
   frame's rect — zeros on a mount. There is no forced synchronous layout
   ([react-features.md](../react-features.md#measuring-a-node)).
2. **The frame** (`WindowNode._flushFrame`): layout, the container queries,
   `absolutize`, the placement pass, damage, paint. **This frame shows the
   arrangement the effect has not corrected yet.**
3. **`onLayout`** is queued with `setImmediate` from inside that pass
   (`Node._reportLayout`), so it fires after the paint; its `setState` is a
   second render, a second commit, a second layout pass and a second paint.

A probe against the mock backend with production scheduling, a row whose
column count is one per 100px of its width:

| scenario               | `useLayoutEffect` measuring `abs`, then `setState`    | `onLayout` → `setState`  |
| ---------------------- | ----------------------------------------------------- | ------------------------ |
| mount at 200px         | reads 0 → paints 1 column, **stays wrong**            | paints 1 column, then 2  |
| React widens it to 400 | reads 200 (stale) → paints 2 columns, **stays wrong** | paints 2 columns, then 4 |
| the window widens      | **never runs** — nothing committed                    | paints 2 columns, then 4 |

`useLayoutEffect` is on time and blind; `onLayout` sees and is late. The
DOM gets both only because reading geometry forces a synchronous reflow,
and React Native's New Architecture got both by laying out synchronously in
the commit. Neither covers the third row, which is the one that matters
most, because most layout passes are not React's:

- **A scroll.** ntk's frame runs before React commits an `onScroll` update —
  the reason sticky had to be native (#523), whose probe painted every wheel
  notch twice. And a pure scroll takes the fast path (#405), which moves the
  children without walking them: only a pass run after `_absolutizeChildren`
  sees those frames.
- **A live resize on macOS.** AppKit's modal loop owns the thread; the resize
  callback flushes the frame synchronously (`src/cocoa/app.js`), so an
  in-frame arrangement follows the drag. Timers and microtasks wait for the
  release, and `onLayout` is a `setImmediate`: an arrangement built on it
  freezes for the whole drag.
- **A transition on a layout property**, which costs a layout pass per frame
  ([styling.md](../styling.md#transitions)) — an effect-driven arrangement
  trails it by a frame on every frame.
- **Everything else that changes a layout inside a frame:** a container
  query flipping, a font or image arriving through `invalidateMeasure`.

The components package was already paying for this. Its virtualization
window builds a guessed number of rows because "there is always one render
that has to guess"; Table measures its rows "a tick after the commit because
layout runs on the frame flush"; Reorder's drop flight reads its landing
place in an `afterLayout` tick. And `<Html>` implements block, inline, float
and table layout itself, inside one node, to arrange children at all.

The core already had five of these in-frame passes, each written by hand:
the container queries (restyle and relayout, bounded and pinned), sticky
(placement and blit-aware damage), anchored popups, `scrollIntoView`, and
the content floors. The seams are the same slot, opened, with the
mechanics — when it runs, damage, the blit, hit testing, order — left in
the core and only the policy handed out. That is AGENTS.md's "decide it,
then leave a way out" twice over: sticky and flexbox are the decided
defaults, and these are the ways out.

## 2. Positions

```js
registerPosition('parallax', {
  options: { rate: { type: 'number', default: 0.5 } },
  place: (node, { pane, options }) =>
    pane ? { x: 0, y: Math.round(pane.scrollY * options.rate) } : null,
});

<box style={{ position: { name: 'parallax', rate: 0.3 } }} />;
```

A node with a registered position is laid out in flow, as `relative` is,
and after the pass `place(node, context)` returns how far to move it from
where layout put it, or null for not at all. The context is everything
sticky needed, in window coordinates and device pixels like `abs`: the
laid-out rect, the nearest scroll pane's scrollport and offsets, the box the
node is contained by (its parent's content box, or the whole scrolled
content for a direct child of the pane), its margins, its direction, the
scale, the frame clock, and the options resolved. `sticky` is exactly a
function of that context (`placeSticky` in `src/layouts.js`), and all 28
sticky tests pass against it unchanged.

What the core keeps, because each is easy to get wrong and was, once, while
sticky was built:

- **Nothing remembers an offset.** The scroll fast path moves a placed node
  along with its pane's content, offset and all, so each pass re-derives
  where layout put the node (`Node._laidOutAt`) and moves it from wherever
  it is.
- **Its moves are claimed by hand**, because neither the layout diff nor the
  fast path sees them: the reach the node was shown at, moved by the pending
  blit, and the reach it lands at, written into the blitting pane's ledger.
  A node that rode the scroll lands where the blit put it and claims
  nothing.
- **It paints and hit-tests over its siblings** of the same `zIndex`, as CSS
  paints a positioned box over the ones in flow.
- **It may animate.** `{ x, y, again: true }` asks for another frame, which
  runs the placement pass with nothing to lay out — the shape a drop flight
  or a collapsing header wants, and the way transitions already keep the
  clock running.

The insets are the scheme's to read, never offsets: sticky reads them as
thresholds, and a registered position may read them as anything. Yoga never
sees them (`applyLayoutStyle`).

**Decided: `position`, not a property of its own.** The first name was
`placement`, and it collided on the first full run: `placement` is the
anchor vocabulary — which side of its trigger a popup opens on — in
`anchor.js`, `Tooltip`, `Select`, `Menu`, `Dialog` and their docs, 58 uses,
and a `<popup placement>` threw the flat-style assertion the moment the
word became a style name. `offset` is the anchor's gap. And the concept
already had a home: CSS's `position` picks a positioning scheme, sticky is
one, and a scheme's insets are its own to interpret. What that costs is
composability with `absolute` — a node has one scheme, as in CSS — and a
wrapping box is the answer for the rare case that wants both.

## 3. Layouts

```js
registerLayout('equal-row', {
  layout(children, c, options, { style }) {
    // …how wide a cell is, then one rect per child
    return { width, height, children: rects };
  },
});

<box style={{ layout: 'equal-row', gap: 8, justifyContent: 'flex-end' }} />;
```

**The contract** is one function, asked two kinds of question. With
`constraints` in the vocabulary `measureContent` speaks — `{ width, height,
widthMode, heightMode }`, `'exactly'`, `'at-most'` or `'unconstrained'`,
`Infinity` for no bound — it answers how big the box's content is; that is
asked several times per pass, at sizes nothing is drawn at, so it must be a
pure function of its arguments. When both modes are `'exactly'`, it also
answers where each child goes: one rect per child, `{ x, y }` with an
optional `width` and `height`, from the content box's corner. SwiftUI's
`Layout` splits these into two methods; one function serves every layout
here, and masonry places while it sizes.

**What an algorithm sees of a child** (`LayoutChild`) is something to
measure and read options off, never a node:
`measure({ width, height, widthMode, heightMode })`, `intrinsicSizes()` →
`{ minContentWidth, maxContentWidth }`, `options` (its `layoutItem`, against
the layout's `childOptions`) and `index`. Every size is the child's **margin
box**, which is what makes an algorithm that stacks children right about
margins without knowing they exist — yoga already treats the size a root is
laid out at as the margin box. An axis given a number and no mode is
`'exactly'`; left out it is `'unconstrained'`; `'at-most'` is CSS's
fit-content, never below the child's floor.

**Options are typed.** `options` and `childOptions` declare what the style
may say — `length`, `number`, `integer`, `boolean`, `string`, `any`, or a
list of values — so a wrong one is reported naming the option and the type,
and a `length`, written in logical pixels like every length in a style,
arrives in device pixels. `info.style` is the host's own resolved style, so
a layout reads `gap`, `justifyContent` and `alignItems` rather than growing
options that mean the same things: `equal-row` has no options of its own.

### The mechanism

- **A host is a measured leaf.** `_syncLayoutHost`, run from the style
  funnel, takes the node's children out of its yoga node and gives it a
  measure function (`_measureHost`) that asks the algorithm. Yoga can do no
  other: a node with a measure function may have no yoga children, and it
  aborts rather than refuse.
- **Each child is a yoga tree of its own**, laid out by `LayoutChild` with
  `calculateLayout` at the size the algorithm asks for. The host's direction
  goes in as the third argument, the way a window's reaches its tree.
- **The final call runs at the end of every layout step**
  (`WindowNode._placeLayoutHosts`), parents before the hosts inside their
  children, and before anything reads a child's size — the container
  queries settle on what it leaves. It lays each child out at its rect and
  records the slot, which `absolutize` then reads (`offsetInParent` is the
  one sum that, `onLayout`, `scrollIntoView` and a scroll pane's extent
  make). It is skipped when nothing asked the algorithm anything since the
  last placement and the box is the size it was: a scroll never asks.
- **Dirt.** A child's yoga tree stops its dirt at its own root, so the
  window looks for it before every pass (`_sweepLayoutHosts`) and makes it
  the host's. Yoga's dirtied callback is no substitute: it fires only on the
  way from clean to dirty, and a child hidden since it mounted was never
  laid out and would never say so — a test pins exactly that case.
- **Right to left is the core's.** An algorithm is written once, from the
  left; the placement mirrors each slot across the content box when the host
  reads right to left, and each child's own tree mirrors inside it.
- **Absolutely positioned children** are not the algorithm's. They are laid
  out by yoga's own rules against a holder standing in for the padding box.
- **A layout that throws**, or answers something that is not a size, is
  reported like a handler's throw (`reportLayoutError`, `onUncaughtError`
  included) and turned off: the box is laid out as flexbox in the same
  frame, and stays so until its style names another layout. A name nobody
  registered is reported once and is flexbox too.
- **Not a host:** a scroll pane — whose size is its viewport's, not its
  content's; the layout goes on a box inside it — a window, and anything
  that measures its own content.

## 4. The content floors inside the children

The floors (#249) are measured over the window's yoga tree: one pass with no
room on offer, read back by `contentSpan`, written onto every flex item as
its minimum. A host's children are not in that tree, so the window's walkers
stop at a host and treat it as the leaf yoga sees — its minimum is what its
algorithm answers at `at-most 0` — and the children are measured tree by
tree:

- **Widths**, before the window's own pass (`_measureHostChildWidths`):
  each stale child's tree with no room, the shrink borrowed, its span read
  back into the extents of everything stale inside it. The child's own
  extent is its min-content width — what `intrinsicSizes()` hands its
  algorithm, and so what `equal-row` squeezes to and `masonry`'s minimum is
  made of. Deepest hosts first, so a host inside a card has its children's
  extents when the card's pass asks it for its minimum.
- **Heights**, at the width the placement gave each child
  (`_measureHostChildHeights`) — a minimum height is a height for a width,
  and the width is the algorithm's. Only for a child that can come out
  shorter than its content, one given a height or naming its own: a
  masonry's cards take their natural heights and squeeze nothing, so the
  common case pays nothing. A live resize defers them with the rest.

## 5. Cost

**No layout, no cost.** Every added branch is behind `_layoutHosts.size` or
a `_host !== null` read; the sweep returns on an empty registry.

**With a layout.** The spike (§6): a masonry of 300 cards of 9 yoga nodes
each, hosted in one measured leaf over detached trees, against the same
cards as a flex-wrap row:

| case                           |   custom host | native flex-wrap |
| ------------------------------ | ------------: | ---------------: |
| host measured per pass         |          once |                  |
| clean frame / a sibling's dirt | 0 re-measures |                  |
| one card's text grew           |       0.25 ms |           2.6 ms |
| window resized 1200↔1100       |        1.6 ms |           2.7 ms |

The two are different algorithms, so read it as "not slower", not as
"faster". What it does show is structural: each child's tree is a
containment boundary, so a change inside one card re-lays out that card
(one text measure of 300), and no cycle can form inside a pass — a child
cannot reach the constraints its host gives it. Container queries needed a
runtime pin for that guarantee; here it holds by construction.

## 6. The spike

`calculateLayout` nested inside a measure call on another tree works — the
components package's `<Html>` flex has shipped on it for months — and the
questions it left were the ones above: how often yoga asks (once per pass in
a column and as a shrinking row item), whether a clean frame re-asks (no),
and whether a detached child's dirt can reach the host (only by a sweep or a
dirtied callback, and only the sweep covers a child never laid out).

## 7. Not done

- **A scroll pane or a window as the host.** Both are sized by something
  other than their content; a box inside them is the host today.
- **Baselines** across a host (`alignItems: 'baseline'` in its parent), which
  needs yoga's baseline function.
- **Fragmentation.** Houdini's layout API has break tokens for pages and
  columns; nothing here paginates.
- **Min-content heights** for an algorithm to read; only widths are handed
  over.
- **Hot reload** keeps a mounted host on the definition it started with
  until its style names a layout again — the contract registered elements
  have.
