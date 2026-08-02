# Drag and drop

react-x11 speaks [XDND](https://freedesktop.org/wiki/Specifications/XDND/),
the X11 drag-and-drop protocol, in both directions: a file dragged out of
Nautilus lands on a `<box>` as an ordinary event, and a row dragged out of
your app can be dropped into a file manager, an editor or a browser. The
same API also covers drags that never leave the app — a reorderable list, a
kanban board — without any X11 traffic at all.

Two prop families, and nothing else to install:

| you want      | props                                                                        |
| ------------- | ---------------------------------------------------------------------------- |
| accept a drop | `dropAccept`, `onDragEnter`, `onDragOver`, `onDragLeave`, `onDrop`           |
| start a drag  | `draggable`, `dragData`, `dragActions`, `onDragStart`, `onDrag`, `onDragEnd` |

Both work on any drawn element and on `<window>` / `<popup>`. Their
_presence_ is what registers the node — there is no provider to mount and
no context to thread.

> The design rationale — why the API is shaped this way, why the XDND
> advertisement is unconditional, what was rejected — is a separate
> document: [architecture/drag-and-drop.md](architecture/drag-and-drop.md).
> This page is the reference.

## Accepting drops

```jsx
<box
  dropAccept={['files']}
  onDrop={(e) => setPaths(e.files.map((f) => f.path))}
  style={{
    borderColor: '$border',
    ':drag-over': { borderColor: '$accent' },
  }}
/>
```

That is a complete dropzone: it accepts file drags from any XDND
application, highlights while one is over it, and receives decoded local
paths. No state, no effect, no cleanup.

### `dropAccept`

What the node will take. Four shapes:

| value                                | means                                                     |
| ------------------------------------ | --------------------------------------------------------- |
| `'image/png'`                        | exactly that type (MIME names compare case-insensitively) |
| `['files']`                          | a semantic group — see the table below                    |
| `['image/png', 'text', 'x-my/type']` | any of these                                              |
| `(types) => boolean`                 | your own predicate, given the offered type names          |
| _absent_                             | anything — a bare `onDrop` is a valid dropzone            |

The three groups exist because the same payload arrives under different
names depending on who is dragging, and exact-match filtering silently
misses most of the desktop:

| group     | matches                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `'files'` | `text/uri-list`, `application/x-kde4-urilist`, `x-special/gnome-copied-files`                              |
| `'uris'`  | `text/uri-list`, `text/x-moz-url`, `_NETSCAPE_URL`                                                         |
| `'text'`  | `text/plain;charset=utf-8`, `UTF8_STRING`, `text/plain`, `STRING`, `TEXT`, `COMPOUND_TEXT` (in that order) |

`dropAccept={['text']}` therefore catches GTK text (`UTF8_STRING`), Firefox
links (`text/x-moz-url`) and a plain terminal selection alike, where
`dropAccept={['text/plain']}` would catch only the last.

`dropAccept` is **data, not a callback**, and that is load-bearing rather
than stylistic: the protocol's accept/reject answer is computed straight
from it, inside the X message handler, without entering React. A window
that is slow to answer stalls the drag cursor in _the other application_,
which is a user-visible freeze in a program you do not own.

### The drag events

`onDragEnter` and `onDragLeave` do not propagate — they are synthesized by
path diffing, exactly like `onMouseEnter`/`onMouseLeave`. `onDragOver`
dispatches capture → target → bubble like any other event, once per pointer
position.

Every drag event carries:

| field                      |                                                                                |
| -------------------------- | ------------------------------------------------------------------------------ |
| `types`                    | `string[]` — the offered payload type names                                    |
| `has(type)`                | group-aware membership test: `e.has('files')`                                  |
| `action`                   | `'copy' \| 'move' \| 'link' \| 'ask' \| 'private'` — what the source asked for |
| `source`                   | `'internal'` (this app) or `'external'` (another application)                  |
| `screenX` / `screenY`      | pointer position in root coordinates                                           |
| `x`/`y`, `localX`/`localY` | window and target-relative coordinates, as on any event                        |

plus, in `onDragOver` only, three ways to answer:

- `e.accept(action?)` — take the drop, optionally forcing the action
  (`e.accept('move')`);
- `e.reject()` — refuse it, overriding a `dropAccept` that matched;
- `e.freeze()` — tell the source to stop sending positions while the
  pointer stays inside this node's rectangle. Cheap on a remote display,
  but it makes the node deaf: **do not freeze a zone that draws an
  insertion caret or auto-scrolls near its edges.**

### The drop

`onDrop` may be `async`. The protocol reply is held until the returned
promise settles, so `await`ing a write is correct; a watchdog sends the
reply anyway after 10 s, because a forgotten `await` in your app must not
hang the drag gesture in someone else's.

The event adds three ways to reach the payload:

```jsx
onDrop={async (e) => {
  e.files;                            // parsed text/uri-list
  e.text;                             // the best offered text flavour
  const png = await e.getData('image/png');   // anything else
}}
```

- **`e.files`** — `[{ uri, path? }]`, parsed per RFC 2483: CRLF-separated,
  `#` comment lines dropped, percent-decoding done. `path` is present only
  for genuinely local `file:` URIs — a remote `file://otherhost/…` has a
  `uri` and no `path`, rather than a path that does not exist here.
- **`e.text`** — the best flavour the source offered, decoded.
- **`await e.getData(type)`** — one conversion of any offered type. Text-ish
  targets decode to a string, everything else stays raw bytes. Group names
  work: `getData('files')` resolves to whichever concrete type was offered.
- **`e.items`** — _internal drags only_: the `dragData` values themselves,
  by reference, never serialised. `undefined` for drops from other
  applications, which is also how you tell the two apart without checking
  `e.source`.

There is deliberately **no `e.dataTransfer`**. X selection transfer is
asynchronous and the DOM's `getData()` is synchronous; a lookalike
returning a promise would stringify to `"[object Promise]"` in template
literals with no error anywhere. The different name is the warning.

### `:drag-over`

A drop target sets the `':drag-over'` style state while a drag it accepts
is over it — no handler, no re-render, and it obeys the same precedence
rules as `:hover` (see [styling.md](styling.md)). This is the whole
highlight feature for most dropzones.

### `useDropTarget`

When the _render_ has to change — a hint label, a disabled sibling — the
hook adds state on top of the same props:

```jsx
import { useDropTarget } from 'react-x11';

const { dropProps, isOver, isAccepted } = useDropTarget({
  accept: ['files'],
  onDrop: (e) => setFiles(e.files),
});

return (
  <box {...dropProps} style={s.zone}>
    <text>{isOver && !isAccepted ? 'not a file drag' : 'drop files here'}</text>
  </box>
);
```

`accept` is the hook's name for `dropAccept` (inside a hook called
`useDropTarget` the shorter word is unambiguous, and it is what
react-dropzone users expect); `onDragOver`, `onDragEnter` and `onDragLeave`
pass through. `isOver` is true whenever a drag is over the node,
`isAccepted` only when it matches.

