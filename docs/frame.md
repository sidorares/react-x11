# Panes in their own process: `<Frame>`

```jsx
import { Frame } from 'react-x11';

<Frame
  src={new URL('./charts.pane.js', import.meta.url)}
  props={{ rows, range, onPick }}
  style={{ flexGrow: 1, backgroundColor: '$surface' }}
  fallback={({ error, restart }) => <Crashed error={error} onRetry={restart} />}
/>;
```

`<Frame>` mounts a module of your application in a **process of its own** and
embeds its output here, laid out like any other child. It is this package's
iframe: the same composition of a display boundary and a process boundary,
behind one element, and it works on every backend.

How the display boundary is drawn differs, and it is worth knowing which one
you are on when reading a trace:

- **X11** — the pane renders into a real window of its own and the host
  embeds it over [`<foreign>`](embedding.md). Two boundaries that already
  existed separately, with `<Frame>` as the contract between them.
- **Cocoa** — there is no server to share, so the pane paints into
  `IOSurface`s created shared and presents by message; the host points one
  sublayer of its window at whichever surface the pane last presented. The
  pane has no `NSWindow` at all, and runs no AppKit. Every other window it
  makes — a menu, a dropdown's sheet, a tooltip, a dialog — it paints the
  same way, and the host shows in an `NSWindow` of its own (see "Sizing,
  stacking, input").
- **Windows** — the same shape as Cocoa with a **DirectComposition surface
  handle** in the IOSurface's place: the pane makes the handle, draws into it
  through a composition swapchain, and duplicates it into the host, which
  gives it to a visual in its own window. The pane has no HWND.
  [windows-embedding.md](windows-embedding.md) has the reasoning; the one
  thing worth knowing from here is that the handle is named **once**, not per
  frame — after that the compositor scans out of whatever the pane last
  presented, so a pane frame costs no message, no fence and no copy.

Either way the host owns layout and hit testing and the pane owns its
drawing, which is the line that makes this **CPU offloading, not
isolation**.

What the process boundary buys is the part no amount of careful coding buys
in-process:

- **Parallelism where this framework is CPU-bound.** The pane's
  reconciliation, layout, text shaping and painting run on another core. A
  pane that grinds for 400ms does not delay the shell's input handling by a
  microsecond — `npm run examples:frame` makes the difference visible with a
  ticker you can watch freeze, or not.
- **Crash isolation.** An uncaught throw, a native-module crash, an OOM: the
  pane dies, the `fallback` renders, `restart()` respawns. The shell never
  knew.
- **Leak isolation.** A pane that leaks is a bounded, killable leak, and its
  GC pauses are its own.

And what it does not buy, said once here and again in
[security.md](security.md): **it is not a security boundary.** On X11 the
pane holds a full-privilege connection to the same X server — it can read
keys, take screenshots, move windows — and on Cocoa it is an ordinary child
process of your application with your file system and your network.
`<Frame>` contains a pane's _failures_, not its intentions; code you would
not run in-process is code you should not run at all.

## The pane module

`src` names a module whose **default export is the pane's root component**:

```jsx
// charts.pane.js
export default function ChartsPane({ rows, range, onPick }) {
  return <box style={{ flexGrow: 1 }}>…</box>;
}
```

Pass `src` as `new URL('./charts.pane.js', import.meta.url)` or an absolute
path — a relative string is refused, because it would resolve against
react-x11's own files rather than yours.

A pane module is an ordinary component module. The same file can run inline
(`import ChartsPane from './charts.pane.js'` and render it), be its own
application, or be a pane — `isFramed()` answers which, and the examples'
autorun guard is where to ask:

```js
import { isFramed } from 'react-x11';

if (!isFramed() && !process.env.REACT_X11_NO_AUTORUN) {
  const root = await createRoot();
  root.render(<ChartsPane {...defaults} />);
}
```

The pane process inherits the parent's `execArgv`, which is what carries a
dev loader (tsx, the refresh loader) into it during development; a bundled
application forks plain JavaScript and needs none. It connects to the
display the host names in `display`, or `$DISPLAY` like everything else.

On macOS a pane stays on its process's main thread, where an app moves onto
a worker ([macos.md](macos.md#js-on-a-worker-a-ui-thread-of-the-bridges-own)):
it has no AppKit for that thread to keep, and the IPC channel it talks to
its host over is that thread's — a worker has no `process.send`. That holds
under `--import react-x11/cocoa-main` too, which a pane inherits whenever its
host was started under it.

## Props: a bag of data, and stubs for the functions in it

`props` crosses by **structured clone** — Dates, Maps, TypedArrays and
cycles survive; component instances, refs and React elements do not. One
message goes out per parent commit that changed the bag (a shallow
`Object.is` pass decides "changed", so a parent re-rendering without
touching the pane's inputs sends nothing), and props and bridged context
travel in the **same message**, so a theme flip and the state change that
caused it land in the pane as one commit rather than a torn pair.

Functions anywhere in the bag become **fire-and-forget stubs** on the pane
side: calling one sends its arguments back and returns `undefined`. The
arguments are sanitized on the way — functions inside them are dropped, the
data around them kept — because a pane calls `onPick(item, ev)` the way it
would call any handler, and `ev` is full of methods.

Callback identity follows function identity: a handler the parent keeps
stable (`useCallback`) keeps its id across updates, and an id from the
previous update still lands — one update of grace, which is what covers a
click racing a props change. A stub stashed outside the props flow and
called two updates later is dropped with a warning, not delivered to the
wrong function.

Two rules of thumb that keep the wire small:

- **The pane owns its data.** Props are for queries, ids, ranges — the pane
  fetches its own rows, the way an iframe fetches its own resources.
  Shipping a dataset through `props` on every commit works, and is the
  slowest possible way to have the pane know it.
- **The pane owns its animation.** An update is an IPC hop plus a pane
  commit: the right price for "show this now", the wrong one for driving a
  spinner at 60fps from the host.

## Context: bridged explicitly, theme by default

React context cannot cross a process boundary, and most of it should not
try: appearance, locale, desktop settings and fonts are resolved from the
desktop identically on both sides, so each process just asks. The rule the
bridge implements: **bridge what the app defines; let each process resolve
what the desktop defines.**

The theme is the one ambient thing the app authors, so it crosses **by
default**: a `<ThemeProvider>` above a `<Frame>` reaches the pane as a real
`ThemeProvider` around it — both routes, `useTheme()` and `$token` styles —
and it is in the pane's very first commit, so there is no frame of default
palette first. The bridged provider wraps the pane's **window** itself, the
position it held in the host: the window's own background follows the app's
palette rather than the pane process's desktop, and the window is the top
of the node tree every `$token` beneath it resolves through — so a theme
toggle in the host moves the pane's background and its static text, not
only what re-renders through `useTheme()`. With no provider above the
frame, nothing is bridged and the pane follows the desktop by itself: same
answer, no bridge. A pane that wants its own look mounts its own provider,
which wins below the bridged one the way an inner provider always wins.

For a context of your own, create it with `createFrameContext` in a module
**both sides import** — which the pane already does, since its components
read the context from it. The import is what registers the key, so identity
needs no wiring:

```js
// contexts.js — imported by the app and by the pane's components
import { createFrameContext } from 'react-x11';
export const Session = createFrameContext('session', null);
```

```jsx
// app side: an ordinary provider that also publishes to frames below it
<Session.Provider value={{ user, workspace }}>
  <Frame src={paneUrl} … />
</Session.Provider>;

// pane side: nothing to wire
const { user } = Session.use();
```

In-process it is an ordinary React context. Across a frame the value is
snapshotted, sent with the props, and recreated as a provider around the
pane — providers nest in the parent's own order, and a frame inside a pane
re-bridges automatically, because the pane's providers republish what they
received.

**Bridged values are data.** A value that will not structured-clone is
dropped with a warning naming the key, and that is deliberate: a bridged
`{ state, dispatch }` would hand live RPC stubs to every pane under the
provider — invisible wiring, with an unanswerable question about which
incarnation of a restarted pane holds which stub. Dispatchers travel in
`props`, where the wiring is visible. `serialize`/`revive` options on
`createFrameContext` cover a value that is data in spirit but a class in
shape.

`bridge` is the off switch the default owes: `bridge={false}` bridges
nothing, `bridge={['react-x11:theme', 'session']}` is an allowlist.

One honest limitation: the pane commits an IPC hop after the host, so a
theme flip repaints the shell a frame before the panes. Every asynchronous
boundary has this; nothing here pretends otherwise.

## Lifecycle, from both sides

The host's view:

- **`onStarted({ pid, windowId })`** — the pane mounted; its window is
  being embedded.
- **`onExit({ code, signal, expected })`** — the pane process ended.
  `expected` is `true` when this side asked (unmount, `restart()`, a `src`
  change) — and the event still fires after the frame unmounted, because
  the exit a graceful close ends in always arrives after the unmount that
  asked for it.
- **`fallback`** — what the rect shows when the pane crashed or could not
  start: an element, or `({ error, restart }) => …`. `error.phase` says
  where it went wrong: `spawn`, `load` (the commonest — a bad `src`),
  `connect`, `handshake` (version skew), `runtime`, `send`, `embed`, or
  plain `exit`.
- **`ref`** — `{ restart(), pid }`.

The pane's view:

- **`useFrameClose(handler)`** — the host is letting the pane go: the
  `<Frame>` unmounted, or the host app is exiting. The handler may return a
  promise and may still call callback props — flushing through one is what
  it is for. The patience is real but bounded: the host asks by message,
  escalates to SIGTERM at 1.5s, SIGKILL at 4s. Not called on a crash; a
  close handler is a courtesy, and anything that must survive a crash
  belongs on disk before the close.
- **`isFramed()`** — see above.
- A host that dies without asking takes the IPC channel with it, and the
  pane exits on the disconnect — no orphans either way.

## Sizing, stacking, input

The embedded pane is a [`<foreign>`](embedding.md), and its rules apply
verbatim. The rect comes from `style` and yoga like any child — there is no
content-driven sizing across the boundary. The pane's window is a real X
child window, so **host-drawn content cannot overlap it**; a HUD or a
"reconnecting…" banner belongs in a sibling `<popup>`. Pointer events over
the pane are the pane's without the host ever seeing them; keys follow
[embedding.md's focus rules](embedding.md#focus-and-who-gets-the-keys) —
the host's handlers see every key first, and what they do not consume is
forwarded.

On Cocoa and Windows the pointer can never be over a pane's window,
because the pane has none. The host hit-tests the frame's box and forwards
the input over the channel. The cursor travels the other way. The pane's
tree names its cursor as a window's would, the pane sends it
(`pane-cursor`), and the host shows it over the box. It is the box's
default cursor, so a `cursor` in the frame's `style` still wins. On X11 the
pane's own window carries its cursor, as any window does.

**A pane's other windows.** On X11 a `<popup>` in a pane is a real window on
the pane's own connection. A Cocoa pane process runs no AppKit, so a window
made there exists and is never shown — a `<Select>` in a pane took the press
and opened nothing (#824). So the pane paints each window it makes besides
its own into a shared ring, as it paints itself (`CocoaPaneSubwindow`,
`src/cocoa/panewindow.js`), and the host makes the `NSWindow` and shows the
ring in it (`src/cocoa/panehost.js`):

- **Where it goes is the pane's to say.** Every `pane-rect` carries
  `screen`, where the frame's box is on the screen in device pixels, sent
  again when the box or the window moves. A popup the pane anchors to one of
  its nodes is placed against it exactly as a window's popup is
  (`windowOrigin`, src/anchor.js), and the host puts the window where the
  pane says.
- **The window's life goes up, its input comes down.** `pane-window`
  messages make, map, move, resize, grab with and destroy it, and its
  `pane-present`s and `pane-cursor`s name it. Input on the host's window for
  it goes back as `pane-event`s naming it. A grab is the host's, so a press
  anywhere in the host's windows reaches the menu outside its bounds, which
  is the dismissal. A managed window — a `<Dialog>` — also sends back the
  user's moves and resizes and its close button.
- **The window's focus goes down too.** The host's window gaining or losing
  it is sent to the pane as `focus`/`blur`, so a menu that closes when its
  window loses focus (`useDismissOnWindowBlur`) closes when the user goes to
  another application.
- **Nothing waits on the host until it is listening.** These messages are
  held until the host's first `pane-rect`: it hears a pane from the moment
  it has a `<Frame>`, and knows what to do with them only once the pane is
  laid out in it. A window is then announced where it is, after that rect
  has placed what is anchored to the pane again.
- **The pane's windows go with it.** A pane that exits or unmounts takes
  every window the host shows for it, and their grab.

**A pane's videos.** A Cocoa pane runs no AppKit, so a player it made would
open the item and never hear AVFoundation say a word — a `<video src>` in a
pane sat on its poster and could not be started. So the host plays it
(`src/cocoa/paneplayer.js`): the hello tells the pane the host plays for
it, which is what makes `useSupports('mediaPlayback')` true there, and the
pane's `<video>` holds a player whose verbs go up as `pane-player` messages
and whose events come back down. The picture comes down the way the pane's
own goes up, the other way round: the host copies the frame showing into
one of a ring of three shared IOSurfaces and names it, and the pane copies
it out into the element's surface. A pane has no layers to lift a part
onto, so its video is always drawn, which costs the copy a covered video
costs in a window — the frame once into the ring, once out of it. A host
over a bridge with no player says nothing in the hello, and the pane
refuses `src` as X11 does. A pane that exits takes its players, and their
sound, with it.

**A pane resized.** On Cocoa the host gives the pane's layer its new size as
the window lays out, and the pane's frame of that size comes a pane frame
later. Core Animation's default stretched the frame the layer had to the new
bounds in between, so a page in a pane had its left column drawn scaled a
little at every step of a window dragged wider, and then drawn back at its
size. A pane whose frames of a new size come within the window's
live-resize budget, `createRoot({ cocoa: { resizeWait } })` (50 ms by
default), has its last frame shown at its size from the top left instead:
cropped on an axis the layer shrank on, and on one it grew on, its last
pixel carried over the rest — the last column across a window dragged
wider, the last row down one dragged taller. A page's edge is mostly its
background, so the strip continues it, a gradient included, where the
`<Frame>`'s own background showed through before. Where the edge crosses
content, a bottom row through a line of text, that content runs down the
strip in thin lines for the frame it lasts. One that falls behind the
budget is stretched across, which is the better picture of a long wait: a
width moves where a page's lines break, and a squeezed page is nearer to the
page laid out again than one cut off with a strip beside it. Down the pane
it stays at its size, cropped or its last row carried down, since a height
moves nothing a page lays out, and stretched down it was the page drawn too
tall for as long as the wait lasted. Behind is
judged by the frames that land: two in a row later than the budget, or none
at all for longer than it, and a frame well inside it shows the next at its
size again. A size the pane is never sent, because a newer one replaced it
while a frame was being painted, is no frame late, and a fast drag of a
page that keeps up stays at its size rather than taking one look at every
step and the other at every frame. Each gesture starts out at its size, and
`resizeWait: 0` stretches always, both ways, as before.

**A pane's frames are named by id, and the id outlives nothing.** On Cocoa
a present carries the IOSurface's id, and the host looks it up when it
reads the message. A resize has the pane make a new ring of buffers, and
the system gives a freed id to the next surface anyone makes — the pane's
next ring, another tab's, the host's own window. A present still in the
channel when its ring was freed was looked up as whichever surface had
the id by then: the pane's next frame cleared or half drawn, or another
tab's page, on glass for a frame at every few steps of a drag. So the host
answers each present it has looked up (`pane-shown`), and the pane keeps a
buffer it retired until the present naming it is answered: that is one
buffer as a rule, and never more than a ring of them, the oldest freed
first if the host stops answering. A pane's video comes down the same way
round: the pane answers each frame once it has looked its buffer up, and
the host keeps a buffer of a ring it retired — a stream that switched
renditions — until the frame naming it is answered. A lookup that finds a
surface of another size than its frame says is not copied out of at all.

**A pane draws only into a buffer the host is done with.** The ring holds
three buffers so that one present can be on its way while the next frame
draws: one on the layer, one named in the channel, one free. Each is made
the first time a frame takes it, copied over from the frame before: a drag
gives each size one frame, and a ring made whole at each was two buffers
made and cleared for nothing, 4.4 ms of every 12 ms frame of a drag of Zen
Garden 101 in the browser example on a Mac. A host two
presents behind — busy with a long frame of its own, a breakpoint's layout,
a window resize — left the next frame nothing but the buffer on the layer or
the one a present still in the channel named, and the frame drew into it
anyway: the host then showed a frame half drawn. So a frame takes a buffer
only once the host has answered a present after the last one that named it,
and waits on the clock for the next answer when there is none. An answer
says the host has looked the present up, not that the screen shows it, and
a host back from a long frame has the buffer it showed throughout still on
glass until its UI thread commits: so of the buffers the host is done with,
a frame takes one the WindowServer has let go of too, and waits for one, a
frame interval at most after the answer. A host that has not answered for
250 ms no longer holds the pane up.

The same answer gates the frame an input gets on the spot
(`flushPendingFrames`): a pane paints on an input only once its last present
is answered and a frame interval has passed since it went, and otherwise the
next frame on the clock answers it. The interval costs an input a few
milliseconds at the display's rate, and is what keeps a pane at one frame a
refresh: without it, input faster than the display had a frame each — 245 a
second on a 120Hz panel, at 250 inputs a second — and the frames that went
faster than the WindowServer let go of buffers drew into ones it still read.

`backgroundColor` in the frame's `style` is what shows before the pane's
first frame and after one dies — the same server-painted rectangle
`<foreign>` documents.

## What a pane costs

A pane is a node process with React and ntk loaded: roughly 40–70MB and
100–300ms of module graph before its first frame, plus an X connection.
That is the price of an event loop of one's own — right for a handful of
heavy panes, wrong as a general componentization strategy. A hundred
buttons belong in your process; the log viewer that parses gigabytes does
not.

## The transport seam

Everything between the host and the pane is six message types over an
injectable transport, and `transport` replaces the fork wholesale — it is
how the tests run a real pane (module, root, window, props, callbacks,
close handlers) in-process over a loopback pair against the in-process X
server, with `structuredClone` standing in for the fork's serialization
(`test/helpers/frame-loopback.js`, and `runFrameChild` in
`src/frame/childmain.js` is the pane's whole bootstrap behind the same
seam). It is also the door to running a pane somewhere other than a child
process without `<Frame>` learning about it.

## Known gaps

Named so they are not rediscovered:

- **Accessibility**: a pane registers on the AT-SPI bus as its own
  application. Orca reads it, and Tab crosses the boundary, but the tree is
  not unified under the host's.
- **DevTools**: a pane is its own React tree; `REACT_X11_DEVTOOLS=1` in the
  pane process attaches a separate DevTools, not a merged one.
- **No intrinsic size**: the host decides the rect; a `measure` protocol
  could exist and does not yet.
- **A window a pane opens in its first commit is placed against a guess.**
  The host has not laid the pane out yet, so the pane does not know where
  it is. A popup anchored to a node is placed again when the first
  `pane-rect` comes, before anyone sees it; a `<Dialog>` open from the start
  is centred where the pane guessed it was, as it is not anchored.
- **Windows** panes do not read `screen` yet: a popup a Windows pane
  anchors is placed against the screen's corner, the second half of what
  #824 fixed on Cocoa. Not run there.
- The `<window embeddable>` underneath (created unmapped, waiting for an
  embedder — see [embedding.md](embedding.md)) speaks plain reparenting
  today, not the `_XEMBED` messages; focus works through the forwarding
  rules above rather than XEmbed's own handshake.
