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
misses most of the desktop. The clipboard uses the same table, on purpose —
what a file manager offers on a drop is what it offers on a copy, so
[`clipboard.read('files')`](clipboard.md#reading) resolves it the same way:

| group     | matches                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `'files'` | `text/uri-list`, `application/x-kde4-urilist`, `x-special/gnome-copied-files`                              |
| `'uris'`  | `text/uri-list`, `text/x-moz-url`, `_NETSCAPE_URL`                                                         |
| `'text'`  | `text/plain;charset=utf-8`, `UTF8_STRING`, `text/plain`, `STRING`, `TEXT`, `COMPOUND_TEXT` (in that order) |

`dropAccept={['text']}` therefore catches GTK text (`UTF8_STRING`), a
terminal selection (`STRING`) and a modern editor's
`text/plain;charset=utf-8` alike, where `dropAccept={['text/plain']}`
catches only the last of those. Groups do not overlap: a Firefox link is
`text/x-moz-url`, which is in `uris`, so accept `['uris', 'text']` if you
want both. A group only ever expands to its own list.

`dropAccept` is **data, not a callback**, and that is load-bearing rather
than stylistic: the protocol's accept/reject answer is computed straight
from it, inside the X message handler, without entering React. A window
that is slow to answer stalls the drag cursor in _the other application_,
which is a user-visible freeze in a program you do not own.

### The drag events

`onDragEnter` and `onDragLeave` do not propagate — they are synthesized by
path diffing, exactly like `onMouseEnter`/`onMouseLeave`. `onDragOver` and
`onDrop` dispatch capture → target → bubble like any other event
(`onDragOverCapture`, `onDropCapture`), `onDragOver` once per pointer
position.

The order across one whole drag, source events and target events
interleaved:

```
onDragStart                      the pointer passed the threshold
  ┌ onDragLeave   (target)       nodes the drag moved off, deepest first
  │ onDragEnter   (target)       nodes it moved onto, outermost first
  │ onDragOver    (target)       the node under the pointer, capture → bubble
  └ onDrag        (source)       last, once the target has been told
onDrop                           the release, capture → bubble
onDragEnd                        always last, on the source
```

The four middle handlers repeat per pointer position, in that order — the
target learns where the pointer is before the source hears about the move,
which is why `onDrag`'s `accepted` is already up to date when it runs.

`onDragEnd` runs even when nothing accepted the drop — with `action: null`
and `dropped: false` — so releasing state there is safe.

Which node is _the_ target, when they nest: the accept decision picks the
**deepest** node whose `dropAccept` matches, skipping any node marked
`disabled`, so a `<window>`-level `dropAccept` is a fallback that loses to
any matching descendant. Two wrinkles worth knowing:

- `onDrop` still dispatches capture → bubble along the whole ancestor path
  of the node under the pointer, so an ancestor with an `onDrop` sees the
  drop even if its own `dropAccept` did not match. If that is not what you
  want, `e.stopPropagation()` in the inner handler.
- `onDragEnter`, `onDragLeave` and `':drag-over'` are **not** filtered at
  all — not by `dropAccept`, not by `disabled`. They follow the pointer's
  ancestor path, exactly like hover.

Every drag event carries:

| field                      |                                                                                |
| -------------------------- | ------------------------------------------------------------------------------ |
| `types`                    | `string[]` — the offered payload type names                                    |
| `has(type)`                | group-aware membership test: `e.has('files')`                                  |
| `action`                   | `'copy' \| 'move' \| 'link' \| 'ask' \| 'private'` — what the source asked for |
| `actions`                  | the choices an `'ask'` source will accept; empty otherwise                     |
| `actionDescriptions`       | its own words for them, positionally matched, `null` where it gave none        |
| `source`                   | `'internal'` (this app) or `'external'` (another application)                  |
| `screenX` / `screenY`      | pointer position in root coordinates                                           |
| `x`/`y`, `localX`/`localY` | window and target-relative coordinates, as on any event                        |

plus three ways to answer. `e.freeze()` is `onDragOver` only; `e.accept()`
and `e.reject()` also work in `onDrop`, where they settle what the drop did
rather than whether it would be taken (see [The drop](#the-drop)):

- `e.accept(action?)` — take the drop, optionally forcing the action
  (`e.accept('move')`);
- `e.reject()` — refuse it, overriding a `dropAccept` that matched;
- `e.freeze()` — tell the source to stop sending positions while the
  pointer stays inside this node's rectangle. Cheap on a remote display,
  but it makes the node deaf: **do not freeze a zone that draws an
  insertion caret or auto-scrolls near its edges.** It applies to drags
  from other applications only; during an in-app drag it does nothing,
  since there is no source to tell.

### The drop

`onDrop` may be `async`. For a drop from **another application** the
protocol reply is held until the returned promise settles, so `await`ing a
write is correct; a watchdog sends the reply anyway after 10 s, because a
forgotten `await` in your app must not hang the drag gesture in someone
else's.

For an **in-app** drop there is no protocol reply to hold, so nothing waits:
`onDragEnd` fires immediately and an async `onDrop` finishes on its own
afterwards. Do not rely on the drag being "over" only once your handler has
resolved — if the source needs to know, have the handler tell it.

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
- **`e.text`** — the best text flavour the source offered, decoded. For a
  file drag it is the raw `text/uri-list` payload instead, which is what
  `e.files` was parsed from; and it is `undefined` when nothing text-ish
  was offered or the conversion failed.
- **`await e.getData(type)`** — one conversion of any offered type. Text-ish
  targets decode to a string, everything else stays raw bytes. Group names
  work: `getData('files')` resolves to whichever concrete type was offered.
- **`parseUriList(text)`** — exported from the package, and the same parser
  `e.files` uses. For when you fetch the list yourself:
  `parseUriList(await e.getData('text/uri-list'))`.
- **`e.items`** — _internal drags only_: the `dragData` values themselves,
  by reference, never serialised. `undefined` for drops from other
  applications, which is also how you tell the two apart without checking
  `e.source`.

There is deliberately **no `e.dataTransfer`**. X selection transfer is
asynchronous and the DOM's `getData()` is synchronous; a lookalike
returning a promise would stringify to `"[object Promise]"` in template
literals with no error anywhere. The different name is the warning.

`onDrop` can also settle what the drop _did_, which is what the source is
told afterwards:

- **`e.accept('move')`** — report a different action from the one that was
  negotiated while hovering. This is how a source that asks gets its
  answer.
- **`e.reject()`** — having looked at the payload, refuse it after all.
  The source is told the drop was not taken, so a "move" leaves the
  original where it was.

Both may be called late from an `async` handler: for a drag from another
application the reply is not sent until the handler settles, so a menu can
decide it. In-app drags do not wait, so only a synchronous answer reaches
`onDragEnd`.

### When the handler fails

A handler that throws — or returns a promise that rejects — did not store
what it was given, so **the drop is refused**, exactly as if it had called
`e.reject()`, and the failure is reported the way every handler throw is
([events.md](events.md#when-a-handler-throws)): the handler name, the
element, and the component that rendered it.

Refusing is the part worth knowing about. A `move` source deletes its own
copy on the strength of being told the drop was taken, so a failed import
that reported success is how a file goes missing. A later handler on the
path can still `accept()`; the refusal is the failed one's answer, not the
whole dispatch's.

An `async` failure is reported when the promise rejects. For a drop from
another application that is before the protocol reply goes out, so the
source hears about it. In-app it is after `onDragEnd` has already fired,
for the same reason nothing else in that path waits — which is why it is
reported rather than only returned.

### Sources that ask

A file manager dragging between two filesystems often does not know
whether you meant copy or move, so it asks: `e.action` is `'ask'`, and the
choices it will accept come with the event.

```jsx
onDrop={async (e) => {
  if (e.action !== 'ask') return void save(e.files, e.action);
  // e.actions            -> ['copy', 'move', 'link']
  // e.actionDescriptions -> ['Copy here', 'Move here', null]
  const chosen = await myMenu(e.actions, e.actionDescriptions);
  if (!chosen) return void e.reject();
  save(e.files, chosen);
  e.accept(chosen);
}}
```

`actionDescriptions` is positional and the source's own wording — a `null`
means it offered that action without describing it, so use your own label.
Both arrays are empty for every other kind of drag, so they can be read
without guarding, and nothing is read off the source's window unless a
position actually asks.

The menu is yours to draw. A built-in one would have to hold the protocol
reply open for as long as it stayed up, and that reply is the only thing
keeping the other application's drag cursor from freezing — so the choice
of how long to make someone wait belongs to the app, not the toolkit.
`ContextMenu` is the obvious thing to build it from.

### `:drag-over`

While a drag is in flight, `':drag-over'` is set on the node under the
pointer **and on its ancestors** — the same ancestor-path rule `:hover`
follows, resolved the same way (a repaint, no React render). For most
dropzones that is the whole highlight feature, with no handler and no
state.

One thing it does **not** do: it is not filtered by `dropAccept`. A node
lights up because the pointer is over it, not because it would take the
drop, so a zone that accepts only `image/png` still highlights while a text
drag passes over. Where the difference matters — showing "yes" versus "no"
feedback — use `useDropTarget` and style from `isAccepted`, which is
exactly the distinction it exists to draw:

```jsx
<box {...dropProps} style={[s.zone, isOver && (isAccepted ? s.yes : s.no)]} />
```

### Scrolling while dragging

A drag that rests near the top or bottom edge of a scroll container scrolls
it, so a drop target below the fold can be reached without letting go.
Nothing opts in: it applies to any scroll container a drag passes over,
from this application or another one.

The viewport it scrolls is the nearest scroll _container_ enclosing the
pointer, walked out the same way the wheel walks. Something that scrolls
pixels of its own without being a container — `<textarea>` and anything else
that answers `canScroll` alone
([extending.md](extending.md#scrolling-content-you-painted)) — is
deliberately excluded: nothing can be dropped into one, so scrolling it
during a drag would only move content out of reach.

Two consequences worth knowing:

- **The content moves under a stationary pointer**, so `onDragEnter`,
  `onDragLeave` and `onDragOver` keep firing while it scrolls, and
  `:drag-over` follows. That is the point — the node under the pointer
  really is changing.
- **Do not `e.freeze()` a zone inside a scroll container.** Freezing tells the
  source to stop sending positions, and for a drag from another
  application those positions are what start the scrolling in the first
  place.

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
  style={{
    backgroundColor: '$panel',
    ':dragging': { backgroundColor: '$dim' },
  }}
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

Thunks are why a payload nobody asks for is never built. Offer
`'text/uri-list': () => buildUriList(selection)` and the list is assembled
only when it is needed — at the drop for an in-app drag, and at the moment
the pointer first leaves your windows for an external one. Note the second:
crossing the window edge is enough to resolve every thunk, whether or not
the drag is ever dropped.

Type names are yours to choose. Use real MIME types for anything another
application might want (`text/uri-list` is what every file manager reads),
and an `application/x-…` name for private in-app payloads.

### `dragActions`

Which actions the source offers, preferred first; default `['copy']`. The
**target** picks one — `e.accept('move')` on its side — and `onDragEnd`
reports what was actually performed, so `'move'` semantics (remove the
original) belong in `onDragEnd`, never in `onDragStart`.

Across applications only the **first** entry reaches the wire: a foreign
target is told the one action you prefer, not the list, so
`dragActions={['copy', 'move']}` does not give a GTK window a copy/move
choice. In-app targets see the same single requested action on `e.action`
and can still answer with any of them.

Note what this does _not_ include: **there is no modifier-key
negotiation.** Holding Ctrl or Shift during a drag does not switch copy to
move the way a desktop file manager does — the requested action is fixed
when the drag starts, and only the target can change it.

Modifier state is readable on the **source** side, where the events carry
the real X motion event: `e.ctrlKey` and `e.shiftKey` are meaningful in
`onDrag`. On the **target** side they are always `false` —
`onDragEnter`/`onDragOver`/`onDragLeave`/`onDrop` are built from a
synthesized event with no button mask — so a dropzone cannot see what the
user is holding. Decide the action from what is being dragged and where it
lands.

### The gesture

DOM-shaped, and deliberately so:

- A press on a `draggable` node is **still a click** until the pointer
  moves 4px — measured as `|dx| + |dy|`, so a straight move needs the full
  4 and a diagonal one starts at about 2.8. Buttons inside draggable rows
  keep working.
- `onDragStart` fires at the threshold. `e.preventDefault()` cancels — the
  gesture continues as ordinary mouse events.
- `onDrag` fires per pointer position, with `screenX`/`screenY` and
  `accepted` (whether whatever is under the pointer would take it).
- `onDragEnd` reports `{ action, dropped }`. `action` is `null` when the
  drag ended over nothing or was refused. Read those rather than `source`,
  which on `onDragStart` and `onDragEnd` is always `'internal'`; only
  `onDrag` reports the transport actually carrying the drag.
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
  fireEvent.mouseMove(card, { dx: 8 }); // past the threshold, still on the card
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
| auto-scroll edge band              | 24px, stepping every 30 ms, up to 14px a step          |
| XDND protocol version              | 5 (the current one; older sources are negotiated down) |
| requires                           | ntk ≥ 5.4.0                                            |

Not supported, deliberately or not yet:

- **Motif drag and drop**, the pre-XDND protocol. Some legacy Motif and
  AWT applications speak only that and will not interoperate.
- **XdndDirectSave (XDS)** — "drag out of the app to save a file into the
  file manager". A separate protocol layered on XDND.
- **A built-in menu for `XdndActionAsk`.** The choices are handed to you —
  see [Sources that ask](#sources-that-ask) — but the menu itself is yours
  to draw. A built-in one would have to hold the reply while it was open,
  and the reply is what keeps another application's drag from freezing.
- **`react-dnd`** and other DOM drag libraries — see
  [ecosystem.md](ecosystem.md).

## Protocol notes

For anyone watching the wire, or debugging against another toolkit:

- `XdndAware` (version 5) is written on every **top-level** window
  unconditionally at realize time. Child windows — `<glarea>`, a nested
  `<window>` — never advertise, per XDND v3+; drags over them arrive at the
  top-level and are routed down in JavaScript.
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
