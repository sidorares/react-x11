# Runtime diagnostics

Three switches answer the three questions a slow or misbehaving frame
raises: _what went on the wire_ (`REACT_X11_TRACE`), _what got repainted_
(`REACT_X11_DEBUG_PAINT`), and _why_ (invalidation reasons, printed by
both). They complement [devtools.md](devtools.md) (component tree) and
`REACT_X11_DEBUG_LAYOUT=1` (outline every drawn node, colour by depth).

The failure mode they exist for is the silent full-window repaint: correct
pixels, quietly costing the whole window every frame. X11 is a network
protocol even on a local socket, and damage rects are invisible at runtime
without these.

Everything here costs nothing when off. The environment switches are read
**once at startup** unless a section says otherwise, and the `NO_…` and
`STRICT_…` switches answer only to `1` — any other value leaves the default
in place. The tracer module is not imported unless `REACT_X11_TRACE` is set
or you import `react-x11/debug` yourself, and stacks are captured only under
`REACT_X11_DEBUG_PAINT=full` or `+stacks`.

## Protocol tracing — `REACT_X11_TRACE`

```sh
REACT_X11_TRACE=summary npm run examples:dashboard
# at exit:
# react-x11 trace: 4211 requests (312.4KB out), 89 replies, 41 events, 0 errors (48.1KB in)
#     1780  Render.CompositeGlyphs32
#      512  Render.Composite
#      ...
```

- `summary` — request/byte totals and an opcode histogram, printed to
  stderr when the process exits.
