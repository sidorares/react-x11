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

| token                                      |                                |
| ------------------------------------------ | ------------------------------ |
| `background` `text` `dim` `border`         | the surface a control sits on  |
| `accent` `accentHover` `accentText`        | primary buttons, checks, fills |
| `hoverBackground` `hoverText`              | selected rows, menu highlights |
| `surfaceHover` `track` `borderFocus`       | hover fills, tracks, focus     |
| `accentActive` `surfaceActive` `dimActive` | the pressed step of each fill  |
| `radius` `radiusSmall` `borderWidth`       | control shape                  |
| `fontSize` `paddingX` `paddingY`           | control size                   |

The `…Active` three are the colour a control takes **while it is held**, and
a palette almost never sets them: each is derived from the step the palette's
own hover already makes — `accent` → `accentHover` → one more of the same —
so it darkens a light theme and lightens a dark one. Set one explicitly and
it wins. See [The press state](#the-press-state) for why every control has
one.

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

## Basic controls

`Button`, `Checkbox`, `Radio`/`RadioGroup`, `Switch` and `ProgressBar` share
one piece of plumbing, `useControl(disabled, onActivate)`: it makes the
control focusable, activates it on click or Space (Enter as well, for
`Button`), sets the pointer cursor, and expresses hover, press and focus
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
`accentActive`/`surfaceActive`/`dimActive` are the colours.

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

**Type-ahead.** Typing letters jumps to the matching option: with the menu
open it moves the highlight, and with it closed it changes the value
outright, the way a native select does. Keystrokes within 700ms accumulate
into one query (`b`,`l` finds _blueberry_, not _banana_); repeating a
single letter cycles through the options starting with it.

### Theming

`Select` has no provider of its own — it reads the palette from
[`ThemeProvider`](#theming) like every other widget. The trigger is
`background`/`text` in a `border` box that turns `borderFocus` on focus or
while open, the chevron and the placeholder text are `dim`, and the menu
highlight is `hoverBackground`/`hoverText`.

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

| prop        |                                                    |
| ----------- | -------------------------------------------------- |
| `label`     | the hint text (nothing shows without it)           |
| `placement` | `'top'` (default), `'bottom'`, `'left'`, `'right'` |
| `delay`     | ms of hover before showing (default 500)           |
| `fontSize`  | label size, also used to size the popup            |

Wraps its children in a row box carrying the hover handlers and the anchor
ref, so it composes around any element. Hides immediately on leave and on
mousedown — a tooltip lingering over the menu you just opened is the
classic annoyance. The popup is sized from the _measured_ label, because a
`<popup>` is a real X window and needs its size before layout.

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
        { label: 'New', shortcut: 'Ctrl+N', onSelect: newFile },
        { separator: true },
        { label: 'Save As…', disabled: true },
        { label: 'Wrap lines', checked: wrap, onSelect: toggleWrap },
      ],
    },
  ]}
/>;

<ContextMenu items={items} style={{ flexGrow: 1 }}>
  <text>Right-click me</text>
</ContextMenu>;
```

Item shape: `{ label, onSelect, shortcut, disabled, separator, checked,
icon, items }`. Both take an `onSelect(item)` prop as well, fired after the
item's own. A bar menu opens on the **press**, for the reason `Select` does.

**Icons.** `icon` fills the 16px column left of the label — the same column
the check mark uses, so an item that is both checked and iconned shows the
check: the check is state, the icon is only identity. One column rather than
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

{ label: 'Save', icon: save, shortcut: 'Ctrl+S', onSelect: onSave }
```

Paint the SVG in `currentColor` and the renderer caches it as coverage
rather than as pixels, so recolouring per row is a composite and every
colour of the icon shares one rendered copy
([elements.md](elements.md#svg)). A **string** icon is drawn as text, which
is a one-liner — but it is only as good as the font, and `✂` or `⏻` is an
empty box on a machine without them. An element is rendered as-is.
`examples/menu.jsx` has a worked set.

**Submenus.** Give an item its own `items` and it becomes a submenu parent,
marked with `▸` and opening to the side:

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
| `onActivate(id, row)`          | Enter on the selection                              |
| `onColumnResize(id, width)`    | after a header drag                                 |

`value(row)` feeds sorting and the default cell text; `render(row)` replaces
the cell contents entirely.

**Rows must all be `rowHeight` tall.** That is the price of the table only
building what is on screen: with ten thousand rows it mounts the twenty or
so in the viewport and swaps them as you scroll, and everything above and
below is a single spacer box, so the scrollbar still measures the whole
list. Sorting a hundred thousand rows is still the caller's problem — pass
`sort` and sort the data yourself when that matters.

The **table** holds the focus, not the row: a row is unmounted as soon as it
scrolls out of view, and focus would go with it. Up/Down move the selection,
PageUp/PageDown by a viewport, Home/End to the ends, and the selection is
kept on screen without building the rows in between.

The header scrolls sideways with the body but never vertically. Dragging the
grip at a header's right edge resizes that column; the body follows.

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
nothing rasterizes. See [3D over indirect GLX](glx.md).

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

| option            |                                                            |
| ----------------- | ---------------------------------------------------------- |
| `placement`       | `'bottom'` (default), `'top'`, `'left'`, `'right'`         |
| `align`           | `'start'` (default), `'center'`, `'end'` on the cross axis |
| `offset`          | gap from the anchor in px (default 2)                      |
| `width`, `height` | size of the popup you are positioning                      |
| `alignTo`         | node the alignment reads, when it is not the anchor        |

`placement` is a **preference, not a promise**: a menu near the bottom of
the screen flips above its trigger rather than opening off-screen, and the
result is clamped into the screen either way. The side actually used comes
back as `placement`. Where screen geometry is unavailable it places without
clamping.

`alignTo` takes the two axes from **different nodes**: the placement edge
from the anchor, the alignment from `alignTo`. A submenu is the case that
needs it — it belongs against the outer edge of the menu it comes out of,
but level with the row that opened it, and that row is inset by the menu's
border and padding. Both nodes have to be in the same window.

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
