# Runtime diagnostics

Three switches answer the three questions a slow or misbehaving frame
raises: _what went on the wire_ (`REACT_X11_TRACE`), _what got repainted_
(`REACT_X11_DEBUG_PAINT`), and _why_ (invalidation reasons, printed by
both). They complement [devtools.md](devtools.md) (component tree) and
`REACT_X11_DEBUG_LAYOUT=1` (outline every drawn node, colour by depth).

X11 is a network protocol even on a local socket, and the renderer's
performance model — damage rects, one `CopyArea` per presented rect — is
invisible at runtime without these. The failure mode they exist for is the
silent full-window repaint: correct pixels, quietly costing the whole
window every frame.

Everything here is built to cost nothing when off: the environment
switches are read **once at startup** (a `process.env` read is a real
environment lookup, and these sit on the frame path), the tracer module is
not even imported unless `REACT_X11_TRACE` is set or you import
`react-x11/debug` yourself, stacks are only captured under
`REACT_X11_DEBUG_PAINT=full` or `+stacks`, and the per-frame reason
bookkeeping is a handful of set insertions. Measuring the renderer must
not change what it measures.

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
  decoded and name the failing request. `landed` is ntk's `frameLatency`:
  how long the previous frame took to be answered, which means different
  things on the two frame clocks. On ntk >= 7 a window presents by default
  and its frames end on the display, so this is time-to-display and reads
  about **one refresh period** — 16ms on a 60Hz screen is the system
  working. Client work and server work still separate here, but the question
  to ask of a large number is which clock produced it: on `frameClock: 'fence'`
  it is a server round trip, and a paint that builds in 0.3ms
  against 20ms there _is_ a server-side problem (software-fallback RENDER
  ops, a virtualized GPU) rather than a renderer one.
  `npm run bench:frames` reports the same split as a summary.
- `chrome:/tmp/trace.json` — [Chrome Trace Event
  JSON](https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU),
  written at exit. Open it in Perfetto or `about:tracing`: React commits
  and painted frames are slices, requests and errors are instant events —
  so "this interaction sent 4000 requests" becomes "3600 of them were
  `CompositeGlyphs32` inside one commit".

