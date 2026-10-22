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
embeds its output here, laid out like any other child — this package's
iframe, on X11, Cocoa and win32. On the [Wayland backend](wayland-backend.md)
a `<Frame>` fails at once: `fallback` renders and no pane is started.

- **X11** — the pane renders into a real window of its own, which the host
  embeds over [`<foreign>`](embedding.md).
- **Cocoa** — the pane has no `NSWindow` and runs no AppKit: it paints into
  shared `IOSurface`s the host shows in a layer of its window, and every other
  window it makes (a menu, a dropdown's sheet, a tooltip, a dialog) the host
  shows in an `NSWindow` of its own.
- **Windows** — the same, with a DirectComposition surface; the pane has no
  HWND.

The host owns layout and hit testing, the pane its drawing: **CPU
offloading, not isolation**. What the process boundary buys:

- **Parallelism.** The pane's reconciliation, layout, text shaping and
  painting run on another core; a pane that grinds for 400ms does not delay
  the shell's input (`npm run examples:frame` shows it with a ticker).
- **Crash isolation.** An uncaught throw, a native-module crash, an OOM: the
  pane dies, `fallback` renders, `restart()` respawns.
- **Leak isolation.** A leaking pane is a killable leak, bounded by the heap
  its `execArgv` gives it, and its GC pauses are its own.

**It is not a security boundary** ([security.md](security.md)). On X11 the
pane holds a full-privilege connection to the same X server — it can read
keys, take screenshots, move windows — and on Cocoa it is an ordinary child
process with your file system and your network. `<Frame>` contains a pane's
_failures_, not its intentions.

| prop                  |                                                                          |
| --------------------- | ------------------------------------------------------------------------ |
| `src`                 | the pane module: a `URL` or an absolute path                             |
| `props`               | data for the pane; functions in it become stubs                          |
| `style`               | the pane's rect; `backgroundColor` shows while no pane frame does        |
| `fallback`            | element or `({ error, restart }) => …` for a pane that died or never ran |
| `bridge`              | bridged contexts: `true` (default), `false`, or a list of keys           |
| `display`             | X display for the pane; default the inherited `$DISPLAY`                 |
| `execArgv`, `env`     | flags and environment for the pane's process                             |
| `watchdog`            | ms unanswered before the pane counts as stuck; 15000, or `false`         |
| `focusable`           | whether the pane joins the tab order, like any `<foreign>`               |
| `onStarted`, `onExit` | the pane mounted; its process ended                                      |
| `transport`           | replaces the fork                                                        |
| `ref`                 | `{ restart(), pid }`                                                     |

Design notes (the display boundary per backend, and how a Cocoa pane's
frames, windows and videos travel): [design/frame.md](../design/frame.md).

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

The pane process inherits the parent's `execArgv`, which carries a dev loader
(tsx, the refresh loader) into it during development; a bundled application
forks plain JavaScript and needs none. It connects to the display the host
names in `display`, or `$DISPLAY`. What else it is started with is the
`<Frame>`'s to say — see
[The pane process](#the-pane-process-flags-and-environment).

On macOS:

- A pane stays on its process's main thread, where an app moves onto a
  worker ([macos.md](macos.md#js-on-a-worker-a-ui-thread-of-the-bridges-own)):
  it has no AppKit for that thread to keep, and its IPC channel is that
  thread's (a worker has no `process.send`). That holds under
  `--import react-x11/cocoa-main` too, which a pane inherits from its host.
- A pane launches with AppKit's `prohibited` activation policy: no Dock tile,
  no ⌘-Tab entry, never the active app — its host's window has the focus and
  forwards what the pane is owed. A root that names `cocoa.activationPolicy`
  itself still has the one it names.

## Props: a bag of data, and stubs for the functions in it

`props` crosses by **structured clone** — Dates, Maps, TypedArrays and
cycles survive; component instances, refs and React elements do not. One
message goes out per parent commit that changed the bag (a shallow
`Object.is` pass decides "changed", so a parent re-rendering without
touching the pane's inputs sends nothing), and props and bridged context
travel in the **same message**, so a theme flip and the state change that
caused it land in the pane as one commit rather than a torn pair.

Functions anywhere in the bag become **fire-and-forget stubs** on the pane
side: calling one sends its arguments back and returns `undefined`. Functions
inside the arguments are dropped and the data around them kept, so a pane can
call `onPick(item, ev)` the way it would call any handler, though `ev` is
full of methods.

Callback identity follows function identity: a handler the parent keeps
stable (`useCallback`) keeps its id across updates, and an id from the
previous update still lands — one update of grace, which covers a click
racing a props change. A stub stashed outside the props flow and called two
updates later is dropped with a warning, not delivered to the wrong function.

Two rules of thumb that keep the wire small:

- **The pane owns its data.** Props are for queries, ids, ranges — the pane
  fetches its own rows, the way an iframe fetches its own resources.
  Shipping a dataset through `props` on every commit works, and is the
  slowest possible way to have the pane know it.
- **The pane owns its animation.** An update is an IPC hop plus a pane
  commit: the right price for "show this now", the wrong one for driving a
  spinner at 60fps from the host.

## Context: bridged explicitly, theme by default

React context cannot cross a process boundary, and most of it need not:
appearance, locale, desktop settings and fonts resolve identically on both
sides. The rule: **bridge what the app defines; let each process resolve what
the desktop defines.**

The theme crosses **by default**: a `<ThemeProvider>` above a `<Frame>` wraps
the pane's **window** as a real `ThemeProvider` — `useTheme()` and `$token`
styles alike — from the pane's very first commit, so the pane's background
and static text follow the app's palette and its toggles, not the pane
process's desktop. With no provider above the frame, nothing is bridged and
the pane follows the desktop by itself. A pane's own provider wins below the
bridged one, as an inner provider always does.

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
dropped with a warning naming the key. That is deliberate: a bridged
`{ state, dispatch }` would hand live RPC stubs to every pane under the
provider, invisibly, and a restarted pane would leave it unclear which
incarnation holds which stub. Dispatchers travel in `props`, where the wiring
is visible. `serialize`/`revive` options on `createFrameContext` cover a
value that is data in spirit but a class in shape.

`bridge` is the off switch: `bridge={false}` bridges nothing,
`bridge={['react-x11:theme', 'session']}` is an allowlist.

The pane commits an IPC hop after the host, so a theme flip repaints the
shell a frame before the panes.

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
  `connect`, `handshake` (version skew), `runtime`, `send`, `embed`,
  `unresponsive` (see [A pane that stops answering](#a-pane-that-stops-answering)),
  or plain `exit`.
- **`ref`** — `{ restart(), pid }`.

The pane's view:

- **`useFrameClose(handler)`** — the host is letting the pane go: the
  `<Frame>` unmounted, or the host app is exiting. The handler may return a
  promise and may still call callback props — flushing through one is what
  it is for. The patience is bounded: the host asks by message, escalates to
  SIGTERM at 1.5s, SIGKILL at 4s. Not called on a crash; anything that must
  survive a crash belongs on disk before the close.
- **`isFramed()`** — see [The pane module](#the-pane-module).
- A host that dies without asking takes the IPC channel with it, and the
  pane exits on the disconnect — no orphans either way.

## Sizing, stacking, input

The embedded pane is a [`<foreign>`](embedding.md), and its rules apply. The
rect comes from `style` and yoga like any child — there is no content-driven
sizing across the boundary. On X11 the pane's window is a real X child
window, so **host-drawn content cannot overlap it**; a HUD or a
"reconnecting…" banner belongs in a sibling `<popup>`. Pointer events over
the pane are the pane's without the host ever seeing them; keys follow
[embedding.md's focus rules](embedding.md#focus-and-who-gets-the-keys) — the
host's handlers see every key first, and what they do not consume is
forwarded.

On Cocoa and Windows the pane has no window for the pointer to be over: the
host hit-tests the frame's box and forwards the input. Keys go over, with
their modifiers, as the box's default action, as `<foreign>` forwards them, so
a chord the host answered above the frame never reaches the pane. The cursor
the pane's tree names is the box's default cursor, so a `cursor` in the
frame's `style` still wins. On X11 the pane's own window carries its cursor.

**Tab goes through a pane as through any subtree.** The frame is one stop in
the host's order, and the pane's own order hangs off it: Tab arriving at the
frame goes on into the pane at its first stop, or its last for Shift+Tab;
Tab while the frame has the focus is the pane's; and the pane running off an
end of its order hands Tab back, and the host goes on from the frame. The
pane lets go of its focus as it does, so the stop it was at shows no ring
while the host's next one does. A modal open in the pane keeps Tab going
round inside it.

**A pane is drawn at the host's scale.** On Cocoa and Windows the host tells
the pane the scale its window is drawn at, and the pane's window, fonts and
the windows it opens are made at that scale from the first commit — even if
the screens changed between the host's start and the pane's — and laid out
again when it changes. A `<box scale>` around the `<Frame>` is not part of
it: the frame's box grows with the zoom, and the pane lays out at the
window's scale in the room it was given.

**A pane's other windows.** On X11 a `<popup>` in a pane is a real window on
the pane's own connection. On Cocoa the host shows each window the pane makes
besides its own — a `<popup>`, a menu, a `<Select>`'s list, a `<Dialog>` — in
an `NSWindow` of its own:

- A popup the pane anchors to one of its nodes is placed against it exactly
  as a window's popup is, and placed again when the frame's box or the window
  moves.
- A grab is the host's, so a press anywhere in the host's windows reaches the
  menu outside its bounds, which is the dismissal. A `<Dialog>` gets the
  user's moves and resizes and its close button.
- The host window's focus is sent to the pane as `focus`/`blur`, so a menu
  that closes when its window loses focus (`useDismissOnWindowBlur`) closes
  when the user goes to another application.
- A pane that exits or unmounts takes every window the host shows for it,
  and their grab.

**A pane's videos.** On Cocoa the host plays a pane's `<video src>` for it, so
`useSupports('mediaPlayback')` is true in a pane whose host can play. A pane's
video is always drawn — it has no layer to lift it onto — so it costs the copy
a covered video costs in a window, twice: into a shared ring and out. A host
over a bridge with no player plays nothing, and the pane refuses `src` as X11
does. A pane that exits takes its players, and their sound, with it.

**A pane resized.** On Cocoa the pane's frame at a new size comes a pane frame
after the host's window lays out. What shows in between is set by
`createRoot({ cocoa: { paneStretch } })` or `REACT_X11_COCOA_PANE_STRETCH`:

- **`'behind'`** (the default) — while the pane keeps within the window's
  live-resize budget, `createRoot({ cocoa: { resizeWait } })` (50 ms by
  default), its last frame is shown at its size from the top left: cropped on
  an axis the layer shrank on, its last column or row carried across one it
  grew on. A pane two frames in a row later than the budget, or with none for
  longer than it, is stretched across to its new width until a frame lands
  well inside the budget; down the pane it stays at its size. Each gesture
  starts out at its size, and `resizeWait: 0` stretches always, both ways.
- **`'never'`** — at its size, its edge carried over, however late the pane
  is.
- **`'always'`** — stretched both ways.

A carried edge usually continues the page's background; where it crosses
content, that content runs down the strip in thin lines for a frame. The
pane's window's `liveResizing` is the host's, so content floors are measured
once the drag ends, as in a window of its own, and an element can put off
work until then too.

`backgroundColor` in the frame's `style` is what shows before the pane's
first frame and after one dies — the same server-painted rectangle
`<foreign>` documents.

## The pane process: flags and environment

`execArgv` and `env` say what a pane's process is started with, beyond what
it inherits:

```jsx
<Frame
  src={new URL('./page.pane.js', import.meta.url)}
  // a page that grows without bound costs its own process, at 256 MB
  execArgv={['--max-old-space-size=256']}
  env={{ PAGE_LOG: 'quiet', NODE_OPTIONS: undefined }}
/>
```

- **`execArgv`** comes after the flags the pane inherits, so a dev loader
  still follows it in and a flag it names is the one in force where the two
  disagree. `--max-old-space-size` is the one a pane wants most: it bounds
  the pane's heap, which nothing running inside the pane can, and a pane
  that passes it is ended — and its `fallback` shown — rather than the
  machine swapping. The flags go to the runtime that forks the pane, and are
  its flags: Bun 1.4 takes node's V8 flags and bounds nothing by them, so
  under Bun this is not a heap bound.
- **`env`** is merged over this process's environment, and a variable named
  with `undefined` is taken away. `DISPLAY` is `display`'s, and
  `REACT_X11_FRAME` is how a pane knows it is one (`isFramed`), so the two
  are set after it and cannot be overridden here.

Either is read by value: the same flags in a new array — one written in
place, as above, at every render — keep the pane it was, and flags or
variables that say something else restart it, as a new `src` does. Something
a fork cannot take — a flag that is not a string — fails as a `spawn` error
and starts nothing.

## A pane that stops answering

A pane whose event loop is stuck — a loop that never ends, a page's script
with no timeout around it — would otherwise stay `running`: it is sent
updates it never reads, its window keeps showing its last frame, and on X11
it holds the keyboard while the pointer is over it.

So the host asks. About once a second it sends the pane a `ping`, which the
pane answers from its event loop. A pane that has not answered for
`watchdog` ms — 15 seconds by default — goes the way a crashed one goes: the
frame fails with phase `unresponsive`, `fallback` is shown and can
`restart()` it, and the process is ended from outside, SIGTERM and then
SIGKILL, since it cannot read an unmount. `onExit` reports it with `expected: false`.

```jsx
<Frame
  src={new URL('./page.js', import.meta.url)}
  watchdog={10000}
  fallback={({ error, restart }) =>
    error?.phase === 'unresponsive' ? (
      <PageStopped onReload={restart} />
    ) : (
      <PageCrashed error={error} onReload={restart} />
    )
  }
/>
```

Three things keep it from ending a pane that is fine:

- **The host's own late tick is no news of the pane's.** Where the host's
  timer comes late — the machine slept, or the host itself was stuck — the
  count starts again from that tick.
- **A pane under the inspector is not watched.** `--inspect`,
  `--inspect-brk` or `--inspect-wait`, in its own `execArgv`, in this
  process's that it inherits, or in `NODE_OPTIONS`: a debugger stops a pane
  on purpose. The flags that only set the inspector up, which Node's test
  runner hands every test process, do not count.
- **`watchdog={false}`** watches nothing, for a pane whose work is long
  and synchronous by design.

A pane of an older react-x11 that does not know the ping fails the handshake,
which says why, rather than being ended for not answering.

## What a pane costs

A pane is a node process with React and ntk loaded: roughly 40–70MB and
100–300ms of module graph before its first frame, plus an X connection.
That is the price of an event loop of one's own — right for a handful of
heavy panes, wrong as a general componentization strategy. A hundred
buttons belong in your process; the log viewer that parses gigabytes does
not.

## The transport seam

`transport` replaces the fork wholesale: it is the door to running a pane
somewhere other than a child process without `<Frame>` learning about it
(react-x11's own tests run a real pane in-process over a loopback pair this
way). A transport is handed what the fork would be — `{ src, display,
execArgv, env }` — and returns the parent's end of the wire: `send`,
`onMessage`, `onExit`, and optionally `kill` and `pid` (`FrameTransport` in
the types).

A transport that still forks the pane, its own way (under a sandbox, with
another runtime), forks the entry the default one does, which is on the
exports map to be resolved: `fileURLToPath(import.meta.resolve(
'react-x11/frame/child'))`. It is a process's entry, not a module to import:
outside a fork it says so and exits.

## Known gaps

- **Accessibility**: a pane registers on the AT-SPI bus as its own
  application. Orca reads it, and Tab crosses the boundary, but the tree is
  not unified under the host's.
- **DevTools**: a pane is its own React tree; `REACT_X11_DEVTOOLS=1` in the
  pane process attaches a separate DevTools, not a merged one.
- **No intrinsic size**: the host decides the rect.
- **A window a pane opens in its first commit is placed against a guess**,
  since the host has not laid the pane out yet. A popup anchored to a node is
  placed again before anyone sees it; a `<Dialog>` open from the start is
  centred where the pane guessed it was.
- **Windows** panes do not know where their frame is on the screen yet: a
  popup a Windows pane anchors is placed against the screen's corner. Not run
  there.
- **A pane hears its window's focus, not its frame's.** Tab out of a pane
  takes its focus with it, but a click on the host does not: the stop the
  pane had focused keeps its focus, and its ring, while the host's is
  elsewhere.
