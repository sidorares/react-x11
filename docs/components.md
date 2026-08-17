# Components

Every component takes **`style`** and merges it after its own, so an override
wins by position rather than by clobbering a computed value:

```jsx
<Button
  label="Sign"
  style={{ marginTop: 8, ':hover': { borderColor: '#333' } }}
/>
```

Props that a component consumes itself are never style — `ProgressBar`'s
`color`, `Dialog`'s `width`/`height` (a dialog is a real popup window and
needs its geometry up front), `ContextMenu`'s `fontSize` (it measures labels
with it). Everything else is forwarded to the host box. See
[styling.md](styling.md).

Widget components are plain React built on the host elements — no
reconciler support involved. They live in the package root export.

All of them are screen-reader ready: roles, names, states and AT-driven
control come built in, and an `aria-label` (or a label child) is the only
thing a widget can need from you — [accessibility.md](accessibility.md)
lists what each one announces.

## Theming

**Widgets follow the desktop with nothing declared** — dark on a dark desktop,
light on a light one, the same way a GTK or Qt app does. See
[system appearance](appearance.md) for how that is worked out and how to pin
or override it.

`<ThemeProvider value={palette}>` gives every widget beneath it a palette,
layered over the scheme in force — so a partial one names what your app
changes and everything else keeps following. It carries **shape as well as
colour** — corner radius, border weight, text size and the padding inside a
control are most of what separates one platform's controls from another's:

| token                                                           |                                      |
| --------------------------------------------------------------- | ------------------------------------ |
| `background` `surface`                                          | the ground, and what is raised on it |
| `text` `textMuted` `border`                                     | ink, secondary ink, edges            |
| `accent` `accentHover` `accentText`                             | primary buttons, checks, fills       |
| `hoverBackground` `hoverText`                                   | selected rows, menu highlights       |
| `surfaceHover` `track` `borderFocus`                            | hover fills, tracks, focus           |
| `danger` `success` `warning` `info` (+`…Text`)                  | what the app says with colour        |
| `accentActive` `surfaceActive` `textMutedActive` `dangerActive` | the pressed step of each fill        |
| `radius` `radiusSmall` `borderWidth`                            | control shape                        |
| `radiusPopup` `radiusPopupItem` `radiusTooltip`                 | floating-surface shape               |
| `fontSize` `paddingX` `paddingY`                                | control size                         |
| `fontFamily` `monoFamily`                                       | the app's two faces                  |
| `direction`                                                     | which way the app reads              |

### The ground and what is on it

`background` is what the **window** is — the fill under everything, painted
by the window itself. `surface` is what is raised off it: a control's fill, a
card, the sheet a menu or a dialog is drawn on. The light palette makes them
the same colour, because a white app on a white ground is what it has always
been; the dark one lifts `surface` a step, because a card at the ground's own
colour is a card you cannot see.

A palette that has one ground says so by naming one: **`surface` follows
`background` unless you name it**, so a theme that only recolours the app
keeps working and only a design that really raises its cards has a second
token to fill in.

```jsx
<ThemeProvider value={{ background: '#f6f8fa', surface: '#ffffff' }}>
```

`surfaceHover` and `surfaceActive` are that surface's own interaction steps,
which is what they have always been — before there was a `surface` to be the
steps of.

### What the app says with colour

`danger`, `success`, `warning` and `info` are the four things a screen has to
be able to say: this failed, this worked, look at this, here is a note. They
are what an alert, a badge, a validation message and a toast are coloured
from, and having them as tokens is what keeps a hard-coded `#e74c3c` — which
is a bruise on a dark desktop — out of application code.

Each works as **ink as well as fill**: every one clears 4.5:1 against its own
palette's ground, so the message under a field and the badge beside it are one
token.

```jsx
<text style={{ color: '$danger' }}>Password too short</text>
<box style={{ backgroundColor: '$danger' }}>
  <text style={{ color: '$dangerText' }}>Delete</text>
</box>
```

For the tinted panel an alert usually wants — a wash of the colour rather
than the colour — tint the fill and leave the ink alone:

```jsx
import { tint } from 'react-x11/style';
<box style={{ backgroundColor: tint(theme.danger, 0.12) }}>
  <text style={{ color: '$danger' }}>Could not save</text>
</box>;
```

Only `danger` has `…Hover` and `…Active`, because a destructive button is the
only status fill anyone presses; the other three are things the app says, not
things the user clicks.

The `…Text` four are the letters on a status fill, and **a palette almost
never sets them**: each is derived from the fill it goes on, as the more
legible of that palette's own `text` and `background`. So a theme whose
`warning` is a yellow gets dark letters on it without having thought about
it — and the same rule fixes `accentText`, which used to be inherited as
white onto accents that could not carry white.

`fontFamily` and `fontSize` are the type this app sets, and text that names
neither **takes them** — a `<text>`, a `<textinput>`, a widget's own label. So
`<ThemeProvider value={{ fontFamily: 'Inter', fontSize: 16 }}>` is where an app
says what it is set in, once, rather than on every label, and a `Select`'s rows
grow with it because a row is its label with even space all round. A `fontSize`
or `fontFamily` in a style still wins, the way a style property always wins
over what a node inherits.

The widgets that take a size of their own keep taking it: `MenuBar` and
`ContextMenu` have a `fontSize` prop because they measure their labels before
they have anywhere to measure them in, and `Table` has `rowHeight` because
every row has to be the same height for it to skip the ones off screen.

Both are CSS-style family lists — `'"JetBrains Mono", monospace'` names a
preference and a fallback.

`monoFamily` is the second face, and nothing unstyled reads it: it is there so
that every code surface in an app — a listing, a log pane, a hex dump, all
written by different components — can say `fontFamily: '$monoFamily'` and be
set from one place.

### Which way it reads

`direction` is `'ltr'` or `'rtl'`, and it is **seeded from the locale**: an
app started under an RTL locale is mirrored without being configured, the
way a GTK or Qt one is. Set it here to mirror a whole UI from one place:

```jsx
<ThemeProvider value={{ direction: settings.rtl ? 'rtl' : 'ltr' }}>
```

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
| `Tree`                    | the indent, the twisty, and which arrow opens       |
| `Table`                   | column resizing, the sort mark, the header's scroll |
| `SplitPane`               | which pane is first, the drag and its arrows        |
| `MenuBar` / `ContextMenu` | submenus open to the start side, and their arrows   |
| `Calendar` / `DatePicker` | a week runs the other way, and so do Left/Right     |
| `Select`, `PasswordInput` | the field's own insets follow the text              |

