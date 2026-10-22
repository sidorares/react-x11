# Drag and drop: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/drag-and-drop.md](../docs/drag-and-drop.md), the reference, and keep
their original headings so code comments that cite them still resolve.

The API review and the rationale behind the XDND advertisement are
[architecture/drag-and-drop.md](architecture/drag-and-drop.md).

## The two transports

On the [cocoa backend](../docs/macos.md) the external transport is AppKit's own —
`NSDraggingSource` and `NSDraggingDestination` on every window — and the
switch is drawn differently: once your press crosses the threshold, AppKit
tracks the gesture everywhere, and a drop on one of your own windows comes
back through that window's destination with the payload still by reference
(`e.source === 'internal'`, `e.items` live), so the table above holds. What
another application reads is the pasteboard, where a `dragData` thunk is a
promise the system asks for only when a consumer actually reads that type.

## Interoperating with other applications

Platform notes, as they were before the reference was tightened:

- **Linux / XWayland** — works both directions, including to and from
  native Wayland applications, which is what makes this worth having on a
  modern desktop.
- **The Wayland backend** — works both directions too, over
  `wl_data_device` (`src/wayland/dnd.js`): a drag from another application
  arrives as the same `DropSession` the X11 path drives, and a drag out is a
  `wl_data_source` the compositor carries from the press serial on. As on
  the cocoa backend, the payload is read at the drop.
- **Windows, the win32 backend** — works both directions with the desktop,
  over OLE: `IDropTarget` on every window with a `dropAccept` under it,
  `DoDragDrop` out of one. Files arrive as CF_HDROP and become one
  `text/uri-list`, text as CF_UNICODETEXT, and anything else as a clipboard
  format registered under its MIME name — which two react-x11 apps agree on
  for free and nothing else will, exactly as an X11 atom behaves.

  Two things differ. A `dragData` **thunk is not lazy**: every type's bytes
  are resolved when the drag starts, because a data object that asked JS for
  them from inside `DoDragDrop`'s modal loop would be reaching across the
  bridge's thread split at the one moment its UI thread cannot wait. And the
  shell's question "may this be dropped here" is answered one motion late —
  it picks a cursor, and the bridge returns the previous answer rather than
  blocking. The drop itself is answered exactly, because whether it was a
  copy or a move decides whether the source deletes its original.

- **macOS, the cocoa backend** — works both directions with the desktop:
  files from the Finder arrive as `['files']` (each file is a pasteboard
  item of one `public.file-url`; they become one `text/uri-list`), text from
  any app as `['text']`, a URL from Safari as `['uris']`. Pasteboard types
  are UTIs, and react-x11's MIME vocabulary maps onto them through the OS's
  own type database — a private `application/x-myapp-…` travels between two
  react-x11 apps as a `dyn.*` type every process computes alike. Two things
  differ from X11. The payload is read **at the drop** (the pasteboard is the
  source's promise, and it may withdraw it once its session ends), so
  `getData()` answers from that read. And the gesture runs inside AppKit's
  own tracking loop, which owns the thread from the threshold to the
  release: no timer of ours fires and no frame clock ticks in between, so
  every frame of a drag is painted from the callback that reported it, and
  every render a drag schedules — a `<popup dragPreview>` following
  `useDragSource().position`, a `useDropTarget` hint, an insertion marker —
  is dispatched at discrete priority and landed there. The preview follows
  the pointer as it does on X11, and because a `<popup>` here is a
  non-activating panel at the pop-up-menu window level — above every other
  application's windows, which sit at the normal level — it is what the
  desktop sees while the pointer is over Finder or a browser. It is also
  the first window the window server finds when the pointer comes back
  over one of yours, and AppKit does not look past it: a window with no
  dragged types registered is still the one found, the drag then has no
  destination, and the window beneath never hears of it. So the popup is
  made transparent to the pointer — `dragPreview` sets the bridge's
  `ignoresMouseEvents` (@windowkit/appkit 0.6.0) — and the hit passes
  through it to the window it covers: the same exclusion the router makes
  on X11, made where the window server can see it. It registers no
  pasteboard types either, having nothing to accept with. What AppKit's own
  session carries is still a blank image: the drag has no bitmap of the
  system's, only the preview you draw. For the same reason the session's
  slide-back is off: left on, AppKit animates that blank image home over
  about a second _before_ it reports the release, so a drop nothing took
  reached `onDragEnd` — and the preview stayed frozen where the pointer let
  go — only after a pause spent animating nothing. The release ends the
  gesture the moment it happens, as on X11, and a return animation is the
  app's to draw from `onDragEnd`.
- **macOS / XQuartz** — X client to X client works. Dragging from **Finder**
  into an X11 window does not, and never has:
  [XQuartz#173](https://github.com/XQuartz/XQuartz/issues/173). That is the
  X server's gap, not react-x11's; test against another X client — or run
  the cocoa backend, which has the Finder.
- **Over `ssh -X`** — each pointer position during an external drag costs a
  few round trips while resolving the foreign window under the cursor, so a
  drag feels heavier on a link than a click does. In-app drags cost
  nothing extra. See [remote.md](../docs/remote.md).

## Protocol notes

For anyone watching the wire, or debugging against another toolkit:

- `XdndAware` (version 5) is written on every **top-level** window
  unconditionally at realize time. Child windows — `<glarea>`, a nested
  `<window>` — never advertise, per XDND v3+; drags over them arrive at the
  top-level and are routed down in JavaScript. A `<popup dragPreview>`
  never advertises either: it follows the pointer, and a window that is
  never under it has nothing to accept.
- A window with **no drop targets mounted** answers with a refusal covering
  the whole window, so a well-behaved source stops asking while the pointer
  stays inside it. What an app that never uses drag and drop still pays:
  the `XdndAware` property, one batch of atom interns, and a session object
  per top-level window, all once at realize — plus one refusal per drag
  that crosses it.
- The drop conversion uses the timestamp from `XdndDrop`, as the protocol
  requires, and `XdndSelection` is released at drag end with the timestamp
  it was acquired with (ICCCM 2.3.1).
- As a source, the foreign window under the pointer is resolved per motion
  frame rather than from a cache built at drag start — correct, and a few
  round trips heavier on a remote display.

The reasoning behind each of those, and the measurements that produced
them, are in [architecture/drag-and-drop.md](architecture/drag-and-drop.md).
Runnable demonstrations of both halves, as two separate processes, are
[`examples/dnd-source.jsx`](../examples/dnd-source.jsx) and
[`examples/dnd-target.jsx`](../examples/dnd-target.jsx).
