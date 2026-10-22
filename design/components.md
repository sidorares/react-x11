# Components: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/components.md](../docs/components.md), the reference, and keep
their original headings so code comments that cite them still resolve.

Widget components are plain React built on the host elements — no
reconciler support involved. They live in the package root export.

## Theming

### The ground and what is on it

`background` is what the **window** is — the fill under everything, painted
by the window itself. `surface` is what is raised off it: a control's fill, a
card, the sheet a menu or a dialog is drawn on. The light palette makes them
the same colour, because a white app on a white ground is what it has always
been; the dark one lifts `surface` a step, because a card at the ground's own
colour is a card you cannot see.

`surfaceHover` and `surfaceActive` are that surface's own interaction steps,
which is what they have always been — before there was a `surface` to be the
steps of.

### What the app says with colour

The `…Text` four are the letters on a status fill, and **a palette almost
never sets them**: each is derived from the fill it goes on, as the more
legible of that palette's own `text` and `background`. So a theme whose
`warning` is a yellow gets dark letters on it without having thought about
it — and the same rule fixes `accentText`, which used to be inherited as
white onto accents that could not carry white.

### Which way it reads

The provider plants the matching `direction` style property in the node tree
as it goes, so the **boxes** and the **widgets** mirror together. That is
why this is the way to do it rather than a bare `<box style={{ direction:
'rtl' }}>`: yoga mirrors boxes on its own, but which way an arrow key steps,
which way a chevron points and which side a submenu opens on are widget
decisions, read through `useDirection()`. Under a bare style property the
layout mirrors and those do not.

Most of the set needs no help — `Button`, `Checkbox`, `Radio`, `Switch` and
`ProgressBar` are rows and flex ratios, and come out mirrored on their own.
The rest each have one thing yoga could not answer:

| widget                    | what mirrors                                        |
| ------------------------- | --------------------------------------------------- |
| `Slider`                  | the drag, and Left/Right (Up/Down do not)           |
| `Tabs`                    | Left/Right walk the strip the way it is drawn       |
| `Table`                   | column resizing, the sort mark, the header's scroll |
| `SplitPane`               | which pane is first, the drag and its arrows        |
| `MenuBar` / `ContextMenu` | submenus open to the start side, and their arrows   |
| `Select`, `PasswordInput` | the field's own insets follow the text              |

The `radius…` three that name a popup are derived too, and from the **text
size** rather than from `radius`: a menu is a sheet laid over the window
where a button is a control cut into it, and half the body size is the
number desktops land near — 7px at a 14px body. The other two step in from
there, because a rounded thing inside a rounded thing needs the tighter
curve: `radiusPopupItem` is the highlight on a menu row, `radiusTooltip` the
tooltip bubble. A palette that moves `fontSize` and names none of them gets
all three in proportion; naming one pins it.

`radiusPopupItem` is a **ceiling**, not the radius a row gets. A rounded rect
inside a rounded rect only reads as one shape when the two curves share a
centre, which happens exactly when the inner radius is the outer one less the
gap between them — so a row's corner is `radiusPopup` minus the sheet's
hairline border minus the inset the row is padded in by, and the token caps
it. A theme that wants rounder highlights rounds the sheet they sit on: that
is the only change that can round both and keep them concentric.

They are only ever _seen_ where the display composites — a popup gives up
its corners by not painting them, and with nothing blending them those
pixels are black rather than the desktop, so the widgets ask the window
(`'@supports transparency'`, [styling.md](../docs/styling.md)) and stay square
where the answer is no.

## System icons

**`size` is the mark, not a grid it sits in.** This is the one place the set
departs from how lucide and its descendants are drawn: theirs put about 14px
of ink in a 24px box, so you reach for `size={20}` next to 14px text. Here
the ink runs corner to corner, so `size` is what you actually see and the
number to pick is the number you want — the `Select` chevron is
`capBand(fontSize)` because it should be as wide as the capitals beside it.

### Affordances, not nouns

The set holds glyphs that say something about **the control**: there is more
here, this one is chosen, this closes, this is hidden. It holds no nouns —
no folder, no document, no save, no printer. Those belong to an icon theme
(lucide, an XDG icon theme, your own art), they are unbounded in number, and
a widget set that starts shipping them has taken on a design system.

