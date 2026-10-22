# Elements: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/elements.md](../docs/elements.md), the reference, and keep
their original headings so code comments that cite them still resolve.

Every heading here also stays in the reference, which carries the tightened
version; what follows is the original text of the paragraphs whose
mechanism, history, measurements or extended rationale did not survive the
tightening, in their original order.

Only `<window>`, `<popup>`, `<glarea>` and `<foreign>` are backed by real
windows of the display system — on X11, X windows created top-down in
React's commit phase so every `CreateWindow` names its actual parent — and,
for `<foreign>`, so that no `ReparentWindow` is ever issued from a render
React might discard.
Everything else is a retained lightweight node — one
[yoga-layout](https://www.yogalayout.dev/) node each — painted into the
owning window's double-buffered 2d context on ntk's frame clock.

## Layout properties (all drawn elements + windows)

### Everything shrinks, nothing shrinks to nothing

`flexShrink` is `1`, as in CSS: an item hands back the space it has spare
when the row it is in runs short, rather than pushing the row past its
container. And **it never gives up what is inside it** — every item carries a
floor of its own min-content size, which is CSS's automatic minimum size
(`min-width: auto` on a flex item) written out by the renderer, since yoga
implements the shrinking half and not the floor half. A row of chips squeezes
until it wraps; a label squeezes to its longest word; a `height: 40` row
stays 40 tall.

The last two are CSS's own rule — `min-*: auto` computes to `0` on anything
whose overflow is not `visible` — and they are what makes a scroll pane
possible: a viewport is a box that is _allowed_ to be smaller than what is
inside it. A `<box overflow="scroll">` gets `minWidth: 0` and `minHeight: 0`
for free.

One deliberate difference from CSS: **a size that was named is kept**. CSS
floors an item at `min(the size it was given, its content)`, so an empty
`height: 40` box squashes to nothing in a column too short for it; that is
survivable on the web because a `<div>` is a _block_ container and its
children are not flex items at all, and it is not survivable here, where
every box lays its children out with flex. Say `minHeight: 0` to get CSS's
answer for one.

The measurement costs the tree an extra layout pass per axis, on frames that
change the layout — a scroll, which moves no box, keeps the single pass it
always had.

## Paint properties

`cursor` (`'pointer'`, `'text'`, `'wait'`, `'move'`, `'crosshair'`, resize
arrows, … — the ntk cursor name map) and `pointerEvents` are style too: CSS
has both, and React Native has been moving `pointerEvents` the same way.
`pointerEvents: 'none'` takes a node and its subtree out of hit testing;
`'box-none'`, React Native's, takes out only the node itself — its children
still take the pointer, and a press on its own area goes to what is behind
it. That is the value for an overlay of controls that must not swallow the
clicks between them, a `<glarea>`'s children over a scene whose input lives
on the element behind the surface included. So is `hitSlop`:

```jsx
<box style={{ height: 16, hitSlop: { top: 4, bottom: 4 } }} /> // 24px target
```

## `<window>`

| prop                        |                                                                                                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`                     | window title (UTF-8, via `WM_NAME` + `_NET_WM_NAME`)                                                                                                                                                                                                      |
| `width`, `height`, `x`, `y` | window geometry (window state, not yoga style — the user may resize). A size is pixels or `'auto'`, and leaving it out means `'auto'` (below). A change sends only what changed: a new size leaves the window where the window manager or the user put it |
| `backgroundColor`           | full-window clear color (default white)                                                                                                                                                                                                                   |
| `onResize(ev)`              | ConfigureNotify — the tree reflows automatically. Fires for **moves** too (see below)                                                                                                                                                                     |
| `onExpose(ev)`              | after a repaint was required                                                                                                                                                                                                                              |
| `onCloseRequest(ev)`        | WM close button — replaces the default answer (see below); `WM_DELETE_WINDOW` is advertised either way                                                                                                                                                    |
| `states`                    | EWMH `_NET_WM_STATE` — controlled, see below                                                                                                                                                                                                              |
| `fullscreen`, `alwaysOnTop` | boolean sugar for two of those states                                                                                                                                                                                                                     |
| `decorations`               | `false` asks the WM for no titlebar or border                                                                                                                                                                                                             |
| `transparent`               | 32-bit ARGB visual — rounded, translucent windows (below)                                                                                                                                                                                                 |
| `transientFor`              | ICCCM `WM_TRANSIENT_FOR` — the window this one belongs to (below)                                                                                                                                                                                         |
| `onStatesChange(states)`    | what the window manager actually did                                                                                                                                                                                                                      |
| `onClientMessage(ev)`       | a ClientMessage addressed to this window — EWMH, XEmbed, the tray (below)                                                                                                                                                                                 |
| `theme`                     | palette that `$token` style values resolve against, for this subtree                                                                                                                                                                                      |
| `embeddable`                | created but never self-mapped: the window waits for an embedder ([`<foreign>`](../docs/embedding.md) on the other side), which maps it after the reparent. What a [`<Frame>`](../docs/frame.md) pane's root window sets                                   |
| `hidden`                    | realized and laid out, never mapped while true (below)                                                                                                                                                                                                    |
| `frameRate`                 | how the window paces its frames under a stream of changes: `'display'` (the default), `'adaptive'`, `'throughput'`, a ceiling in fps, or `{ budget, minFps, maxFps }` (below)                                                                             |

#### On the Cocoa backend

Everything above that is about _drawing_ — geometry, background, resize,
close, `transparent`, `theme`, `frameRate`, `hidden` — works. What a
**window manager** does is where the two part company, because macOS has no
separate one to negotiate with, and the honest list is short:

| prop                                                             | on Cocoa                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `minWidth`/`minHeight`/`maxWidth`/`maxHeight`                    | honoured — they become the window's own min/max size                                                                                       |
| `resizable`, `decorations`                                       | honoured, but read **once, at creation**: they are `NSWindow` style options rather than hints, so changing either after mount does nothing |
| `transparent`, `borderRadius`                                    | always available; every window composites, so there is no "if a compositor is running"                                                     |
| `states: ['demands_attention']`                                  | the Dock bounce, held until the state is removed                                                                                           |
| `fullscreen`, `states: ['maximized' \| 'hidden']`                | the green button's full-screen Space, the zoom, and the Dock, through `toggleFullScreen:`, `zoom:` and `miniaturize:`                      |
| every other `_NET_WM_STATE`                                      | inert — `sticky`, `below`, `skip_taskbar`, `shaded` and the rest have no AppKit equivalent                                                 |
| `onStatesChange`, and `useWindowState()`                         | fire for full screen (from the transition's begin), the zoom, the Dock and the key window; `desktop` and `obscured` never change           |
| `appId`, `windowType`, `gravity`, the increment and aspect hints | inert. They are messages to a window manager, and there is not one                                                                         |
| `transientFor`                                                   | inert today — a stub waiting on `addChildWindow`; a managed `<Dialog>` already floats on its own window                                    |
| `onClientMessage`                                                | never fires — X11's ClientMessage has no counterpart                                                                                       |
| `embeddable`                                                     | means a `<Frame>` pane, and works — but through shared surfaces rather than reparenting ([frame.md](../docs/frame.md))                     |

Inert means **inert, not fatal, and today also silent**: the prop is
accepted and does nothing, so shared application code stays branch-free. See
[macos.md](../docs/macos.md#windowing-semantics-what-maps-what-bends-what-breaks)
for why that is the policy and what it costs.

### Natural size

This is CSS's `width: auto`, read the way CSS reads it for a box whose
containing block is the viewport but which is not in flow — a float, an
abspos, an inline-block: **shrink-to-fit**. A top-level window has no
container to stretch into, and stretching into the screen is what
`fullscreen` means.

The size is worked out **before `CreateWindow`**, so the window is created
the right size rather than resized into it after mapping. Nothing is ever on
screen at the wrong size, and there is no jump to watch for.

Where this parts company with CSS: shrink-to-fit is
`min(max(min-content, available), max-content)`, and that `max(…)` means a
CSS box never shrinks below its min-content size even when it overflows. A
window cannot be wider than the screen, so the cap wins and the content is
cut instead.

**The cap** is the usable area of the monitor the window will open on:
Xinerama's per-monitor rects — so a window on a two-head desktop is bounded
by one screen and not by both — with `_NET_WORKAREA` taken off it per axis,
so a panel is not space to grow into. Both are read once while `createRoot()`
connects. On a server with neither, the cap is the screen; with no display to
ask at all — the headless mock — there is no cap. The window manager's frame
is _not_ modelled, so a window that reaches the cap is a titlebar taller than
the work area and the WM will trim it.

**Afterwards, auto keeps up with the content until something else sets the
size.** Add a row and the window grows, take it away and the window shrinks
back; the moment the user drags an edge, or a window manager answers with a
size of its own, the window is theirs and stops re-fitting. Setting `width` to
a number is the app doing the same thing, and setting it back to `'auto'`
hands it back. Only a size the window did not ask for counts: its own
requests come back from the server as echoes, sometimes late and sometimes
behind a move that still carries the old size, and none of those is anybody
taking the window over.

**A re-fit is laid out once, at the new size.** On X11 a window takes a size
when the server answers the request, a round trip later, so the frame that
re-fits waits for that answer before it lays out, and the old pixels stay
up meanwhile. Laid out at the size it still had, content that grew would be
drawn for a round trip wrapped and cut off at the bottom of a window too
small for it — a tooltip whose value gained a word. A request answered with
no new size (a window manager refusing it) gives up the wait after 150 ms.
Cocoa takes a size on the call, so there is nothing to wait for there.
`REACT_X11_NO_REFIT_HOLD=1` turns the wait off
([debugging.md](../docs/debugging.md#react_x11_no_refit_hold1)).

### A floor the content decides

This is what Qt and GTK both do, and in both it is the default rather than
something you ask for: a Qt layout's `minimumSize()` becomes the window's
via `QLayout::SetDefaultConstraint`, and GTK writes the widget tree's
minimum into the WM geometry hints. Here it is opt-in, because a renderer
whose layout is CSS has no floor unless one is asked for — CSS lets content
overflow.

This is the same measurement every node's own floor comes from (above), read
at the top of the tree — so the escape hatch is the same one, and it is the
one CSS, Qt and GTK all spell: `min-width: 0`, `QScrollArea`,
`min-content-width`. A node that named a floor of its own is taken at its
word and its contents stop counting, so a window around a scrolling pane is
floored by everything _except_ that pane.

Three things worth knowing:

- **A floor is a request.** mutter, kwin and xfwm enforce it at the drag; a
  tiling window manager may size the window however it likes. It stops the
  user, it does not relieve the app of clipping gracefully — and the
  renderer will not fight a window manager that ignores it.
- **`minHeight="auto"` is measured for the width the window has**, and
  re-sent as that changes. A minimum height is a height _for a width_ — a
  paragraph is tallest at its narrowest — and `WM_NORMAL_HINTS` holds two
  independent numbers with no way to say so. (GTK answers the same question
  at its minimum _width_, which is a taller floor than a wide window needs.)
- **The floor outlives the size.** An `'auto'` size stops tracking once the
  user takes the window over; an `'auto'` bound does not, because stopping
  them going too far is the whole job. It is measured on every frame that
  lays out — one extra layout pass per axis asked for — and written only on
  the frames it actually moves.

Three things worth knowing before reaching for it:

- A scroll container reports its **content** height, not a viewport height,
  so an auto window around a long list opens as tall as the screen. Give the
  window a `height`, or the scrolling box a `maxHeight`, if the scrolling is
  meant to happen inside a smaller window.
- The natural size is measured with **no available width**, where nothing
  wraps and nothing is short of room to shrink into, so an auto width is the
  **unwrapped** row. That makes the width font-dependent: the same window is
  wider under a wide UI face than under a narrow one.
- Measuring costs an extra layout pass per frame that lays out, for as long
  as the window is still tracking. A window with both sizes given pays
  nothing.

### `hidden` — realized, laid out, not on screen

On a `<popup>` the pair of unmap/map is the whole story. On a managed
`<window>` an unmap is ICCCM's _withdraw_ — the window manager forgets the
window, and the re-map is a fresh `MapRequest`, so a WM may frame or place
it anew and `states` are re-declared rather than remembered.

### `frameRate` — pacing the frames under a flood

By default a window paints every frame the clock gives it: on X11 as often
as the server keeps up, on macOS at the display's own rate. That is right
for a UI that answers input — a keystroke, a hover, a scroll — where every
frame is one someone is waiting for. It is wrong for a window whose content
changes faster than anyone can read it: a terminal under `cat`, a chart fed
by a socket, a simulation ticking as fast as it can. On a 120Hz panel such a
window paints 120 times a second, and where a frame costs a few
milliseconds of the JS thread — full-window CoreGraphics passes on macOS —
most of that thread goes to painting screens nobody sees, and the producer
gets what is left. Measured on a streaming terminal, that was a flood four
times slower on macOS than under XQuartz on the same machine, and the whole
difference was frame count times per-frame cost.

`frameRate` prices frames in CPU time rather than counting them. A window
under `'adaptive'` keeps a budget: painting may take a quarter of the wall
time while the window is busy. Credit accrues at that rate, a frame spends
what it measurably cost — the flush, and on macOS the present — and a claim
that finds the window in debt waits for the credit to reach zero, and no
longer. Four things follow, and they are what the tests pin:

- **Idle is immediate.** A quiet window has a full bucket, so the first
  claim after a pause — a keystroke, a click — paints on the next tick,
  whatever the last frame cost.
- **Cheap is unthrottled.** A frame that costs less than the credit it
  accrued leaves the bucket where it was. A blit-scrolled list keeps the
  display's rate: its frames are memmoves and a strip.
- **A rare expensive frame is free.** The bucket holds a burst — 50ms of
  paint, the floor's interval — so the one relayout in a scroll costs
  credit, the credit refills, and nothing waited. Only a _stream_ of
  expensive frames drains it, and then each waits `cost × (1/budget − 1)`:
  a 6ms frame is followed by 18ms of the thread for everything else.
- **A flood that ends is un-throttled at once.** The debt is never more than
  one frame's cost, so the prompt that appears when the flood stops waits
  for that and nothing more.

Two more numbers bound the rule. `minFps` is the floor: whatever the debt,
the screen is never more than `1000 / minFps` ms behind the last paint — a
promise about staleness, not a rate, since a single frame can take longer.
`maxFps` is a ceiling on top of the display's, cheap frames included — the
knob every terminal already has.

| value                        | `budget` | `minFps` | `maxFps` | when                                                                                   |
| ---------------------------- | -------: | -------: | -------: | -------------------------------------------------------------------------------------- |
| `'display'` (the default)    |        1 |     none |     none | a UI answering input: every frame the clock gives, after React's own batching          |
| `'adaptive'`                 |     0.25 |       20 |     none | a window fed off an input path: a terminal, a live chart, a scene that streams         |
| `'throughput'`               |      0.1 |       10 |       30 | output matters more than the display: the screen may lag by up to 100ms during a flood |
| a number, `60`               |        1 |     none |       60 | a ceiling and nothing else — the fixed cap                                             |
| `{ budget, minFps, maxFps }` |          |          |          | the three numbers, any subset; the ones left out are `'display'`'s                     |

A budget below 1 with no `minFps` warns in development: after an expensive
frame the next may wait three times its cost with nothing to bound it, and
`{ budget, minFps: 20 }` is what `'adaptive'` does.

Three sources, in order of precedence: **`REACT_X11_FRAME_RATE`** in the
environment (`adaptive`, `display`, `throughput` or a number) overrides
everything, the way `REACT_X11_BACKEND` does, so an A/B run and a field
diagnosis need no code change; then **the prop**; then
**`createRoot({ frameRate })`**, the default for every window of that root;
then `'display'`. A `<popup>` paces itself the same way, from its own prop.
A [`<glarea>`](../docs/elements.md#glarea) takes the window's policy for its own frames unless
it names one.

What the pacer does not do. It never changes what a frame paints: a held
claim's damage accumulates on the window exactly as it does between two
ticks of the clock, and the frame that follows paints all of it. It never
holds the answer to an input: a click or a key paints the window at once
(the early flush in [events.md](../docs/events.md)), held claims included, and the
debt is paid then. And it prices the JS thread's time only — on X11 the
server's work is fenced by the frame clock already, so the pacer rarely
holds a frame there; where a backend has backpressure of its own, the
pacer is inert. `REACT_X11_TRACE=requests` prints `waited=` on every frame
the pacer held ([debugging.md](../docs/debugging.md)), and
[architecture/frame-pacing.md](architecture/frame-pacing.md) is the design
record, with the measurements.

### `onResize` fires for moves

`onResize` is X's `ConfigureNotify`, which reports _any_ geometry change:
under a window manager that moves windows opaquely, dragging one by its
title bar delivers one per pointer step, all the same size. The renderer
already discriminates — a move costs no layout and no repaint — but a
handler of your own has to, or it does its work per step of a drag. The
event says which it was:

```jsx
<window
  onResize={(ev) => {
    if (ev.resized) refit(ev.width, ev.height);
    if (ev.moved) rememberPosition(ev.x, ev.y);
  }}
/>
```

`ev.previous` carries the geometry these are measured against. Note that
`ev.x`/`ev.y` are frame-relative once a reparenting window manager has
framed the window, so they are not screen coordinates — the renderer
resolves the real origin itself for popup anchoring.

### Stacking

Nested `<window>`s stack the way drawn siblings paint: the later sibling
sits on top, and `zIndex` wins over document order. Reordering them in JSX
restacks the real windows — one `ConfigureWindow` pass per commit, and
nothing at all when mount order already agrees.

Top-level windows are the window manager's to stack — it redirects the
request — so their order in the tree carries no stacking meaning. Use
`alwaysOnTop` (below) for those.

### Window manager hints

Properties the window manager reads (ntk ≥ 3.5.0). All work at mount and
update; unchanged values are not re-sent. The size hints are flat props like
the geometry they constrain — with style in its own channel the yoga names
are free, so no `sizeHints` object is needed.

### `transientFor` — a window that belongs to another

Measured against quartz-wm — the thinnest EWMH implementation in the stack,
so this is a floor rather than a best case:

| the client sets       | the WM allows                                                 | the WM adds to `_NET_WM_STATE` |
| --------------------- | ------------------------------------------------------------- | ------------------------------ |
| nothing               | close, minimize, move, resize, maximize horz/vert, fullscreen | —                              |
| `transientFor`        | close, minimize, move, resize                                 | skip_taskbar, skip_pager       |
| `windowType="dialog"` | close, minimize, move, resize                                 | skip_taskbar, skip_pager       |

Rows two and three matching is the EWMH rule working as specified: a managed
window with `WM_TRANSIENT_FOR` and no `_NET_WM_WINDOW_TYPE` **is** a dialog.
The converse does not hold — a `dialog` type with no owner is a dialog
belonging to nobody, with nothing to stack above or iconify with — so set
both, which is what real toolkits do. A fuller window manager also restacks
the transient above its owner and iconifies it alongside; quartz-wm does
neither, and both are policy rather than spec.

**It is inert on an override-redirect window**, which is every `<popup>` by
default: the WM never manages those, so nothing reads the property. ICCCM
4.1.2.6 draws exactly that distinction — `WM_TRANSIENT_FOR` for windows the
WM manages, override-redirect plus a pointer grab for menus. ntk warns if
you ask it to write the property on one.

Resolution happens in the **commit phase**, not at element creation: a React
ref is not something ntk should be asked to understand. Refs attach in the
layout phase, after every mutation, so on the commit that mounts two sibling
`<window>`s the second realizes while the first one's ref is still null —
that owner is retried on the frame the mount schedules rather than dropped.

`windowIdOf(refOrInstance)` is the same resolution, exported: it returns the
XID a ref points at, or null. It is also what an xdg-desktop-portal
`parent_window` handle needs — `` `x11:${id.toString(16)}` ``, lowercase hex
with **no** `0x` prefix. Both shipping portal backends happen to tolerate a
prefix, which is exactly why it is easy to get wrong and never notice; Qt's
parser returns 0 on failure with no error path, so the symptom would be a
silently unparented, non-modal dialog. `useWindowId(ref)` is the hook form
and returns a getter, like `useAnchor`.

### Closing a window

Every window the window manager manages advertises `WM_DELETE_WINDOW` in
`WM_PROTOCOLS`, whether or not you pass `onCloseRequest`. That property is
what lets the WM _ask_ a window to close; a client without it can only be
shot, so the close button becomes `XKillClient` — the connection dies
mid-frame, effects never clean up, and IceWM asks the user to confirm the
kill first. Advertising it is not an opt-in feature, it is the difference
between closing and crashing, so react-x11 does it for you.

### Window state

**These are controlled props, and the reason is not React convention.** On X
the window manager changes state behind the app's back constantly: the user
hits maximize, a global hotkey leaves fullscreen, a tiling WM has its own
opinion. react-x11 therefore diffs `states` against the _previous props_,
never against what the window currently has — so a prop is re-sent only when
the app changes its mind, and a WM that disagreed is not fought on the next
commit. `onStatesChange` is the other half: it reports what the WM actually
did, and subscribing to it is what makes react-x11 watch the property, so a
window without a handler costs nothing.

States are applied **before the window is mapped**, which is what EWMH 7.7
requires and the only way to open already fullscreen instead of flashing at
the normal size first.

### `onClientMessage` — speaking a protocol of your own

`ev.messageType` is the atom's **name**, which is the point: without it a
handler has to intern its atoms first and compare numbers, and cannot say
anything at all until those round trips have landed. `ev.atom` is the id it
came in as, `ev.format` is 8, 16 or 32, and `ev.data` is the payload at that
width — 5 values at 32, 10 at 16, 20 at 8.

Nothing has to be armed. A ClientMessage reaches its window's owner whatever
event mask that window selected, so a `<window>` without the prop pays
nothing and one with it needs no other setup.

- **Messages arrive in the order they were sent.** The chunked protocols
  depend on it — `_NET_SYSTEM_TRAY_BEGIN_MESSAGE` and the
  `_NET_SYSTEM_TRAY_MESSAGE_DATA` pieces after it reassemble by arrival order
  and nothing else. Naming a type this connection has never seen costs one
  `GetAtomName`, and everything behind it waits rather than overtaking it.
  `messageType` is therefore `null` only for an atom the **server** does not
  know, which is a broken sender.

### Kiosk

`cursor: 'none'` hides the pointer outright (ntk ≥ 4.2.0). It is not the
same as leaving `cursor` unset, which inherits whatever the root window's
cursor is — see [styling.md](../docs/styling.md).

### `transparent` — rounded corners and translucency

Two props do the work together. `transparent` gives the window somewhere to
put transparency; `borderRadius` in the window's own `style` rounds the
background painted into it, and the corners it gives up are the corners the
desktop then shows through. The edge is **antialiased**, because it is alpha
rather than the Shape extension's 1-bit mask — no `XShapeCombineMask`, no
jagged diagonal.

### When transparency is not available

See [Capability queries](../docs/styling.md#capability-queries). The block is
answered per window and re-resolved live, so a compositor being switched on
mid-session turns the popup rounded without a remount — which is why
`transparent` still takes the 32-bit visual when nothing is compositing yet.
A visual is a `CreateWindow` field and cannot be changed afterwards; what
the window paints can.

To **look at the fallback** on a display that composites perfectly well,
run with `REACT_X11_NO_TRANSPARENCY=1`: `transparent` is ignored, the window
is created on the ordinary visual, and both the style block and
`useSupports` answer false. Otherwise the only way to see the design you
wrote for XQuartz is to stop the compositor, which takes the rest of your
desktop with it. See [debugging.md](../docs/debugging.md).

Toggling the `transparent` prop itself on a mounted window does nothing
until it remounts (change its `key`) — again because the visual is fixed at
creation. Requires **ntk ≥ 6.6.0**.

## `<popup>`

### `anchor` — a popup that places itself

**Why the popup and not the application.** A `<popup>` with no `width` is
sized from its content like any other window, and that size is settled
_inside_ `realize()` — after the content is measured, before `CreateWindow`.
Which side the popup flips to and how far it is pulled back from a screen
edge are both functions of that size, so the earliest anyone can work out the
position is the moment after the measurement — which is already too late for
React to have passed one in. Doing it here keeps the rule the natural size
established: the window is **born** the right size in the right place, rather
than mapped somewhere provisional and corrected a frame later.

**When the anchor scrolls out of view the popup unmaps** and comes back,
where it belongs — and holding its `grab` again, since X drops a pointer
grab whose window stops being viewable — when the anchor does. A popup is a real X window rather
than an element its ancestors clip, so a caret that has scrolled out of the
editor leaves a list floating over a document it no longer points into —
and there is no position that fixes that. Whether it should _close_ instead
is React state and therefore the application's: do the placement yourself
with [`useAnchorTracking`](../docs/components.md#useanchorref--anchorrectnode-options)
and its `onOutOfView`.

**`grab` is what makes a menu dismissable.** Without it, a press that lands
anywhere else — another application, the root window, or even this app's own
**window frame**, which belongs to the window manager — never reaches the
client, so the menu stays open behind whatever was clicked. With the grab,
that press is redirected to the popup instead, arrives outside its bounds,
and `onDismiss` fires. The client's own windows still receive their own
presses (X owner-events), so submenus and the owner window keep working
normally, and only the root popup of a menu needs the grab. Needs
ntk ≥ 3.7.0; on older ntk the popup behaves as it did before.

### Centred over something

A centred popup is centred **once**. When its own size changes afterwards —
its content growing a line — it keeps its top edge and its horizontal middle
and grows from there, pulled back only as far as it takes to stay on the
monitor: re-centring would move the top edge by half the growth, and with it
whatever the user was reading or about to press. A managed one grows from
wherever the window manager or the user has put it since, and is moved only
to keep it on the monitor. A new `rect` (or the `to` node moving) centres it
again.

**The monitor comes from the whole rect**, not from a corner of it. A
menu-bar item's frame starts a few points _above_ the top of the display it
is on, so its top-left corner is outside that display — and on a desk where
a taller neighbour reaches down past that edge, inside a different one. The
monitor the rect overlaps most is the one it is on; a rect that overlaps
none takes the nearest.

### A managed `<popup>` is a dialog

Defaults to `windowType="popup_menu"` — the least-wrong answer for a popup
that declares nothing; pass `windowType` to say what yours is
(`"tooltip"`, `"dropdown_menu"`, …). The built-in widgets do:
`Select`'s sheet is `dropdown_menu`, `Tooltip` is
`tooltip`. The hint is **additive** — override-
redirect is what keeps the WM from moving or decorating the popup, and
stays on. The EWMH spec asks for the type hint on override-redirect
windows too, so compositing managers can give menus and tooltips
consistent shadows and animations.

## Scrolling: `overflow: 'scroll'` {#scrolling}

The bar belongs to the scroller, not to the content painted under it — the
same rule a browser applies — so a press on the thumb never reaches the row
behind it. Dragging keeps the grip where it was taken, so the thumb does not
jump to the pointer, and a press on the track pages towards it, like
PageUp/PageDown. A drag moves the pane by whole device pixels, as a wheel
does ([extending.md](../docs/extending.md#scrolling-content-you-painted)), so the
scroll stays a blit and nothing in the pane is drawn off the pixel grid.
`<textarea>` behaves the same way, and there a bar press never moves the
caret.

### The layout defaults it brings

`min-*: 0` is the CSS spec's own rule — `min-*: auto` computes to `0` on a
flex item whose overflow is not `visible` — and it is what lets a viewport be
smaller than what is inside it, which is what scrolling is. The zero basis is
half of what `flex: 1` means. Without them a header/scroll/footer window
grows past its own bounds as rows are added and the footer is pushed out of
view. Set either yourself to opt out; an explicit value always wins.

### Props

`scrollIntoView(node)` scrolls the minimum amount that makes a descendant
node fully visible — for one larger than the viewport, CSSOM View's
`block: nearest`: left where it covers the viewport, and otherwise brought
in by the edge that moves it least — and is safe to call from an effect right after that
node mounts: the request is resolved on the next layout pass, when the
node actually has geometry. Asking repaints nothing by itself. A request
that finds the node in view already leaves the pane as it was, so focus
moving between the fields of a form in a pane costs what it costs outside
one: the two focus rings. One that does move the pane is a scroll like any
other: where the backend can copy pixels, what stays on screen is copied
and only the strip the move uncovers is repainted.

## `<text>`

### Variable fonts

_ntk ≥ 7.1.0._

ntk instantiates on demand and rasterizes only the glyphs actually drawn,
at the size drawn; both its caches are bounded. What it does not do is
quantize for you, so a slider bound straight to an axis with `step={1}`
really will ask for hundreds of distinct faces as it is dragged — step the
control, not the font. See ntk's `docs/fonts.md` for the whole picture,
including why a variable `.woff2` cannot be instantiated and you want the
`.ttf`.

### `textRendering`

_ntk ≥ 7.2.0._ CSS's property, picking which glyph path draws the text.

**Why display text wants it.** On the cached path a glyph's advance is baked
into the server-side glyphset as a whole number, because a cached bitmap can
only land on a whole pixel. Animate a variable font's `wght` and the true
advances move by hundredths of a pixel — hundredths that accumulate along
the line until one glyph crosses a rounding boundary and jumps a whole pixel
on its own while its neighbours stand still. `geometricPrecision` puts every
glyph where shaping asked, so the line slides instead of stepping.

**It never reflows.** Only draw-time rounding differs; ntk's layout measures
byte-identically for every value, down to per-run offsets. Changing it drops
the cached layout — the value rides on the spans inside it — and repaints,
without marking anything dirty for yoga. So it is safe to flip on a state
change without the tree moving.

### Letter spacing and figures

_ntk ≥ 8.9.0 on X11, `@windowkit/appkit` ≥ 0.11.0 on Cocoa._

Spaced text drops the optional ligatures — `liga`, `clig`, `dlig` and
`hlig` — because a ligature is one glyph, with no gap in its middle to open.
Name one in `fontFeatureSettings` to keep it anyway.

### Tiny text

Text smaller than **6 logical pixels** is painted as a strip of its ink over
the band its letters sit in, one rectangle per line, instead of as glyphs. A
zoomed-out view — a minimap, a graph at a tenth of its size, a grid of five
thousand cells — is a screen of labels nobody can read, each of which would
cost a glyph run at the price of a legible one; below a legible size a label
is a smudge of its ink, and the strip is that smudge for one fill. Layout is
untouched: the text is still shaped, the strip is as wide as the line. The
size is logical because legibility is physical — a 5px label is the same
size on a 2x panel as on a 1x monitor.

## Selecting text

_Issue #259._ A label is not selectable, the way `Gtk.Label` is not: a
desktop application is full of text that is chrome rather than content, and
a stray drag lighting up a button's caption is noise. Text becomes
selectable when an element says so.

### What is in a surface

What is **not** in it:

- anything under a `selectable={false}`, which is CSS's `user-select: none`.
  A list's bullets, a table's chrome, a button's caption inside a document;
- `<textinput>` and `<textarea>`, and any element that says
  `hasOwnSelection` — they keep their own selection, and a press in one is
  theirs;
- `<svg>`, and any registered element that draws its own text, which draw
  their text through an ntk widget that exposes no character geometry to us.

### What a copy assembles

The separators come from the **layout**, not from the markup: core cannot
know that one `<text>` is a table cell and another is a paragraph, and
asking every application to say so would be a second authoring model for
something the screen already shows. Two pieces of text sharing a band of
pixels are joined with a **tab**; one that starts below the last is joined
with a **newline**. For a table laid out as rows of cells that is exactly
"cells with tabs, rows with newlines", and for ordinary prose it is one
paragraph per line.

### One selection, and where the keys go

**Only one selection is visible in an application at a time.** Selecting in
a document collapses the highlight in the field beside it, and selecting in
a field clears the document — the two never both claim to be showing the
selection, which is a rule core holds rather than one every surface has to
keep. That is also what makes PRIMARY honest: there is one selection on the
display, so there is one here.

### The geometry underneath

Indices are **code points**, not UTF-16 units, so an emoji is one position.
Rectangles are in the owning window's coordinates — the same space as
`abs` and `contentBox()`, which is device pixels; a mouse event's `x`/`y`
are logical ([scale.md](../docs/scale.md)). `textRangeRects` returns
one band per line _and_ one per direction run inside a line: a range that
crosses from Latin into Arabic covers two separate stretches of pixels, and
a single rectangle drawn between two caret positions would paint over text
nobody selected.

## `<textinput>`

Single-line editable text. Caret and selection geometry come from ntk's
`TextLayout.caretPosition`/`indexAt` (ntk ≥ 3.3.0), so positions are exact
across kerning, shaping boundaries and trailing whitespace.

The text style props include `textAlign`, and the field is laid out at its
box's **direction** the way a `<text>` is: the value, the placeholder and the
caret sit at the base direction's start edge — the right-hand one under
`direction: 'rtl'` — and the value is shaped at that base level rather than
at its own first strong character, which is what makes `"(1) 12:30 — نص"`
punctuate the same way in a field and in the paragraph beside it. Clicking,
the caret, the selection bands and the horizontal scroll are read from one
placement, so they mirror together. See
[styling.md](../docs/styling.md#inside-an-editable-field).

### The change event

Two details worth knowing:

- **`ev.target.value` is the new value even in controlled mode**, where
  `props.value` is still the old string until the parent re-renders. That is
  what makes `e.target.value` mean here what it means in the DOM, and it is
  why react-hook-form and formik work — see
  [docs/ecosystem/forms.md](../docs/ecosystem/forms.md). It is true _while the
  handler runs_: `ev.target` is the live node, so a handler that stashes the
  event and reads `ev.target.value` later sees whatever the control holds
  then. `ev.value` is a snapshot and always safe.
- **`ev.nativeEvent` can be null.** A keystroke carries the X key event that
  produced it, but an edit can also come from a paste resolving, an undo, or
  a value the parent pushed back — none of which has an X event behind it.
  Guard it. (Not academic: downshift reads
  `event.nativeEvent.preventDownshiftDefault` unguarded, so a null there is a
  TypeError rather than a no-op.)

### The right-click menu

**Paste** is greyed when nothing owns the CLIPBOARD selection. The field
subscribes to selection changes the first time its menu opens rather than
asking on the way in — asking would mean a round trip against whatever
foreign client owns the clipboard, and a wait if that client is wedged, at
exactly the moment a menu should already be on screen. So the very first
menu of a session still shows Paste enabled; every one after it knows. On
a server without XFixes it stays enabled, which is where it started. On
macOS it follows the pasteboard's change count, a quarter second behind a
copy made in another app ([clipboard.md](../docs/clipboard.md#knowing-when-it-changes)).

The menu is not the field's private property: `openEditMenu(node, at,
actions)` opens this one for anything that edits or selects text — a code
editor, a rendered document with a selection — and `<textinput>`'s own menu
is a caller of it, which is what keeps the two the same menu. See
[extending.md](../docs/extending.md#the-standard-edit-menu).

### `sensitive`

The line it draws is between what is on screen and what is on the clipboard.
The first stops being visible when the field is hidden or the window closes;
the second is readable by every client on the display until something else
takes the selection, and a clipboard manager will have written it down.
`PasswordInput` sets it on the input it shows while the secret is revealed —
see [components.md](../docs/components.md#passwordinput). An input method is on the
same side of the line: on Wayland a `sensitive` field is declared
`sensitive_data` and none of its text is offered as surrounding text
([events.md](../docs/events.md#input-methods)).

### Undo

A composed character is one entry, not one per keystroke: the accent a dead
key is holding is not in the value until it commits, so Ctrl+Z after
`dead_acute` `e` steps over `é` rather than into it.

Undo is a stack of snapshots of the states the control has shown, capped
at 200. A **controlled** `value` reports the restored text through
`onChange` and waits for the prop to come back, exactly as typing does —
so a parent that filters or rejects a value gets the same say over an undo
that it has over an edit. A value changed from outside (a form reset)
becomes its own entry, and undoing steps back through it.

## `<image>`

### `src` — pixels the client has

A file path (or `new URL('./logo.png', import.meta.url)`) is read and
decoded asynchronously; the element measures 0×0 until the decode lands,
then reflows. Style it a `width` and `height` and nothing moves when it
does. The in-memory forms skip the filesystem — pixels that arrived from a
socket, a decoder, or a `getImageData` readback go straight on screen — and
raw RGBA and an ntk `Image` are synchronous. Encoded bytes are synchronous
where the decoder is (PNG and JPEG under Node) and land a moment later, the
way a file does, where it is not: any format under Bun, and WebP elsewhere.
Raw `data` is `width × height × 4` bytes of straight (non-premultiplied)
RGBA — exactly what `getImageData` hands back — and the object is treated as
immutable content: hand over a new object when the pixels change, or the
renderer cannot tell. That goes for encoded bytes too, which under Bun are
read on another thread after the commit.

#### Formats, and what decodes them

**Under Bun, Bun decodes everything**, PNG and JPEG included, which the
JavaScript decoders could read: libjpeg-turbo, spng and libwebp are built
into the runtime and run on a worker thread. A 1080p JPEG takes ~110ms of the
JavaScript thread inside jpeg-js and ~7ms under Bun, which is the difference
between a stall the user feels and none. What it costs is that bytes under
Bun land a frame or so late, like a file. Where that matters — a test that
measures the element on its first frame — decode the bytes yourself and pass
the result, which is used as-is on every runtime:

```jsx
import { decodeImage } from 'ntk/image'; // PNG and JPEG, synchronous

const logo = <image src={decodeImage(bytes)} />;
```

The WebP decoder under Node is pure JavaScript, imported the first time a
WebP arrives so an app that shows none never loads it: the first WebP pays
~140ms to load the decoder, and each one about what jpeg-js costs a JPEG of
the same size.

What differs between the two, so it is not found the hard way:

- **An animation shows its first frame** — an animated WebP on either
  runtime, a GIF under Bun. Bun's libwebp cannot decode an animated WebP at
  all (Bun 1.4), so under Bun that one goes to the JavaScript decoder too.
- **A JPEG's EXIF orientation is applied under Bun and not under Node.**
  Browsers apply it, and so does Bun; jpeg-js does not, so under Node a
  phone photo taken in portrait shows on its side. Rotate it before
  handing it over, or run under Bun.
- **A format with no decoder says so**: GIF under Node, or HEIC under Bun on
  Linux, is logged with what to convert it to, and the element shows
  nothing, the same as a missing file.

Decoded pixels are uploaded to the server once and composited from there on
every repaint (ntk's `Image` caches its upload per connection), so the cost
of an image is one `PutImage` at first paint, not one per frame.

On the Cocoa backend (macOS's default) the upload is a CoreGraphics bitmap
rather than a pixmap — made once per `Image` at its first paint and
composited, scaled, from there — so the cost is the same one upload. The
element frees it with an `Image` it decoded; for an `Image` of yours it is
freed when the `Image` is garbage-collected, since ntk's `destroy()` frees
only its X copies.

### `src={{ symbol }}` — the platform's own icons

On Linux a `-symbolic` icon is preferred where the theme has one, and it is
the one that takes the text colour — the monochrome set GTK tints the same
way. An icon the theme only has in its own colours is shown as it is. The
lookup is the Icon Theme Specification's, read when the first symbol is
drawn.

### `picture` / `drawable` — pixels the server already has

When the content is already a server-side Picture or Drawable — a pixmap the
app rendered offscreen, `NameWindowPixmap` from Composite, a cached tile —
showing it must not mean reading it back and uploading it again. These
composite straight from the existing resource: one `RenderComposite` into
the window, no `PutImage`, no round trip.

The caller states the size because asking the server for it would be a round
trip, which these props exist to avoid. The descriptor is compared by value,
so an object literal rebuilt every render costs nothing. Scaling (a box
styled to a different size than the source) is server-side, through the
picture transform with bilinear filtering — note that drawing a `picture`
scaled sets that picture's transform and filter for the composite and resets
them to identity/nearest after, the same bracket ntk puts around its own
uploads; a picture that must keep a transform of its own should be
composited 1:1.

`drawable` wraps the pixmap or window in a Picture the element creates and
owns (freed on unmount; the drawable stays yours). `depth` picks the format
it is composited through: 24 — the screen's default depth, what a window
pixmap from Composite is — is the default, 32 is argb, and 8 composites as
ink through its alpha, which is what previewing a mask looks like. A
`picture` needs no depth: its format was fixed when it was created.

Both name X server resources, so both are X11-only: the Cocoa backend has no
X server to composite from, and there they draw nothing (development warns
once). Hand `src` the pixels instead.

## `<video>` {#video}

| prop                                                  |                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `frames`                                              | a `VideoFrames` sink the application pushes decoded frames into (`useVideoFrames`, `createVideoFrames`) — works on every backend                 |
| `src`                                                 | a path or URL the platform plays itself, where `useSupports('mediaPlayback')` is true; elsewhere one `NoMediaPlaybackError` through `onError`    |
| `poster`                                              | an `<image src>` value, shown until there is a frame and whenever there is none                                                                  |
| `autoPlay`, `loop`, `muted`, `volume`, `playbackRate` | HTML's names and defaults — nothing plays until asked; for `src`                                                                                 |
| `paused`                                              | controlled when present; for `src`                                                                                                               |
| `onLoadedMetadata`                                    | `{ width, height, duration }` once the stream's size is known — for a sink, once it is mounted, with a `duration` of `Infinity`, a live source's |
| `onPlay`, `onPause`, `onEnded`, `onTimeUpdate`        | for `src`; the `ref` has `play()`, `pause()`, `seek(seconds)`, `currentTime`, `duration` and `paused`                                            |
| `onError`                                             | the source failed, or there is no player for `src`; without a handler, one console warning                                                       |

### `VideoFrames`, the sink

- **Formats.** `'NV12'` (Y, then Cb/Cr pairs — what a hardware decoder
  emits), `'I420'` (Y, Cb, Cr — `yuv420p`, most software decoders' default)
  and `'BGRA'` (the fourth byte ignored: a frame is opaque). `colorSpace`
  (`'bt709'` by default, `'bt601'`, `'bt2020'`) and `range` (`'video'` by
  default, `'full'`) say what a YCbCr frame's numbers mean.
- **`preferredFormats`** is this display's order, cheapest first, for a
  decoder that can choose: `NV12, I420, BGRA` on macOS, where a YCbCr frame
  goes on a layer as it is, and `BGRA` wherever a 2D context draws it. Every
  format works everywhere; the conversion is charged where it happens.
- **The newest frame is the frame.** A push replaces the last one, shown or
  not; nothing queues, and the decoder's own clock is the pacing. A push
  hands its planes over until the next push — they are read then, not
  copied at the call — so a decoder that writes every frame into one buffer
  pushes it again after writing.
- **`push(planes, { strides, time })`** takes a Buffer per plane or one
  Buffer of them back to back, with each plane's bytes per row when a
  decoder pads them; a plane too small for the frame is a `TypeError` naming
  the plane and the bytes it needs. `close()` drops the frame and ignores
  what comes after, so a decoder racing an unmount loses quietly.
- **Nothing to free.** A sink owns nothing native: what shows it makes its
  surfaces and lets them go when it stops showing it.

### Lifted, drawn, and what each costs

On **macOS** a video with a frame to show goes on a layer of its own above
the window's bitmap, under the same rule that lifts an animation
([macos.md](../docs/macos.md)): nothing painted over it, no fade, no rounded
clipping ancestor that cannot hold it. There every `push` writes the frame
into a surface the render server shows as it is and repoints the layer —
0.07ms for a 1080p NV12 frame, 0.27ms for an I420 one interleaved on the
way — with **no frame of the window's own**. The rest of the time — a
tooltip over it, a dialog's dim, a card with rounded corners — it is
**drawn**: a push claims the picture, and the next frame copies the newest
frame into a surface of the element's own and composites it in paint
order. The bridge converts a YCbCr frame into that surface in the colours
the layer shows it in, so the picture does not change shade on the way
between the two.

On **X11, Wayland and Windows** it is always drawn, the frame converted to
RGBA in JavaScript unless it is BGRA — which is why those displays prefer
BGRA. On X11 the upload rides ntk's shared-memory path where the server has
it. No transfer function is applied there, as nothing else on those
displays is colour-managed either.

`borderRadius` on an ancestor that clips the video costs the layer, not the
picture: the video is drawn for as long as the rounded clip holds it.

### `src` — the platform's player

Where `useSupports('mediaPlayback')` is true, `src` is a file or URL the
platform plays with its own decoder, audio, seeking and streaming — on macOS
AVFoundation, over a bridge with its player verbs (`createPlayer`), and in
a `<Frame>` pane, whose host plays it and sends the frames down
([frame.md](../docs/frame.md#sizing-stacking-input)). A path, a `file://` URL and an
`http(s)` one, HLS included, all play.

It is laid out at 300x150 — or the poster's size — until the item is ready,
and at the clip's size from `onLoadedMetadata` on. `paused` is controlled
when present; `autoPlay`, `loop`, `muted`, `volume` and `playbackRate` are
HTML's, and a change to any of them goes to the same player. The `ref` is
HTMLMediaElement's imperative half: `play()` (from the start if the item has
ended), `pause()`, `seek(seconds)` — exact, not to the nearest keyframe —
and `currentTime`, `duration` and `paused`. `onPlay` and `onPause` fire when
it starts and stops, `onTimeUpdate` four times a second while it plays and
after a seek, `onEnded` at the end of an item that does not loop, and
`onError` when the item fails.

