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

`<ThemeProvider value={palette}>` gives every widget beneath it a palette,
and a partial one merges over the defaults. It carries **shape as well as
colour** — corner radius, border weight, text size and the padding inside a
control are most of what separates one platform's controls from another's:

| token                                 |                                   |
| ------------------------------------- | --------------------------------- |
| `background` `text` `dim` `border`    | the surface a control sits on     |
| `accent` `accentHover` `accentText`   | primary buttons, checks, fills    |
| `hoverBackground` `hoverText`         | selected rows, menu highlights    |
| `surfaceHover` `track` `borderActive` | hover fills, slider tracks, focus |
| `radius` `radiusSmall` `borderWidth`  | control shape                     |
| `fontSize` `paddingX` `paddingY`      | control size                      |

Widgets plant the merged palette on their own root node, so a `$token` in a
style you pass one resolves against it — see
[styling.md](styling.md#theme-tokens).

`examples/themes.js` has three worked palettes — GitHub, macOS and Windows,
each in light and dark — and `npm run examples:theming` switches between
them at runtime.

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
  onChange={(value) => setColor(value)}
  placeholder="Pick a color…"
/>;
```

| prop                       |                                           |
| -------------------------- | ----------------------------------------- |
| `options`                  | array of `{value, label}` or plain values |
| `value`, `onChange(value)` | selection                                 |
| `placeholder`              | trigger text when nothing is selected     |
| `style` + any box props    | forwarded to the trigger box              |

Behavior: click / Space / Enter toggles the menu; Escape, focus loss, or
picking closes it; the option list scrolls when taller than 220px; the
trigger participates in Tab traversal.

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

```jsx
import { SelectThemeProvider } from 'react-x11';

<SelectThemeProvider
  value={{
    border: '#444',
    borderActive: '#f39c12',
    background: '#2f3640',
    text: '#f5f6fa',
    dim: '#95a5a6',
    hoverBackground: '#f39c12',
    hoverText: '#1e272e',
  }}
>
  <Select … />
</SelectThemeProvider>;
```

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
  onChange={setVolume}
/>;
```

| prop                       |                                                        |
| -------------------------- | ------------------------------------------------------ |
| `value`, `onChange(value)` | current value (controlled)                             |
| `min`, `max`, `step`       | range and quantisation (defaults 0, 100, 1)            |
| `width`, `height`          | track width; `height` is the bar thickness (default 4) |
| `disabled`                 | inert, dimmed                                          |

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

A modal dialog in a `<popup trapFocus grab>`, centred over the owner window.

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
| `onClose`         | Escape, or a press outside the dialog                        |
| `width`, `height` | popup size (default 360×170)                                 |

The focus behaviour is the **renderer's**, not the component's: `trapFocus`
keeps Tab inside the dialog, stops presses elsewhere from moving focus, and
hands focus back to whatever had it — usually the button that opened the
dialog — when it closes. See
[Focus scopes](events.md#focus-scopes-modals). Put `autoFocus` on a control
inside to pick the first stop; with nothing to focus, the dialog surface
takes focus itself (`tabIndex={-1}`) so Escape and Tab work immediately.

Escape closes because keys go to the focused node inside the popup and
bubble out through the popup's place in the JSX tree; `grab` makes a press
anywhere else in the session close it too. **Pointer modality is not
enforced** — widgets in the owner window stay clickable behind the dialog —
so it is for confirmations, not for guarding state.

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
items }`. Both take an `onSelect(item)` prop as well, fired after the
item's own.

**Submenus.** Give an item its own `items` and it becomes a submenu parent,
marked with `▸` and opening to the side:

```jsx
{ label: 'Export', items: [
    { label: 'PNG', onSelect: exportPng },
    { label: 'SVG', onSelect: exportSvg },
] }
```

Nesting is unlimited. Each level is its own `<popup>`, anchored to its
parent row with `placement: 'right'`, so it flips to the left near a screen
edge like any other anchored popup.

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

Animate by changing props from a `requestAnimationFrame` loop on the window
ref (see `examples/three.jsx`) — a scene only redraws when something
changes, unless `frameLoop="always"`.

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

`placement` is a **preference, not a promise**: a menu near the bottom of
the screen flips above its trigger rather than opening off-screen, and the
result is clamped into the screen either way. The side actually used comes
back as `placement`. Where screen geometry is unavailable it places without
clamping.

---

The other components — `Button`, `Checkbox`, `Radio`/`RadioGroup`,
`Switch`, `ProgressBar` — are demoed together in `examples/widgets.jsx`.

The `Select` source (`src/components/Select.js`) is the reference for building
your own: hover/focus state with `useState`, a `<popup>` for anything that
must escape the window bounds, and a ref to the trigger node for anchoring
(`node.abs` + `node.root.window.x/y`).
