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
  // keyboard: keycode, keysym, codepoint, key
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
| `onContextMenu`                             | right-click (button 3), after `onMouseDown`; default action opens the element's menu  |
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

react-x11 windows are XDND drop targets: drags from file managers,
editors and browsers land as ordinary events on ordinary nodes. (The
other direction — being a drag _source_ — is planned;
[#126](https://github.com/sidorares/react-x11/issues/126) tracks both
halves, and the design review lives in
[the architecture doc](https://github.com/sidorares/react-x11/pull/161).)

```jsx
<box
  dropAccept={['files']}
  onDrop={async (e) => setPaths(e.files.map((f) => f.path))}
  style={{
    borderColor: '$border',
    ':drag-over': { borderColor: '$accent' },
  }}
/>
```

Any drawn element, `<window>` or `<popup>` takes the props; their
presence is what makes the node a drop target. `dropAccept` is
deliberately namespaced (not `accept`) so a prop spread cannot turn a box
into a dropzone by accident.

| prop                          | notes                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `dropAccept`                  | a MIME type, a group (`'files'`, `'uris'`, `'text'`), an array of either, or a predicate |
| `onDragEnter` / `onDragLeave` | do not propagate — drag-path diffing, like hover; paired with the `':drag-over'` state   |
| `onDragOver`                  | per position; `e.accept(action)` / `e.reject()` override the declarative answer          |
| `onDrop`                      | may be async — the protocol reply waits for the returned promise (bounded by a watchdog) |

`dropAccept` matters beyond filtering: it is **data**, so the protocol's
accept/reject answer is computed in the event handler without entering
React. The groups encode real-world offers — GTK text arrives as
`text/plain;charset=utf-8`/`UTF8_STRING`, Firefox links as UTF-16
`text/x-moz-url` — so `dropAccept={['text']}` catches what string
equality on `'text/plain'` would miss.

The drag event carries `types`, `has(type)`, `action`, `source`
(`'external'` for XDND), and `screenX/screenY`. On `onDrop`
additionally:

- `e.files` — parsed `text/uri-list`: `[{ uri, path? }]`, `path` present
  only for genuinely local `file:` URIs, percent-decoding done;
- `e.text` — the best offered text flavour;
- `await e.getData(type)` — any other offered type, decoded to a string
  for text-ish targets, raw bytes otherwise. There is deliberately no
  `e.dataTransfer`: X selection transfer is asynchronous, and a
  sync-looking `getData` would stringify to `"[object Promise]"` without
  an error in sight.

The `':drag-over'` style state makes the common highlight free — no
handler, no re-render. For render-state (an `isOver` hint label), the
`useDropTarget` hook mirrors react-dropzone:

```jsx
const { dropProps, isOver, isAccepted } = useDropTarget({
  accept: ['files'],
  onDrop: (e) => setFiles(e.files),
});
return <box {...dropProps} style={isOver ? s.zoneHot : s.zone} />;
```

### Drag sources

`draggable` makes a node a drag source; `dragData` is the offer, keyed by
payload type name:

```jsx
<box
  draggable
  dragData={{
    'text/uri-list': () => toUriList(item), // a thunk: resolved lazily
    'text/plain': item.path,
    'application/x-myapp-item': item, // a live object
  }}
  dragActions={['copy', 'move']}
  onDragEnd={(e) => {
    if (e.action === 'move') remove(item.id);
  }}
  style={{ ':dragging': { opacity: 0.4 } }}
/>
```

One drag session, two transports, and handlers cannot tell them apart
without asking (`e.source`):

- **Inside the app** (over any of its windows, including other
  `<window>`s and `<popup>`s) the drag is local: no X traffic at all, and
  a drop hands values over **by reference** — `e.items['application/x-myapp-item']`
  is the object itself, never serialised.
- **Leaving the app's windows** promotes the drag to XDND: `dragData` is
  published on `XdndSelection` (thunks resolve now — a drag that ends in
  the wastebasket never builds its payload; live objects are
  JSON-serialised for the wire), the target under the pointer is found by
  descending from the root, and any XDND application — a file manager, an
  editor, another react-x11 process — can accept the drop. Coming back
  over the app demotes it again.

The gesture is DOM-shaped: a press on a `draggable` is still a click
until it moves ~4px; `onDragStart` fires at the threshold
(`preventDefault()` cancels the drag); `onDrag` tracks every motion with
`screenX/screenY` and `accepted`; `onDragEnd` reports `{ action,
dropped }` — `action` is null when the drag ended nowhere. A completed
drag suppresses the click, and `:dragging` styles the source while it
lasts.

There is deliberately no `dragPreview` prop rendering a bitmap — the
preview is a live React tree. `useDragSource` packages the pattern:

```jsx
const { dragProps, isDragging, position } = useDragSource({
  data: { 'text/plain': label },
  onDragEnd: (e) => {
    /* … */
  },
});
return (
  <>
    <box {...dragProps} />
    {isDragging && (
      <popup dragPreview x={position.x + 12} y={position.y + 12}>
        <Chip label={label} />
      </popup>
    )}
  </>
);
```

The `dragPreview` prop on the `<popup>` matters: it tells the drag router
the window under the pointer is the preview itself, not a drop target.

The two runnable halves live in
[`examples/dnd-source.jsx`](../examples/dnd-source.jsx) and
[`examples/dnd-target.jsx`](../examples/dnd-target.jsx) — run them in two
terminals and drag between the processes.

Notes for protocol watchers: `XdndAware` (version 5) is written on every
top-level window unconditionally at realize time; a window with no drop
targets mounted answers a drag with one refusal covering the whole
window, so an app that never uses DnD costs one property and nothing per
drag. On the source side, the foreign target is re-resolved per motion
frame (2–4 round trips against a local server; the drag-start window
cache for remote X is future work), the mid-drag cursor rides
`ChangeActivePointerGrab` over the implicit button grab, and
`XdndFinished` is awaited with a 5 s timeout so a dead target cannot wedge
the gesture. macOS/XQuartz cannot deliver Finder drags into X11
applications
([XQuartz#173](https://github.com/XQuartz/XQuartz/issues/173)) — test
against another X client there; on Linux, XWayland bridges XDND both
ways.
