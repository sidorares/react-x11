# Events

Raw input arrives per window from the backend; react-x11 dispatches it as
synthetic events over the drawn node tree with DOM-like semantics.

## Dispatch

1. **Hit test**: front-to-back over the stacking-ordered tree (zIndex, then
   document order), respecting `overflow` clipping and `pointerEvents` —
   `'none'` removes a node and its subtree, `'box-none'` only the node
   itself, so its children are still targets and a point over its own area
   lands on what is behind it. A `<glarea>` is asked first: its surface is
   above everything 2D in the window and its children above the surface, so
   a point over it lands on a child, on the `<glarea>`, or (with
   `'box-none'`) on what is behind the surface
   ([elements.md](elements.md#glarea)).
2. **Capture phase**: `on<Event>Capture` handlers from the window down to
   the target.
3. **Target + bubble phase**: `on<Event>` handlers from the target up.
4. **Default action**: the element's built-in behaviour (textinput editing,
   wheel scrolling, then Tab traversal) — skipped if any handler called
   `ev.preventDefault()`.

`ev.stopPropagation()` stops the walk. Handlers always read current props.
Step 4 is open to elements added with `registerElement`, through the same
`defaultKeyDown` / `defaultMouseDown` / `defaultMouseMove` / … methods
([extending.md](extending.md#behaviour-of-your-own)). For the wheel, the node
under the pointer gets `defaultWheel` first (a pane that zooms), then the
scroll chain asks each node outward `canScroll(deltaX, deltaY)`
([extending.md](extending.md#scrolling-content-you-painted)).

### When the response is painted

**Discrete input** — `mouseDown`/`mouseUp`, `keyDown`/`keyUp`, focus, blur,
the window manager's close request — paints in the same turn of the event
loop, once the default action, your handlers and React's update have all
run: one frame, never a half-updated one. A burst faster than frames are
acknowledged folds into one catch-up frame.

**Motion and the wheel stay on the frame clock**: `mouseMove` (and the hover
it drives) coalesces to at most one per frame, keeping the newest position;
wheel events coalesce by _adding up_, so one event carries the frame's whole
distance.

**Hover follows content.** After a frame that laid out — every frame of a
scroll — the window re-hit-tests the pointer's last position, as a browser
does: `:hover`, `onMouseEnter` and `onMouseLeave` update, and the node under
the pointer hears `defaultMouseMove` (so self-painted hover re-reads what it
is over). `onMouseMove` is not called, and nothing changes while a press or
capture holds the pointer or after it has left the window.

**On macOS, hover belongs to the active window**, as in AppKit and the
browsers there. A Cocoa window that loses the keyboard hears `onMouseLeave`
down its hover path, `:hover` comes off, a self-painting element hears
`defaultMouseLeave`, and no motion, enter, cursor or attention follows until
it is active again — when hover returns at the pointer without waiting for a
move. `<window onMouseOut>` is not called. "Active" is the focus's answer
([Window focus](#window-focus)): a window whose `<Dialog>` holds the keyboard
still hovers, and an unmanaged `<popup>` (menu, dropdown, tray popover)
always does. Presses still land where aimed and the wheel scrolls a
background window. On X11, Wayland and Windows windows hover without the
keyboard, as every toolkit there does. Design notes:
[design/events.md](../design/events.md#when-the-response-is-painted).

### When a handler throws

**No error boundary can catch it**: a handler runs from an X event, with
React not on the stack. The dispatcher catches it, reports the element, the
handler name and the component that rendered the node, sets
`process.exitCode = 1` (so CI and a supervisor still see it), and **dispatch
continues** — one bad handler must not stop the handlers after it, or the
frame loop.

```
react-x11: onClick on <box> in Panel threw. It ran from an X event rather
than a render, so no error boundary could catch it; dispatch continues.
```

`onDrop` may be `async`; a promise it rejects with arrives here too (same
message, not an unhandled rejection, which node exits on) and refuses the
drop ([drag-and-drop.md](drag-and-drop.md#the-drop)).
`createRoot({ onUncaughtError })` takes over completely — for a kiosk,
crashing loudly is correct:

```js
const root = await createRoot({
  onUncaughtError: (error, info) => {
    telemetry.report(error, info.componentStack);
    process.exit(1);
  },
});
```

## Event object

```
{
  type, target, currentTarget,      // public instances
  x, y,                             // window coordinates
  localX, localY,                   // target-relative
  nativeEvent,                      // the raw ntk/X11 event
  shiftKey, ctrlKey,                // on every event, not just keys
  altKey, metaKey,                  // Mod1 and Mod4 — see Modifiers below
  preventDefault(), stopPropagation(),
  capturePointer(), releasePointer(),   // see Pointer capture below
  // mouse: button, detail (DOM-style click count: 2 = double, 3 = triple)
  // wheel: deltaX, deltaY (pixels), smooth
  // keyboard: keycode, keysym, group, codepoint, key, composing
  // composition: data
}
```

- `x`/`y`/`localX`/`localY` and the wheel deltas are logical pixels in **the
  target's** unit: the display scale times any `scale` prop above it
  ([scale.md](scale.md#a-subtree-of-its-own)). A handler on an unzoomed
  ancestor reads the zoomed target's pixels; `ev.nativeEvent.x`/`y` are the
  window's own.
- `ev.screenX`/`screenY`: the pointer on the virtual screen in the same
  logical pixels — what to anchor a `<popup>` at. Undefined without a
  pointer position. `nativeEvent.rootx`/`rooty` is the same point in
  **device** pixels, the unit of a node's `abs`; use it only for geometry
  against `abs` ([scale.md](scale.md)).
- `detail` counts a multi-click within the desktop's double-click time and
  distance ([system.md](system.md#usedesktopsettings--how-the-desktop-wants-an-app-to-feel)),
  timed by the presses' own `nativeEvent.time`, so a slow first render does
  not break a double click. win32 presses carry no time and are timed as
  handled.
- On the Wayland backend a finger or tablet tool drives the mouse events,
  which then carry `nativeEvent.pointerType` (`'touch'`, `'pen'`, `'eraser'`,
  `'mouse'`) and `pressure`, `tiltX`/`tiltY`, `rotation`, `distance`,
  `tangentialPressure` in the DOM's ranges; a mouse adds nothing. Raw
  `touchstart`/`touchmove`/`touchend`/`touchcancel` arrive on the window
  (`wnd.on(...)`, not React props) — [wayland-backend.md](wayland-backend.md).

**Read a Ctrl chord from the keysym, not the code point.** `codepoint` comes
from the _shifted_ keysym (Ctrl+Shift+Z is `Z`, Ctrl+Z is `z`).
`ctrlChordLetter(ev)` from `react-x11/keysyms` gives the lowercase keysym
either way, as `<textinput>` uses for Ctrl+C/V/Z, and keeps working under a
Cyrillic or Greek layout ([Layouts](#layouts)). For most chords,
[Accelerators](#accelerators) is shorter.

```js
onKeyDown={(ev) => {
  if (ev.ctrlKey && ctrlChordLetter(ev) === keysymOf('d')) duplicateLine();
}}
```

### Modifiers

Four booleans with DOM names, on **every** event — a shift+click, an
Alt+drag and a Super+wheel all need them:

| property   | X11 modifier | usually |
| ---------- | ------------ | ------- |
| `shiftKey` | Shift        | Shift   |
| `ctrlKey`  | Control      | Ctrl    |
| `altKey`   | Mod1         | Alt     |
| `metaKey`  | Mod4         | Super   |

```js
onKeyDown={(ev) => {
  if (ev.altKey && ev.keysym === keysymOf('b')) wordLeft();
}}
```

Mod1/Mod4 as Alt/Super is the convention every toolkit reads, not protocol.
For a keymap that disagrees, `ev.nativeEvent.buttons` is the raw mask and
`MOD` in `react-x11/keysyms` names its bits (`MOD.Mod3`, `MOD.Lock` for Caps
Lock, …).

### The primary modifier {#primary-modifier}

**On the Cocoa backend the editing chords are ⌘, not Ctrl.** ⌘ arrives as
`metaKey`, and `app.primaryModifier` is `'Super'` there and absent elsewhere
(X11 under XQuartz included). The built-in editors read it: `<textinput>`'s
Undo, Cut, Copy, Paste and Select All are ⌘Z, ⌘X, ⌘C, ⌘V, ⌘A, Redo is ⇧⌘Z,
and the context menu prints them so. A ⌃ or ⌘ chord the field does not answer
is never typed as text. Ask the same question with `primaryModifierHeld`:

```js
import { ctrlChordLetter, keysymOf, primaryModifierHeld } from 'react-x11/keysyms';

onKeyDown={(ev) => {
  if (primaryModifierHeld(ev, app) && ctrlChordLetter(ev) === keysymOf('d'))
    duplicateLine();
}}
```

Menus and accelerators follow the same rule: `Control` in a `shortcut` means
⌘ there ([globalmenu.md](globalmenu.md#shortcuts-are-a-list-not-a-string),
[The chord](#the-chord)), so `useAccelerator([['Control', 'K']])` is ⌘K and a
drawn `ContextMenu` prints and answers `⌘S`.

Where shortcuts are ⌘, `<textinput>` and `<textarea>` also move and delete
with AppKit's bindings:

| keys                   | does                                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| ⌥← ⌥→                  | a word back or forward                                               |
| ⌘← ⌘→, and ⌃← ⌃→       | the start or end of the line                                         |
| ⌘↑ ⌘↓                  | the start or end of the value                                        |
| ⌥↑ ⌥↓                  | the start or end of the paragraph, and on to the next                |
| ↑ ↓ in a `<textinput>` | its start and its end, as in an NSTextField                          |
| ⌥⌫ ⌥⌦                  | delete a word                                                        |
| ⌘⌫                     | delete to the start of the line                                      |
| ⌃⌫                     | take the accent off the character before the caret — é to e          |
| ⌃A ⌃E                  | the start or end of the paragraph                                    |
| ⌃B ⌃F, ⌃P ⌃N           | a character back or forward, a line up or down                       |
| ⌃H ⌃D                  | delete a character back or forward                                   |
| ⌃K ⌃Y                  | kill to the paragraph's end (its break, if at the end); yank it back |

Shift extends the selection. "Line" is the drawn, wrapped line; "paragraph"
runs between line breaks; in a `<textinput>` both are the whole value.
Elsewhere the bindings are GTK's, Qt's and Windows' (Ctrl+←/→ and Ctrl+⌫/⌦ by
word, Ctrl+A select all) — never a mix. Home and End go to the ends of the
line on every backend.

⌃K's kill buffer is the app's, not the pasteboard: ⌘C's copy is untouched,
⌃Y in one field yanks what ⌃K killed in another, and consecutive kills add
up. A `sensitive` field kills into nothing. All of these are the field's
default action, so `preventDefault()` in `onKeyDown` keeps the key.

## Handlers

| handler                                                           | notes                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `onClick`                                                         | on the nearest common ancestor of press & release; `detail` counts clicks                        |
| `onMouseDown` / `onMouseUp` / `onMouseMove`                       | move is coalesced to once per frame                                                              |
| `onMouseEnter` / `onMouseLeave`                                   | do not propagate; hover-path diffing, on motion and when content scrolls under the pointer       |
| `onWheel`                                                         | pixels ([below](#wheel)); default action scrolls the nearest container with somewhere to go      |
| `onContextMenu`                                                   | right-click, after `onMouseDown`; default action opens the element's menu                        |
| `onKeyDown` / `onKeyUp`                                           | to the focused node (or window); defaults: Space/Enter click, [accelerators](#accelerators), Tab |
| `onCompositionStart` / `onCompositionUpdate` / `onCompositionEnd` | text still being typed — [below](#composition)                                                   |
| `onFocus` / `onBlur`                                              | focus follows mousedown (nearest `focusable` ancestor) and Tab                                   |
| `onDragEnter` / `onDragLeave`                                     | do not propagate; drag-path diffing, like hover                                                  |
| `onDragOver` / `onDrop`                                           | on a drop target; `onDrop` may be async — [drag-and-drop.md](drag-and-drop.md)                   |
| `onDragStart` / `onDrag` / `onDragEnd`                            | on a `draggable` node; the press is a click until it moves 4px                                   |

## Space and Enter are a click {#space-and-enter-are-a-click}

**An `onClick` on a focusable node is keyboard-operable with nothing else
written.** Space or Enter dispatches the whole press gesture — mousedown,
mouseup, click — so a `<box>` control behaves like a `<Button>`:

```jsx
<box focusable role="option" aria-selected={on} onClick={() => open(channel)}>
  <text>{channel}</text>
</box>
```

It is a **default action**, so:

- `preventDefault()` in the node's `onKeyDown` keeps the key (a disclosure
  that opens on Enter while its click only selects);
- a node with no `onClick` is untouched whatever its `role` —
  `role="button"` with only `onKeyDown` stays yours;
- `<textinput>` and `<textarea>` never activate: Space types a space;
- **a scroll pane keeps Space**: Space and Shift+Space page a scrolling
  `<box>` ([elements.md](elements.md#scrolling)), so a clickable pane pages
  with Space and activates with Enter. A focused row _inside_ a pane is
  unaffected;
- **a chord is not a press**: with Ctrl, Alt or Super (⌘, ⌃, ⌥ on Cocoa)
  held, Space and Enter go to whoever bound them, e.g. a menu's Ctrl+Return.

Shift travels: the click carries the key's modifier mask, so Shift+Enter is a
shift-click. Assistive-technology activation goes through the same function
([accessibility.md](accessibility.md#at-driven-controls)).

## Accelerators {#accelerators}

**A menu's `shortcut` is a binding.** `MenuBar` and `ContextMenu` answer
their items' chords while mounted, unopened:

```jsx
<MenuBar
  menus={[
    {
      label: 'File',
      items: [
        { label: 'Save', shortcut: [['Control', 'S']], onSelect: save },
        {
          label: 'Save As…',
          shortcut: [['Control', 'Shift', 'S']],
          onSelect: saveAs,
        },
      ],
    },
  ]}
/>
```

The same array is announced as `aria-keyshortcuts` and crosses the bus when
a desktop panel draws the menu ([globalmenu.md](globalmenu.md)); it stays
bound then, since the key is still pressed in your window. (The macOS menu
bar answers its ⌘ chords itself — [below](#the-macos-menu-bar).) For a
shortcut in no menu, `useAccelerator` takes the same chords:

```jsx
import { useAccelerator } from 'react-x11';

useAccelerator([['Control', 'K']], () => openPalette());
```

### The chord

`[['Control', 'S'], ['F2']]` is dbusmenu's `aas`: **alternatives**, each
modifier tokens (`Control`, `Alt`, `Shift`, `Super`) ending in the key. Any
alternative fires; only the first is drawn. Keys use X keysym names (as
`gdk_keyval_name()` emits): `plus` not `+`, `Prior` not `PgUp`, `Return` not
`Enter`; a one-character name is that character. `keysymFromName()` in
`react-x11/keysyms` resolves names, and
`matchesShortcut(ev, shortcut, { primary })` matches, for apps dispatching
chords their own way.

**`Control` is the app's primary modifier**: ⌘ on the Cocoa backend (what a
drawn row prints, `⌘S`, `⇧⌘Z`, and what it answers —
[The primary modifier](#primary-modifier)), Ctrl elsewhere. `Super` is ⌘
there too, so a chord cannot ask for ⌃ on a Mac. `matchesShortcut` is pure,
so it takes the answer as an option:

```js
import { matchesShortcut } from 'react-x11';
import { primaryModifier } from 'react-x11/keysyms';

matchesShortcut(ev, [['Control', 'S']], { primary: primaryModifier(app) });
```

Matching is:

- **exact on the four modifiers**, the primary one included: Ctrl+S does not
  fire on Ctrl+Shift+S, nor ⌘S on ⌃⌘S.
- **indifferent to Caps Lock and Num Lock.**
- **by key, not character**: against `ev.keysym`, the Latin keysym of the
  physical key, so a chord survives a layout switch ([Layouts](#layouts)) and
  `'s'`/`'S'` are one binding. A chord naming a **symbol** also matches the
  character produced (`+` is shifted `=`, and `[['Control', 'plus']]` must be
  pressable); letters never do, or Ctrl+Shift+S would fire Ctrl+S.
- **gated by `enabled` and `visible`**, including a disabled parent
  submenu's.

### Who gets the key first

Accelerators sit in the default-action chain, and `preventDefault()` stops it
at any step:

1. the application's own `onKeyDown`, capture then bubble;
2. composition — a dead key, a Compose sequence;
3. the focused element's own behaviour (`<textinput>` editing, a scroll pane's
   page keys);
4. **accelerators**;
5. focus traversal, for Tab.

So **a focused text field keeps the chords it answers** (Ctrl+C copies the
selection, never reaching a menu's Ctrl+C) and passes the rest (Ctrl+S
reaches the menu). A `<textinput>` answers Return and Shift+Return with
`onSubmit`; Ctrl, Alt or Super+Return (⌘↩ on Cocoa) are chords and reach the
menu. With **no** `onSubmit` it does not answer Return at all, so a form's
`[['Return']]` default button gets it. A `<textarea>` keeps Return and
Shift+Return for the newline and Ctrl+Return (⌘↩) for `onSubmit` if it has
one; Alt and Super+Return are chords, except on Cocoa, where ⌃↩ and ⌥↩ are
AppKit's newline.

Nothing fires while:

- **a menu is open** (it holds a pointer grab);
- **a modal `<popup>`** (`trapFocus`, as `Dialog` sets) is up — Ctrl+S under
  a confirmation saves nothing. A menu declared _inside_ the modal still
  works, as Tab traversal does, and `useAccelerator`'s `scope` joins a hook
  binding to it:

  ```jsx
  const inDialog = useRef(null);
  useAccelerator([['Control', 'Return']], confirm, { scope: inDialog });
  ```

A chord belongs to the window whose menu declared it; another top-level
window does not answer it. `enabled: false` unbinds one; `accelerators={false}`
on a `MenuBar` or `ContextMenu` turns the whole mechanism off for an app with
its own dispatcher. **An app with no `<window>`** (a menu-bar app) binds
against the root-level `<popup>` that took the keyboard
([elements.md](elements.md#a-popover-under-a-tray-item)); a binding with
neither warns once in development and names `scope`.

### The macOS menu bar {#the-macos-menu-bar}

On the Cocoa backend the system draws a `MenuBar`
([globalmenu.md](globalmenu.md)) and runs an item on its ⌘ chord itself,
after the window has seen the key, wherever it can spell the chord as a key
equivalent (one chord on a character key). Those chords are **reserved**: the
window's accelerators — the bar's own binding or a `useAccelerator` on the
same chord — never see them, and the item runs once. A chord it cannot spell
(a function key, a second alternative, `plus`) or one without `Control` or
`Super` stays the window's. Steps 1 and 3 above run first and AppKit still
runs the item afterwards, so an `onKeyDown` or a focused field answering ⌘C
beside an Edit menu's ⌘C runs alongside it, `preventDefault()` or not —
leave a chord the menu bar shows to the menu bar.

## The wheel {#wheel}

`ev.deltaX` / `ev.deltaY` are **pixels**, positive down and right; one wheel
notch is 48 — the step an arrow key takes. On X11 with XI2 they are the
distance the device measured, so a touchpad reports fractions (`14.5`, not
`48` twice a second); without XI2 every event is one whole notch.

```jsx
<box
  style={{ overflow: 'scroll' }}
  onWheel={(ev) => {
    ev.deltaY; // pixels — fractional from a touchpad
    ev.smooth; // whether the device can report a fraction at all
  }}
/>
```

`ev.smooth` is the kind of device, not of this delta: `true`, the next event
may be a third of a notch; `false`, an emulated button that only ever says
one. Branch on it to animate scrolling — ease towards a whole notch, never a
stream of measured pixels.

**Nothing is opted into.** A `<window>` selects XI2 on its first scroll (it
costs pointer-motion traffic, so windows that never scroll never pay) and
falls back to buttons where the server has none. A `<popup>` stays on
buttons, since it holds a pointer grab, so an open menu scrolls a notch at a
time. `<window xi2>` selects at creation, for a touchpad app that wants its
very first flick smooth; `<window xi2={false}>` never selects. Design notes:
[design/events.md](../design/events.md#wheel).

Shift turns a vertical scroll sideways on a one-axis device; a device with
its own horizontal axis keeps it. The default action is the hit node's
`defaultWheel`, then the scroll chain
([extending.md](extending.md#behaviour-of-your-own),
[extending.md](extending.md#scrolling-content-you-painted)).

## Composition: dead keys and Compose {#composition}

`é` is not a key: on a French, German or us-intl layout it is `dead_acute`
then `e`, and a dead key has **no code point** — code typing from
`ev.codepoint` drops the accent. Test text input on such a layout, not only
US. A composition is text still being typed: it shows underlined at the
caret, and is not the value until it commits:

```
dead_acute        →  the field shows ´ (underlined). value unchanged.
e                 →  the field shows é. value is now …é, one undo step.
```

On by default, no configuration:

| you press                          | you get                                           |
| ---------------------------------- | ------------------------------------------------- |
| `dead_acute` `e`                   | `é` — and any base letter, in any script          |
| `dead_circumflex` `dead_acute` `e` | `ế` — dead keys stack                             |
| `dead_acute` space                 | `´` — the accent on its own                       |
| `dead_acute` `q`                   | `´q` — no such character, so nothing is swallowed |
| Compose `o` `c`                    | `©`                                               |
| Compose `'` `e` (or `e` `'`)       | `é`                                               |
| Compose `-` `-` `-`                | `—`                                               |
| Escape mid-sequence                | nothing typed, and the accent goes away           |

Dead keys use Unicode composition, so `dead_breve` + `и` is `й` and
`dead_acute` + `α` is `ά`; only what Unicode has no rule for is tabled
(`dead_stroke` + `o` is `ø`, and the `Multi_key` sequences).

### Handling it yourself

The three events mirror the DOM's: `data` is empty on start, the text at the
caret on each update, and the **committed text** at the end (empty if
abandoned).

```jsx
<textinput
  onCompositionUpdate={(ev) => setStatus(`composing ${ev.data}`)}
  onCompositionEnd={(ev) => setStatus('')}
/>
```

**A key the composition took carries no text**: `ev.key` and `ev.codepoint`
are `undefined` and `ev.composing` is true (its text comes on the
composition event), but the keysym is there, so chords still match. The order
is **application chords → composition → the element → focus traversal**:
`preventDefault()` in `onKeyDown` hides a key from the composer, and a key
the composer takes never reaches the element — a dead key cannot fire an
accelerator, nor a Compose `z` undo. A composition is abandoned, never
half-committed, when focus leaves, the window loses the keyboard, or a press
moves the caret. Screen readers hear the committed character, not the accent
([accessibility.md](accessibility.md#while-a-composition-is-open)).

### Input methods

The [Wayland backend](wayland-backend.md)'s compositor input method (IBus
under GNOME, via `zwp_text_input_v3`) and the Windows IME (IMM32) drive the
same three events: preedit on `onCompositionUpdate`, the commit on
`onCompositionEnd`, inserted like typing. Only there:

- `ev.cursorBegin` / `ev.cursorEnd` on an update — code-point offsets into
  `data` for the engine's cursor or the segment being converted (drawn with
  a heavier underline). A dead key never sets them.
- a commit with no preedit (an emoji picker) is a start and an end in one.

Keys the input method consumes never reach the app, nor the client-side
table. `<textinput sensitive>` offers it none of its text, and `inputMode`
tells it what to expect ([elements.md](elements.md#textinput)).

The **Cocoa backend has no input method yet**: ⌥E (a dead key) types and
shows nothing, the next key types what macOS put there (`é`, or the bare
letter), and a key that typed several characters (`´s`) commits them as one
composition. Press-and-Hold accents and CJK input are not available there
yet.

### Changing the table

```js
import { XK_MULTI_KEY } from 'react-x11/keysyms';

const root = await createRoot({
  compose: {
    // this machine's Compose file, which is how a personal ~/.XCompose is
    // picked up — usually absent on macOS, where nothing is lost
    file: 'system',
    sequences: [[[XK_MULTI_KEY, 'l', 'd'], '🦆']],
  },
});
```

`compose: 'system'` is shorthand for the file alone; `compose: false` turns
composition off for an app that does its own. Later definitions override
earlier ones. The format is X's; `include` is ignored, and lines naming
keysyms outside ASCII and the dead-key block (`<Greek_alpha>`) are skipped.
**On X11 this is not an input method** — no preedit from another process, no
candidate list — so CJK input there needs XIM or an IBus/Fcitx client, which
react-x11 does not have yet.

## Layouts {#layouts}

A key event answers two questions, differently under a non-Latin layout:

- **what the key typed** — `ev.key` and `ev.codepoint`, from the active
  layout and level. A Cyrillic layout types Cyrillic.
- **what the key is called** — `ev.keysym`, the **Latin** keysym for that
  key, whichever group holds it, because shortcuts do not move with the
  layout (GTK, Qt and browsers agree): Ctrl+Z keeps undoing in Russian.

So `ctrlChordLetter(ev) === keysymOf('z')` matches the physical Z key under
every layout. `ev.group` is the active XKB group (0–3), for showing which
layout is live; a switch sends no other notice. Under XQuartz, layout
switches reach X only with Preferences → Input → "Follow system keyboard
layout" on. Design notes: [design/events.md](../design/events.md#layouts).

**⌥ types, on the Cocoa backend**: it is the layout's third and fourth level
(⌥S is `ß` on US; on German ⌥L is `@`, ⌥5 and ⌥8 `[` and `{`). `ev.key` and
`ev.codepoint` are what was typed, with ⌥, Shift and Caps Lock applied, while
`ev.keysym` is still the key (`s`) and `ev.altKey` is true — an Alt+S
accelerator matches and a field types `ß`. A ⌘ or ⌃ chord types nothing and
is named by its key (⌘⌥S is a chord on S), as in the DOM on a Mac.

```js
const root = await createRoot({
  // 'latin' is the default; 'layout' reports the keysym the layout put on
  // the key, for an app matching shortcuts its own way
  accelerators: 'layout',
});
```

`accelerators` also takes a keycode→keysym table (`{ 52: 'z' }`) for a
server whose keycodes are neither evdev's nor macOS's. **The AltGr row is not
reachable** on X11: `ev.keysym` and `ev.codepoint` read groups only.

## Pointer capture

`ev.capturePointer()` routes every following `mousemove` and `mouseup` to
the capturing node, so a drag keeps working past the widget and a release
far outside still ends it. `Slider` is built on it:

```jsx
onMouseDown: (ev) => {
  ev.capturePointer();
  setDragging(true);
},
onMouseMove: (ev) => { if (dragging) setValue(valueAt(ev)); },
onMouseUp: () => setDragging(false),
```

Capture ends on `mouseup` (like the DOM's implicit capture), when the node
unmounts, or on `ev.releasePointer()`. While captured, hover stays put.

## Focus

`focusable` opts a node in (`<textinput>` and a scroll container with
somewhere to scroll are focusable by default); `disabled` opts it out
whatever else it says; `autoFocus` focuses at mount. Every drawn node's ref
has `focus()` (which returns the node, for forwarding from an imperative
handle), `blur()`, `focused`, and `focusWithin` — focus on the node **or
inside it**; `':focus-within'` draws that
([styling.md](styling.md#inline-pseudo-states)). Mousedown focuses the
nearest focusable ancestor of the hit node; keyboard events route up the
focused node's ancestor chain. Focusing a node in a scroll container scrolls
it into view, unless a press focused it.

**A focused node shows a ring** depending on how focus arrived: a press sets
`:focus`; Tab, `autoFocus`, `node.focus()` or a modal handing focus back
also set `:focus-visible`, which the ring is drawn on. A press on a **text
control** sets both. No opt-in;
[styling.md](styling.md#the-focus-ring) restyles it.

### Tab order

`tabIndex` follows the DOM's rules:

- **positive** `tabIndex` first, ascending;
- then everything focusable without one (the implicit `0`), in tree order;
- `tabIndex={-1}` is focusable by a press or `focus()`, never by Tab;
- an explicit `tabIndex` makes a node focusable without `focusable`.

Tab from a node outside the order (`tabIndex={-1}`, or outside the current
focus scope) starts from the beginning.

```jsx
<box tabIndex={1} />   {/* visited first  */}
<box tabIndex={2} />   {/* then this      */}
<box focusable />      {/* then tree order */}
<box tabIndex={-1} />  {/* clickable, never tabbed to */}
```

Traversal is the last **default action**: `preventDefault()` on Tab keeps
it, as does an element whose `defaultKeyDown` consumes it (an editor
indenting) — which then owes the user the Escape-arms-one-Tab way out
([extending.md](extending.md#behaviour-of-your-own)).

### Focus scopes (modals)

`trapFocus` makes a node own a **focus scope**. While it is the innermost:

- Tab / Shift+Tab visit only focusables inside it;
- a press outside does not move focus (the press still dispatches — pair it
  with `grab` + `onDismiss` for a real modal);
- when it unmounts, focus returns to whatever had it before it opened.

```jsx
function Dialog({ open, x, y, onClose }) {
  if (!open) return null;
  return (
    <popup
      trapFocus
      grab
      x={x}
      y={y}
      width={280}
      height={120}
      onDismiss={onClose}
    >
      <textinput autoFocus />
      <Button label="OK" onPress={onClose} />
    </popup>
  );
}
```

Scopes nest; the innermost wins, and closing it hands focus back to the
outer. Programmatic `focus()` is never blocked — the trap is about Tab and
presses.

### Focus inside a `<popup>`

A popup never holds input focus itself: its **owner window** does, and a
node inside the popup can be that window's focused node. Keys arrive at the
owner and bubble out through the popup's place in the JSX tree. A press in a
popup on nothing focusable leaves focus alone — which is how menus and
`Select` keep the trigger handling keys while open. A popup with no owner (a
tray popover in a windowless app) takes keys itself with `grabKeyboard`
([elements.md](elements.md#a-popover-under-a-tray-item)).

### Window focus

Node focus is per `<window>`; whether the window gets the keys is the window
manager's call, reported by `<window onFocus>` / `<window onBlur>`. In an
unfocused window the focused node **keeps** focus (as
`document.activeElement` does) but stops looking active: a `<textinput>`
caret stops blinking until the window is focused again. `focus()` in an
unfocused window asks for the input focus; the window manager may refuse.

A key goes to **the node that has focus**, whichever of a top-level's windows
(nested `<window>`, `<popup>`) it arrived at; with several focused nodes, the
last focused answers. "Unfocused" is the **focus's** answer, not one
window's: a `<popup>` shares its owner's focus, a managed `<Dialog>` is
focused by the window manager in its own right, and the caret follows
whichever holds the keyboard. `focus()` inside an open dialog does not ask
for input focus — the dialog has it.

### Focus and visibility

**Focus follows visibility.** A subtree leaving the screen — a `<Suspense>`
fallback, `<Activity mode="hidden">`, `display: 'none'`, an unmapped
`<popup>` — gives up the keyboard: the focused node fires `onBlur`,
`:focus`/`:focus-within` come off, and keys go to the window, so a hidden
control never collects keystrokes. Tab skips invisible nodes.

**And it comes back with it**, ring and all, when the subtree is revealed —
but only if **nothing else has the keyboard** by then, and as a restore: no
scrolling into view and no request for the window system's focus, so a
background window never takes the keyboard from another app.
`createRoot({ restoreFocusOnReveal: false })` turns the restore off (focus
that fell to nothing stays there, as in a browser); the release always
happens.

## Cursors

The `cursor` style property (`'pointer'`, `'text'`, `'wait'`, `'move'`,
`'crosshair'`, `'ew-resize'`, `'ns-resize'`, `'grab'`, `'not-allowed'`, …) of
the deepest hovered node applies to the window. `cursor: 'none'` hides the
pointer (the kiosk case) — unlike naming no cursor anywhere, which inherits
the root window's visible one.

## Drag and drop {#drag-and-drop}

Drag and drop rides this event system — same hit testing, capture/bubble
dispatch and style states — on any drawn element, `<window>` or `<popup>`:

```jsx
<box
  dropAccept={['files']}
  onDrop={(e) => setPaths(e.files.map((f) => f.path))}
  style={{ ':drag-over': { borderColor: '$accent' } }}
/>
```

| handler                                | notes                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `onDragEnter` / `onDragLeave`          | do not propagate — path diffing, like hover; paired with `':drag-over'`   |
| `onDragOver`                           | per pointer position; `e.accept(action)` / `e.reject()` answer the source |
| `onDrop`                               | may be async — the reply waits for the promise, bounded by a watchdog     |
| `onDragStart` / `onDrag` / `onDragEnd` | the source side of a `draggable` node; `':dragging'` styles it meanwhile  |

A press on a `draggable` node is a **click** until it moves 4px, and a
completed drag suppresses the click, as in the DOM. A drag leaving the app's
windows becomes the platform's own — XDND on X11, AppKit dragging on Cocoa,
the data device on Wayland, OLE on Windows — and drops into a file manager,
an editor or another react-x11 process with the handlers unchanged.

**Full reference: [drag-and-drop.md](drag-and-drop.md)** — `dropAccept`
matching, the payload (`e.files`, `e.text`, `e.getData`, `e.items`),
`dragData` and lazy payloads, `useDropTarget`/`useDragSource`, previews, GTK
and Firefox interop, and driving a drag in a test.
