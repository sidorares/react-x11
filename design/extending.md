# Extending the element vocabulary: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/extending.md](../docs/extending.md), the reference, and keep
their original headings so code comments that cite them still resolve.

Every heading of extending.md stayed in the reference, which now states the
contract tersely. What is kept here, under copies of those headings, is the
original wording of the paragraphs whose history, issue references,
measurements, mechanics or longer rationale the reference no longer carries.

## The definition

Two of these exist because getting them wrong fails a long way from the
cause, so they are worth understanding rather than copying:

**`drawn` decides whether your element paints at all.** `paintOrder()`
filters children on the set of drawn kinds; a node missing from it lays out
correctly, reports a sensible `abs` rect, and never appears on screen, with
no error anywhere. `registerElement` puts you in that set unless you opt out.

**`semanticNames` is the difference between DEV and production.** react-x11
throws in development on `<box width={10} />`, because `width` is a style
property written flat — a real mistake with an unhelpful failure otherwise.
An element whose own vocabulary overlaps the style vocabulary (`width`,
`color`, `fontSize`) therefore has to say so, or it throws on its own props
in development and works in production. `<window width>` is the built-in
precedent: on a `<window>` it is the X window's width and never style.

## Registering under hot reload {#hot-reload}

Register at module scope — the pattern everything above shows, and the one
tree-shaking forces on a component library. That module scope re-runs when
[`react-x11/refresh`](../docs/ecosystem/dev-tooling.md#react-refresh) hot-reloads
the module, so `registerElement` has a re-registration policy rather than
a footnote:

- **The same `create` reference is never a conflict.** A definition
  arriving twice replaces silently, latest flags winning.
- **Under an active hot-reload session, any duplicate replaces silently.**
  The session begins with the first hot re-import and covers the rest of
  the process: from then on, "already registered" would only mean
  "registered by the previous version of yourself". Mounted nodes keep the
  old prototype until they remount — the same staleness contract Fast
  Refresh has for classes; new mounts get the new definition.
- **Outside a session, a duplicate still throws.** Two packages claiming
  one element name in a plain run is a conflict to be told about, and
  `override: true` remains the way to say a replacement is deliberate.

## The node contract

- `this.scale` — device pixels per logical pixel ([scale.md](../docs/scale.md)).
  `this.style`, `this.abs`, `contentBox()`, the paint context, every rect you
  hand `invalidate` or `scrollContents` and every rect you report to a screen
  reader are device pixels already; a synthetic event's `x`/`y` are logical,
  so a hit test against `abs` reads `ev.nativeEvent.x`/`y`, or multiplies.
  On a 1x display the two units coincide — which is exactly how an element
  that mixes them passes every headless test and then hovers, drags and
  frames at half the distance on a retina panel.
  `renderX11(element, { scale: 2 })` is the test that catches it. It is a
  per-node number rather than a per-window one — an enclosing `scale` prop
  zooms a subtree ([scale.md](../docs/scale.md#a-subtree-of-its-own)) — so read it
  off the node rather than caching one for the tree.

- `this.resolveColor(value)` — a colour from this node's style as one a
  context can paint: the value itself, or for
  [`currentColor`](../docs/styling.md#currentcolor) the node's ink. Every colour
  core paints goes through it, so a colour of yours read off `this.style`
  should too — `ctx.strokeStyle = this.resolveColor(this.style.borderColor)`
  — or it paints nothing where the app wrote the keyword. A node whose
  style paints in `currentColor` repaints when its ink moves, without being
  asked.

To ask for a repaint: `this.invalidate(layout, damage, reason)`. Pass the
damage — `this` is usually it, or a rect when you know a tighter one. An
invalidation with no bound repaints the whole window, which is this
renderer's main performance bug class (see [debugging.md](../docs/debugging.md)).
`reason` joins the closed set the diagnostics print. Damage is collected on
the window node and `invalidate` on any node forwards there, so an element
that is not attached yet invalidates nothing rather than throwing.

### Text of your own

**`contentBox()` is not `abs` minus `style.padding`.** The insets come off
the layout, which is where `padding: '10%'`, the per-side overrides and the
border widths have already been resolved against this frame's size — so the
box an element computes from the style bag agrees with the one `<text>` uses
only by luck, and stops agreeing the next time the vocabulary grows another
edge — the per-side border widths were the last one to arrive.

**`resolvedTextStyle()` is what makes the type of an app reach your
element.** It is the node's own font properties over what it **inherits**
from the elements around it, and under that what the palette says text with
none of its own is set in — in the shape `fonts.layout` wants (`family`, not
`fontFamily`; `variations`, not `fontVariationSettings`; `features`, what
`fontVariantNumeric` and `fontFeatureSettings` resolve to together). An
element that reads `this.style.fontFamily` instead is one that a
`<ThemeProvider value={{ fontFamily: 'Inter' }}>` does not reach, and one
that a `<box style={{ color: theme.dim }}>` around it does not dim — bugs an
app author can only work around by growing props on your element and
threading them in. Ask, and the element inherits exactly what a `<text>`
sibling inherits, including a `:hover` block on the row it sits in
([styling.md](../docs/styling.md#inheritance-the-ink-the-face-and-the-size)).

Both are read at paint time. `contentBox()` is computed each call, since the
box changes with every layout; `resolvedTextStyle()` is memoised and dropped
by everything that can move it — a style change, a state block, an
animation tick, a theme swap, an element above it changing its own type — so
reading it per frame costs a property lookup and never goes stale. If the
text is also what _sizes_ the element, shape it in `measureContent` as well;
`<text>` memoizes its layout per max-width for exactly that reason. An
element that keeps a cache of its own keyed on the type — a shaped run, a
rasterized label — should drop it in **`_textStyleMoved(cost)`**, which is
called with `2` when a glyph can have moved and `1` when only the ink or the
glyph rounding did. The default re-measures on the first and repaints on the
second, which is right for most elements.

**Text drawn where a context is not.** A GL surface's labels, or a signed
distance field made from a string, need the text as pixels rather than
drawn onto a surface — and a surface read back is a round trip for pixels
the engine had, one that answers asynchronously and in the ink the screen
gets (hinted, gamma and contrast applied). A layout answers
**`coverage({ pad })`** instead (#673): how much of each device pixel its
glyphs cover, one byte a pixel, synchronously — the layout box in whole
pixels with `pad` round it, the layout's origin at `(pad, pad)`. Linear,
grayscale, unhinted: the outlines' own coverage, which is what a raster that
will be scaled wants.

It is optional on purpose: ntk's layout answers it (X11, Wayland, the mock),
and so do DirectWrite's (Windows) and CoreText's (macOS), each from the
release that added it. Feature-detect, keep a readback, and never assume
the two are pixel-identical — `draw` snaps and hints, coverage does
neither.

### Answering for your own text

_Issue #259._ An element that draws text can also let the user **select**
it. There is no registration call and no list of blessed kinds: a
`selectable` ancestor walks its subtree and asks every node four questions,
and an element that answers them is part of the document.

**Two spaces, and both are the ones already in use.** Indices are **code
points** — the space ntk's `TextLayout.caretPosition`/`indexAt` speak, so an
emoji is one position and not two — and rectangles are in the **owning
window's** coordinates, the same as `abs` and `contentBox()`: device pixels.
(A mouse event's `x`/`y` are the same coordinates in logical pixels —
[scale.md](../docs/scale.md).) An element that answers in its own local coordinates
is one whose highlight is drawn somewhere else on the screen.

**Answer from what you draw.** `<text>` computes its layout and its origin
in one place and uses it for painting and for all four accessors, because a
caret answered from a differently-placed layout is a caret in the wrong
place and nothing about it looks like a bug in the accessor. If your element
scrolls, the origin has the scroll offset in it — that is what makes a hit
test right after the user has scrolled.

**One band per line, and one per direction run.** A selection is contiguous
in _logical_ order and a line is laid out in _visual_ order, so a range that
crosses from Latin into Arabic covers two disjoint stretches of pixels. If
you are drawing with ntk's `TextLayout`, walk `line.runs` and intersect each
one with the range rather than filling from one caret x to the other;
`<text>` does this and `test/text-selection.test.js` pins it.

**Say if you own a selection of your own.** An element that edits — anything
with a caret the user moves — sets `hasOwnSelection = true` in its
constructor. A `selectable` document then skips its subtree whole and never
takes its presses, which is what keeps a `<textinput>` inside a document
from having half of it lit by somebody else's drag.

**Presses arrive through the base class.** `Node`'s `defaultMouseDown`,
`defaultMouseDrag`, `defaultMouseUp` and `defaultKeyDown` hand the gesture
to the nearest `selectable` ancestor, so an element that only draws needs to
write none of them. An element that overrides one and does not call `super`
has taken that gesture for itself — right for an editor, and the reason a
drawing element that wants both should end its handler with
`super.defaultMouseDown(ev)`.

### A size of your own

`<gauge ticks={6} />` is then 180×24 with nothing in the style saying so, the
way `<textarea rows={6}>` is six lines tall.

It has to be a **method on the class**: the base `Node` constructor is what
wires it to layout, so an element that assigns it in its own constructor is
too late and never gets asked. `invalidateMeasure()` says so in development.

#### What it is asked

The `at-most 0` row is the one worth reading twice, because it is not only
the layout that asks it. The renderer measures the smallest size every node
can be drawn at — by laying the tree out with **no room at all** and asking
each leaf directly — and writes that back as the element's own floor, so a
row too narrow for it squeezes it that far and no further
([elements.md](../docs/elements.md#everything-shrinks-nothing-shrinks-to-nothing)).
The same measurement read at the top of the tree is what
`<window minWidth="auto">` sends the window manager. An element that answers
0 there is saying it can be squeezed to nothing, and both floors come out
without it.

`at-most` is what is _available_, not a cap that will be enforced: an element
may answer larger and it will be laid out at what it asked for, overflowing
whatever contains it. That is how `<text textWrap="nowrap">` works, and it is
the honest answer for content that genuinely does not reflow — a code block
that scrolls sideways rather than wrapping.

#### What it must not do

`measureContent` is a **question about a hypothetical**, asked several times
per layout and at sizes nothing will ever be drawn at. So:

- **do not read `this.abs`** — it is the result of the layout doing the
  asking, and last frame's answer at that;
- **do not paint, invalidate, or set state.** Cache derived work if it is
  expensive (`<text>` memoizes its shaped layout per width), but keep the
  answer a pure function of the content and the constraints;
- **answer with finite numbers.** Content that has not arrived yet is
  `{ width: 0, height: 0 }`, not `undefined` — anything else throws naming
  the element, because a `NaN` would otherwise spread silently through every
  ancestor's rect.

An element that measures itself **cannot have children**: layout sizes it
from the measure function and gives its children no say, so rendering one
inside it is an error naming both elements.

#### Content with an aspect ratio

It shrinks to the width on offer with the height following, and scales the
width from a style height when only that axis is fixed — which is what an
`<img>` does, and is the whole of `<image>`'s own measurement.

### Behaviour of your own

An element that _does_ something — an editor, a terminal, a table with cell
editing, a tree with type-ahead — implements the **default actions**. They are
the same seam `<textinput>`'s editing runs on, and the ordering is the whole
point:

1. the application's `onKeyDown` / `onMouseDown` / … handlers, capture then
   bubble;
2. **if none of them called `ev.preventDefault()`**, the element's `default*`
   method.

So an app can veto the behaviour, or run something before it, without knowing
how the element is built — which is what `<textinput onKeyDown>` has always
been able to do, and is the reason to implement behaviour here rather than in
a React component wrapping the element.

| method                   | when                                                                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultKeyDown(ev)`     | a key, delivered to the focused node. `ev.keysym` is the `XK_*` constant — the Latin one, so a chord matches under any layout; `codepoint >= 0x20` is the test for "this is text"                                           |
| `defaultKeyUp(ev)`       | that key was released. Rare — nothing in core needs it — and there for an element that answers the whole keystroke rather than the press, such as `<foreign>` forwarding into an embedded client                            |
| `defaultComposition(ev)` | text still being typed — a dead key, a Compose sequence. `ev.type` is the phase, `ev.data` what to show, or at the end what to insert                                                                                       |
| `defaultMouseDown(ev)`   | a press. Place a caret, grab a handle; `ev.capturePointer()` to keep the rest of the gesture                                                                                                                                |
| `defaultMouseDrag(ev)`   | motion while _this_ element holds the press — including outside its box, which `onMouseMove` does not give you                                                                                                              |
| `defaultMouseUp(ev)`     | that press was released                                                                                                                                                                                                     |
| `defaultMouseMove(ev)`   | the pointer moved over this element, no button down — light the node, the edge, the handle it is over. The first one after it arrives is the enter                                                                          |
| `defaultMouseLeave(ev)`  | …and the pointer left: put that back                                                                                                                                                                                        |
| `defaultWheel(ev)`       | the wheel, before the scroll chain — for the element whose wheel is not a scroll. `ev.preventDefault()` consumes it                                                                                                         |
| `defaultContextMenu(ev)` | right-click, after the press: open your own menu. Separate so suppressing it keeps the caret placement                                                                                                                      |
| `defaultFocus(info)`     | this element became the focused node (or its window got the X focus back): start the caret blinking. `info` is `{ reason, backwards }` — `'key'` with a direction is a Tab, which is the only thing that has ever needed it |
| `defaultBlur()`          | focus left, or the window lost it: stop it                                                                                                                                                                                  |

**The wheel that is not a scroll.** `canScroll`/`scrollBy`
([below](../docs/extending.md#scrolling-content-you-painted)) route the wheel for content that
scrolls, and they hand the element deltas only — which is the whole of the
gesture when the answer is "move by that much". It is not the whole of a zoom
about the pointer: that needs the point that must _not_ move (`ev.x`/`ev.y`)
and the modifier that tells a zoom from a pan, and it answers the wheel
whether or not anything "can scroll". `defaultWheel(ev)` is the whole event,
at the node under the pointer, before the chain walks; `ev.preventDefault()`
consumes it and the walk never runs. The deltas are as the device measured
them, fractions included — the whole-pixel rule the chain follows is there
for the scroll blit, and a zoom factor is continuous.

**Tab is an ordinary key here.** It reaches `defaultKeyDown` before focus
traversal sees it, so an element can keep it — an editor indenting with Tab
does not need a wrapping component to get it, which is what the ordering used
to force. Consuming it means calling `ev.preventDefault()` from the default
action: what that prevents is the default action _after_ this one, which for
Tab is the focus cycle.

An element that eats Tab has taken the keyboard user's only way out of it, so
it owes them another. The convention, above and worth converging on: **Escape
arms one pass-through Tab.** Escape on its own does nothing visible, the next
Tab leaves, and the one after that indents again — the same bargain a code
editor on the web makes, and the reason a screen-reader user is not stuck in
your element.

**An element that forwards keys somewhere else sets `composes = false`**
instead. Composition is ours to run only when the text lands in our tree;
an element handing the raw key event to another program — `<foreign>` and
its embedded client — wants the dead key itself, and the client's own input
method takes it from there.

### Text a screen reader can read

An element that draws text of its own is, to an assistive technology,
nothing at all: a painted rectangle with no characters, no caret and no
selection in it. `<textinput>` is not — it implements AT-SPI's `Text` and
`EditableText` interfaces in full — and the difference is one method
(issue #257):

That alone buys the whole read side: character count, reading by character,
word and line, the caret, the selection, and the `text-changed` /
`text-caret-moved` / `text-selection-changed` deltas Orca narrates from —
through the same code that serves `<textinput>`, so a third-party editor is
read by the paths core is read by rather than by a parallel set of them.

**The two tiers are the two kinds of element.** A viewer — a markdown
document, a code block, a log, a terminal — reports `value` and a selection
and stops there: it gets the `Text` interface, a `document` role, and a
selection an AT can read and set, which is the whole of what "select this
paragraph and copy it" needs. An editor adds `editable: true` and
`a11yReplaceText`, which is what turns on the EDITABLE state and the
`EditableText` interface. An element that claims `editable` without
implementing the write **is** still announced as editable and reports its
own edits — it simply is not exposed as one an AT may type into, because an
interface whose every method answered "no" is a lie an AT cannot see
through.

Four details, each of which is a defect the other way round:

**Offsets are code points and they index what you draw.** `Array.from(value)`
is the counting, and `value` is the string on the screen — an open
composition included, because every geometric answer beside it (the extents
of character _n_, a magnifier's highlight) is read off the glyphs a sighted
user sees. Say which part is uncommitted with `preedit: { offset, text }`
and its churn is marked as text the user did not type, exactly as
`<textinput>`'s is ([accessibility.md](../docs/accessibility.md#while-a-composition-is-open)).
Offsets you report are clamped for you, so a caret left stale between an
edit and your own bookkeeping cannot become an out-of-range answer on the
wire.

**`notifyA11yTextChanged()` is free when nobody is listening** — one
property read, the hook slots being empty until a bridge or the test spy
fills them. So call it from every path that moves the text, rather than
asking whether accessibility is on.

The behaviour is assertable without a screen reader, a desktop or a bus:
`renderX11(el, { a11y: true })` hands back a spy that records the same feed
([accessibility.md](../docs/accessibility.md#asserting-what-a-screen-reader-would-hear)),
and `test/a11y-custom-text.test.js` in this repo is a worked editor and a
worked viewer driven through it.

### A scene a screen reader can walk

_Issue #304._ An element that draws a hundred interactive things is still
one node, so it is one accessible: a graph pane full of selectable,
draggable, connectable nodes reads out as **"Flow graph, group"** and stops
there. Nothing in it can be found, named, activated or told apart, and no
amount of `role`/`aria-*` on the element itself changes that — the objects
an assistive technology would need are not in the tree, because you drew
them.

Each becomes a real child of your element's accessible: named, placed,
walked into, focusable, with `selected` announced as it changes — the same
model a `<box role="listitem" aria-selected>` goes through, because that is
literally what these are read as. `id` is the whole of what core needs from
you: it is what makes the child that was there last frame the same child
this frame, and therefore what keeps every reference a screen reader is
holding alive across a scene you rebuild sixty times a second.

Four things worth knowing before you write one:

**`focused` is the only way your cursor is reported.** The window's focus
manager holds your element, not the thing inside it that arrow keys move —
which is right, and it means the state has to come from you. Reporting it
is all that is asked: navigation between items stays yours.

**Actions fall back rather than fail.** With no `a11ySceneAction`, an
activation is a synthetic click at the item's own rect — you hit-test your
scene already, so the rect is the whole address and an AT's click is
indistinguishable from a mouse user's. `focus` focuses the element,
`scroll` reveals it. Implement the seam for the cases where that is wrong
(an activation that is not a click, a cursor to move, a viewport of your
own to scroll), claim those with `true`, and let the rest fall through.

**An action needs a role that promises one** — `button`, `option`,
`treeitem`, `checkbox` — _or_ your `a11ySceneAction`, which is the same
promise made directly. A `listitem` with neither is read, not clicked, the
same as everywhere else in ARIA.

**`a11yScene()` is called once per question**, so answer from what you
already hold. It is the same rule `a11yTextState()` follows, for the same
reason: a shaping pass or a copy of your model behind it turns a screen
reader walking the tree into a frame budget.

Assertable with no bus and no desktop, through the same spy:
`renderX11(el, { a11y: true })` records an item's states changing exactly as
it records a `<Checkbox>`'s, and `test/a11y-scene.test.js` is a worked graph
pane. The wire itself — children, extents, actions — is covered in
`test/atspi.test.js`.

### The standard edit menu

A `<textinput>` gets a right-click Undo / Cut / Copy / Paste / Select All
menu without being asked. An element that edits or selects text of its own
gets **the same menu** — not one that looks like it — by naming its verbs
and letting core do the rest (issue #256):

What that buys, and the reason it is worth an export rather than a recipe:
the rows and their order, the enablement rules, Paste watching **selection
ownership** instead of asking the server on the way to opening a menu
([elements.md](../docs/elements.md#the-right-click-menu)), the arrow keys and
Escape, the pointer grab that dismisses it, and handing the keyboard back to
wherever it came from afterwards. `<textinput>` is a caller of this function,
which is what keeps the two from drifting.

**A verb you leave out is a row that is not there** — not a greyed one. It
was `<textinput sensitive>` that motivated the rule, where a disabled Copy
over a password reads as a bug in the application rather than as a decision,
but it is also exactly what a **read-only** surface needs: a rendered
document that can be selected and copied passes three things and gets a
two-row menu, with no dead Undo, Cut or Paste to explain.

**Enablement is not yours to decide row by row.** You answer three questions
only the target can answer — `canUndo`, `canRedo`, `canSelectAll` (which
defaults to true: the surface is empty, or all of it is selected already) —
and hand over `hasSelection`. Cut and Copy follow the selection, Paste
follows what the server has said about the clipboard. That is the part a
second implementation would get subtly wrong.

`at` is where the pointer was, in the **owner window's** coordinates — the
`x`/`y` a synthetic event carries. A surface with no caret has nothing else
to offer, and this is what it already has; the menu is placed on the screen
from there, clamped into the monitor it opens on.

### Scrolling content you painted

A `<box overflow="scroll">` scrolls **children**: layout knows where they
are, so the extent, the bars, the clamping and the wheel all follow from the
tree. An editor, a terminal or a canvas-backed table has no children — its
content is pixels it draws — and it still has a scroll position, an extent
and a wheel gesture to answer. Two methods make it a member of the same
machinery instead of an exception to it (issue #253):

**The wheel's default action is those first two and nothing else.** It walks
out from the node the pointer hit, asks each one `canScroll(deltaX, deltaY)`,
and the first that says yes gets `scrollBy` — up to the `<window>`, where the
walk stops. So an element joins the chain by answering two questions, and it
**chains** by answering the first of them honestly: say no when there is
nothing left to move and the wheel goes to the pane or the window behind you,
which is what a browser does and what a user flicking through a long page
expects. `<textarea>` is the worked example in core — it scrolls wrapped text
it painted, and since it answers `canScroll` off that text, a short one hands
the gesture outward rather than swallowing it.

The one thing ahead of the walk is the hit node's own `defaultWheel`
([above](../docs/extending.md#behaviour-of-your-own)) — for an element whose wheel is not a
scroll at all, a pane that zooms about the pointer. Consuming the event there
is what keeps the walk from running; leaving it alone is what puts the
element back in this chain.

Answer `canScroll` from the **extent, not the position**: a viewport already
scrolled to its bottom should keep the rest of a flick rather than pass it
to whatever is behind it.

Both deltas are **whole pixels**, and stay whole however the scroll was
measured. A touchpad on a server with XI2 reports fractions of a notch and
`ev.deltaY` carries them ([events.md](../docs/events.md#wheel)), but the default
action spends only the whole part and carries the rest to the next event —
because a fractional scroll offset is one the server-side blit cannot shift,
and a smooth gesture that repainted every frame would cost more than it
looks. So an element joining the chain never has to think about sub-pixels,
and a slow scroll still moves: a pixel at a time.

#### The mixin, for everything else

`measureScrollContent` is called at most once per layout pass, from
`absolutize`, so it may read layout geometry, but it must not paint or
invalidate. It has to return finite numbers: a `NaN` extent would otherwise
become a `NaN` offset and a subtree laid out at `NaN`, so returning anything
else throws naming the element, exactly as `measureContent` does. The answer
is cached across passes that laid nothing inside the pane out again — a pass
that merely scrolled reuses it, since a scroll cannot change how far the
content reaches.

When the drawing changes its own extent — a line was typed, rows arrived —
say so the way any other layout change is said, with
`this.invalidate(true, this, 'scroll')`; the next pass asks again. That call
is also what re-arms the measurement above: content that grows silently and
never invalidates would scroll against the stale extent.

#### Scrolling the pixels, not just the offset

`copyWithin(src, dx, dy)` shifts `src` (`{x, y, width, height}`, in surface
coordinates) in place by an integer delta and answers **whether anything
survived** — `false` means repaint the lot, which is the branch a fresh
buffer, a jump to the far end and a resize all take. It is one `CopyArea`
inside the pixmap: nothing crosses the wire but the request, the overlap is
safe, and no exposure events come back.

The same element runs unchanged on the Cocoa, Wayland and win32 backends.
`react-x11/ntk`'s `Surface` asks the app it is handed for the
implementation — ntk's pixmap on an X connection, a CG bitmap on a Cocoa
app, a GL render target on a Wayland one, a Direct2D bitmap on a win32 one
— so the surface above is a bitmap there, `copyWithin` is one in-place copy
of the band (on win32 it answers `false` for now, the bridge having no
in-place blit for an offscreen bitmap, so the element repaints the rect),
and `drawImage` is one composite, with the element naming no backend. The
one thing to know: where a surface has one graphics state rather than a context per
call — a bitmap, a render target — `getContext('2d')` answers the same
context every time and its `destroy()` is a no-op (docs/macos.md "Custom
drawing on a layer tree").

**Drawing into a surface, whichever backend.** ntk's advice — a caller
doing many draws takes `getContext('2d')` once and holds it, rather than
one context per frame — holds everywhere, including the backends where the
surface is a GPU target and every context in the process shares one GL
device. A held context there takes the device back whenever it finds it in
someone else's hands, so its draws land in its own surface even in the
middle of the window's own paint, and the window's context does the same on
its way back (issue #566). Nothing to branch on, and nothing to restore:

```js
drawRows(rows) {
  const ctx = (this.ctx ??= this.surface.getContext('2d'));
  for (const row of rows) this.paintRow(ctx, row);
}
```

`surface.render(fn)` is the scoped alternative: it hands `fn` a context
whose transform and clip start clean and flushes when `fn` returns. Use it
for a whole-surface repaint; hold a context for a grid that is touched a
few cells at a time. The one thing not to do is mix them and expect the
held context's transform to survive a `render()` — it is the same context,
and `render` resets it.

`copy` is canvas's "replace these pixels, do not read what is under them",
and it means the same thing on both backends: XRender's `PictOp.Src` on
X11, and on Cocoa a row memcpy in place of the CGImage the blend would
otherwise be built from — a 125x45 terminal grid composites in 0.42ms
rather than 1.37 (docs/macos.md "Compositing a surface at a translate").
Set it back, or set it inside a `save`/`restore` pair: it is context state,
and the context is the window's. It is only right for a surface with no
transparency to show through, and it is refused rather than approximated by
a backend that cannot draw it — assign it and read the property back if you
want to know which you got.

Two things it lines up with. The deltas you are handed are already whole
pixels — the sub-pixel carry described above exists so that a shift is
always expressible — so an element scrolling this way never has a fraction
to round. And `<box overflow="scroll">` has been doing the window-side half
of this without being asked: a pure scroll of one viewport blits the
surviving band inside ntk's backing pixmap rather than repainting it. This
is that optimisation, for a buffer you retained yourself.

An element that draws its content live rather than into a surface asks for
the window-side half directly, with
[`scrollContents`](../docs/extending.md#panning-a-scene-you-drew) — the same shift, one layer
out.

#### Drawing what stays put while the pane scrolls

That window-side blit copies everything in the pane's viewport with its
content, which is right for everything that scrolls. An element that
paints part of itself **against the pane's viewport** rather than against
its own box has pixels the copy gets wrong: a document with a fixed
background or a `position: fixed` header, drawn by one element inside a
`<box overflow="scroll">`, had its header dragged along with the text and
its background scrolling away. `viewportFixedRects()` is the element's word
for those parts: window coordinates, device pixels, like `abs`, or `null`,
the default.

A scroll of the pane that blits repaints those rects where they are and
where the copy dragged their image, as it does the corners of a rounded box
around the pane; one that pins most of the viewport — a fixed background
behind all of it — makes the scroll a repaint, which draws it right. Only
the nearest scroll pane asks: a pane further out moves the inner one with
its content, and what is fixed to it with it. The answer is read on each
scroll the pane blits, after layout, and nowhere else.

#### Keeping what the viewport shows while your content moves

A document laid out again at another width breaks its text above the fold
into more lines or fewer, so the paragraph at the top of the viewport moves
down the document or up it by the difference, and a pane that keeps its
offset shows the reader whatever is at that offset now: a window dragged
narrower scrolled them away from where they were reading. A browser keeps
the paragraph where it was on screen instead, and moves the offset by as
much (CSS Scroll Anchoring 1). `anchorScrollBy(dx, dy)` is how an element
asks its scroll pane for that: its content moved by (dx, dy) device pixels
under the viewport, in the layout pass running now, and the nearest scroll
pane moves its offsets by as much, after it measures what it holds and
before it places it, so the frame that lays the content out again shows it
where it was.

Ask it from the layout pass — `measureContent`, or what it calls — where
the pane places what it holds after; shifts asked in one pass add up, and
one asked outside a pass waits for the next and asks for it. A `scrollTo`
the application made since the last pass drops it, since the shift was
measured against the offsets before that scroll; a `scrollIntoView` lands
after it; and the result is clamped to what the pane holds, as any scroll
is. It returns false where nothing scrolls the element.

### Drawing a scene into one node

_Issue #301._ A frame repaints **rects, not windows**: claims coalesce into
disjoint rectangles, each gets its own clipped pass, and a subtree that lands
outside the pass being painted emits no drawing at all. All of that has one
granularity — the retained node — which is exactly right until your element
_is_ the scene. A graph view, a chart, a timeline, a code editor: the tree
says "one node, 1100×700", so a pass over the 80×40 box a dragged node moved
through redraws all three hundred nodes, all seven hundred edges, the grid
and the minimap into a clip that throws almost all of it away.

Two accessors make such an element a member of the same machinery rather
than the one exception to it. Both are opt-in, and both keep core's answer
when you say nothing.

**Committing: `selfDamagedProps`.** `applyProps` damages the whole node when
any non-event prop changes identity, which is right for every element whose
node _is_ what changed and always-everything for a scene pane. A controlled
graph app commits a new `nodes` array per drag step, so each step is one
scoped claim from the gesture plus one full-pane claim from the commit — and
the full-pane claim wins. Name the props whose damage your own `applyProps`
claims and the commit contributes none of its own:

```js
registerElement('flow', {
  create: (props, app) => new FlowNode(props, app),
  semanticNames: ['nodes', 'edges'],
  // "my applyProps diffs these and invalidates what actually moved"
  selfDamagedProps: ['nodes', 'edges'],
});
```

Three things about that contract, in the order they bite:

**Everything you do not recognise goes to `super`.** An element that answers
"nothing changed" about a prop it does not actually claim shows a stale
pixel, and nothing comes back to fix it — so the override answers for the
props it knows and hands the rest to core, which is conservative on purpose.
That is what keeps an `aria-label`, a `title`, or a prop the element grows
next year correct without anybody remembering this method exists.

**A style change is not yours to excuse.** `style` is compared by value by
the caller and never reaches either seam: what it moves is the background,
the border and the clip that `Node.paint` draws for you.

**Claim before you skip.** `selfDamagedProps` only says the commit will not
claim — it does not claim anything on your behalf. An element that names a
prop and then forgets to invalidate for it renders nothing at all on that
change, which at least fails loudly the first time you drag something.

And one place `paintDamage()` does not belong: inside `paintCached`
([below](../docs/extending.md#drawing-once-instead-of-every-frame)). That draws into a surface in
its own coordinates, and a copy culled against the window's damage is stored
half-drawn under a key that says it is whole — so every later frame that hits
the key gets the hole.

The same scene has a second one-node problem, in the accessible tree rather
than in the frame: see [A scene a screen reader can
walk](../docs/extending.md#a-scene-a-screen-reader-can-walk).

Worth it because the numbers are not small. `@react-x11/components`' `<Flow>`
on a 300-node / 745-edge scene at 1100×700 costs ~2470 X requests and ~150 ms
per drag step redrawing the pane, and ~400 requests / ~30 ms with the two
seams — the same frame, with the parts of it nobody can see left unsent.
`REACT_X11_DEBUG_PAINT=1` is how to watch it: the pass's rect is stroked in
the frame's colour, so a scene that is still repainting whole strobes across
the pane instead of outlining what moved ([debugging.md](../docs/debugging.md)).

#### Panning a scene you drew

_Issue #303._ The two seams above scope a frame to the part of the scene
that changed. A **pan** has no such part: it translates every pixel, so the
honest claim is the whole pane and the honest frame is a full repaint — of a
picture that is already on screen, one shift away from being right.

That is the shape `<box overflow="scroll">` has been treating as a special
case since issue #138: blit the band that survives inside ntk's backing
store, repaint only the strip the shift exposed. `scrollContents` is that
same dance, for a viewport of your own:

```js
class FlowNode extends Node {
  onDragPan(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    // "the pixels in here moved by (dx, dy); the rest of it is new"
    this.scrollContents(this.contentBox(), dx, dy);
  }

  paintContent(ctx) {
    // …and this is the exposed strip, not the pane. Nothing here changes.
    const damage = this.paintDamage();
    for (const item of this.scene()) {
      if (damage && !overlaps(item.bounds, damage, 1)) continue;
      this.draw(ctx, item);
    }
  }
}
```

The call claims `rect` — the conservative answer, and the one that stands if
anything declines — and arms the frame to blit instead. At frame time core
asks ntk to move the surviving band and **narrows that claim to the band the
shift exposed**, which is what `paintDamage()` then hands your paint. So the
element draws the strip and nothing else without ever asking whether the
blit happened, and every gate below falls back to repainting `rect`, which is
the behaviour without the call at all.

Four things worth knowing, in the order they bite:

**`dx`/`dy` are how far the pixels moved.** The sense `Surface.copyWithin`
and ntk's `scrollRegion` use, not a scroll offset's: panning the scene right
by ten is `dx: 10`, and the exposed band is down the left edge. Both whole
device pixels — a fractional shift is not a copy — and `rect` in window
coordinates (the same space as `abs` and `contentBox()`: device pixels) and
inside your node.

**You promise one thing: that inside `rect` the frame really is that
translation.** Everything else is core's to check, and each of them declines
rather than misrenders — a claim from anywhere else reaching into the rect, a
sibling drawing over it, a child of your node laid out on top of it, your own
border ring or rounded corner, a layout pass that moved something, a region
too small or a shift too large to be worth it. Several pans in one frame
coalesce into one blit by their net shift; two different regions of one node
do not, and fall back.

**Diagonal is fine here**, unlike the scroll containers' one-axis-at-a-time
rule. That rule exists because the L of exposed strips overlaps the scrollbar
rects and the merges balloon back towards the whole viewport; with no bars
the L is two disjoint rects and stays two. A drag-pan is diagonal almost
every frame, so this is the case rather than the corner.

**Every gate above is about `rect`, not about your node.** A pane usually
has furniture — a minimap, zoom controls, a HUD strip — that has to repaint
on a pan frame and whose pixels must _not_ ride the blit. A strip along one
edge can be carved out of the region you shift and claimed the ordinary way;
the claim lands beside the rect and the frame stays a blit:

```js
onDragPan(dx, dy) {
  this.panX += dx;
  this.panY += dy;
  const box = this.contentBox();
  const hud = { ...box, y: box.y + box.height - HUD, height: HUD };
  this.scrollContents({ ...box, height: box.height - HUD }, dx, dy);
  this.invalidate(false, hud, 'props'); // repainted, not shifted
}
```

A claim that _reaches into_ the rect — by so much as a pixel — still declines
the frame (issue #309). Overlay panels mounted as sibling nodes work the same
way, as long as they sit outside the rect: one drawing over it is dragged
along by the blit, so it declines instead.

**Furniture in a corner is pinned, not carved.** What shifts is one
rectangle, so carving a minimap out of the bottom-right corner takes the rows
beside it too, and zoom controls in the other bottom corner make that a band
the pane's full width — repainted on every pan frame, with every card, label
and edge in it (issue #682). Hand over the whole pane instead, and name the
furniture that stays put:

```js
onDragPan(dx, dy) {
  this.panX += dx;
  this.panY += dy;
  // rects inside the region, in its coordinates, that do not move
  this.scrollContents(this.contentBox(), dx, dy, null, [
    this.minimapRect(),
    this.controlsRect(),
  ]);
}
```

The copy drags a stale image of each piece along by (dx, dy), and core
repaints the pinned rect and that image: two small rects a piece, on every
pan frame, whether the furniture changed or not. So what the furniture shows
can follow the pan — a minimap's viewport box — without a claim of its own,
and a claim it makes anyway is yours as long as it lies inside a pinned rect.
A claim anywhere else in the region still declines the frame, and so does
furniture that is most of the pane: past three quarters of it repainted, the
blit is buying a shift and paying for the region anyway.

**A rounded box around your element is pinned the same way.** The arc of a
rounded corner does not translate, but it lives in the four radius-sized
squares at the corners and nowhere else, so core pins those squares itself:
the whole region shifts, and each square is repaired where it is and where
the copy dragged it — a few pixels a corner (issue #691). A graph pane
inside a rounded card is the common shape. Its own border ring and corners
are different: those are the element's paint, not its drawing, and they
decline the blit.

The rects a pan frame repaints — its strips, the furniture, the corners —
are merged down to a few passes, and merged together, so the small ones
join their neighbours before a large box can swallow them: a diagonal pan
of a rounded pane with furniture in both bottom corners repaints under a
fifth of it.

A node mounted over the region inside a pinned rect — a zoom button, a
legend — is furniture too: it does not decline the blit, and its pixels are
repaired with the rest. Its claims carry the pixel of slop every node's do,
so the rect to pin is the one it claims, `node.paintBounds()`, or its hover
declines the frame it lands in.

**Zoom is not a blit.** Scaling resamples; it is a full repaint and should
be. That is the right trade: a zoom is a gesture step, a pan is sixty of them
a second.

The protocol bench prices it at five diagonal pan steps over a 374-cell scene
— 627 requests / 308 composites / 0.06 Mpx, against 6550 / 3269 / 2.38 for
the same five steps under `REACT_X11_NO_SCROLL_BLIT=1`, which is exactly the
fallback every gate here takes. With a HUD strip claimed beside the region
they cost 1993 / 993 / 0.43 — the blit plus the strip. With furniture in two
bottom corners they cost 1622 / 790 / 0.30 pinned, where carving the band
between the corners costs 2736 / 1349 / 0.70, and 1892 / 920 / 0.31 in a
rounded pane.

If your element keeps its drawing in a `Surface` of its own rather than
drawing it live, the shift you want is
[`copyWithin`](../docs/extending.md#scrolling-the-pixels-not-just-the-offset) on that surface —
same idea, one layer in.

### An element that covers its box

A terminal, a media frame, a chart with a retained surface: an element that
composites a bitmap of its own over its whole content box, every paint,
leaves nothing of what was painted under it. Core does not know that. A
pass inside the element still fills the window's background, the
background of every ancestor and the element's own before `paintContent`
composites the bitmap over all three — composites the server ran for
nothing on X11, and on macOS full-area CoreGraphics passes that were a
fifth of a streaming terminal's frame.

A pass that lies inside the answer is painted without the fills that would
be under it — the window's background, this node's own and every
ancestor's. Whole pixels only, window coordinates like `abs`: a fractional
edge is antialiased and an antialiased pixel is not opaque, so core takes
the whole pixels inside what you answer. A clipping ancestor shrinks the
cover to what reaches the surface, a rounded one by its radius all round.
The promise is yours to keep — every pixel, alpha one, on every paint,
whatever the props — and an element that is translucent, or paints a
background only sometimes, answers `null`, the default. The answer is read
per pass, so it may follow `contentBox()`, and it costs nothing on a pass
it does not cover.

**The same promise lets a move be copied** (issue #681). A subtree whose
only change in a frame is where it is — a terminal dragged across a
desktop, a card of widgets dragged across a graph — is already on the
surface, one shift away. When something in it covers its box, nothing under
it shows through there, so core copies its pixels where they went
(`CopyArea` on X11, the backing's own copy on Cocoa and Windows) and paints
only what the copy cannot supply: the strip the move uncovered, the
corners a radius gives up, and whatever is drawn over it. What covers is
an element answering `opaqueRect()`, a box with a `backgroundColor`
nothing shows through, or either of those inside boxes that hold nothing
else — the wrappers a card is positioned and scaled by. A card with no background of its own is drawn over what is
under it, and is repainted where it was and where it went.

The frame's other claims are sorted by whose they are. One from an element
painted **under** the moved subtree is repainted around the copy but not
through it, since nothing of it shows there — a graph pane that claims the
box its card moved through, with the card's mounted body over it, pays for
the card's header and edges and not for the body. One from inside the
subtree, over it, or from a claim core cannot place is repainted in full,
and where the copy carried what it covered. When those repaint most of the
copy, or would take more damage rects than the window affords a frame —
on X11, four: a rounded card's corners and the strip it uncovered are
already five — the move is repainted where it was and where it went, as
it always was. `REACT_X11_NO_SCROLL_BLIT=1` turns the copy off with the
other blits ([debugging.md](../docs/debugging.md#react_x11_no_scroll_blit1)).

### An element that draws past its box

Device pixels, every side. It is read when core rebuilds its cached paint
bounds, which a claim of the node does, so answer a bound for anything the
element may draw rather than for what it drew last — the claim after a
change is what has to cover the frame before's ink.

### Drawing once instead of every frame

**The key is the entire correctness surface.** It must name every input
`paintCached` reads, and it should be derived from the same values
`applyProps` compares so the two cannot drift. A key that misses something
shows stale pixels, which is the hardest kind of bug to see — so develop with
`REACT_X11_PAINT_CACHE=verify`, which re-renders every hit and complains
loudly when the drawing changed while the key did not. Return `null` for
anything animated, hovered, focused or blinking.

Two footguns worth naming. `paintCached` draws in **surface-local**
coordinates: reaching for `this.abs.x` inside it is the first thing to check
when a cached element paints in the wrong place. And the cache is per X
connection and keyed only on your string, so make the key specific enough
that two different drawings cannot collide — prefix it with your element
name, as above.

### Parts of your drawing on layers of their own

An element that draws a scene has animations inside it — a document's CSS
animation on one element, a cursor's blink, an edge's dash, a tooltip's
fade — and each is a frame of JavaScript: restyle, claim, repaint. On macOS
the render server can run such an animation itself, with no frame at all, if
what moves is on a layer of its own. Layer promotion does that for a plain
`<box>` ([macos.md](../docs/macos.md#layer-promotion-the-animated-few-on-their-own-layers-above-the-surface-presenter));
an element whose content is its own `paint` answers **sprites**: the parts
of its drawing it would like lifted, each with what the layer shows and what
runs on it.

A part is its `key`, its `rect` (and a `reach`, if it draws past it, and a
`clip`, if you cut it to one, with a `clipRadius` where the clip's corners
are round), a `paint` that draws it **where it is in the
window, at opacity 1 and untransformed** — the layer carries both — and a
`version` whose change paints it again. Its `opacity` and its `transform`, CSS's `matrix(a, b, c,
d, e, f)` as an array with `e` and `f` in device pixels, about an `origin`
that defaults to the rect's centre, are what the layer shows at rest. A
part turned out of the plane hands over `matrix3d()`'s sixteen numbers
instead, column by column, its translation and the distance its perspective
divides by in device pixels: Core Animation draws the layer through the
whole matrix, perspective and all, on the GPU. The presenter lifts such a
part only where none of its corners is behind the viewer, at rest or in
any keyframe, since past that plane its picture has no bounds, and asks
about it where its corners are seen rather than where it was laid out. Its
`animations` are keyframes for one of those two properties each: `values`,
`keyTimes`, a `timings` curve per segment, a `duration`, a `repeat`
(`Infinity` loops), `autoreverse`, and `hold` to stay on the last value. A
CSS animation goes over as it plays: an opacity's keyframes with their
curves, and a transform **sampled** into matrices from the element's own
interpolation, which is what makes a full turn turn and a mixed function
list interpolate as CSS says — Core Animation's own interpolation would do
neither.

The rules the presenter decides by, every frame, are promotion's, asked of
the element at **everywhere the part can be** — its reach through every
transform it is animated through:

- **Nothing painted after the element reaches into what shows of it** — no
  later sibling, no ancestor's border, ring or scrollbar. What shows is
  what is inside its `clip` and inside every clipping ancestor with square
  corners: the layer goes in a box that masks it to them, so a carousel's
  slide under `overflow: hidden`, or a part scrolled half out of its pane,
  is cut there as the bitmap is. A rounded ancestor has to hold all of it,
  since one box cannot take its corners. A `clip` of your own may have
  round corners — a card with a radius, cutting what it holds — and the
  box takes them; an ancestor with square corners that cuts it again puts
  that box in a box of its own. A part none of which shows — scrolled out
  of its pane, or outside its own clip — stays on its layer, cut to show
  nothing, so that its animation runs where it would and none of yours is
  spent on it; past a budget of raster for such parts (32 MB a window), it
  is yours to draw.
- **Neither the element nor any ancestor fades**: their group on the bitmap
  would leave the layer out of it.
- **Your inside is yours.** Offer only a part that nothing you draw after it
  overlaps — but for another part you offer after it, since that one's layer
  stands above: list your parts in the order you paint them, and they stack
  in it. The presenter cannot see inside your `paint`, so a part it turns
  down is yours to draw, in the bitmap under every layer, and every part
  listed before it that it overlaps is turned down with it, in that frame;
  one it does not reach keeps its layer.

A part can be inside another of yours — a spinner in a card that fades —
by naming it as its `parent`, earlier in the list. Its layer goes in the
parent's layer, so it fades, turns and is cut with it, and it is asked
about nothing more than staying inside the parent's raster everywhere it
can be: the parent was asked about all of that. Its `rect`, `origin` and
`clip` are where it is in the window with its parent untransformed. The
parent's `paint` is handed the keys of the parts lifted inside it, and
leaves them out; the presenter paints it again whenever they change, in
the frame they do. A part whose parent is not lifted, or that reaches out
of it, is yours to draw — in the parent's raster, where the parent is
lifted.

A lifted part is a hole in your drawing from the frame `spritesLifted` says
so, and a part the set no longer holds is yours to draw again in that same
frame — the bitmap under it is claimed as it comes back. Declining is always
safe, and it is what happens everywhere but on macOS: X11, Wayland, the
layer presenter and a scene that refuses never ask, and your `paint` draws
everything as it always did, so the same element runs on every backend and
the animation runs on your own clock there.

#### A part that shows a source

The layer is exactly `rect` — the picture scaled into it — so put its edges
on whole pixels, or the hole you leave and the layer that fills it meet with
a seam. Everything else is a part's: the rules above, a `clip` if you cut it,
`spritesChanged()` when the part comes or goes. A presenter that cannot show
the source — any bridge without video surfaces, and every backend but macOS —
declines the part, and drawing the newest frame yourself is the same code
that runs in every frame something is painted over it. `<video>` is built
exactly this way (src/nodes/video.js).

Three things to know about ids and time. An animation is attached **once per
`id`**: one that changed is a new id, and one the render server finished is
not started again while you still list it. Its `delay` counts from the frame
that asks, so it is a fresh number every frame and read only on the first.
And a part is painted once unless its `version` changes — a move by whole
pixels moves the layer, but a move to another fraction of a pixel, or a new
size, paints it again.

Sprites need `@windowkit/appkit` 0.19 or later, which takes a transform as
a matrix or a matrix3d and a negative delay as one begun in the past: on an
older bridge nothing is asked, and the element draws everything. A bridge
that lists `matrix` and not `matrix3d` among its `transformForms()` lifts
the parts in the plane and leaves those out of it to their elements.

#### A part that is its shadows

A part may be **shadows** alone: CSS's outer `box-shadow`, which the
render server draws on the GPU where your `paint` would blur a glow a pixel
at a time. It has `shadows` in place of `paint`, its `rect` is the box that
casts them — none of them falls inside it, with `rectRadius` corners, as an
outer shadow is never drawn under its box — and each shadow is the shape it
is the shadow of, with its corners' `radius`, an offset `x` and `y`, CSS's
`blur` radius and a `color`, `[r, g, b, a]` in straight sRGB from 0 to 1.
The first is on top, as CSS lists them; a spread is yours to fold into
the shape.

Their `animations` are of `'shadowBlur'`, `'shadowColor'` and
`'shadowOffset'`, with `shadow` saying which: blurs and `[x, y]` offsets in
device pixels, colours as above, and an `opacity` and a `transform` on the
whole part as any part has. A transition between two lists of shadows is
yours to pad, as CSS pads it, and to sample where Core Animation's straight
interpolation of a colour would not be CSS's. Where they can reach is
worked out from the shadows through every keyframe, and that is everywhere
the part is asked about: a part that is its shadows stands over what is
under its glow, so nothing painted after your element may reach into it.
Leave the box itself in your bitmap and draw everything but its shadows
there while the part is lifted. A part that is its shadows is never inside
another's.

### Elements that own a real X window

`drawn: false` is for a node backed by its own child X window rather than
painted into its parent — a GL surface, an XEMBED socket, a video overlay.
There are two worked examples, and they are worth reading in this order.

`GlAreaNode` (`src/glnodes.js`) is the simple one: it holds no paint code,
and the owning `WindowNode` realizes it in the commit phase
(`_realizeChildWindows`) so the child window names its real parent from the
start. The ordering constraint — no X calls in the render phase, because the
render phase is discardable — is the part that is easy to get wrong.

Input is the other thing a child window decides without being asked. X
delivers a device event to the first window up the hierarchy that selected
it, so a window that selects nothing hands the pointer over it to the window
the tree lives in — which is how a `<glarea>`'s presses reach the tree — and
one that selects `ButtonPress` keeps every press for itself. Select only
what the element needs from the server, and remember that ntk selects
whatever a window is listened to for. The panes a `<glarea>`'s children are
drawn on (`src/gloverlay.js`) select nothing for the same reason. The owning
window's hit test knows about `<glarea>` surfaces and their children and
asks them before the tree (`GlAreaNode.hitSurface`); it does not know about
a registered element's window, so a point over one lands on whatever the
tree has behind it.

`ForeignNode` (`src/foreignnodes.js`) is the same shape with the stakes
raised, and it is the one to read if your element touches a resource you did
not create. Three things it has to do that a GL surface does not:

- **Nothing in the render phase, for a sharper reason.** A `CreateWindow`
  from a discarded render leaks a server resource; a `ReparentWindow` from
  one has moved another application's window for real.
- **Teardown is synchronous.** `WindowNode.destroySubtree` destroys its own
  X window in the same turn your node's does, and `DestroyWindow` takes every
  inferior with it — so a release that waits for a round trip releases a
  window that no longer exists. Compute what you would have asked for; the
  requests are ordered on the connection, which is what makes "hand it back,
  _then_ destroy the container" a guarantee.
- **Give it back, do not destroy it.** The element's own test file asserts
  that first, because it is the failure this shape is most able to cause.

## A layout algorithm of your own

**Options are declared, and typed.** `options` and `childOptions` map each
name to `{ type, default }`: `'length'`, `'number'`, `'integer'`,
`'boolean'`, `'string'`, `'any'`, or an array of the values it may take. A
`length` is written in logical pixels in the style and arrives in device
pixels, so an algorithm never multiplies by the scale. A value of the wrong
type, or an option you did not declare, is reported naming it, and takes
the default. What the box's own style already says — `gap`,
`justifyContent`, `alignItems` — is `info.style`: read it rather than
declaring options that mean the same thing. `info.scale` is the box's device
pixels per logical pixel, for a length the schema cannot see: one inside a
string, like a grid's track list. `info.report(message, consequence)` says
that something in a style is wrong but can be laid out around — a grid area
nobody named — once, the way a bad style value is said; a throw is for what
cannot be laid out at all.

## A position of your own

**What core does.** It re-derives where layout put the node on every pass
(nothing may remember an offset: the scroll fast path moves a node with its
pane, offset and all), claims where it was and where it went as damage —
into the scroll blit's ledger, so a pane of placed nodes keeps the blit —
lifts it over its siblings of the same `zIndex` for paint and for hit
testing, and when `place` throws, reports it once and leaves the node where
layout put it until its style names another position. `position: 'sticky'`
is written against exactly this context (`placeSticky` in `src/layouts.js`).

## The subpath exports

**Reach ntk through `react-x11/ntk`, not a second dependency.** Two copies
of ntk in one process means two font caches and two glyph atlases, and a
node built against one cannot be painted by the other — a failure that
looks like a drawing bug rather than a dependency bug. It is also where a
drawing-adjacent name gets its backend-neutral answer: `Surface` from here
is a pixmap on X11, a CG bitmap on the Cocoa backend, a GL render target on
Wayland and a Direct2D bitmap on win32, where `Surface` from `ntk` is the
pixmap only. And it is where an element that draws images of its own
decodes them: `decodeImageBytes` is the ladder `<image>` reads
bytes with — WebP everywhere, and under Bun every format Bun reads, off the
JavaScript thread — where ntk's `decodeImage` is PNG and JPEG, synchronously
([formats](../docs/elements.md#formats-and-what-decodes-them)).

**An element does not need the layout engine, and that is deliberate.**
`measureContent` is handed its constraints in words (`'exactly'`,
`'at-most'`, `'unconstrained'`) rather than yoga's integers, so an element
never links against it and yoga's ABI never becomes part of this seam. If you
are writing an element and reaching for `react-x11/yoga`, the answer is
almost certainly `measureContent`.

`react-x11/yoga` is for the case that is genuinely different. A layout that
arranges a box's children is `registerLayout`
([above](../docs/extending.md#a-layout-algorithm-of-your-own)) and never needs it; what does is
an element laying out content it draws itself that wants to delegate part
of that to flexbox. `@react-x11/components`'s `<Html>` is the worked example
— its `display: flex` builds a small yoga tree, asks it, and reads the
answer back rather than re-deriving flexbox, which is long, subtle, and
silently wrong when it is wrong.

Such a package must use **this** engine rather than its own `yoga-layout`
dependency, for the same reason it must reach ntk through `react-x11/ntk`:
two instances are two WebAssembly modules, and a node created by one cannot
be inserted into a tree owned by the other. That failure surfaces as a crash
inside the engine, naming nothing you wrote.

The enum constants are readable from the first tick; `Node` and `Config`
throw until the assembly is loaded, which `createRoot()` awaits before it
builds anything (docs/packaging.md explains why it is loaded rather than
imported).

## Typing

`test/types/extend.tsx` in this repo compiles exactly that, so the story
stays true as the declarations move.

The drawing side is declared too. `Context2D` from `react-x11/node` is the
canvas-shaped subset the backends implement — ntk's context over
XRender, and the one `src/backend/context2d.js` wraps over CoreGraphics on
Cocoa and Direct2D on win32 — so `paintContent(ctx: Context2D)`
type-checks every call an element makes, and a member not every backend
has is optional there (`globalCompositeOperation`, which a native context
takes only for the modes its bridge draws — assign it and read it back) or
absent. `paintCachePlan`, `paintCached`, `opaqueRect` and the rest of the
contract above are on the class, with `PaintCachePlan` for the plan.
