# Element-owned layer contents: a `Surface` that is its node's layer

_Design record, 2026-09-07. Written against master at 7e95217 (react-x11
2.8.3 plus the frame pacer, ntk ^8.7.0, `@windowkit/appkit` ^0.6.0), for
issue #499 — the fourth of the upstream seams in
sidorares/react-x11-components#69 §6 and the last of them still unbuilt.
**Nothing is implemented with this document**; §9 is the shape the
implementing PR takes, and §10 is the spike its claims were measured on.
The mechanism it extends is
[layer promotion](../macos.md#layer-promotion-the-animated-few-on-their-own-layers-above-the-surface-presenter);
the cost it removes is the one [frame pacing](frame-pacing.md) measured and
then paced around._

---

## 0. TL;DR

- An element with a **retained surface** — a terminal, a chart on a socket,
  a media frame — draws its pixels once into a `Surface` of its own and
  composites that bitmap over its box on every frame
  ([extending.md](../extending.md#an-element-that-covers-its-box)). On the
  Cocoa backend that composite, and the window swapchain's catch-up copy
  behind it, are **1.3ms of a 3.8ms frame** on an M1 Pro at 1800×1280 — to
  move pixels that already exist into a bitmap the window then hands to
  Core Animation, which had them all along.
- If the element's surface **were** its layer, both disappear: the window's
  bitmap is never touched, so the window neither flips nor catches up, and
  the element's own flip is `layer.contents = iosurface` — **0.03ms,
  constant, whatever the size**. `<glarea>` already works this way
  (src/cocoa/glarea.js), and layer promotion (#483, src/cocoa/promotion.js)
  already gives a node a layer above the window's bitmap for animation.
  This is the same move for a node whose pixels are its own.
- The render server scans out of **our** memory: a fill into the IOSurface
  a layer is showing is on the screen with no present call at all (§2,
  measured). So an element-owned surface needs the pair the window has —
  a back buffer to draw into, a flip, and a damage-sized catch-up copy so
  the new back buffer is not one frame stale.
- The API is two pieces. A `Surface` asked for with `presentable: true` —
  the same `react-x11/ntk` `Surface` a component already allocates, asking
  for a swapchain instead of a bitmap. And
  `presentedSurface()` on the node — an accessor core asks every frame,
  like `opaqueRect()`, answering the surface and the rect it covers.
  **Declining is always safe**, on X11 and whenever the scene says no: the
  element keeps compositing through `ctx.drawImage(surface, …)`, which is
  the code it already has.
- The policy is promotion's, unchanged: the layer is above all the 2D
  content, so a node is taken only while nothing painted after it reaches
  into its bounds and every clipping ancestor holds all of it — re-decided
  every frame, handed back the frame that finds it overlapped.

## 1. What a retained-surface element pays now

The element class is the one
[extending.md](../extending.md#scrolling-the-pixels-not-just-the-offset)
already documents: it keeps its drawing in a `Surface`, draws into it when
its data changes — a terminal writes the rows that arrived, a chart the
sample that landed, and a pan is one `copyWithin` of the band that survives
— and its `paint` is one line:

```js
paint(ctx) {
  const box = this.contentBox();
  ctx.drawImage(this.surface, box.x, box.y);
}
```

On the Cocoa backend that line and its consequences are the frame:

1. **The composite.** `drawImage` is one `CGContextDrawImage` from the
   element's bitmap into the window's backing store, clipped to the pass.
   Full-area, 0.96ms at 1800×1280 on an M1 Pro (§7); the components PRD
   measured 1.7ms in a live terminal at 2000×1400.
2. **The window's flip.** `CocoaWindow.present` hands the backing store's
   IOSurface to the window's root layer — cheap, 0.03ms, but it happens
   because the element dirtied the bitmap.
3. **The window's catch-up copy.** After the flip the other buffer of the
   pair is one frame stale, so the flip memcpys the frame's damage across
   (src/cocoa/window.js). The element's rect is that damage: 0.31ms
   full-area here, 0.95ms in the PRD's terminal.

So the pixels are copied twice and blended once, from a buffer the compositor
could have read directly. The waste is not an accident of the surface
presenter — it is what "one bitmap per window" means, and every retained
element pays it in proportion to its area.

`opaqueRect()` (#497) already removed the other half of this frame — the
window's and the ancestors' background fills under an element that covers
its box. What is left under it is the copying.

## 2. What the platform does, spiked

Five questions, one script (§10), run on an M1 Pro at 2×, macOS 15.2,
`@windowkit/appkit` 0.6.0. Its output, verbatim:

```
placement, orientation, scale, colour, clip:
{
  bitmap: '128,128,128',
  marker: '0,255,0',
  top_band: '255,0,0',
  grey_in_element: '128,128,128',
  rounded_corner: '128,128,128'
}
after drawing into the SHOWN buffer, with no present:
{ element: '0,0,255' }
```

- **A sublayer composites over the window's bitmap.** The root layer holds
  the surface presenter's frame (mid grey); a sublayer showing an IOSurface
  covers exactly its own frame and nothing else — `bitmap` outside it is
  still the presenter's grey. This is promotion's arrangement, with
  contents instead of properties.
- **No flip, no mirror.** `createSurfaceIOSurface` lays a CG bitmap over the
  IOSurface with the same top-left CTM `createSurface` uses, so the
  surface's device (0,0) lands at the layer's top-left (`marker`) and row
  order is preserved (`top_band`). `<glarea>` mirrors its layer
  (`transform: { scaleY: -1 }`) because GL renders bottom-up; **a 2d surface
  must not**.
- **Device pixels, and the scale carried by the layer.** The layer's frame
  is points, its `contentsScale` is the window's scale, and the IOSurface is
  device pixels — the units a `Surface` is already sized in
  ([scale.md](../scale.md)). A 200×120pt layer showing a 400×240 surface at
  2× is pixel-exact.
- **The same colour space as the bitmap.** Mid grey drawn into the element's
  IOSurface composites to the same bytes as mid grey drawn into the window's
  backing store (`grey_in_element` = `bitmap`). Both go through
  `kCGColorSpaceSRGB`; the Generic-RGB drift that made layer _property_
  colours composite paler (fixed in appkit 0.5.1) never applied to contents.
- **A rounded clip clips contents.** `cornerRadius` + `masksToBounds` on the
  layer cuts the corner out of the IOSurface too (`rounded_corner` is the
  bitmap beneath), so an element with a `borderRadius` keeps it.

And the finding the whole design turns on:

> **The render server scans out of our memory.** Filling the IOSurface the
> layer is already showing — no `setLayerContentsIOSurface`, no transaction,
> nothing that tells Core Animation anything happened — put the new colour
> on the screen.

That is the tear, stated as a measurement: an element drawing into a
presented buffer is drawing into the scanout, and a half-drawn frame is a
half-drawn screen. The window answered this with two IOSurfaces and a flip;
an element-owned surface needs the same, and it is the reason this is a
`Surface` feature rather than "hand core your bitmap".

## 3. A presentable `Surface`

```js
import { Surface } from 'react-x11/ntk';

this.surface = new Surface(this.app, { width, height, presentable: true });
```

`react-x11/ntk`'s `Surface` already asks the app it is handed for the
implementation (src/ntk.js) — ntk's pixmap on an X connection, a CG bitmap
on a Cocoa app. `presentable` asks that app for a **swapchain** instead of a
single bitmap. Everything else about the object is unchanged: `getContext('2d')`,
`render`, `clear`, `copyWithin`, `destroy`, and `ctx.drawImage(surface, …)`
as a source.

What the Cocoa implementation (src/cocoa/surface.js) grows:

- **A pair, not a bitmap.** Two `createSurfaceIOSurface` buffers; the
  context draws into the back one. Falls back to the single plain bitmap
  when IOSurface creation fails — the window's own fallback, and the element
  is none the wiser because it never presents.
- **A generation, so one context spans two bitmaps.** `CocoaContext2D` takes
  its handle and a generation as closures (`() => handle`, `() => gen`)
  precisely so a flip can swap the bitmap under a cached context: the sticky
  graphics state — fill colour, line width, the CTM — is CoreGraphics state
  living _in the bitmap_, and the generation is what makes the context
  re-sync it. `CocoaWindow` does exactly this on every flip (`_surfaceGen`);
  a presentable surface is the same arrangement one level in.
- **`present(damage)`, called by core, not by the element.** Unlock, hand
  the back buffer's `iosurfaceId` to the layer, swap, lock the new back, and
  memcpy `damage` across (`copySurfaceRegion`) so the new back buffer is not
  one frame stale. `damage` is the rects the element claimed since the last
  present, translated into surface coordinates; no damage means a full copy.
- **The catch-up happens at the flip, synchronously.** Not lazily at the next
  draw, which would be cheaper for an element that repaints everything: the
  element may draw into the back buffer at any moment after the frame
  returns — that is the whole point of a retained surface — and a copy
  arriving after that would overwrite what it drew. The window can afford no
  such distinction; here it is a correctness rule, not a preference.
- **Lock brackets.** `surfaceLock` before a frame's first draw,
  `surfaceUnlock` before the flip: 1µs for the pair, measured — free, and
  the contract IOSurface asks for.
- **`destroy()` frees both**, on the call, the way `releaseSurface` freed the
  window's pair rather than waiting for V8 (the `rss +80MB` a resize drag
  used to hold). A resize retires a pair; two window-sized buffers at 2× are
  ~18MB, so this is not optional bookkeeping.

**On X11 the option is accepted and ignored.** ntk's `Surface` answers as it
does today, `present()` returns false, and the element's `drawImage`
composite is the path — an XRender `Composite` the server runs, with no
per-element scanout buffer to hand a compositor and no reason to invent one
(§8). The element's code is identical on both backends, which is the same
bargain `scrollContents` and `opaqueRect()` make.

## 4. The node's half: who gets a layer, and when

### 4.1 The accessor

```js
/** The surface this element's content lives in, and the rect it covers in
 *  window coordinates — or null. */
presentedSurface() {
  return { surface: this.surface, rect: this.contentBox() };
}
```

Asked **every frame**, like `opaqueRect()` and like promotion's whole
policy; a `null` answer, or a frame that declines it, changes nothing about
what the element does. The rule promotion states applies here word for word:
_declining is always safe_ — the element's `paint` composites the surface,
and that is the picture.

The alternative spelling, an imperative `node.presentSurface(surface)`, is
worse for the reason promotion's policy is re-decided every frame: the
answer depends on the scene, and a scene changes without the element
hearing about it.

### 4.2 The arrangement

Three layers, one per thing that is genuinely separate:

```
window root layer          the surface presenter's bitmap — a hole where the node is
└── node layer             the property box: background, border, radius, masksToBounds, z
    ├── contents layer     frame = the presented rect, contents = the front IOSurface
    └── raster layer       the children, if it has any (promotion's `_syncContent`)
```

The node layer is promotion's `Visual` verbatim (`propBoxProps`): a
promoted node's background, border, corner radius and clip are already
layer properties, which is what makes them animatable. The contents layer is
new and is a sublayer rather than the node layer itself, because the
presented rect is usually the **content box** — inset from the node's box by
padding and border — and a layer's contents fill its bounds. It is also how
`<glarea>` attaches, one level up.

The children keep promotion's answer: one raster sublayer, painted by the
node's own `_paintChildren` walk, repainted for the claims that reached into
it. A presenting element with drawn children is unusual — a terminal has
none — so the implementing PR may leave the raster out and decline a node
that has drawn children; the machinery is there when a consumer appears.

### 4.3 What promotion has to grow

`CocoaPromotion` is the owner: same candidate set, same z-order test, same
per-frame re-decision, same demote-and-claim-the-hole. Four honest changes:

- **`promotableNode` gates on `plainBox(node)`** — an identity test on
  `node.paint`, "not an element with a paint of its own, whose content
  exists nowhere but in that override". A presenting element _is_
  that, and is safe for the opposite reason: its content exists nowhere but
  in its surface, and the surface is on the layer. So the test grows a
  second acceptance path — a node whose ink is defined to be its presented
  surface plus the property box.
- **`paintsSomething` / `_reaches`** must count a presenting node's ink as
  its presented rect, so a _neighbouring_ candidate is told the truth about
  what would be painted over it.
- **The candidate set** gains nodes that answer `presentedSurface()`, not
  only nodes that animate. They are not the same set and both are small: a
  scene has a handful of each.
- **`IDLE_GRACE_MS` does not apply.** An animation ends; a presented surface
  does not. A presenting node keeps its layer until it stops answering, is
  overlapped, or is destroyed.

### 4.4 The frame

The seams already exist and are already in the right order (src/nodes.js,
`WindowNode.flush`):

1. The element draws into its back buffer when its data changes, and claims
   the rect it drew — `invalidate(false, rect, 'props')`, exactly as it does
   today so the composite happens.
2. `noteInvalidate` sees the claim on its way to the bitmap. For a presenting
   node it answers `true` — the bitmap owes nothing, since the node is a hole
   — and records the rect, which is what the catch-up copy will cover. A
   frame is still scheduled (`needsPaint`), and the pacer still prices it.
3. `prepareFrame(root, layoutRan)` runs after layout and before the damage is
   taken. It syncs the node layer's properties and, for each presenting node
   with claims, calls `surface.present(rects)` — the flip.
4. The paint pass paints nothing there, because the node is `_promoted`.
   With no other claim in the frame the window's backing store is untouched,
   `CocoaWindow.present` returns early on `!this._dirty`, and **the window
   neither flips nor copies**. That is the second half of the saving, and it
   falls out of machinery that already exists rather than being added.

### 4.5 What the element must not do

**Draw inside `paint`.** A presenting node's `paint` is not called — that is
what the hole means — so an element that draws its scene there and
composites in the same pass would simply stop updating. The class this seam
is for already separates the two (draw on data, composite in `paint`), and
the accessor's documentation has to say so in one line. An element that
wants core to drive its drawing has a different answer today and a better
one later (§8).

## 5. Scale, orientation, colour, corners

All four are measured in §2 and none needs new code:

| question               | answer                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| flip / mirror          | none — the CG bitmap over the IOSurface has `createSurface`'s top-left CTM. `<glarea>`'s `scaleY: -1` is GL's bottom-up rendering, not the IOSurface's |
| scale                  | layer frame in points, `contentsScale` = the window's scale, surface in device pixels — the units `Surface` already uses                               |
| colour                 | both buffers are `kCGColorSpaceSRGB`; an element's grey and the bitmap's grey composite to the same bytes                                              |
| rounded corners        | `cornerRadius` + `masksToBounds` on the node layer clips the contents                                                                                  |
| a partly drawn surface | a fresh IOSurface is transparent, not garbage — `Surface` clears on construction anyway (src/cocoa/surface.js)                                         |

## 6. What it composes with

- **The frame pacer** ([frame-pacing.md](frame-pacing.md)). Unchanged and
  still the right tool: the claim is held in `_scheduleFrame`, above the
  clock, and the frame is priced by what it costs. This design makes that
  cost smaller, so a streaming element gets _more_ frames at the same
  budget. The two are complementary — pacing decides how often, this decides
  how much.
- **`opaqueRect()`.** Moot while presented (`_coverFor` skips `_promoted`
  nodes) and correct again the moment the node is handed back. An element
  should keep answering it: it is what pays when the scene declines.
- **The scroll blit.** A presenting element's pan is `surface.copyWithin` on
  its own surface — the shift it already had, one layer in — and the window's
  `scrollRegion` never sees it. `_scrollBlitSafe` already skips `_promoted`
  children, so a pan _around_ the element still blits.
- **Promotion.** Same z range, one sort: a promoted animation layer and a
  presenting element layer are both sublayers of the root, ordered by paint
  order, and each is refused if the other reaches into it.
- **`<glarea>`.** Above both at `zPosition: 1e7`, unchanged.
- **The layers presenter** (`REACT_X11_COCOA_PRESENTER=layers`). Every node
  there already has a visual, and a presenting node's raster visual becomes
  contents from the element's front IOSurface — strictly less work than the
  raster it replaces. Out of scope for v1, which declines and keeps
  `drawImage`.
- **Transparent windows and popups.** A layer over a clear window composites
  as any layer does; the window's shadow recompute is driven by the bitmap
  and unaffected. A presenting element in a `<popup dragPreview>` is
  declined for the ordinary reason — nothing is asking for one.

## 7. Measured

M1 Pro, macOS 15.2, 2×, `@windowkit/appkit` 0.6.0. A 1800×1280 element in a
1800×1400 window — a pane under a strip of chrome, the `stream` scenario's
shape. Per frame, beyond the element's own drawing (2.45ms either way; an
IOSurface-backed CG bitmap and a plain one draw at the same speed, which is
its own finding):

| the frame paints                         |      today |  presented |     saving |
| ---------------------------------------- | ---------: | ---------: | ---------: |
| the whole element                        |            |            |            |
| — composite (`ctxDrawSurface`)           |     0.96ms |          — |            |
| — the window's flip                      |     0.03ms |          — |            |
| — the window's catch-up over the element |     0.31ms |          — |            |
| — the element's flip                     |          — |     0.03ms |            |
| — the element's catch-up (whole surface) |          — |     0.34ms |            |
| **total**                                | **1.30ms** | **0.37ms** | **0.93ms** |
| a quarter of the element                 |            |            |            |
| — composite, clipped to the claim        |     0.20ms |          — |            |
| — the window's flip + catch-up           |     0.11ms |          — |            |
| — the element's flip + catch-up          |          — |     0.10ms |            |
| **total**                                | **0.31ms** | **0.10ms** | **0.21ms** |

Three things to read out of it. The saving is **about 70% of the copying,
at any damage fraction** — the composite is a blend (read source, read
destination, blend, write) where the catch-up is a memcpy, so the same area
costs roughly three times less; and the flip is constant. It is **largest
exactly where the problem was found**: a full-area frame, which is what a
terminal under a flood produces every time. And it is **not the whole
frame**: the element's own drawing is untouched, which is what the pacer is
for.

Two caveats, stated rather than buried. These are microbenchmarks — one
operation repeated with warm caches — and the components PRD measured 1.7ms
and 0.95ms for the same two steps inside a live terminal at 2000×1400, where
the source has been evicted by everything else the frame did. **The ratio is
what to trust, not the absolute**; by the PRD's numbers the same arithmetic
removes 2.65ms of a 6ms frame. And the numbers move ±30% between runs with
WindowServer load, as every Cocoa measurement in this repo does.

## 8. What is not here, and why

- **A core-owned raster for any element** — "a node whose content is painted
  code gets a raster visual", the Tier L rule in
  [macos.md](../macos.md#custom-drawing-on-a-layer-tree). More general (it
  needs nothing from the element but its existing `paint`) and a different
  design: core owns the buffer, core decides when to redraw, and the
  element's incremental drawing — the terminal writing the rows that arrived,
  the `copyWithin` pan — has nowhere to live. This seam is for the element
  that already owns its pixels; the raster is for the one that does not. They
  should both exist and neither is the other's v2.
- **One buffer instead of two.** `IOSurfaceIsInUse` would let an element
  skip the pair while the compositor is not reading — the bridge exposes no
  such verb, it is a race in any case (in-use can become true between the
  question and the first fill), and the buffer costs 9MB. Not worth an appkit
  issue yet.
- **`preserveContents: false`.** An element that redraws every pixel between
  presents needs no catch-up copy at all (0.34ms at full size). Real, and
  deliberately not in v1: the claim-derived copy is already the right answer
  for everyone else, and a flag whose contract is "trust me" should wait
  until a measurement asks for it.
- **An X11 equivalent.** A child window with a pixmap of its own would give
  the server the same trick, at one X window per element, a second damage
  domain, and input plumbing around a window the element does not own — for
  a composite the server already runs asynchronously. The X11 answer is
  `drawImage`.
- **Video, YUV and GL interop.** An IOSurface can carry a decoder's output
  or a GL render target, and a `<video>` element would want exactly this
  seam. Out of scope; nothing here forecloses it.

## 9. Decisions the implementing PR has to make, and the suggested answer

| question                         | suggested answer                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the `Surface` option             | `presentable: true`. Not `swapchain: 2` (the count is an implementation detail) and not a separate class (`Surface` is already the backend-neutral name a component reaches for)                                                                                    |
| the node accessor                | `presentedSurface()` → `{ surface, rect }` or `null`, asked every frame beside `opaqueRect()`                                                                                                                                                                       |
| who calls `present()`            | core, in `prepareFrame`, so the flip is a frame and the pacer prices it. `Surface.present(damage)` stays public for a consumer outside the renderer                                                                                                                 |
| what the catch-up copies         | the rects the element claimed since the last present, translated into surface coordinates by `rect`'s origin; an unbounded claim is a full copy                                                                                                                     |
| when it copies                   | at the flip, synchronously — the element may draw the moment the frame returns                                                                                                                                                                                      |
| a node with drawn children       | v1 declines; promotion's raster sublayer is the answer when a consumer needs it                                                                                                                                                                                     |
| an element that draws in `paint` | documented as a contract, not detected: `paint` is not called, so the element would go stale. The accessor's doc line, and a `docs/extending.md` section beside "An element that covers its box"                                                                    |
| the scene test                   | promotion's `_clear`, unchanged, plus a presenting node's rect counted as ink in `paintsSomething`/`_reaches`                                                                                                                                                       |
| the grace period                 | none — `IDLE_GRACE_MS` is for an animation that ended; a surface does not end                                                                                                                                                                                       |
| resize                           | the element reallocates its surface as it does today; the old pair is freed on the call, not by the finalizer                                                                                                                                                       |
| two nodes, one surface           | refused (the second answers `null` in development with a warning); one buffer cannot be two layers' contents without tearing between them                                                                                                                           |
| X11                              | the option is accepted and ignored, `present()` returns false, `presentedSurface()` is never asked because no window answers `prepareFrame`                                                                                                                         |
| tracing                          | a `trace` line for taken/declined with the reason, the way promotion's decisions are traceable — a refusal is invisible in the picture, which is the point and also the debugging problem                                                                           |
| types                            | `presentable` on the `Surface` options and `presentedSurface(): { surface, rect } \| null` in `src/node.d.ts`, one line in `test/types/extend.tsx`                                                                                                                  |
| docs                             | a section in [extending.md](../extending.md#an-element-that-covers-its-box) after "An element that covers its box"; the ladder in [macos.md](../macos.md#custom-drawing-on-a-layer-tree) gains the presented case; this file becomes the design record it points at |

**Tests**, in the shape of `test/cocoa-promotion.test.js` and
`test/cocoa-surface.test.js` — the fake bridge for what reaches the natives,
the real one for pixels:

- a presentable surface allocates a pair and answers one context across a
  flip, with the generation bumped so the sticky state re-syncs;
- `present(damage)` unlocks, sets the layer's contents to the back buffer's
  id, swaps, locks, and copies exactly `damage` — and copies everything when
  told nothing;
- a presenting node gets a layer, leaves a hole, and the bitmap under it is
  claimed once, in the frame that takes it;
- a frame in which only the presenting element claimed touches the window's
  backing store not at all (the `_dirty` assertion — this is the saving,
  stated as a test);
- every promotion refusal applies: a later sibling over it, a clipping
  ancestor that does not hold it, a focus ring, a scrollbar strip, hidden —
  and each hands the node back in the frame that finds it, with the element
  compositing again;
- pixels on a real display: the presented surface lands at its rect, at
  scale, unmirrored, and a repaint of the bitmap around it leaves it alone;
- X11: `presentable` is accepted, `present()` is false, and the element
  paints identically with and without it.

**Bench**: a `--presented` column on the `stream` scenario
(`scripts/bench/presenters.js`), whose element already covers its box and
already answers `opaqueRect()`. The gate rule is the one that matters:
frames per second at a fixed budget, and the window's paint count at zero.

**Sequencing.** Three PRs, each useful alone: the presentable `Surface` and
its tests; `presentedSurface()` and the promotion policy; the bench column,
the numbers and the docs. Nothing needs a bridge release — §2 is the proof
that `@windowkit/appkit` 0.6.0 already has every verb.

## 10. The spike

Reproduced so the numbers can be re-run: save it at the repo root of a
react-x11 checkout and run it with `node` on a Mac with a display. It uses
the bridge alone — no renderer, no React — and honours
`REACT_X11_CALAYERS_PATH` so a bridge checkout can be tested too.

```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bridge = require(
  process.env.REACT_X11_CALAYERS_PATH ?? '@windowkit/appkit',
);
const N = bridge.native ?? bridge;
const { PNG } = require('pngjs');
const fs = require('node:fs');

const s = 2; // device pixels per point
const PTS = { width: 400, height: 300 };
N.initApp();
const win = N.createWindow2({ ...PTS, kind: 'borderless', x: 100, y: 100 });
const root = N.windowRootLayer(win);
N.showWindow(win, true);

// the surface presenter's bitmap: mid grey over the whole window
const bitmap = N.createSurface(PTS.width * s, PTS.height * s, s);
N.ctxSetFillColor(bitmap, 0.5, 0.5, 0.5, 1);
N.ctxFillRect(bitmap, 0, 0, PTS.width * s, PTS.height * s);
N.surfaceToLayer(bitmap, root);

// an element's own layer, its contents an IOSurface a CG context drew into
const BOX = { x: 50, y: 40, w: 200, h: 120, r: 24 };
const layer = N.createLayer();
N.addSublayer(root, layer);
N.setLayerProps(layer, {
  frame: [BOX.x, BOX.y, BOX.w, BOX.h],
  contentsScale: s,
  cornerRadius: BOX.r,
  masksToBounds: true,
  zPosition: 1,
});
const ew = BOX.w * s,
  eh = BOX.h * s;
const buf = N.createSurfaceIOSurface(ew, eh, s);
N.surfaceLock(buf.handle);
N.ctxSetFillColor(buf.handle, 1, 0, 0, 1); // top half red
N.ctxFillRect(buf.handle, 0, 0, ew, eh / 2);
N.ctxSetFillColor(buf.handle, 0.5, 0.5, 0.5, 1); // bottom half the bitmap's grey
N.ctxFillRect(buf.handle, 0, eh / 2, ew, eh / 2);
N.ctxSetFillColor(buf.handle, 0, 1, 0, 1); // a 60px device marker at 0,0
N.ctxFillRect(buf.handle, 0, 0, 60, 60);
N.surfaceUnlock(buf.handle);
N.setLayerContentsIOSurface(layer, buf.iosurfaceId);

const shot = (name) => {
  N.snapshotWindow(win, name);
  const png = PNG.sync.read(fs.readFileSync(name));
  const d = png.width / PTS.width;
  return (x, y) => {
    const i = (png.width * Math.round(y * d) + Math.round(x * d)) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]].join(',');
  };
};

const time = (label, fn, n = 60) => {
  for (let i = 0; i < 10; i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  console.log(
    `  ${label.padEnd(46)} ${((performance.now() - t0) / n).toFixed(3)} ms`,
  );
};

let tick = 0;
const pump = setInterval(() => {
  N.pump2();
  if (++tick === 10) {
    const at = shot('/tmp/spike-a.png');
    console.log('placement, orientation, scale, colour, clip:');
    console.log({
      bitmap: at(320, 250), // outside the element
      marker: at(BOX.x + 26, BOX.y + 26), // inside the surface's own (0,0) corner
      top_band: at(BOX.x + 100, BOX.y + 20),
      grey_in_element: at(BOX.x + 100, BOX.y + 100),
      rounded_corner: at(BOX.x + 2, BOX.y + 2),
    });
    // draw into the buffer the layer is already showing; present nothing
    N.ctxSetFillColor(buf.handle, 0, 0, 1, 1);
    N.ctxFillRect(buf.handle, 0, 0, ew, eh);
  }
  if (tick === 20) {
    const at = shot('/tmp/spike-b.png');
    console.log('after drawing into the SHOWN buffer, with no present:');
    console.log({ element: at(BOX.x + 100, BOX.y + 60) });

    const W = 900 * s,
      H = 700 * s,
      EH = 640 * s;
    const wa = N.createSurfaceIOSurface(W, H, s);
    const wb = N.createSurfaceIOSurface(W, H, s);
    const el = N.createSurface(W, EH, s);
    const ea = N.createSurfaceIOSurface(W, EH, s);
    const eb = N.createSurfaceIOSurface(W, EH, s);
    console.log(`\ncost, ${W}x${EH} element in a ${W}x${H} window:`);
    time('composite ctxDrawSurface(window, element)', () =>
      N.ctxDrawSurface(wa.handle, el, 0, 0, W, EH, 0, 0, W, EH),
    );
    time('window catch-up copySurfaceRegion(element)', () =>
      N.copySurfaceRegion(wa.handle, wb.handle, [0, 0, W, EH]),
    );
    time('flip setLayerContentsIOSurface', () =>
      N.setLayerContentsIOSurface(layer, ea.iosurfaceId),
    );
    time('element catch-up copySurfaceRegion(all)', () =>
      N.copySurfaceRegion(ea.handle, eb.handle, null),
    );
    time('element catch-up copySurfaceRegion(25%)', () =>
      N.copySurfaceRegion(ea.handle, eb.handle, [0, 0, W, EH / 4]),
    );
    clearInterval(pump);
    N.destroyWindow2(win);
    process.exit(0);
  }
}, 8);
```

The clipped-composite row in §7 is one more `time()` call with the
destination clipped to a fraction of the element before `ctxDrawSurface`:
0.96ms unclipped, 0.20ms at a quarter, 0.05ms at a twentieth — the composite
is proportional to the claim, which is why §7 has two halves.

## 11. Verdict

Buildable now, on the bridge as it is, at moderate size: a swapchain and a
`present()` in `src/cocoa/surface.js`, an accessor on `Node`, and a second
kind of candidate in `src/cocoa/promotion.js` — whose hard part, the z-order
rule, is written and tested. It removes about 70% of what a retained-surface
element spends outside its own drawing — 0.93ms of a 3.8ms frame here, and
by the components PRD's numbers 2.65ms of a 6ms one — which is the largest
item left in a streaming element's frame now that the pacer and
`opaqueRect()` have taken theirs.

The reason to do it after the pacer rather than instead of it is that they
answer different halves: pacing stops the thread painting screens nobody
sees, and this stops each of the screens it does paint from being copied
twice. And the reason to keep `drawImage` working underneath is the reason
promotion keeps the frame clock underneath: the scene decides, every frame,
and the element's pixels must be right when the answer is no.
