# Styling

Style lives in one place: the `style` prop. A style property passed flat is
an error in development that names the fix, rather than the silent no-op an
unrecognised prop used to be.

## The rule

One namespace per kind of thing, and no name in both:

- **`style`** — everything CSS has a concept for: layout, paint, text,
  `cursor`, `overflow`, `zIndex`, `pointerEvents`.
- **props** — everything else: `title`, window geometry and size hints,
  `resizable`, `wmClass`, `windowType`, `grab`, `value`, `src`, `focusable`,
  `tabIndex`, `disabled`, handlers. The 3D elements keep flat property props
  (`position`, `material`) — those are object properties, not CSS.

`style` takes an object or a nested array, flattened left-to-right with
falsy entries skipped. That is what replaces the **selector** cascade:
precedence is written at the call site instead of resolved by specificity.

```jsx
<box style={[s.card, isWide && s.wide, { backgroundColor: theme.panel }]} />
```

Inheritance is a different thing and it does happen — see
[Inheritance](#inheritance-the-ink-the-face-and-the-size) below. The two are
easy to conflate because CSS ships them together: what is gone here is
_matching a rule against a tree_; what remains is a handful of properties
that travel down it, which is the part that makes a theme, a caption block
or a dimmed row expressible at all.

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

The thing inline CSS cannot do, and the reason people keep a stylesheet:

```jsx
<box
  style={{
    backgroundColor: theme.surface,
    ':hover': { backgroundColor: theme.surfaceHover },
    ':focus': { borderColor: theme.borderFocus },
  }}
/>
```

`:hover`, `:focus-within`, `:focus`, `:focus-visible`, `:active`,
`:disabled`, `:drag-over`, `:dragging`.
These are **node states, not selectors** — each is something the node itself
already knows, so resolving them needs no specificity and no matching. The
event manager already tracks the hover path, the press chain and the focused
node; a state change recomputes one node's style and repaints. **No React
render.**

Precedence is fixed and low-to-high: `:hover` → `:focus-within` → `:focus` →
`:focus-visible` → `:active` → `:disabled` → `:drag-over` → `:dragging`,
merged per property, so a disabled control never looks hovered, a node that
is itself focused can say something narrower than one that merely contains
focus, and a drag in progress outranks all of the pointer and focus states.
Because the hover _path_ is the ancestor chain, hovering a child lights up an
ancestor's `:hover` block, exactly like CSS.

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
[components.md](components.md#the-press-state).

```jsx
<box
  focusable
  style={{
    backgroundColor: theme.background,
    ':hover': { backgroundColor: theme.surfaceHover },
    ':active': { backgroundColor: theme.surfaceActive },
  }}
/>
```

A `transition` on the same property is welcome — what matters is that the
change _starts_ on the press frame, not that it finishes there.

The keyboard has no press state: Space and Enter act on the down, so the
activation is immediate, but nothing draws held-ness. X reports auto-repeat
as release/press pairs and neither ntk nor node-x11 implements XKB's
`DetectableAutoRepeat`, so a held key cannot be told from fast tapping.

`:focus-visible` is focus that came from the keyboard — Tab, an arrow inside
a widget, `autoFocus`, `node.focus()`, a modal handing focus back as it
closes. A **press** sets `:focus` and not `:focus-visible`, for the reason
CSS grew the distinction: the user knows where they clicked, and a ring on
every click is noise, where a ring on Tab is the only cue a keyboard user
has. Put focus rings in `:focus-visible` and colour changes that are welcome
either way in `:focus`.

`:focus-within` is focus on this node **or inside it** — CSS's, and the
answer to "the row should light up while the field in it is being typed
into", which is the one thing a node's own states cannot say. It is diffed
over the focused node's ancestor chain, the same walk `:hover` uses, and a
`<popup>` counts as inside the node it hangs off in the JSX tree, so a
`Select` with its menu open still reads as focused.

```jsx
<box
  style={{
    borderColor: theme.border,
    ':focus-within': { borderColor: theme.borderFocus },
  }}
>
  <textinput value={value} onChange={setValue} />
</box>
```

The last two belong to drag and drop. `:drag-over` follows the pointer
during a drag on exactly the same ancestor-path rule as `:hover` — and,
like `:hover`, it says where the pointer is, not whether the node would
accept the drop; `useDropTarget`'s `isAccepted` is the one that answers
that. `:dragging` is set on the source node for the duration of a drag.
See [drag-and-drop.md](drag-and-drop.md).

**State blocks may only set paint properties** (`backgroundColor`,
`borderColor` and the per-side `borderTopColor`/…, `borderRadius`, `zIndex`,
`outlineWidth`, `outlineColor`,
`outlineOffset`, `color`) — enforced at declaration
time by `createStyles`. A `:hover` that could set `padding` would reflow the
tree on pointer move: jitter, and the end of the "hover is a repaint" property
that makes this worth having. Anything that changes layout or what renders
stays in React state.

### The focus ring

**Every focusable node draws one already**, on `:focus-visible`, with no
styling at all — a bare `<box focusable>` included. It is not something an
application opts into, because a keyboard user cannot opt into needing it.

`outlineWidth`, `outlineColor` and `outlineOffset` override it, and they are
paint properties like any other: animatable, legal in a state block, and
painted **outside the border box** so switching one on cannot move the thing
it surrounds. That is the whole reason CSS has `outline` as well as `border`,
and the reason these are not in the layout vocabulary.

```jsx
<box focusable />                                  {/* ring, for free */}
<box focusable style={{ outlineWidth: 0 }} />      {/* opted out */}
<box
  focusable
  style={{ ':focus-visible': { outlineWidth: 3, outlineColor: '#e17055' } }}
/>
```

A theme sets `focusRing`, `focusRingWidth` and `focusRingOffset` to restyle
every ring under it at once — the renderer reads them from the nearest
`theme` prop, so `<ThemeProvider>` covers the widgets and anything an
application writes itself.

## Direction, and the logical edges

```jsx
<box style={{ direction: 'rtl' }}>
  <box style={{ flexDirection: 'row', paddingStart: 12, gap: 8 }}>…</box>
</box>
```

`direction` is CSS's, `'ltr' | 'rtl' | 'inherit'`, and it inherits: setting
it mirrors that subtree and nothing above it. Rows run the other way, `flex-start`
is the right-hand end, and every logical edge below swaps sides with it.

**The default comes from the locale.** An app started under
`LANG=ar_EG.UTF-8` is mirrored with no configuration, because that is what
GTK and Qt both do and because the alternative is an Arabic desktop where
one application's panels are on the wrong side. Every locale that is not
written right to left answers `'ltr'`, so an app that never thinks about
this pays nothing. The palette carries it — `theme.direction` — so an app
with a language menu switches the whole UI with the `<ThemeProvider>` swap
it was already doing for colours:

```jsx
<ThemeProvider value={{ direction: settings.rtl ? 'rtl' : 'ltr' }}>
```

Prefer the provider over a bare `direction` style when the region contains
**widgets**. Yoga mirrors boxes on its own, so most of the widget set needs
nothing — a `<Checkbox>` is a row with a gap — but the decisions yoga cannot
make (which way an arrow key steps, which way a chevron points, which side a
submenu opens on) are read from the palette through `useDirection()`. A
provider plants the matching style property in the tree as it goes, so both
routes always agree under one.

### The logical edges

| logical                          | physical in LTR                | in RTL  |
| -------------------------------- | ------------------------------ | ------- |
| `start` / `end`                  | `left` / `right`               | swapped |
| `marginStart` / `marginEnd`      | `marginLeft` / `marginRight`   | swapped |
| `paddingStart` / `paddingEnd`    | `paddingLeft` / `paddingRight` | swapped |
| `borderStartWidth` / `…EndWidth` | `borderLeftWidth` / `…Right…`  | swapped |
| `borderStartColor` / `…EndColor` | `borderLeftColor` / `…Right…`  | swapped |

**A logical edge wins over the physical one even in LTR**, the way CSS's
`padding-inline-start` wins over `padding-left`. Yoga's full order is
start/end, then the physical side, then `EDGE_HORIZONTAL`, then
`EDGE_ALL` — the opposite way round from what the vertical shorthands
suggest, which is why it is pinned in a test.

Write layout in the logical pair and it is the same layout in both
directions. Use the physical one when you mean the screen: a drop shadow, a
resize handle in a fixed corner.

### What does not mirror

- **`<canvas>`** — the drawing is the application's, and `ctx` keeps its
  top-left origin. An app that wants mirrored art reads `node.direction`
  from the ref it already has.
- **A `<window>`'s or `<popup>`'s explicit `x`/`y`** — screen coordinates.
- **Vertical anything.** `top`/`bottom`, a column's order, a vertical
  scrollbar's travel, Up/Down on every control.
- **The caret keys in a field.** Left and Right step through the _string_,
  not across the screen, and so do Home and End — the editing model is
  written in logical positions, and visual-order caret motion through bidi
  text is its own question.

What **does**, besides the box tree: a vertical scrollbar moves to the left;
horizontal scrolling counts from the right-hand edge, so `scrollX: 0` still
means "at the beginning"; `textAlign: 'start'`/`'end'` resolve against the
box's direction rather than against the first strong character; a popup
prefers the start side, so a submenu opens leftwards and still flips at the
screen edge; and the inside of a `<textinput>`/`<textarea>` — see below.

### Inside an editable field

A field is laid out at its box's direction, exactly as a `<text>` is, and the
direction does two separate things there:

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

`textAlign` works on a field too: `'start'` (the default) is the base
direction's start edge, and `'center'`/`'end'` do what they say while the
value fits. A value that overflows its box is pinned to the start edge
whatever the alignment says, because that is what it is scrolled from.

The text's _own_ direction is not consulted: a Latin value in an RTL field is
placed at the field's right edge, the way `<input dir="rtl">` places one, and
there is no `dir="auto"` equivalent yet.

## Per-side borders

```jsx
<box
  style={{ borderLeftWidth: 3, borderLeftColor: '$border', paddingLeft: 10 }}
>
  {children} {/* a blockquote bar, no extra node */}
</box>
```

A side width overrides the `borderWidth` shorthand exactly the way
`paddingLeft` overrides `padding`, and a side colour
(`borderTopColor`/`Right`/`Bottom`/`Left`) falls back to `borderColor`.
`borderStartWidth`/`borderStartColor` and their `End` counterparts are the
[logical](#the-logical-edges) pair, and they win over the physical side. The
widths are layout — yoga sees each edge, so the bar above insets content on
the left only — and the colours are paint, legal in a state block like
`borderColor` itself.

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

```jsx
<box
  style={{
    padding: 16,
    borderRadius: 10,
    backgroundImage: 'linear-gradient(135deg, $accent, $accentActive)',
    boxShadow: '0 2px 8px rgba(0, 0, 0, .4)',
    ':hover': { boxShadow: '0 6px 20px rgba(0, 0, 0, .5)' },
  }}
>
  <text style={{ color: '$accentText' }}>Header</text>
</box>
```

Both are **paint** properties: legal in a state block, and outside layout
entirely — a gradient fills the box the layout already decided on, and a
shadow is drawn beyond it and moves nothing. Both are written in CSS's
spelling, because both are values people already know by heart, and a
`$token` resolves **inside** them as well as as a whole value, which is what
keeps a themed decoration in a hoisted style.

### `backgroundImage`

`linear-gradient(<direction>?, <stop>, <stop>, …)` or `'none'`, resolved
against the node's own box so it works wherever the node lands.

- The direction is an angle in degrees clockwise from "up" (`135deg`), a side
  (`to right`), or a corner (`to bottom right`). Left out, it is `to bottom`.
- A stop is a colour, optionally followed by a `%` or a pixel position.
  Positions left out are spread evenly; one that goes backwards is pulled up
  to the one before it, so two stops at the same offset are a hard break.
- It paints **over** `backgroundColor`, which is CSS's order — a translucent
  gradient tints the colour underneath it rather than replacing it.

Only linear gradients exist. A radial or conic one is a `<canvas onDraw>`
away (ntk's context has `createRadialGradient` and `createConicalGradient`),
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
own `color`. A blurred shadow is a real gaussian — RENDER's convolution over
a coverage surface — cached by size, radius and blur, so a list of identical
cards renders one and composites it many times.

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

## Measuring text to its letters

```jsx
<text style={{ fontSize: 24, textBoxTrim: 'cap-alphabetic', padding: 12 }}>
  HEX
</text>
```

`textBoxTrim` is CSS's `text-box-trim: trim-both` with `text-box-edge: cap
alphabetic`: the `<text>`'s box becomes the capitals down to the last
baseline, so padding around a label is measured from the letters and
centring centres what you can see. Default `'none'`.

The problem it solves is that **a line box is not the text**. It is the
font's ascent plus its descent plus its line gap, and the space over a
capital differs from the space under a baseline by `(ascent - capHeight) -
descent` — a property of the typeface, so a label is only ever optically
centred by luck. With the KaTeX face the tests use, a 24px label in a 12px
padded box sits 17px below the top and 18px above the bottom; trimmed, it is
12 and 12.

**`lineHeight` is not an alternative.** It is a multiplier over the natural
line box and the leading still splits evenly above and below, so it moves
both edges by the same amount — it can change how much space there is, never
how it is balanced.

Two things worth knowing:

- It applies to `<text>`. `<textinput>` and `<textarea>` keep their full line
  box, because their caret and selection geometry is measured against it.
- Trimming removes real space, so a control gets shorter: size the padding
  for the result you want rather than to whatever the metrics happened to
  add.

**The built-in widgets set it on every label**, which is why `paddingY` in a
palette is bigger than a CSS padding for the same look — it is the space you
see, not the space plus whatever the ascent left over. Which way a face is
off changes with the face: at 14px, SF NS leaves 3.7px above the capitals
against 2.9px below the baseline, so an untrimmed label rides low, while
Helvetica leaves 0.7 against 3.2 and it rides high. A widget cannot correct
for that, because it does not know the face it will be drawn in.

A glyph drawn as text — a check mark, a submenu arrow, an icon — is centred
on its own middle rather than sitting on a baseline, so trimming its box
moves it off centre. Those keep the full line box, and so should yours.

`<textinput>` cannot trim — its caret and selection are measured against the
full line box — so it reaches the same place from the other side: its **box**
is the cap band, its baseline goes where the space above the capitals equals
the space under it, and the glyphs are allowed to hang out of the box the way
a trimmed label's descenders do. The drawing is clipped one step out, at the
padding box, so an ascender and a descender are both there and neither can
reach the border. The caret and the selection follow, being drawn from the
same origin.

That is what makes a field the same height as the controls beside it. Padding
it with the palette's `paddingY` gives exactly the height a `<Button>` and a
`<Select>` have, because all three are now the same sum — the capitals, plus
that padding twice, plus the border:

```jsx
<textinput
  style={{
    paddingTop: '$paddingY',
    paddingBottom: '$paddingY',
    paddingLeft: 10,
    paddingRight: 10,
    borderWidth: '$borderWidth',
  }}
/>
```

`<textarea>` keeps its full line boxes, box and clip both: it is line spacing
that a paragraph is made of, and nothing hangs out of a stack of them.

## Keeping text on one line

```jsx
<text style={{ textWrap: 'nowrap' }}>{row.modified}</text>
```

`textWrap: 'nowrap'` is CSS's, and it is what separates a cell from a
paragraph. A `<text>` measures height-for-width: hand it a narrow box and it
wraps to fit, which is right for prose and wrong for a row of a fixed height —
a date that wraps to two lines is not a taller row, it is a line and a half of
date with the rest sliced off, top and bottom, spilling over the rows either
side on the way. `'nowrap'` measures at unbounded width, so the overflow is
horizontal, which `overflow: 'hidden'` on the box around it already knows what
to do with. Default `'wrap'`.

`<Table>` sets it on every cell and header for that reason.

## Inheritance: the ink, the face and the size

Seven properties travel down the tree, and they are the ones CSS calls
inherited:

| property                |                                            |
| ----------------------- | ------------------------------------------ |
| `color`                 | the ink                                    |
| `fontFamily`            | the face                                   |
| `fontSize`              | the size                                   |
| `fontWeight`            |                                            |
| `fontStyle`             |                                            |
| `fontVariationSettings` | a variable font's remaining axes           |
| `textRendering`         | how glyph origins are rounded at draw time |

So a block of quiet type is a `<box>` and not a decision repeated at every
label inside it:

```jsx
<box style={{ color: theme.textMuted, fontSize: 12 }}>
  <text>Last modified</text>
  <text>{row.modified}</text>
  <Icon name="clock" />
</box>
```

A style property on the node itself still wins, the way a property always
wins over what a node inherits — and under the outermost element is the
palette, so text that names none of this is set in the theme's `text`,
`fontFamily` and `fontSize` ([theme tokens](#theme-tokens) below).

It reaches everything that draws with type, not just `<text>`: a
`<textinput>`, a `<canvas mono>` (which is what an `<Icon>` is), an `<svg>`
resolving `fill="currentColor"`, and any custom element
that asks `node.resolvedTextStyle()`
([extending.md](extending.md#text-of-your-own)). A nested `<text>` span is
the same mechanism seen from closer up.

**A `:hover` block that sets `color` therefore reaches the labels inside.**
That is how CSS behaves and it is why there is no "group hover" here to
learn: `:hover` marks the row, `color` is inherited, and the row's label and
its icon follow.

```jsx
<box style={{ color: theme.text, ':hover': { color: theme.accent } }}>
  <text>Open recent</text>
  <Icon name="chevronRight" />
</box>
```

Nothing about that costs a layout pass. A state block may only set paint
properties and `color` (see above), so the only inherited property a pointer
can ever move is the ink — which drops the memoised text layouts under it
and repaints, with no re-measuring and no reflow. A `fontSize` change
_does_ re-measure, and it can only come from a React commit, a size query or
a theme.

What does **not** inherit: `textAlign`, `lineHeight`, `textWrap` and
`textBoxTrim`. CSS inherits the first two; here they are read by the node
that owns the **box** the text flows in, and a box is not something a
descendant has. `<Icon>`'s `size` does not inherit either — a glyph is a
drawing rather than a letter, so it takes its default from the palette's
`fontSize` and stays put when a label around it shrinks.

## A font file of your own

An app that ships a face, or that shows one — a picker, a specimen, a
preferences page with a family name in it — asks for the file by path (or by
bytes) and gets back what to draw it with:

```jsx
import { loadFont } from 'react-x11';

// `app` is the ntk connection — the one `createRoot({ app })` took, or
// `useApp()`'s inside a tree
const { font, family } = loadFont(app, '/path/to/Inter.ttf');

<text style={{ fontFamily: family, fontSize: 20 }}>Handgloves</text>;
```

`family` comes **off the file** rather than out of the caller's head: it is
the font's own name, so an app that ships `Inter.ttf` goes on writing
`fontFamily: 'Inter'` in the styles it already has, and a registered face
beats fontconfig for that name — which is the point of shipping one. Several
faces of one family — regular, bold, italic — all keep the name and
`fontWeight` picks between them. Only a second file that would be
_unreachable_ under it, the same family at the same weight and slant, is
scoped: that one comes back as `Inter 2`. Draw with the name that comes back
and the question never arises.

`loadFont(app, path, { family: 'preview' })` names it yourself instead —
worth doing for a file the _user_ picked, to keep it out of the way of the
app's own type. `weight` and `style` override what the file claims about
itself, and `postscriptName` picks one face out of a `.ttc`.

From a component, `useFont` is the same thing with the connection already in
hand, and it returns null before anything is picked:

```jsx
function Specimen({ path }) {
  const picked = useFont(path); // path may be null
  return <text style={{ fontFamily: picked?.family }}>Handgloves</text>;
}
```

A file that will not parse throws, which an error boundary is the right home
for when the app ships the font and the wrong one when a user just chose it
in a dialog — reach for `loadFont` in that handler and catch there.

### Reading a font without installing it

`openFont(app, source)` reads the file and changes nothing else:

```js
const font = openFont(app, path);
font.metrics(30); // what the renderer lays out with
font.variationAxes; // { wght: { name, min, default, max } }
font.hasGlyph(0x20b8); // is the tenge sign in this face?
```

The difference from `loadFont` is worth knowing before a font browser picks
one over the other. Registering a face does not only make a `fontFamily`
resolve to it: every registered font is consulted, ahead of the system
fonts, for **any codepoint the current face is missing**. That is exactly
what an app shipping a symbol or icon face wants, and exactly what an app
that is merely _previewing_ files does not — it would quietly change which
face draws the bullets and the curly quotes in its own UI.

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

## `flattenStyle`

`flattenStyle(style)` collapses whatever the `style` prop accepts — an
object, an array, nested arrays, holes — into one plain object, which is what
the reconciler itself does before applying props. Two details are worth
knowing if you call it: a lone object is returned **as-is**, not copied, so
`===` still identifies a hoisted style; and a state block merges with one
already collected rather than replacing it, so
`[{ ':hover': { color } }, { ':hover': { backgroundColor } }]` keeps both.

## In components

Every component takes `style` and merges it after its own, so an override
wins by position instead of clobbering a computed value:
`style: [control.style, base, checked && on, style]`.

`useControl(disabled, onActivate, { styled: true })` stops holding hover,
focus and the press in React state: no enter/leave handlers, no re-render on
pointer move. `Switch` and `Button` are the worked examples. Without it the
hook returns `hover`/`focused`/`pressed` as React state, which is what a
control needs when the part that has to change is not on the press chain —
a `Checkbox`'s well is a sibling of the label the press lands on, and no
node-local state block can cross that.

A component's own props are never style. `ProgressBar` takes `color`,
`Dialog` takes `width`/`height` — a dialog is a real popup window and needs
its geometry up front — and `ContextMenu` takes `fontSize` because it
measures labels with it. `Select` and `Slider` used to take `width` purely
to put it in their own box; that is `style={{ width }}` now.

## Theme tokens

A style value of `'$name'` resolves against the nearest theme above the node
— `<ThemeProvider value={palette}>`, or a `theme` prop on any element. The
sigil is what keeps it unambiguous: `'red'` is a CSS colour, `'$red'` is a
token.

```jsx
const s = createStyles({
  card: { backgroundColor: '$panel', padding: '$gutter' },
  title: { color: '$text', fontSize: 20 },
});

<window theme={palette} style={{ backgroundColor: '$bg' }}>
  <box style={s.card}>…</box>
</window>;
```

That is the point of tokens: the style is **hoisted** — declared once,
outside render, with no access to React context — and still follows the
theme. Without them a palette has to be threaded to every element that
paints (`style={[s.card, { backgroundColor: theme.panel }]}`).

Tokens are not colour-only; `padding: '$gutter'` resolves a number just as
well.

Three of them are read with no `$` anywhere, because they are what text falls
back to rather than something a style asked for: **`text`, `fontFamily` and
`fontSize` are the ink, the face and the size of every `<text>` that names
none of its own** ([components.md](components.md#theming)). They are the floor
under [inheritance](#inheritance-the-ink-the-face-and-the-size) — what a node
resolves to when no element above it named one either — which is what makes
`<ThemeProvider value={{ fontFamily: 'Inter' }}>` a sentence an app says once.
A style property still wins over it, the way a style property always wins over
what a node inherits:

```jsx
<window theme={{ fontFamily: 'Inter', fontSize: 16 }}>
  <text>Inter at 16</text>
  <text style={{ fontFamily: '$monoFamily' }}>the palette's mono face, 16</text>
  <text style={{ fontSize: 24 }}>Inter at 24</text>
</window>
```

`monoFamily` has no such fallback — nothing is monospace unless it says so, and
that is what the `$` above is for. It is a token so that the code surfaces of
an app, which are written by components that never meet, can be set from one
place.

A `theme` prop anywhere scopes its subtree, and an inner one merges over the
outer, so a panel can restate a colour or two without repeating a palette.
Popups resolve through their place in the **tree**, not their window, so a
menu inherits the theme of the UI that opened it even though it is a
separate X window.

Note that a raw `theme` prop is exactly the object you wrote: it merges, but
nothing is computed from it. The widget palette's derived tokens — the
pressed `accentActive`/`surfaceActive`/`textMutedActive`/`dangerActive`, the
`…Text` ink on each fill, and `surface` following `background` — are filled in
by `<ThemeProvider>`, which plants the resolved palette in the tree for this
lookup to find. Hand-writing `theme={{ accentHover: … }}` on a box gets the
merge and not the derivation.

Changing the theme restyles the subtree in place. Nodes whose own props did
not change are still updated — which is why a theme change also drops the
memoised text layouts under it, or cached text would keep painting the old
colour.

An unknown token is an error naming what the theme does have, and a token
with **no** theme above it at all warns in dev — that one is otherwise
silent, since the whole style is stripped rather than one value failing.
Resolution is cached per (style object, theme object), so a hoisted style
under one theme keeps its identity across renders and the `===` fast path
still applies.

Resolution walks the node tree, not React context, so a palette has to reach
the tree to be seen. `<ThemeProvider>` puts it in both places — the context
widgets read with `useTheme()`, and a `theme` prop on a node — which is what
makes provider and token one mechanism rather than two
([components.md](components.md#theming)). Widgets plant their own merged
palette on their root node as well, so `$tokens` work inside a widget
subtree — and in a style you pass one — with no provider anywhere.

With no `theme` prop above it at all, a token resolves against **the
desktop's palette** — `backgroundColor: '$background'` in an app that never
wrote a `<ThemeProvider>` is dark on a dark desktop, which is how that app
blends in ([appearance.md](appearance.md)). A token no palette defines is an
error naming every token the one in force does have.

## Transitions

`transition` names how long a change takes. A number covers every animatable
property; an object picks them individually.

```jsx
<box
  style={{
    backgroundColor: theme.surface,
    transition: 120, // or { backgroundColor: 120, left: 200 }
    ':hover': { backgroundColor: theme.surfaceHover },
  }}
/>
```

Numbers lerp and colours lerp per channel through ntk's own CSS colour
parser, so anything the paint path accepts animates. A value with no
meaningful midpoint — an enum like `flexDirection`, a percentage, `auto` —
snaps instead, and `zIndex` is excluded on purpose: restacking every frame is
not an animation.

The easing is a fixed ease-out cubic. A transition starts from **what is on
screen**, not from the declared value, so interrupting one reverses from
where it got to rather than jumping to the end first.

The animation _is_ the repaint loop: the window keeps asking its frame clock
for frames while any transition is unfinished, and stops the frame the last
one lands. Nothing polls, and there is no per-widget
`requestAnimationFrame`.

Transitions may animate layout properties, unlike state blocks. That is not
an inconsistency: a pointer move must never reflow the tree, but an author
who writes `transition: { left: 200 }` has asked for animated layout and
pays a layout pass per frame for it. `Switch` is the worked example — the
thumb is absolutely positioned and slides on `left`, because
`justifyContent` would flip between the ends with nothing in between.

## Window size queries

`'@width >= 600'` and friends are the X11 analogue of `@media`: what a style
can usefully ask about here is the window it is laid out in, not the screen.

```jsx
const s = createStyles({
  bar: {
    flexDirection: 'column',
    gap: 4,
    '@width >= 600': { flexDirection: 'row', gap: 16 },
  },
});
```

`width` and `height`, with `>=`, `<=`, `>` or `<`. Blocks that match are
merged in declaration order, before state blocks — so a `:hover` inside the
wide layout still wins over the wide layout.

**A size query may set layout properties, unlike a state block.** That is
not an inconsistency: a pointer state must never reflow the tree, but a size
query is only ever re-evaluated inside a layout pass that a resize has
already required, so it costs nothing extra. Nodes that declare one are
registered with their window and re-resolved just before it lays out, and
only when the size actually changed.

A malformed query is an error rather than a key that silently never
matches.

## Capability queries

`'@supports transparency'` is to `@supports` what the size queries are to
`@media`: what a style can ask about the **server**, rather than about the
window it is in.

```jsx
const s = createStyles({
  menu: {
    backgroundColor: '#1c1c22', // works everywhere
    borderWidth: 1,
    borderColor: '#3a3a44',
    '@supports transparency': {
      backgroundColor: 'rgba(24, 24, 30, 0.86)',
      borderRadius: 14,
      borderWidth: 0,
    },
  },
});
```

Write the design that works everywhere as the base and the enhancement in
the block — the same way you would write a `@media` query for a wider
screen. That ordering is the point: get it the other way round and the
fallback is the _unusual_ case, which is the one nobody tests.

`transparency` is true only when **both** halves hold: the window was
created on a 32-bit visual (`<window transparent>`, and the display had one
to give), **and** a compositor is running to blend it. Either half missing
and a transparent corner is a _black_ corner — X shows the raw pixels — so
the honest answer is no, and the block does not apply.

It is answered **per window**, not per display. A component rendered inside
a `<popup transparent>` gets the translucent design; the same component
nested in a plain `<window>` gets the opaque one, without being told which
it is in.

The answer can change while the app runs — a compositor being started or
stopped is a checkbox on some desktops — and blocks are re-resolved when it
does. That is why `transparent` takes the 32-bit visual even when nothing is
compositing yet: a window's _visual_ is fixed at creation and cannot follow,
but what it paints can.

For decisions that are not styling — sizing a popup to hold a shadow margin,
say, which has to happen before the window exists — there is
[`useSupports('transparency')`](elements.md#transparent--rounded-corners-and-translucency),
which answers the same question about the display.

An unknown feature name is an error, like a malformed size query.

Running with `REACT_X11_NO_TRANSPARENCY=1` makes the answer false on any
display, so the base design — the one nobody tests, being the unusual case —
can be looked at without stopping the compositor for the whole session. See
[debugging.md](debugging.md#react_x11_no_transparency1).

## Decided

- **`':hover'`, not `_hover`.** The CSS spelling costs a pair of quotes and
  buys transfer from every other styling system.
- **Inherited properties, no relational selectors.** `color` and the font
  properties travel down the tree; nothing matches a rule against it. So
  there is no `:hover > child`, no sibling combinator and no Tailwind-style
  `group`. Each of those exists to move a value across the tree, and
  inheritance already does it in the one direction that is cheap: a parent's
  `:hover` reaches its children because `color` is inherited, and a child's
  hover reaches its parents because the hover path is the ancestor chain.
  What is left over — a **sibling** reacting to a sibling — stays in React,
  where `useControl` already returns `hover`/`focused`/`pressed` as state
  ([components.md](components.md#basic-controls)). `<Checkbox>` does exactly
  that, because its well is a sibling of the label the press lands on.

## Elements that are not styled

The 3D scene elements and the declarative SVG children carry their own
vocabularies — `position`, `color` and `width` mean a transform, a material
and a radius there — so the style channel does not apply to them, the same
way it does not apply to an `<input type>` in the DOM. They report
`stylable === false` and their props are passed through untouched.

## Next

`opacity` (needs offscreen composition — see NEXT_STEPS §3), a `boxShadow`
that a `<popup>` can cast (the window needs a translucent margin around
itself first — see [elements.md](elements.md) on `transparent` popups), and
per-node container queries if the window-level ones prove too coarse.
