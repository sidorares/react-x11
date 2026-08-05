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
  (`frame 412: 320x24@8,40 reasons=style-state fence=0.4ms`). X errors are
  decoded and name the failing request. `fence` is ntk's measured server
  round trip after the previous frame — how long the server took to drain
  what that frame drew. Client work and server work separate here: a paint
  that builds in 0.3ms against a fence of 20ms is a server-side problem
  (software-fallback RENDER ops, a virtualized GPU), not a renderer one.
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

## `REACT_X11_NO_SCROLL_BLIT=1`

Disables the scroll-blit fast path (a pure scroll `CopyArea`s the
surviving band and repaints only the exposed strip), so a scroll frame
repaints its whole viewport again. For measuring the blit against the
plain path on the same build, and as first aid if a scroll ever
misrenders. Read once at startup, like the switches above, and like them
it answers only to `1` — any other value leaves the blit on.

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

`<svg>` and `<tex>` render their content once and composite the result on
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

## Invalidation reasons

Every internal `invalidate()` call now names why it ran, from a small
closed set: `props`, `style-state`, `theme`, `animation`, `scroll`,
`text`, `content`, `child-list`, `focus`, `caret`, `resize`, `mount`,
`expose`, `highlight`. The frame's collected reasons are what
`REACT_X11_TRACE=requests` frame lines, the chrome trace's frame slices,
the full-repaint warning and `examples/stress/perf.js` print. After a
frame they are readable on the window node as `root._lastReasons`
(instrumentation surface, like `root._lastDamageRects` — not public API).
