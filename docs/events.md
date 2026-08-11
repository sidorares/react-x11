# Events

ntk delivers raw X11 events per window; react-x11 turns them into synthetic
events dispatched over the drawn node tree with DOM-like semantics.

## Dispatch

1. **Hit test**: front-to-back walk of the stacking-ordered tree (zIndex,
   then document order), respecting `overflow` clipping and
   `pointerEvents="none"`.
2. **Capture phase**: `on<Event>Capture` handlers from the window down to
   the target.
3. **Target + bubble phase**: `on<Event>` handlers from the target up.
4. **Default action**: the element's built-in behavior (textinput editing,
   wheel scrolling, then Tab traversal) — skipped if any handler called
   `ev.preventDefault()`.

Step 4 is a documented seam, not a privilege of the built-in elements: an
element added with `registerElement` implements the same `defaultKeyDown` /
`defaultMouseDown` / … methods and gets the same ordering
([extending.md](extending.md#behaviour-of-your-own)).

`ev.stopPropagation()` stops the walk. Handlers always read from current
props — they can never go stale.

### When the response is painted

**Discrete input paints from its own handler**, in the same turn of the
event loop as the press — not on the next frame. A click has exactly one
visual answer (a button darkens, a caret lands, focus moves), so there is
nothing a frame's wait could coalesce it with, and waiting would charge it
up to a frame interval plus a server round trip on top of a paint that
measures in the hundreds of microseconds. The dispatcher therefore lands
React's discrete-priority commit and paints once the whole dispatch has
unwound — the default action, your handlers and React's update all in one
pass, never a half-updated frame followed by a second one.

Discrete means everything ntk does not coalesce: `mouseDown`/`mouseUp`,
`keyDown`/`keyUp`, the wheel, focus and blur, and the window manager's close
request.

**Motion stays on the frame clock.** `mouseMove`, and the hover
enter/leave work it drives, are the opposite case — the pointer reports at
device rate and only the newest position matters — so they coalesce to at
most one repaint per frame, as before.

Bursts of discrete input stay bounded by the same mechanism. While the
server has not acknowledged the last frame, the response goes back to the
paced path: spin a wheel and the first notch paints immediately while the
rest fold into one catch-up frame. Update instantly, then catch up.

This needs ntk 5.2.0 or newer, which publishes the `frameInFlight()` gate
the decision is made with. On an older ntk everything still works; the
response simply waits for the next frame, as it did before.

### When a handler throws

**No error boundary can catch it.** A boundary only sees throws React
itself invoked, and a handler runs from an X event, so React is not on the
stack. react-x11 therefore catches it at the dispatcher: the error is
reported with the element, the handler name and the component that rendered
the node, `process.exitCode` is set to 1 so the crash is still visible to CI
and to a supervisor, and **dispatch continues** — one bad tooltip handler
must not stop the handlers after it, or the frame loop.

```
react-x11: onClick on <box> in Panel threw. It ran from an X event rather
than a render, so no error boundary could catch it; dispatch continues.
```

`onDrop` is the one handler that may be `async`, and a promise it rejects
with arrives here too — same message, same channel — rather than becoming an
unhandled rejection, which node exits on. It also refuses the drop; see
[drag-and-drop.md](drag-and-drop.md#the-drop).

`createRoot({ onUncaughtError })` takes it over completely, which is the
point of it being overridable: for a kiosk, crashing loudly is correct.

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
  preventDefault(), stopPropagation(),
  capturePointer(), releasePointer(),   // see Pointer capture below
  // mouse: button, detail (DOM-style click count: 2 = double, 3 = triple)
  // wheel: deltaX, deltaY
  // keyboard: keycode, keysym, codepoint, key, composing
  // composition: data
}
```

`nativeEvent.rootx/rooty` are screen coordinates — useful for anchoring a
`<popup>` at the pointer.

**A Ctrl chord is read from the keysym, not the code point.** `codepoint`
comes from the _shifted_ keysym, so Ctrl+Shift+Z arrives as `Z` and Ctrl+Z as
`z`; a handler that compares code points misses half of its own shortcut.
`ctrlChordLetter(ev)` from `react-x11/keysyms` answers with the lowercase
keysym either way — it is what `<textinput>` reads Ctrl+C/V/Z with, and it is
exported because any widget with a chord of its own needs the same rule:

```js
onKeyDown={(ev) => {
  if (ev.ctrlKey && ctrlChordLetter(ev) === keysymOf('d')) duplicateLine();
}}
```

## Handlers

| handler                                                           | notes                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `onClick`                                                         | fires on the nearest common ancestor of press & release; `detail` counts multi-clicks      |
| `onMouseDown` / `onMouseUp` / `onMouseMove`                       | move is coalesced to once per frame by ntk                                                 |
| `onMouseEnter` / `onMouseLeave`                                   | do not propagate; synthesized by hover-path diffing                                        |
| `onWheel`                                                         | X buttons 4–7; default action scrolls the nearest scroll container with somewhere to go    |
| `onContextMenu`                                                   | right-click (button 3), after `onMouseDown`; default action opens the element's menu       |
| `onKeyDown` / `onKeyUp`                                           | delivered to the focused node (or the window); Tab cycles focus unless the element took it |
| `onCompositionStart` / `onCompositionUpdate` / `onCompositionEnd` | text still being typed — a dead key, a Compose sequence; see below                         |
| `onFocus` / `onBlur`                                              | focus follows mousedown (nearest `focusable` ancestor) and Tab traversal                   |
| `onDragEnter` / `onDragLeave`                                     | do not propagate; drag-path diffing, the same shape as the hover pair above                |
| `onDragOver` / `onDrop`                                           | on a drop target; `onDrop` may be async — [drag-and-drop.md](drag-and-drop.md)             |
| `onDragStart` / `onDrag` / `onDragEnd`                            | on a `draggable` node; the press is a click until it moves 4px                             |

## Composition: dead keys and Compose {#composition}

`é` is not a key. On a French, German or us-intl layout it is `dead_acute`
then `e`, and a dead key is a keysym with **no code point at all** — so a
renderer that types from `ev.codepoint` types the letter and drops the
accent. That is most accented input in Europe, and it is invisible to anyone
testing on a US layout (issue #272).

A composition is text the user is still typing. It shows at the caret,
underlined, and it is not the value until it commits:

```
dead_acute        →  the field shows ´ (underlined). value unchanged.
e                 →  the field shows é. value is now …é, one undo step.
```

Everything about it is on by default and needs no configuration:

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

The dead keys are Unicode's own composition rather than a table somebody
maintains, so `dead_breve` + `и` is `й` and `dead_acute` + `α` is `ά`
without anyone having written those down. What is written down is the part
Unicode has no rule for: `dead_stroke` + `o` is `ø`, and the `Multi_key`
symbol sequences, which are conventions rather than compositions.

### Handling it yourself

The three events mirror the DOM's. `data` is empty on the start, the text
showing at the caret on each update, and the **committed text** at the end —
empty when the sequence was abandoned.

```jsx
<textinput
  onCompositionUpdate={(ev) => setStatus(`composing ${ev.data}`)}
  onCompositionEnd={(ev) => setStatus('')}
/>
```

**A key an open composition took carries no text of its own.** `ev.key` and
`ev.codepoint` are `undefined` on it and `ev.composing` is true, because its
text arrives on the composition event instead — an application that types
from `onKeyDown` would otherwise insert `o`, `c` and then `©`. The keysym is
still there, so a chord still matches.

The order is **application chords → composition → the element → focus
traversal**: an `onKeyDown` that calls `preventDefault()` keeps its key and
the composer never sees it, and a key the composer does take never reaches
the element's `defaultKeyDown` — so a dead key cannot also fire an
accelerator, and a Compose sequence containing `z` cannot undo halfway
through.

A composition is abandoned, never half-committed, when focus leaves, when the
window loses the keyboard, or when a press puts the caret somewhere else.

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

`compose: 'system'` is the whole file shorthand, `compose: false` turns
composition off for an app that does its own, and later definitions win over
earlier ones — which is what makes a Compose file an override of the
built-ins rather than an addition beside them. Parsing is X's own format;
`include` directives are ignored, and a line naming keysyms outside ASCII
and the dead-key block (`<Greek_alpha>`, `<Cyrillic_a>`) is skipped rather
than guessed at.

**What this is not is an input method.** There is no preedit arriving from
another process and no candidate list, so CJK still needs XIM or an
IBus/Fcitx client — issue #272 tracks it. The events above are the surface it
will arrive on.

## Pointer capture

`ev.capturePointer()` routes every following `mousemove` and `mouseup` to
the capturing node instead of whatever is under the pointer, so a drag
keeps working past the widget's own bounds — and a release far outside it
still ends the gesture. This is what `Slider` is built on:

```jsx
onMouseDown: (ev) => {
  ev.capturePointer();
  setDragging(true);
},
onMouseMove: (ev) => { if (dragging) setValue(valueAt(ev)); },
onMouseUp: () => setDragging(false),
```

Capture is released automatically on `mouseup` (like the DOM's implicit
pointer capture) and when the capturing node unmounts; `ev.releasePointer()`
ends it early. While captured, hover stays where it was — dragging must not
light up every widget the pointer crosses.

## Focus

`focusable` opts a node into focus (`<textinput>` is focusable by
default, and so is a scroll container with somewhere to scroll), `autoFocus`
takes it at mount, and every drawn node has
`focus()` / `blur()` / `focused` on its ref — plus `focusWithin`, which is
true while focus is on the node **or inside it**, the question a modal asks
before taking focus itself. To _draw_ that rather than read it, there is a
`':focus-within'` style block
([styling.md](styling.md#inline-pseudo-states)), which is what a row
containing a field wants. `focus()` hands the node back, so a component
can forward it straight out of an imperative handle. Focusing a node inside a
scroll container scrolls it into view. Mousedown focuses the nearest
focusable ancestor of the hit node; Tab / Shift+Tab cycle through focusable
nodes in tree order. Keyboard
events route to the focused node's ancestor chain. `disabled` opts a node
back out of focus, whatever else it says.

**A focused node shows a ring**, and how focus arrived decides whether it
does. A press sets `:focus`; everything else — Tab, `autoFocus`,
`node.focus()`, a modal handing focus back as it closes — also sets
`:focus-visible`, and that is the state the ring is drawn on. It costs no
layout and needs no opt-in; see
[styling.md](styling.md#the-focus-ring) for restyling it.

### Tab order

`tabIndex` sets the sequential focus order, following the DOM's rules:

- nodes with a **positive** `tabIndex` come first, in ascending order;
- then everything focusable without one (the implicit `0` group), in tree
  order;
- `tabIndex={-1}` is focusable — by a press, and by `focus()` — but Tab
  never lands on it;
- an explicit `tabIndex` makes a node focusable without also passing
  `focusable`.

Tab out of a node that is not in the tab order (`tabIndex={-1}`, or a node
outside the current focus scope) and traversal starts from the beginning of
the order.

```jsx
<box tabIndex={1} />   {/* visited first  */}
<box tabIndex={2} />   {/* then this      */}
<box focusable />      {/* then tree order */}
<box tabIndex={-1} />  {/* clickable, never tabbed to */}
```

Traversal is a **default action** like any other, and it runs last: an
`onKeyDown` that calls `preventDefault()` on Tab keeps it, and so does an
element whose own `defaultKeyDown` consumes it — an editor indenting with
Tab. An element that does owes the keyboard user a way out of it, which is
the Escape-arms-one-Tab convention in
[extending.md](extending.md#behaviour-of-your-own).

### Focus scopes (modals)

`trapFocus` makes a node own a **focus scope**. While it is the innermost
scope:

- Tab / Shift+Tab only visit focusables inside it — the rest of the window
  is unreachable by keyboard;
- a press outside it does not move focus (poking at the window behind a
  modal is inert as far as focus goes — the press itself still dispatches,
  so pair it with `grab` + `onDismiss` for a real modal);
- when the scope unmounts, focus goes back to whatever had it before the
  scope opened — no bookkeeping in the widget.

That is a modal dialog, with the popup taking focus at mount:

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

Scopes nest (a modal opened from a modal); the innermost one wins, and
popping it hands focus back to the outer one. Programmatic `focus()` is
never blocked by a scope — the trap is about Tab and presses.

### Focus inside a `<popup>`

An override-redirect window never receives the X input focus, so a popup
cannot hold focus itself: the **owner window** does, and a node inside the
popup can be the focused node of that window. Keys arrive at the owner
window and are dispatched to it, then bubble out through the popup's
position in the JSX tree into the owner's handlers, so nothing has to
proxy them.

One consequence worth knowing: a press inside a popup that lands on nothing
focusable leaves the owner window's focus alone. Menus depend on it —
their rows are not focusable, and the trigger keeps handling keys while the
menu is open (`Menu`, `Select`).

### Window focus

Node focus is per `<window>`, and the window itself may or may not be the
one the X server sends keys to — that is the window manager's call.
`<window onFocus>` / `<window onBlur>` report it (ntk ≥ 3.7.0, X
`FocusIn`/`FocusOut`).

While the window is unfocused the focused node **keeps** focus, exactly as
`document.activeElement` survives a window blur in a browser — it just
stops looking active: a `<textinput>` caret stops blinking, and resumes
when the window is focused again. Calling `focus()` on a node in a window
that does not have the input focus asks for it (X `SetInputFocus`), though
a window manager is free to refuse.

## Cursors

The `cursor` style property (`'pointer'`, `'text'`, `'wait'`, `'move'`,
`'crosshair'`, `'ew-resize'`, `'ns-resize'`, `'grab'`, `'not-allowed'`, …)
applies the deepest hovered node's cursor to the window, via ntk's cursor
cache over the standard X cursor font.

`cursor: 'none'` hides the pointer (ntk ≥ 4.2.0) — the kiosk case. It is
the one name that is not a glyph in that font, so ntk builds it from an
empty 1×1 mask. Note it is **not** the same as setting no cursor at all:
with none of a node's ancestors naming one, the window inherits the root
window's cursor and the pointer stays visible.

## Drag and drop {#drag-and-drop}

Drag and drop rides this event system — same hit testing, same
capture/bubble dispatch, same style states — so the props sit alongside the
pointer handlers on any drawn element, `<window>` or `<popup>`:

```jsx
<box
  dropAccept={['files']}
  onDrop={(e) => setPaths(e.files.map((f) => f.path))}
  style={{ ':drag-over': { borderColor: '$accent' } }}
/>
```

| handler                                | notes                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `onDragEnter` / `onDragLeave`          | do not propagate — path diffing, like hover; paired with the `':drag-over'` state       |
| `onDragOver`                           | per pointer position; `e.accept(action)` / `e.reject()` answer the source               |
| `onDrop`                               | may be async — the protocol reply waits for the returned promise, bounded by a watchdog |
| `onDragStart` / `onDrag` / `onDragEnd` | the source side of a `draggable` node; `':dragging'` styles it for the duration         |

Two things that differ from the events above. A press on a `draggable` node
is still a **click** until the pointer moves 4px, and a completed drag
suppresses the click that would otherwise follow — the same bargain the DOM
makes. And a drag that leaves the app's own windows keeps working: it is
promoted to the X11 XDND protocol and can be dropped into a file manager,
an editor or another react-x11 process, with the handlers unchanged.

**The full reference is [drag-and-drop.md](drag-and-drop.md)**: the
`dropAccept` matching rules, the event payload (`e.files`, `e.text`,
`e.getData`, `e.items`), `dragData` and lazy payloads, the `useDropTarget`
and `useDragSource` hooks, drag previews, interoperating with GTK and
Firefox, and how to drive a drag in a test.
