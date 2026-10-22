# Styling: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/styling.md](../docs/styling.md), the reference, and keep
their original headings so code comments that cite them still resolve.

Under a heading that stayed in the reference, the paragraphs here are the
original wording of ones the reference now says more briefly, kept for the
history, mechanics and rationale the shorter version left out.

Style lives in one place: the `style` prop. A style property passed flat is
an error in development that names the fix, rather than the silent no-op an
unrecognised prop used to be.

## The rule

Inheritance is a different thing and it does happen — see
[Inheritance](../docs/styling.md#inheritance-the-ink-the-face-and-the-size) below. The two are
easy to conflate because CSS ships them together: what is gone here is
_matching a rule against a tree_; what remains is a handful of properties
that travel down it, which is the part that makes a theme, a caption block
or a dimmed row expressible at all.

## Lengths and shorthands

### Relative units

What a relative length costs is the re-resolution, and only on the nodes that
wrote one: a node records what its style read — the inherited size, the
palette's, the window's — and is resolved again by the walk that already
carries that change (the text cascade, the theme walk, the size-query
registry). A style written in pixels reads none of them. Inside an
`'auto'`-sized window a viewport unit makes the content depend on the window
that depends on the content; like a size query, it settles where the two
agree, so size such a window or keep the viewport units out of it.

So is a second value where a property takes one. Yoga's own setters used to
`parseFloat` whatever they were handed, so `'2ex'` was quietly two pixels.

**The more specific property wins, wherever it is written.** A longhand
beats its shorthand, a side beats all four sides, and a pair beats all four
too: `paddingTop` beside `padding: '8px 16px'` is the top padding whether it
comes before or after it in the style. That is the rule `paddingLeft` beside
`padding: 8` has always followed, and it is not CSS's, which goes by order.
A flattened style array has no order left to go by — a longhand and its
shorthand end up as two keys of one object — and "the specific one wins" is
the rule you can read off a style without knowing how it was assembled.

## What it fixes on `<window>`

`width`/`height` on a `<window>` are the real X window's geometry — the user
can drag them, and `flush()` reads them back — so they must never reach the
root yoga node. That used to mean stripping them out of the style bag
(`_yogaProps`), and it forced the size hints to hide inside a `sizeHints`
object because `minWidth`/`maxWidth` were already taken by yoga.

With the split, both workarounds go:

```jsx
<window
  title="Editor"
  width={900}
  height={600}
  x={40}
  y={40} // the X window
  minWidth={400}
  minHeight={300}
  resizable // WM hints, flat, no nesting
  style={{ flexDirection: 'row', backgroundColor: '#1e1e1e' }} // the root box
/>
```

`WINDOW_HINT_PROPS` is mapped back to ntk's `sizeHints` shape in
`windowAttributes()`, and `style.backgroundColor` is forwarded as the window's
creation attribute — the ntk contract is unchanged, only the call site is.

## Inline pseudo-states

`:hover`, `:focus-within`, `:focus`, `:focus-visible`, `:active`,
`:disabled`, `:drag-over`, `:dragging`.
These are **node states, not selectors** — each is something the node itself
already knows, so resolving them needs no specificity and no matching. The
event manager already tracks the hover path, the press chain and the focused
node; a state change recomputes one node's style and repaints. **No React
render.**

`:active` is a press, and it follows the same chain for the same reason: the
node under the pointer is whatever a control happens to be built out of — a
button's label, a switch's thumb — and it is the control that has to draw
the press. It is also **live for the whole gesture**: it drops when the
pointer leaves the chain and comes back when it returns, so `:active` always
means "releasing now activates this", matching the nearest-common-ancestor
rule the click itself is synthesized on.

This is not decoration. A control acts on the release, so `:active` is the
only thing it can show while it is held, and a click held half a second is
half a second of silence without it. Give every interactive thing one — see
[components.md](../docs/components.md#the-press-state).

The keyboard has no press state: Space and Enter act on the down, so the
activation is immediate, but nothing draws held-ness. X reports auto-repeat
as release/press pairs and neither ntk nor node-x11 implements XKB's
`DetectableAutoRepeat`, so a held key cannot be told from fast tapping.

`:focus-within` is focus on this node **or inside it** — CSS's, and the
answer to "the row should light up while the field in it is being typed
into", which is the one thing a node's own states cannot say. It is diffed
over the focused node's ancestor chain, the same walk `:hover` uses, and a
`<popup>` counts as inside the node it hangs off in the JSX tree, so a
`Select` with its menu open still reads as focused.

**State blocks may only set paint properties** (`backgroundColor`,
`borderColor` and the per-side `borderTopColor`/…, `borderRadius`, `zIndex`,
`outlineWidth`, `outlineColor`,
`outlineOffset`, `opacity`, `color`) — enforced at declaration
time by `createStyles`. A `:hover` that could set `padding` would reflow the
tree on pointer move: jitter, and the end of the "hover is a repaint" property
that makes this worth having. Anything that changes layout or what renders
stays in React state.

### The focus ring

`outlineWidth`, `outlineColor` and `outlineOffset` override it, and they are
paint properties like any other: animatable, legal in a state block, and
painted **outside the border box** so switching one on cannot move the thing
it surrounds. That is the whole reason CSS has `outline` as well as `border`,
and the reason these are not in the layout vocabulary.

## Direction, and the logical edges

**The default comes from the locale.** An app started under
`LANG=ar_EG.UTF-8` is mirrored with no configuration, because that is what
GTK and Qt both do and because the alternative is an Arabic desktop where
one application's panels are on the wrong side. Every locale that is not
written right to left answers `'ltr'`, so an app that never thinks about
this pays nothing. The palette carries it — `theme.direction` — so an app
with a language menu switches the whole UI with the `<ThemeProvider>` swap
it was already doing for colours:

### The logical edges

**A logical edge wins over the physical one even in LTR**, the way CSS's
`padding-inline-start` wins over `padding-left`. Yoga's full order is
start/end, then the physical side, then `EDGE_HORIZONTAL`, then
`EDGE_ALL` — the opposite way round from what the vertical shorthands
suggest, which is why it is pinned in a test.

### What does not mirror

- **The caret keys in a field.** Left and Right step through the _string_,
  not across the screen, and so do Home and End — the editing model is
  written in logical positions, and visual-order caret motion through bidi
  text is its own question.

### Inside an editable field

- **It is the base level the value is shaped at.** UAX#9 resolves a run of
  neutral characters — `"(1) 12:30"`, a filename, a lone bracket — against
  the paragraph level, and "take it from the first strong character" is only
  the rule for when nobody said. A field that never said reorders an Arabic
  word typed into an English form as though the whole line were Arabic, in an
  **LTR** window. So the field says.

- **It is the edge the text is against.** The value, the placeholder and the
  caret start at the direction's start edge — the right-hand one under
  `direction: 'rtl'` — and an unscrolled field still shows the _beginning_ of
  its value, so a value too long for its box overflows towards the left.
  Clicking, the caret, the selection bands and the scroll are read from one
  placement, so they mirror together.

## Per-side borders

This is what a rule or an accent edge should be built from: a blockquote's
bar, a table's row separators (`borderBottomWidth: 1` on each row), a tab's
underline. Composing the same line out of 1px `<box>`es works but pays a
node per row into layout and paint, and scatters what is really one style
value ("the table's border colour") across the tree.

Two edges of the v1 shape:

- **`borderRadius` requires uniform borders** — same width and colour on
  all four sides. A non-uniform border paints square, ignores the radius,
  and says so once in development; bars and rules are square, so this costs
  nothing real.
- Corners between two painted sides of different colours are square and
  deterministic: top and bottom span the box's full width, left and right
  run between them. CSS mitres that corner diagonally; nothing built from
  bars and rules can tell the difference.

## Gradients and shadows

The two decorations a UI asks for after colour and radius, and the two that
used to mean giving up on `<box>` and drawing the panel by hand:

Both are **paint** properties: legal in a state block, and outside layout
entirely — a gradient fills the box the layout already decided on, and a
shadow is drawn beyond it and moves nothing. Both are written in CSS's
spelling, because both are values people already know by heart, and a
`$token` resolves **inside** them as well as as a whole value, which is what
keeps a themed decoration in a hoisted style.

### `backgroundImage`

Only linear gradients exist. A radial or conic one is a `<canvas onDraw>`
away (`createRadialGradient` draws on every backend but Windows', and
ntk's context has `createConicalGradient`),
and CSS's sizing keywords for them are most of the work for very little of
the demand.

One cost worth knowing, because it is not where anyone would look for it: a
gradient is a server-side source picture, so a **square** one is as cheap as
a colour — but a **rounded** one is not. ntk's rounded-rect fast path (cached
corner glyphs plus `FillRectangles`) only takes a solid colour, so a rounded
gradient falls back to a coverage mask rasterized on the client and uploaded
per fill: about 4 KB per box per repaint. Damage bounding means that is only
paid where something changed, but a list of rounded gradient rows is the one
shape to think twice about — see the `shapes: 24 gradient+shadow cards`
scenario in `npm run bench`, which prices it.

### `boxShadow`

`<x> <y> [blur] [spread] [colour]`, comma-separated for several, painted
first-on-top like CSS's. The colour may be left out, which means the node's
own `color` — [`currentColor`](../docs/styling.md#currentcolor), which may be written out
too. A blurred shadow is a real gaussian — RENDER's convolution over a
coverage surface — cached by size, radius and blur, so a list of identical
cards renders one and composites it many times.

On macOS and Windows, which have no X server to bake one on, the shadow is
the 2d context's own `shadowBlur`, and the context draws a rounded rect's
shadow from a tile it makes once and stretches — see
[macos.md](../docs/macos.md#a-shadow-from-a-tile). The rest of this section is the
X11 route.

The blur is **baked into the cached surface's pixels**, in two separable 1-D
passes, rather than left as a filter on its picture. That is not an internal
detail: XRender applies a picture's filter on every composite, so a shadow
whose blur rode on the picture paid its whole kernel again every frame it was
drawn — a card-sized coverage surface at a wide blur is hundreds of millions
of multiply-accumulates, in the server, per shadow, per repaint. Baked, a
repaint composites a plain mask however wide the blur is, and the convolution
runs once per distinct geometry.

What it does not do, and why:

- **`inset` throws.** An inner shadow is a different drawing and a different
  damage story, and painting an outer one where an inner was asked for is a
  bug with no visible cause. An inset border or a `<canvas>` says it today.
- **Ignored on `<window>` and `<popup>`** (with a warning in development). A
  shadow is painted outside the box, and a toplevel owns no pixels there —
  a real one needs the window to carry a translucent margin of its own,
  which is a feature rather than a line in the painter. Put the shadow on a
  `<box>` inside the window; for a floating menu, the popup's own
  `borderRadius` plus a border is what reads as raised today.
- **Neither transitions.** Both are several numbers and a colour in one
  string, and `interpolate` moves one value; they snap. A card that wants to
  rise on hover animates the `backgroundColor` or the border beside them.

A shadow is the first thing in this vocabulary that inks pixels the node
does not own, so it also widens what the node repaints — its offset, its
spread and the blur's tail — and the frame that _removes_ one claims where
it was. That is the renderer's business, not the application's, but it is
the reason a shadow is not free the way a colour is: prefer one shadow on
the card to one on every row inside it.

## Opacity

On the Cocoa backend a faded box is drawn into the window's bitmap like this
rather than lifted onto a layer of its own (docs/macos.md): a box and its
content on separate layers would fade one over the other, which is the thing
`opacity` exists not to do.

## Measuring text to its letters

The problem it solves is that **a line box is not the text**. It is the
font's ascent plus its descent plus its line gap, and the space over a
capital differs from the space under a baseline by `(ascent - capHeight) -
descent` — a property of the typeface, so a label is only ever optically
centred by luck. With the KaTeX face the tests use, a 24px label in a 12px
padded box sits 17px below the top and 18px above the bottom; trimmed, it is
12 and 12.

**The built-in widgets set it on every label**, which is why `paddingY` in a
palette is bigger than a CSS padding for the same look — it is the space you
see, not the space plus whatever the ascent left over. Which way a face is
off changes with the face: at 14px, SF NS leaves 3.7px above the capitals
against 2.9px below the baseline, so an untrimmed label rides low, while
Helvetica leaves 0.7 against 3.2 and it rides high. A widget cannot correct
for that, because it does not know the face it will be drawn in.

## Keeping text on one line, and saying when it did not fit

`maxLines` is the other half — CSS has no single-property spelling for it
(`-webkit-line-clamp` is what everyone actually writes), so this is the name
the platforms that got a clean shot at it chose. A three-line blurb that ends
in a `…` is `{ maxLines: 3, textOverflow: 'ellipsis' }`; the lines past the
cap are dropped before the box is measured, so the height is the kept lines'
and not the whole paragraph's.

### What `nowrap` and `ellipsis` do together

An eliding one is measured against the width on offer, because at unbounded
width there is one line, one line is never over the cap, and nothing would
ever be cut. So its floor is small and it **gives way**: it takes the room
that is left, shows `Applicati…`, and the column beside it keeps its width.
That is the behaviour a table wants — a column that cannot show a file name
should say so rather than making every other column narrower to avoid it.

What is truncated is a fact about the pixels and nothing else. A `<text>` that
was elided still reports the **whole** string as its accessible name, and the
caret and selection indices still index into the whole string — a screen
reader that read `Application Sup…` would be reading the layout instead of the
content.

## Inheritance: the ink, the face and the size

Nothing about that costs a layout pass. A state block may only set paint
properties and `color` (see above), so the only inherited property a pointer
can ever move is the ink — which drops the memoised text layouts under it
and repaints, with no re-measuring and no reflow. A `fontSize` change
_does_ re-measure, and it can only come from a React commit, a size query or
a theme.

**A value that is not one inherits.** `fontSize: '1.2ex'`, `fontStyle: 7`,
`fontWeight: 1200` or `lineHeight: 'tall'` is an error at the commit in
development, naming the property; where one gets past that — a `$token`, or
a production build — the text sets as though it had not been written, the way
CSS inherits past a declaration it cannot parse. Numbers may be numeric
strings (`fontSize: '20'`), as they always could, and a size is a
[length](../docs/styling.md#lengths-and-shorthands) like any other: `fontSize: '20px'` is 20,
and `'1.5em'` or `'150%'` is half again the size inherited. A `lineHeight`
in a length — `'24px'` — is that multiple of the node's own size. Before, a
size in px set no text at all and the others threw from inside a frame.

### `currentColor`

It stays the keyword in the node's style, which is CSS's computed value, and
becomes a colour where it is painted, so it follows the ink wherever the ink
moves: a `:hover` on a row above, a theme swap, a `color` transition frame by
frame. A node painting in it repaints when its ink moves, bounded to that
node, and a box does too although it draws no text; one that paints nothing
in it still costs nothing when the ink above it moves. A `<popup>` written
under the row inherits the ink like any other child and repaints with it.

## A font file of your own

### Reading a font without installing it

Both verbs read a given file once per connection, however often they are
called: the face is cached in the app's font manager, so `useFont` in a
component that re-renders sixty times a second parses nothing, and
`loadFont` after `openFont` on the same path registers the face already
open. This matters more than it looks — a second copy of a font is a second
glyph cache and a second server-side glyphset, and a node built against one
copy cannot be painted by the other.

`font` is ntk's `Font`, which has more on it than the four members above
([ntk's docs/fonts.md](https://github.com/sidorares/ntk/blob/master/docs/fonts.md)). If you need
anything else of ntk's — `Path2D`, `Image`, `Surface` — **import it from
`react-x11/ntk`, never from `ntk`**, and never declare `ntk` as a dependency
of your own. Two copies in one process are two font caches and two glyph
atlases, with the same consequence as above and a great deal further from
its cause.

## `createStyles`

Identity is the point — a hoisted style object lets `applyProps` skip the
whole update with a `===` check, the same reason RN's `StyleSheet.create`
still exists now that its id registry is gone. It also validates keys, which
a bare object literal cannot: an unknown style property is an error at
declaration instead of a silent no-op.

## In components

A component's own props are never style. `ProgressBar` takes `color`,
`Dialog` takes `width`/`height` — a dialog is a real popup window and needs
its geometry up front — and `ContextMenu` takes `fontSize` because it
measures labels with it. `Select` and `Slider` used to take `width` purely
to put it in their own box; that is `style={{ width }}` now.

## Theme tokens

Changing the theme restyles the subtree in place. Nodes whose own props did
not change are still updated — which is why a theme change also drops the
memoised text layouts under it, or cached text would keep painting the old
colour.

That is deliberately not a throw. Resolution happens when a node's ancestry
completes — inside a commit, and also from an X event when the desktop
switches between light and dark — and on both of those paths a throw is
uncatchable: it either lands on the `<window>` fiber above every error
boundary the app wrote inside it, or it unwinds into the frame loop with no
React on the stack at all. One wrong character in a style value should not
be able to blank the screen.

Set **`REACT_X11_STRICT_TOKENS=1`** to make it fatal again — for a kiosk, or
a build that would rather stop than paint something wrong. Strict mode also
throws in the right _place_: the error is raised from the offending node's
own `commitMount`, so an error boundary at any depth inside the window
catches it and shows a fallback for that subtree. Where React genuinely is
not on the stack — the desktop appearance switch — strict mode crashes,
which is what it was asked for.

## Sticky positioning

- **It lands in the frame that scrolled.** The pane applies the offset in
  the layout pass the scroll runs — never through a re-render — so a header
  cannot trail its content by a frame, and a pane of headers keeps the
  scroll blit: a header riding with its rows costs nothing, and a held one
  repaints its own rect.

## Grid

- **It is checked against Chrome.** A corpus of grids Chrome laid out is
  part of the test suite (`test/grid-conformance.test.js`) and lays out here
  within a pixel of Chrome's, but for the fraction above.

## Transitions

Numbers lerp and colours lerp per channel through ntk's own CSS colour
parser, so anything the paint path accepts animates. Two percentages of the
same unit lerp as numbers — `'-40%'` to `'100%'` is a value travelling across
whatever contains it, with nothing measuring the container. A value with no
meaningful midpoint — an enum like `flexDirection`, `auto`, a percentage
against a pixel value — snaps instead, and `zIndex` is excluded on purpose:
restacking every frame is not an animation. A duration keyed by a
[shorthand](../docs/styling.md#lengths-and-shorthands) is its longhands', the longhand's own
entry winning: `{ border: 150 }` fades the colour `border: '1px solid …'`
set, and `{ padding: 200 }` moves each side `padding: '8px 16px'` expanded
into.

The animation _is_ the repaint loop: the window keeps asking its frame clock
for frames while any transition is unfinished, and stops the frame the last
one lands. Nothing polls, and there is no per-widget
`requestAnimationFrame`.

Transitions may animate layout properties, unlike state blocks. That is not
an inconsistency: a pointer move must never reflow the tree, but an author
who writes `transition: { left: 200 }` has asked for animated layout and
pays a layout pass per frame for it, and a repaint of whatever that pass
moves rather than of the window. `Switch` is the worked example — the
thumb is absolutely positioned and slides on `start`, because
`justifyContent` would flip between the ends with nothing in between.

### Loops

Why this and not a repeating `transition`: a transition is defined by a
_change_, from what is on screen to a new target, and it has no cycle to
repeat. A loop has no target — it has two ends and a period. They are
different declarations because they are different things, and one of them
would otherwise have to be spelled as the other with a flag.

The easing default differs from a transition's for the same reason. A change
that ends looks right slowing into its new value; a cycle that restarts
would stutter at the wrap, so a loop is `linear` unless you say otherwise.

**A loop costs a repaint of what moves.** It is the same machinery
transitions run on — the window's own frame clock, a damage region claimed
per frame — so an indeterminate progress bar repaints the bar, not the
window. The alternative an app would otherwise write, `setInterval` →
`setState`, is a re-render of the component and a repaint of whatever the
damage heuristics decide, at a cadence unrelated to when the window can
present.

On macOS a loop — or a transition — on a plain box's colour, border width
or radius is handed to Core Animation instead and costs no frames at all:
the layer presenter runs it on the node's own layer, and the surface
presenter promotes the node to a layer of its own above the window for as
long as it animates, where nothing is painted over it
([macos.md](../docs/macos.md#layer-promotion-the-animated-few-on-their-own-layers-above-the-surface-presenter)).
So is a loop on an inset of a box out of the flow that says no pointer
lands on it — `position: 'absolute'` and `pointerEvents: 'none'`, as the
block of `<ProgressBar indeterminate>` does — since it moves that box and
nothing else: it becomes the layer's position. Without `pointerEvents:
'none'` it stays on the clock, because input is hit where the layout put
the box.
Anything else runs as above. `examples/animation.jsx` has both shapes side
by side, with a frame counter in the terminal that shows the difference.

**And it stops itself**, which is the whole reason this is core's job. A
forever-loop keeping a frame clock alive is invisible when it is wrong, so
every way of going off the screen is wired to it:

|                                                                                                                                    |     |
| ---------------------------------------------------------------------------------------------------------------------------------- | --- |
| the window is unmapped, minimized, or fully obscured under a bare WM                                                               |     |
| anything above the node hides it — `display: 'none'`, `<Suspense>`, `<Activity>`                                                   |     |
| the node unmounts, or the style stops declaring the loop                                                                           |     |
| the desktop asked for **reduced motion** ([system.md](../docs/system.md#usedesktopsettings--how-the-desktop-wants-an-app-to-feel)) |     |
| all the loop can draw is out of sight — scrolled out of its pane, clipped away by a box above it, off the window                   |     |

Each one leaves the frame clock idle, and every one of them runs the loop
again when it goes away — with its phase reset, since a loop that resumes
mid-cycle would have been drawing where nobody could see it.

Nothing about this is a per-frame callback: `animation` describes the motion
and the renderer runs it. For a `<glarea>` drawing its own frames,
[`frameLoop`](../docs/gl.md) is the per-frame seam, and a 2D one is not
built yet.

## Window size queries

**A size query may set layout properties, unlike a state block.** That is
not an inconsistency: a pointer state must never reflow the tree, but a size
query is only ever re-evaluated inside a layout pass that a resize has
already required, so it costs nothing extra. Nodes that declare one are
registered with their window and re-resolved just before it lays out, and
only when the size actually changed.

## Container queries

### A block must not move the size it asks about

CSS makes this impossible by construction: `container-type: inline-size` is
size containment, the container is sized as if it had no content, and
nothing a descendant does can move it. Yoga has no containment, so here it is
a rule, and breaking it is detected rather than prevented. A block that
grows the container past the very threshold that turned it on — and shrinks
it back when it turns off — has no size that satisfies it. The renderer
notices (the node comes back to an answer it already held this frame),
**holds the answer it has**, and says so once in development, naming the
node. The answer stays held until the container's size moves for some other
reason.

## Decided

- **`':hover'`, not `_hover`.** The CSS spelling costs a pair of quotes and
  buys transfer from every other styling system.
- **Declared containers, not the parent.** `'@container'` answers to the
  nearest ancestor that _declares_ itself one, never to whatever happens to
  be the parent: a wrapper `<box>` added for a border must not change a
  component's answer. CSS spent a decade on element queries before shipping
  container queries with exactly this requirement. Nor is a scroller a
  container without saying so — it is the ideal one to declare, but the
  presence of one between a node and its container must not silently change
  which box answers. And there is no self query: a node's own size deciding
  its own layout is the cycle containment exists to forbid.
- **Inherited properties, no relational selectors.** `color` and the font
  properties travel down the tree; nothing matches a rule against it. So
  there is no `:hover > child`, no sibling combinator and no Tailwind-style
  `group`. Each of those exists to move a value across the tree, and
  inheritance already does it in the one direction that is cheap: a parent's
  `:hover` reaches its children because `color` is inherited, and a child's
  hover reaches its parents because the hover path is the ancestor chain.
  What is left over — a **sibling** reacting to a sibling — stays in React,
  where `useControl` already returns `hover`/`focused`/`pressed` as state
  ([components.md](../docs/components.md#basic-controls)). `<Checkbox>` does exactly
  that, because its well is a sibling of the label the press lands on.
- **`currentColor` resolves where it is painted, not in the style.**
  Resolving it where a `$token` resolves, once per style swap, would have
  made every reader of a colour simpler and every inherited change wrong: a
  `:hover { color }` on a row restyles no node under it, so an ink baked
  into their styles would be stale in every one. So the style keeps the
  keyword, as CSS's computed value does, and every reader — the paint on
  each backend, a Cocoa layer's properties, the blits deciding what a box
  covers — asks `resolveColor`.
- **Sticky sticks to a pane that scrolls, not to anything that clips.** CSS
  makes every `overflow` but `visible` a scroll container, so a header
  inside a card with `overflow: hidden` sticks to the card — which never
  scrolls — and appears to do nothing, the most asked-about sticky bug there
  is. Here `'hidden'` is CSS's `clip`: it clips and scrolls nothing, and only
  `overflow: 'scroll'` makes a pane (see
  [Sticky positioning](../docs/styling.md#sticky-positioning)). A header inside a rounded card
  sticks to the list the card scrolls in, and stays inside the card.
- **A registered position is a `position` value, not a property of its
  own.** CSS's `position` already picks a positioning scheme, and sticky is
  one whose insets mean something other than an offset; a scheme of your own
  is the same kind of thing. The first spelling, `placement`, was already
  the anchor vocabulary — which side of its trigger a popup opens on — and
  threw on the first `<popup placement>` it met. What one property costs is
  composing a scheme with `absolute`, which a wrapping box answers.
- **A layout is a style property, and runs inside the pass.** What a layout
  decides depends on sizes the pass produces, so a React-side one —
  measure in `onLayout`, set state — paints the old arrangement first, and
  misses every pass React never sees: a scroll, a live resize, a
  transition. A style property is also one a container query block can
  switch in the same frame.
- **The renderer mirrors right to left, not the algorithm.** An algorithm
  places from the left, once, and each slot is mirrored across the box when
  it reads right to left — the way yoga mirrors a flex row, so no layout can
  forget to.
- **`null` is unset, and a layout value the layout cannot take is an error
  where it is written.** `width: wide ? 240 : null` leaves the width to the
  layout, as `undefined` does — yoga's own setters threw on `null`.
  `width: 'hidden'`, `padding: 'auto'` or `flexDirection: 'sideways'` is an
  error at the commit in development, naming the property, and that includes
  a query block that does not match yet: the block is applied when it starts
  matching, which is inside a frame, and a throw from there used to take the
  process down. A value that only turns out wrong in a frame — a `$token`
  resolving to one — is dropped there and reported, the way CSS drops a
  declaration it cannot parse, and the rest of the block still applies.
- **A colour that does not parse is dropped, not painted.**
  `backgroundColor: 'nonsense'`, `7` or `'#12'` is an error at the commit in
  development, naming the property — in the style, in a state block, as a
  gradient stop or as a shadow's colour. `''`, like `undefined`, means
  unset. Where one gets past that — a `$token` whose palette entry is not a
  colour, or any value in a production build — the paint drops it the way
  CSS drops a declaration it cannot parse: no fill and no stroke, no
  gradient or shadow at all rather than half of one, and the inherited ink
  for text. On X11 it used to throw from the frame, where no error boundary
  could catch it, and the other backends painted it black.

- **The more specific property wins, not the later one.** CSS resolves a
  longhand against its shorthand by order. A flattened style has no order
  left — `[base, { padding: '8px 16px' }]` and `{ paddingTop: 0, … }` are
  keys of one object by the time anything reads them — so a longhand beats
  its shorthand and a side beats all four, wherever each is written. It is
  the rule `paddingLeft` beside `padding: 8` always followed.
- **A length is pixels, and a unit nothing reads is an error.** `'12px'` is
  12 — scaled for the display like any number, where it used to reach yoga
  as a string the scale skipped and the border setter read as NaN — and
  `'2ex'` names its unit rather than becoming 2.
- **`rem` is the palette's `fontSize`, not 16.** CSS's root font size is
  whatever the document's root says, and here that is the theme: the size
  every label nobody styled is set in. So spacing written in `rem` follows a
  theme that sets a bigger type size, as the palette's own radii and
  paddings already do, and an app porting web numbers that assume 16 sets
  `fontSize: 16` on its theme. The nearest palette is the one read, the way
  a `$token` is — a `<ThemeProvider value={{ fontSize: 12 }}>` around a
  dense panel re-bases it.

## Next

A
`boxShadow` that a `<popup>` can cast (the window needs a translucent margin
around itself first — see [elements.md](../docs/elements.md) on `transparent`
popups). Container queries shipped; the design record, with the targeting
forms considered and the cost measured, is
[architecture/container-queries.md](architecture/container-queries.md).