Lifted, the picture is the player's own layer and costs the window nothing
while it plays; painted over, the frame showing is copied into the element's
surface at the clip's own frame rate for as long as it plays, in the same
colours. There is no `controls` attribute: the transport is your React,
over or beside the video.

## `<canvas>`

`ctx` is ntk's canvas-like 2d context (paths, transforms, gradients incl.
conical, `setLineDash`, round caps/joins, images, text — XRender-backed),
translated to the node's origin and clipped to its bounds. `onDraw` runs on
every repaint of the window.

A drawing made of many small rectangles in one colour — a sparkline, a heat
map, row striping, terminal cells — has a batch primitive, and the
difference is a whole frame's worth of requests:

```jsx
ctx.fillStyle = theme.accent;
ctx.fillRects(bars); // [[x, y, w, h], …] or one flat [x, y, w, h, x, …]
```

`fillRects` is `fillRect` per rectangle — the same fill style, alpha,
composite op and clip — sent as a single `Render.FillRectangles` where the
loop would have sent one composite each.

### `cacheKey` — draw it once

Opt-in, and the reason matters: `onDraw` is an opaque closure. Nothing in the
renderer can know what it reads — a prop, a ref, a clock — and its identity
changes on every render unless you memoize it, so it is not a key either. Only
you know, so you say.

