# Styling

Style lives in one place: the `style` prop. A style property passed flat is
an error in development that names the fix.

## The rule

One namespace per kind of thing, and no name in both:

- **`style`** — everything CSS has a concept for: layout, paint, text,
  `cursor`, `overflow`, `zIndex`, `pointerEvents`, `container`.
- **props** — everything else: `title`, window geometry and size hints,
  `resizable`, `appId`, `windowType`, `grab`, `value`, `src`, `focusable`,
  `tabIndex`, `disabled`, handlers. The 3D elements of
  `@react-x11/components/three`, under a reconciler of their own, keep flat
  property props (`position`, `material`) — those are object properties, not
  CSS.

`style` takes an object or a nested array, flattened left-to-right with
falsy entries skipped. That replaces the **selector** cascade: precedence is
written at the call site instead of resolved by specificity.

```jsx
<box style={[s.card, isWide && s.wide, { backgroundColor: theme.panel }]} />
```

Nothing matches a rule against the tree, but inheritance does happen: a
handful of properties travel down it — see
[Inheritance](#inheritance-the-ink-the-face-and-the-size).

## Lengths and shorthands

A length is a distance in **logical pixels**: `12` and `'12px'` are the same
value, and the display scale turns either into device pixels (see
[scale.md](scale.md)). Where the layout takes them, `'50%'` and `'auto'`
mean what they mean in CSS; a border's or an outline's width also takes
`'thin'`, `'medium'` and `'thick'` (1, 3 and 5).

`null`, like `undefined`, is unset: `width: wide ? 240 : null` leaves the
width to the layout, and `''` is an unset colour. A value a property cannot
take (`width: 'hidden'`, `padding: 'auto'`, `flexDirection: 'sideways'`) or
a colour that does not parse (`'nonsense'`, `7`, `'#12'`) is an error at the
commit in development, naming the property — in a state block, a gradient
stop, a shadow, and a query block that does not match yet too. One that
gets past that — a `$token` resolving to it, or a production build — is
dropped where it is applied and reported, the way CSS drops a declaration it
cannot parse: the rest of the block still applies, and a dropped colour
paints no fill, stroke, gradient or shadow at all rather than half of one,
and the inherited ink for text.

```jsx
<box
  style={{
    padding: '8px 16px',
    margin: '0 auto',
    border: '1px solid $border',
    borderBottom: '2px solid $accent',
    background: 'linear-gradient($surface, $background) $surface',
    ':focus-visible': { outline: '2px solid $accent' },
  }}
/>
```

CSS's shorthands are read the way CSS reads them, and expand into the
longhands before anything else sees the style:

| shorthand                                         | sets                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `padding`, `margin`                               | the four sides, by CSS's one-to-four rule — `'8px 16px'`, `'0 auto'`, `'1 2 3'`           |
| `inset`                                           | `top`, `right`, `bottom`, `left`, the same way — `inset: 0`                               |
| `borderWidth`, `borderColor`                      | the four sides' widths or colours, the same way                                           |
| `paddingInline`, `marginInline`                   | `…Start` and `…End`: one value for both, or two                                           |
| `paddingBlock`, `marginBlock`                     | `…Top` and `…Bottom`, the same way                                                        |
| `gap`                                             | `rowGap` and `columnGap` — `'4px 8px'` is the row gap first, as in CSS                    |
| `border`                                          | `borderWidth`, `borderStyle`, `borderColor`: `'1px solid $border'`                        |
| `borderTop`/`Right`/`Bottom`/`Left`/`Start`/`End` | that side's width and colour: `borderBottom: '1px solid $border'`                         |
| `outline`                                         | `outlineWidth` and `outlineColor`; `'none'` is `outlineWidth: 0`                          |
| `background`                                      | `backgroundColor` and `backgroundImage` — a colour, a gradient, or both                   |
| `flex`                                            | `flexGrow`, `flexShrink`, `flexBasis` — `1`, `'auto'`, `'none'`, `'1 1 0'`, `'0 0 240px'` |

A `$token` may stand for any one value inside them — `padding: '$gutter 0'`,
`border: '$hairline solid $border'` — and resolves before the value is read.

**The more specific property wins, wherever it is written.** A longhand
beats its shorthand, a side beats all four sides, and a pair beats all four
too: `paddingTop` beside `padding: '8px 16px'` is the top padding whether it
comes before or after it in the style. CSS goes by order instead; a
flattened style array has no order left to go by.

A part a shorthand leaves out is left unset rather than reset to CSS's
initial value, since a longhand written beside it would win anyway. Three
things differ from CSS on purpose, and say so:

- **A line with no width is `medium`, 3px**, as in CSS; but a line with no
  style is `'solid'` rather than CSS's `none`, because `borderWidth` alone
  has always drawn here. `'none'` is a width of 0 — `border: 'none'`,
  `outline: 'none'`.
- **A line with no colour is [`currentColor`](#currentcolor)**, the node's
  ink, as in CSS — but the weakest thing in the style rather than whatever
  came last: a colour the style names for that side anywhere else is the one
  it takes, so `borderBottom: '1px solid'` beside `borderColor: '$border'`
  is a `$border` line wherever each is written.
- **A box has one `borderStyle`.** `border`'s style is the box's, and a
  side's only speaks when `border` named none; two shorthands naming
  different ones are an error unless `borderStyle` says which.

What is not here says what to write instead: `font` (the longhands),
`paddingHorizontal` (React Native's name — `paddingInline`), a per-corner
radius (`borderRadius` rounds all four), `border-radius` (style names are
camelCase), and a misspelt name gets the nearest real ones. `background` and
`outline` are paint all the way down, so a state block may set them;
`border` sets a width, which is layout, so it may not. A `transition` keyed
by a shorthand reaches the longhands it expands into —
`transition: { border: 150 }` fades the `borderColor` a `border` set.

### Relative units

Every length also takes CSS's relative units, resolved for the node it is
written on into the same logical pixels:

| unit                       | one of it is                                                                                                          | resolved again when             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `em`                       | the node's own font size — and on `fontSize` itself, the size it inherits, so `'1.5em'` is half again its parent's    | an ancestor's font size changes |
| `rem`                      | the palette's `fontSize`: the size every label that names none is set in, 14 by default                               | the theme changes               |
| `vw`, `vh`, `vmin`, `vmax` | a hundredth of the window the node is in — the `<window>` or `<popup>`, the size a `'@width >= 600'` block asks about | the window is resized           |

`rem` is read from the nearest palette, the way a `$token` is: a
`<ThemeProvider value={{ fontSize: 12 }}>` around a dense panel re-bases it,
and an app porting web numbers that assume 16 sets `fontSize: 16` on its
theme.

A **percentage on `fontSize`** is of the inherited size, as `em` is. A
**percentage `borderRadius`** is of the box's shorter side: a corner here is
a circle, so `'50%'` is a circle on a square and a pill on anything longer,
where CSS would draw each corner as an ellipse. Everywhere else a percentage
is the layout's, as before.

`calc()`, `min()`, `max()` and `clamp()` over any of these resolve to one
number where the style is — `'calc(1rem + 2px)'`, and fluid type as
`fontSize: 'clamp(14px, 1rem + 0.5vw, 20px)'`. A **percentage takes part
only alone** (`'calc(100% / 3)'`): yoga takes one unit per value, and what a
percentage is of is decided inside the layout, so `'calc(100% - 16px)'` is an
error that says so. Pad a `'100%'` box rather than subtracting from it, or
give the room to `flexGrow`.

`lineHeight` takes all of CSS's forms and comes to the multiple the text
engines take: `1.5`, `'150%'` and `'1.5em'` are that multiple, and a length
— `'24px'`, `'1.75rem'` — is divided by the node's own font size, which is
what makes a design's "16 on 24" the line it asks for.

A relative length is re-resolved only on the nodes that wrote one, when what
it reads changes; a style written in pixels costs nothing. Inside an
`'auto'`-sized window a viewport unit makes the content depend on the window
that depends on the content; like a size query, it settles where the two
agree, so size such a window or keep the viewport units out of it.

Some of CSS's units are **not read**, and a value in one is an error naming
the unit and why — `invalid width "2ex" in <box style>: ex is not read — it
needs the font's x-height`:

- `ex` and `ch`, which need font metrics nothing measures yet (`0.5em` is the
  usual stand-in);
- the container units, `cqw` and the rest: a container's size is known only
  after a layout pass, and a length in it would lay the tree out again on
  every frame the container moves — a percentage of the parent, or an
  `'@container'` block, says the same without that;
- the print units, `pt`, `mm`, `in`: lengths here are logical pixels, which
  the display scale turns into device ones.

So is a second value where a property takes one.

## What it fixes on `<window>`

`width`/`height` on a `<window>` are the real window's geometry — the user
can drag them — so they are props and never reach the layout, and the window
manager's size hints sit beside them, flat:

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

`style` is the root box, and its `backgroundColor` is also the window's own
background colour.

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
`:disabled`, `:drag-over`, `:dragging`. These are **node states, not
selectors**: each is something the node itself already knows, so there is no
specificity and no matching. A state change recomputes one node's style and
repaints — **no React render.**

Precedence is fixed and low-to-high: `:hover` → `:focus-within` → `:focus` →
`:focus-visible` → `:active` → `:disabled` → `:drag-over` → `:dragging`,
merged per property, so a disabled control never looks hovered, a node that
is itself focused can say something narrower than one that merely contains
focus, and a drag in progress outranks all of the pointer and focus states.
Because the hover _path_ is the ancestor chain, hovering a child lights up an
ancestor's `:hover` block, exactly like CSS.

`:active` is a press, and follows the same chain, so the control draws the
press whichever of its parts — a label, a thumb — is under the pointer. It
is **live for the whole gesture**: it drops when the pointer leaves the
chain and comes back when it returns, so it always means "releasing now
activates this". A control acts on the release, so give every interactive
thing an `:active` look: it is the only thing it can show while it is held
([components.md](components.md#the-press-state)).

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
activation is immediate, but nothing draws held-ness — on X11 a held key
cannot be told from fast tapping.

`:focus-visible` is focus that came from the keyboard — Tab, an arrow inside
a widget, `autoFocus`, `node.focus()`, a modal handing focus back as it
closes. A **press** sets `:focus` and not `:focus-visible`, as in CSS: the
user knows where they clicked, and a ring on every click is noise, where a
ring on Tab is the only cue a keyboard user has. Put focus rings in
`:focus-visible` and colour changes that are welcome either way in `:focus`.

The exception is CSS's too: a press on a **text control** — `<textinput>`,
`<textarea>`, or a custom element reporting editable text — does set
`:focus-visible`, because what the click told the user is where the caret
went, not that every keystroke from now on lands there.

`:focus-within` is focus on this node **or inside it** — CSS's, and the
answer to "the row should light up while the field in it is being typed
into". A `<popup>` counts as inside the node it hangs off in the JSX tree,
so a `Select` with its menu open still reads as focused.

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
`backgroundImage`, `borderColor` and the per-side `borderTopColor`/…,
`borderRadius`, `boxShadow`, `zIndex`, `outlineWidth`, `outlineColor`,
`outlineOffset`, `opacity`, `color`, and the `background` and `outline`
shorthands) — enforced at declaration time by `createStyles`, so that a
pointer move never reflows the tree. Anything that changes layout or what
renders stays in React state.

There are **no relational selectors** — no `:hover > child`, no sibling
combinator, no Tailwind-style `group`. A parent's `:hover` reaches its
children because `color` is
[inherited](#inheritance-the-ink-the-face-and-the-size), a child's hover
reaches its ancestors because the hover path is the ancestor chain, and a
sibling reacting to a sibling stays in React ([In components](#in-components)).

### The focus ring

**Every focusable node draws one already**, on `:focus-visible`, with no
styling at all — a bare `<box focusable>` included. It is not something an
application opts into, because a keyboard user cannot opt into needing it.
A text field gets it from a click as well as from Tab; everything else waits
for the keyboard (see `:focus-visible` above).

`outlineWidth`, `outlineColor` and `outlineOffset` override it, and they are
paint properties like any other: animatable, legal in a state block, and
painted **outside the border box** so switching one on cannot move the thing
it surrounds.

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
`LANG=ar_EG.UTF-8` is mirrored with no configuration, as GTK and Qt apps
are. Every locale that is not written right to left answers `'ltr'`, so an
app that never thinks about this pays nothing. The palette carries it —
`theme.direction` — so an app with a language menu switches the whole UI with
the `<ThemeProvider>` swap it was already doing for colours:

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
`padding-inline-start` wins over `padding-left`, and the physical side wins
over all four sides.

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
  written in logical positions.

What **does**, besides the box tree: a vertical scrollbar moves to the left;
horizontal scrolling counts from the right-hand edge, so `scrollX: 0` still
means "at the beginning"; `textAlign: 'start'`/`'end'` resolve against the
box's direction rather than against the first strong character; a popup
prefers the start side, so a submenu opens leftwards and still flips at the
screen edge; and the inside of a `<textinput>`/`<textarea>` — see below.

### Inside an editable field

A field is laid out at its box's direction, exactly as a `<text>` is, and the
direction does two separate things there:

- **It is the base level the value is shaped at.** A run of neutral
  characters — `"(1) 12:30"`, a filename, a lone bracket — resolves against
  it rather than against the first strong character, so an Arabic word typed
  into an English form in an **LTR** window does not reorder the line as
  though it were Arabic.
- **It is the edge the text is against.** The value, the placeholder and the
  caret start at the direction's start edge — the right-hand one under
  `direction: 'rtl'` — and an unscrolled field still shows the _beginning_ of
  its value, so a value too long for its box overflows towards the left.
  Clicking, the caret, the selection bands and the scroll mirror together.

`textAlign` works on a field too: `'start'` (the default) is the base
direction's start edge, and `'center'`/`'end'` do what they say while the
value fits. A value that overflows its box is pinned to the start edge
whatever the alignment says, because that is what it is scrolled from.

The text's _own_ direction is not consulted: a Latin value in an RTL field is
placed at the field's right edge, the way `<input dir="rtl">` places one, and
there is no `dir="auto"` equivalent.

## Per-side borders

```jsx
<box
  style={{ borderLeftWidth: 3, borderLeftColor: '$border', paddingLeft: 10 }}
>
  {children} {/* a blockquote bar, no extra node */}
</box>
```

A side width overrides `borderWidth` exactly the way `paddingLeft`
overrides `padding`, `borderBottom: '1px solid $border'` sets one side's
width and colour together, and a side colour
(`borderTopColor`/`Right`/`Bottom`/`Left`) falls back to `borderColor`.
`borderStartWidth`/`borderStartColor` and their `End` counterparts are the
[logical](#the-logical-edges) pair, and they win over the physical side. The
widths are layout — yoga sees each edge, so the bar above insets content on
the left only — and the colours are paint, legal in a state block like
`borderColor` itself.

Build a rule or an accent edge this way — a blockquote's bar, a table's row
separators (`borderBottomWidth: 1` on each row), a tab's underline — rather
than out of 1px `<box>`es, which pay a node per row in layout and paint.

Two limits:

- **`borderRadius` requires uniform borders** — same width and colour on
  all four sides. A non-uniform border paints square, ignores the radius,
  and says so once in development.
- Corners between two painted sides of different colours are square and
  deterministic: top and bottom span the box's full width, left and right
  run between them, where CSS mitres the corner diagonally.

## Gradients and shadows

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
spelling, and a `$token` resolves **inside** them as well as as a whole
value, which is what keeps a themed decoration in a hoisted style.

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
away (`createRadialGradient` draws on every backend but Windows', and
ntk's context has `createConicalGradient`).

On X11 a **square** gradient is as cheap as a colour, but a **rounded** one
is rasterized on the client and uploaded per fill — about 4 KB per box per
repaint, paid only where something changed. A list of rounded gradient rows
is the one shape to think twice about.

### `boxShadow`

`<x> <y> [blur] [spread] [colour]`, comma-separated for several, painted
first-on-top like CSS's. The colour may be left out, which means the node's
own `color` — [`currentColor`](#currentcolor), which may be written out
too. A blurred shadow is a real gaussian, computed once per distinct size,
radius and blur and cached, so a list of identical cards renders one and
composites it many times, and a repaint costs the same however wide the
blur. On macOS and Windows it is the 2D context's own `shadowBlur`.

What it does not do, and why:

- **`inset` throws.** An inner shadow is a different drawing, and painting an
  outer one where an inner was asked for is a bug with no visible cause. An
  inset border or a `<canvas>` says it today.
- **Ignored on `<window>` and `<popup>`** (with a warning in development). A
  shadow is painted outside the box, and a toplevel owns no pixels there —
  a real one needs the window to carry a translucent margin of its own.
  Put the shadow on a `<box>` inside the window; for a floating menu, the
  popup's own `borderRadius` plus a border is what reads as raised.
- **Neither transitions.** Both are several numbers and a colour in one
  string; they snap. A card that wants to rise on hover animates the
  `backgroundColor` or the border beside them.

A shadow inks pixels the node does not own, so it widens what the node
repaints — its offset, its spread and the blur's tail. Prefer one shadow on
the card to one on every row inside it.

## Opacity

`opacity` fades a node **and everything in it, as one**, the way CSS's does:

```jsx
<box style={{ opacity: enabled ? 1 : 0.5, transition: { opacity: 150 } }}>
  <svg viewBox="0 0 16 16">…</svg>
  <text>Reminders</text>
</box>
```

That is the difference from a colour's own alpha. `rgba(…, .5)` on a card's
background fades the background; it cannot fade the card, because every part
of it — the border, the icon, the caption — is drawn over the others, and at
half alpha each one shows what is under it: the card through the icon. With
`opacity` the subtree is drawn once, into an offscreen surface the size of
what it paints, and the surface is composited at the alpha.

It is a **paint** property: legal in a state block, and it transitions and
loops like the others — a halo that pulses, a section that fades in:

```jsx
animation: { opacity: { from: 1, to: 0.5, duration: 800, alternate: true } }
```

What it costs is that surface: one per faded node, the size of its paint
bounds inside the window, kept from one frame to the next while the node stays
faded and released when it is opaque again. `0` draws nothing and costs
nothing — and the node is still laid out and still hit, as in CSS. A value
outside 0 to 1 is clamped; one that is not a number throws in development.

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

**A line box is not the text**: the space over a capital differs from the
space under a baseline by `(ascent - capHeight) - descent`, a property of
the typeface, so an untrimmed label is only optically centred by luck.
**`lineHeight` is not an alternative**: it is a multiplier over the natural
line box, and the leading still splits evenly above and below, so it changes
how much space there is, never how it is balanced.

Two things worth knowing:

- It applies to `<text>`. `<textinput>` and `<textarea>` keep their full line
  box, because their caret and selection geometry is measured against it.
- Trimming removes real space, so a control gets shorter: size the padding
  for the result you want rather than to whatever the metrics happened to
  add.

**The built-in widgets set it on every label**, which is why `paddingY` in a
palette is bigger than a CSS padding for the same look — it is the space you
see, not the space plus whatever the ascent left over. Which way an untrimmed
label is off changes with the face (it rides low in SF NS and high in
Helvetica), and a widget does not know the face it will be drawn in.

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

## Keeping text on one line, and saying when it did not fit

```jsx
<text style={{ textWrap: 'nowrap' }}>{row.modified}</text>
```

`textWrap: 'nowrap'` is CSS's, and it is what separates a cell from a
paragraph. A `<text>` measures height-for-width: hand it a narrow box and it
wraps to fit, which is right for prose and wrong for a row of a fixed height —
a date that wraps is sliced off top and bottom and spills over the rows
either side. `'nowrap'` measures at unbounded width, so the overflow is
horizontal, which `overflow: 'hidden'` on the box around it clips. Default
`'wrap'`.

A date always fits, so clipping it would be a bug rather than a design. A
**name** does not: clipped, a truncated file name and a short one look
equally complete.

```jsx
<text style={{ textWrap: 'nowrap', textOverflow: 'ellipsis' }}>
  {file.name}
</text>
```

`textOverflow` is CSS's `text-overflow`: `'clip'` (the default) slices
mid-glyph, `'ellipsis'` ends the line in a `…`. It is the careful version, not
a substring —

- the `…` is set in the font of the run it cut into, so an elided line ending
  in a large or bold word gets a matching mark rather than one in the
  paragraph's base style, and it falls back to `...` where neither that font
  nor any fallback covers U+2026;
- the cut is at a grapheme boundary and the tail is **re-shaped**, because
  kerning and ligatures across the cut change widths;
- it cuts the **visually** last run rather than the logically last one, so a
  right-to-left line ends on its left.

`maxLines` is the other half — CSS's `-webkit-line-clamp`. A three-line blurb
that ends in a `…` is `{ maxLines: 3, textOverflow: 'ellipsis' }`; the lines
past the cap are dropped before the box is measured, so the height is the
kept lines' and not the whole paragraph's.

**`textOverflow: 'ellipsis'` on its own means one line.** Eliding happens off
a line count — the mark stands for the lines that were dropped — so an
ellipsis with no cap would have nothing to say and would silently do nothing.
One line is what a name, a path or a status line wants; `maxLines` is how to
ask for two or three.

### What `nowrap` and `ellipsis` do together

They change what the `<text>` reports to layout, which is worth knowing
before a row moves under you.

A clipping `nowrap` label is measured at unbounded width, so it tells its
container it needs the **whole string** — and CSS's automatic minimum size
turns that into a floor. It cannot be squeezed, so a long name pushes the
column next to it out of the row and the overflow is dealt with somewhere
above.

An eliding one is measured against the width on offer, so its floor is small
and it **gives way**: it takes the room that is left, shows `Applicati…`,
and the column beside it keeps its width. That is the behaviour a table
wants, and `<Table>` sets `nowrap` and `ellipsis` on every cell and header
for that reason.

What is truncated is a fact about the pixels and nothing else. A `<text>` that
was elided still reports the **whole** string as its accessible name, and the
caret and selection indices still index into the whole string.

## Inheritance: the ink, the face and the size

Ten properties travel down the tree, and they are the ones CSS calls
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
| `letterSpacing`         | the space after every character            |
| `fontVariantNumeric`    | which figures: tabular, oldstyle…          |
| `fontFeatureSettings`   | any other OpenType feature, by tag         |

So a block of quiet type is a `<box>` and not a decision repeated at every
label inside it:

```jsx
<box style={{ color: theme.textMuted, fontSize: 12 }}>
  <text>Last modified</text>
  <text>{row.modified}</text>
  <Icon name="moreVertical" />
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

Nothing about that costs a layout pass: a state block sets paint and `color`
only, so the only inherited property a pointer can move is the ink, which
repaints without re-measuring. A `fontSize` change _does_ re-measure, and it
can only come from a React commit, a size query or a theme.

What does **not** inherit: `textAlign`, `lineHeight`, `textWrap`,
`textOverflow`, `maxLines` and `textBoxTrim`. CSS inherits the first two;
here they are read by the node that owns the **box** the text flows in, and a
box is not something a descendant has. `<Icon>`'s `size` does not inherit either — a glyph is a
drawing rather than a letter, so it takes its default from the palette's
`fontSize` and stays put when a label around it shrinks.

**A value that is not one inherits.** `fontSize: '1.2ex'`, `fontStyle: 7`,
`fontWeight: 1200` or `lineHeight: 'tall'` is an error at the commit in
development, naming the property; where one gets past that — a `$token`, or
a production build — the text sets as though it had not been written, the way
CSS inherits past a declaration it cannot parse. Numbers may be numeric
strings (`fontSize: '20'`), and a size is a
[length](#lengths-and-shorthands) like any other: `fontSize: '20px'` is 20,
and `'1.5em'` or `'150%'` is half again the size inherited. A `lineHeight`
in a length — `'24px'` — is that multiple of the node's own size.

### `currentColor`

The ink as a colour: `currentColor` is the node's own `color`, or the one it
inherits. It goes wherever a colour does — `backgroundColor`, `borderColor`
and each side of it, `outlineColor`, a `boxShadow`'s colour, a gradient stop,
and inside `border`, `outline` and `background` — and a line those
shorthands give no colour is drawn in it, as in CSS:

```jsx
<box style={{ color: theme.textMuted, ':hover': { color: theme.accent } }}>
  <box style={{ borderBottom: '2px solid' }}>
    <text>Inbox</text>
  </box>
</box>
```

The label and its underline turn together, and nothing re-renders. It is
CSS's keyword in any case CSS takes it (`currentcolor` reads too), and on
`color` itself it is the colour inherited — CSS's `inherit`.

It stays the keyword in the node's style, which is CSS's computed value, and
becomes a colour where it is painted, so it follows the ink wherever the ink
moves: a `:hover` on a row above, a theme swap, a `color` transition frame by
frame. A node painting in it repaints when its ink moves, bounded to that
node. A `<popup>` written under the row inherits the ink like any other
child and repaints with it.

Two places it cannot simply follow:

- **A transition runs between the colours at the swap.** `borderColor`
  going from `'#d0d0d0'` to `'currentColor'` under a `transition` fades to
  the ink as it is when the style changes, and lands on the keyword, which
  follows the ink from then on. An ink moving under a `currentColor` that
  stayed is not a change of the property and does not transition: the border
  is the new ink at once. To fade it, transition `color`, and the border
  rides along.
- **A loop cannot end in it.** A loop's ends are fixed for as long as it
  runs, so `animation: { borderColor: { to: 'currentColor', … } }` is an
  error saying so. Loop `color` instead, and write the border in
  `currentColor`.

An element of your own that paints a colour from its style asks
`node.resolveColor(value)` for it
([extending.md](extending.md#text-of-your-own)).

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
called: `useFont` in a component that re-renders sixty times a second parses
nothing, and `loadFont` after `openFont` on the same path registers the face
already open.

`font` is ntk's `Font`, which has more on it than the four members above
([ntk's docs/fonts.md](https://github.com/sidorares/ntk/blob/master/docs/fonts.md)). If you need
anything else of ntk's — `Path2D`, `Image`, `Surface` — **import it from
`react-x11/ntk`, never from `ntk`**, and never declare `ntk` as a dependency
of your own. Two copies in one process are two font caches and two glyph
atlases, and a node built against one copy cannot be painted by the other.

## `createStyles`

A hoisted style object keeps its identity, so `applyProps` skips the whole
update with a `===` check. `createStyles` also validates keys, which a bare
object literal cannot: an unknown style property is an error at declaration
instead of a silent no-op.

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
measures labels with it. A `Select`'s or a `Slider`'s width is
`style={{ width }}`.

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

A **hoisted** style — declared once, outside render, with no access to React
context — still follows the theme, with no palette threaded to every element
that paints.

Tokens are not colour-only; `padding: '$gutter'` resolves a number just as
well. And they resolve wherever a style value is written: in a state block, in
an `animation` declaration, and in a size, container or capability query block
— `'@width >= 600': { padding: '$gutter' }` is the wide layout's gutter from
the same palette.

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

**The floor is read from the window, not from the nearest provider.** That is
the sentence to remember, because the failing shape looks right: a
`<ThemeProvider value={palette}>` _inside_ a `<window>` feeds `useTheme()` and
resolves every `$token` under it, so the styles that name a face get one — and
every `<text>` that names none still falls back to the **window's** palette,
which is the desktop's `sans-serif` unless the window itself was given a
theme. An app that ships its own fonts then draws its headings in the face it
shipped and its body copy in whatever the machine calls sans-serif, which is
both wrong and slow: resolving a generic family costs an `fc-match` per weight
on the first paint (~110ms each).

Three ways to say it. For a whole app the first says it once, for the widgets
and every window; the last is the one for a subtree:

```jsx
<ThemeProvider value={palette}>     {/* above the windows: they take it */}
  <App />
</ThemeProvider>

<window theme={palette}>            {/* the floor, for everything inside */}

<box style={{ fontFamily: '$fontFamily', color: '$text' }}>
  {/* or hand the face to a subtree by inheritance, which needs no window */}
</box>
```

`monoFamily` has no such fallback — nothing is monospace unless it says so,
with `fontFamily: '$monoFamily'`, so an app's code surfaces are set from one
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

Changing the theme restyles the subtree in place, nodes whose own props did
not change included.

An unknown token is **reported and dropped**: the message names the token,
the element, the component that wrote it, and every token the palette in
force does have; that one property goes missing, so the widget paints
visibly wrong rather than the app dying; and `process.exitCode` is set to 1,
so a test run, a CI job or a supervisor still counts the run as failed. It
is not a throw because resolution also happens where no error boundary can
catch one — above every boundary inside a `<window>`, or from the desktop's
light/dark switch with no React on the stack.

Set **`REACT_X11_STRICT_TOKENS=1`** to make it fatal — for a kiosk, or
a build that would rather stop than paint something wrong. Strict mode
throws from the offending node's own `commitMount`, so an error boundary at
any depth inside the window catches it and shows a fallback for that
subtree. Where React genuinely is not on the stack — the desktop appearance
switch — strict mode crashes, which is what it was asked for.

A token with **no** theme above it at all warns in dev — that one is
otherwise silent, since the whole style is stripped rather than one value
failing. Resolution is cached per (style object, theme object), so a hoisted
style under one theme keeps its identity across renders and the `===` fast
path still applies; a misspelling in a shared style is reported for every
node that wears it, not just the first.

Resolution walks the node tree, not React context, so a palette has to reach
the tree to be seen. `<ThemeProvider>` puts it in both places — the context
widgets read with `useTheme()`, and a `theme` prop on a node
([components.md](components.md#theming)). Widgets plant their own merged
palette on their root node as well, so `$tokens` work inside a widget
subtree — and in a style you pass one — with no provider anywhere.

With no `theme` prop above it at all, a token resolves against **the
desktop's palette** — `backgroundColor: '$background'` in an app that never
wrote a `<ThemeProvider>` is dark on a dark desktop
([appearance.md](appearance.md)).

## Sticky positioning

`position: 'sticky'` is CSS's: the box is laid out in flow, exactly where
`relative` would put it, and then held inside the nearest scroll pane by its
insets. `top: 0` keeps a section's header at the top of the pane while the
section scrolls under it — until the section's end arrives and carries the
header off, which is how the next section's header takes over.

```jsx
const s = createStyles({
  pane: { overflow: 'scroll', flexGrow: 1 },
  section: { flexShrink: 0 },
  header: { position: 'sticky', top: 0, backgroundColor: '$background' },
});

<box style={s.pane}>
  {groups.map((group) => (
    <box key={group.letter} style={s.section}>
      <text style={s.header}>{group.letter}</text>
      {group.people.map((person) => (
        <Row key={person.id} person={person} />
      ))}
    </box>
  ))}
</box>;
```

- **The insets are thresholds, not offsets.** `top: 12` says the box's top
  edge may come no nearer than 12px to the pane's top edge; it does not move
  a box that is already further down. `top`, `bottom`, `left`, `right`,
  `start` and `end` all work, in any combination, and a percentage is of the
  pane's size. An edge with no inset does not stick.
- **The pane is the nearest ancestor with `overflow: 'scroll'`** — a `<box>`
  or the `<window>`. Its edges are inside its border and over its padding:
  the band the content scrolls through. `overflow: 'hidden'` clips without
  scrolling, so — unlike on the web — a rounded card between a header and
  the pane does not quietly become the pane the header sticks to. With
  nothing above that scrolls, the box stays where layout put it.
- **The parent is the limit.** The box's margin box never leaves its
  parent's content box, and that is the push. Wrap each header with the rows
  it heads, as above: a header that is a sibling of every row has the whole
  list for a parent and sticks for the whole list. A direct child of the
  pane has the pane's content for a parent, and sticks for the whole scroll.
- **It paints over its siblings.** A sticky box paints after its siblings of
  the same `zIndex`, as CSS paints a positioned box over the ones in flow, so
  the rows that scroll under a header do not paint over it, and it takes the
  press where it covers them. `zIndex` still orders it first. Give it a
  background, or the rows show through.
- **It lands in the frame that scrolled**, with no re-render, so a header
  cannot trail its content by a frame; a header riding with its rows costs
  nothing, and a held one repaints its own rect.
- **`onLayout` reports where layout put the box**, not where it is held,
  the same way a scroll does not fire it. Where it is held is
  `getClientRects()`.

Both axes at once, and one sticky box inside another, are what
`examples/schedule.jsx` is made of: day banners pushed off by the next day, a
row of room names held under the banner, a column of times held at the left,
and the corner where the two meet.

Not supported: CSS's `scroll-padding`. Scrolling a node into view — keyboard
focus reaching a row — brings it to the pane's edge, which can be under a
held header.

Sticky is the built-in [custom position](#custom-positions): the same
placement, written against the same context a registered one is handed.

## Custom positions

A position is CSS's positioning scheme: `relative` lays the box out in flow
and moves it by its insets, `sticky` lays it out in flow and holds it against
a scroll pane's edges. `registerPosition` adds one of your own — the box laid
out in flow, then moved by an offset your scheme works out once the layout
pass is done, in the same frame:

```jsx
import { registerPosition } from 'react-x11/host';

// a layer that scrolls at a share of the pane's speed
registerPosition('parallax', {
  options: { rate: { type: 'number', default: 0.5 } },
  place: (node, { pane, options }) =>
    pane ? { x: 0, y: Math.round(pane.scrollY * options.rate) } : null,
});

<box style={{ overflow: 'scroll', flexGrow: 1 }}>
  <image src={hero} style={{ height: 240, position: 'parallax' }} />
  <box style={{ position: { name: 'parallax', rate: 0.2 } }}>…</box>
</box>;
```

- **It is a `position` value**, by name or with its options, and switches
  like one — from a container query block too. The box is laid out exactly
  where `relative` would put it, and moved; nothing around it reflows. A box
  has one `position`, so to combine a scheme with `absolute`, wrap it in a
  box.
- **The insets are the scheme's.** Yoga never sees them as offsets: sticky
  reads them as thresholds, and a registered position reads them as whatever
  it documents.
- **It runs on every layout pass**, the one a scroll runs included, so what
  it moves lands in the frame that scrolled; one that animates asks for the
  next frame itself. It paints and takes the press over its siblings of the
  same `zIndex`, like sticky.
- **Options are typed**: a `length` is written in logical pixels like any
  length in a style, and a wrong option is reported, naming it, and takes
  its default.

The contract — what `place` is handed and may return — is in
[extending.md](extending.md#a-position-of-your-own).

## Grid

`display: 'grid'` lays a box's children out as a CSS grid, written the way
CSS writes one — `gridTemplateColumns` on the box, `gridColumn` on a child —
so a grid copied from a web codebase lays out here as it was written:

```jsx
// a form: the labels as wide as the widest, the fields taking the rest
<box
  style={{
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    columnGap: 12,
    rowGap: 6,
  }}
>
  <text>Name</text>
  <textinput />
  <text>Postal address</text>
  <textarea />
  <box style={{ gridColumn: '1 / -1' }}>{/* a row the whole width */}</box>
</box>

// a gallery: as many columns of 200 and up as fit, each row as tall as its
// tallest card
<box
  style={{
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
    gap: 8,
  }}
>
  {cards}
</box>

// an app's shell, by named areas
<box
  style={{
    display: 'grid',
    gridTemplateColumns: '200px 1fr',
    gridTemplateRows: 'auto 1fr auto',
    gridTemplateAreas: ['head head', 'side main', 'foot foot'],
    flexGrow: 1,
  }}
>
  <Header style={{ gridArea: 'head' }} />
  <Sidebar style={{ gridArea: 'side' }} />
  <Main style={{ gridArea: 'main' }} />
  <Footer style={{ gridArea: 'foot' }} />
</box>
```

| on the grid box                           |                                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `gridTemplateColumns`, `gridTemplateRows` | a track list, or a number: that many equal tracks                                                           |
| `gridTemplateAreas`                       | one quoted string per row — `'"head head" "side main"'` — or an array of the rows                           |
| `gridAutoColumns`, `gridAutoRows`         | the size of a track the grid adds for a child placed past its template; a number is a length                |
| `gridAutoFlow`                            | `'row'` (the default) or `'column'`, and `'dense'` to back-fill a hole                                      |
| `gap`, `columnGap`, `rowGap`              | between the tracks                                                                                          |
| `justifyItems`, `alignItems`              | where each child sits in its area: `'stretch'` (the default), `'flex-start'`, `'center'`, `'flex-end'`      |
| `justifyContent`, `alignContent`          | where the tracks sit when they leave room                                                                   |
| **on a child**                            |                                                                                                             |
| `gridColumn`, `gridRow`                   | `2`, `'span 2'`, `'2 / 4'`, `'2 / span 3'`, `'1 / -1'`                                                      |
| `gridArea`                                | a name from `gridTemplateAreas`, or four lines; `gridColumn` and `gridRow` beside it win for their own axis |
| `justifySelf`, `alignSelf`                | its own place in its area, over the grid's                                                                  |

Each property is CSS's of the same name (`gridTemplateColumns` is
`grid-template-columns`). A track list takes lengths in `px` (logical
pixels), `%` and `fr`; `auto`, `min-content`, `max-content`; `minmax()`,
`fit-content()`; and `repeat()` with a count, `auto-fill` or `auto-fit`.

Things to know:

- **A number is a count** where CSS's value is a track list:
  `gridTemplateColumns: 3` is three equal columns, `repeat(3, minmax(0,
1fr))`, the way Tailwind's `grid-cols-3` means it — equal whatever is in
  them. `'repeat(3, 1fr)'` is CSS's own, a column never narrower than what is
  in it, so one long word widens its column. Inside a track list a length
  takes its unit, `'200px 1fr'`; on `gridAutoRows` a number is a length, and
  on `gridColumn` a line, counting from 1 at the start and from -1 at the
  end.
- **`layout: 'grid'` is the same request**, under the name every layout goes
  by ([below](#custom-layouts)). A box whose `display` and `layout` disagree
  — `display: 'grid'` beside `layout: 'masonry'`, or `layout: 'grid'` beside
  `display: 'flex'` — is reported, and laid out as flexbox until they agree.
- **The alignment keywords are this renderer's**, the ones `alignItems`
  already takes: `'flex-start'` and `'flex-end'` where CSS grid writes
  `start` and `end`. A value it does not take is an error listing the ones
  it does.
- **The lines are whole pixels.** Tracks are sized exactly and their lines
  snapped, so neighbours in `'1fr 1fr 1fr'` meet on a shared pixel and every
  gap is as wide as it was written. Chrome lays a track out at a fraction of
  a pixel, so a row whose content fits in the fraction can wrap one line
  differently here.
- **It matches Chrome** within a pixel, but for the fraction above.
- **Not here:** subgrid (a grid's child lays its own children out), baseline
  alignment, named lines (`[full-start]` — name an area instead) and the
  `grid` and `grid-template` shorthands. A value that uses one is an error
  naming it.
- **It runs inside the layout pass**, as every layout does — on a window's
  resize, a live one included, and in the frame a container query flips. A
  query block can switch one property alone:
  `'@container width < 500': { gridTemplateColumns: 1 }`. In a scroll pane,
  the grid is a `<box>` inside the pane.
- **What it costs** is its children's sizes, asked only where a track needs
  them. Fixed tracks, `minmax(0, 1fr)` and a bare count never ask; `1fr`'s
  minimum is the content floor, which is measured anyway; `auto`,
  `min-content` and `max-content` columns ask each child once for each width;
  `auto` rows ask each child its height at its column's width, which placing
  it needs anyway. What a child answered is remembered until something inside
  it changes, so a frame in which one card's text changed lays out that card.

Design notes: [design/architecture/grid-layout.md](../design/architecture/grid-layout.md).

## Custom layouts

`layout` hands a box's children to a layout algorithm in place of flexbox.
[Grid](#grid) is one, and the other two built in are:

```jsx
// a board of notes, each dropped into whichever column is shortest so far
<box style={{ layout: { name: 'masonry', columnWidth: 220 }, gap: 12 }}>
  {notes.map((note) => (
    <Note
      key={note.id}
      note={note}
      style={note.pinned && { layoutItem: { span: 2 } }}
    />
  ))}
</box>

// a dialog's buttons, every one as wide as the widest, at the row's end
<box style={{ layout: 'equal-row', gap: 8, justifyContent: 'flex-end' }}>
  <Button>Cancel</Button>
  <Button>Save changes</Button>
</box>
```

**`masonry`** is columns, each child placed in the one that is shortest so
far: the layout of a photo wall or a board of notes of different heights,
which flexbox cannot write — a wrapping row lines its items up in rows. As
many `columnWidth`-wide columns as fit (240 by default), or exactly
`columns`, sharing the width; `columnGap`, `rowGap` and `gap` space them,
and a child's `layoutItem: { span: 2 }` lays it across two.

**`equal-row`** is a row whose children are all as wide as the widest of
them. Flexbox makes siblings equal only by dividing a width it was given
(`flex: 1`), and a row sized by its content — a dialog's buttons — has none
to divide. Squeezed, the cells shrink together, down to the widest child's
content floor and no further. `gap`, `justifyContent` and `alignItems` mean
what they mean on a flex row, and `alignItems` defaults to `'stretch'`, so
the cells are one height too.

Things to know:

- **It runs inside the layout pass**, in the same frame — on a window
  resize, a live resize, a scroll or a container query flip, with no React
  render. Measuring in `onLayout` and setting state instead paints the old
  arrangement first ([react-features.md](react-features.md#measuring-a-node)).
- **It is a style property**, so a container query block can switch it:
  `'@container width < 500': { layout: { name: 'masonry', columns: 1 } }`.
- **Right to left is mirrored for you.** An algorithm places from the left,
  and the renderer mirrors each child across the box when it reads right to
  left: a masonry fills from the right-hand column.
- **Absolutely positioned children** are not the algorithm's: they are
  placed by their insets against the box's padding box, as anywhere else.
- **A child's content floor still holds.** A row inside a masonry card
  squeezes its label only as far as its longest word, the rule everywhere
  else ([elements.md](elements.md#everything-shrinks-nothing-shrinks-to-nothing)).
- **Not on a scroll pane or a window.** A pane's size is its viewport's,
  not its content's: put the layout on a `<box>` inside it, which is what it
  scrolls. It is reported once, and the pane lays out as it would without.
- **A layout that throws**, or a name nobody registered, is reported, and
  the box is laid out as flexbox — in the same frame.

Writing one of your own is `registerLayout` from `react-x11/host`
([extending.md](extending.md#a-layout-algorithm-of-your-own)). Design notes:
[design/architecture/custom-layout.md](../design/architecture/custom-layout.md).

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

Numbers interpolate, and colours interpolate per channel, so any colour the
paint accepts animates. Two percentages of the same unit interpolate as
numbers — `'-40%'` to `'100%'` is a value travelling across whatever contains
it, with nothing measuring the container. A value with no meaningful
midpoint — an enum like `flexDirection`, `auto`, a percentage against a
pixel value — snaps instead, and `zIndex` never transitions. A duration
keyed by a [shorthand](#lengths-and-shorthands) is its longhands', the
longhand's own entry winning: `{ border: 150 }` fades the colour
`border: '1px solid …'` set, and `{ padding: 200 }` moves each side
`padding: '8px 16px'` expanded into.

The easing is a fixed ease-out cubic. A transition starts from **what is on
screen**, not from the declared value, so interrupting one reverses from
where it got to rather than jumping to the end first. One to or from
[`currentColor`](#currentcolor) runs between the colours as they are at the
change.

A transition runs on the window's own frame clock, which stops the frame the
last one lands: nothing polls, and there is no per-widget
`requestAnimationFrame`.

Transitions may animate layout properties, unlike state blocks: an author
who writes `transition: { left: 200 }` has asked for animated layout and
pays a layout pass per frame for it, and a repaint of whatever that pass
moves. `Switch` is the worked example — the thumb is absolutely positioned
and slides on `start`, because `justifyContent` would flip between the ends
with nothing in between.

### Loops

A transition is over when it arrives. `animation` is the other shape: a
property that travels between two values and **keeps doing it**, for the
spinner, the pulse, and everything else that means "working, no idea how
long".

```jsx
<box
  style={{
    position: 'absolute',
    start: '-40%',
    width: '40%',
    animation: { start: { to: '100%', duration: 1100 } },
  }}
/>
```

Per property, and each one names where it goes and how long a crossing
takes:

| key         |                                                                  |
| ----------- | ---------------------------------------------------------------- |
| `to`        | the far end                                                      |
| `from`      | the near end; **defaults to what the style declares**            |
| `duration`  | one crossing, in ms                                              |
| `easing`    | `'linear'` (default), `'ease-in'`, `'ease-out'`, `'ease-in-out'` |
| `alternate` | turn around at each end instead of wrapping back to `from`       |
| `delay`     | when the loop's own time starts, in ms; negative starts it early |

`from` defaulting to the declared value is what makes a pulse read as a
resting colour plus somewhere to go:

```jsx
style={{
  backgroundColor: theme.track,
  animation: {
    backgroundColor: { to: theme.accent, duration: 900, alternate: true },
  },
}}
```

That value is also **where the property rests whenever the loop is not
running** — before the first frame, off screen, or under reduced motion — so
a loop never leaves a node with no value for the thing it animates.

Every loop starts when its node gets the style, so loops with one duration
move together for good. `delay` is how they stop doing that — CSS's
`animation-delay`. A positive delay holds `from` that long before the first
crossing, once rather than every cycle; a negative one starts the loop that
far in, already moving, which is the way to say a phase:

```jsx
const TypingDot = ({ index }) => (
  <box
    style={{
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.textMuted,
      opacity: 0.3,
      animation: {
        opacity: { to: 1, duration: 500, alternate: true, delay: -index * 160 },
      },
    }}
  />
);
```

A changed `delay` is a different loop and starts from the top, as a changed
`duration` does.

A loop's easing is `linear` unless you say otherwise, where a transition's is
ease-out: a cycle that restarts would stutter at the wrap.

**A loop costs a repaint of what moves**, on the window's frame clock: an
indeterminate progress bar repaints the bar, not the window. Prefer it to
`setInterval` → `setState`, which re-renders the component on a cadence
unrelated to when the window can present.

On macOS a loop — or a transition — on a plain box's colour, border width
or radius runs in Core Animation and costs no frames at all. So does a loop
on an inset of a box that is `position: 'absolute'` and
`pointerEvents: 'none'`, as the block of `<ProgressBar indeterminate>` is;
without `pointerEvents: 'none'` it stays on the frame clock, because input is
hit where the layout put the box. Anything else runs as above.
`examples/animation.jsx` has both shapes side by side, with a frame counter
in the terminal that shows the difference.

**And it stops itself** whenever it goes off the screen:

- the window is unmapped, minimized, or fully obscured under a bare WM;
- anything above the node hides it — `display: 'none'`, `<Suspense>`,
  `<Activity>`;
- the node unmounts, or the style stops declaring the loop;
- the desktop asked for **reduced motion**
  ([system.md](system.md#usedesktopsettings--how-the-desktop-wants-an-app-to-feel));
- all the loop can draw is out of sight — scrolled out of its pane, clipped
  away by a box above it, off the window.

Each one leaves the frame clock idle, and every one of them runs the loop
again when it goes away — with its phase reset.

Out of sight is judged after each layout pass, by what **every** frame of
the loop can reach and never by where the current one has the node: the
block of `<ProgressBar indeterminate>` starts each crossing off its track,
and is judged by the track it slides in. A loop on a colour, an opacity or
a radius reaches what the node and its children cover. One on the outline,
or one that moves or sizes a node out of the flow (`position: 'absolute'`),
reaches the nearest box that clips it, or the whole window when nothing
does. And one that moves or sizes a node in the flow is never out of sight
at all: each of its frames can move the node's siblings and resize the
boxes above it, so it runs for as long as its window is up.

Reduced motion is honoured in core, once, for every loop in every
application: `Gtk/EnableAnimations` off means loops do not start. What core
cannot decide is what the _still_ frame should look like, which is the
author's — `<ProgressBar indeterminate>` parks its block inside the track
rather than at its off-screen starting point, so a bar that cannot move
still shows something in progress.

Nothing about this is a per-frame callback: `animation` describes the motion
and the renderer runs it. For a `<glarea>` drawing its own frames,
[`frameLoop`](gl.md) is the per-frame seam; there is no 2D one.

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

**A size query may set layout properties, unlike a state block.** It is only
re-evaluated inside the layout pass a resize already requires, and only when
the size actually changed, so it costs nothing extra.

A malformed query is an error rather than a key that silently never
matches.

## Container queries

`'@container width >= 400'` asks about the box a node is inside rather than
the window it is in — CSS's `@container`, for the case a window query cannot
tell apart: the same card in a 220px sidebar and in a 600px pane, in one
900px window.

```jsx
const s = createStyles({
  pane: { container: true, flexGrow: 1, minWidth: 0, overflow: 'scroll' },
  card: {
    flexDirection: 'column',
    gap: 8,
    '@container width >= 400': { flexDirection: 'row', gap: 16 },
  },
});

<box style={s.pane}>
  <box style={s.card}>…</box>
</box>;
```

A container is declared with the **`container` style property** — CSS's
`container-type` and `container-name` in one — and a block answers to the
**nearest ancestor that declares one**. Wrapping the card in another `<box>`
for a border changes nothing: the parent is not the container, the declared
ancestor is, which is what lets a component be put anywhere and still get
the answer its author meant. A scroll pane is not a container unless it
declares one, though it is the ideal one to declare. A node's blocks never
answer to its own size, even when it declares itself a container: its
declaration is for the blocks under it. The declaration changes nothing
about the container itself; it is neither layout nor paint. Being a style
property, it can be set from inside a query block — a box that is a
container only in the wide layout — and `false` takes a declaration back
from earlier in a style array.

`width` and `height`, with `>=`, `<=`, `>` or `<`, in the logical pixels the
dependent's own lengths are written in. Blocks that match are merged in
declaration order with the other query blocks, before the state blocks.

### Named containers

`container: 'pane'` names the container, and `'@container pane width >= 300'`
asks for it by name — **reaching past** any nearer container. A card that is
a container for its own contents does not capture a query a label inside it
meant for the pane:

```jsx
const s = createStyles({
  pane: { container: 'pane', flexGrow: 1, minWidth: 0, overflow: 'scroll' },
  card: {
    container: true, // the card's contents ask about the card…
    '@container width >= 380': { flexDirection: 'row' }, // …and the card asks the pane
  },
  detail: { '@container width < 220': { display: 'none' } }, // the card
  label: {
    display: 'none',
    '@container pane width >= 300': { display: 'flex' }, // the pane, past the card
  },
});
```

`examples/container-queries.jsx` is that design in full: one `<Card>` in a
sidebar and in a main pane, both panes named `pane`, so the labels come and
go with whichever pane a card is in.

A name nothing above carries makes the block **not apply, quietly** — that
is what lets one component render inside and outside a `sidebar`. An
**unnamed** query with no container above it is reported in development,
the way an unknown token is: the window already has a spelling (`'@width'`),
so the only thing a silent fallback to it could hide is a forgotten
declaration. `REACT_X11_STRICT_TOKENS=1` makes the report a throw.

### When it is answered, and what it costs

Like a size query, a container block **may set layout properties**, and for
the same reason: it is only ever re-evaluated inside a layout pass. Unlike
one, it cannot be answered _before_ the pass — a container's size is what
the pass produces — so the blocks are resolved after it, and the tree is laid
out once more when an answer moved. A frame where no answer crosses a
threshold (a scroll, a hover, a resize between two breakpoints) pays one
size read per container and nothing else. A frame where one does pays what
the same change would have cost had React made it.

When what depends on the size is not a style — how many rows to build, which
component to render — the same size reaches React through `onLayout` on any
element ([react-features.md](react-features.md#measuring-a-node)). It
arrives after the pass, so the reaction lands a frame later than a block
would; that is the reason to write a style as a block where one can.

### A block must not move the size it asks about

Yoga has no size containment, so here this is a rule, detected rather than
prevented. A block that grows the container past the very threshold that
turned it on — and shrinks it back when it turns off — has no size that
satisfies it. The renderer notices, **holds the answer it has**, and says so
once in development, naming the node. The answer stays held until the
container's size moves for some other reason.

The way to stay clear of it is also what makes a good container: a size that
does not come from the content below it.

|                                                  |                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| an explicit `width` / `height`                   | fixed, whatever is inside                                         |
| a flex item with `minWidth: 0` and a `flexBasis` | the parent distributes it; `flex: 1` is both in one               |
| `overflow: 'scroll'`                             | **the natural container**: content overflows rather than grows it |

The common responsive pattern — less content when narrow, more when wide —
is monotone and settles on the first re-layout; a warning means the design
genuinely contradicts itself.

Design notes: [design/architecture/container-queries.md](../design/architecture/container-queries.md).

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
screen. Get it the other way round and the fallback is the _unusual_ case,
which is the one nobody tests.

`transparency` is true only when **both** halves hold: the window was
created on a 32-bit visual (`<window transparent>`, and the display had one
to give), **and** a compositor is running to blend it. Either half missing
and a transparent corner is a _black_ corner — X shows the raw pixels — so
the answer is no, and the block does not apply.

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
display, so the base design can be looked at without stopping the compositor
for the whole session. See
[debugging.md](debugging.md#react_x11_no_transparency1).

## Elements that are not styled

The declarative SVG children carry a vocabulary of their own — `<circle cx
r fill>` is SVG's, not the style channel's — so the style channel does not
apply to them, the same way it does not apply to an `<input type>` in the
DOM. They report
`stylable === false` and their props are passed through untouched.
