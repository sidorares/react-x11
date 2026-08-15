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
| `<text>`                | label, reading its content — and its selection, if any      |
| `<textinput>`           | entry: editable, single-line, caret and selection live      |
| `<textarea>`            | entry: editable, multi-line                                 |
| `<image>` / `<svg>`     | image, named by `alt`                                       |
| `overflow: 'scroll'`    | scroll pane (and a tab stop when it can scroll — see below) |
| `<canvas>` / `<glarea>` | drawing area / canvas — name them if they carry meaning     |

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
| `aria-keyshortcuts`                                         | the shortcut announced with the item ("Control+N")   |
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

| widget                    | reads as                                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`                  | button, named by its label; disabled buttons say so                                                                                                                                                                                             |
| `Checkbox`                | check box, checked/unchecked, named by its label                                                                                                                                                                                                |
| `Radio` / `RadioGroup`    | radio buttons with the selected one checked                                                                                                                                                                                                     |
| `Switch`                  | switch, on/off — **give it an `aria-label`**, it has no visible label of its own                                                                                                                                                                |
| `Slider`                  | horizontal slider with value and range; Orca can adjust it                                                                                                                                                                                      |
| `ProgressBar`             | progress bar; the value reads as a percentage of its range                                                                                                                                                                                      |
| `Select`                  | combo box named by the current choice, expanded/collapsed; its menu is a listbox of options, each "n of m" and the current one selected                                                                                                         |
| `MenuBar` / `ContextMenu` | menu bar and menus; items carry their shortcut as the standard `keyshortcuts` attribute ("Control+N" — UI Events spelling, where the row draws "Ctrl+N"), a `toggleType` as checked/radio, `toggleState: -1` as `mixed`, submenus as expandable |
| `Tooltip`                 | tooltip                                                                                                                                                                                                                                         |
| `Dialog`                  | modal dialog, named by its title                                                                                                                                                                                                                |
| `Tabs`                    | tab list with orientation; each tab selected or not; the panel is a tab panel                                                                                                                                                                   |
| `Tree`                    | tree of tree items with level, expanded/collapsed and selection                                                                                                                                                                                 |
| `Table`                   | table with column headers and rows ("n of m", selected). Virtualization means only rendered rows exist in the tree — the same rows a sighted user can see                                                                                       |
| `SplitPane`               | the divider is a separator with orientation and position — the ARIA window-splitter pattern                                                                                                                                                     |
| `Calendar` / `DatePicker` | combo box opening a grid of date cells, each named by its date and marked selected; the month buttons are labelled                                                                                                                              |

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

A `<text>` has the `Text` interface too — readable, with no caret to move.
What it now also reports is its **selection**: a paragraph inside a
`selectable` surface ([elements.md](elements.md#selecting-text)) hands over
the range the user has dragged across, and says so as it moves, so a
magnifier's highlight and a braille display's cursor sit on the same
characters the highlight is painted over.

### While a composition is open

A dead key or a half-typed Compose sequence puts text on the screen that is
in nobody's value yet ([events.md](events.md#composition)). The `Text`
interface answers with **what is drawn**, that preedit included, and its
offsets index that string — because every geometric answer beside it is
read off the layout of the same string, and a magnifier tracking character
3 has to land on the glyph a sighted user sees. `CaretOffset` is at the far
end of the composition, where the next keystroke of the sequence appears.

Which part of it is uncommitted is said twice, so a reader can act on
either:

- the preedit is its own **attribute run** — `underline: single`, the
  registered AT-SPI attribute for what is literally drawn, plus
  `composition: true`, which is this renderer's own because AT-SPI
  registers nothing for a preedit;
- its churn is **`:system`** text — `text-changed:insert:system` when the
  accent appears, `delete:system` when it changes or is abandoned. That is
  the suffix Gecko established for a change the user did not type, and it
  is what lets a reader stay quiet through a composition.

What the sequence **commits** is a plain `insert` of the finished
character: `é` is what the user typed, and it is spoken, once, as one
insertion — the same event an ordinary keystroke produces, which is also
why it is one undo step and not two.

Nothing here is announced through `announce()`. A live-region announcement
on top of the text-changed feed would have a screen reader say the accent
twice; an application that wants to narrate composition state can call
`announce()` itself from `onCompositionUpdate`.

### Text of your own

A [registered element](extending.md) that draws its own text — a code
editor, a markdown viewer, a terminal, a canvas-backed table with cell
editing — reports it through one method and is then read by everything
above: character count, reading by character/word/line, caret, selection,
the text-changed deltas, and an AT that can navigate and type.

```js
class EditorNode extends Node {
  a11yTextState() {
    return {
      value: this.text, // what is drawn, composition included
      caret: this.caret, // code-point offsets into `value`
      selectionStart: this.anchor,
      selectionEnd: this.caret,
      editable: true, // an editor rather than a viewer
      multiline: true,
    };
  }

