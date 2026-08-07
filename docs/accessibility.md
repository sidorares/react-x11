# Accessibility

react-x11 applications are visible to screen readers. The renderer carries a
built-in [AT-SPI2](https://gitlab.gnome.org/GNOME/at-spi2-core) bridge — the
same interface GTK and Qt applications register themselves through — so Orca
reads a react-x11 window the way it reads any other: roles, names, states,
focus, live text editing, and the actions to drive controls without a
pointer.

It is on by default and costs nothing to have: with no accessibility bus on
the machine the bridge never comes up, and the render path pays one property
read per event for the hooks it would have filled.

```jsx
<box role="button" aria-label="Close" onClick={close} focusable>
  <text>×</text>
</box>
```

That is the entire API for most code. `role` and `aria-*` are the web's
names, accepted on every host element — the same vocabulary react-dom takes
and React Native adopted — so a component library that sets them is
accessible here with no react-x11-specific knowledge, and the built-in
widgets (`Button`, `Checkbox`, `Select`, `Menu`, `Tabs`, `Tree`, …) already
carry them.

> This page is the reference. The design record — why there is no mirror
> tree, why the vocabulary is the web's rather than React Native's, why
> discovery dials its own socket, what was rejected and what is deferred —
> is [architecture/accessibility.md](architecture/accessibility.md).

## What a screen reader hears without any props

Accessibility is not opt-in; the defaults are chosen so an unlabelled tree
is _boring_ to a screen reader rather than broken:

| element                 | reads as                                                    |
| ----------------------- | ----------------------------------------------------------- |
| `<window>`              | frame, named by `title`                                     |
| `<popup>`               | window (give the content a `role` — `menu`, `dialog`, …)    |
| `<box>`                 | filler — skipped silently, like GTK's own layout boxes      |
| `<text>`                | label, reading its content                                  |
| `<textinput>`           | entry: editable, single-line, caret and selection live      |
| `<textarea>`            | entry: editable, multi-line                                 |
| `<image>` / `<svg>`     | image, named by `alt`                                       |
| `<scrollview>`          | scroll pane (and a tab stop when it can scroll — see below) |
| `<canvas>` / `<glarea>` | drawing area / canvas — name them if they carry meaning     |
| `<markdown>` / `<html>` | document                                                    |

Focus, enabled/disabled, checked, selected, expanded and the rest are read
from the same live state the widgets draw from — the `focusable` rule, the
`disabled` prop, the `aria-*` props — so what the screen reader says cannot
drift from what the screen shows.

## The props

All of these are accepted on every host element and are inert (and
harmless) when no assistive technology is listening.

| prop                                                        | AT-SPI meaning                                       |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| `role`                                                      | what the element _is_ (ARIA role names; table below) |
| `aria-label`                                                | the accessible name, over every other source         |
| `aria-description`                                          | supplementary description                            |
| `aria-hidden`                                               | remove this subtree from the accessible tree         |
| `aria-checked` (`true`/`false`/`'mixed'`)                   | CHECKABLE + CHECKED / INDETERMINATE                  |
| `aria-selected`                                             | SELECTABLE + SELECTED                                |
| `aria-expanded`                                             | EXPANDABLE + EXPANDED / COLLAPSED                    |
| `aria-pressed`                                              | PRESSED (toggle buttons)                             |
| `aria-busy`, `aria-modal`, `aria-required`, `aria-readonly` | the states of the same names                         |
| `aria-haspopup`                                             | HAS_POPUP (`'menu'`, `'listbox'`, `'dialog'`, …)     |
| `aria-orientation`                                          | HORIZONTAL / VERTICAL                                |
| `aria-valuenow` / `-valuemin` / `-valuemax` / `-valuetext`  | the Value interface (sliders, progress)              |
| `aria-level`, `aria-posinset`, `aria-setsize`               | "level 2", "3 of 7" — headings, trees, lists         |
| `aria-keyshortcuts`                                         | the shortcut announced with the item ("Ctrl+N")      |
| `onAccessibilityAction`                                     | the AT drove the control (below)                     |

Roles: `alert alertdialog article banner blockquote button caption cell
checkbox columnheader combobox comment complementary contentinfo dialog
document form grid gridcell group heading img link list listbox listitem log
main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter
navigation note option paragraph progressbar radio radiogroup region row
rowheader scrollbar search searchbox separator slider spinbutton status
switch tab table tablist tabpanel term textbox timer toolbar tooltip tree
treegrid treeitem window`, plus `none`/`presentation` to erase a wrapper
from the accessible tree while keeping its children. An unknown role warns
in development and falls back to the element default — a typo must not
silently turn a button into a filler, and it must not crash either.

Two deliberate absences. There is no `aria-disabled`: `disabled` is already
a host prop with real behaviour (it blocks focus and drives `:disabled`
style blocks), and a parallel prop that only _said_ disabled would let the
two disagree. And there is no `aria-labelledby`/`aria-describedby`: there
are no element ids to point them at — use `aria-label`, or lean on
name-from-contents.

### Names

The accessible name resolves in order: `aria-label` → what the element
itself carries (a window's `title`, an image's `alt`, an input's
`placeholder` — the fallback the web engines also use) → for roles whose
contents are their label (buttons, checkboxes, menu items, tabs, links,
options, tree items, …), the visible text inside. So
`<Button>Save</Button>` is named "Save" with nobody writing a label, and
`announce`-worthy custom controls need one prop, not three.

### AT-driven controls

Activation needs no wiring at all: every element whose role promises it
(button, checkbox, menu item, tab, …) or that has an `onClick` exposes an
AT-SPI `activate` action, and the bridge performs it by dispatching a
synthetic click through the normal event path — capture, bubble, default
actions, the discrete-priority commit — so Orca pressing a button is
indistinguishable from a finger.

(Under the hood the activation is a full press gesture — mousedown, mouseup,
click — because several controls act on the press: `Select` and `MenuBar`
drop their menus on it, the way real menus do.)

The one thing that does need a handler is a _value_ write — Orca adjusting
a slider through the Value interface. The handler receives one argument:

```ts
{ action: 'setValue', value: number }
```

(`action` is a string so the shape can grow; `'setValue'` is the only
action delivered today — activation never arrives here, it goes through the
event system above.) Wire it into the same state setter as the pointer and
the keyboard:

```jsx
<box
  role="slider"
  aria-valuenow={value}
  aria-valuemin={0}
  aria-valuemax={100}
  onAccessibilityAction={({ action, value }) => {
    if (action === 'setValue') setValue(clamp(value));
  }}
/>
```

`Slider` already does exactly this.

### Announcements

```js
import { announce } from 'react-x11';

announce('Form saved');
announce('Connection lost', { assertive: true });
```

The explicit counterpart of an ARIA live region: say something through the
screen reader without moving focus. Returns `true` when a bridge was live
to carry it; `false` means nobody is listening and a visible fallback may
be warranted. (Orca ≥ 45 speaks these; there is no `aria-live` region
tracking — an explicit call is smaller, and it cannot fire on renders you
did not mean.)

## What the built-in widgets announce

Every widget in [components.md](components.md) is wired; none of them need
anything from you beyond their ordinary props. What a screen reader hears:

| widget                    | reads as                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                  | button, named by its label; disabled buttons say so                                                                                                       |
| `Checkbox`                | check box, checked/unchecked, named by its label                                                                                                          |
| `Radio` / `RadioGroup`    | radio buttons with the selected one checked                                                                                                               |
| `Switch`                  | switch, on/off — **give it an `aria-label`**, it has no visible label of its own                                                                          |
| `Slider`                  | horizontal slider with value and range; Orca can adjust it                                                                                                |
| `ProgressBar`             | progress bar; the value reads as a percentage of its range                                                                                                |
| `Select`                  | combo box named by the current choice, expanded/collapsed; its menu is a listbox of options, each "n of m" and the current one selected                   |
| `MenuBar` / `ContextMenu` | menu bar and menus; items carry their shortcut ("Ctrl+N") as the standard `keyshortcuts` attribute, checkmarks as checked, submenus as expandable         |
| `Tooltip`                 | tooltip                                                                                                                                                   |
| `Dialog`                  | modal dialog, named by its title                                                                                                                          |
| `Tabs`                    | tab list with orientation; each tab selected or not; the panel is a tab panel                                                                             |
| `Tree`                    | tree of tree items with level, expanded/collapsed and selection                                                                                           |
| `Table`                   | table with column headers and rows ("n of m", selected). Virtualization means only rendered rows exist in the tree — the same rows a sighted user can see |
| `SplitPane`               | the divider is a separator with orientation and position — the ARIA window-splitter pattern                                                               |
| `Calendar` / `DatePicker` | combo box opening a grid of date cells, each named by its date and marked selected; the month buttons are labelled                                        |

## Text controls

`<textinput>` and `<textarea>` implement the AT-SPI `Text` and
`EditableText` interfaces in full working order: character count, reading
by character/word/line, caret position (offsets are code points, on both
sides), selections, per-character screen rectangles for magnifiers and
caret tracking, and edits — a screen reader can read, navigate, select,
and type. Every edit and caret move emits the precise
`text-changed`/`text-caret-moved` deltas Orca narrates from.

One honest limit: "line" granularity follows hard newlines, not the soft
wraps of a `<textarea>`'s layout. Orca still reads everything; a
line-by-line walk of one long wrapped paragraph is one stop, not several.

## The compatibility ladder

`createRoot()` starts one climb per process, off the critical path:

1. is `dbus-native` installed? (it is an optionalDependency; Node < 22.12
   skips it)
2. is there a session bus?
3. does `org.a11y.Bus` answer `GetAddress`? (this also starts the a11y bus
   launcher on desktops where it is not running yet)
4. connect, export the tree, `Embed` with the AT-SPI registry.

Every "no" is a normal, **silent** off: ssh sessions, CI, containers, bare
`startx`, macOS and Windows X servers — react-x11's own flagship
configurations — simply have no accessibility stack, and an app must not
log, slow down or grow a mode because of it. The bridge holds no
event-loop reference either, so a process that is done exits; the registry
sees the name drop and forgets the app.

Environment switches, in priority order:

- `REACT_X11_A11Y=0` — off. Any other value forces the climb **and makes
  it loud**: each rung prints why it stopped, which is the answer to "why
  does Orca not see my app".
- `AT_SPI_BUS_ADDRESS` — skip discovery and connect here. The seam
  sandboxes use, and the one the hermetic tests use.
- `NO_AT_BRIDGE=1` — off; the ecosystem-wide switch every toolkit honours.
  `react-x11/test` sets it, so a test run on a desktop does not parade
  phantom applications through a running screen reader.

A dead accessibility bus is not redialled — the same contract as
[dbus.md](dbus.md): the app simply stops being accessible until restarted.

## For component libraries

There is nothing to integrate against. Set the standard props on the host
elements you render, exactly as the built-in widgets do; the bridge mirrors
whatever the tree says. The seams, in increasing order of involvement:

- `role` + `aria-*` on any element — the whole story for almost everything.
- `disabled`, `focusable`, `tabIndex` — already doubling as the ENABLED and
  FOCUSABLE states; nothing separate to maintain.
- `onAccessibilityAction` — when an AT can _set_ something on your control.
- A [registered element](extending.md) is a host element like any other:
  its instances take all of the above, and a class that should default to a
  role can set `props.role` in its constructor.

## Testing and verifying

The bridge is testable without a desktop: point `AT_SPI_BUS_ADDRESS` at an
in-process bus (dbus-native's broker), own `org.a11y.atspi.Registry` on it
with a stub `Embed`, and walk your app with real D-Bus calls —
`test/atspi.test.js` is the worked example, and the model half (roles,
names, states as pure functions over the tree) needs no bus at all
(`test/a11y.test.js`).

Against a real desktop, the AT side of the stack is scriptable through the
same library Orca uses:

```python
import gi; gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
desktop = Atspi.get_desktop(0)
apps = [desktop.get_child_at_index(i) for i in range(desktop.get_child_count())]
app = next(a for a in apps if a and a.get_name() == 'myapp')
# walk it, read roles/names/states, do_action(0), set values…
```

Accerciser gives the same view interactively, and running `orca` while
Tab-walking your app is the ground truth. Under `react-x11/test`,
remember, the bridge is off by default (`NO_AT_BRIDGE`) so tests stay
deterministic.

## What is deliberately not there (yet)

- **Relations** (`aria-labelledby`, label-for) — needs an id registry;
  `aria-label` and name-from-contents cover the widgets.
- **The Selection interface** on containers — Orca reads per-item
  SELECTED states and selection is driven through actions and focus, so
  this is polish, not a gap in coverage.
- **The Table interface** — `Table` exposes honest `table`/`row`/`cell`
  roles with positions, but not the row/column navigation calls; note that
  virtualization means only rendered rows exist in the accessible tree,
  which is also all a sighted user can see.
- **Key-event forwarding** (`DeviceEventController.NotifyListenersSync`) —
  Orca's per-keystroke echo of _keys themselves_; typed characters already
  arrive through text-changed events.
- **Soft-wrap line granularity** in `<textarea>`, per above.
