# Testing: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/testing.md](../docs/testing.md), the reference, and keep
their original headings so code comments that cite them still resolve.

Paragraphs below are the originals of ones the reference now says more
briefly; the facts an app needs stayed in the reference.

The page's introduction:

**The harness drives the X11 backend**, on every platform including macOS —
there is no `'cocoa'` backend for `renderX11()`, and `createRoot()`'s own
choice does not apply here because the harness always passes it an `app`.
That is deliberate rather than pending: the point of this harness is a real
protocol connection to a real server in-process, and macOS has no protocol
to connect to. What it means in practice is that an app targeting both
backends tests its **tree, its queries and its behaviour** here — all of
which are shared — while anything that is genuinely per-backend (a native
bezel's pixels, an `NSMenu`, a pasteboard flavour) is covered by the
renderer's own Cocoa tests against a fake bridge, and by looking at a Mac.

## Components

`getByComponent` returns, per rendered instance, the topmost host nodes of
its output — the container `within()` wants next. Ownership is React's JSX
owner (_who wrote the element_), so content passed as children belongs to
the component whose JSX it appears in, and a miss lists the component names
that are in the tree. All of this reads debug info development React records
on every fiber (`_debugOwner`, `_debugStack` — the same data
[click-to-component](../docs/click-to-component.md) navigates by), so it costs no
setup and no dependency, and returns nothing in production builds.

### `inspect(node)` and `setHook`

This drives the **React DevTools backend in-process**: the same
react-debug-tools inspection and the same override path the DevTools app
uses, minus its WebSocket — nothing listens on anything, and `ws` is never
loaded ([devtools.md](../docs/devtools.md) has the wiring). It needs the
`react-devtools-core` package in your devDependencies; the queries above
work without it.

What to know before leaning on it:

- **Reading hooks re-runs the component.** That is how react-debug-tools
  recovers hook names: the render function is invoked once under a stub
  dispatcher, output discarded, `console` muted. A render-counting test
  will see it.

## Driving it

Two things this buys that emitting on the ntk window never could:

**Grabs are real.** A `<popup grab>` is dismissed by a real press outside
it. But note _where_ outside: react-x11's popups grab with **owner events**,
so a press on one of the client's own windows is delivered normally — that is
what keeps submenus and the owner window working. Only a press somewhere the
client does not own reaches the grab holder. `userEvent.clickOutside()` is
how a test says that; clicking another widget and expecting the menu to close
is testing the wrong thing.

**Focus is real**, so `trapFocus`, `autoFocus` and Tab traversal are
exercised rather than simulated. Deciding which window gets the keyboard is a
window manager's job and there is no window manager, so `renderX11` plays the
part with one `SetInputFocus` at mount — otherwise keys would go to whatever
the pointer happened to be over, which is a rule nobody should have to learn.

**A smooth scroll is the one exception**, and says so. Whole notches go
through the server as the button presses X really uses, but a touchpad's
fraction of a notch is XI2, and the in-process server has no XInput — there
are no valuators to inject. `{ smooth: true }` therefore delivers the `wheel`
event ntk would have derived from them, straight to the window. Everything
above it is still the real path: the dispatch, the chain, the default action.

## `act`, and the three clocks

It `act`s once more after the attempt that passes, so what it resolves with
is on screen. That matters for a node. What an attempt finds can have arrived
in the pause before it — an fs read, a timer — and that commits outside
`act`, on React's own scheduler, while the frame that lays it out runs on the
third clock, which need not have ticked since. Without that last `act`, a
row found that way could have no rect yet, and the click after it would throw
`has no laid-out rect yet`.

## Pixels

`toPNG` is also how a pull request gets a screenshot rendered by its own
code, which this repo asks for ([AGENTS.md](../AGENTS.md), "Pull requests").