  insert(text) {
    /* …the edit… */ this.notifyA11yTextChanged();
  }
}
```

| member                              |                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| `a11yTextState()`                   | `{ value, caret, selectionStart, selectionEnd, editable, multiline, preedit }` — `null` for no text |
| `notifyA11yTextChanged()`           | the text moved. Free when nothing is listening, so no guard around it                               |
| `a11ySetSelection(start, end)`      | an AT moved the caret or made a selection                                                           |
| `a11yReplaceText(start, end, text)` | an AT edited — insert, delete and replace all arrive as this                                        |
| `a11yRole`                          | the role the element is when the app writes none; `role` still wins                                 |

Two tiers, because the read-only one is a real element and not a
degenerate editor. `{ value, selectionStart, selectionEnd }` alone is a
document: the `Text` interface, a `document` role, a selection an AT reads
and sets — which is what a markdown view with Ctrl+C needs and all it
needs. `editable: true` adds the EDITABLE state, an `entry` role and, once
`a11yReplaceText` exists, the `EditableText` interface. Nothing is exposed
that would not work: an element that reports editable text but implements
no write is announced as editable and reports its own edits, but is not
offered to an AT as one to type into.

Offsets are code points and index the string the element **draws** — an
open composition included, for the same reason `<textinput>`'s do. Report
which part is uncommitted as `preedit: { offset, text }` and its churn is
marked `:system`, so a reader stays quiet through a dead key and speaks the
character it commits. Offsets are clamped on the way out, so a stale caret
cannot become an out-of-range answer on the wire.

The known limits of the tier, none of which stop a screen reader working:
per-character screen rectangles fall back to the element's own rect (a
magnifier tracks the element, not the glyph), and AT-driven paste and copy
are the built-ins' — an element's own Ctrl+C/Ctrl+V is unaffected. Both
want a layout the element alone has; say so on the issue if you have one.

The seam is observed by the test spy exactly as core's is, so an editor in
another package can assert what it says with no bus and no desktop —
[below](#asserting-what-a-screen-reader-would-hear).

### A scene of your own

The other half of the same gap. A [registered element](extending.md) that
_draws_ interactive things — a graph pane, a chart, a timeline, a seating
plan — is one node, so it is one accessible: "Flow graph, group", with
three hundred selectable nodes inside it that no assistive technology can
see. It says what it drew and each one becomes a child:

```js
class FlowNode extends Node {
  a11yScene() {
    return this.nodes.map((node) => ({
      id: node.id, // stable while it is on screen: this is identity
      role: 'listitem',
      name: node.label,
      rect: node.rect, // window coordinates
      states: {
        selected: this.selection.has(node.id),
        focused: this.cursor === node.id,
      },
    }));
  }

  select(id) {
    /* …the element's own selection… */ this.notifyA11ySceneChanged();
  }
}
```

| member                        |                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `a11yScene()`                 | `[{ id, rect, role, name, description, focusable, states, props, children }]`                         |
| `notifyA11ySceneChanged()`    | the scene moved between commits — a drag, an animation, your own arrow keys                           |
| `a11ySceneAction(id, action)` | an AT sent `'activate'`, `'focus'` or `'scroll'`. `true` claims it; anything else keeps core's answer |

They are read by the same model everything else is: `role` and the
`aria-*`-shaped states above become the AT-SPI role and state set, `rect`
becomes the Component extents a magnifier tracks and focus is drawn around,
and a change to any of it is announced as that child changing rather than as
the pane being replaced. Keyboard navigation _between_ items stays the
element's own — the window's focus manager holds the element, which is why
`states.focused` is the only way the cursor inside it is reported.

Activation with no `a11ySceneAction` is a synthetic click at the item's own
rect, which is exactly what a mouse user does to it; the seam is for the
elements where that is not the truth. See
[extending.md](extending.md#a-scene-a-screen-reader-can-walk) for the whole
contract.

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
  role assigns `this.a11yRole` in its constructor (a `role` prop still
  wins).
- `a11yTextState()` + `notifyA11yTextChanged()` — when your element draws
  text of its own, which is the one thing props cannot express
  ([above](#text-of-your-own)).
- `a11yScene()` + `notifyA11ySceneChanged()` — when your element draws
  interactive _things_ of its own, which is the other one
  ([above](#a-scene-of-your-own)).

## Testing and verifying

### Asserting what a screen reader would hear

`renderX11(element, { a11y: true })` hands back `at`, an in-process
assistive-technology spy: the same semantic feed the AT-SPI bridge serves
to Orca, observed before it becomes D-Bus — so it is synchronous, needs no
bus, and runs everywhere the test suite runs (the mock backend, Node 20,
macOS included). Input stays real: `userEvent.tab()` is a Tab through the
in-process X server's focus machinery, not a shortcut around it.

```js
import { renderX11, userEvent, cleanup, XK_SPACE } from 'react-x11/test';

