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
embeds its window here, laid out like any other child. It is this package's
iframe: the same composition of a window boundary and a process boundary,
behind one element. Both boundaries already existed separately — the window
half is [`<foreign>`](embedding.md), the process half is a forked node — and
`<Frame>` is deliberately nothing more than the contract between them.

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
[security.md](security.md): **it is not a security boundary.** The pane
holds a full-privilege connection to the same X server — it can read keys,
take screenshots, move windows. `<Frame>` contains a pane's _failures_, not
its intentions; code you would not run in-process is code you should not run
at all.

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
palette first. With no provider above the frame, nothing is bridged and the
pane follows the desktop by itself: same answer, no bridge. A pane that
wants its own look mounts its own provider, which wins below the bridged
one the way an inner provider always wins.

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
- The `<window embeddable>` underneath (created unmapped, waiting for an
  embedder — see [embedding.md](embedding.md)) speaks plain reparenting
  today, not the `_XEMBED` messages; focus works through the forwarding
  rules above rather than XEmbed's own handshake.
