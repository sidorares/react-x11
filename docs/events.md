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
   scrollview wheel scrolling) — skipped if any handler called
   `ev.preventDefault()`.

`ev.stopPropagation()` stops the walk. Handlers always read from current
props — they can never go stale.

## Event object

```
{
  type, target, currentTarget,      // public instances
  x, y,                             // window coordinates
  localX, localY,                   // target-relative
  nativeEvent,                      // the raw ntk/X11 event
  preventDefault(), stopPropagation(),
  capturePointer(), releasePointer(),   // see Pointer capture below
  // mouse: button, detail (DOM-style click count: 2 = double, 3 = triple)
  // wheel: deltaX, deltaY
  // keyboard: keycode, keysym, codepoint, key, shiftKey, ctrlKey
}
```

`nativeEvent.rootx/rooty` are screen coordinates — useful for anchoring a
`<popup>` at the pointer.

## Handlers

| handler                                     | notes                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `onClick`                                   | fires on the nearest common ancestor of press & release; `detail` counts multi-clicks |
| `onMouseDown` / `onMouseUp` / `onMouseMove` | move is coalesced to once per frame by ntk                                            |
| `onMouseEnter` / `onMouseLeave`             | do not propagate; synthesized by hover-path diffing                                   |
| `onWheel`                                   | X buttons 4–7; default action scrolls the nearest `<scrollview>`                      |
| `onKeyDown` / `onKeyUp`                     | delivered to the focused node (or the window); Tab cycles focus in `tabIndex` order   |
| `onFocus` / `onBlur`                        | focus follows mousedown (nearest `focusable` ancestor) and Tab traversal              |

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
default), `autoFocus` takes it at mount, and every drawn node has
`focus()` / `blur()` / `focused` on its ref. Focusing a node inside a
`<scrollview>` scrolls it into view. Mousedown focuses the nearest
focusable ancestor of the hit node; Tab / Shift+Tab cycle through focusable
nodes in tree order. Keyboard
events route to the focused node's ancestor chain. `disabled` opts a node
back out of focus, whatever else it says.

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

The `cursor` prop (`'pointer'`, `'text'`, `'wait'`, `'move'`,
`'crosshair'`, `'ew-resize'`, `'ns-resize'`, `'grab'`, `'not-allowed'`, …)
applies the deepest hovered node's cursor to the window, via ntk's cursor
cache over the standard X cursor font.