Append `+stacks` to `requests` or `chrome` to capture a JS stack per
request (node-x11's seq2stack mechanism). An X error is asynchronous — it
arrives long after the call that caused it returned — and the captured
stack is the only thing that maps it back to your code. It costs an
`Error` capture per request, so it is opt-in.

The tracer attaches to a connection _after_ its handshake, so the
connection-setup packet — the one carrying the X auth cookie — is
structurally invisible to it, and payload bytes are never recorded: only
opcode, length and direction.

### `startTrace()` — the same thing as an API

```js
import { startTrace } from 'react-x11/debug';

const trace = startTrace(); // sink: 'summary' | 'requests' | 'chrome'
await interaction();
const { requests, bytesOut, replies, byOpcode } = trace.stop();
```

With no `app` the trace follows every connection the renderer has open or
opens later; pass `startTrace({ app })` to trace one specific connection
(the bench harness does this). `byOpcode` maps decoded request names —
`'CopyArea'`, `'Render.CompositeGlyphs32'` — to counts. This is the same
splitter `npm run bench` uses, promoted to a runtime feature; for
committed regression numbers still use the bench (`scripts/bench/`), whose
in-process server keeps them deterministic.

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
    at WindowNode.invalidate (src/nodes.js:…)
    at ...
```

Full repaints are the renderer's main performance bug class (see
"Protocol efficiency" in AGENTS.md); before this switch nothing surfaced
them. Expected full repaints exist too — a resize, the first frame after a
mount, ntk invalidating its backing store — and their reasons say so.

A bounded frame can still be doing the work of an unbounded one, and this is
where to notice it: an element that draws a whole **scene** into one node — a
graph view, a chart, an editor — is one node to the damage machinery, so a
tight outline around what moved can sit over a pane that redrew all of
itself inside it. Such an element reads the pass's rect and claims its own
commits ([extending.md](extending.md#drawing-a-scene-into-one-node)).

## `REACT_X11_NO_SCROLL_BLIT=1`

Disables the scroll-blit fast path (a pure scroll `CopyArea`s the
surviving band and repaints only the exposed strip), so a scroll frame
repaints its whole viewport again. For measuring the blit against the
plain path on the same build, and as first aid if a scroll ever
misrenders. Read once at startup, like the switches above, and like them
it answers only to `1` — any other value leaves the blit on.

It covers the element-owned form of the same shift as well —
[`scrollContents`](extending.md#panning-a-scene-you-drew), which a pane
that pans a scene it drew itself calls — so a scene that misrenders while
panning is one variable away from being told apart from one that misdraws.

## `REACT_X11_STRICT_TOKENS=1`

Makes an unresolvable `$token` fatal instead of reported.

By default a token the palette in force does not define is dropped, named
loudly on stderr — token, element, owning component, and every token the
palette _does_ have — and counted as a failure through `process.exitCode`.
The widget paints one property short, which is visible, and the rest of the
app keeps running. That is the default because the check runs when a node's
ancestry completes, and on most of those paths a throw cannot be caught: on
a fresh mount React is completing the `<window>`, so the error is attributed
above every boundary inside it, and a desktop light/dark switch reaches the
tree from an X event with no React on the stack at all.

Set this when you would rather stop than paint something wrong — a kiosk, or
a CI job that should fail at the first bad token rather than at the
screenshot diff:

```sh
REACT_X11_STRICT_TOKENS=1 npm run examples:theming
```

Strict mode still throws somewhere useful. The error is raised from the
offending node's own `commitMount`, on its own fiber, so an
[error boundary](react-features.md) at any depth inside the window catches
it and renders a fallback for that subtree rather than losing the window.
With no boundary above it, it reaches `onUncaughtError` and the process
stops — which is the point. The one path that cannot be routed is the
desktop appearance switch; there strict mode crashes.

Read once at startup like the switches above, and answers only to `1`.

## `REACT_X11_NO_BOUNDS_CACHE=1`

Disables the cached paint reach. A bounded frame asks every subtree on the
way to its rect whether it reaches in, and the answer — the node's rect
unioned with its descendants' — is kept until something that moves it says
so: a rect assigned by layout, a child list change, a style swap, a state
flip, a change the node announces about itself. Recomputing it per pass made
a one-cell repaint cost the whole tree (1.25ms at 3,600 nodes, 0.37ms
cached). With this set every walk is fresh, so if a node ever goes missing
from a bounded repaint — culled by a reach nobody updated — this is the
first thing to try, and a fix that lands here is a change nobody announced
through `invalidate`. Read once at startup; answers only to `1`.

## `REACT_X11_NO_TRANSPARENCY=1`

Makes every display answer the way one with no 32-bit visual does:
[`transparent`](elements.md#transparent--rounded-corners-and-translucency)
is ignored, windows are created on
the ordinary visual, `'@supports transparency'`
([styling.md](styling.md#capability-queries)) never matches, and
`useSupports('transparency')` is false.

```sh
REACT_X11_NO_TRANSPARENCY=1 npm run examples:tooltips
```

It exists because the fallback design is otherwise unreachable on the
machine you work on. Rounded menus, the tooltip's arrow and any
`@supports` block of your own have a second look for displays that cannot
composite — and the only way to see it used to be stopping the compositor,
which takes every other window on the desktop with it. Both halves answer
this switch at once, deliberately: a window that took the ARGB visual under
a `useSupports` that said no would size a popup for chrome it then refused
to draw.

What it models is a display with **no 32-bit visual** — XQuartz, a plain
remote server. The other degraded case, an ARGB window with _nothing
compositing it_, is the one where a cleared corner comes out black rather
than showing the desktop; that one needs a real session with the compositor
off (or `setCompositingForTests`), since the visual has to be taken for the
question to arise. Both render the same by design, which is the invariant
worth checking.

Like the switches above it answers only to `1`, so a stale
`NO_TRANSPARENCY=0` cannot quietly mean the opposite of what it says.
Unlike them it is read per call rather than once at startup — it is asked
when a window is created and when a `@supports` block resolves, never on
the frame path, and being live is what lets a test turn it on around a
single mount.

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

A rounded box is the most common non-rectangular thing a UI draws and,
historically, the most expensive: its corners become a polygon, and a
polygon becomes either server-side trapezoids (which glamor does not
accelerate — measured at ~5.6ms per operation on a virtualized GPU) or a
client-side coverage mask that is uploaded again every frame.

ntk 6.7.0 recognizes the shape instead. A `fill()` or `stroke()` whose path
is exactly one axis-aligned `roundRect` on integer geometry goes out as
**four cached corner glyphs plus `FillRectangles`** — the corners ride the
glyph path every X server optimizes, cached server-side after first use,
and the straight runs between them are plain rectangles. Nothing is
rasterized or uploaded in steady state. `_paintBackground` and
`_paintBorder` already draw exactly that shape, so every `borderRadius` box
takes the route with no change to your code.

What it is worth, measured on this repo's `bench:frames` cards mode against
a glamor/virgl server — 48 cards, all recoloured every frame:

|                          | fps  | paint   | landed  | wire/frame |
| ------------------------ | ---- | ------- | ------- | ---------- |
| `--border=2` (fast path) | 57.8 | 0.78 ms | 0.70 ms | 13 KB      |
| `--border=2 --no-glyphs` | 3.8  | 7.53 ms | 287 ms  | 342 KB     |

(measured on the fence clock, where the column is server drain — on the
default vertical-blank clock the fast-path row would read about one refresh
period instead, and the cliff would show in `fps` and `dropped`)

A bail-out is a silent perf cliff — the box still renders, identically,
just via the route above — so the counters matter more than usual.

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
histogram the route shows up directly: `Render.CompositeGlyphs8` and
`Render.FillRectangles` where `Render.Trapezoids`, `Render.AddTraps` or a
`PutImage`-heavy `Render.Composite` used to be.

### Why a box falls back

`misses` counts by reason. In rough order of how often they bite:

- `fractional` — the box, or the stroke's band, is not on whole pixels.
  Usually **fractional layout geometry**: a box laid out on a half-pixel
  bails whatever its border width is.

  On ntk < 7 an _odd_ border width bailed too, and it was the one to know
  about. `_paintBorder` strokes the box inset by half the border width,
  putting the stroke's centre-line radius at `borderRadius - borderWidth/2`
  — half-integer whenever the border is odd — and the stroke path wanted an
  integer radius. A 1px or 3px rounded border therefore kept its corners on
  the polygon route while the fill underneath took the fast one, which on
  the 48-card wall was 26x the wire per frame (341 KB against 13 KB) and 5x
  the client paint. ntk 7 takes those radii (sidorares/ntk#218), so a 1px
  border is now as cheap as a 2px one and no border width needs choosing
  around this.

- `radius-cap` — the corner radius is over `shapePolicy.maxRadius` (64 by
  default; glyph-atlas behaviour past that is driver-specific). Also what
  the off switch reports.
- `gradient` — the fill or stroke style is not a solid colour.
- `clip-mask` — a non-rectangular clip is in effect. Rectangular clips are
  fine; they go out as picture clip rectangles.
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
A/B measurement and for cornering a suspected rendering difference — the
route is not something an application should need to turn off.

```sh
npm run bench:frames -- cards 8 --border=2              # fast path
npm run bench:frames -- cards 8 --border=2 --no-glyphs  # same scene, polygons
npm run bench:frames -- cards 8 --border=1              # the odd-width cliff
```

The two routes are not bit-identical: they rasterize the same arc by
different means, so corner pixels differ by antialiasing — under 4/255 for
fills, up to 48/255 on a stroked corner. Everything outside the corner
boxes is exact, which is the property the decomposition rests on (the
glyphs and the rectangles partition the pixels, so no pixel is painted
twice and translucent colours are safe). `test/rounded-box-glyphs.test.js`
asserts exactly that split.

In practice the difference does not reach a screenshot: regenerating
`docs/img/*.png` with the route off moves between 0 and 0.06% of pixels,
by at most 8/255. If `npm run screenshots` ever produces a bigger diff than
that after a toolkit bump, the cause is somewhere else — ntk 6.7.0's other
change, an arc flattener that subdivides curves more exactly, moved those
same screenshots far more than this route did.

## Invalidation reasons

Every internal `invalidate()` call now names why it ran, from a small
closed set: `props`, `style-state`, `theme`, `direction`, `animation`,
`scroll`, `text`, `content`, `measure`, `child-list`, `focus`, `caret`,
`resize`, `mount`, `expose`, `highlight`, `capabilities`. The frame's collected reasons are what
`REACT_X11_TRACE=requests` frame lines, the chrome trace's frame slices,
the full-repaint warning and `examples/stress/perf.js` print. After a
frame they are readable on the window node as `root._lastReasons`
(instrumentation surface, like `root._lastDamageRects` — not public API).