const { at } = await renderX11(<Preferences />, { a11y: true });

await userEvent.tab();
assert.equal(at.focused().utterance, 'Save, button');

await userEvent.tab();
await userEvent.key(XK_SPACE);
assert.ok(at.since().some((e) => e.type === 'state' && e.state === 'checked'));
```

Every entry is a precise fact (`{ type, state, on, node, … }`) plus a
one-line `summary`; `at.transcript()` is the summaries, made for
`deepEqual`. `at.focused()` and `at.focusables()` describe nodes the way an
AT would — name, role, states, and an `utterance` string following the
model documented on this page (name, role, the states worth speaking, a
value as a percentage). The utterance is deliberately **this library's
model, not an imitation of Orca**, whose wording is presentation policy;
what it buys you is that a control nobody named renders as
`"(no accessible name)"` instead of passing because no assertion happened
to mention its name.

Four tests worth copying into any application — each one a check a sighted
test author cannot make by looking (`test/a11y-spy.test.js` is the worked
example of all four):

- **Focus order** — tab through, `deepEqual` the focus summaries.
- **No keyboard trap** — `at.focusables().length` + 1 Tabs lands back on
  the first stop, and Shift+Tab wraps the other way.
- **Nothing nameless** — for each of `at.focusables()`, assert the
  utterance is not `"(no accessible name)"`. The highest value per line in
  this document.
- **State changes are announced** — press Space on a checkbox, assert a
  `checked` state entry arrived; a widget that repaints without one is the
  most common accessibility regression there is.

### Testing the bridge itself

The wire half is testable without a desktop too: point
`AT_SPI_BUS_ADDRESS` at an in-process bus (dbus-native's broker), own
`org.a11y.atspi.Registry` on it with a stub `Embed`, and walk your app with
real D-Bus calls — `test/atspi.test.js` is the worked example, and the
model half (roles, names, states as pure functions over the tree) needs no
bus at all (`test/a11y.test.js`). Applications rarely need this layer; it
is how react-x11 proves the transport.

### Seeing it without learning a screen reader

`npm run a11y:probe` is the client side of AT-SPI — the side Orca is on —
with no GNOME libraries and nothing to configure:

```bash
npm run a11y:probe                       # what is on the accessibility bus
npm run a11y:probe -- widgets            # dump that app's accessible tree
npm run a11y:probe -- widgets --watch    # follow its events as you click
npm run a11y:probe -- widgets --watch --speak   # ...said out loud
npm run a11y:probe -- nautilus           # someone else's toolkit, for comparison
```

It talks to whatever is on the bus, so pointing it at a GTK app and at
yours is the sharpest check available: if the shapes match, a screen reader
will treat them the same. The `say:` lines it prints are a **toy** model —
what Orca really utters is Orca's own policy — but they make a missing
accessible name audible instead of merely absent, which is the failure that
matters most and is easiest to miss.

### With a real screen reader

```bash
orca --replace --debug-file=/tmp/orca.log     # then Tab through your app
grep "SPEECH OUTPUT" /tmp/orca.log
```

The debug log is the ground truth, and it is easier to read than listening.
For audio, speech-dispatcher does the talking (`spd-say hello` tests it on
its own). Orca's own toggle is `gsettings set
org.gnome.desktop.a11y.applications screen-reader-enabled true`; the GUI
inspector, if you want one, is `accerciser`.

### Scripting the AT side

The AT stack is also scriptable through the same library Orca uses:

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
- **An input method** — dead keys and Compose are the whole composition
  story today, so a script that needs a candidate window (any CJK) cannot
  be typed at all, accessibly or otherwise. What an IME would report is
  already here: the preedit is a text run and its own `:system` feed, so
  the work left is the input method, not its accessibility.