- `requests` — one stderr line per request as it is sent
  (`x11 → Render.FillRectangles 36B`), plus one line per painted frame
  (`frame 412: 320x24@8,40 reasons=style-state landed=16.4ms`). X errors are
  decoded and name the failing request. `landed` is how long the previous
  frame took to be answered. A window presents by default, so this is
  time-to-display and reads about **one refresh period** — 16ms on a 60Hz
  screen is the system working. On `frameClock: 'fence'` it is a server
  round trip instead, and a paint that builds in 0.3ms against 20ms there
  _is_ a server-side problem (software-fallback RENDER ops, a virtualized
  GPU) rather than a renderer one. A frame the frame pacer held
  ([elements.md](elements.md#framerate--pacing-the-frames-under-a-flood))
  carries `waited=18.0ms` — how long the claim waited before the clock got
  it.
- `chrome:/tmp/trace.json` — [Chrome Trace Event
  JSON](https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU),
  written at exit. Open it in Perfetto or `about:tracing`: React commits
  and painted frames are slices, requests and errors are instant events —
  so "this interaction sent 4000 requests" becomes "3600 of them were
  `CompositeGlyphs32` inside one commit".

Append `+stacks` to `requests` or `chrome` to capture a JS stack per
request. An X error arrives long after the call that caused it returned,
and the captured stack is the only thing that maps it back to your code. It
costs an `Error` capture per request, so it is opt-in.

The tracer attaches to a connection _after_ its handshake, so the
connection-setup packet — the one carrying the X auth cookie — is never
seen, and payload bytes are never recorded: only opcode, length and
direction.

### `startTrace()` — the same thing as an API

```js
import { startTrace } from 'react-x11/debug';

const trace = startTrace(); // sink: 'summary' | 'requests' | 'chrome'
await interaction();
const { requests, bytesOut, replies, byOpcode } = trace.stop();
```

With no `app` the trace follows every connection the renderer has open or
opens later; pass `startTrace({ app })` to trace one specific connection.
`byOpcode` maps decoded request names — `'CopyArea'`,
`'Render.CompositeGlyphs32'` — to counts.

## Repaint flashing — `REACT_X11_DEBUG_PAINT`

```sh
REACT_X11_DEBUG_PAINT=1 npm run examples:dashboard
```

Every painted frame strokes its damage rects in a colour that rotates per
frame. A region repainting every frame strobes; one that painted once
leaves a single quiet outline. This is the browser's "paint flashing" for
this renderer.

```sh
REACT_X11_DEBUG_PAINT=full npm run examples:dashboard
```

Additionally warns — with the invalidation's reasons and the stack of the
`invalidate()` call that made the frame unbounded — whenever a frame
degrades to a full-window repaint:

```
react-x11: full-window repaint (800x600) reasons=props
Error: invalidated here
    at WindowNode.invalidate (src/nodes/invalidate.js:…)
    at ...
```

Full repaints are the main performance bug to look for. Expected ones exist
too — a resize, the first frame after a mount, the backing store being
invalidated — and their reasons say so.

A bounded frame can still be doing the work of an unbounded one: an element
that draws a whole **scene** into one node — a graph view, a chart, an
editor — is one node to the damage machinery, so a tight outline around
what moved can sit over a pane that redrew all of itself inside it. Such an
element reads the pass's rect and claims its own commits
([extending.md](extending.md#drawing-a-scene-into-one-node)).

## `REACT_X11_NO_SCOPED_FLOORS=1`

Measures the content floors over the whole tree on every layout change,
instead of measuring a change inside an absolutely positioned box with its
own width and height in that box alone, or a change down a column whose
height is its content's (a document, a log, a feed in a scroll pane) alone
with the column summed. For comparing the two on the same build, and as
first aid if a box ever comes out the wrong size after its content changes.

## `REACT_X11_NO_UNREAD_WIDTHS=1`

Measures every box's min-content width in the width passes — over the whole
tree, and over a box measured alone — instead of only the widths a floor is
written from. By default a leaf whose width nothing reads (a paragraph down
a column in a document) is not set a word to a line to find one, which
matters for a large first frame. For comparing the two, and as first aid if
something in a row ever comes out narrower than its content after the first
frame.

## `REACT_X11_NO_REFIT_HOLD=1`

By default, the frame on which an `'auto'`-sized window's content asks for a
new size waits for the server's answer ([elements.md](elements.md#natural-size)).
This switch lays it out at the size it has on that frame instead, so on X11
that frame shows the new content at the old size — a label that grew wraps,
and is cut off — for the round trip before the resize lands. For comparing
the two, and as first aid if an `'auto'` window ever stops repainting after
its content changes.

## `REACT_X11_NO_SCROLL_BLIT=1`

Disables the scroll-blit fast path (a pure scroll copies the surviving band
and repaints only the exposed strip), so a scroll frame repaints its whole
viewport again. For measuring the blit against the plain path on the same
build, and as first aid if a scroll ever misrenders.

It also covers the other paths that move retained pixels instead of
repainting them:

- [`scrollContents`](extending.md#panning-a-scene-you-drew), which a pane
  that pans a scene it drew itself calls — so a scene that misrenders while
  panning is one variable away from being told apart from one that misdraws;
- the `<glarea>` overlay's copy, where a child of a surface that only moved
  is moved on its pane rather than repainted ([elements.md](elements.md#glarea));
- the window's own copy of a subtree that only moved: a card with a
  background nothing shows through, dragged across a pane, is copied where
  it went and the frame paints the strip it uncovered
  ([extending.md](extending.md#an-element-that-covers-its-box)).

With this set, each of them repaints instead.

## `REACT_X11_NO_PANE_SHAPE=1`

Leaves every X11 pane over a `<glarea>` the rectangle of its child's reach,
where by default a pane is cut with the SHAPE extension to what its child
actually paints ([elements.md](elements.md#glarea)). A rectangle covers the
GL frame with the surface's `clearColor` wherever the child's reach goes
past its ink — a `<Flow>` graph's edges stop short of every card and lose
their arrowheads — so this is for measuring the cut against the rectangle,
and as first aid if a pane's cut is ever wrong.

## `REACT_X11_STRICT_TOKENS=1`

Makes an unresolvable `$token` fatal instead of reported.

By default a token the palette in force does not define is dropped, named
loudly on stderr — token, element, owning component, and every token the
palette _does_ have — and counted as a failure through `process.exitCode`.
The widget paints one property short, which is visible, and the rest of the
app keeps running. (A throw there could not be caught by most boundaries:
the check runs as a node's ancestry completes, often while React completes
the `<window>` or from a desktop light/dark switch with no React on the
stack.)

Set this when you would rather stop than paint something wrong — a kiosk, or
a CI job that should fail at the first bad token rather than at the
screenshot diff:

```sh
REACT_X11_STRICT_TOKENS=1 npm run examples:theming
```

The error is raised from the offending node's own `commitMount`, on its own
fiber, so an [error boundary](react-features.md) at any depth inside the
window catches it and renders a fallback for that subtree rather than
losing the window. With no boundary above it, it reaches `onUncaughtError`
and the process stops. The one path that cannot be routed is the desktop
appearance switch; there strict mode crashes.

## `REACT_X11_NO_BOUNDS_CACHE=1`

Disables the cached paint reach — the rect of a node unioned with its
descendants', which a bounded frame asks of every subtree on the way to its
rect, and which is kept until layout, a child list change, a style swap, a
state flip or the node's own `invalidate` moves it. With this set every walk
is fresh, so if a node ever goes missing from a bounded repaint — culled by
a reach nobody updated — this is the first thing to try, and a fix that
lands here is a change nobody announced through `invalidate`.

## `REACT_X11_NO_STROKE_CHUNKING=1` (macOS, Windows)

The 2d context the Cocoa and win32 backends share splits a stroke with many
subpaths into several platform calls, which makes a stroke of thousands of
subpaths many times faster; the antialiased fringe where two subpaths'
strokes overlap is then half-covered twice rather than covered once, and
reads a little lighter. This switch hands every stroke to the platform in
one call. Set it to compare the two on the same build, or as first aid if a
drawing that strokes thousands of subpaths ever looks wrong at its seams.
`ctx.strokeChunking = false` is the same switch for one context.

Nothing on X11 reads it: there a stroke is one coverage mask, so splitting
would be a loss.

## `REACT_X11_NO_TRANSPARENCY=1`

Makes every display answer the way one with no 32-bit visual does:
[`transparent`](elements.md#transparent--rounded-corners-and-translucency)
is ignored, windows are created on the ordinary visual,
`'@supports transparency'` ([styling.md](styling.md#capability-queries))
never matches, and `useSupports('transparency')` is false.

```sh
REACT_X11_NO_TRANSPARENCY=1 npm run examples:tooltips
```

It lets you see the fallback design — rounded menus, the tooltip's arrow,
any `@supports` block of your own — without stopping the compositor, which
would take every other window on the desktop with it. Both halves answer
this switch at once, so a window never takes the ARGB visual under a
`useSupports` that said no.

What it models is a display with **no 32-bit visual** — XQuartz, a plain
remote server. The other degraded case, an ARGB window with _nothing
compositing it_ (a cleared corner comes out black rather than showing the
desktop), needs a real session with the compositor off, or
`setCompositingForTests`. Both should render the same.

Unlike the switches above it is read per call rather than once at startup —
when a window is created and when a `@supports` block resolves, never on the
frame path — so a test can turn it on around a single mount.

## The paint cache — `REACT_X11_NO_PAINT_CACHE`, `REACT_X11_PAINT_CACHE=verify`

`<svg>` renders its content once and composites the result on
later repaints, keyed on _what is drawn_ rather than on which node drew it —
so a wall of 400 cells holding eight distinct icons keeps eight rendered
copies, and a repaint of unchanged content is one composite per cell. Your own
drawings opt in with [`<canvas cacheKey>`](elements.md#cachekey--draw-it-once).

Three switches, all read once at startup:

- `REACT_X11_NO_PAINT_CACHE=1` disables it entirely, so everything paints
  live. For measuring against the cached path on the same build, and as first
  aid if anything ever renders stale — same role as `REACT_X11_NO_SCROLL_BLIT`.
- `REACT_X11_PAINT_CACHE=verify` re-renders every cache hit and compares a
  digest of the drawing calls against the one recorded when the entry was
  made. A cache key that fails to name something the drawing reads then says
  so, loudly, at the moment it would otherwise have shown a stale pixel:

  ```
  react-x11: paint cache key does not cover the paint of <canvas>.
    key: canvas|64x24@1|spark:3
    The drawing changed while the key did not, so a cached frame would show
    stale pixels. Add whatever changed to the key.
  ```

  Slow by construction — it does all the work the cache exists to avoid, plus
  the comparison. Worth leaving on while developing a `cacheKey`.

- `REACT_X11_DEBUG_PAINT_CACHE=1` prints a line per frame: entries, bytes
  held, and hits/misses/renders/evictions. Rising `renders` on a still screen
  means keys that change when they should not; rising `evictions` means the
  working set does not fit the budget.

## Rounded boxes — the corner-glyph fast path

On X11, a `fill()` or `stroke()` whose path is exactly one axis-aligned
`roundRect` on integer geometry — what every `borderRadius` box draws — goes
out as four cached corner glyphs plus rectangles, with nothing rasterized or
uploaded in steady state. A box that falls back still renders, identically,
as a polygon, which on a server without accelerated trapezoids (a
virtualized GPU) can cost an order of magnitude more per frame. The fallback
is silent, so the counters below are how you notice it.

Design notes and measurements:
[design/debugging.md](../design/debugging.md#rounded-boxes--the-corner-glyph-fast-path).

### Seeing which boxes took it

`REACT_X11_TRACE=summary` ends its histogram with the tally:

```sh
REACT_X11_TRACE=summary npm run examples:tasks
# react-x11 trace: 83 requests (15.6KB out), 32 replies, ...
#        6  Render.CompositeGlyphs8
#        6  Render.FillRectangles
#   rounded boxes: 6 fast (glyph+rect), 2 fell back (fractional 2)
```

The same tally is on `trace.stop().shapes` as `{ hits, misses }`, and ntk
prints a process-wide version under `NTK_DEBUG_SHAPES=1`. In the opcode
histogram the fast path shows as `Render.CompositeGlyphs8` and
`Render.FillRectangles`; the fallback as `Render.Trapezoids`,
`Render.AddTraps` or a `PutImage`-heavy `Render.Composite`.

### Why a box falls back

`misses` counts by reason. In rough order of how often they bite:

- `fractional` — the box, or the stroke's band, is not on whole pixels:
  usually a box laid out on a half-pixel. Any border width, odd or even,
  takes the fast path.
- `radius-cap` — the corner radius is over `shapePolicy.maxRadius` (64 by
  default). Also what the off switch reports.
- `gradient` — the fill or stroke style is not a solid colour.
- `clip-mask` — a non-rectangular clip is in effect. Rectangular clips are
  fine, and so, on X11, is a rounded box's own `overflow` clip: everything
  inside a rounded card or pane stays on the fast path. The exceptions are a
  box that is corner all the way along a side (a pill), one laid out off the
  pixel grid, and a clip an element sets itself.
- `dashes` — `borderStyle: 'dashed'`.
- `transform` — the context's matrix is not translate-only.
- `composite-op`, `geometry`, `radii-mix`, `join` — a non-`source-over`
  operation, a degenerate or oversized box, mixed per-corner radii on a
  stroke, a non-miter join on a square one.

### Turning it off

`app.shapePolicy` sits beside `rasterPolicy` and `textPolicy`:

```js
const root = await createRoot();
root.app.shapePolicy = { maxRadius: 0 }; // off; every box goes back to polygons
root.app.shapePolicy = { maxRadius: 32, cacheBytes: 128 << 10 };
```

`NTK_NO_SHAPE_GLYPHS=1` does the same from the environment. Both are for
A/B measurement and for cornering a suspected rendering difference — an
application should not need to turn it off. The two routes differ only in
corner antialiasing (under 4/255 for fills, up to 48/255 on a stroked
corner); every pixel outside the corners is exact, and translucent colours
are safe.

## Invalidation reasons

Every internal `invalidate()` call names why it ran, from a small closed
set: `props`, `position`, `style-state`, `shadow`, `outline`, `theme`,
`ink`, `direction`, `scale`, `units`, `animation`, `scroll`, `text`,
`selection`, `content`, `measure`, `child-list`, `focus`, `caret`,
`resize`, `mount`, `expose`, `highlight`, `trace-updates`, `capabilities`,
`layout` (`INVALIDATE_REASONS` in `src/nodes/damage.js` says what each one
means). A frame's collected reasons are what `REACT_X11_TRACE=requests`
frame lines, the chrome trace's frame slices and the full-repaint warning
print. After a frame they are readable on the window node as
`root._lastReasons` (an instrumentation surface, like
`root._lastDamageRects` — not public API).