`<textinput>` and `<textarea>` are the gap: they shape and draw bidi text
correctly, but the field's own origin and caret scrolling are still
left-to-right.

See [styling.md](styling.md#direction-and-the-logical-edges) for the style
property and the logical edges.

`paddingY` is the space **you can see** — above the capitals and below the
baseline — not the space plus whatever the font's ascent left over: every
widget label is trimmed to its letters
([styling.md](styling.md#measuring-text-to-its-letters)), so a control is its
label band plus this twice. That makes it a larger number than the same look
would need in CSS, and it makes it mean the same thing in every typeface.
Rows on a popup follow the same rule — a menu row and a `Select` option are
their label with `padding` all round, so the space above a row's text is the
space beside it. So does `<textinput>`, which is what keeps a field the same
height as the `Button` and the `Select` next to it on a form; give it
`paddingY` and the three agree by construction
([styling.md](styling.md#measuring-text-to-its-letters)).

The `…Active` four are the colour a control takes **while it is held**, and
a palette almost never sets them: each is derived from the step the palette's
own hover already makes — `accent` → `accentHover` → one more of the same —
so it darkens a light theme and lightens a dark one. Set one explicitly and
it wins. See [The press state](#the-press-state) for why every control has
one.

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
(`'@supports transparency'`, [styling.md](styling.md)) and stay square
where the answer is no.

There are two consumers of a palette, and one provider feeds both. Widgets
read it as React context through `useTheme()`; a `$token` in a style
resolves against the nearest `theme` **prop** in the node tree, which knows
nothing about React ([styling.md](styling.md#theme-tokens)). `ThemeProvider`
puts the merged palette on the context _and_ plants it in the tree, so

```jsx
<ThemeProvider value={dark}>
  <box style={{ backgroundColor: '$background' }}>…</box>
</ThemeProvider>
```

paints the palette rather than nothing. Nesting works the same either way:
an inner provider merges over the outer, as an inner `theme` prop does.

`useTheme()` returns the palette in force — complete, whatever the provider
above set — and is the same object token resolution sees:

```jsx
function Panel() {
  const theme = useTheme();
  return <box style={{ borderColor: theme.border }} />;
}
```

It is a bag of tokens, and indexes like one: a component that resolves a name
it was handed rather than one it wrote — a code block reading its own colour
map, a renderer resolving `$token` itself — writes `theme[name]` with no cast.
The named tokens keep their types, anything else is `unknown` and narrows.
What a provider _accepts_ stays closed (`Partial<Theme>`), because a typo in a
palette has nowhere else to be caught.

The palette reaches the tree on a `<box>` the provider renders, styled
`{ flexGrow: 1 }` so an app-level provider fills its parent; pass `style` to
change that (`style={{ flexGrow: 0 }}` around a single control). A `<window>`
may not sit inside a box, so a provider above one plants the prop on the
window itself and renders no box.

Widgets plant the merged palette on their own root node too, so a `$token`
in a style you pass one resolves even with no provider anywhere.

`examples/themes.js` has three worked palettes — GitHub, macOS and Windows,
each in light and dark — and `npm run examples:theming` switches between
them at runtime.

## System icons

The glyphs the widgets here are drawn with, exported so an application and a
third-party widget can use the same ones — a toolbar you write and a `Select`
you did not should not disagree about which way a chevron points.

```jsx
import { Icon } from 'react-x11';

<Icon name="chevronDown" />
<Icon name="check" size={10} color={theme.accentText} />
```

| name                                                   |                                      |
| ------------------------------------------------------ | ------------------------------------ |
| `chevronRight` `chevronLeft` `chevronDown` `chevronUp` | more this way: menus, twisties, sort |
| `check` `dash` `dot`                                   | chosen, partly chosen, one of many   |
| `close` `plus` `moreVertical`                          | dismiss, add, overflow               |
| `eye` `eyeOff`                                         | reveal a secret, hide it again       |

| prop    |                                                       |
| ------- | ----------------------------------------------------- |
| `name`  | one of the above; anything else throws                |
| `size`  | the mark, px. Default: a shade under `theme.fontSize` |
| `color` | the ink. Default: `theme.text`                        |

Everything else goes to the host `<canvas>`, so a clickable one is
`<Icon name="close" onClick={…} focusable />`.

**`size` is the mark, not a grid it sits in.** This is the one place the set
departs from how lucide and its descendants are drawn: theirs put about 14px
of ink in a 24px box, so you reach for `size={20}` next to 14px text. Here
the ink runs corner to corner, so `size` is what you actually see and the
number to pick is the number you want — the `Select` chevron is
`capBand(fontSize)` because it should be as wide as the capitals beside it.

A chevron is the one glyph whose two axes differ: the arms are at 45°, so it
is as long as `size` along the way it points across and half that the other
way. `<Icon name="chevronDown" size={10} />` is 10 wide and 5 tall; the same
size of `chevronRight` is 5 wide and 10 tall.

### Affordances, not nouns

The set holds glyphs that say something about **the control**: there is more
here, this one is chosen, this closes, this is hidden. It holds no nouns —
no folder, no document, no save, no printer. Those belong to an icon theme
(lucide, an XDG icon theme, your own art), they are unbounded in number, and
a widget set that starts shipping them has taken on a design system.

That is also the answer to "why is X missing": if X names a thing rather
than an action the control affords, it is not going to be here. Bringing
your own set is expected and supported — a `<svg>` or a `<canvas>` goes
anywhere an `<Icon>` does, and `ContextMenu`'s `icon` takes either.

The **drawings are not themable** for the same reason: the geometry is the
widget set's vocabulary, and an application that wants a different chevron
wants an icon library. Colour and size are yours; the shape is not.

### Colour inherits; size does not

`color` travels down the tree
([styling.md](styling.md#inheritance-the-ink-the-face-and-the-size)), so an
icon takes the ink of whatever it is written inside and needs nothing said
at the call site:

```jsx
<box style={{ color: theme.textMuted, ':hover': { color: theme.accent } }}>
  <text>Open recent</text>
  <Icon name="chevronRight" />
</box>
```

That covers the hover case too. `:hover` marks the row, `color` is
inherited, and the label and the icon both follow — which is why `Tree`'s
twisty and `ContextMenu`'s submenu chevron carry no colour of their own any
more. The `color` prop is for saying something the surrounding text does
not: a destructive action's mark, or a check drawn on an accent fill.

**`size` does not inherit, and is deliberately not `fontSize`.** A glyph is
a drawing rather than a letter — no baseline to sit on, no ascent to be
measured against — so it takes its default from the palette's `fontSize` and
stays put when a label beside it shrinks. Pass `size` for the one icon that
has to be bigger.

### What it costs to draw one

Each glyph is a drawing over `<canvas mono>`
([elements.md](elements.md#canvas)), which is a promise that everything it
paints is one colour it did not choose — so one drawing serves every state a
control puts it in, and the paint cache can keep one rendered copy of
`chevronDown` at 12px for every twisty in a `Tree` at once.

The entry is **coverage**, so the colour is applied at composite time and
stays out of the key: one rendered copy of `chevronDown` at 12px serves the
resting row, the highlighted row, the disabled one and both colour schemes —
the trick the glyph cache runs on text, and the one `<svg>` gets for a
`fill="currentColor"` document. The size cannot leave the key, since a
coverage surface is pixels at a fixed size, so one icon at two sizes is two
entries.

The drawings are module-level, so re-rendering a `Tree` invalidates none of
its twisties: `<canvas>` compares `onDraw` by identity, and a fresh closure
per render is a repaint per glyph.

`icons` is the map of raw drawings, for a widget that wants the glyph
without the component:

```jsx
import { icons } from 'react-x11';

<canvas
  mono
  cacheKey="check"
  onDraw={icons.check}
  style={{ width: 12, height: 12, color: '$textMuted' }}
/>;
```

They are **decoration by default** — `aria-hidden`, because the meaning is
already on the control, in its `role` and its `aria-expanded`. Name one
(`aria-hidden={false} aria-label="Close"`) only when the icon _is_ the
control and nothing else says so.

## Basic controls

`Button`, `Checkbox`, `Radio`/`RadioGroup`, `Switch` and `ProgressBar` share
one piece of plumbing, `useControl(disabled, onActivate)`: it makes the
control focusable, activates it on click — and so on Space and Enter, which
are a click on anything with an `onClick`
([events.md](events.md#space-and-enter-are-a-click)), the widgets having no
key mapping of their own any more — sets the pointer cursor, and expresses
hover, press and focus
feedback as `:hover`/`:active`/`:focus` style blocks rather than React state
— so moving the pointer over a control repaints one node instead of
rendering.

`Button`, `Checkbox`, `Switch` and `ProgressBar` take `style`, merged after
their own so an override wins by position, and forward any remaining props
to the host box. `Radio` is the exception: it takes only the props listed
below, and the group around it carries the layout.

```jsx
import { Button, Checkbox, RadioGroup, Radio, Switch, ProgressBar } from 'react-x11';

<Button primary onPress={save}>
  Save
</Button>
<Checkbox checked={wrap} onChange={(ev) => setWrap(ev.value)}>Wrap lines</Checkbox>
<Switch checked={live} onChange={(ev) => setLive(ev.value)} />
<ProgressBar value={0.4} style={{ width: 200 }} />

<RadioGroup value={size} onChange={(ev) => setSize(ev.value)}>
  <Radio value="s">Small</Radio>
  <Radio value="m">Medium</Radio>
</RadioGroup>;
```

Label text is the children (or a `label` prop); a bare string is wrapped in
a `<text>` for you, so `<Button>Save</Button>` needs no `<text>`.

### The press state

Every control here activates on the **release** — that is what a click is.
So every one of them also has a distinct look while it is being _held_,
because otherwise a click a user takes half a second over is half a second
of a control that has visibly not heard them, and the change, when it comes,
reads as the machine being slow rather than the hand being unhurried.

Four states, all different: resting, hovered, held, and hovered again on the
release. The held one is drawn on the press **even though the press itself
does nothing** — it acknowledges the input, it does not promise the outcome.
A press dragged off the control drops it, and picking the control back up
restores it, so the way it looks always agrees with whether releasing there
would activate anything.

Nothing is needed to get this: it is what the widgets do. Writing a control
of your own, `:active` is the state block for it —
[styling.md](styling.md#inline-pseudo-states) — and the palette's
`accentActive`/`surfaceActive`/`textMutedActive`/`dangerActive` are the
colours.

### The change event, and `name`

Every value control — `Checkbox`, `Switch`, `RadioGroup`, `Select`,
`Slider` — calls `onChange(ev)` with a change event, the **same signature**
`<textinput>` and `<textarea>` use
([elements.md](elements.md#the-change-event)). The new value is `ev.value`:

```jsx
<Checkbox checked={agreed} onChange={(ev) => setAgreed(ev.value)}>
  I agree
</Checkbox>
```

```js
{ type: 'change',
  target: { type: 'checkbox', name: 'agree', value: true, checked: true },
  currentTarget: /* the same object */,
  name: 'agree', value: true }
```

One signature is the point. It is what lets a form library's handler be
passed straight to any control in the library, with no per-widget adapter:

```jsx
<textinput name="host" value={f.values.host} onChange={f.handleChange} />
<Checkbox  name="agree" checked={f.values.agree} onChange={f.handleChange} />
```

`target` is a plain descriptor rather than a node, and that is the one place
this differs from the host elements: a widget is several nodes with no single
element holding its value, so there is nothing honest to point at. Its shape
is what formik's `handleChange` and react-hook-form's event reader
destructure — `target.type` is how they tell a checkbox from a text field,
which is why it is set even though nothing in react-x11 reads it. There is no
`preventDefault`: the value has already changed by the time the handler runs.

**The line is `name`.** A widget that takes one is a form field and reports
an event. `Tabs`, `Tree`, `Table` and the menus are not form fields — you
would never register a tab strip with formik — and keep their plain callbacks
(`Tabs` calls `onChange(id)`).

`name` is otherwise inert; it exists so a form library has somewhere to put
one. See [docs/ecosystem/forms.md](ecosystem/forms.md).

### `Button`

| prop                 |                                           |
| -------------------- | ----------------------------------------- |
| `children` / `label` | the label                                 |
| `onPress()`          | click, Space or Enter                     |
| `primary`            | accent fill instead of the surface colour |
| `disabled`           | inert, dimmed, not focusable              |

### `Checkbox`

| prop                 |                                           |
| -------------------- | ----------------------------------------- |
| `checked`            | current value (controlled)                |
| `onChange(ev)`       | a change event; the value is `ev.value`   |
| `name`               | field name, for form libraries            |
| `children` / `label` | label to the right of the 16px check well |
| `disabled`           | inert, dimmed                             |

### `Radio` / `RadioGroup`

`RadioGroup` takes `value`, `onChange(ev)`, `name`, `style` and any
box props; each `Radio` takes the `value` it selects, plus `children`/`label`
and `disabled` — and nothing else, so per-radio styling goes on the group. A
`Radio` outside a `RadioGroup` throws rather than silently doing nothing.
`name` lives on the group the way it does in HTML: the group is the field.

Arrow keys move the selection through the group in **mount order**,
wrapping — Up/Left back, Down/Right forward — which is how a native radio
group behaves; click or Space selects the focused one.

### `Switch`

`checked`, `onChange(ev)`, `name` and `disabled`, the same semantics
as `Checkbox` in a sliding pill. The thumb is absolutely positioned and
animates on `left` (`transition: { left: 120 }`) because `justifyContent`
would flip between the ends with nothing in between to animate — the worked
example in [styling.md](styling.md#transitions).

### `ProgressBar`

Determinate progress only.

| prop         |                                                        |
| ------------ | ------------------------------------------------------ |
| `value`      | 0 to 1, clamped                                        |
| `color`      | fill colour (defaults to the theme accent)             |
| `trackColor` | the groove (defaults to the theme track)               |
| `height`     | bar thickness, default 8; the corner radius follows it |

The fill is expressed as flex ratios rather than a percentage width. A
percentage child resolves against space that is still being measured, which
fed back into the track's intrinsic width — a card with a fuller bar came
out wider than one with an empty bar.

## `Select`

A dropdown whose menu is a real override-redirect `<popup>` window anchored
below the trigger.

```jsx
import { Select } from 'react-x11';

<Select
  style={{ width: 160 }}
  value={color}
  options={[
    { value: '#2980b9', label: 'Blue' },
    { value: '#c0392b', label: 'Red' },
    'green', // shorthand: value === label
  ]}
  onChange={(ev) => setColor(ev.value)}
  placeholder="Pick a color…"
/>;
```

| prop                    |                                           |
| ----------------------- | ----------------------------------------- |
| `options`               | array of `{value, label}` or plain values |
| `value`, `onChange(ev)` | selection                                 |
| `name`                  | field name, for form libraries            |
| `placeholder`           | trigger text when nothing is selected     |
| `style` + any box props | forwarded to the trigger box              |

Behavior: the menu opens on the **press** — Space and Enter toggle it too;
Escape, focus loss, or picking closes it; the option list scrolls when taller
than 220px; the trigger participates in Tab traversal.

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

**Type-ahead.** Typing letters jumps to the matching option: with the menu
open it moves the highlight, and with it closed it changes the value
outright, the way a native select does. Keystrokes within 700ms accumulate
into one query (`b`,`l` finds _blueberry_, not _banana_); repeating a
single letter cycles through the options starting with it.

### Theming

`Select` has no provider of its own — it reads the palette from
[`ThemeProvider`](#theming) like every other widget. The trigger is
`background`/`text` in a `border` box that turns `borderFocus` on focus or
while open, the chevron and the placeholder text are `textMuted`, and the menu
highlight is `hoverBackground`/`hoverText`.

## `Calendar` / `DatePicker`

A month grid — one date or a range, with any day blockable. `Calendar` is the
grid on its own; `DatePicker` hangs the same grid off a field, on a real
`<popup>` window, and every calendar prop passes straight through it.

```jsx
<DatePicker value={day} onChange={(ev) => setDay(ev.value)} />

<Calendar
  mode="range"
  value={stay}
  onChange={(ev) => setStay(ev.value)}
  min="2026-08-01"
  isDateBlocked={(day) => booked.has(day)}
/>
```

| prop                                      |                                                         |
| ----------------------------------------- | ------------------------------------------------------- |
| `mode`                                    | `'single'` (default) or `'range'`                       |
| `value` / `defaultValue`                  | a day, or `{ start, end }` in range mode                |
| `onChange(ev)`                            | `ev.value` is the new selection                         |
| `min` / `max`                             | the bounds; days outside them are blocked               |
| `isDateBlocked(day, parts)`               | everything the bounds cannot say                        |
| `spanBlocked`                             | let a range run **across** blocked days                 |
| `dayContent(day, state)`                  | drawn under the number — the seam for per-day marks     |
| `month` / `defaultMonth`                  | visible month, `'2026-08'`; reported by `onMonthChange` |
| `locale` / `weekStartsOn`                 | month and weekday names; which day a week starts on     |
| `format(value)` _(DatePicker)_            | the trigger's label                                     |
| `placeholder` / `disabled` _(DatePicker)_ | an empty field, and one that does not open              |

### A day is a string

`'2026-08-07'`, in and out — not a `Date`. A square on a wall calendar is not
an instant: it has no time, no zone and no length that survives a DST
boundary, so two `Date`s for "the 7th" are only equal if both were built the
same way (`new Date(2026, 7, 7)` and `new Date('2026-08-07')` are eleven hours
apart in Sydney, and neither is wrong). As a string, `a === b` is "the same
day", `a < b` is "earlier", it is a `Set` key with no codec, and it is already
the shape a calendar API answers in.

A `Date` is accepted anywhere a day is taken and read as its **local**
calendar day — the day you were looking at when you built it. Anything else
throws, and so does a date that does not exist: `'2026-02-30'` is a typo, and
sliding it quietly to March 2nd the way `new Date()` does is how a booking
ends up a day out.

### Blocking days

`min`/`max` for the bounds, `isDateBlocked(day, parts)` for the rest. `parts`
is `{ year, month, day, weekday, date }`, so the common cases do not parse the
string back apart:

```jsx
<Calendar
  min={today}
  isDateBlocked={(day, { weekday }) =>
    weekday === 0 || weekday === 6 || holidays.has(day)
  }
/>
```

A blocked day is dimmed, is not clickable, and cannot be reached by Enter —
but the keyboard still **moves through** it, so a blocked week is not a wall
the arrows cannot cross.

**A range may not contain a blocked day.** The preview stops at the first one
and an end past it is refused, because an app that blocked a date did not mean
"unless it is in the middle", and a selection that quietly included it would
have to be validated all over again on the way out. `spanBlocked` is the other
reading — only the two ends must be free — for the holidays a stay is allowed
to run across.

### Picking a range

The first click sets the start and reports `{ start, end: null }`; the second
completes it. Reporting the half-picked state is what lets a controlled
picker drive the whole interaction from its own value — there is no hidden
"pending" state to get out of step with — and it is what a form shows while it
waits for the other end. Clicking **before** the start re-anchors rather than
selecting backwards, and the pointer previews the end it would land on.

### Marking days

`dayContent(day, state)` renders inside the cell, under the number, in a strip
the grid reserves only when the prop is there. `state` is
`{ selected, inRange, blocked, outside, today, focused, color }`, and `color`
is what the number itself is being drawn in — a marker that follows it stays
legible on the filled ends of a range.

```jsx
<Calendar
  dayContent={(day, state) =>
    events.has(day) && (
      <box
        style={{
          width: 4,
          height: 4,
          borderRadius: 2,
          backgroundColor: state.color,
        }}
      />
    )
  }
/>
```

### Keyboard

The grid is a **single tab stop**. Arrows move by a day and by a week,
Home/End go to the ends of the week, PageUp/PageDown change month — with
Shift, year — and Enter or Space takes the day under the cursor. Moving off
the edge of the month turns the page, and so does clicking one of the
neighbouring days the grid's corners are filled with.

A `DatePicker` opens on Down, Up, Enter or Space, and its **trigger keeps the
keyboard** while the calendar is up: a `<popup>` is override-redirect and
never takes focus, so the trigger feeds the grid its keys through the
`handleKey` on its ref and keeps Escape and Tab for itself. That ref is
public — `useRef<CalendarHandle>` — for anything else that has to drive a
calendar it does not focus.

The calendar opens on the **press**, as `Select`'s menu does: a control whose
whole purpose is to be looked at gains nothing by waiting out the length of
the click. It closes on the pick — on the _second_ end of a range — on Escape,
on a second press of the trigger, and when the window loses focus.

## `PasswordInput`

A masked field whose mask is a **scribble**, not a row of bullets.

```jsx
<PasswordInput
  value={secret}
  onChange={(ev) => setSecret(ev.value)}
  onSubmit={() => signIn()}
/>
```

| prop                          |                                        |
| ----------------------------- | -------------------------------------- |
| `value` / `defaultValue`      | the secret; controlled with `onChange` |
| `onChange(ev)`                | `ev.value` is the new value            |
| `onSubmit(value)`             | Enter                                  |
| `placeholder`                 | shown while empty (`'Password'`)       |
| `revealable`                  | show the eye at all, default `true`    |
| `revealed` / `onRevealChange` | drive the reveal yourself              |
| `maxLength`                   | in code points                         |
| `drawMask(ctx, info)`         | draw the mask yourself                 |
| `disabled`                    | not focusable, not editable            |

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
[`sensitive`](elements.md#sensitive) so its menu has no Cut or Copy, and
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

### Drawing your own mask

`drawMask(ctx, info)` replaces the scribble entirely; `info` is
`{ width, height, seed, color, length }`, where `width` is the mask width the
field worked out and `seed` is the value-and-window seed. The scribble itself
is `strokeScribble` in `src/components/scribble.js`, which is worth reading
before replacing it — the reasoning for each number is there.

```jsx
<PasswordInput
  drawMask={(ctx, { width, height, color }) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, height / 2 - 1, width, 2);
  }}
/>
```

### Password managers

Paste and typing are the two seams that reach a field on this desktop, and
both work here: XTEST auto-type arrives as ordinary key events, and Ctrl+V
takes a secret from the clipboard with control characters stripped so a
manager's trailing newline stays out of it. Which manager does what, what the
window title has to do with it, and the seams that are _not_ a field —
Secret Service, the sandbox portal, AT-SPI — are in
[desktop.md](desktop.md#password-fields-and-password-managers).

## `Slider`

A draggable value control.

```jsx
import { Slider } from 'react-x11';

<Slider
  value={volume}
  min={0}
  max={100}
  step={5}
  style={{ width: 200 }}
  onChange={(ev) => setVolume(ev.value)}
/>;
```

| prop                    |                                                         |
| ----------------------- | ------------------------------------------------------- |
| `value`, `onChange(ev)` | current value (controlled)                              |
| `name`                  | field name, for form libraries                          |
| `min`, `max`, `step`    | range and quantisation (defaults 0, 100, 1)             |
| `height`                | the bar thickness (default 4); width comes from `style` |
| `disabled`              | inert, dimmed                                           |

Dragging uses [pointer capture](events.md#pointer-capture): the press
captures, so the thumb keeps following a pointer that has wandered far
outside the widget, and releasing out there still ends the drag.

Keyboard: arrows step, `Home`/`End` jump to the ends, `PageUp`/`PageDown`
move by ten steps.

The thumb is centred on its value, so the usable travel is the track width
minus one thumb width — otherwise `min` and `max` would be unreachable.

## `Tooltip`

A hover hint in a `<popup>`, so it can extend past the owner window.

```jsx
import { Tooltip } from 'react-x11';

<Tooltip label="Back to zero">
  <Button onPress={reset}>Reset</Button>
</Tooltip>;
```

| prop              |                                                              |
| ----------------- | ------------------------------------------------------------ |
| `label`           | the hint: a string, or an element (nothing shows without it) |
| `direction`       | `'auto'` (default), `'top'`, `'bottom'`, `'left'`, `'right'` |
| `delay`           | ms of hover before showing (default 500)                     |
| `fontSize`        | label size, also used to size the popup                      |
| `width`, `height` | the bubble's size — required for an element `label`          |

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
**element** is the same problem without a way to measure, so the caller
gives `width`/`height` — and then gets the bubble to fill, with no padding
imposed on it:

```jsx
<Tooltip
  label={
    <box style={{ flexGrow: 1, padding: 10, gap: 7 }}>
      <text style={{ color: '#f5f6fa' }}>Scratch volume</text>
      <ProgressBar value={used} />
    </box>
  }
  width={200}
  height={82}
  direction="right"
>
  <box>…</box>
</Tooltip>
```

Anything renders in there, widgets included — it is a real tree in a real
window, not a rich-text label. `examples/tooltips.jsx` has both kinds.

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

A dialog in a `<popup>`, centred over the owner window — and one the
**window manager knows is a dialog**: it is a managed window with
`WM_TRANSIENT_FOR` pointing at its owner, so it is framed, movable, closable
through the WM, out of the taskbar and alt-tab list, and (on a full EWMH
window manager) stacked above its owner and iconified with it.

```jsx
import { Button, Dialog } from 'react-x11';

<Dialog
  open={confirming}
  title="Clear the form?"
  onClose={() => setConfirming(false)}
  actions={
    <>
      <Button label="Cancel" onPress={() => setConfirming(false)} />
      <Button primary autoFocus label="Clear" onPress={clear} />
    </>
  }
>
  The name and the greeting below it will be discarded.
</Dialog>;
```

| prop              |                                                              |
| ----------------- | ------------------------------------------------------------ |
| `open`            | renders nothing when false; the popup exists only while true |
| `title`           | bold heading (optional)                                      |
| `children`        | body content; strings become `<text>`                        |
| `actions`         | elements for the right-aligned button row                    |
| `onClose`         | Escape, or the window manager's close button                 |
| `managed`         | `false` for the override-redirect popup 1.x shipped (below)  |
| `width`, `height` | popup size (default 360×170)                                 |

The focus behaviour is the **renderer's**, not the component's: `trapFocus`
keeps Tab inside the dialog, stops presses elsewhere from moving focus, and
hands focus back to whatever had it — usually the button that opened the
dialog — when it closes. See
[Focus scopes](events.md#focus-scopes-modals). Put `autoFocus` on a control
inside to pick the first stop; with nothing to focus, the dialog surface
takes focus itself (`tabIndex={-1}`) so Escape and Tab work immediately.

Escape closes because keys go to the focused node inside the popup and
bubble out through the popup's place in the JSX tree; so does the window
manager's close button, through `onCloseRequest`. **Pointer modality is not
enforced** — widgets in the owner window stay clickable behind the dialog —
so it is for confirmations, not for guarding state. (`_NET_WM_STATE_MODAL`
is the mechanism that would enforce it, and it means nothing without the
`WM_TRANSIENT_FOR` this now sets; that is why the property had to come
first.)

### `managed`

| `managed`        | what you get                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true` (default) | a WM-managed window: frame, titlebar, movable, WM close button, transient for its owner, out of the taskbar. A press outside does **not** close it. |
| `false`          | the override-redirect popup: no frame, not movable, a pointer grab, and a press anywhere outside calls `onClose`.                                   |

They are one choice, not two: a client-side pointer grab over a window the
window manager is trying to let the user drag swallows the press that would
start the drag, so `grab` and the frame turn on and off together. A managed
dialog staying open when you click elsewhere is not a regression — it is what
a dialog does. `managed={false}` is the right shape for a transient
confirmation on a display with no window manager at all.

The owner is resolved automatically: `Dialog` already keeps an out-of-flow
`<box>` inside the owner window for placement, and a ref to any drawn node
resolves to the window that owns it
([`transientFor`](elements.md#transientfor--a-window-that-belongs-to-another)).

A `<popup>` is a real X window and needs its size up front, hence explicit
`width`/`height` rather than sizing to content. Placement comes from
`centerRect(node, {width, height})`, exported alongside `anchorRect` for
window-centred popups of your own.

## `MenuBar` / `ContextMenu`

Pull-down and right-click menus, both rendered in `<popup>` windows so they
escape the owner window, both anchored with `useAnchor`.

```jsx
import { MenuBar, ContextMenu } from 'react-x11';

<MenuBar
  menus={[
    {
      label: 'File',
      items: [
        { label: 'New', shortcut: [['Control', 'N']], onSelect: newFile },
        { type: 'separator' },
        { label: 'Save As…', enabled: false },
        {
          label: 'Wrap lines',
          toggleType: 'checkmark',
          toggleState: wrap ? 1 : 0,
          onSelect: toggleWrap,
        },
      ],
    },
  ]}
/>;

<ContextMenu items={items} style={{ flexGrow: 1 }}>
  <text>Right-click me</text>
</ContextMenu>;
```

Item shape: `{ label, onSelect, type, items, enabled, visible, shortcut,
toggleType, toggleState, icon, iconName, disposition, key }`. Both take an
`onSelect(item)` prop as well, fired after the item's own. A bar menu opens on
the **press**, for the reason `Select` does.

**The vocabulary is `com.canonical.dbusmenu`'s**, and that is not incidental.
On a desktop whose panel shows application menus, `MenuBar` hands this array
straight over and stops drawing — no configuration, no second authoring model,
the same line of JSX either way. `type: 'separator'` rather than
`separator: true`, `enabled: false` rather than `disabled: true`,
`toggleType`/`toggleState` rather than a bare `checked`, and `shortcut` as a
list of modifier tokens rather than a display string, all follow from that.
`toggleState` is `0`, `1` or `-1`, the last being indeterminate. See
[globalmenu.md](globalmenu.md), which also covers `globalMenu={false}`.

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

**Icons.** `icon` fills the 16px column left of the label — the same column
a `toggleType` mark uses, so an item that is both checked and iconned shows
the check: the check is state, the icon is only identity. `icon` is drawn by
react-x11 and never crosses the bus; `iconName` is the icon-theme name a
panel uses ([globalmenu.md](globalmenu.md)). One column rather than
two, because a second would indent every label in the menu to reserve room
for icons most items do not have.

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
([elements.md](elements.md#svg)). A [system icon](#system-icons) is already
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

**Submenus.** Give an item its own `items` and it becomes a submenu parent,
marked with a `chevronRight` and opening to the side:

```jsx
{ label: 'Export', items: [
    { label: 'PNG', onSelect: exportPng },
    { label: 'SVG', onSelect: exportSvg },
] }
```

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

**Keyboard.** Up/Down move the active item, **skipping separators and
disabled entries** and wrapping; Home/End jump to the ends; Right opens a
submenu (selecting its first item) and Left leaves one; Enter/Space
activate — or open a submenu, for a parent row; Escape closes **one level
at a time**. In a `MenuBar`, Left/Right walk between menus _when there is
no submenu to move through_, and with one menu open, hovering another
switches to it. Hovering a submenu parent opens it with nothing selected
inside.

**PageUp/PageDown** step ten rows and then settle on the nearest selectable
entry in the direction of travel, so a page never lands on a separator or a
disabled row. Menus size to their content rather than scrolling, so the
stride is fixed — deriving one from the menu height would just equal
Home/End.

**Type-ahead.** Typing letters jumps to the entry whose label starts with
them, in whichever level is deepest open. Keystrokes within 700ms
accumulate into one query, so `c`,`a` finds _Carrot_ rather than jumping to
_Apple_ first; repeating a single letter cycles through the entries
starting with it. Disabled entries and separators are never matched.

Open state is a single path of active indices — one per open level — so
moving the selection at any level truncates the path and closes deeper
levels for free.

Both keep focus on a node in the _owner_ window — the popup is
override-redirect and never takes focus — which is the same arrangement
`Select` uses. `ContextMenu`'s wrapper is focusable for that reason and
takes focus when the menu opens.

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

One panel visible at a time, switched by a strip of tabs.

```jsx
<Tabs
  items={[
    { id: 'general', label: 'General', content: <GeneralPage /> },
    { id: 'advanced', label: 'Advanced', content: () => <AdvancedPage /> },
    { id: 'legacy', label: 'Legacy', disabled: true },
  ]}
/>
```

| prop                     |                                                    |
| ------------------------ | -------------------------------------------------- |
| `items`                  | `{ id, label, content, disabled }[]`               |
| `value` / `defaultValue` | selected id — controlled with `value` + `onChange` |
| `onChange(id)`           | a tab was chosen                                   |
| `orientation`            | `'horizontal'` (default) or `'vertical'`           |
| `manual`                 | arrows move focus only; Enter or Space commits     |

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

A grid with a header that stays put, resizable columns, and only the rows in
view actually built.

```jsx
<Table
  columns={[
    { id: 'name', label: 'Name', width: 220 },
    { id: 'size', label: 'Size', width: 90, align: 'right' },
  ]}
  rows={files}
  onSelect={(id, row) => open(row)}
/>
```

| prop                           |                                                     |
| ------------------------------ | --------------------------------------------------- |
| `columns`                      | `{ id, label, width, align, value, render }[]`      |
| `rows`                         | `{ id, … }[]` — `id` identifies the row             |
| `rowHeight`                    | every row is this tall (24 by default)              |
| `sort` / `defaultSort`         | `{ column, direction }`; reported by `onSortChange` |
| `selected` / `defaultSelected` | selected row id; reported by `onSelect(id, row)`    |
| `onActivate(id, row)`          | a double click, or Enter on the selection           |
| `onColumnResize(id, width)`    | after a header drag                                 |

`value(row)` feeds sorting and the default cell text; `render(row, { selected,
column })` replaces the cell contents entirely.

A `render` is **told when its row is selected**, because the selection is a
filled bar and a colour picked against the resting background disappears
into it — a directory in the accent, a failure in red. Fall back to
`hoverText` there and let the glyph carry the meaning:

```jsx
render: (row, { selected }) => (
  <text style={{ color: selected ? '$hoverText' : statusColour(row) }}>
    {row.state}
  </text>
);
```

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

## `Tree`

A disclosure tree: file browsers, outline panes, property inspectors.

```jsx
<Tree
  items={[{ id: 'src', label: 'src', children: [{ id: 'a', label: 'a.js' }] }]}
  defaultExpanded={['src']}
  onSelect={(id, item) => open(item)}
/>
```

| prop                           |                                                          |
| ------------------------------ | -------------------------------------------------------- |
| `items`                        | `{ id, label, children, disabled }[]`                    |
| `expanded` / `defaultExpanded` | ids of open branches; controlled with `onExpandedChange` |
| `selected` / `defaultSelected` | selected id; controlled with `onSelect`                  |
| `onSelect(id, item)`           | the selection moved                                      |
| `onActivate(id, item)`         | Enter or Space on a row                                  |

An item with a `children` **array** is a branch, even when the array is
empty — that is how an unexpanded directory shows a twisty before its
contents are known. Load lazily by handing back `children: []` and filling
it in when `onExpandedChange` fires.

The twisty is its own hit target: clicking it opens a branch **without**
moving the selection, the way a file browser lets you peek inside a folder
you have not chosen. Clicking the label selects.

The tree is a single tab stop. Up/Down walk the rows that are currently
visible, skipping disabled ones. Right expands a branch and, if it is
already open, steps into it; Left collapses it and, if it is already closed,
steps out to the parent. Home/End jump to the ends, Enter and Space
activate, and typing letters jumps by prefix — the same type-ahead `Select`
and the menus use, so a quick "bu" refines rather than jumping twice. The
tree scrolls the focused row into view as you move.

## `SplitPane`

Two panes with a divider you can drag.

```jsx
<SplitPane direction="row" defaultSize={220} min={120} minSecond={300}>
  <Sidebar />
  <Editor />
</SplitPane>
```

| prop                   |                                                 |
| ---------------------- | ----------------------------------------------- |
| `direction`            | `'row'` (default) or `'column'`                 |
| `size` / `defaultSize` | the **first** pane's width or height, in pixels |
| `onResize(size)`       | after a drag or a key step                      |
| `min` / `minSecond`    | how small either pane may get                   |

Only the first pane's size is stored; the second takes what is left, so a
window resize can never leave a gap. The drag clamps against the container
as it is laid out at that moment, so the limits stay honest when the window
changes underneath it.

The divider is focusable: arrows move it by 16px, Home/End drive it to
either limit. Dragging captures the pointer, so it keeps tracking after the
pointer leaves the six pixels it started on, and it keeps the grip where it
was taken rather than jumping to the pointer.

## `Canvas3D`

The entry point to the [3D scene](elements.md#3d-scene-mesh-group-geometries-materials)
— a thin wrapper over the `<glarea>` host element, named `Canvas3D` rather
than r3f's `Canvas` because react-x11 already has a `<canvas>` element (the
2D `onDraw` escape hatch).

```jsx
import { Canvas3D } from 'react-x11';

<Canvas3D
  style={{ flexGrow: 1 }}
  clearColor="#12161f"
  camera={{ position: [0, 2, 6], fov: 45 }}
>
  <group rotation={[0, angle, 0]}>
    <mesh position={[-1.6, 0, 0]}>
      <boxGeometry args={[1.4, 1.4, 1.4]} />
      <meshBasicMaterial color="#2980b9" />
    </mesh>
    <mesh position={[1.6, 0, 0]}>
      <sphereGeometry args={[0.9, 24, 16]} />
      <meshBasicMaterial color="#e67e22" wireframe />
    </mesh>
  </group>
</Canvas3D>;
```

Takes every `<glarea>` prop (layout props, `clearColor`, `frameLoop`, `glx`,
`onCreated`, `onDraw`, `onError`) plus:

- `camera` — `{ position, target, up, fov, near, far }`, or
  `{ orthographic: true, zoom }`. Defaults to a perspective camera at
  `[0, 0, 5]` looking at the origin with a 50° vertical field of view.
- `fallback` — what to show when this X server cannot give us a GL context.

Animate by changing props from a `requestAnimationFrame` loop on the window
ref (see `examples/three.jsx`) — a scene only redraws when something
changes, unless `frameLoop="always"`.

### When there is no GL

Plan for it. Indirect GLX — the only kind that works over the wire, and so
the only kind react-x11 can use — is **disabled by default** on Xorg ≥ 1.17
and on Xwayland, which is most desktops. A `<Canvas3D>` there has nothing to
draw with, and without a `fallback` it renders an empty box.

```jsx
<Canvas3D
  style={{ flexGrow: 1 }}
  fallback={(err) => <NoGL error={err} />}
>
```

`fallback` takes an element or a function of the error, and is rendered in a
`<box>` carrying the component's `style` — so it holds the same place in the
layout the surface would have. It cannot be `children`: those are the scene
graph. (Same reason `<Suspense fallback>` is a prop.)

The error is classified, so branch on `code` rather than matching the
message:

| `err.code`              |                                                               |
| ----------------------- | ------------------------------------------------------------- |
| `GLX_INDIRECT_DISABLED` | server has GLX but refuses indirect contexts — the common one |
| `GLX_NO_EXTENSION`      | server has no GLX at all                                      |
| `GLX_NO_CONFIG`         | no visual matches the `glx` spec you asked for                |
| `GLX_CONTEXT_FAILED`    | anything else in setup                                        |

`err.hint` is a multi-line explanation of how to get a server that works,
written to be printed as-is. The codes come from ntk and are also available
as `GLXError` from `react-x11/ntk` if you would rather not spell them out.

Setup failure is a property of the connection, not of one surface, so it is
remembered per app: a second `<Canvas3D>` mounting after the first has found
out renders its fallback on the first frame, with no round trip and no
flash of empty box.

To develop against a server that does have it:

```bash
Xwayland :5 +iglx & DISPLAY=:5 npm run examples:three
```

Be warned that on current Linux distros the indirect GL engine behind those
contexts is frequently missing even with `+iglx` — contexts are created and
nothing rasterizes.

**On a modern Linux desktop the better answer is the other backend.** Those
same servers that refuse indirect GLX generally do have DRI3, which is what
direct rendering needs, so a scene that shows the fallback here often just
works with:

```jsx
const root = await createRoot({ glPolicy: 'auto' });
```

That also unlocks `<shaderMaterial>`. See [the two backends](gl.md).

## `useAnchor(ref)` / `anchorRect(node, options)`

The placement math behind `Select` and `Tooltip`, exported for building
your own popup-based widgets.

```jsx
const ref = useRef(null);
const measure = useAnchor(ref);

// screen coordinates for a <popup>, given the size you intend to use
const rect = measure({ placement: 'bottom', align: 'center', width, height });
// -> { x, y, width, height, placement }
```

| option            |                                                                        |
| ----------------- | ---------------------------------------------------------------------- |
| `placement`       | `'bottom'` (default), `'top'`, `'start'`, `'end'`, `'left'`, `'right'` |
| `align`           | `'start'` (default), `'center'`, `'end'` on the cross axis             |
| `offset`          | gap from the anchor in px (default 2)                                  |
| `at`              | a rect **inside** the node to anchor to instead — a caret, a cell      |
| `width`, `height` | size of the popup you are positioning                                  |
| `alignTo`         | node the alignment reads, when it is not the anchor                    |

`placement` is a **preference, not a promise**: a menu near the bottom of
the screen flips above its trigger rather than opening off-screen, and the
result is clamped into the screen either way. The side actually used comes
back as `placement`. Where screen geometry is unavailable it places without
clamping.

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

`at` is a rect in the **anchor node's own coordinates**, and it becomes the
anchor: the side that flips, the edge that aligns, the gap `offset` leaves,
the rect tracking keeps in view. A caret is the case it exists for — a
moving point inside one element — and a table cell, a chart datapoint or a
highlighted span are the same shape.

```jsx
const measure = useAnchor(editorRef);
const rect = measure({
  at: { x: caretX, y: lineTop, width: 1, height: lineHeight },
  placement: 'bottom',
  width: 240,
  height: rows * 22,
});
```

`width` and `height` are optional (`{x, y}` alone is a point), and `width`
on the popup then defaults to the sub-rect's rather than the node's.

Node-relative rather than screen-relative on purpose: the offset stays true
through everything that moves the node, so `useAnchorTracking` follows a
caret with no extra work — and its out-of-view test becomes the caret's,
which is what you want, since an editor's own lines scroll away long before
the editor does.

**A popup that has to measure itself first anchors from the other side.**
Rows sized to their labels, a menu as wide as its widest item: the size is
not known until the popup's content is laid out, and by then React has
already rendered. `<popup anchor={{ to: ref, at }}>` hands the placement to
the popup, which does it in the one place the size is known —
[elements.md](elements.md#anchor--a-popup-that-places-itself).

### `anchorArea(node)`

The rect a popup anchored to `node` may be placed in: the usable part of the
monitor that node is on — per-monitor, `_NET_WORKAREA` taken off it, the
same answer [`<window width="auto">`](elements.md#natural-size) is capped
by. `null` where there is no display to ask.

What needs it is a surface sizing itself: a menu measured to its longest
label is never usefully wider than the screen it opens on, and `anchorRect`
can slide a popup back from an edge but nothing rescues one that does not
fit. `Select` and `ContextMenu` both cap themselves this way.

## `useDropTarget(options)` / `useDragSource(options)`

The render-state layer over the drag-and-drop props, for the cases a
`':drag-over'` or `':dragging'` style block cannot cover — a hint label, a
disabled sibling, a drag preview that follows the pointer.

```jsx
const { dropProps, isOver, isAccepted } = useDropTarget({
  accept: ['files'],
  onDrop: (e) => setFiles(e.files),
});

const { dragProps, isDragging, position } = useDragSource({
  data: { 'text/plain': label },
  actions: ['copy', 'move'],
});
```

Spread `dropProps` / `dragProps` on any drawn element. Both are thin — the
props they return are the same ones you can write by hand — so reach for
them when the render changes, and for the plain props when it does not.
`position` is `{ x, y, accepted }` in screen coordinates while a drag is in
flight, which is what a `<popup dragPreview>` follows. Full reference:
[drag-and-drop.md](drag-and-drop.md).

---

The other components — `Button`, `Checkbox`, `Radio`/`RadioGroup`,
`Switch`, `ProgressBar` — are demoed together in `examples/widgets.jsx`.

The `Select` source (`src/components/Select.js`) is the reference for building
your own: hover/focus state with `useState`, a `<popup>` for anything that
must escape the window bounds, and a ref to the trigger node for anchoring
(`node.abs` + `node.root.window.x/y`).

The window's screen position comes from the server (`TranslateCoordinates`),
refreshed when the window is realized and whenever it is configured — not
from `window.x`/`y`. Once a reparenting window manager has put the window
inside its frame, those are relative to the _frame_, and a popup placed with
them lands near the corner of the screen instead of under its trigger.
