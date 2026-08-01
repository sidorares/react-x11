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
  (`frame 412: 320x24@8,40 reasons=style-state`). X errors are decoded and
  name the failing request.
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

## Invalidation reasons

Every internal `invalidate()` call now names why it ran, from a small
closed set: `props`, `style-state`, `theme`, `animation`, `scroll`,
`text`, `content`, `child-list`, `focus`, `caret`, `resize`, `mount`,
`expose`, `highlight`. The frame's collected reasons are what
`REACT_X11_TRACE=requests` frame lines, the chrome trace's frame slices,
the full-repaint warning and `examples/stress/perf.js` print. After a
frame they are readable on the window node as `root._lastReasons`
(instrumentation surface, like `root._lastDamageRects` — not public API).
