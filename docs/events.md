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
| `onKeyDown` / `onKeyUp`                     | delivered to the focused node (or the window); Tab cycles focus                       |
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
events route to the focused node's ancestor chain.

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