**The key must name every input the drawing reads.** One that leaves something
out shows stale pixels, which is the hardest kind of bug to see. Develop with
`REACT_X11_PAINT_CACHE=verify`, which turns exactly that mistake into a loud
complaint — see [Runtime diagnostics](../docs/debugging.md#the-paint-cache--react_x11_no_paint_cache-react_x11_paint_cacheverify).
Leave `cacheKey` unset for anything animated, or driven by state outside the
props.

`<svg>` does this automatically: its content is fully described by
its props, so the renderer can build the key itself.

### `mono` — one colour, and the colour out of the key

The promise is what lets one drawing serve every state a control puts it in:
`:hover`, `:disabled` and a theme flip all reach the same `onDraw`, and none of
them is the drawing's business.

**What it buys at the cache.** With a `cacheKey`, a `mono` drawing is kept as
**coverage** rather than as pixels, with the colour applied at composite time —
so the colour leaves the key and one rendered copy serves every ink. That is
the trick the glyph cache runs on text, and the one `<svg>` gets for a
`fill="currentColor"` document; a closure cannot be scanned the way a document
can, so here you say it. Without `mono`, each colour of the same shape is a
separate rasterization and a separate pixmap.

Needs **ntk ≥ 7.3.3**, which `package.json` carries: earlier versions
composite coverage as empty under a clip they cannot express as a rectangle
([sidorares/ntk#243](https://github.com/sidorares/ntk/issues/243)), and a
widget sits inside clips like that routinely.

## `<glarea>`

An OpenGL surface in the layout — on X11 the only drawn element that owns a
real X window, because GLX needs a drawable created for a GL-capable visual
and cannot share the XRender pipeline the rest of the tree paints through
(NEXT_STEPS §4); the other backends give it a surface of their own
([gl.md](../docs/gl.md)). On X11 under the default `glPolicy` it needs ntk ≥ 3.6.0
and a server with **indirect GLX** enabled (`+iglx` / `AllowIndirectGLX` —
off by default on many).

The surface is stacked above everything drawn in its window, so nothing the
window paints can overlap it. **Its own children can: they are 2D content
drawn above the surface.** Layout treats a `<glarea>` as a flex container
like a `<box>` — it is sized and positioned like any node, its window follows
that rect, and its children are laid out inside it and cut to its box: a
legend in a corner, a toolbar along an edge, a label over the scene. They are
ordinary nodes in every way but one. The window's own paint cannot reach
above the surface, so they are painted on **panes** stacked over it, in the
same frame and from the same damage as everything else.

What a pane is depends on the backend, and so does what translucent means:

|                      | Cocoa                                                                                                   | X11                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a pane               | one transparent layer over the whole surface, above the GL layer                                        | one child window per child, as big as its paint reach, stacked directly above the surface's window in the children's order; where two overlap, the upper pane holds the lower child's pixels too                                                            |
| translucency         | composited by Core Animation: a translucent fill, an antialiased edge or a shadow blends with the frame | partly: a pane is cut with SHAPE to where its child painted half its alpha or more, and the frame shows everywhere else; a pixel inside the cut that is translucent — an antialiased edge, a translucent fill — blends with the `clearColor`, not the frame |
| between the children | the GL frame                                                                                            | the GL frame                                                                                                                                                                                                                                                |

So on X11 expect a translucent fill to be tinted by the `clearColor`
rather than to show the scene: the frame shows around a child, not through
it. X11 cannot do better without a compositor, and a compositor would not
help: it blends top-level windows, not the children inside one. The cut
needs the SHAPE extension, which every real X server has; without it — the
in-process server in `react-x11/test` — a pane is the rectangle of its
child's reach, and whatever the child leaves unpainted there shows the
`clearColor`. A window per child keeps each pane as small as what it
holds.

A pane is its child's, and holds that child and what is under it, never
what is over it. So a child that moves — a card dragged across a graph —
takes its pane along and repaints nothing when nothing is under it, and the
panes it passes over are not touched at all. A pane's window takes its new
place and the pixels that go there in one batch of requests, and the
server keeps what each pane and the surface show while they are mapped
(backing store), so what a moving pane uncovers is back at once rather than
after an Expose and a repaint.

**XQuartz draws nothing over a GL surface.** There every surface, direct
(Apple-DRI) or indirect, is composited by the macOS window server above
everything the X server draws in the window. A pane stacked over the
surface in X is drawn under it on screen, and nothing on the X side changes
that: cutting the surface's window down with SHAPE still leaves the frame
covering all of it. A pane over the _whole_ surface does show, but only
because the frame then disappears. So on XQuartz the children are laid out
and not drawn, the pointer over them is the surface's,
`useSupports('glOverlay')` is false, and a development build says so once.
Ask the hook and draw the overlay another way there, beside the surface or
in GL, or run on the Cocoa backend (the default on macOS), which composites
it.

**A child that only moves is not repainted.** A pane keeps what it drew
between frames, so when all that changed about one of the surface's children
is where it sits — its `left` or `top`, and nothing inside it — the frame
moves that child's pixels on the pane and repaints only what the copy cannot
supply: the strips the move uncovered, and the other children's pixels it
passed over or under. A layer of mounted content panned across a scene,
such as a graph's node bodies over its GL edges, then costs a copy and a few
strips a frame rather than a repaint of everything on show. A scroll pane
among the children scrolls the same way, moving the pane's pixels. A child
that also changed size, or drew anything differently in the same commit, is
repainted as before, and
[`REACT_X11_NO_SCROLL_BLIT=1`](../docs/debugging.md#react_x11_no_scroll_blit1) turns
every such copy off.

How it gets there differs underneath and nowhere above. On X11 the surface
is a child window that **selects no input of its own**, so the server
reports what happens over it to the window the tree lives in — in that
window's coordinates, under that window's grab, and with its XI2 selection,
so the wheel over a surface is the same wheel as anywhere else in the
window. On the Cocoa backend the surface is a layer and the events were the
window's all along.

One rule follows for an element built on `<glarea>`: **do not listen for
the pointer on `node.window`**. ntk selects whatever its window is listened
to for, and X then delivers the event there instead of to the tree — every
press, and the wheel with them, since both are ButtonPress. Listening there
was the only way to hear a press over a surface before core delivered it;
`node.forwardsPointer` is `true` where it does
(`GlAreaNode.prototype.forwardsPointer` from `react-x11/node`, to ask
without rendering), and is the switch for dropping such a listener.

## `<foreign>`

**X11 only.** Cross-process window embedding does not exist on macOS —
there is no equivalent of handing another application's window to your
layout, and none is planned. Where there is none — the Cocoa, Wayland and
Windows backends, and the headless mock tests render on — this element
refuses: it lays out as an empty box and draws nothing, never calls
`onReady`, and calls `onError` once to say why. Ask before rendering one:

```jsx
const embedding = useSupports('embedding');
```

Another process's top-level X window, laid out as an element — a terminal
pane, a video surface, a docked tray icon. The second element that owns a
real X window without painting into its parent, and the only one that makes
a react-x11 app a _host_ rather than a drawer of its own pixels. Needs ntk
≥ 7.4.0.

- `windowId` — the window to embed. Changing it hands the old client back
  before the new one is taken. **Omit it** to adopt whatever is put inside
  this node instead, which is what `xterm -into WID` and `mpv --wid=WID`
  need.
- `onReady({ windowId })` — this node's own container id, offered before
  anything is embedded, so a program can be spawned into it. Never called
  where there is no embedding, so the id is always a real window's.
- `onEmbedded({ id, xembed, version })` — a client is in. `xembed: false`
  is a client that set no `_XEMBED_INFO` and got plain reparenting, which
  is the common case rather than the fallback.
- `onClientGone()` — destroyed, or reparented away by someone else.
- `onRequestFocus()` — the client asked for the focus. It is then given
  through the focus manager, so the rest of the tree observes it normally.
- `onError(err)` — the embed failed, or — once, at mount — this backend has
  no embedding at all. Without a handler, a console warning; for the second
  kind, one per app however many `<foreign>`s ask.
- `focusable` — default `true`, like `<textinput>`.
- `backgroundColor` in the `style` is what shows in the rect with no client
  in it: the container window's background, painted by the server.

**Unmount reparents the client back to the root and drops it from the save
set. It never destroys it** — a React tree changing shape is not a reason
for another application to lose its window.

Layout treats it as a leaf, and its X window follows that rect; every change
also sends the client the synthetic ICCCM 4.1.5 `ConfigureNotify` with
root-relative coordinates. Stacking is `<glarea>`'s: the child window sits
above everything drawn in the parent, so 2D content cannot overlap it — and
unlike a `<glarea>`, `<foreign>` takes no children to draw over it, so an
overlay belongs in a sibling `<popup>` — and pointer events over it are the
client's.

## 3D scene: `<mesh>`, `<group>`, geometries, materials

Moved to [`@react-x11/components/three`](../docs/ecosystem.md), which is a scene
graph with its own reconciler over the `<glarea>` above — and, unlike the
version that lived here, one that renders on **both** GL backends from the
same JSX. Core keeps the surface and `onDraw`; see [gl.md](../docs/gl.md).

## Vector drawings

Documents used to live here too — `<markdown>`, `<html>` and `<tex>`, thin
wrappers over ntk's document widgets. They were removed in react-x11 2.0:
each rendered a whole document as one opaque drawing, which foreclosed the
two things a document most needs — text selection across blocks, and
re-rendering only the block that changed while content streams in. Their
successors are components in
[`@react-x11/components`](https://github.com/sidorares/react-x11-components),
composed from public host elements rather than wrapping a widget:
`<Markdown>` (GFM, selectable, streaming-friendly) and `<Formula>` (KaTeX,
selectable), with `<RichText>` and `<CodeBlock>` underneath them.