That is also the answer to "why is X missing": if X names a thing rather
than an action the control affords, it is not going to be here. Bringing
your own set is expected and supported — a `<svg>` or a `<canvas>` goes
anywhere an `<Icon>` does, and `ContextMenu`'s `icon` takes either. The
platform's own set is there too:
[`<image src={{ symbol }}>`](../docs/elements.md#src-symbol---the-platforms-own-icons)
draws an SF Symbol on macOS and an icon from the desktop's icon theme
elsewhere, in the text colour.

The **drawings are not themable** for the same reason: the geometry is the
widget set's vocabulary, and an application that wants a different chevron
wants an icon library. Colour and size are yours; the shape is not.

### Colour inherits; size does not

That covers the hover case too. `:hover` marks the row, `color` is
inherited, and the label and the icon both follow — which is why
`ContextMenu`'s submenu chevron carries no colour of its own any more. The `color` prop is for saying something the surrounding text does
not: a destructive action's mark, or a check drawn on an accent fill.

**`size` does not inherit, and is deliberately not `fontSize`.** A glyph is
a drawing rather than a letter — no baseline to sit on, no ascent to be
measured against — so it takes its default from the palette's `fontSize` and
stays put when a label beside it shrinks. Pass `size` for the one icon that
has to be bigger.

### What it costs to draw one

Each glyph is a drawing over `<canvas mono>`
([elements.md](../docs/elements.md#canvas)), which is a promise that everything it
paints is one colour it did not choose — so one drawing serves every state a
control puts it in, and the paint cache can keep one rendered copy of
`chevronDown` at 12px for every chevron on the screen at once.

The entry is **coverage**, so the colour is applied at composite time and
stays out of the key: one rendered copy of `chevronDown` at 12px serves the
resting row, the highlighted row, the disabled one and both colour schemes —
the trick the glyph cache runs on text, and the one `<svg>` gets for a
`fill="currentColor"` document. The size cannot leave the key, since a
coverage surface is pixels at a fixed size, so one icon at two sizes is two
entries.

The drawings are module-level, so re-rendering a list invalidates none of
its icons: `<canvas>` compares `onDraw` by identity, and a fresh closure per
render is a repaint per glyph.

## Basic controls

`Button`, `Checkbox`, `Radio`/`RadioGroup`, `Switch` and `ProgressBar` share
one piece of plumbing, `useControl(disabled, onActivate)`: it makes the
control focusable, activates it on click — and so on Space and Enter, which
are a click on anything with an `onClick` unless Ctrl, Alt or Super make
them a shortcut's ([events.md](../docs/events.md#space-and-enter-are-a-click)), the
widgets having no key mapping of their own any more — sets the pointer cursor,
and expresses hover, press and focus
feedback as `:hover`/`:active`/`:focus` style blocks rather than React state
— so moving the pointer over a control repaints one node instead of
rendering.

### Native bezels

On a backend that renders the platform's own control bezels — today the
**Cocoa** backend, never X11 — `Button`, `Checkbox`, `Radio`, `Switch`,
`Slider` and `Select` wear AppKit's pixels by default, while interaction,
focus, keyboard and accessibility stay this library's shared implementation.
The mechanism is a bezel _image_ drawn through the ordinary paint path, not
an embedded `NSView`: the press model and the event routing are behaviour
this project considers part of its identity, and a real `NSControl` would
take them over wholesale. [macos.md](../docs/macos.md#native-controls) is the
design record.

`controls` is `'auto'` (bezels where the backend has them), `'native'` (ask
for them, and hear about it in development where there are none) or
`'drawn'` (this library's rendering everywhere). It lives in the theme
rather than in `style` because whether an app looks native is an
app-identity decision, not a per-node one. `native={false}` is the escape
hatch for the one custom-branded control — and a control naming its own
colours in `style` should also say it, because a bezel the system draws
ignores them.

Under a native bezel, `style` sizes the box the control _sits in_ rather
than the control itself. A `<Button>` or a `<Select>` keeps AppKit's own
height and is centred in whatever footprint the layout gives it, so
`style={{ height: 44 }}`, a `height: '100%'` in a taller parent, a
`flexGrow: 1` or a taller neighbour in a stretching row leave a 22pt
control in a 44pt slot instead of stretching a bezel the system draws at
one size. The slack around it is not part of the control: a press up there
does nothing, as it does in AppKit. Drawn controls stretch as they always
have — their chrome is drawn to the box and their label is centred in it,
so a stretched drawn control is merely roomy.

The one thing that makes a native button taller is its own label. Squeezed
narrower than its label, a `<Button>` wraps it at its words — native or
drawn — and grows by the lines it gained, which on macOS is drawn with
AppKit's flexible-height push bezel, the one it has for a title that wraps.
A row that should never wrap its buttons wants `flexWrap: 'wrap'` on the
row instead, so the buttons move to a second row rather than their labels
to a second line.

### The press state

Every control here activates on the **release** — that is what a click is.
So every one of them also has a distinct look while it is being _held_,
because otherwise a click a user takes half a second over is half a second
of a control that has visibly not heard them, and the change, when it comes,
reads as the machine being slow rather than the hand being unhurried.

### The change event, and `name`

`target` is a plain descriptor rather than a node, and that is the one place
this differs from the host elements: a widget is several nodes with no single
element holding its value, so there is nothing honest to point at. Its shape
is what formik's `handleChange` and react-hook-form's event reader
destructure — `target.type` is how they tell a checkbox from a text field,
which is why it is set even though nothing in react-x11 reads it. There is no
`preventDefault`: the value has already changed by the time the handler runs.

**The line is `name`.** A widget that takes one is a form field and reports
an event. `Tabs`, `Table` and the menus are not form fields — you would never
register a tab strip with formik — and keep their plain callbacks (`Tabs`
calls `onChange(id)`).

### `Button`

Chrome and colour are two axes, and they compose. `variant` is how much box
the button carries — `solid` a fill, `outline` a border on nothing, `ghost`
neither, for the affordance that sits inside other content (a `✕` on a chip,
a delete on a form row) and must not add a box to the row it lives in.
`primary` is whose colours it speaks in. So a dialog footer is an `outline`
beside a `primary` solid, and a toolbar's loudest icon is
`primary variant="ghost"` — every combination keeps the widget states, which
is the point of not hand-drawing the chrome-less ones. All variants keep the
border _width_, so a mixed row lines up to the pixel.

`size="small"` halves the control padding — the toolbar and inline-row
metric. It is derived from the palette, so a theme that moves `paddingY`
moves both sizes together, which a hand-made `style={{ height: 22 }}` would
not.

A label with less room than it needs wraps at its words, the lines centred
under one another, and the button grows to hold them — a row too narrow
for its buttons squeezes each to its longest word first, as it would any
paragraph ([Native bezels](../docs/components.md#native-bezels) has what that does to a native
button).

An **element** child inherits the resolved label colour — the ink is set on
the button's box and `color` inherits ([styling.md](../docs/styling.md)) — so an
icon+label button is correct by construction in every state, disabled
included, with nothing passed to the icon:

```jsx
<Button primary disabled={busy} onPress={run}>
  <Icon name="chevronRight" />
  Continue
</Button>

<Button variant="ghost" size="small" aria-label="Remove" onPress={remove}>
  <Icon name="close" />
</Button>
```

### `Switch`

`checked`, `onChange(ev)`, `name` and `disabled`, the same semantics
as `Checkbox` in a sliding pill. The thumb is absolutely positioned and
animates on `left` (`transition: { left: 120 }`) because `justifyContent`
would flip between the ends with nothing in between to animate — the worked
example in [styling.md](../docs/styling.md#transitions).

### `ProgressBar`

The determinate fill is expressed as flex ratios rather than a percentage
width. A percentage child resolves against space that is still being
measured, which fed back into the track's intrinsic width — a card with a
fuller bar came out wider than one with an empty bar.

`indeterminate` is the worked example of a
[style loop](../docs/styling.md#loops): the block is absolutely positioned and
travels on the logical `start` edge from `-40%` to `100%` of the track, so it
mirrors with the text direction, is right at any width without measuring
anything, and repaints the bar rather than the window. It reports
`aria-busy` **with no value at all**, which is what tells a screen reader
that a percentage is not coming.

Under [reduced motion](../docs/system.md#usedesktopsettings--how-the-desktop-wants-an-app-to-feel)
the loop never starts — that part is core's, and every loop in every app gets
it — and the block parks in the middle of the track instead of at its
off-screen starting point. A still bar that shows nothing would say the app
had stopped; a full one would say it had finished.

## `Select`

The caption's `fontSize`, as a number, is the one the chevron is sized
against, since the chevron is as tall as the capitals beside it and an
`<Icon>`'s size does not inherit. `chevronStyle={{ display: 'none' }}` leaves
it out, for a trigger whose arrow is drawn by something else. A select with
either slot is drawn, where `controls: 'auto'` would otherwise use the
platform's popup bezel, whose pixels no style reaches. The menu is not
restyled: it is the same surface a menu is.

**The menu can be the platform's.** On macOS, with `@windowkit/appkit` 0.20
or later, a select under the native bezel drops a real `NSMenu`: the chosen
row placed over the trigger and checked, the menu at least the trigger's
width, AppKit's tracking, type-select and VoiceOver. A drawn menu sized as
one was the best a drawn widget could do; this is the menu itself.
`nativeMenu` is that choice on its own: it follows the trigger by default,
`true` asks for the platform's menu under a drawn trigger too — what a
browser does with a `<select>` a page styled, and what `<Html>` does — set
at the caption's size and in the family its style names when the system
has it, and `false` keeps the drawn menu. Elsewhere, and on an older
bridge, the menu is drawn whatever the prop says. The menu is the
platform's to dismiss: Escape, a click outside, or the application losing
focus, and the select hears a pick or nothing.

**A caption is one line.** The trigger is as wide as the form made it and the
value in it can be any length, so a caption with no room left ends in a `…`
rather than wrapping to a second line — which there is no height for: the
trigger is one row of label, and under a native popup bezel it is AppKit's
own fixed height, so the wrapped line drew outside the control. The menu is
sized to its longest option rather than to the trigger, so its rows are
whole; where the screen is narrower than that longest label and the sheet is
clamped to it, they end in a `…` too.

The menu is the **same surface a menu is**: an ARGB popup rounded at
`radiusPopup` with a hairline border where the display composites, and the
active option is the same pill at `radiusPopupItem`, inset from the sheet's
edge. A dropdown and a menu are one kind of thing, and two shapes for it
would only say that the widgets were written at different times.

Opening on the press rather than the release is deliberate, and it is the
one control whose answer to a press is more than a colour: a dropdown exists
to be looked at, so waiting for the button to come back up before showing it
wastes the whole time the button is down. It is what every desktop toolkit
does. A press while the menu is up dismisses it through the popup's pointer
grab, so the two never fight over the toggle.

Keyboard, while the trigger is focused (the popup is override-redirect and
never takes focus, so the trigger keeps handling keys with the menu open):

| key               | closed         | open                                    |
| ----------------- | -------------- | --------------------------------------- |
| `Down` / `Up`     | opens the menu | move the active option, wrapping around |
| `Home` / `End`    | —              | first / last option                     |
| `Enter` / `Space` | opens the menu | pick the active option                  |
| `Escape`          | —              | close without picking                   |

The menu opens with the current value active, hovering an option makes it
active (pointer and keyboard share one highlight), and the active option is
scrolled into view.

**PageUp/PageDown** move by a menu viewport (`MAX_MENU_HEIGHT / ITEM_HEIGHT`
options), clamping at the ends rather than wrapping the way the arrows do.

**Losing the window** closes it too. That is not the same event as the
trigger's own blur: a window losing the window manager's focus leaves the
node inside it focused and merely stops it looking active — so without this
the menu would still be up over an application you have switched away from,
holding the pointer grab it opened with. The menus do the same.

## `Calendar` / `DatePicker`

Moved to [`@react-x11/components`](../docs/ecosystem.md). A date picker is a locale
problem before it is a widget, and the calendar systems, holiday sets and
range semantics people need do not belong in a renderer.

## `PasswordInput`

### Why a scribble

Bullets answer the wrong question. They report **how many characters** have
been typed — countably, from across the room — and they report almost nothing
about the keystroke that just landed, because one more identical dot at the
end of a row of identical dots is the least visible change a field could
make. The feedback is weakest exactly where a password field needs it, and
strongest exactly where it should not be.

So the mask is a single stroke through points chosen by a generator seeded
from the window id and a hash of the value. Every keystroke reseeds it, so
**the whole curve moves on every character** — feedback you cannot miss — and
nothing in the shape is per-character: the pen visits a number of points taken
from the mask's _width_, where a character is worth about half a point, so no
part of the stroke can be matched to anything typed.

It is a **scribble rather than a waveform**, and that is a decision rather
than a look. A stroke whose `x` only ever increases is the plot of a
function, and the eye reads it as one — value against position, meaning in
the peaks — however wild the `y` is. So the points are laid out one per
column, which is what makes the stroke cover the width it was given, and then
visited **out of order**: the pen doubles back, crosses what it has already
drawn, and leaves loops. The shuffle is local rather than global, because in
a box seventeen pixels tall a jump right across it is a long shallow scratch,
and a maskful of those is not a scribble either.

What does grow is the width, because a mask that did not would say nothing
about progress. Each position contributes an advance drawn from a **second,
window-seeded** stream, so the width only ever grows as you type, never
twitches when a character is replaced, and is not a clean multiple of
anything a glance could divide.

The honest limit, since a mask that oversells itself is worse than one that
does not: **this hides a glance, not a recording.** Someone watching the
field grow keystroke by keystroke still counts the keystrokes, and a long
password still sits in a visibly different bracket from a short one.

### Two states, and what holds across both

**Masked**, editing is smaller than `<textinput>`'s, because a scribble has
nowhere to put a caret: type, Backspace, Ctrl+Backspace / Ctrl+U / Delete to
clear, Ctrl+V or Shift+Insert to paste, Enter to submit. No caret, no
selection, no undo history — a rewindable secret is not a feature.

**Revealed**, it is an ordinary text input, because that is what it looks
like and anything else would be a trap. A real `<textinput>` takes the mask's
place: caret, selection, arrow keys, a click into the middle of the word,
undo, the edit menu. Focus follows the swap in both directions, and the
reveal ends when the keyboard leaves the widget — not when it moves between
the field and the input inside it.

What holds in **both** states is that nothing leaves by a selection. Ctrl+C
and Ctrl+X do nothing, the revealed input carries
[`sensitive`](../docs/elements.md#sensitive) so its menu has no Cut or Copy, and
neither state ever takes PRIMARY, so a middle click in another window cannot
spend it. The line is between what is on screen and what is on the clipboard:
the first stops being visible when the field is hidden, the second is
readable by every client on the display until something else takes it.

While the value is masked it is **never laid out and never drawn**: the mask
is measured from one reference character, so the secret does not enter ntk's
shaping cache and its glyphs never reach the X server. Revealing it costs
what revealing it costs. The eye is a pointer affordance and not a tab stop,
as GTK's peek icon is; `revealed` + `onRevealChange` put the toggle wherever
your keyboard can reach it.

Caps Lock is reported while it is on, from the modifier state on the keys as
they arrive — the mistake that a masked field otherwise lets you make four
times before telling you.

### Password managers

Paste and typing are the two seams that reach a field on this desktop, and
both work here: XTEST auto-type arrives as ordinary key events, and Ctrl+V
takes a secret from the clipboard with control characters stripped so a
manager's trailing newline stays out of it. Which manager does what, what the
window title has to do with it, and the seams that are _not_ a field —
Secret Service, the sandbox portal, AT-SPI — are in
[desktop.md](../docs/desktop.md#password-fields-and-password-managers).

## `Slider`

The thumb's `width` and `height`, as numbers, are the sizes the widget works
with: the drag's travel is the track less one thumb, and the control is as tall
as the taller of thumb and track, with its target still grown to 24. A
`marginStart` and `marginEnd` of half a thumb on the track are what let the
thumb overhang its ends. A slider with any slot is drawn, where `controls: 'auto'` would
otherwise use the platform's bezel, whose pixels no style reaches.

Dragging uses [pointer capture](../docs/events.md#pointer-capture): the press
captures, so the thumb keeps following a pointer that has wandered far
outside the widget, and releasing out there still ends the drag.

Keyboard: arrows step, `Home`/`End` jump to the ends, `PageUp`/`PageDown`
move by ten steps.

The thumb is centred on its value, so the usable travel is the track width
minus one thumb width — otherwise `min` and `max` would be unreachable.

## `Tooltip`

Wraps its children in a row box carrying the hover handlers and the anchor
ref, so it composes around any element. Hides immediately on leave and on
mousedown — a tooltip lingering over the menu you just opened is the
classic annoyance.

**One at a time**, per connection: a hint belongs to where the pointer is,
and there is one pointer. A trigger taking the hover dismisses whatever is
showing straight away rather than at the end of its own delay, so two are
never up together saying different things about the same place. This does
not fight the safe-polygon grace that lets a hint with content in it be
reached — a trigger underneath an open hint cannot be hovered, the popup
being a window above it.

`direction` is which side of the trigger it opens on. The default, `'auto'`,
takes the first side the hint fits on, preferring above — measured against
the **screen**, because a popup is a real X window and the screen is what
bounds it. A named side is a preference rather than a promise either way:
it still flips to its opposite instead of opening off-screen. (`placement`
is the older name for the same prop and still wins where it is given.)

A **string** `label` is measured and the popup sized around it, because a
`<popup>` is a real X window and needs its size before layout. An
**element** label is measured too — nothing to size, nothing to guess: the
popup is rendered once [`hidden`](../docs/elements.md#hidden--realized-laid-out-not-on-screen)
at its natural size (a real layout of the real content, capped at the screen
and at `maxWidth`/`maxHeight`), the size is read back, and the same
placement math runs before anything is mapped. Both commits land in the same
task and the popup maps last, so it is only ever on screen placed and at its
final size. The element gets the bubble to fill, with no padding imposed on
it:

```jsx
<Tooltip
  label={
    <box style={{ flexGrow: 1, padding: 10, gap: 7 }}>
      <text style={{ color: '#f5f6fa' }}>Scratch volume</text>
      <ProgressBar value={used} />
    </box>
  }
  maxWidth={260}
  direction="right"
>
  <box>…</box>
</Tooltip>
```

`width`/`height` still pin an axis exactly: give both and the measuring pass
is skipped entirely (the guaranteed-fit mode element labels used to
require); give one and the other is measured for it, so `width={340}` is a
fixed column whose height fits the message. The size is settled at open —
content that changes size while the hint is up keeps the bubble it opened
with until the next open, which is a hint's lifetime away.

**The palette inside the bubble is upside down.** A tooltip is drawn in the
palette's ink so that it reads as a label over the desktop rather than as
another panel of the app — so inside it, `$background` is the bubble and
`$text` is the ink on it, published through a `ThemeProvider` so that
`useTheme()` agrees. Write the content the way you would write anything
else and it is legible in both schemes; hard-code a light text colour and
it will be invisible on the light bubble a dark palette gives it. `textMuted`
is derived for the same reason — the palette's own is a grey chosen against
the app's background, not against this one — and `$surface` is the bubble
too, so a card written for the app does not light up inside a tooltip.

Where the display composites, the popup is an ARGB window: a bubble rounded
at `radiusTooltip`, no border, and a small arrow pointing back at the middle
of the trigger with everything neither covers left transparent. Without a
compositor it is the square opaque rectangle it has always been and there is
no arrow — those pixels would be black rather than empty.

## `Dialog`

| prop       |                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `open`     | renders nothing when false; the popup exists only while true                                                              |
| `title`    | names the dialog, drawn once: the frame's caption when managed, a bold in-content heading when not                        |
| `children` | body content; strings become `<text>`                                                                                     |
| `actions`  | elements for the right-aligned button row                                                                                 |
| `onClose`  | Escape, or the window manager's close button                                                                              |
| `managed`  | `false` for the override-redirect popup 1.x shipped (below)                                                               |
| `width`    | popup width (default 360); `'auto'` for the content's                                                                     |
| `height`   | popup height (default `'auto'`: the content's, capped at the monitor — [below](../docs/components.md#size-and-placement)) |

Escape closes because keys go to the focused node inside the popup and
bubble out through the popup's place in the JSX tree; so does the window
manager's close button, through `onCloseRequest`. **Pointer modality is not
enforced** — widgets in the owner window stay clickable behind the dialog —
so it is for confirmations, not for guarding state. (`_NET_WM_STATE_MODAL`
is the mechanism that would enforce it, and it means nothing without the
`WM_TRANSIENT_FOR` this now sets; that is why the property had to come
first.)

### `managed`

They are one choice, not two: a client-side pointer grab over a window the
window manager is trying to let the user drag swallows the press that would
start the drag, so `grab` and the frame turn on and off together. A managed
dialog staying open when you click elsewhere is not a regression — it is what
a dialog does. `managed={false}` is the right shape for a transient
confirmation on a display with no window manager at all.

The owner is resolved automatically: `Dialog` already keeps an out-of-flow
`<box>` inside the owner window for placement, and a ref to any drawn node
resolves to the window that owns it
([`transientFor`](../docs/elements.md#transientfor--a-window-that-belongs-to-another)).

### Size and placement

**The height is the content's** by default (`height="auto"`): ten lines and
a row of buttons make a dialog as tall as ten lines and a row of buttons. The
popup measures its content, centres itself over the owner window at that
size and only then opens — it is born the right size in the right place,
never shown at a guess and corrected
([`placement: 'center'`](../docs/elements.md#centred-over-something)).

- **Capped at the monitor.** Content taller than the usable height of the
  monitor caps the dialog there; the body scrolls, and the `actions` row stays
  pinned at the bottom of the window. The body is a tab stop only while it has
  something to scroll. A numeric `height` scrolls the same way when the
  content needs more than it, where the overflow, buttons included, used to
  be cut off at the bottom edge (#940).
- **Following its content.** A dialog whose content changes while it is open
  re-fits to it, growing from its **top edge**: the title and the field the
  user is looking at stay where they are, and only the bottom moves. It moves
  up only as far as it takes to stay on the monitor. A managed dialog the user
  dragged aside grows where they put it.
- **Centred once,** over where the owner window was when the dialog opened,
  and not tracked after that: moving the owner does not drag the dialog with
  it, which is the window manager's call on a managed one.

`width` stays a number by default, 360: a body of prose wraps to it, where a
natural width would be as wide as its longest sentence. `width="auto"` is
there for a dialog whose content has a width of its own (a grid of fields, an
image). A number for either axis is that size exactly.

`centerRect(node, {width, height})` is the same centring as a function,
exported alongside `anchorRect` for window-centred popups of your own that
know their size; one that does not uses `<popup anchor={{ rect, placement:
'center' }}>` and lets the window work it out.

## `MenuBar` / `ContextMenu`

**`shortcut` is a binding, not a label.** It is a list of alternatives, each a
list of modifier tokens ending in the key — `[['Control', 'S']]` — and a
mounted menu answers it: Ctrl+S fires that item's `onSelect` without the menu
being opened, gated by the item's own `enabled` and `visible`, and it keeps
working when the desktop's panel has taken the menu over. One array is then
the drawn menu, the exported dbusmenu payload, the `aria-keyshortcuts`
announcement and the binding, so there is nothing to keep in step by hand. The
chord rules, the vocabulary the key tokens come from, `useAccelerator` for a
shortcut that is not in a menu, and `accelerators={false}` for an app with its
own dispatcher are all in [events.md](../docs/events.md#accelerators).

**The vocabulary is `com.canonical.dbusmenu`'s**, and that is not incidental.
On a desktop whose panel shows application menus, `MenuBar` hands this array
straight over and stops drawing — no configuration, no second authoring model,
the same line of JSX either way. `type: 'separator'` rather than
`separator: true`, `enabled: false` rather than `disabled: true`,
`toggleType`/`toggleState` rather than a bare `checked`, and `shortcut` as a
list of modifier tokens rather than a display string, all follow from that.
`toggleState` is `0`, `1` or `-1`, the last being indeterminate. See
[globalmenu.md](../docs/globalmenu.md), which also covers `globalMenu={false}`.

**The sheet.** Where the display composites, a menu is an ARGB window
rounded at `radiusPopup` with a hairline border, and the highlight on a row
is a pill: inset from the popup's edge by the list's own padding and rounded
a step tighter (`radiusPopupItem`), so it reads as sitting _on_ the sheet
rather than cutting across it. The fill is `hoverBackground` — the palette's
selection colour, shared with `Select`'s active option and `Table`'s current
row, so one token moves every highlight in the app. Without a compositor
both go square, which is what those pixels can honestly be.

**One selection at a time.** The bar item, the row under it and the row
under that are one trail, and only its deepest level wears the selection
colour; everything behind is drawn in `surfaceActive`.
They are still chosen — they are the way back — but two selection-coloured
rows in two menus claim the same thing twice, and only one of them is where
the keys are going. A submenu that is open with _nothing_ selected in it has
not taken over yet: the pointer is still on the row that opened it, so that
row stays lit — which is why a menu bar item stays coloured until you touch
a row in the menu it opened, and goes quiet then.

The bar item wears the same pill as the rows, at `radiusPopupItem` — the same
padding around the same capitals, so a title and the first row of the menu it
opens are one shape in one size, inset into the bar by a few pixels of margin
that sit outside that padding.

**Titles that do not fit.** A bar narrower than its menus paints as many as
fit and moves the rest behind a chevron at the end of it — the system set's
`moreVertical`, drawn rather than a `»`, so it is a mark and not a font's
opinion of one. The chevron is an ordinary bar entry whose items are the
menus that were cut, so each row opens the menu it stands for as a submenu,
and it is a real stop for Left/Right: **the keyboard walks exactly what is
painted**, never a title laid out past the window's edge. Widen the window
and the titles come back one at a time. The bar measures itself, so the
first frame of a new bar always shows everything and the cut lands on the
next — and none of this happens on a desktop whose panel has taken the menu,
where there is no bar of ours to overflow.

**Icons.** `icon` fills the column left of the label — the same column a
`toggleType` mark uses, so an item that is both checked and iconned shows
the check: the check is state, the icon is only identity. `icon` is drawn by
react-x11 and never crosses the bus; `iconName` is the icon-theme name a
panel uses ([globalmenu.md](../docs/globalmenu.md)). One column rather than
two, because a second would indent every label in the menu to reserve room
for icons most items do not have.

The column is there for the menus that draw in it and gone from the ones
that do not. What counts is what a row actually paints: one icon, or one
toggle that is _on_, anywhere in a menu indents every label in it — and a
menu of plain commands, or of checkboxes that all happen to be off, has no
column at all and its labels sit where a label sits.

So ticking the first item in such a menu moves its labels sideways, once.
Toolkits that reserve the column unconditionally are buying stillness in
that one frame, and paying for it with an indent on every menu that has a
toggle anywhere in it — this one makes the other trade. A menu that already
has a mark in it keeps the column whatever happens to the rest.

Pass a **function** for anything real. It is called with the colour the
row's label is being drawn in and the size the column allows, which is what
lets one drawing follow its row into the highlight and into the disabled
grey:

```jsx
const save = ({ color, size }) => (
  <svg source={SAVE_SVG} style={{ width: size, height: size, color }} />
);

{ label: 'Save', icon: save, shortcut: [['Control', 'S']], onSelect: onSave }
```

Paint the SVG in `currentColor` and the renderer caches it as coverage
rather than as pixels, so recolouring per row is a composite and every
colour of the icon shares one rendered copy
([elements.md](../docs/elements.md#svg)). A [system icon](../docs/components.md#system-icons) is already
that, and takes the same two arguments:

```jsx
{ label: 'Close', icon: (p) => <Icon name="close" {...p} />, onSelect: onClose }
```

A **string** icon is drawn as text, which is a one-liner — but it is only as
good as the font, and `✂` or `⏻` is an empty box on a machine without them.
An element is rendered as-is. `examples/menu.jsx` has a worked set.

The **toggle marks** are system icons for that reason: a checked item is a
`check`, a radio one a `dot`, and the indeterminate third state a `dash`.
They used to be `✓`, `●` and `–` set in the row's font, which is the same
gamble this paragraph tells you not to take.

Nesting is unlimited. Each level is its own `<popup>` with `placement:
'right'`, so it flips to the left near a screen edge like any other anchored
popup. It hangs off the **menu's** outer edge and lines up with the row that
opened it — two different nodes, which is what `anchorRect`'s `alignTo` is
for. Anchoring both to the row would put the submenu inside its parent by
the menu's border and padding, and the two would overlap.

Lined up on the **items**, not on the boxes: a submenu whose top edge is
level with its parent row starts its first item a border and a padding
lower, and what the eye lines up is the text. `anchorRect`'s `alignOffset`
is the shift that pays for the submenu's own chrome, so the row you came
from and the row you arrive at are on one line.

**PageUp/PageDown** step ten rows and then settle on the nearest selectable
entry in the direction of travel, so a page never lands on a separator or a
disabled row. Menus size to their content rather than scrolling, so the
stride is fixed — deriving one from the menu height would just equal
Home/End.

Open state is a single path of active indices — one per open level — so
moving the selection at any level truncates the path and closes deeper
levels for free.

Both keep focus on a node in the _owner_ window — the popup is
override-redirect and never takes focus — which is the same arrangement
`Select` uses. `ContextMenu`'s wrapper is focusable for that reason and
takes focus when the menu opens. It is `tabIndex={-1}` rather than
`focusable`: it has no role or name, so as a Tab stop it would be announced
as an unnamed filler around controls that are already stops of their own.

Switching between `MenuBar` menus reuses the same X window and moves it
rather than destroying and recreating one, so there is no flicker.

### Safe-polygon hover

Reaching a submenu means moving the pointer _diagonally_ across the rows in
between, and reaching a tooltip means leaving the trigger it belongs to — so
naive hover handling closes both just as the user aims at them. `MenuBar`,
`ContextMenu` and `Tooltip` therefore use
[floating-ui's safePolygon](https://floating-ui.com/docs/usehover#safepolygon)
idea: the triangle between where the pointer was and the near edge of the
open surface counts as still hovering the parent.

While the pointer is inside that triangle, hover changes are held back —
but only for `SAFE_HOVER_DELAY` (320 ms), so a pointer that stops there
still means what it landed on. Leaving the triangle switches immediately,
and reaching the surface keeps it open for as long as the pointer stays.

The helpers are exported for widgets of your own:
`movingToward(point, apex, rect)`, `safePolygon(apex, rect, buffer)`,
`pointInPolygon(point, polygon)` and `screenPoint(ev)`. All coordinates are
**screen** coordinates, because the trigger and the popup are different X
windows.

## `Tabs`

`content` may be a node or a function. A function is called only while that
tab is selected, which is how to avoid building a panel nobody is looking
at. Items with no `content` at all make `Tabs` a pure navigator — useful
when the panel lives elsewhere, as in `examples/app.jsx`, where the strip is
in one half of a `SplitPane` and the panel in the other.

The strip is a **single tab stop**. Left/Right (Up/Down when vertical) move
and wrap, Home/End jump to the ends, disabled tabs are skipped. Arrows
select as they move, the way a desktop notebook behaves; `manual` splits
focus from selection, which is what you want when a panel is expensive.

## `Table`

**Rows must all be `rowHeight` tall.** That is the price of the table only
building what is on screen: with ten thousand rows it mounts the twenty or
so in the viewport and swaps them as you scroll, and everything above and
below is a single spacer box, so the scrollbar still measures the whole
list. Sorting a hundred thousand rows is still the caller's problem — pass
`sort` and sort the data yourself when that matters.

The **table** holds the focus, not the row: a row is unmounted as soon as it
scrolls out of view, and focus would go with it. Up/Down move the selection,
PageUp/PageDown by a viewport, Home/End to the ends, and the selection is
kept on screen without building the rows in between. A click selects, a
double click activates — the same `onActivate` Enter fires, counted from
`ev.detail` like any other multi-click.

The header scrolls sideways with the body but never vertically. Between two
headers there is a hairline rule and, just left of it, a grab band seven
pixels wide: the separator you see and the handle you hit are not the same
size, because a boundary wants to be thin and a handle wants to be easy. The
band is invisible until the pointer is on it and takes the accent while it is
held, and it is a **sibling** of the header rather than a child of it — a
click fires on the nearest common ancestor of press and release, so a handle
inside the header would end every resize with a sort of the column that was
just dragged. The handle takes focus on the press, so Left/Right resize by
16px from the keyboard as well.

## `SplitPane`

Only the first pane's size is stored; the second takes what is left, so a
window resize can never leave a gap. The drag clamps against the container
as it is laid out at that moment, so the limits stay honest when the window
changes underneath it.

The divider is focusable: arrows move it by 16px, Home/End drive it to
either limit. Dragging captures the pointer, so it keeps tracking after the
pointer leaves the six pixels it started on, and it keeps the grip where it
was taken rather than jumping to the pointer.

## `Canvas3D`

Moved to [`@react-x11/components/three`](../docs/ecosystem.md) as `<Canvas>`, with
the scene graph it wrapped. Core keeps the `<glarea>` surface underneath it
— see [gl.md](../docs/gl.md) and `examples/viewer3d.jsx`.

## `useAnchor(ref)` / `anchorRect(node, options)`

`placement` is a **preference, not a promise**: a menu near the bottom of
the screen flips above its trigger rather than opening off-screen, and the
result is clamped into the screen either way. The side actually used comes
back as `placement`. Where screen geometry is unavailable it places without
clamping.

`'center'` is no side: the popup goes **over** the anchor, middle on
middle, and is only clamped — `align` and `offset` mean nothing to it. It is
what a dialog is placed with ([`Dialog`](../docs/components.md#size-and-placement)).

`'start'` and `'end'` are the **logical** sides and are what a submenu
wants: it opens away from the edge its parent's rows begin at, which is
leftwards in a mirrored menu, and still flips at the screen edge from there.
`'left'`/`'right'` stay physical. `align` mirrors the same way, but only
when the popup is above or below its trigger — with one beside it the
alignment axis is vertical, and nothing vertical mirrors. The direction is
read off the anchoring node, so a menu inside a mirrored panel needs no
argument.

`alignTo` takes the two axes from **different nodes**: the placement edge
from the anchor, the alignment from `alignTo`. A submenu is the case that
needs it — it belongs against the outer edge of the menu it comes out of,
but level with the row that opened it, and that row is inset by the menu's
border and padding. Both nodes have to be in the same window.

### `at` — anchoring to part of a node

Node-relative rather than screen-relative on purpose: the offset stays true
through everything that moves the node, so `useAnchorTracking` follows a
caret with no extra work — and its out-of-view test becomes the caret's,
which is what you want, since an editor's own lines scroll away long before
the editor does.

### `anchorScreenRect(app, rect, options)` — a rect with no node behind it

The same placement against a rect on the **screen**: the item a tray click
reports, or where the pointer was. `rect` and the answer are logical screen
pixels, `{x, y}` alone is a point, and the popup is kept on the monitor the
rect is on — the one the **whole rect** overlaps most, and the nearest where
it overlaps none, because a tray item's frame starts just outside its own
display. With no node to ask, `options.scale` is the display's — it
defaults to 1 — and `options.direction` decides what `'start'` and `'end'`
mean. A `<popup>` does this itself with
[`anchor={{ rect }}`](../docs/elements.md#a-popover-under-a-tray-item).

**A popup that has to measure itself first anchors from the other side.**
Rows sized to their labels, a menu as wide as its widest item: the size is
not known until the popup's content is laid out, and by then React has
already rendered. `<popup anchor={{ to: ref, at }}>` hands the placement to
the popup, which does it in the one place the size is known —
[elements.md](../docs/elements.md#anchor--a-popup-that-places-itself).

### `anchorArea(node)`

The rect a popup anchored to `node` may be placed in: the usable part of the
monitor that node is on — per-monitor, `_NET_WORKAREA` taken off it, the
same answer [`<window width="auto">`](../docs/elements.md#natural-size) is capped
by. `null` where there is no display to ask.

What needs it is a surface sizing itself: a menu measured to its longest
label is never usefully wider than the screen it opens on, and `anchorRect`
can slide a popup back from an edge but nothing rescues one that does not
fit. `Select` and `ContextMenu` both cap themselves this way.

---

The `Select` source (`src/components/Select.js`) is the reference for building
your own: hover/focus state with `useState`, a `<popup>` for anything that
must escape the window bounds, and a ref to the trigger node for anchoring
(`node.abs` + `node.root.window.x/y`).

The window's screen position comes from the server (`TranslateCoordinates`),
refreshed when the window is realized and whenever it is configured — not
from `window.x`/`y`. Once a reparenting window manager has put the window
inside its frame, those are relative to the _frame_, and a popup placed with
them lands near the corner of the screen instead of under its trigger.