## Starting drags

```jsx
<box
  draggable
  dragData={{
    'text/uri-list': () => `file://${encodeURI(file.path)}\r\n`, // lazy
    'text/plain': file.path,
    'application/x-myapp-file': file, // a live object
  }}
  dragActions={['copy', 'move']}
  onDragEnd={(e) => {
    if (e.action === 'move') remove(file.id);
  }}
  style={{ ':dragging': { opacity: 0.4 } }}
/>
```

### `dragData`

A map from payload type name to value. What a value may be, and what
happens to it:

| value                   | in-app drop                    | dropped on another application                 |
| ----------------------- | ------------------------------ | ---------------------------------------------- |
| a string                | handed over as-is              | sent as UTF-8                                  |
| a `Buffer`/`TypedArray` | handed over as-is              | sent as-is (chunked if large)                  |
| any other object        | **by reference**, on `e.items` | `JSON.stringify`d                              |
| a function (thunk)      | called on drop                 | called when the drag first leaves your windows |

Thunks are the reason the payload of a drag that ends in the wastebasket is
never built. Offer `'text/uri-list': () => buildUriList(selection)` and the
list is assembled only if the drag actually reaches a foreign window.

Type names are yours to choose. Use real MIME types for anything another
application might want (`text/uri-list` is what every file manager reads),
and an `application/x-…` name for private in-app payloads.

### `dragActions`

Which actions the source offers, preferred first; default `['copy']`. The
target picks one — `e.accept('move')` on its side — and `onDragEnd` reports
what was actually performed, so `'move'` semantics (remove the original)
belong in `onDragEnd`, never in `onDragStart`.

### The gesture

DOM-shaped, and deliberately so:

- A press on a `draggable` node is **still a click** until the pointer
  moves 4px. Buttons inside draggable rows keep working.
- `onDragStart` fires at the threshold. `e.preventDefault()` cancels — the
  gesture continues as ordinary mouse events.
- `onDrag` fires per pointer position, with `screenX`/`screenY` and
  `accepted` (whether whatever is under the pointer would take it).
- `onDragEnd` reports `{ action, dropped }`. `action` is `null` when the
  drag ended over nothing or was refused.
- A completed drag **suppresses the click**, as in the DOM.
- `':dragging'` is set on the source node for the duration.

### `useDragSource` and drag previews

XDND has no drag image in the protocol; every toolkit paints its own. In
react-x11 that is a `<popup>` following the pointer — which means the
preview is a live React tree rather than a bitmap:

```jsx
import { useDragSource } from 'react-x11';

const { dragProps, isDragging, position } = useDragSource({
  data: { 'text/plain': file.name },
  actions: ['copy', 'move'],
  onDragEnd: (e) => {
    /* … */
  },
});

