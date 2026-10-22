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
`color`, `Dialog`'s `width`/`height` (its window's size), `ContextMenu`'s
`fontSize` (it measures labels with it). Everything else is forwarded to the
host box. See [styling.md](styling.md).

The widgets are plain React over the host elements, exported from the package
root. All are screen-reader ready: roles, names, states and AT-driven control
are built in, and an `aria-label` (or a label child) is the only thing a
widget can need from you — [accessibility.md](accessibility.md) lists what
each one announces.

## Theming

**Widgets follow the desktop with nothing declared** — dark on a dark desktop,
light on a light one. See [system appearance](appearance.md) for how that is
worked out and how to pin or override it.

`<ThemeProvider value={palette}>` gives every widget beneath it a palette,
layered over the scheme in force, so a partial one names only what your app
changes. It carries **shape as well as colour**:

| token                                                           |                                      |
| --------------------------------------------------------------- | ------------------------------------ |
| `background` `surface`                                          | the ground, and what is raised on it |
| `text` `textMuted` `border`                                     | ink, secondary ink, edges            |
| `accent` `accentHover` `accentText`                             | primary buttons, checks, fills       |
| `hoverBackground` `hoverText`                                   | selected rows, menu highlights       |
| `surfaceHover` `track` `borderFocus`                            | hover fills, tracks, focus           |
| `selection` `caret` `link`                                      | selected text, the caret, links      |
| `danger` `success` `warning` `info` (+`…Text`)                  | what the app says with colour        |
| `accentActive` `surfaceActive` `textMutedActive` `dangerActive` | the pressed step of each fill        |
| `radius` `radiusSmall` `borderWidth`                            | control shape                        |
| `radiusPopup` `radiusPopupItem` `radiusTooltip`                 | floating-surface shape               |
| `fontSize` `paddingX` `paddingY`                                | control size                         |
| `fontFamily` `monoFamily`                                       | the app's two faces                  |
| `direction`                                                     | which way the app reads              |

### The ground and what is on it

`background` is the **window**, the fill under everything. `surface` is what
is raised off it: a control's fill, a card, the sheet of a menu or dialog.
The light palette makes them the same colour; the dark one lifts `surface` a
step. **`surface` follows `background` unless you name it**, so only a design
that really raises its cards has a second token to fill in.
`surfaceHover` and `surfaceActive` are that surface's interaction steps.

```jsx
<ThemeProvider value={{ background: '#f6f8fa', surface: '#ffffff' }}>
```

### What the app says with colour

`danger`, `success`, `warning` and `info` — failed, worked, look at this, a
note — colour alerts, badges, validation messages and toasts, and keep a
hard-coded `#e74c3c` (a bruise on a dark desktop) out of app code. Each
clears 4.5:1 against its palette's ground, so it works as **ink as well as
fill**:

```jsx
<text style={{ color: '$danger' }}>Password too short</text>
<box style={{ backgroundColor: '$danger' }}>
  <text style={{ color: '$dangerText' }}>Delete</text>
</box>
```

For a tinted panel, tint the fill and leave the ink alone:

```jsx
import { tint } from 'react-x11/style';
<box style={{ backgroundColor: tint(theme.danger, 0.12) }}>
  <text style={{ color: '$danger' }}>Could not save</text>
</box>;
```

Only `danger` has `…Hover` and `…Active` — the only status fill anyone
presses. The `…Text` four (and `accentText`) are derived from their fill as
the more legible of the palette's `text` and `background`, so a palette
almost never sets them: a yellow `warning` gets dark letters unasked.

`fontFamily` and `fontSize` are the app's type, and text that names neither
**takes them** — a `<text>`, a `<textinput>`, a widget's label — so
`<ThemeProvider value={{ fontFamily: 'Inter', fontSize: 16 }}>` sets it once,
and a `Select`'s rows grow with it. A style's `fontSize`/`fontFamily` still
wins. Both are CSS-style family lists (`'"JetBrains Mono", monospace'`).
`MenuBar` and `ContextMenu` keep a `fontSize` prop (they measure labels
before they have a window to measure in), and `Table` keeps `rowHeight`
(every row must be the same height to skip the ones off screen).

`monoFamily` is read by nothing unstyled: it is there so every code surface
in an app can say `fontFamily: '$monoFamily'` and be set from one place.

### Which way it reads

`direction` (`'ltr'` or `'rtl'`) is **seeded from the locale**, so an app
started under an RTL locale is mirrored unconfigured. Set it here to mirror a
whole UI:

```jsx
<ThemeProvider value={{ direction: settings.rtl ? 'rtl' : 'ltr' }}>
```

The provider plants the `direction` style property in the node tree, so
boxes **and** widgets mirror together. A bare
`<box style={{ direction: 'rtl' }}>` mirrors only the layout, not the widget
decisions read through `useDirection()` — which way an arrow key steps, a
chevron points or a submenu opens. `Button`, `Checkbox`, `Radio`, `Switch` and
`ProgressBar` need nothing more; the rest mirror one thing each:

