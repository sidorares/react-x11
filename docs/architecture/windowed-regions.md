# Windowed regions: when X11 subwindows pay, and what API to give them

_Research document, 2026-08-01. Measured against the `perf/scroll-blit` checkout (nodes.js @
4219 lines), ntk 4.2.0 installed. All measurements ran on one machine (Apple M1 Pro, macOS 15.2,
node v26): live XQuartz 2.8.6 (X.Org 21.1.23, custom build), Xvfb 21.1.23 (stock Xorg
dix/mi/fb), and node-x11's in-process pure-JS X server via the repo's own bench harness.
Benchmark scripts and raw research notes are preserved out-of-tree (see §10); file:line
references are to the checkout above and will drift with the code._

---

## 0. TL;DR

Today every control is drawn into one surface per `<window>`/`<popup>`; hover on 1 of 1000
controls means `PointerMotion` selected on the whole window plus an O(N) JS hit test per motion
frame. The research question: when should a control or region get a real X subwindow instead,
and how automatic should that be?

**Findings, compressed:**

1. **Subwindows are cheap as objects and expensive as a lifestyle.** A window costs ~290 B server
   heap, ~5 µs to create, 8 B to destroy recursively. But per-child map/move storms are O(siblings)
   each (654 ms to nudge 5000 mapped children on XQuartz), every toolkit that shipped
   window-per-widget abandoned it, and core X cannot alpha-blend a child over its parent — no
   translucency, no antialiased rounded corners, no drawn overlays above a windowed region.
   **Window-per-control is dead on arrival; nothing here re-litigates that.**

2. **The measured hover cost is client-side JS, not the wire — and it is fixable client-side.**
   A motion frame at 1000 controls costs ~27 µs and ~8–11 KB of allocation, ~94% of it in
   `hitTest`'s per-node `paintOrder()` churn and unpruned descent, not in the hover machinery.
   GTK4 hit-tests every motion client-side and considers it fine; Flutter does it at 120 Hz on
   phones — the fix is caching + pruning (see §5.1), not protocol surgery. Subwindow event masks
   would win the _wire_ (zero motion traffic, server-side Enter/Leave picking at ~3 ns per mapped
   sibling), which matters for remote X and battery, but they are not needed to fix the CPU cost.

3. **The one region where a subwindow structurally wins is the scrollview.** Moving a child window
   is a server-side blit with Expose only for the revealed strip — verified on XQuartz and Xorg —
   i.e. exactly what the scroll-blit branch hand-builds, minus all ~12 purity gates, the per-frame
   O(N) safety walk, the scrollbar-repair choreography, and the per-notch full-tree
   relayout+absolutize. A `viewport window + content window` scrollview turns a scroll into one
   20-byte ConfigureWindow — and on Composite servers (**the deployment majority**: Xorg+
   compositor, XWayland), a `backing-store: WhenMapped` content pane scrolls with **zero Expose**:
   the server restores the revealed strip from its own backing. XQuartz (minority, no Composite)
   falls back to Expose-strip repaints served from ntk's pixmap. Constraints: positions are INT16
   (±32767 → re-anchoring for long content), backing memory for the content pane, and drawn rows
   only (windowed rows inside the pane would pay O(children) clip revalidation per scroll frame).

4. **API answer from history and from our numbers: automatic-off, explicit-in, at region
   granularity.** Every surviving toolkit converged on: native windows for toplevels + popups
   (react-x11 already does this), plus a small number of explicitly-promoted surfaces where the
   server gives something the drawn path cannot (GL/video/foreign — `<glarea>` already exists),
   plus framework-inserted promotion at _known_ hotspots (Flutter's repaint boundaries around
   scrollables). Fully automatic promotion exists only in browsers and needed a decade of
   squashing heuristics. The concrete proposal is in §8: keep `<box windowed>` out of the public
   API; instead (a) fix the client-side hit test, (b) make the scrollview internally windowed
   behind a feature gate, (c) keep real windows implicit-by-capability (glarea, future
   `<foreign>`), and (d) optionally spike InputOnly hit-region windows for per-region cursors and
   hover-during-scroll correctness — the only subwindow variant with zero rendering downside.
   **§8.1 turns this into an issue-ready, dependency-ordered action plan** (code, API, and docs
   items with acceptance criteria).

