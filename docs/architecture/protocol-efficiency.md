# Protocol efficiency: the checkbox-hover audit

_Research document, 2026-08-22. Measured on the `claude/x11-protocol-efficiency`
checkout with ntk 8.2.0 / x11 3.9.0 installed, on one machine (macOS 15.2,
node v26): live XQuartz (X.Org 21.x) through the
[x11-protocol-visualizer](https://github.com/sidorares/x11-protocol-visualizer)
MITM proxy, and node-x11's in-process pure-JS X server via `scripts/bench/`.
File:line references will drift with the code; request counts will not, because
the bench now prices them._

---

## 0. TL;DR

A protocol trace of _hovering a `<Checkbox>`_ in `examples/form/index.jsx` — a frame
whose visible result is one 18×18 rounded rectangle changing colour — showed
~26 requests per frame, among them a `CreatePixmap` of a **420×380 depth-8
pixmap created and freed every frame**. The audit attributed every request in
that frame and in the mount that precedes it, across all three layers
(react-x11, ntk, node-x11).

**Findings, compressed:**

1. **[ntk] `_fillRect` misses the rectangular-clip fast path** — the dominant
   cost, and the whole explanation of the per-frame pixmap. Every `fillRect`
   under _any_ clip materializes a **window-sized a8 clip mask** and
   composites through it, when the glyph, trapezoid and image routes all
   already special-case a rectangular clip stack. A one-function fix
   (intersect the fill rect with the clip rect, composite directly) removes
   7 requests and ~2 full surfaces of server pixel work from every partial
   repaint. Verified byte-identical.
2. **[ntk] Picture-clip churn** — the rounded-rect glyph route brackets every
   shape in `SetPictureClipRectangles` + reset, so a box's fill and border
   pay 4 clip requests where 1 would do, and consecutive shapes re-set the
   clip they just reset. A sticky, lazily-reset picture clip removes ~75% of
   them. Verified byte-identical.
3. **[react-x11] Event mask declared one listener at a time** — nine
   `ChangeWindowAttributes` per window for a constant value. Fixed on this
   branch: the union goes in `CreateWindow`.
4. **[react-x11 / ntk / node-x11] Startup round trips serialized** — ~10
   dependent round trips before the first `CreateWindow`. Partially fixed on
   this branch (`createRoot`'s two probes now run concurrently); the ntk and
   node-x11 halves are proposed below.
5. The rest of the hover frame is honest work (corner glyphs, border,
   blit) — and the event side (XI2 Motion at ~136 B/event) is the price of
   smooth scrolling, with one narrow refinement available.

Prototyped fixes 1+2 against the whole bench: **requests −35…−80% and
composite pixel area −45…−95% on every partial-repaint scenario**, pixels
byte-identical (SHA-256 of full-window `GetImage` across five interaction
states), full test suite green.

---

## 1. The trace, explained line by line

The captured hover frame (reproduced byte-for-byte on the in-process server
and on live XQuartz through the proxy — same requests, same sizes):

| request                                             | bytes | why it is there                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChangeWindowAttributes {cursor}`                   | 16    | the hover path crossed into/out of a node with a `cursor`; react-x11 already dedupes (`EventManager._updateCursor`), so one request per boundary crossing is correct                                                                                                                                                                                                                                                                                                             |
| `GetInputFocus`                                     | 4     | **node-x11's void-sync**, not the frame fence (ntk#309 settled this from the reply positions: it follows the cursor write and precedes the paint, where a fence would trail `Present:Pixmap`). ntk passes a discarded `() => {}` to `ChangeWindowAttributes`, and node-x11 guarantees a callback on a void request eventually fires by injecting a `GetInputFocus` round trip. The fence proper (`Window#_armFence`) only runs where Present completions are not clocking frames |
| `CreatePixmap 420×380 depth=8`                      | 16    | **the bug.** `_fillRect` under the damage-rect clip takes the mask path: this is a full-window a8 clip mask                                                                                                                                                                                                                                                                                                                                                                      |
| `RENDER:CreatePicture`                              | 20    | picture over that mask                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `RENDER:FillRectangles Src (0,0,0,0)`               | 28    | clear the _entire_ 420×380 mask (159,600 px of server work)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `RENDER:FillRectangles Src (0,0,0,1) [18×18 rect]`  | 28    | write the clip rect into the mask                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `RENDER:Composite Over src=solid mask=a8 → backing` | 36    | the window background, painted through the mask                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `RENDER:SetPictureClipRectangles [18×18]`           | 20    | clip for the checkbox body's corner glyphs                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `RENDER:CompositeGlyphs8`                           | 76    | the body's rounded corners, as cached server-side glyphs (`shapeglyphs.js` — this part is the fast path working as designed)                                                                                                                                                                                                                                                                                                                                                     |
| `RENDER:FillRectangles Over ×3 rects`               | 44    | the body's straight strips                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `RENDER:SetPictureClipRectangles [reset]`           | 20    | eager reset after the body                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `RENDER:SetPictureClipRectangles [the same 18×18]`  | 20    | …immediately re-set for the border                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `RENDER:CompositeGlyphs8`                           | 76    | border corner glyphs                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RENDER:FillRectangles Over ×4 rects`               | 52    | border strips                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `RENDER:SetPictureClipRectangles [reset]`           | 20    | eager reset again                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `RENDER:FreePicture` + `FreePixmap`                 | 16    | the mask ceremony's teardown                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `XFIXES:SetRegion`                                  | 16    | the frame's damage as the present region (region id reused — correct)                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Present:Pixmap`                                    | 72    | the blit, scheduled against vblank                                                                                                                                                                                                                                                                                                                                                                                                                                               |

So of ~26 requests, **8 are the clip-mask ceremony** (finding 1), **3 of 4
clip set/resets are redundant** (finding 2), and the remaining ~12 are the
actual ink plus the blit. The pixel-work story is worse than the request
count: the ceremony touches ~2 × 160k px per frame for an 18×18 change.

The damage scoping above all of this is _correct_: react-x11 repaints exactly
the 18×18 checkbox box (`_takeDamage` → one clipped `_paintRegion` pass), and
a 120-motion hover sweep coalesces into 7 presents. The waste is entirely in
how the bounded repaint is translated to RENDER.

## 2. How to measure (the e2e methodology)

Two complementary rigs, both now in-repo or one command away:

**Deterministic (CI-grade): `npm run bench`.** Runs scenarios against
node-x11's in-process X server and counts requests / bytesOut / replies /
`Composite` count / **composite pixel area** / **convolved pixels** per
scenario (`scripts/bench/xcount.js`). Requests and bytes miss pixel work
entirely — a Composite is 36 bytes whether it touches ten pixels or the whole
surface — so the Mpx column is the one that catches "correct but does far too
much". The convMpx column catches the layer under _that_: area prices every
destination pixel the same, but a source or mask picture carrying RENDER's
`convolution` filter is re-convolved by the server on every composite that
reads it, so `kernel_w × kernel_h × area` is what the server actually runs.
Issue #413 is the case that motivated it — a blurred `boxShadow` left the
blur as a picture filter rather than baking it into the pixels, which made
every shadowed repaint ~700x slower with requests, bytes, composites, area,
stalls, dups, churn and the rendered pixels all unchanged.
Since #380 the same counting proxy also analyses the stream: `stalls`
(blocking round trips nothing was pipelined behind), `dupQueries` (repeated
identical reply-carrying requests) and `churn` (server resources created and
freed inside the measured window, keyed by creation parameters — the
"window-sized mask pixmap rebuilt every frame" class reads as one line with
a count), with `--hotspots` for the per-scenario detail, `--record-dir` for
x11vis-format captures of each scenario, and a CI job gating `--check`.
This audit added the two scenarios the trace exposed as unpriced:

- `fills: 20 fillRects each under a damage clip` — the window background of
  every partial repaint;
- `hover: rounded box state flip, on and off` — the whole per-frame tail of a
  pointer interaction (damage scoping → background under clip → corner
  glyphs → border → blit).

**Live (ground truth): x11vis.** The MITM proxy records byte-exact captures
against a real server, with decode, per-request RTT, stats and resource-
lifecycle lints:

```bash
# terminal 1 — proxy the real display, record
x11vis --no-ui --quiet --record hover.x11cap

# terminal 2 — the app under test, through the proxy
DISPLAY=127.0.0.1:1 npm run examples:form
```

Driving the interaction reproducibly on XQuartz (no XTEST there): the app's
own connection can sweep the real pointer with core-protocol `WarpPointer`
across the widget row — real `EnterNotify`/`MotionNotify`/XI2 events follow,
so the full input path is exercised. The capture is then sliced between
`Present:Pixmap` requests to isolate steady-state frames, and
`x11vis --diff a.x11cap b.x11cap` compares before/after sessions.

**The correctness bar.** "No visual degradation" is verified as _pixel_
byte-identity, not request-stream identity (an optimized stream is different
by definition): render the same tree through the same interaction script
under both implementations and compare SHA-256 digests of full-window
`GetImage` readbacks at each settled state. The in-process server makes this
deterministic (no font/AA variance across runs). Five states were compared
for this audit — mounted, hover on, hover wiggle, hover off, clicked — all
identical.

**The latency metric.** Requests are a proxy; the goal posts are (a) **round
trips on the critical path** (the `replies` column; each is a full RTT on a
remote display) and (b) **server pixel work per frame** (Mpx), which is what
turns into input→photon latency once the server is the bottleneck.

## 3. Findings in detail

### 3.1 [ntk] `_fillRect` + any clip = a window-sized mask (the headline)

`renderingcontext_2d.js` has a rectangular-clip fast path — "a stack of
rectangles stays virtual" — and `_drawGlyphsDevice`, `drawTraps` and
`_beginDirectComposite` (images) all use it. `_fillRect` is the one direct
route that never checks: it calls `_compositeMask()` unconditionally, whose
own comment claims it is "reached only when the clip is not a rectangle".
Under react-x11 every partial repaint clips to the damage rect first, so
_every window-background fill of every bounded frame_ takes the mask path:
`CreatePixmap` (window-sized, depth 8) + `CreatePicture` + full-surface
clear + rect write + `Composite` through the mask + `FreePicture` +
`FreePixmap` — recreated per frame because `restore()` drops the mask.

**Fix.** In the identity-transform branch of `_fillRect`: if the clip stack
is all rectangles, intersect the fill rect with `_clipRect()` and composite
directly (`mask=0`, or a 1×1 repeating solid for `globalAlpha < 1`, exactly
as `_beginDirectComposite` already does). Fall back to `_compositeMask()`
only for a genuinely non-rectangular stack. The same treatment applies to
the remaining `_compositeMask()` call sites (the two `drawImage` legs).

**Why byte-identical:** compositing `src IN mask(=1 inside R, 0 outside)`
bounded to rect D writes exactly the pixels of D∩R; compositing unmasked
bounded to D∩R writes the same pixels with the same operator arithmetic.
Verified empirically (§5).

**Bonus:** this also stops per-frame XID allocate/free churn — the capture's
lint pass flags the freed mask pixmap's id being recycled into a Present
event id, which is legal but makes captures harder to read.

### 3.2 [ntk] Sticky picture clip

`_emitShapeGlyphs` (and the text fast path) bracket each run in
`SetPictureClipRectangles(clip)` … `SetPictureClipRectangles(0,0,32767,32767)`.
A rounded box paints as _fill bracket + border bracket_: four clip requests,
two of them setting the value the previous one just reset.

**Fix.** Make the destination picture's rectangular clip a piece of tracked
state: a set that matches the applied clip is skipped, and the reset is
recorded lazily and only flushed by the next operation that draws to the
picture under a different (or no) clip. Every RENDER op that names the
context's picture as destination goes through one accessor, which is what
makes the laziness safe — an unobserved reset-then-set-same pair is, by
construction, unobservable to the server. In the hover frame this turns 4
clip requests into 1.

### 3.3 [react-x11, landed] The event mask, one request instead of nine

ntk grows a window's server-side event mask from a `newListener` hook — one
`ChangeWindowAttributes` per first listener of each kind. react-x11's
subscriptions are a constant (pointer ×4, keys ×2, focus ×2, plus ntk's own
Exposure for the backing store), so mount paid nine requests for a value
known before the window existed. `WindowNode.realize()` now passes the union
as a `CreateWindow` attribute; ntk ORs it in and every lazy grow becomes a
no-op. _(A complementary ntk fix — coalescing mask grows per tick — would
serve non-react ntk apps too.)_

### 3.4 [all three, partially landed] Startup round-trip pipelining

Before the first `CreateWindow`, instrumented reply-by-reply:

| layer                  | chain                                                                                                                                       | round trips       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| node-x11               | connection handshake                                                                                                                        | 1                 |
| ntk `createClient`     | `require('glx')` → `require('render')` (QueryExtension → QueryPictFormats, nested) → `Render.QueryVersion`                                  | 4–5, **serial**   |
| react-x11 `createRoot` | `beginCompositing` (InternAtom → GetSelectionOwner → XFixes QueryExtension) then `beginScreens` (QueryExtension → InternAtom → GetProperty) | 6, **was serial** |

On a remote display at 20 ms RTT that is ~200 ms of pure serialization before
the first pixel. Landed here: `createRoot` awaits its two probes with
`Promise.all` (the trace now shows them interleaved — the floor is the
slower chain, not the sum). Proposed for ntk: run the `glx` and `render`
requires concurrently and pipeline `QueryVersion` behind `QueryExtension`'s
reply (both only need the major opcode). Proposed for node-x11: the render
extension's own `QueryVersion`/`QueryPictFormats` can go out together.

Also verified, no action needed: node-x11's write path already batches
Xlib-style (16–64 KB buffer, flush on reply-bearing requests, `setImmediate`
backstop), atoms are cached with the 68 standard atoms pre-seeded, and the
17 `InternAtom`s react-x11's dnd module issues at mount are pipelined (one
RTT total). The one node-x11 nicety worth having: dedupe _concurrent_
in-flight `InternAtom`s for the same name (the cache only catches repeats
after the reply).

### 3.5 [ntk] Smaller findings

- **`_compositeMask` alpha fill is window-sized** — when `globalAlpha < 1`
  it fills the whole scratch mask with the alpha; a 1×1 repeating solid (as
  `_beginDirectComposite` uses) or a fill bounded to the composite rect is
  the same result without the full-surface write.
- **The backing store's birth clear** — every backing pixmap is
  `PolyFillRectangle`d white at creation, and react-x11's first frame then
  paints every pixel of it. Skipping the clear when a full-window paint is
  already queued would save one full-surface fill per window/resize.
- **`AddGlyphs` per batch** — a first paint uploads new glyphs as
  encountered (20 `AddGlyphs` at form mount). Same bytes, fewer requests if
  accumulated per (frame × glyphset).

### 3.6 The event side (bytes _in_)

In the live hover capture, `XInputExtension:Motion` is the single largest
item: 120 events, 16,320 bytes — 96% of event traffic, ~136 B per motion
against 32 B for core `MotionNotify`. This is the cost of XI2 Motion
selection, which is what smooth (sub-notch, valuator-based) scrolling rides
on, so it is bought deliberately (issue #273). One refinement is available:
ntk already queries the seat's scroll axes for its wheel bookkeeping, so on
a seat with _no_ scroll valuators the XI2 Motion selection buys nothing and
could be skipped, keeping 32-byte core motion. Not worth conditioning on
anything finer — device hot-plug would re-open the question mid-session.

Also checked and fine: motion coalescing (120 injected motions → 7 painted
frames), `PointerMotion` selection itself (hover styling needs it), and the
cursor updates (deduped; one request per hover-boundary crossing).

### 3.7 Why the traced session showed `GetInputFocus` _and_ `Present:Pixmap`

_Corrected 2026-08-23 — the first version of this section blamed the frame
fence; ntk#309's position analysis showed otherwise._

The per-frame `GetInputFocus` in the original capture is **node-x11's
void-sync**, not ntk's fence. ntk's `setCursor` (and its lazy event-mask
grows) pass a no-op `() => {}` callback to `ChangeWindowAttributes`, and
node-x11 honours its guarantee that a callback on a void request eventually
fires by injecting a `GetInputFocus` round trip when no reply-bearing
request follows in the same tick. The tell is the position: each
`GetInputFocus` follows a cursor write and precedes the frame's drawing,
where a fence would trail `Present:Pixmap` in the same synchronous run —
and the client never waited on the reply. The Present completion clock was
active in that capture all along (a live probe on this machine's XQuartz
confirms `frameClock: 'present'`); its 20.5 ms RTT is still informative —
that is the server draining the frame's mask ceremony, which finding 1
removes. Fixes: drop the discarded callbacks (ntk#309 / PR ntk#311, which
also memoizes the cursor id ntk-side). The fence itself needs no change: it
is the flow control everywhere Present completions cannot clock frames, and
one 4-byte request per frame is the correct price there.

## 4. Numbers

Bench, ntk 8.2.0 as published ("before") vs the same with fixes 3.1+3.2
prototyped ("after"). Composites and text/glyph bytes are unchanged
throughout — the ink is the same ink.

| scenario                                     | reqs before → after | Mpx before → after |
| -------------------------------------------- | ------------------- | ------------------ |
| fills: 20 fillRects each under a damage clip | **150 → 30**        | **3.36 → 0.18**    |
| hover: rounded box state flip, on and off    | **37 → 20**         | 0.00 → 0.00        |
| clips: 40 nested rect clips with text        | 148 → 108           | 0.16 → 0.16        |
| scroll: 10 notches over 500 rows             | 329 → 207           | 0.64 → 0.39        |
| svg: 10 unchanged icons in a damaged row     | 41 → 16             | 0.01 → 0.01        |
| update: 5 color flips, no layout             | 49 → 19             | 0.03 → 0.03        |
| update: 5 absolute box moves (layout)        | 48 → 18             | 0.03 → 0.03        |
| scene: 5 drag steps over 300 cells           | 240 → 146           | 0.08 → 0.01        |
| scene: 5 pan steps over 374 cells            | 983 → 623           | 0.30 → 0.06        |
| scene: 5 pan steps with a HUD strip          | 3060 → 1992         | 1.10 → 0.43        |

Full-repaint scenarios (mount, icon wall, gradient cards) are unchanged —
they never clip, so they never paid the tax. The `Mpx` collapses are the
through-mask composites and full-surface mask clears disappearing; on a
slow or software-rendering server that column is frame time.

react-x11 changes landed with this document (measured on the mount trace):
9 `ChangeWindowAttributes` → 0, and the pre-window probe serialization
6 round trips → the slower of two ~3-trip chains.

Verification: the full test suite passes with the prototyped ntk (the six
known macOS-only appearance failures and nothing else), and SHA-256 digests
of full-window `GetImage` readbacks across five interaction states are
identical between published and prototyped ntk.

## 5. What lands where

- **This branch (react-x11):** event mask at `CreateWindow`; concurrent
  `createRoot` probes; the two bench scenarios + baseline refresh; this
  document.
- **ntk (proposed, prototype validated):** `_fillRect` rectangular-clip fast
  path (§3.1, also the `drawImage` `_compositeMask` legs); sticky picture
  clip (§3.2); bounded/solid alpha mask (§3.5); optional: coalesced event-
  mask grows, deferred backing clear, per-frame `AddGlyphs` batching,
  scroll-axis-gated XI2 Motion. Once released, react-x11 re-saves the bench
  baseline to lock the improvement in (the skipped-on-CI trap: CI installs
  published ntk, so the baseline must always be saved against it).
- **node-x11 (proposed):** pipeline extension init round trips; dedupe
  concurrent `InternAtom`s.

---

## Addendum, 2026-08-23: where the proposals went

Filed and in flight the day after the audit:

- react-x11#380 (landed) — the bench's counting proxy grew the `stalls` /
  `dupQueries` / `churn` analysis, a pointer-driven Checkbox hover scenario,
  `--hotspots`, x11vis-format `--record-dir`, and a CI `--check` gate.
- ntk#307 → PR ntk#312 — the `fillRect` rectangular-clip bypass (§3.1),
  including `globalAlpha` as a 1×1 solid on every direct composite.
- ntk#308 — the sticky, lazily-reset picture clip (§3.2).
- ntk#309 → PR ntk#311 — drop the no-op callbacks whose void-sync this
  section originally misread as the fence (§3.7), and memoize the cursor.
- ntk#313 — the residual `_compositeMask` fallback: full-surface alpha
  stamp and clip intersection bounded to the composite box (§3.5's first
  bullet, narrowed to what PR ntk#312 leaves behind).