| widget                    | what mirrors                                        |
| ------------------------- | --------------------------------------------------- |
| `Slider`                  | the drag, and Left/Right (Up/Down do not)           |
| `Tabs`                    | Left/Right walk the strip the way it is drawn       |
| `Table`                   | column resizing, the sort mark, the header's scroll |
| `SplitPane`               | which pane is first, the drag and its arrows        |
| `MenuBar` / `ContextMenu` | submenus open leftwards, and their arrows           |
| `Select`, `PasswordInput` | the field's own insets follow the text              |

`<textinput>` and `<textarea>` mirror inside too: value, placeholder and caret
sit against the start edge, and the value is shaped at the box's base level
([styling.md](styling.md#inside-an-editable-field)); Left/Right and Home/End
still step through the string, not across the screen. The style property and
logical edges: [styling.md](styling.md#direction-and-the-logical-edges).

### Size and shape

`paddingY` is the space **you can see**, above the capitals and below the
baseline: every widget label is trimmed to its letters
([styling.md](styling.md#measuring-text-to-its-letters)), so a control is its
label band plus `paddingY` twice — a larger number than CSS would need, and
the same in every typeface. Menu rows, `Select` options and `<textinput>`
follow the rule, so a field, a `Button` and a `Select` on one row match in
height.

The `…Active` four are the colour **while held**, derived one step past the
hover (`accent` → `accentHover` → `accentActive`), so a palette rarely sets
them; one that is set wins. See [The press state](#the-press-state).

The popup radii follow the **text size**, not `radius`: `radiusPopup` is half
the body size (7px at 14px), and `radiusPopupItem` (a menu row's highlight)
and `radiusTooltip` (the bubble) step in from it. Naming one pins it.
`radiusPopupItem` is a **ceiling**: a row's corner is `radiusPopup` less the
sheet's border and the row's inset, so the curves stay concentric — round the
sheet to round the highlights. Rounded corners only show where the display
composites (`'@supports transparency'`, [styling.md](styling.md)); elsewhere
the widgets stay square.

### `ThemeProvider` and `useTheme()`

Widgets read the palette as React context through `useTheme()`; a `$token` in
a style resolves against the nearest `theme` **prop** in the node tree
([styling.md](styling.md#theme-tokens)). `ThemeProvider` feeds both, so this
paints the palette, and an inner provider merges over an outer one:

```jsx
<ThemeProvider value={dark}>
  <box style={{ backgroundColor: '$background' }}>…</box>
</ThemeProvider>
```

`useTheme()` returns the complete palette in force — the object token
resolution sees. It indexes like a bag of tokens: `theme[name]` needs no cast;
named tokens keep their types, anything else is `unknown`. What a provider
_accepts_ stays closed (`Partial<Theme>`), so a palette typo is caught.

```jsx
function Panel() {
  const theme = useTheme();
  return <box style={{ borderColor: theme.border }} />;
}
```

**Above the windows**, at the root of the tree, a provider draws nothing and
every window under it takes the palette — background, the fallback type of
unstyled `<text>`, the `$token`s — however the windows arrive (a component
that renders one, a closed window, several, a nested provider):

```jsx
root.render(
  <ThemeProvider value={brand} colorScheme={settings.theme}>
    <App />
  </ThemeProvider>,
);
```

**Inside a window** it is a `<box>` styled `{ flexGrow: 1 }`; pass `style` to
change that (`{ flexGrow: 0 }` around a single control). A nested `<window>`
under a provider written directly in a window takes the palette with it; a
provider deeper inside a `<box>` has no window to hand it to, and the error
says to move it. Widgets plant the palette on their own root node too, so a
`$token` in a style you pass one resolves with no provider at all.

`examples/themes.js` has GitHub, macOS and Windows palettes in light and dark;
`npm run examples:theming` switches between them.

## System icons

The glyphs the widgets are drawn with, exported so your toolbar and a
`Select` agree about which way a chevron points.

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

**`size` is the mark**, ink corner to corner — not a 24px grid with 14px of
ink in it as in lucide-style sets — so pick the size you want to see. A
chevron is the one glyph whose axes differ (45° arms):
`<Icon name="chevronDown" size={10} />` is 10 wide and 5 tall, and
`chevronRight` at the same size is 5 wide and 10 tall.

### Affordances, not nouns

The set holds glyphs about **the control** — more here, chosen, close,
hidden — and no nouns (folder, document, printer). Bring your own icon set:
a `<svg>` or `<canvas>` goes anywhere an `<Icon>` does, and `ContextMenu`'s
`icon` takes either. The platform's own set is
[`<image src={{ symbol }}>`](elements.md#src-symbol---the-platforms-own-icons):
an SF Symbol on macOS, the desktop's icon theme elsewhere, in the text colour.
The drawings are not themable: colour and size are yours, the shape is not.

### Colour inherits; size does not

`color` inherits ([styling.md](styling.md#inheritance-the-ink-the-face-and-the-size)),
so an icon takes the ink it is written inside, hover included; the `color`
prop is for ink the surrounding text does not have (a destructive mark, a
check on an accent fill):

```jsx
<box style={{ color: theme.textMuted, ':hover': { color: theme.accent } }}>
  <text>Open recent</text>
  <Icon name="chevronRight" />
</box>
```

**`size` does not inherit, and is not `fontSize`**: it defaults from the
palette's `fontSize` and stays put when a label beside it shrinks. Pass
`size` for the one icon that must be bigger.

### What it costs to draw one

Each glyph is a module-level drawing over `<canvas mono>`
([elements.md](elements.md#canvas)), cached as coverage and coloured at
composite time, so one copy per glyph and size serves every colour and state.
`icons` is the map of raw drawings, for a widget that wants the glyph without
the component; keep `onDraw` identity-stable as these are, or every render
repaints:

```jsx
import { icons } from 'react-x11';

<canvas
  mono
  cacheKey="check"
  onDraw={icons.check}
  style={{ width: 12, height: 12, color: '$textMuted' }}
/>;
```

Icons are **`aria-hidden` by default** — the meaning is on the control's
`role` and `aria-expanded`. Name one
(`aria-hidden={false} aria-label="Close"`) only when the icon _is_ the
control.

## Basic controls

`Button`, `Checkbox`, `Radio`/`RadioGroup`, `Switch` and `ProgressBar` are
focusable, activate on click — and so on Space and Enter, unless Ctrl, Alt or
Super make it a shortcut ([events.md](events.md#space-and-enter-are-a-click))
— set the pointer cursor, and draw hover, press and focus as
`:hover`/`:active`/`:focus` style blocks, so hovering repaints one node
rather than rendering. All but `Radio` take `style` (merged after their own)
and forward other props to the host box; `Radio` takes only its listed props,
and its group carries the layout.

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
a `<text>` for you. All five are demoed in `examples/widgets.jsx`.

### Native bezels

On the **Cocoa** backend (never X11) `Button`, `Checkbox`, `Radio`, `Switch`,
`Slider` and `Select` wear AppKit's bezels by default; on **win32** all but
`Switch` wear the system's own while the desktop is light, and are drawn in
dark mode. Interaction, focus, keyboard and accessibility stay this
library's. Opt out at three levels:

```jsx
// the app's identity
<ThemeProvider value={{ controls: 'drawn' }}>
  {/* one control */}
  <Button native={false}>Brand</Button>
</ThemeProvider>;

const canGoNative = useSupports('nativeControls'); // what the backend has
```

`controls` (a theme token, since looking native is an app-wide decision) is
`'auto'` (bezels where the backend has them), `'native'` (ask, and hear about
it in development where there are none) or `'drawn'`. Give `native={false}`
to a control that names its own colours in `style` — a system bezel ignores
them.

Under a native bezel, `style` sizes the slot the control _sits in_: a
`<Button>` or `<Select>` keeps AppKit's height, centred, so
`height: 44`, `height: '100%'`, `flexGrow: 1` or a taller neighbour in a
stretching row leave a 22pt control in a 44pt slot, and a press in the slack
does nothing. Drawn controls stretch to the box. A `<Button>` squeezed
narrower than its label wraps it at its words and grows by the lines —
native or drawn (on macOS with AppKit's flexible-height bezel); give the row
`flexWrap: 'wrap'` to move buttons to a second row instead. Design notes:
[macos.md](macos.md#native-controls).

### The press state

Every control activates on the **release**, and looks distinct while
**held** — on the press, though the press does nothing yet — so a slow click
is visibly heard. Four states: resting, hovered, held, hovered again on
release. Dragging off the control drops the held look and coming back
restores it, so the look always says whether releasing there would activate.
For a control of your own, `:active`
([styling.md](styling.md#inline-pseudo-states)) is the state block and
`accentActive`/`surfaceActive`/`textMutedActive`/`dangerActive` the colours.

### The change event, and `name`

Every value control — `Checkbox`, `Switch`, `RadioGroup`, `Select`,
`Slider` — calls `onChange(ev)` with the **same change event**
`<textinput>` and `<textarea>` use
([elements.md](elements.md#the-change-event)); the new value is `ev.value`:

```js
{ type: 'change',
  target: { type: 'checkbox', name: 'agree', value: true, checked: true },
  currentTarget: /* the same object */,
  name: 'agree', value: true }
```

So a form library's handler goes straight onto any control:

```jsx
<textinput name="host" value={f.values.host} onChange={f.handleChange} />
<Checkbox  name="agree" checked={f.values.agree} onChange={f.handleChange} />
```

`target` is a plain descriptor, not a node (a widget has no single node
holding its value), shaped as formik's `handleChange` and react-hook-form
read it — `target.type` tells a checkbox from a text field. There is no
`preventDefault`: the value has already changed.

**The line is `name`**: a widget that takes one is a form field and reports
an event. `Tabs`, `Table` and the menus are not, and keep plain callbacks
(`Tabs` calls `onChange(id)`). `name` is otherwise inert. See
[docs/ecosystem/forms.md](ecosystem/forms.md).

### `Button`

| prop                 |                                                                         |
| -------------------- | ----------------------------------------------------------------------- |
| `children` / `label` | the label                                                               |
| `onPress()`          | click, Space or Enter                                                   |
| `variant`            | `'solid'` (default), `'outline'`, `'ghost'` — the chrome                |
| `size`               | `'medium'` (default) or `'small'` — the compact metric                  |
| `primary`            | speaks in the accent: the fill when solid, the ink and border otherwise |
| `disabled`           | inert, dimmed, not focusable                                            |

`variant` and `primary` compose: `solid` is a fill, `outline` a border,
`ghost` neither (for a `✕` on a chip, or a delete inside a form row); a
dialog footer is `outline` beside `primary`, a toolbar's loudest icon
`primary variant="ghost"`. Every variant keeps the widget states and the
border _width_, so a mixed row lines up. `size="small"` halves the control
padding and follows the palette's `paddingY`, which a hand-set `height`
would not.

A label with too little room wraps at its words, centred, and the button
grows — a too-narrow row squeezes each button to its longest word first. An
**element** child inherits the label's colour in every state, disabled
included:

```jsx
<Button primary disabled={busy} onPress={run}>
  <Icon name="chevronRight" />
  Continue
</Button>

<Button variant="ghost" size="small" aria-label="Remove" onPress={remove}>
  <Icon name="close" />
</Button>
```

### `Checkbox`

| prop                 |                                           |
| -------------------- | ----------------------------------------- |
| `checked`            | current value (controlled)                |
| `onChange(ev)`       | a change event; the value is `ev.value`   |
| `name`               | field name, for form libraries            |
| `children` / `label` | label to the right of the 16px check well |
| `disabled`           | inert, dimmed                             |

### `Radio` / `RadioGroup`

`RadioGroup` takes `value`, `onChange(ev)`, `name`, `style` and any box
props; each `Radio` takes only its `value`, `children`/`label` and
`disabled`, so per-radio styling goes on the group. A `Radio` outside a
`RadioGroup` throws. Arrow keys move the selection in **mount order**,
wrapping (Up/Left back, Down/Right forward); click or Space selects the
focused one.

### `Switch`

`checked`, `onChange(ev)`, `name` and `disabled`, as `Checkbox`, in a
sliding pill (the thumb's `left` transition is the worked example in
[styling.md](styling.md#transitions)).

### `ProgressBar`

Determinate with a `value`, indeterminate without one.

| prop            |                                                         |
| --------------- | ------------------------------------------------------- |
| `value`         | 0 to 1, clamped                                         |
| `indeterminate` | working, extent unknown — a block slides across forever |
| `color`         | fill colour (defaults to the theme accent)              |
| `trackColor`    | the groove (defaults to the theme track)                |
| `height`        | bar thickness, default 8; the corner radius follows it  |

```jsx
<ProgressBar value={0.4} style={{ width: 200 }} />
<ProgressBar indeterminate style={{ width: 200 }} />
```

The indeterminate block is a [style loop](styling.md#loops) on the logical
`start` edge, so it mirrors with the text direction and fits any width; it
reports `aria-busy` **with no value**, telling a screen reader no percentage
is coming. Under
[reduced motion](system.md#usedesktopsettings--how-the-desktop-wants-an-app-to-feel)
it does not move and parks mid-track.

## `Select`

A dropdown whose menu is an override-redirect `<popup>` anchored below the
trigger.

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
| `labelStyle`            | the caption's style, over `text`          |
| `chevronStyle`          | the chevron's style, over `textMuted`     |
| `native`, `nativeMenu`  | the platform's bezel, and its menu        |

`style` restyles the trigger and the two slots what is inside it, keeping the
menu, keyboard, type-ahead and focus ring. A borderless select in a line of
text:

```jsx
<Select
  value={sort}
  options={['Newest', 'Oldest', 'Most replies']}
  onChange={(ev) => setSort(ev.value)}
  style={{
    borderWidth: 0,
    paddingLeft: 0,
    paddingRight: 0,
    backgroundColor: 'transparent',
    ':hover': { backgroundColor: 'transparent' },
  }}
  labelStyle={{ color: theme.accent, fontWeight: 'bold' }}
  chevronStyle={{ color: theme.accent }}
/>
```

The chevron is sized against the caption's numeric `fontSize`;
`chevronStyle={{ display: 'none' }}` drops it. A select with either slot is
drawn even under `controls: 'auto'`. The menu itself is not restyled.

**The menu can be the platform's.** On macOS with `@windowkit/appkit` 0.20 or
later, a select under the native bezel opens a real `NSMenu`: the chosen row
over the trigger and checked, at least the trigger's width, with AppKit's
tracking, type-select and VoiceOver. `nativeMenu` makes that choice alone: it
follows the trigger by default; `true` uses the platform menu under a drawn
trigger too (as a browser does for a styled `<select>`, and as `<Html>`
does), at the caption's size and family when the system has it; `false`
keeps the drawn menu. Elsewhere, or on an older bridge, the menu is drawn. A
platform menu dismisses itself (Escape, a click outside, the app losing
focus), and the select hears a pick or nothing.

**Behaviour.** The menu opens on the **press**, as in every desktop toolkit;
a press while it is up closes it. Space and Enter toggle it; Escape, focus
loss, losing the window (switching applications) or picking close it. The
list scrolls past 220px, is sized to its longest option (rows end in `…`
only on a screen narrower than that), and is drawn as a menu is. The
trigger is a Tab stop, and a caption with no room ends in `…` rather than
wrapping.

Keys go to the focused trigger, menu open or not:

| key                   | closed         | open                                    |
| --------------------- | -------------- | --------------------------------------- |
| `Down` / `Up`         | opens the menu | move the active option, wrapping around |
| `Home` / `End`        | —              | first / last option                     |
| `PageUp` / `PageDown` | —              | a menu's height of options, clamped     |
| `Enter` / `Space`     | opens the menu | pick the active option                  |
| `Escape`              | —              | close without picking                   |

The menu opens with the current value active; hovering an option makes it
active (one highlight for pointer and keyboard), and it is scrolled into view.
**Type-ahead**: letters typed within 700ms form one query (`b`,`l` finds
_blueberry_, not _banana_), and a repeated single letter cycles; with the
menu open this moves the highlight, closed it changes the value, as a native
select does.

### Theming

`Select` reads the palette from [`ThemeProvider`](#theming) like every
widget: the trigger is `background`/`text` in a `border` box that turns
`borderFocus` when focused or open; chevron and placeholder are `textMuted`;
the menu highlight is `hoverBackground`/`hoverText`.

## `Calendar` / `DatePicker`

Moved to [`@react-x11/components`](ecosystem.md): a date picker is a locale
problem before it is a widget.

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

Bullets show how many characters were typed and barely show the keystroke
that just landed. The scribble is the reverse: **the whole stroke changes on
every character**, nothing in it is per-character, and its width only grows
(never twitching when a character is replaced, never a clean multiple of
anything). **It hides a glance, not a recording**: someone watching it grow
still counts keystrokes. Design notes:
[design/components.md](../design/components.md#why-a-scribble).

### Two states, and what holds across both

**Masked**: type, Backspace, Ctrl+Backspace / Ctrl+U / Delete to clear,
Ctrl+V or Shift+Insert to paste, Enter to submit. No caret, no selection, no
undo history. **Revealed**: a real `<textinput>` takes its place — caret,
selection, arrows, clicks, undo, the edit menu. Focus follows the swap both
ways, and the reveal ends when the keyboard leaves the widget.

In **both**, nothing leaves by a selection: Ctrl+C and Ctrl+X do nothing, the
revealed input is [`sensitive`](elements.md#sensitive) (no Cut or Copy in its
menu), and neither state takes PRIMARY. While masked the value is **never
laid out or drawn**, so its glyphs never reach the display server. The eye is
a pointer affordance, not a tab stop; `revealed` + `onRevealChange` put the
toggle where the keyboard can reach it. Caps Lock is reported while it is on.

### Drawing your own mask

`drawMask(ctx, info)` replaces the scribble; `info` is
`{ width, height, seed, color, length }`, with the mask width the field
worked out and the value-and-window seed. The scribble is `strokeScribble` in
`src/components/scribble.js`, with the reasoning for each number.

```jsx
<PasswordInput
  drawMask={(ctx, { width, height, color }) => {
    ctx.fillStyle = color;
    ctx.fillRect(0, height / 2 - 1, width, 2);
  }}
/>
```

### Password managers

XTEST auto-type arrives as ordinary key events, and Ctrl+V pastes with
control characters stripped (so a manager's trailing newline stays out).
Which manager does what, the window title's part, and Secret Service, the
portal and AT-SPI:
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
| `thumbStyle`            | the thumb's style, over its default                     |
| `trackStyle`            | the track's style, over `height` and `track`            |
| `fillStyle`             | the filled part of the track, over `accent`             |

The style slots restyle the parts and keep the drag, keyboard, `aria-*`
values, RTL and target size. A flat slider:

```jsx
<Slider
  value={volume}
  onChange={(ev) => setVolume(ev.value)}
  style={{ width: 240 }}
  thumbStyle={{
    width: 14,
    height: 14,
    borderWidth: 0,
    backgroundColor: theme.accent,
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
  }}
  trackStyle={{ height: 3, marginStart: 7, marginEnd: 7 }}
/>
```

The thumb is centred on its value, so the travel is the track less one thumb
(numeric `thumbStyle` `width`/`height` are what the widget uses); the control
is as tall as the taller of thumb and track, its target at least 24. Half a
thumb of `marginStart`/`marginEnd` on the track lets the thumb overhang the
ends. A slider with any slot is drawn even under `controls: 'auto'`.

Dragging uses [pointer capture](events.md#pointer-capture), so it follows
the pointer anywhere and ends wherever it is released. Keyboard: arrows
step, `Home`/`End` jump to the ends, `PageUp`/`PageDown` move ten steps.

## `Tooltip`

A hover hint in a `<popup>`, so it can extend past the owner window.

```jsx
import { Tooltip } from 'react-x11';

<Tooltip label="Back to zero">
  <Button onPress={reset}>Reset</Button>
</Tooltip>;
```

| prop                    |                                                                        |
| ----------------------- | ---------------------------------------------------------------------- |
| `label`                 | the hint: a string, or an element (nothing shows without it)           |
| `direction`             | `'auto'` (default), `'top'`, `'bottom'`, `'left'`, `'right'`           |
| `delay`                 | ms of hover before showing (default 500)                               |
| `fontSize`              | label size, also used to size the popup                                |
| `width`, `height`       | pin an axis of the bubble exactly; anything not pinned is measured     |
| `maxWidth`, `maxHeight` | cap what an element label measures out to, inside the screen's own cap |

It wraps its children in a row box carrying the hover handlers and anchor ref,
so it composes around any element, and hides at once on leave and on
mousedown. **One at a time** per connection: a trigger taking the hover
dismisses any showing hint immediately. `direction` is a preference: `'auto'`
takes the first side that fits on the **screen**, preferring above, and a
named side still flips rather than open off-screen. (`placement` is the older
name and still wins where given.)

An **element** `label` is measured like a string one: rendered
[`hidden`](elements.md#hidden--realized-laid-out-not-on-screen) at its
natural size (capped by the screen and `maxWidth`/`maxHeight`) and placed
before it maps, so it never appears misplaced. It fills the bubble with no
padding imposed; anything renders there, widgets included
(`examples/tooltips.jsx`):

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

`width` and `height` together skip measuring; one alone fixes that axis and
measures the other (`width={340}` is a column whose height fits). The size is
settled at open and kept until the next.

**The palette inside is inverted**: the bubble is drawn in the palette's ink,
so inside it `$background` (and `$surface`) is the bubble and `$text` the ink,
published through a `ThemeProvider` so `useTheme()` agrees, with `textMuted`
derived to match. Write content with tokens and it reads in both schemes; a
hard-coded light text colour vanishes on the light bubble of a dark palette.
Where the display composites the bubble is rounded at `radiusTooltip`, with
no border and a small arrow at the trigger's middle; elsewhere it is a
square rectangle with no arrow.

## `Dialog`

A `<popup>` centred over its owner that the **window manager knows is a
dialog**: managed and transient for its owner (`WM_TRANSIENT_FOR` on X11) —
framed, movable, closable through the WM, out of the taskbar and alt-tab, and
on a full EWMH window manager stacked above its owner and iconified with it.

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

| prop       |                                                                     |
| ---------- | ------------------------------------------------------------------- |
| `open`     | renders nothing when false; the popup exists only while true        |
| `title`    | names the dialog; drawn once ([below](#managed))                    |
| `children` | body content; strings become `<text>`                               |
| `actions`  | elements for the right-aligned button row                           |
| `onClose`  | Escape, or the window manager's close button                        |
| `managed`  | `false` for an unframed override-redirect popup ([below](#managed)) |
| `width`    | popup width (default 360); `'auto'` for the content's               |
| `height`   | default `'auto'`, the content's ([below](#size-and-placement))      |

Focus is the renderer's `trapFocus` ([Focus scopes](events.md#focus-scopes-modals)):
Tab stays inside, presses elsewhere do not move focus, and focus returns to
whatever had it (usually the opening button) on close. `autoFocus` picks the
first stop; with nothing focusable the dialog surface takes focus
(`tabIndex={-1}`), so Escape and Tab work at once. **Pointer modality is not
enforced** — the owner stays clickable — so it is for confirmations, not
guarding state.

### `managed`

| `managed`        | what you get                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `true` (default) | frame, titlebar (the `title`), movable, WM close button, transient for its owner; a press outside does not close it |
| `false`          | no frame, not movable, a pointer grab, the `title` as a bold heading; a press outside calls `onClose`               |

The frame and the grab go together (a grab would swallow the press that
starts a window drag). `managed={false}` suits a display with no window
manager. Either way the `title` names the dialog for accessibility, and the
owner is found automatically
([`transientFor`](elements.md#transientfor--a-window-that-belongs-to-another)).

### Size and placement

**The height is the content's** (`height="auto"`): the dialog measures its
content, centres over the owner at that size, and only then opens
([`placement: 'center'`](elements.md#centred-over-something)).

- **Capped at the monitor**: taller content scrolls in the body while the
  `actions` row stays pinned; the body is a tab stop only while it can
  scroll. A numeric `height` scrolls the same way.
- **Following its content**: content that changes while open re-fits the
  dialog from its **top edge**, moving it up only to stay on the monitor; a
  managed dialog the user dragged grows where they put it.
- **Centred once**, over where the owner was at open; moving the owner does
  not move it.

`width` defaults to 360 so prose wraps; `width="auto"` is for content with a
width of its own (a grid of fields, an image). A number is exact on either
axis. `centerRect(node, {width, height})` is the same centring as a function,
for popups of your own that know their size; one that does not uses
`<popup anchor={{ rect, placement: 'center' }}>`.

## `MenuBar` / `ContextMenu`

Pull-down and right-click menus in `<popup>` windows, anchored with
`useAnchor`. On the Cocoa backend with native controls they are sized as
`NSMenu` sizes its own — 22pt rows, the 13pt menu font
([macos.md](macos.md#menus-the-global-menu-finally-at-home)).

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
`onSelect(item)` prop too, fired after the item's own. A bar menu opens on
the **press**, like `Select`.

**The vocabulary is `com.canonical.dbusmenu`'s** — `type: 'separator'`,
`enabled: false`, `toggleType`/`toggleState` (`0`, `1`, or `-1` for
indeterminate), `shortcut` as modifier tokens — because on a desktop whose
panel shows application menus, `MenuBar` hands the array over and stops
drawing, with the same JSX ([globalmenu.md](globalmenu.md), also for
`globalMenu={false}`).

**`shortcut` is a binding, not a label**: `[['Control', 'S']]` makes Ctrl+S
fire the item's `onSelect` while the menu is mounted, unopened, gated by its
`enabled` and `visible`, and still when a panel has taken the menu over. The
same array is the drawn shortcut, the dbusmenu payload and the
`aria-keyshortcuts` announcement. Chord rules, key names, `useAccelerator`
and `accelerators={false}`: [events.md](events.md#accelerators).

**A context menu's items can come from the right-click.** The click records
only where it happened; the menu's content, size and placement come from the
`items` of the next render, so items derived in a row's `onContextMenu` give
a menu for that row on the first right-click. Items still empty open nothing
— no popup, no grab, focus left where the press put it.

```jsx
const [target, setTarget] = useState(null);

<ContextMenu items={target ? itemsFor(target) : []}>
  {rows.map((row) => (
    <box key={row.id} onContextMenu={() => setTarget(row)}>
      <text>{row.name}</text>
    </box>
  ))}
</ContextMenu>;
```

**Look.** Where the display composites, a menu is rounded (`radiusPopup`,
hairline border) and the row highlight an inset pill (`radiusPopupItem`) in
`hoverBackground`, the token shared with `Select` and `Table` highlights;
without a compositor both are square. Only the deepest open level wears
`hoverBackground`; the bar item and parent rows behind it are
`surfaceActive`. A bar too narrow for its titles moves the rest behind a
`moreVertical` entry whose rows open them as submenus; the keyboard walks
only what is painted. Design notes:
[design/components.md](../design/components.md#menubar--contextmenu).

**Icons.** `icon` fills the column left of the label, shared with the
`toggleType` mark (a checked item with an icon shows the check). It is drawn
locally and never crosses the bus; `iconName` is the icon-theme name a panel
uses. The column exists only while some row paints in it, so ticking the
first item of an unticked menu shifts its labels once. Pass a **function**:
it gets the row's ink and the column size, so one drawing follows the
highlight and the disabled grey —

```jsx
const save = ({ color, size }) => (
  <svg source={SAVE_SVG} style={{ width: size, height: size, color }} />
);

{ label: 'Save', icon: save, shortcut: [['Control', 'S']], onSelect: onSave }
{ label: 'Close', icon: (p) => <Icon name="close" {...p} />, onSelect: onClose }
```

— an SVG painted in `currentColor` is cached once for every colour
([elements.md](elements.md#svg)), as a [system icon](#system-icons) is. A
**string** icon is drawn as text and is only as good as the font (`✂` or `⏻`
is an empty box without one); an element renders as-is. Toggle marks are
the `check`, `dot` and `dash` icons. `examples/menu.jsx` has a worked set.

**Submenus.** An item with its own `items` is a submenu parent, marked with a
`chevronRight`. Nesting is unlimited; each level is a `<popup>` opening to the
end side, its first item level with its parent row, flipping at a screen
edge.

```jsx
{ label: 'Export', items: [
    { label: 'PNG', onSelect: exportPng },
    { label: 'SVG', onSelect: exportSvg },
] }
```

**Keyboard.** Up/Down move, **skipping separators and disabled entries**,
wrapping; Home/End jump to the ends; PageUp/PageDown step ten rows, then to
the nearest selectable one (menus size to content, never scroll); Right opens
a submenu at its first item and Left leaves it; Enter/Space activate or open;
Escape closes **one level at a time**. In a `MenuBar`, Left/Right move between
menus when there is no submenu to move through, and with one menu open,
hovering another switches to it. Hovering a parent opens its submenu with
nothing selected. **Type-ahead** works in the deepest open level: 700ms
queries (`c`,`a` finds _Carrot_), a repeated letter cycles, disabled entries
and separators never match.

Focus stays in the _owner_ window, as with `Select`; `ContextMenu`'s wrapper
is focusable and takes focus when its menu opens. Losing the window closes
an open menu.

### Safe-polygon hover

`MenuBar`, `ContextMenu` and `Tooltip` keep a submenu or hint open while the
pointer crosses towards it, using
[floating-ui's safePolygon](https://floating-ui.com/docs/usehover#safepolygon)
idea: the triangle between where the pointer was and the near edge of the
open surface counts as still hovering the parent. Inside it, hover changes
wait at most `SAFE_HOVER_DELAY` (320 ms); leaving it switches at once, and
reaching the surface keeps it open.

The helpers are exported for widgets of your own:
`movingToward(point, apex, rect)`, `safePolygon(apex, rect, buffer)`,
`pointInPolygon(point, polygon)` and `screenPoint(ev)`, all in **screen**
coordinates, since trigger and popup are different windows.

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

`content` may be a node or a function, called only while its tab is
selected. Items with no `content` make `Tabs` a pure navigator (in
`examples/app.jsx` the strip is in one `SplitPane` half, the panel in the
other). The strip is a **single tab stop**: Left/Right (Up/Down when
vertical) move and wrap, Home/End jump, disabled tabs are skipped. Arrows
select as they move; `manual` splits focus from selection, for expensive
panels.

## `Table`

A grid with a fixed header, resizable columns, and only the rows in view
built.

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
column })` replaces the cell. `selected` is there because a colour picked for
the resting row can vanish into the selection bar — fall back to `hoverText`:

```jsx
render: (row, { selected }) => (
  <text style={{ color: selected ? '$hoverText' : statusColour(row) }}>
    {row.state}
  </text>
);
```

**Every row must be `rowHeight` tall**: only the ~20 rows in view are
mounted, swapped as you scroll, with spacers keeping the scrollbar true.
Sorting a hundred thousand rows is still yours — pass `sort` and sort the
data yourself.

The **table** holds focus, not the row (rows unmount off screen). Up/Down
move the selection, PageUp/PageDown by a viewport, Home/End to the ends; a
click selects and a double click (`ev.detail`) or Enter fires `onActivate`.
The header scrolls sideways with the body, never vertically. A seven-pixel
grab band left of each header rule resizes the column (accent while held,
no sort on release); it takes focus on the press, so Left/Right then resize
by 16px.

## `Tree`

Moved to [`@react-x11/components`](ecosystem.md): virtualisation,
drag-to-reorder and lazy children do not belong in core.

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

Only the first pane's size is stored; the second takes the rest, so a window
resize never leaves a gap, and the drag clamps against the container as laid
out at that moment. The divider is focusable: arrows move it 16px, Home/End
to either limit. A drag captures the pointer and keeps the grip where it was
taken.

## `Canvas3D`

Moved to [`@react-x11/components/three`](ecosystem.md) as `<Canvas>`. Core
keeps the `<glarea>` surface under it — [gl.md](gl.md),
`examples/viewer3d.jsx`.

## `useAnchor(ref)` / `anchorRect(node, options)`

The placement math behind `Select` and `Tooltip`, for popup widgets of your
own.

```jsx
const ref = useRef(null);
const measure = useAnchor(ref);

// screen coordinates for a <popup>, given the size you intend to use
const rect = measure({ placement: 'bottom', align: 'center', width, height });
// -> { x, y, width, height, placement }
```

| option            |                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------- |
| `placement`       | `'bottom'` (default), `'top'`, `'start'`, `'end'`, `'left'`, `'right'`, `'center'` |
| `align`           | `'start'` (default), `'center'`, `'end'` on the cross axis                         |
| `offset`          | gap from the anchor in px (default 2)                                              |
| `at`              | a rect **inside** the node to anchor to instead — a caret, a cell                  |
| `width`, `height` | size of the popup you are positioning                                              |
| `alignTo`         | node the alignment reads, when it is not the anchor                                |
| `alignOffset`     | shift along the alignment axis in px, applied before clamping                      |

`placement` is a **preference**: near a screen edge the popup flips to the
opposite side, and it is clamped into the screen either way; the side used
comes back as `placement`. With no screen geometry it does not clamp.
`'center'` puts the popup **over** the anchor, middle on middle, only
clamped (`align`/`offset` ignored) — what [`Dialog`](#size-and-placement)
uses.

`'start'`/`'end'` are **logical** (a submenu opens towards `'end'`, leftwards
when mirrored); `'left'`/`'right'` are physical. `align` mirrors too, but
only above or below the anchor. The direction is read off the anchoring
node. `alignTo` takes the alignment from another node in the same window — a
submenu sits against its menu's outer edge but level with the row that
opened it, and `alignOffset` lines its first item up with that row's text.

### `at` — anchoring to part of a node

`at` is a rect in the **anchor node's own coordinates** that becomes the
anchor — for a caret, a table cell, a datapoint, a highlighted span. `{x, y}`
alone is a point; the popup `width` then defaults to the sub-rect's. Being
node-relative, it lets `useAnchorTracking` follow a caret for free, out-of-view
test included.

```jsx
const measure = useAnchor(editorRef);
const rect = measure({
  at: { x: caretX, y: lineTop, width: 1, height: lineHeight },
  placement: 'bottom',
  width: 240,
  height: rows * 22,
});
```

### `anchorScreenRect(app, rect, options)` — a rect with no node behind it

The same placement against a **screen** rect in logical pixels — a tray
item's frame, where the pointer was; `{x, y}` alone is a point. The popup
stays on the monitor the whole rect overlaps most (the nearest if none).
`options.scale` is the display's (default 1) and `options.direction` decides
`'start'`/`'end'`. A `<popup>` does this itself with
[`anchor={{ rect }}`](elements.md#a-popover-under-a-tray-item).

A popup that must **measure itself first** (rows sized to labels) cannot
know its size at render; `<popup anchor={{ to: ref, at }}>` lets the popup
place itself once laid out —
[elements.md](elements.md#anchor--a-popup-that-places-itself).

### `anchorArea(node)`

The usable part of the monitor `node` is on — panels and docks taken off, the
cap [`<window width="auto">`](elements.md#natural-size) uses — or `null` with
no display. A surface sizing itself caps itself to it (`Select` and
`ContextMenu` do), since `anchorRect` can slide a popup back from an edge but
not rescue one too big for the screen.

## `useDropTarget(options)` / `useDragSource(options)`

The render-state layer over the drag-and-drop props, for what a
`':drag-over'` or `':dragging'` style block cannot do — a hint label, a
disabled sibling, a preview that follows the pointer.

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

Spread `dropProps` / `dragProps` on any drawn element; they are the same
props you could write by hand, so use them when the render changes and the
plain props when it does not. `position` is `{ x, y, accepted }` in screen
coordinates during a drag — what a `<popup dragPreview>` follows. Full
reference: [drag-and-drop.md](drag-and-drop.md).

---

To build a popup widget of your own, `src/components/Select.js` is the
reference: state in React, `:hover` style blocks, a `<popup>` for anything
that must escape the window, `useAnchor` on the trigger. Do not place a popup
from a window's own `x`/`y` — under a reparenting window manager they are
frame-relative; `useAnchor` and `ev.screenX`/`screenY` come from the server.