5. **Gravity is a latency mask, not a layout engine.** `winGravity` can pin corner/edge-anchored
   children server-side during a parent resize (it works on XQuartz — quartz-wm itself relies on
   it), but it expresses only `x = a + b·W, b ∈ {0, ½, 1}` and never resizes anything; flex-grow,
   stretch (yoga's default), percentages and space-between all need the client anyway. Useful only
   to hide one frame of resize latency on anchored panes; not a reason to add windows.

### 0.1 Cross-check against the project goals

The goal hierarchy this document is graded against: **(main) perceived performance** — minimum
input→screen delay, achieved by prepping while idle, updating as much as possible instantly, and
catching up afterwards; **(note) visual stability** — no stutter, no unexpected jumps, no
queued-event storms; **(secondary) client CPU first, server CPU second.**

| item                                   | input→photon latency                                                                   | stability                                                                         | client CPU                              | server CPU                           |
| -------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------ |
| A. hit-test caching/pruning            | small direct win; big _jitter_ win (less GC)                                           | **GC-pause stutter shrinks** (8–11 KB/event → ~1 KB)                              | the top measured win                    | —                                    |
| B. windowed scrollview                 | **the headline win**: scroll applied at server speed, decoupled from React             | server blit is atomic; re-anchor seams and hover churn must be engineered (below) | deletes per-notch relayout + gate walks | small (blit + O(pane siblings) clip) |
| C. capability windows (glarea/foreign) | n/a (capability, not perf)                                                             | airspace rules as documented                                                      | —                                       | —                                    |
| D. InputOnly hit regions               | **cursor feedback becomes server-side-instant**, immune to client busyness             | Enter/Leave uncoalesced → needs frame debounce                                    | motion stream off when idle             | ~µs picking                          |
| gravity (§5.5)                         | **upgraded under this lens**: "latency mask" _is_ the main goal during resize gestures | `winGravity: Unmap` prevents stale-position jumps                                 | —                                       | —                                    |
| window-per-control                     | still dead: storms _add_ latency and jank                                              | storms are anti-stability                                                         | —                                       | O(siblings) each                     |

What the lens changes, specifically:

- **B's real rationale is latency, not request counts.** Today a wheel notch is: discrete
  ButtonPress → `scrollBy` → `invalidate(true)` → _wait for the paced frame_ (up to 16 ms +
  fence) → full-tree relayout + absolutize → repaint/blit → present. With a windowed pane the
  ConfigureWindow can be written **synchronously inside the wheel handler, before React runs
  anything** — the screen moves at server speed, and layout/virtualization catch up on the
  following frames. Scroll responsiveness decouples from render cost entirely: even mid-GC or
  mid-heavy-render, queued wheel events still turn into 20-byte moves the server applies
  smoothly, instead of accumulating into one visible catch-up jump. This is the
  "update instantly, then catch up" pattern made structural.
- **Idle prep has a concrete new lever: overdraw prepainting.** A content pane sized
  viewport+overdraw can have its off-screen band rasterized into backing _while idle_ — then the
  next N notches reveal already-painted pixels with zero client work at input time (server
  restores from backing on Composite targets). Today's window-sized backing cannot prepaint
  beyond the viewport at all. Idle time becomes scroll headroom; re-anchor work also belongs in
  idle, never on the input path.
- **Stability items promote from "risks" to requirements.** (1) One shared frame clock /
  atomic present per top-level is a _stability_ requirement, not an optimization — two regions
  presenting independently in one gesture is visible tearing (Present is the long-term protocol
  answer). (2) Enter/Leave arrive uncoalesced → hover restyles need a frame-level debounce or
  crossing storms cause per-crossing paints. (3) Re-anchor seams must be invisible: prepaint the
  re-anchored backing before the swap, swap in one frame. (4) Windowed regions should be
  size-stable during interactive resize (GTK's "partial results drawn" is precisely an
  unexpected-jump failure) — or `winGravity: Unmap` them for the gesture.
- **A's alloc-churn reduction is a stability fix as much as a CPU fix**: per-event garbage is
  what turns into GC pauses, and GC pauses are stutter. The acceptance criterion in §8.1 tracks
  bytes/event, not just µs/event.
- **An adjacent lever this research surfaced but that needs no windows: the frame clock taxes
  every discrete input with up to one frame of latency.** Coalescing is right for motion;
  for discrete inputs (click, keypress, wheel) an immediate-flush policy — paint the damage from
  a discrete event as soon as the handler returns instead of waiting for the paced frame — is
  probably the single cheapest perceived-latency win in the whole stack, orthogonal to
  subwindows. Added to §8.1 as item 4b.

---

## 1. Where we are: the single-surface pipeline and what it costs

One ntk `Window` per `<window>`/`<popup>`. All controls are retained JS nodes painted through one
2d context whose XRender Picture targets the window's **backing pixmap**
(`ntk/lib/renderingcontext_2d.js:198-218`); ntk presents by `CopyArea(backing → window)` per dirty
rect and serves real server Expose from the pixmap with zero JS when the backing is valid
(`ntk/lib/window.js:652-658`).

### 1.1 Events

`EventManager.attach()` subscribes mousedown/up/move/out + keys + focus **unconditionally**
([events.js:84](../../src/events.js)), so every window selects `PointerMotion` over its whole area
whether or not anything wants hover. ntk coalesces motion keep-last per paced 16 ms frame, so the
expensive work runs at frame rate, not device rate. Per motion frame:
`hitTest` ([nodes.js:1118](../../src/nodes.js)) does a front-to-back recursive descent calling
`paintOrder()` — three array allocations, a per-child wrapper object, and a sort — _at every
visited node_, and only prunes a
subtree when the point is outside **and** the node clips ([nodes.js:1127](../../src/nodes.js));
non-clipping rows recurse into all children regardless. Then the hover path is diffed, `_path` is
computed twice (hover + dispatch), and `:hover` flips invalidate.

**Measured (in-process server, real renderer, 800×600 window, R×C grid of hover-styled boxes):**

| controls | `_onMouseMove`, no hover change | alternating cells (hover flip) | garbage/event |
| -------- | ------------------------------- | ------------------------------ | ------------- |
| 100      | 3.3 µs                          | 4.4 µs                         | ~2–6 KB       |
| 1000     | 27.3 µs                         | 29.0 µs                        | ~8–11 KB      |
| 5000     | 132 µs                          | 135 µs                         | ~120 KB       |

~94% of every motion event is the hit test; the hover diff machinery itself is ~1.7 µs. Scaling is
linear in N (~27–55 ns/control/event). Worst case is the **top-left** control, not bottom-right:
`hitTest` scans paint order back-to-front (front-to-back in z), so the first-painted control is
tested last — 57 µs at 1000. Every event also allocates a closure-laden synthetic event object.

### 1.2 Damage and paint

Damage is a capped list of ≤4 disjoint rects at the window root with least-waste merging
([nodes.js:192-320](../../src/nodes.js)). A hover-flip frame produces one coalesced ~65×16 rect and
31 ctx calls — the damage _narrowing_ works well. The cost that remains is the walk that exploits
it: culling tests each candidate child via `_subtreeBounds()`, which is recursive and deliberately
uncached, so repainting a 65×16 rect at 1000 controls made **2158 recursive `_subtreeBounds`
calls**. Measured hover-flip frame: ~69 µs flush, split ≈ 55% cull walk / 30% request emission /
15% bookkeeping; a full-window repaint for comparison is ~1 ms. End-to-end hover flip
(event + frame) ≈ **105–130 µs of main-thread JS at 1000 controls** — fine at 60 Hz, but all of it
is O(N) walks that don't shrink when the damage does.

Two ntk-side notes that surfaced: (a) each damage pass's first `ctx.clip()` rasterizes a
**full-surface** a8 clip mask (`renderingcontext_2d.js:992-1005`) — an O(window-area) server cost
even for a 20×20 rect; (b) `'draw'` with invalid backing is always full-window — expose-rect
granularity exists only when the backing is valid.

### 1.3 Layout

One `needsLayout` boolean per window; a layout frame runs yoga (`yoga-layout@3.2.1` **wasm**,
shared with ntk) once at the root, then an O(N) `absolutize` walk — 4 embind crossings per node —
regardless of what changed. **Every wheel notch is `invalidate(true, …, 'scroll')` — a full-tree
relayout + absolutize per notch** ([nodes.js:1839](../../src/nodes.js)), because scroll offset is
baked into `abs` during absolutize. The scroll-blit fast path then tries to narrow the repaint,
behind ~12 gates and a per-frame O(N) `_scrollBlitSafe` walk — and is currently **inert at
runtime** (installed ntk 4.2.0 has no `scrollRegion`; the chain ntk#139 → release → #137/#139 is
still in flight).

### 1.4 Wire (protocol bench, in-process server, counted with the repo's own `xcount.js`)

| scenario                                            | requests                | bytes out                | Composite px                                 |
| --------------------------------------------------- | ----------------------- | ------------------------ | -------------------------------------------- |
| mount 1000-control grid                             | 1038                    | 36.8 KB                  | 640 K                                        |
| hover flip to adjacent control (today)              | ~14 net                 | ~400 B                   | 2.6 K                                        |
| 8 motion samples inside one cell (steady hover tax) | 0                       | 0                        | 0 — but 32 B _in_ + 1 JS hit test per sample |
| create+map 1000 child X windows                     | 2002                    | 52 KB                    | 0                                            |
| move one child (ConfigureWindow)                    | 1                       | 20 B                     | 0                                            |
| move all 1000 (ntk as-is)                           | 2002 + **1001 replies** | 24 KB                    | 0                                            |
| move all 1000 (`frameSync:false`)                   | 1002                    | 20 KB                    | 0                                            |
| windowed hover: crossing a child boundary           | **0**                   | 0 (64 B in: Leave+Enter) | 0                                            |

The `move all 1000` row exposes an ntk design cost: each ntk `Window` has its own frame clock and
arms a `GetInputFocus` fence when its ConfigureNotify arrives — a 1000-child move storm doubles
request count and adds 1000 replies. Any windowed-region design must share one frame clock per
top-level (or create children `frameSync:false, coalesceEvents:false`).

### 1.5 What already exists

Four kinds of real X windows already work: nested `<window>` (prop-driven geometry, stacking
synced via `_restackWindowChildren` with server-verified QueryTree tests), `<popup>`
(override-redirect, focus-delegating), `<glarea>` (the **only layout-driven child window** —
`absolutize → _syncGeometry` diffs the rounded rect and issues one setState; clipping vs
scrollviews unsolved, stacking vs `<window>` siblings deliberately undefined), and foreign windows
(the WM example adopts other clients' windows). `NEXT_STEPS.md` §4 already states the policy this
document mostly re-confirms: a real window **only when the server gives something the drawn path
cannot** — "never because it has event handlers or a background color."

The isWindow boundary is already carved through every subsystem (yoga membership, absolutize,
`_subtreeBounds`, `_setRoot`, `paintOrder`, blit safety) — a "windowed region" is a drawn subtree
given the WindowNode treatment. The genuinely missing piece is small: a yoga node that stays in
the **parent's** layout tree whose computed rect is pushed to the child window as ConfigureWindow
(glarea's `_syncGeometry` generalized), plus a paint root that isn't a full WindowNode
(no WM hints, shared frame clock).

---

## 2. What the server actually offers (spec-verified)

All claims below were verified verbatim against the X11R7.7 protocol spec (section names cited
in the research notes; spec source URLs in §11).

**Event routing.** The server hit-tests: pointer events originate at the deepest containing window
and propagate **up** to the first window selecting the type; `do_not_propagate_mask` blocks
per-type. There is no capture phase — React capture stays client-side. The **`child` field** of
every delivered pointer event names the immediate child containing the pointer even when _no_
child selects anything: with one flat layer of region windows this is a free server-side hit test
one level deep, delivered on the events we already get. node-x11 parses it; ntk and react-x11
currently discard it.

**Enter/Leave.** Delivered only to windows selecting them, never propagated, never compressed.
Sibling→sibling crossing = exactly 2 events (Nonlinear pair), nothing on the parent; nested
crossings add Virtual events on strictly-intermediate windows. The `detail` field
(Ancestor/Inferior/Virtual/Nonlinear…) natively encodes the DOM mouseout-vs-mouseleave
distinction react-x11 synthesizes by path-diffing; `mode` distinguishes real crossings from
Grab/Ungrab pseudo-crossings. Thin siblings skipped between pointer samples generate no events —
crossings are computed between successive positions, not along the geometric path.

**Implicit grab.** ButtonPress starts an automatic grab: all drag motion and the release deliver
to the press's event window (negative coords when outside) until buttons release. This reproduces
DOM implicit pointer capture _and_ "hover stays put during drag" server-side — react-x11 already
silently relies on it at the whole-window level (`_pressOutside`, scrollbar drags).

**InputOnly windows.** Depth 0, border 0, only win-gravity/event-mask/do-not-propagate/
override-redirect/cursor attributes (anything else is BadMatch). Invisible to all rendering:
never Expose, never occlude output, cannot be drawables. They own the pointer where they cover:
local event masks, per-region cursors, server-side Enter/Leave — with **zero** paint-model
consequences. Gotcha: they occlude _input_ from siblings beneath them; overlap must mirror hit
priority in stacking order, and non-rectangular hit areas need SHAPE input regions instead.

**Gravity.** `winGravity` repositions children on parent resize by the 8 compass deltas (+Static,
+Unmap which auto-unmaps for "client will relayout anyway"); `bitGravity` retains window bits.
`winGravity` was live-probed and works on both XQuartz and Xvfb — quartz-wm's own growbox is a
SouthEastGravity child and its title-bar prelight is an InputOnly tracking window, so it is
exercised daily on our platform. `bitGravity` is implemented in Xorg's mi layer
(source-verified, `miSlideAndSizeWindow`) but was **not** probed on XQuartz's rootless resize
path. Gravity moves, never resizes; servers may legally ignore bitGravity.

**Scroll-by-move.** "If … a window is moved … the contents of the window are not lost but move
with the window" — the server blits, and Expose covers only newly-valid regions. This is the
protocol-guaranteed version of scroll-blit. Coordinate limits: positions are INT16 (±32767);
sizes are CARD16 (≤65535 on the wire) but effectively bounded by the 16-bit coordinate/region
space — treat ±32767 as the safe envelope for any window geometry.

**Backing store.** Advisory in the spec; in practice a **majority-target capability**. Modern
Xorg (≥1.15) implements it via per-window Composite automatic redirection — a full window-sized
server pixmap each — and any Composite-capable server advertises `WhenMapped` (verified live: a
`WhenMapped` child on Xvfb survived occlude-then-reveal with zero Expose). Since most expected
users run Xorg+compositor or XWayland, **server-side content preservation for opted-in region
windows is available on the deployment majority**, feature-detectable for free from the
connection setup's per-screen `backing-stores` field. The exception is XQuartz — this dev
machine — which ships without Composite: no core backing store at all (probe confirmed: the same
`WhenMapped` child Exposed on reveal), and its rootless frame buffer covers _toplevel_ occlusion
only. `save-under` is hardwired dead everywhere. Design consequence: treat server backing store
as a **feature-detected acceleration tier** — on Composite servers it can carry a region's
content preservation outright (and should _replace_, not double, ntk's backing pixmap for that
window, since both cost the same window-sized pixmap); ntk's own backing pixmap remains the
portable fallback that keeps XQuartz correct. Don't sprinkle it on small controls (a hidden
pixmap + Damage record per window); use it at region granularity.

**Translucency — the hard rendering limit.** Core X is a pixel-ownership model: a child window
_replaces_ parent pixels where mapped; there is no core operation blending child over parent. An
ARGB child overwrites rather than blends even under a compositor (compositors redirect and blend
**top-level hierarchies only**; children are flattened inside by core clipping). The only route is
Composite manual redirection + client-side Render — i.e. rebuilding by hand the compositing the
single drawn surface gives for free (available on the Composite majority, impossible on XQuartz —
so even as an advanced option it cannot be relied on universally). SHAPE gives non-rectangular
boundaries but binary/aliased ones. **Opaque + rectangular is the promotion boundary**; shadows, rounded corners, translucent
overlays, cross-fades disqualify a subtree.

**Costs.** CreateWindow 32+4n B, ConfigureWindow 12+4n B (move = 20 B), Map/Unmap/Destroy 8 B,
all round-trip-free; DestroyWindow is recursive (one 8-byte request tears down a subtree,
measured 20 000 windows in 3.9 ms). XIDs: 29-bit space, 2 097 152 per client at Xorg defaults
(protocol floor: 2^18). **node-x11's `AllocID` has an explicit unhandled-overflow TODO and ntk
never releases window IDs** (it does for pixmaps/pictures/glyphsets and cursor GCs; the 2d
context's GC and the present/clear GCs also never release) — harmless today, a real leak under
window churn; the XC-MISC binding already exists in node-x11, just unwired.

---

## 3. Server reality on our targets (measured)

**Target weighting.** Most expected users run Linux Xorg (with a compositor) or XWayland —
Composite present, backing store available, standard DDX paths. XQuartz is where development
happens but is a **minority deployment**: a custom rootless server without Composite, ~2× the
dix cost floor on window storms, and its own bug surface. Read the numbers below accordingly:
the Xvfb column approximates what the majority sees (a stock-Xorg dix floor); the XQuartz column
is the compatibility floor the design must not break, **not** the environment to optimize for.

### 3.1 Per-window server cost — a non-issue

| measure                                                       | value                                                              | source                                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| heap per plain window (Xorg 21.1.23, exact malloc accounting) | **293 B** (256 B WindowRec+privates + 32 B resource + hash growth) | heap-tool diff, 20 000 windows                                                                                                       |
| with WindowOptRec (cursor/backing/shape/…)                    | +96 B exact                                                        | same                                                                                                                                 |
| RSS per unmapped window, live XQuartz                         | ~250–460 B                                                         | two independent runs disagree 1.8× (10k- and 20k-window deltas); macOS RSS is compression-noisy — heap figure above is authoritative |
| RSS per mapped window, XQuartz                                | ~1.3 KB                                                            | 5000-window delta (clip data included)                                                                                               |
| clip fragmentation from 10 000 randomly overlapping siblings  | ~3.7 B/window                                                      | 1-box/empty regions stored inline; fully-obscured = empty clip                                                                       |

Even 20 000 windowed regions ≈ 5–25 MB server-side. Memory never binds; CPU does:

### 3.2 The algorithmic costs — where window-per-control dies

| operation                                                              | XQuartz                                    | Xvfb (Xorg dix floor)                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| CreateWindow, batched                                                  | ~2–7 µs/win                                | ~1–4 µs/win                                                                                |
| MapWindow storm, 1000 / 5000 mapped children                           | 12–37 µs/win / **91 µs/win (455 ms)**      | 10 µs / 42 µs/win                                                                          |
| ConfigureWindow move, mapped, 1000 / 5000 siblings                     | 21–53 µs/op / **131 µs/op (654 ms total)** | 15–18 µs / 68 µs/op                                                                        |
| same, unmapped (control)                                               | ~4 µs/op                                   | —                                                                                          |
| raise 1 of 5000 siblings                                               | 1.3 ms                                     | 0.09 ms                                                                                    |
| map / move **one** window among N mapped siblings                      | —                                          | 0.13–0.22 ms @1k → 1.0–1.4 ms @20k (O(N))                                                  |
| server event pick (miSpriteTrace), flat worst case                     | —                                          | **1.5 µs @100 → 60 µs @20k motions (~3 ns per mapped sibling, ≈6 ns per sibling scanned)** |
| scroll = move **one** container child (1000 grandchild windows riding) | 4.9 ms/frame                               | 0.27 ms/frame                                                                              |
| parent toplevel resize                                                 | **14–20 ms regardless of children**        | 0.14–0.46 ms                                                                               |
| destroy 10–20k subtree (one request)                                   | 4–8 ms                                     | 3.9 ms                                                                                     |

Readings: clip revalidation (`miValidateTree`) is O(mapped siblings) per configure/map and the
storms are superlinear; XQuartz is ~2× the dix floor and its rootless toplevel-resize path is its
fragile spot (multiple crash bugs filed). Server-side _picking_ is effectively free and
hierarchy-aware. InputOnly children: 1000 created in ~2 ms on XQuartz, zero errors — and XQuartz's
own WM depends on them.

**The 4.9 ms scroll row needs care:** that pane carried 1000 windowed grandchildren — the
anti-pattern — plus a full XSync round trip per frame; how much of the 4.9 ms is per-child clip
work vs pane-area blit was **not isolated** (a §10 follow-up; miComputeClips also has a VTMove
translate-only fast path, so "revalidated 1000 clips" is not established). A content pane with
_drawn_ rows should be one window move — expected µs-scale by extrapolation from the small-window
move rows, but **not yet measured for a large pane**; measure pane-area scaling before committing
(§10). The design rule stands: **windowed viewport + windowed content pane + drawn rows.**

### 3.3 Compositor interaction

On Xorg+compositor and XWayland, child windows never reach the compositor — redirection captures
whole toplevel hierarchies (children are flattened into the toplevel's pixmap server-side). On
XQuartz likewise only toplevels get Quartz frames. So windowed regions cost the native window
system nothing anywhere; their price is X-server clip CPU. Also verified: XWayland creates
`wl_surface`s only for InputOutput children of root; and GLX **into child windows** is XQuartz's
historically buggiest path (Wine crashes, Mesa fix in 2.7.4) — relevant to `<glarea>`, which sits
exactly there. One majority-target upside worth naming: XWayland and composited Xorg are
standard xserver builds, so the Composite-based backing store verified on Xvfb is expected to
work there too (dix-level machinery; XWayland itself unprobed — §10).

---

## 4. What 30 years of toolkits concluded

- **Xt/Motif**: window-per-widget → per-widget ConfigureWindow storms on every relayout (layout
  was client-side anyway), clear-then-expose flicker. Motif's windowless _gadgets_ are the
  cautionary inverse: the manager selected **all** events including MotionNotify and hit-tested
  client-side — exactly react-x11's current shape — and by X11R5 "gadgets are worse than widgets
  … from a performance perspective." The balance is empirical and era-dependent; Motif got it
  wrong in both directions.
- **GTK 2.18 client-side windows (2009)**: kept the entire GdkWindow API — per-region event
  masks, enter/leave, grabs, scroll-copy — as a _client-side abstraction_; the real window carries
  the union of descendant interests. What broke was almost entirely native-handle consumers
  (plus expose-handler timing assumptions and a long-broken win32 backend).
  Larsson's flicker post is the canonical description of the scroll-copy tearing hazard the
  scroll-blit branch handles. Original driver: offscreen rendering/transforms, which per-widget X
  windows pin to the screen.
- **GTK4 (2020)**: no subwindows at all, even client-side. One GdkSurface per toplevel/popup;
  cached per-widget render nodes; frame clock; pure client-side picking with synthesized
  crossings. GTK4's considered answer to hover-on-1-of-1000 is "hit-test every motion
  client-side, make picking cheap."
- **Qt 4.4 alien widgets (2008)**: native-off by default; multi-granularity opt-in
  (env var / app / `WA_NativeWindow` / **implicit promotion on `winId()`** — asking for the handle
  _is_ the opt-in). Native promotion is viral to ancestors (clipping/stacking need it) unless
  explicitly stopped — a real API-design cost to remember. Where native reenters
  (`createWindowContainer`), the docs read like our glarea caveats: "stacks on top … as an opaque
  box," undefined stacking among containers.
- **AWT/Swing**: the mixing/"airspace" problem — heavyweights always above lightweights,
  punching through menus and tooltips; took Sun 15 years to paper over via window shaping.
  Structurally identical to `<glarea>` today.
- **Browsers/Flutter**: layers, not windows. Promotion criterion that survived: **different
  update cadence, moves-without-repaint, or foreign content** — never "is interactive." Both
  explicit hints (`will-change`, `RepaintBoundary`) and automatic triggers exist, with squashing
  as the defense against layer explosion; Flutter auto-inserts boundaries around scrolling list
  children. Flutter is the existence proof that event routing needs no windows at any scale.

**No toolkit that left window-per-widget ever went back.** And none ever adopted InputOnly
hit-region children for controls — that path is unexplored, not discredited.

---

## 5. The five concern axes

### 5.1 Local event masks

**Concern:** one hover-sensitive control in a 1000-control window forces PointerMotion on the
whole window and a hit test per motion.

**True today,** but decompose the cost:

- _Wire:_ 32 B/motion sample in, zero out (H1b). At 125–1000 Hz device rate, coalesced to frame
  rate by ntk. Negligible locally; matters over SSH-forwarded X.
- _CPU:_ ~27 µs + 8–11 KB garbage per motion frame at 1000 controls — all in `hitTest`/`paintOrder`
  churn. This is a **client-side data-structure problem**: `paintOrder()` re-allocates and
  re-sorts per node per event; non-clipping containers don't prune; `_path` runs twice.
  A cached paint-order array (invalidated on child-list/zIndex change), point-in-subtree-bounds
  pruning (using bounds cached during `absolutize`), and a reused event object would cut this
  10–50× with zero protocol change. GTK3's union-mask + client routing and GTK4/Flutter picking
  are precedents that this is enough at any realistic scale.
- _What subwindows add on top:_ zero motion traffic at the server (mask off PointerMotion
  entirely unless someone has `onMouseMove`), Enter/Leave computed by the server at ~6 ns/sibling,
  the free one-level `child` field even without any child selecting events, per-region cursors as
  a creation attribute, correct hover when content moves _under_ a stationary pointer (scroll —
  the client model gets this stale today), and implicit-grab press/drag/release per control.

**Also true:** ntk's per-region event-mask machinery (lazy mask growth from listeners) already
exists and react-x11 defeats it by subscribing everything unconditionally
([events.js:84](../../src/events.js)). Handler-counted lazy subscription (the r3f rule `<glarea>`
already implements one level up) would drop `PointerMotion` from windows with no motion/hover
consumers at all — the cheapest win of the lot.

**Latent bug either way:** `_onMouseOut` clears the entire hover path on _any_ LeaveNotify
without checking `detail`/`mode` ([events.js:384](../../src/events.js)). Today every trigger —
pointer leaving the toplevel (the common case), crossings into `<glarea>`/nested `<window>`
children, Grab/Ungrab pseudo-crossings from popup grabs — happens to clear hover acceptably;
the first windowed region would break hover globally. Any subwindow work starts by making
crossing handling detail/mode-aware.

**Verdict:** fix client-side first; subwindow event masks are not the remedy for the CPU concern.
InputOnly regions (§8, option D) are the right vehicle _if_ the wire/cursor/scroll-hover benefits
are wanted, because they carry none of the rendering costs.

### 5.2 Damage area calculation

Damage narrowing already works (one coalesced rect, 31 ctx calls for a hover flip). What
subwindows would scope is the _walk_: per-region damage lists mean a region's invalidate touches
only its subtree, and the 4-rect cap stops being shared across unrelated corners of the UI. But
the same effect is available client-side by caching `_subtreeBounds` during `absolutize` (the
"recomputed on demand" design assumption — bounds asked only by the handful of invalidating nodes
— is falsified by measurement: 2158 recursive calls per 65×16 repaint, 55% of frame time).

What subwindows do **not** fix: the parent paints into a _pixmap_, and pixmaps have no children —
X's child-clipping applies only at the final CopyArea, so parent rasterization under windowed
children still happens unless the client culls it (today's `_outsideDamage`, retargeted at region
rects). A per-region window also brings per-region present (CopyArea) and — critical on the ntk
side — a per-Window frame clock and fence with **no cross-window frame transaction**: two regions
presenting independently can tear against each other. One ntk frame clock per toplevel is a
prerequisite (§9).

**Verdict:** cache subtree bounds client-side; per-region damage is a real but secondary benefit
that falls out of any region window added for other reasons (scroll), not a reason by itself.

### 5.3 Backing store invalidation

ntk already double-buffers per window and serves Expose from backing with no JS. Windowed regions
would each carry a backing pixmap — that is the memory axis: viewport-sized today vs
region-extent-sized after promotion. A 900×90 000 content pane is absurd (324 MB) regardless of
who holds the pixmap; the design must band the backing, opt the pane out (`backingStore:false` +
JS repaint of exposed strips), or size the pane viewport+overdraw and re-anchor.

**Who holds the pixmap is a per-server choice, and the majority target has the better option.**
On Composite servers (most users: Xorg+compositor, XWayland), setting `backing-store: WhenMapped`
on the content pane makes the _server_ retain the pane's clipped-away band — so scroll-by-move
generates **no Expose at all**: the server blits the surviving band and restores the revealed
strip from its own backing (this is exactly the behavior the in-process JS server showed as the
subwindow best case, and it is real on the majority target — occlude/reveal probe passed on
Xvfb). ntk's backing pixmap for that window then becomes redundant and should be dropped
(`backingStore:false`), or memory doubles for no benefit. On XQuartz (minority; no Composite)
the same window falls back to ntk's pixmap with Expose-strip repaints served from it. Both modes
cost one window-sized pixmap; the difference is which side owns it and whether scroll exposes
reach the client at all. Feature-detect via the screen's `backing-stores` field. Either way,
don't put backing store on small controls — on Xorg each opted-in window is a hidden full-window
redirect pixmap plus a Damage record.

There is also a fix available with no windows at all — but it starts in ntk, not react-x11: ntk
4.2.0 collapses every invalid-backing restore to a full-window synthetic `'draw'` (no rects reach
the renderer at all). Delivering the coalesced expose-rect union (§9.7) plus a react-x11 consumer
would restore partial granularity without any windows.

### 5.4 Layout engine cache

The key structural fact (verified in code): **a region's inner layout depends only on its
width/height, never its position** — position enters solely as the absolutize origin, and a
WindowNode lays out from `{0,0,w,h}`. So for a size-stable region, a parent-driven move is
exactly one ConfigureWindow with zero inner relayout and zero repaint (the backing rides along).
`_sizePinned` + the `_reflowed` contained-reflow machinery are the embryo of this boundary; a
windowed region is `_sizePinned` made real, enforced by the server instead of damage arithmetic.

The scrollview is where this bites hardest today: scroll offset baked into `abs` makes every
wheel notch a full-tree relayout + absolutize (~4 embind crossings × N per notch). A windowed
scrollview deletes that: scroll stops touching layout at all. Short of windows, the same cheap
observation — "scroll is a translation, not a reflow" — could be exploited client-side by storing
scroll offset as a paint/hit-test-time translation instead of re-absolutizing, at the cost of
threading an offset through paint and hitTest (a mini transform stack — the thing the flat `abs`
design deliberately avoids). That refactor is the client-side alternative to compare against.

When a parent resize _does_ change a region's size: two frames of latency (parent pass →
ConfigureWindow → child relayout) unless the inner pass runs synchronously in the same flush —
resize asynchrony between parent and children is literally GTK's stated top reason for leaving
subwindows ("asynchronously resize all child windows and sometimes get partial results drawn").
Regions should be size-stable or few.

### 5.5 Server-supported layout (gravity etc.)

Works (both servers, quartz-wm depends on it), already forwardable through ntk creation
attributes from JSX props, and nearly useless _as a layout engine_ for yoga: it expresses
corner/edge pinning of fixed-size children only — no stretch, no flex, no percentages, no
space-between; and yoga's default cross-axis is `stretch`. Its honest use is latency-masking
anchored panes during interactive resize (child snaps with the edge server-side, one frame
before the client's authoritative ConfigureWindow), plus `winGravity: Unmap` to suppress
stale-position jumps when relayout is coming anyway. **Under the project's goal hierarchy that
is not a dismissal — "latency mask" is the main goal during a resize gesture** (§0.1): resize is
continuous direct manipulation, the client is structurally one frame late, and the server moving
anchored windows instantly is "update instantly, catch up" in its purest form. It applies only
to windows that already exist for other reasons (a windowed scrollview's panes and bars, capability
windows) and only to gravity-expressible positions — so it is a free rider on B, never a reason
to create windows. ntk gap: gravity is creation-time only (no ChangeWindowAttributes path
exposed; §9.10).

---

## 6. When a windowed region pays — ranked

| candidate                                                                                            | why                                                                                                                                                                                                                              | verdict                                                                                     |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Scrollview (viewport + content pane)**                                                             | server-side blit + strip expose deletes the whole scroll-blit gate stack, the O(N) safety walk, per-notch relayout; drawn rows ride along free; zero-Expose scroll with server backing store on Composite targets (the majority) | **the** case — prototype behind a flag (§8 B)                                               |
| **`<glarea>` / video / foreign embed**                                                               | server capability the drawn path cannot express                                                                                                                                                                                  | already exists; keep implicit-by-capability                                                 |
| **`<popup>` / nested `<window>`**                                                                    | WM interaction, bounds escape                                                                                                                                                                                                    | already exists                                                                              |
| InputOnly hit regions (cursor, hover-during-scroll, remote-X wire, drag semantics)                   | zero rendering cost; all event-locality wins                                                                                                                                                                                     | optional spike (§8 D) — no toolkit precedent either way                                     |
| Large opaque panes with independent update cadence (dashboard tiles, terminal grid, animation layer) | per-region damage + present isolation                                                                                                                                                                                            | only after frame-clock sharing exists in ntk; measure first — client-side fixes may suffice |
| Hover-dense control grids                                                                            | the motivating concern                                                                                                                                                                                                           | **no** — fix the client-side hit test (§5.1)                                                |
| Table/list rows                                                                                      | GTK's treeview-window-per-row is the canonical regret                                                                                                                                                                            | **no**                                                                                      |
| Anything translucent, shadowed, rounded-antialiased, transform-animated                              | core X cannot blend child over parent                                                                                                                                                                                            | **structurally excluded**                                                                   |

---

## 7. What breaks — the hazards checklist

Every item below is verified (code, spec, or measured), not speculative:

1. **Airspace**: a windowed region is always above all drawn content of its parent; drawn
   tooltips/menus/overlays cannot paint over it. Mitigation: overlays are already `<popup>`s in
   react-x11 — the airspace rule aligns with existing practice, but must be documented per region.
2. **Translucency/rounding**: opaque rectangles only (§2). Antialiased rounded corners against
   the parent are impossible (SHAPE is binary).
3. **Hover detail/mode blindness**: `_onMouseOut` clears all hover on any LeaveNotify —
   pre-existing bug, first windowed region trips it ([events.js:384](../../src/events.js)).
4. **ntk InputOnly BadMatch**: ntk unconditionally puts `bitGravity: 1` in every CreateWindow
   value list (`ntk/lib/window.js:375-381`) — illegal for InputOnly; needs an ntk guard (plus a
   `getContext` guard).
5. **Per-window frame clocks** (a _stability_ requirement under §0.1, not just perf — two
   regions presenting independently in one gesture is visible tearing): N regions = N
   fences/timers, ordering inversions possible
   (move(A) → press(B) can invert since coalescing is per-window), storms double request counts.
   Needs a shared per-toplevel frame clock in ntk.
6. **XID leak**: ntk never releases window IDs; node-x11 AllocID overflow is an unhandled TODO.
   One-line ntk fix + optionally wire the existing xc-misc binding.
7. **16-bit geometry**: positions INT16 (±32767), sizes CARD16 — treat ±32767 as the envelope;
   content panes for long lists must re-anchor;
   glarea already has this bug latent (no clamp/unmap when scrolled far out — no guard exists).
8. **First-paint flash**: `attributes.backgroundColor` is dead in ntk 4.2.0 (no consumer);
   region windows should set `backgroundPixel` (or background None to inherit stale pixels
   rather than flash — the GTK2 anti-flicker rule).
9. **Resize asynchrony**: parent-size-tracking regions repaint one frame late (GTK's #1 reason
   for leaving). Keep regions size-stable; consider `winGravity: Unmap` for the rest.
10. **XQuartz specifics** (minority target, but the dev machine — compatibility floor, not
    design driver): no Composite → no server backing store for regions; child-GLX is the
    historically buggy path; toplevel resize is expensive and crash-prone; XTEST off by default
    (blocks input-injection tests on macOS — integration tests should target Xvfb/the JS server).
11. **Stacking bookkeeping**: regions must join `_restackWindowChildren`-style ordering
    (including vs `<glarea>`, whose stacking is currently undefined), and scrollview clipping of
    a windowed region needs the server parent-child relationship to be the clip (viewport window),
    not `overflow: hidden` arithmetic.
12. **Coordinate-space audit**: `_pressOutside`, popup anchoring (`_screenOrigin` composition),
    DevTools `getClientRects`, ClickToComponent — everything reading `abs` as window-absolute
    needs the extra origin composed when a region boundary intervenes.
13. **Cross-boundary bubbling and focus**: today capture/bubble stops dead at every window
    boundary (`_path` breaks at the owning window, [events.js:130](../../src/events.js)) and
    `_focusables` refuses to walk into `isWindow` children ([events.js:567](../../src/events.js)) —
    a windowed scrollview needs row clicks to bubble to ancestors outside the region and Tab to
    traverse into it. The existing precedents are popup-style `focusManager` delegation and the
    key path's tree-walking dispatch; both must be generalized to pointer events (with
    child-local → owner coordinate translation) before any region ships.

---

## 8. API design: the manual → automatic spectrum

Ordered from least to most automatic, with verdicts:

**A. Client-side fixes only (no new API).** Cache `paintOrder`; cache subtree bounds in
`absolutize`; prune hit test by cached bounds; single `_path` per event; reused event objects;
handler-counted lazy event masks (stop selecting PointerMotion when nothing consumes it); use the
free `child` field once regions exist; expose-rect granularity from ntk instead of full-window.
**Do this regardless.** It attacks every _measured_ cost, needs no ntk release, and no design
risk. Expected effect: motion frame from ~27 µs to low-µs; hover-flip flush from ~69 µs to ~30 µs.

**B. Framework-internal promotion at known hotspots (invisible API).** The scrollview becomes
`viewport window + content pane window + drawn rows` internally, feature-gated
(`REACT_X11_WINDOWED_SCROLL=1` during bring-up, later a scrollview prop, eventually default where
safe). No user-facing "window" concept; identical JSX. This is Flutter's
`addRepaintBoundaries`-around-scrollables move, and it lands on the only region with a measured
structural win. Framed by the goals (§0.1): scroll is the most latency-sensitive gesture in the
toolkit, and this makes its screen response synchronous with the input event (ConfigureWindow
written in the wheel handler, before React) instead of one relayout + one paced frame later —
with idle time spent prepainting the overdraw band so revealed content is already backed.
On the deployment majority (Composite servers) it has a second tier for free:
give the content pane `backing-store: WhenMapped` (feature-detected from the screen's
`backing-stores` field, ntk backing dropped for that window) and scrolling stops generating
Expose entirely — the server owns both the blit and the strip restore; XQuartz falls back to
strip repaints from ntk's pixmap. Bring-up order: needs the ntk frame-clock/backing work (§9),
the detail/mode hover fix, cross-boundary bubbling/focus (§7.13), INT16 re-anchoring, and honest
fallbacks (small viewports and translucent-over-viewport layouts keep the drawn path — the
scroll-blit gates shrink to "is this scrollview windowed or not").

Two things to say out loud about B. First, **it reverses a recorded decision**: NEXT_STEPS §4
states verbatim that a scrollview is "a clip rect + translation on the render list, not a child
window (optionally optimized later with CopyArea scrolling inside the same window)" — the
CopyArea option being exactly the scroll-blit branch B would supersede. This document argues the
reversal on new measured evidence (server-side blit verified on both targets, per-notch relayout
cost, the gate stack); if B lands, amend NEXT_STEPS §4. Second, **the hermetic test suite cannot
exercise B's core mechanism**: the in-process JS server gives every window a retained raster, so
child moves generate no Expose there — the expose-strip half of the design is invisible to it,
XTEST is absent on this XQuartz, and there is currently zero test coverage for events/focus
inside nested windows. B's test plan is Xvfb-based integration tests (the only full-fidelity
target on this machine) plus extending the JS server with real expose-on-move semantics.

**C. Explicit region element for capability, not performance.** Keep real windows where the
server gives capability: `<glarea>` (exists), `<foreign windowId>` (NEXT_STEPS §4), possibly
`<surface>` for an opaque pane an app _knows_ updates independently — with documented constraints
(opaque, rectangular, above drawn siblings, clipped only by its parent window). Follow Qt's
implicit-promotion insight: asking for the native handle (a ref that needs an XID) _is_ the
opt-in signal. **Do not ship `<box windowed>` as a general perf knob** — the constraint list is
exactly the airspace/translucency/stacking catalogue every toolkit documents as its regret.

**D. InputOnly hit-region spike (orthogonal, optional).** A `hitWindow` internal experiment:
InputOnly children mirroring a few interactive regions, selecting Enter/Leave/Button, drawn tree
untouched. Buys per-region cursors as server attributes, hover-during-scroll correctness,
implicit-grab drag semantics per control, zero motion wire, `do_not_propagate` shielding — at the
price of ConfigureWindow-per-layout for those regions, XID lifecycle, and the detail/mode fix.
No rendering hazards at all. The perceived-performance lens (§0.1) adds one argument the CPU
lens missed: **a per-window cursor is applied by the server the instant the pointer crosses,
with the client not in the loop at all** — cursor feedback (I-beam over text, resize arrows on a
split handle) stays instant even while the client is mid-render or mid-GC, where today it rides
the motion→hover→`setCursor` path and stalls with the client. Worth a spike _after_ A if cursor
fidelity, hover-during-scroll, or remote-X matter; the CPU argument alone still does not
justify it.

**E. Fully automatic promotion (browser-style heuristics).** Rejected. Requires squashing
heuristics, memory-pressure valves, and years of tuning; the failure modes (layer explosion) are
documented at length by Chromium; and our candidate list (§6) is short enough that named hotspots
cover it. History: only browsers ever made this work, and nothing at react-x11's scale should try.

**Recommended sequence: A → B(prototype + measure) → C(as capabilities demand) → D(spike if
motivated) — E never.**

### 8.1 Concrete action plan (issue-ready)

Every item below is adoptable as code, API, or documentation without further research. Ordered by
dependency; acceptance criteria reference the benchmarks preserved out-of-tree (§10). Items are
phrased so they can be lifted directly into issue drafts (react-x11 / ntk / node-x11 as marked).

**Phase 0 — record the decisions (docs).**

- **[react-x11 docs]** Add a "when does an element get a real X window" section to
  `docs/elements.md`: the promotion policy (opaque + rectangular + region granularity; real
  windows for capability, never for "has handlers or a background"), the airspace constraints
  (currently documented only in `docs/glx.md`), and the hazard list from §7. This makes the
  policy user-visible instead of implicit in NEXT_STEPS.
- **[react-x11 docs]** Annotate NEXT_STEPS §4's scrollview sentence with a pointer to this
  document: the "clip rect + translation" decision is now conditional on the Phase-3 prototype's
  results, and should be amended (not silently contradicted) if B lands.

**Phase 1 — client-side fixes, no ntk dependency (react-x11 code).**

1. **fix(events): respect crossing `detail`/`mode`** in `_onMouseOut`/hover handling
   ([events.js:384](../../src/events.js)) — drop Grab/Ungrab pseudo-crossings, treat
   `detail=Inferior` as "still inside". Prerequisite for every windowed anything; arguably a live
   bug for `<glarea>` + popup-grab edge cases now. Test: hover retention across a glarea/nested
   `<window>` crossing.
2. **perf(hit-test): cache and prune** — cache `paintOrder()` per node (invalidate on child-list/
   zIndex change), cache subtree bounds during `absolutize` (drop the per-call `_subtreeBounds`
   recursion), prune `hitTest` descent by cached bounds, build `_path` once per motion, reuse the
   synthetic event object. Acceptance: `hitbench.mjs` motion frame ≤5 µs and ≤1 KB alloc at 1000
   controls (from 27 µs / 8–11 KB); hover-flip flush cull share <20% (from ~55%).
3. **perf(events): handler-counted lazy event masks** — stop subscribing `mousemove`/etc.
   unconditionally in `EventManager.attach()`; select PointerMotion only while some node has a
   motion/hover/cursor consumer (the r3f rule `<glarea>` already applies one level up). Note the
   cursor dependency: `_updateCursor` rides the hover path, so `cursor` props count as consumers.
   Acceptance: a protocol-bench scenario asserting zero MotionNotify delivery for an app with no
   hover/motion/cursor usage.
4. **chore(windows): pass `backgroundPixel` at creation** (forwardable through ntk today) so
   windows stop flashing undefined content before first paint.
   4b. **perf(latency): immediate flush for discrete inputs** — clicks, keypresses, and wheel
   currently paint on the next paced frame (up to 16 ms + fence later); flush their damage as
   soon as the discrete handler returns, keeping coalescing for continuous motion only. No
   windows involved; probably the cheapest perceived-latency win in the stack (§0.1).
   Acceptance: a caret blink / button `:active` flip reaches the wire in the same event-loop
   turn as the input event (assert with the protocol tracer); motion-driven hover still
   coalesces to frame rate.

**Phase 2 — ntk/node-x11 groundwork (file as issues now, accumulate into the next ntk cycle).** 5. **[ntk fix]** Release window XIDs on destroy (pixmaps/pictures/glyphsets already do); note
the 2d-context/present/clear GC ids also leak. **[node-x11 fix]** wire the existing
`xc-misc` GetXIDRange binding into `AllocID` (overflow TODO at `xcore.js:377-389`). 6. **[ntk feat]** Shared frame clock/fence per top-level for child windows (or a supported
`frameSync:false, coalesceEvents:false` child mode) — kills the measured 1000-fence storm
(protobench E vs E2) and the cross-window event-ordering inversion. 7. **[ntk fix]** InputOnly (`windowClass: 2`) support: omit `bitGravity`/background attributes
(BadMatch today), guard `getContext`, skip the StructureNotify base mask for micro-windows. 8. **[ntk feat]** `'draw'` with coalesced expose rects (today invalid-backing restores collapse
to full-window), plus a react-x11 consumer — partial restores without any windows. 9. **[ntk feat]** `serverBackingStore` creation option mapping to the X backing-store attribute
(deliberately not forwarded today, `window.js:112-121`), with feature detection from the
screen's `backing-stores` field — enables the zero-Expose scroll tier on Composite servers. 10. **[ntk feat, optional]** post-create `ChangeWindowAttributes` for winGravity/bitGravity
(TODO at `window.js:975`) — only if gravity latency-masking on anchored panes is pursued.

**Phase 3 — the windowed scrollview prototype (react-x11, flagged, decision gate).** 11. **feat(scrollview): `REACT_X11_WINDOWED_SCROLL=1`** — viewport window + content pane window + drawn rows; pane sized viewport+overdraw with INT16 re-anchoring; scrollbars drawn on the
viewport window; `serverBackingStore` tier on Composite servers, ntk-pixmap + expose-strip
fallback on XQuartz. Two goal-driven behaviors are part of the design, not polish:
**(latency)** the ConfigureWindow is written synchronously in the wheel/drag handler, before
any React or layout work — scroll response never waits on the frame clock or a render;
**(idle prep)** the overdraw band is prepainted during idle, and re-anchoring runs in idle
time with the swap prepared off-screen so no seam is ever visible on the input path.
Depends on items 1, 5–9. Test plan: Xvfb integration tests (the hermetic JS server cannot
see expose-on-move; XTEST is absent on this XQuartz); screenshot parity vs the drawn path.
Acceptance: **(latency)** wheel-to-ConfigureWindow-on-the-wire in the same event-loop turn,
measured with the protocol tracer, vs today's relayout + paced frame; pure-scroll frame
beats the scroll-blit path on the `protocol.js` bench metrics and on Xvfb frame times; zero
Expose per notch with the backing-store tier; **(stability)** no visible re-anchor seam, one
present per frame across viewport+bars (no cross-region tearing), hover changes from
pane-moves-under-pointer debounced to frame rate; no parity regressions. **Decision gate:**
if it wins, promote to a scrollview prop and amend NEXT_STEPS §4; if not, this document's
§5/§3 records why not, and the scroll-blit chain stands.

**Phase 4 — optional, after Phase 3 evidence.** 12. **spike: InputOnly hit regions** (per-region cursors as server attributes, hover-during-
scroll correctness, remote-X wire silence, implicit-grab drags) — sweep script ready in
`windowed-regions-bench/bench1.js`, needs Xvfb+XTest. Adopt only if the measured benefits
show up in a real app scenario. 13. **API decisions to take deliberately, not by drift:** `<surface>` element (explicit opaque
pane) and ref-XID implicit promotion (Qt's `winId()` insight) stay out of the public API
until a concrete capability demands them; `<box windowed>` stays out, period.

---

## 9. Prerequisites in ntk / node-x11 (accumulate into the next ntk cycle)

(The same items appear inside §8.1's phased action plan with their react-x11 counterparts; this
section is the ntk-release shopping list.) Fixes independent of any decision here are marked ✱.

1. ✱ Release window XIDs on destroy (one line); optionally wire `xc-misc` GetXIDRange into
   `AllocID` (binding exists, unwired; overflow TODO at `x11/lib/xcore.js:377-389`).
2. Shared frame clock / fence per top-level for child windows (or a supported
   `frameSync:false, coalesceEvents:false` child mode + parent-side coalescing) — kills the
   1000-fence storm and the cross-window ordering inversion.
3. InputOnly support: omit `bitGravity`/background attrs when `windowClass === 2`; guard
   `getContext`.
4. ✱ Consume or remove the dead `backgroundColor` creation attribute (ntk-side; no consumer in
   4.2.0). `backgroundPixel` itself is _already_ forwarded by ntk — the missing half is
   react-x11 passing a real value at region-window creation so new windows don't flash
   undefined content.
5. `ChangeWindowAttributes` exposure for winGravity/bitGravity post-create (TODO already at
   `window.js:975`) — only if gravity latency-masking is wanted.
6. Banded/opt-out backing pixmap strategy for large content panes (or document
   `backingStore:false` + expose-strip repaint as the supported mode).
7. ✱ Deliver ntk's coalesced expose-rect union to the renderer ('draw' with rects), so partial
   restores stop being full-window repaints.
8. ✱ Ship `scrollRegion` (ntk#139) — the current chain's blit remains the right fallback for
   non-windowed scrollviews.
9. A way to set the X `backing-store` attribute — ntk deliberately does **not** forward it
   (its own `backingStore` creation option means client-side double buffering, and the comment
   at `window.js:112-121` excludes the X attribute to avoid a silent collision). The
   zero-Expose scroll tier on Composite servers (§5.3, §8 B) needs an explicit spelling, e.g.
   `serverBackingStore: 'whenMapped'`, plus feature detection from the screen's
   `backing-stores` field so it degrades cleanly on XQuartz.

`_onMouseOut` detail/mode filtering is a react-x11-side prerequisite for **everything** above
(and is arguably a live bug for `<glarea>` + popup-grab edge cases today).

---

## 10. Measurement appendix

Scripts and raw research notes are preserved out-of-tree in the maintainer's local
`docs-extra/` research area (deliberately uncommitted): `docs-extra/windowed-regions-bench/`
holds the scripts, `docs-extra/windowed-regions-notes/` the eleven per-agent research reports
with full source URLs. The in-process-server scripts need no display; the copies reference
absolute paths from the research session and may need path tweaks to re-run:

- `hitbench/hitbench.mjs` — hit-test/motion/flush microbench (in-process server + real renderer)
- `protobench/protobench.mjs` — protocol-traffic scenarios (repo's `xcount.js` counting)
- `livebench/bench1.js bench2.js bench3.js` — live XQuartz window storms, RSS, InputOnly (node-x11)
- `bench.c bench2.c` — XQuartz-vs-Xvfb C benchmarks (storms are batched with a single trailing
  XSync — same methodology as livebench, which is what makes the merged ranges legitimate;
  XSync-per-op only for raise/resize/pick/scroll frames; gravity/backing probes, scroll-by-move)
- `winmem2.js mapmem.js mapscale.js holdrand.js motion.js` — Xorg heap accounting, map scaling,
  miSpriteTrace pick cost (XTest, Xvfb)
- x11perf-1.6.1 (built locally) — window-op and Copy/Composite throughput on XQuartz

Key environment facts worth re-checking when numbers matter: XQuartz 2.8.6 here is a custom
build (X.Org 21.1.23, no XTEST, **no Composite**); two Xvfb servers were running during
measurement; the in-process JS X server gives every window a retained raster (universal backing
store) and implements neither gravity nor Composite — its subwindow numbers are lower bounds.

Follow-up measurements worth running before committing to B:

- windowed-scrollview prototype vs scroll-blit vs full repaint, same content, frame times +
  protocol counts — on XQuartz _and_ on a Composite target (Xvfb or a Linux box/VM with
  Xorg+compositor), including the `backing-store: WhenMapped` zero-Expose tier, which is the
  majority-user path (verified only as an occlude/reveal probe on Xvfb so far, not as a scroll
  loop; XWayland entirely unprobed). Re-save the bench baseline at the ntk floor bump, per the
  PR-chain convention;
- XQuartz pane-move cost vs pane pixel area (isolate from the grandchild-count effect — the
  4.9 ms row conflates them, and the "drawn-rows pane is µs-scale" expectation rests on it);
- the un-measured layout axis: time a wheel-notch frame (full-tree relayout + absolutize) at
  N≈1000 with the hitbench harness, and settle whether yoga's wasm `calculateLayout` early-outs
  when the root size is re-set to identical values — it conditions the client-side
  "scroll-as-translation" alternative's payoff (§5.4);
- Enter/Leave storm cost sweeping a grid of InputOnly regions (needs Xvfb + XTest, script ready
  in `livebench/bench1.js`);
- hit-test bench re-run after the §8-A caching fixes to confirm the 10–50× expectation.

Not covered here, noted for completeness: **Present** (advertised by XQuartz, rootless fidelity
unknown) is the protocol's frame-transaction tool and the principled answer to §5.2's
cross-region tearing if regions ever multiply; **XInput2** changes the event-mask story (raw
motion, touch, smooth scroll) and its crossing semantics were not covered by this pass; the JS
server implements neither, so both need Xvfb work.

## 11. Primary sources

X11R7.7 protocol spec (event delivery, crossings, InputOnly, gravity, backing-store, encoding);
Composite v0.4, Shape v1.1, Render v0.11, XC-MISC specs; xorg-server master sources
(`windowstr.h`, `mivaltree.c`, `miwindow.c`, `compinit.c`, `dix/window.c`, `dix/dispatch.c`);
XQuartz rootless README + quartz-wm sources (InputOnly tracking window, SouthEastGravity growbox);
xwayland-window.c; Larsson's CSW posts + gtk-devel rationale mail; GTK3/GTK4 input & drawing
docs; Qt QWidget "Native vs Alien" docs + window-embedding blog; O'Reilly Motif ch.3 (gadgets)
and Java Swing ch.28 (mixing); Chromium GPU-compositing design doc; Keith Packard's smart
scheduler paper; XQuartz issues #308/#438/#466 and old-ticket 536 (child GLX). Full URL list in
the out-of-tree research notes (§10).