return (
  <>
    <box {...dragProps} style={s.card} />
    {isDragging && (
      <popup
        dragPreview
        x={position.x + 14}
        y={position.y + 14}
        width={180}
        height={34}
      >
        <box style={position.accepted ? s.previewOk : s.previewNo}>
          <text>{file.name}</text>
        </box>
      </popup>
    )}
  </>
);
```

`position` is `{ x, y, accepted }` in screen coordinates while dragging and
`null` otherwise. **`dragPreview` on the `<popup>` is required**: it tells
the router that this window is the preview, not something under the
pointer, and without it the drag would immediately land on its own preview.

## The two transports

One drag session, two ways of moving the payload. Handlers cannot tell them
apart unless they ask.

|                      | inside the app (`e.source === 'internal'`) | another application (`'external'`)   |
| -------------------- | ------------------------------------------ | ------------------------------------ |
| X11 traffic          | none                                       | XDND messages + a selection transfer |
| payload              | the live value, on `e.items`               | serialised, read with `getData`      |
| thunks resolved      | at the drop                                | when the pointer leaves your windows |
| `e.files` / `e.text` | yes, same shape                            | yes                                  |
| latency              | no round trips                             | a few per pointer position           |

The switch is automatic and reversible: leave your windows and the drag is
promoted to XDND; come back and it demotes again. Reorderable lists, trees
and kanban boards therefore cost nothing on the wire, while the _same_
component can also be dropped into GIMP.

## Interoperating with other applications

What arrives from the desktop, and what to accept for it:

| dragging from               | offers                                                   | accept with |
| --------------------------- | -------------------------------------------------------- | ----------- |
| Nautilus / Thunar / Dolphin | `text/uri-list`, `text/plain`                            | `['files']` |
| a GTK editor's selection    | `text/plain;charset=utf-8`, `UTF8_STRING`, `STRING`      | `['text']`  |
| Firefox (a link)            | `text/x-moz-url` (UTF-16), `text/uri-list`, `text/plain` | `['uris']`  |
| Chromium (a link)           | `text/uri-list`, `_NETSCAPE_URL`, `text/html`            | `['uris']`  |
| another react-x11 app       | whatever its `dragData` declared                         | those names |

Dragging **out** works the same way: offer `text/uri-list` and file
managers, editors and upload widgets will take it.

Platform notes:

- **Linux / XWayland** — works both directions, including to and from
  native Wayland applications, which is what makes this worth having on a
  modern desktop.
- **macOS / XQuartz** — X client to X client works. Dragging from **Finder**
  into an X11 window does not, and never has:
  [XQuartz#173](https://github.com/XQuartz/XQuartz/issues/173). That is the
  X server's gap, not react-x11's; test against another X client.
- **Over `ssh -X`** — each pointer position during an external drag costs a
  few round trips while resolving the foreign window under the cursor, so a
  drag feels heavier on a link than a click does. In-app drags cost
  nothing extra. See [remote.md](remote.md).

## Testing

Drags are drivable through `react-x11/test` — real pointer events into the
in-process X server, no display needed. The threshold is real, so move
before releasing:

```js
import { renderX11, fireEvent, act, cleanup } from 'react-x11/test';

const { windowNode } = await renderX11(<Board />);
const card = /* the draggable node */;
const bin = /* the dropzone node */;

await act(async () => {
  fireEvent.mouseDown(card);
  fireEvent.mouseMove(card, { x: 60, y: 50 }); // past the 4px threshold
  fireEvent.mouseMove(bin); // over the target
  fireEvent.mouseUp(bin);
});
```

`onDragStart`, `onDrop` and `onDragEnd` all run, and `e.items` carries the
live payload. Drops from _other_ applications need a second X connection
playing the foreign source — `test/dnd.test.js` in this repo does exactly
that if you need the pattern. See [testing.md](testing.md).

## Limits and defaults

|                                    |                                                        |
| ---------------------------------- | ------------------------------------------------------ |
| drag threshold                     | 4px                                                    |
| `onDrop` reply watchdog            | 10 s                                                   |
| wait for the target's confirmation | 5 s                                                    |
| XDND protocol version              | 5 (the current one; older sources are negotiated down) |
| requires                           | ntk ≥ 5.4.0                                            |

Not supported, deliberately or not yet:

- **Motif drag and drop**, the pre-XDND protocol. Some legacy Motif and
  AWT applications speak only that and will not interoperate.
- **XdndDirectSave (XDS)** — "drag out of the app to save a file into the
  file manager". A separate protocol layered on XDND.
- **`XdndActionAsk`** — a source asking the target to offer a choice of
  actions gets `copy` rather than a menu.
- **Auto-scrolling** a `<scrollview>` when a drag hovers near its edge.
- **`react-dnd`** and other DOM drag libraries — see
  [ecosystem.md](ecosystem.md).

## Protocol notes

For anyone watching the wire, or debugging against another toolkit:

- `XdndAware` (version 5) is written on every **top-level** window
  unconditionally at realize time. Child windows — `<glarea>`, a nested
  `<window>` — never advertise, per XDND v3+; drags over them arrive at the
  top-level and are routed down in JavaScript.
- A window with **no drop targets mounted** answers the first position with
  one refusal covering the whole window, so a source stops asking until the
  pointer leaves. An app that never uses drag and drop costs one property
  write, once, and nothing per drag.
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
