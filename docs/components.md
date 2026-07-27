# Components

Widget components are plain React built on the host elements — no
reconciler support involved. They live in the package root export.

## `Select`

A dropdown whose menu is a real override-redirect `<popup>` window anchored
below the trigger.

```jsx
import { Select } from 'react-x11';

<Select
  width={160}
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
| `width` + any box props    | forwarded to the trigger box              |

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
  width={200}
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

<ContextMenu items={items} flexGrow={1}>
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

## `Canvas3D`

The entry point to the [3D scene](elements.md#3d-scene-mesh-group-geometries-materials)
— a thin wrapper over the `<glarea>` host element, named `Canvas3D` rather
than r3f's `Canvas` because react-x11 already has a `<canvas>` element (the
2D `onDraw` escape hatch).

```jsx
import { Canvas3D } from 'react-x11';

<Canvas3D
  flexGrow={1}
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
