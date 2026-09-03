# A native macOS backend

**Status: research RFC with a working POC.** Written 2026-09-01 against
react-x11 2.2.1, ntk 8.8.0, and `node-calayers` 0.1.0 — a proof-of-concept
Node addon (Objective-C++, ~900 lines native + 155 JS) that already does
retained CALayer trees, CoreText measurement and rasterization, native
control bezels, window snapshots, and an NSApplication event pump driven
from Node's own loop. The POC is local (not yet published); publishing it
against the API contract in this document is the first actionable step.
The line counts and inventories below are measurements, not estimates;
where a companion number comes from [wayland.md](wayland.md), it is cited
rather than re-measured.

## What this is, and is not

This is a plan for a **third target, second backend family**: the same
React tree, the same components and the same application code running as a
first-class macOS app — real `NSWindow`s, the system menu bar, native
control rendering, Core Animation compositing — with no X server anywhere.
X11 stays what it is: the flagship remote target ([remote.md](remote.md)),
the window-manager story, and the only backend for `<foreign>`/XEmbed.
Nothing here proposes changing how the X11 path works, and the plan is
explicitly shaped so that its refactors are pinned by the existing pixel
and bench gates before any macOS code lands on top of them.

The relationship to the [Wayland RFC](wayland.md) matters, because the two
inversions are opposite and one architecture has to hold both:

- **Wayland deletes the drawing protocol downward** — the client
  rasterizes finished pixels. Its natural seam is _below_ ntk's 2d
  context: a span compositor behind the same `getContext('2d')` name.
- **macOS deletes the drawing protocol upward** — the WindowServer is a
  retained compositor and the client's job is to _mutate a persistent
  layer tree_, not to encode draw calls and not to rasterize (except
  where it chooses to). Its natural seam is _above_ the 2d context: at
  the node tree itself.

Both seams can exist at once, and the extraction this document proposes
(§"One renderer, two presenters") leaves the Wayland plan intact — a
Wayland presenter is the X11 presenter with a different surface under it.

Goals, unchanged from the project's standing ones: perceived performance
first (input-to-photon), then stability, then client CPU and memory; the
whole range of desktop UI that the platform permits; a small portable
codebase, with a native module admissible where the runtime leaves no
other way to reach a required OS facility — and macOS is the clearest
case of that clause: there is no wire protocol to speak, only
frameworks, so the bridge is a compiled addon by necessity. What keeps
the spirit of the rule is keeping the addon **thin and mechanism-only**
(create/set/add/remove/pump — no policy, no widget logic), which is
exactly the shape `node-calayers` already has.

Out of scope on this backend, honestly and up front, the same way
wayland.md declares its walls:

- **A window manager cannot be written against Cocoa.** `examples/wm.jsx`
  and the substructure-redirect half of the API remain X11-only.
- **Cross-process window embedding does not exist on macOS.** `<foreign>`,
  the XEmbed half of `<Frame>`, `@react-x11/components`' tray-host and its
  mpv/VLC `--wid` embedding have no equivalent; `<Frame>` on macOS becomes
  a parented toplevel or an in-process pane, exactly the fate wayland.md
  assigns it.
- **XQuartz is not deprecated by this.** react-x11 already runs on macOS
  today through XQuartz; that path remains the way to run the X11 backend
  (and the WM example) on a Mac. This backend is for shipping _native_
  apps.

## What macOS actually changes

X11 is "the client encodes drawing, the server rasterizes and composites."
Wayland is "the client rasterizes, the compositor composites." macOS is a
third shape: **the client owns a retained scene graph (the CALayer tree)
and the render server composites it on the GPU** — geometry, colors,
corner radii, shadows, opacity, transforms, filters, and whole animations
are _properties of persistent objects_, committed atomically in
transactions and interpolated server-side without the client's further
involvement.

That shape is not an obstacle to this renderer; it is this renderer's own
architecture, one level down. react-x11 is already a retained tree — every
drawn element is a lightweight node holding style, a yoga node and an
absolute rect, and React commits arrive as property diffs against it
(`commitUpdate` → `applyProps(new, old)`). On X11 those diffs then have to
be _flattened into paint_: damage rects, a paint walk, clip bounding,
scroll blits, a paint cache — ~1,000 lines of machinery whose entire job
is to turn retained-tree diffs back into efficient immediate-mode drawing.
On macOS the diff **is** the drawing: a commit maps to one `CATransaction`
of `layer.set(...)` calls, layout writes frames inside the same
transaction, and the WindowServer recomposites what changed. The
reconciler's native output format and Core Animation's native input format
are the same thing — a property diff over a retained tree — with no
serialization through an immediate-mode bottleneck between them.

Three consequences are worth naming before any code, because they shape
the whole plan:

- **Animation leaves the JS thread.** A CA animation runs in the render
  server; the POC's spinner stays smooth while JS is stalled. The
  project's first goal is answering the input on the frame it arrived —
  a `transition:` on `:active` that the _system_ interpolates is that
  goal with the JS thread taken out of the loop entirely.
- **Scrolling becomes a property.** The scroll-blit fast path — gates,
  ledger, claim clipping, `CopyArea` (AGENTS.md §protocol efficiency) —
  exists because scrolling on X11 is repainting. On a layer tree,
  scrolling is `bounds.origin` on one clipping layer: constant cost,
  server-side, and the entire fast-path apparatus does not need to exist
  in that presenter.
- **Retina inverts from cost to freebie.** On the X11 path a 2× display
  quadruples every rasterized pixel; layers carry `contentsScale` and the
  GPU composites at native resolution, with rasterization confined to the
  nodes that actually rasterize (text, images, custom drawing).

The other thing macOS changes is _expectation_: a Mac app has the menu bar
at the top of the screen, native-looking controls, native open/save
dialogs, ⌘-shortcuts. This project's answer to the same question on Linux
was built desktop-first (D-Bus global menu with in-window fallback,
portals, XSETTINGS), and this document keeps that stance: the menu bar
becomes `NSMenu`, controls prefer native rendering with an escape hatch,
dialogs go native — each behind the same "default that serves the main
customer, seam for everyone else" rule the codebase already follows.

## What the POC already proves

`node-calayers` (local, `~/tmp/node-calayers`) settles the risky
mechanisms, which is what a POC is for:

- **A Node process can own NSApplication.** Node's main thread _is_ the
  process main thread on macOS; the addon initializes the app and JS
  drives an event pump (`nextEventMatchingMask:` with `distantPast`) off
  a timer. No `[NSApp run]`, no second process, no thread hop.
- **Retained layers behave.** `Layer`/`TextLayer`/`GradientLayer`/
  `ShapeLayer` wrappers over real `CALayer`s: frame/bounds/position,
  backgroundColor, cornerRadius, borderWidth, shadows, opacity,
  zPosition, masks, `masksToBounds`, transforms — mutated with
  `layer.set(props)`, batched with `CATransaction`, suppressed with
  `disableActions` (the reconciler-commit mode), animated implicitly and
  explicitly (`CABasicAnimation` on any keyPath, running in the render
  server through a JS stall).
- **Top-left coordinates work.** A layer-hosting, flipped `NSView` makes
  the hosted tree top-left-origin (`geometryFlipped`); the two flip
  gotchas (`hitTest:` stays bottom-up, `renderInContext:` ignores the
  flip) are handled in native code, and snapshots read the window's real
  composited pixels via `CGWindowListCreateImage` — no screen-recording
  permission needed for the process's own windows.
- **CoreText measures and rasterizes.** `text.measure()` →
  `{width, ascent, descent, leading}` via `CTLine`;
  `text.render()` → CGImage via `CTFramesetter`, set as layer contents —
  the glyph path a text visual needs. `CATextLayer` works too, taking the
  WindowServer path for retina-crisp static text.
- **Native control bezels render offscreen** — the WebKit/Firefox form
  technique: `NSButtonCell`/`NSPopUpButtonCell` via `drawWithFrame:`
  under `performAsCurrentDrawingAppearance:` (so dark mode and the user's
  accent apply), and the two controls modern AppKit refuses to draw as
  cells (`NSSlider`, `NSSwitch`) via a real unparented control's
  `displayRectIgnoringOpacity:`. Push (incl. accent-filled default),
  checkbox, radio, popup, slider, switch — interactive states, both
  appearances, re-renderable live.
- **Events arrive.** Mouse/key/wheel from the real pump to a JS callback;
  synthetic event posting through the same pump for tests
  (`postMouseEvent`), which is the `fireEvent` transport a test harness
  wants.
- **Hit testing round-trips.** `-[CALayer hitTest:]` maps back to JS
  wrapper objects by layer name. (react-x11 will not use it — the node
  tree already hit-tests — but it validates the tree's integrity.)

Known POC limits, all of which are Phase-0 work items rather than
unknowns: no modifier flags on events, one shared event callback with no
per-window routing, no `NSWindowDelegate` (resize/close/focus arrive only
by polling), sublayer append-only (no insert-at-index), no raw-buffer
`contents` upload (only CGImages produced native-side), no menu API, no
pasteboard, no drag session, no display-link frame clock, and the
pump-on-a-timer model leaves AppKit's internal modal loops (live resize,
menu tracking) starving JS. The full required API is specified in
§"node-calayers: the required API".

## What already carries over

The measured split from [wayland.md](wayland.md) §"What already carries
over" applies unchanged, because it was measured against the display
system, not against Wayland specifically: **~16,200 lines of portable
core** (reconciler, yoga, styles/decorations parsing, palette, a11y
model, keysyms, compose, text-selection model, anchors) and **~8,700
lines of `components/` + `frame/` + `refresh/`** carry over as-is. Of
`nodes.js`'s 11,515 lines, only `WindowNode` + `PopupNode` (~3,100)
speak X; `BoxNode`, `TextNode`, `ImageNode`, `CanvasNode`,
`TextInputNode`, `TextAreaNode` and the layout/hit-test machinery never
name the display system. The honest per-backend surface is the same
~9–10k-line list wayland.md names — window realize/present, events, DnD,
clipboard, screens, window state, scale, keyboard state, compositing,
input time, startup — plus, for macOS, the presenter itself.

What the _consumers_ actually depend on was inventoried for this RFC
across both sibling repos (`@react-x11/workbench` 0.1.0,
`@react-x11/components` 0.4.0, cloned and grepped 2026-09-01):

- The workbench is a thin consumer: `<box>`, `<text>`, `<window>`
  (`title`/`width`/`height`/`onCloseRequest` only), `<textinput>`, seven
  core components, `react-x11/test`, and
  `jsxImportSource: "react-x11"`. Nothing X-shaped at all.
- `@react-x11/components` is the real contract: **all ten subpaths**
  (`.`, `/host`, `/node`, `/style`, `/keysyms`, `/test`, `/yoga`,
  `/ntk`, `/jsx-runtime`, `/jsx-dev-runtime`, `/debug`). It subclasses
  `Node` and overrides `paint(ctx)`/`measureContent`/`default*` in seven
  registered elements; it uses the ntk `Context2D` dialect **including
  the extensions** `fillRects`, `drawGlyphs`, `positioned`,
  `layoutSubtree`, `vw`/`vh`/`em`; it reads X keysyms (`XK_*`) in twenty
  files; and its tests name backends
  (`renderX11(..., { backend: 'mock' | 'xserver' | ... })`).
- Its genuinely X-only reaches are few and localized: offscreen
  `ntk.Surface` allocation (charts, terminal, flow), `createWindow({id})`
  for an embedded client's title, the XEmbed `windowId` flow feeding
  mpv/VLC, `serverTime()`, and the tray host. Those stay X11-only
  features of those components, not portability obligations.

Two conclusions fall straight out of that inventory. First, **the public
API does not need a redesign to go native** — the compatibility surface
is the intrinsics, the components, the style system, the hooks, the
`Node`/`Context2D`/`registerElement` seam, the keysym vocabulary and the
test harness, and every one of those is implementable on Cocoa. Second,
**`XK_*` keysyms are the cross-platform key vocabulary by adoption**, not
an X leak to be replaced: they are symbolic integers used by every
consumer, `keysymOf()`/`ctrlChordLetter()` already abstract them, and the
macOS input layer synthesizes them (Latin-1 keysyms are their code
points, the rest via the `0x01000000 + UCS` rule plus a ~50-entry `kVK_*`
table for arrows/function/editing keys). Renaming them would break every
consumer to remove a prefix.

Desktop integration repeats Wayland's pleasant surprise, further along:
the appearance ladder **already has a macOS rung** (`appearance.js` reads
`AppleInterfaceStyle`/accent through a long-lived `osascript` child), and
so does the file dialog ladder. The native backend upgrades those rungs
from `osascript` to real API and deletes nothing.

## One renderer, two presenters

The user-facing question first — _conditional per-OS host components
inside one reconciler, or a completely separate reconciler exposing the
same public API?_ — because everything else hangs off it.

**A separate reconciler is the wrong split, and the inventory above says
why.** The public API that must stay identical is not a thin façade: it
includes the retained `Node` contract itself (subclassed by consumers),
the style system with its state blocks and transitions, the event
synthesis rules ("answer the input" — press chains, `:active`
narrowing, capture/bubble order), focus and tab order, text editing with
undo/coalescing, selection, scroll semantics, the a11y model, the anchor
math, and the test harness's behavioral assumptions. A second
implementation of all of that is a second toolkit wearing the first one's
types — two copies of every behavioral decision AGENTS.md records, one
maintainer, and a drift surface the size of the project. The measured
portable core (~25k lines with components) is precisely the code a
separate reconciler would fork.

**A pure "conditional host components" split is too shallow**, though: the
difference between X11 and Core Animation is not _which_ box node to
instantiate, it is _what happens after commit_ — immediate-mode paint
versus retained-property sync. The seam has to sit at that boundary, and
the codebase is already shaped for it in three load-bearing ways:

1. `createInstance` performs **no platform calls** (the render phase is
   discardable); every real window is created in the commit phase via
   `realize()`. The host config is already platform-free.
2. Nodes do not paint themselves spontaneously — they **announce**:
   `invalidate(layoutChanged, node, reason)` is the one channel through
   which every change reaches the screen, and `WindowNode.flush()` is the
   one consumer. The X11 damage/paint pipeline is an _implementation of
   that channel_, not part of the node model.
3. Everything a node needs from the platform is already reached through
   the `app` object — `createWindow`, `fonts.layout`, `clipboard`, the
   event emitter — and `createRoot({ app })` injects it. The headless
   mock in `src/testing/mock-app.js` passes the whole suite, which is
   the existence proof that the contract is closed.

So the proposal is **one renderer, one node model, two presenters**, plus
per-platform service modules behind the existing hook APIs:

| seam            | X11 implementation (today's code)                              | Cocoa implementation                                          |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| **WindowHost**  | `WindowNode.realize()` → ntk `CreateWindow`, WM hints, mapping | `NSWindow` + layer-hosting flipped view; delegates → events   |
| **Presenter**   | damage rects → paint walk → ntk 2d ctx → XRender               | dirty nodes → per-node visuals → `CATransaction` property set |
| **TextEngine**  | ntk `FontManager.layout` (fontkit shaping, glyph atlas)        | CoreText (`CTFramesetter`/`CTLine`) behind the same interface |
| **InputSource** | ntk window events (X11, XI2)                                   | NSEvent pump → the same normalized event shapes               |
| **FrameClock**  | ntk rAF (Present completions + fence)                          | `CADisplayLink`/`CVDisplayLink`; CA transactions for pacing   |
| **services**    | screens/scale/appearance/clipboard/DnD/menus/… (X + D-Bus)     | NSScreen/backingScale/NSAppearance/NSPasteboard/NSMenu/…      |

The refactor this requires of the X11 code is bounded and mechanical:
`WindowNode.flush()`'s paint half and the `_paint*` methods become the
X11 presenter (moved, not rewritten), and the node model keeps layout,
absolutize, hit testing, events, focus, selection and props. It lands as
its own phase with **zero behavior change**, pinned by the existing
pixel tests, `test/dirty-rect.test.js`, and `npm run bench -- --check` —
the same discipline the scroll-blit work used. Registered third-party
elements keep their `paint(ctx)` contract on both presenters (see
§"Custom drawing on a layer tree").

This split also answers the "complete rewrite vs seams" question with
numbers: seams cost a ~3–4k-line mechanical extraction inside `nodes.js`
plus per-backend modules that had to be written under any design; a
rewrite duplicates ~25k lines of accumulated behavior and every future
fix twice. And the extraction is not macOS-only spend — the Wayland
plan's "WindowNode.realize grows a second path" and the presenter split
are the same seams.

## Two tiers, one architecture — and the reconciler fit

Both integration levels from the exploration brief are real, and the plan
uses both — but **they are stages of one build, not alternatives**, and
the design target is the retained tier. The commitment made here, so the
bring-up stage cannot calcify into the architecture: _Tier S exists to
validate mechanisms and to serve as the raster fallback inside Tier L;
every interface is designed for Tier L from day one._

### Tier S — surface presenter (canvas2d, single layer per window)

Implement the `app`/`window`/`ctx` contract (the `mock-app.js` shape)
over Cocoa: an `NSWindow` whose content is one bitmap-backed layer, a
canvas2d context over `CGContext`, CoreText behind `app.fonts`, NSEvents
mapped to the ntk event names. `createRoot({ app: cocoaApp })` then runs
today's renderer unchanged — damage rects, paint walk, dirty-rect
machinery and all, painting into the bitmap and committing changed rects
to the layer (`setNeedsDisplayInRect`-style partial uploads, or an
IOSurface pair).

Everything here is load-bearing later, which is what justifies building
it first:

- the **CG-backed 2d context** is Tier L's raster fallback for
  `<canvas>`, `<svg>` and registered elements (CG is canvas2d's ancestor;
  the dialect including `fillRects` maps to `CGContextFillRects`
  directly);
- the **CoreText TextEngine** is the same object Tier L's text visuals
  measure and rasterize through;
- the **window host, event mapping and run-loop work** carry verbatim;
- the whole thing runs the existing test suite and examples on macOS
  natively, which is the fastest possible detector for event/text/input
  contract gaps.

What Tier S cannot do, structurally: offload animation (every transition
frame is a JS-side repaint + upload), make scrolling cheap (the blit
becomes a `memmove` + upload), or exploit retina (2× is 4× the raster
and 4× the upload). It is a correct port with X11's cost model on
hardware that offers a better one.

### Tier L — layer presenter (retained, the design target)

The Cocoa presenter consumes the same `invalidate()` stream but keeps a
**visual** per drawn node — lazily, only for nodes that draw something —
and on flush syncs dirty nodes into layer properties inside one
`CATransaction` per frame, actions disabled by default. Layout runs
exactly as today (yoga, absolutize); frames are written from the yoga
rects. The commit pipeline becomes:

```
React commit → applyProps diff → invalidate(node)
  frame: yoga layout → for dirty nodes: visual.sync(node) → CATransaction commit
```

No damage rects, no paint walk, no paint cache, no scroll-blit ledger, no
`_outsideDamage` culling — that machinery is the X11 presenter's private
business. The style vocabulary maps almost embarrassingly well, which is
not a coincidence — both vocabularies are children of CSS:

| style prop                              | CALayer mapping                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `backgroundColor`                       | `backgroundColor`                                                                 |
| `borderRadius`                          | `cornerRadius` (+ `cornerCurve: continuous` — a native nicety X11 cannot offer)   |
| uniform `border*`                       | `borderWidth`/`borderColor`                                                       |
| per-edge border colors, `borderStyle`   | four edge sublayers, or the raster fallback for that node                         |
| `backgroundImage: linear-gradient(...)` | `CAGradientLayer` (the parsed spec from `decorations.js` feeds it directly)       |
| `boxShadow`                             | `shadowColor/Opacity/Radius/Offset` + **`shadowPath`** set from the rounded rect  |
| `zIndex`                                | `zPosition` (+ sibling order for equal z)                                         |
| `outline*` (focus ring)                 | one sublayer outside bounds                                                       |
| `overflow: hidden`/scroll clipping      | `masksToBounds` on the clipping node's layer                                      |
| scroll offset                           | `bounds.origin` on the clip layer — the whole scroll path                         |
| `:hover`/`:active`/`:focus` state block | property sets on one layer (exactly the "repaint of one node" they were built as) |
| `transition: { prop: ms }`              | `CATransaction` duration / `CABasicAnimation` — **runs in the render server**     |

The `shadowPath` row carries a scar worth transferring: issue #413 was a
blur re-run per composite that cost 700× and showed up in no request
count. CA has the same trap in the same place — a shadow without
`shadowPath` makes the render server derive the silhouette per frame —
and the fix is the same shape: hand it the geometry once. The presenter
sets `shadowPath` always, from the same resolved rect + radius the
border uses.

Nodes whose visual exceeds the property vocabulary do not fail — they
**degrade to raster per node**: the visual allocates a bitmap, replays
the node's paint through the CG-backed 2d context (translated so
`this.abs` lands at the layer origin), and sets it as `contents`. That
one rule carries `<canvas onDraw>`, `<svg>`, all seven of
`@react-x11/components`' registered elements, per-edge borders and any
future paint feature ahead of its layer mapping — correctness never
waits for a mapping, and mappings are pure optimization.

Two structural decisions inside Tier L, called out because they are easy
to get wrong:

- **Layer per drawing node, not per node.** A layout-only `<box>` (no
  background, border, shadow, clip, or scroll) materializes no layer;
  its children parent to the nearest ancestor with one, positioned by
  the already-absolute rects. A clipping or scrolling node always
  materializes (it _is_ the mask/viewport). This keeps the layer count
  proportional to visible painted content — the same quantity the X11
  path rasterizes — rather than to tree shape, and virtualized lists
  (`Table`, `monitor`) already bound visible content by construction.
  Whether collapsing is needed at all is a Phase-3 measurement
  (`CATransaction` commit cost vs. layer count), and the fallback of
  "every drawn node gets a layer" is the simpler first cut.
- **The node tree stays the source of truth for input.** Hit testing,
  capture/bubble, press chains, focus — all continue to run on node
  rects exactly as on X11. `CALayer hitTest:` is not used for dispatch.
  One event model, one set of tests, identical interaction semantics on
  both backends; the layer tree is write-only presentation.

Text in Tier L is a raster visual by default: the TextEngine's layout
(same object that measured for yoga) rasterizes into the node's layer
contents at `contentsScale`, so measurement and pixels cannot disagree.
`CATextLayer` (attributed strings, WindowServer-side re-raster on scale
change, animatable `foregroundColor`) is an _optional_ fast path for
static single-style text, adopted only if profiling says the raster
visuals' memory or update cost matters — it uses its own framesetter,
and two framesetters is one framesetter too many for anything
selection- or caret-bearing.

### Why the retained tier is the design target, in this project's terms

The project grades itself on input-to-photon, then stability, then client
CPU (AGENTS.md, [wayland.md](wayland.md) goals). Per scenario, against
Tier S on the same hardware:

- **Hover/press feedback** (`:hover`/`:active` blocks): Tier S repaints
  the control's rect into the bitmap and uploads; Tier L sets properties
  on one layer. Both answer on the input's frame; L does it with less
  work and _keeps doing it_ when the JS thread is busy mid-transition.
- **Scrolling a 500-row list**: S = memmove + strip repaint + upload per
  notch (the X11 fast path, minus the server doing the blit for us);
  L = one `bounds.origin` write. The entire class of scroll-blit gates,
  ledgers and bail conditions stops existing on this backend.
- **Transitions** (Switch thumb, hover fades): S = JS frame loop ×
  raster × upload for the duration; L = one animation handed to the
  render server, frame-perfect under JS stalls. This is the qualitative
  gap — no amount of Tier S optimization reaches "smooth while the app
  thread is blocked".
- **Window live-resize**: S re-lays-out and re-rasters everything per
  tick on the modal loop's cadence; L re-lays-out and updates frames —
  the WindowServer interpolates the rest. (Both need the run-loop work
  in §"Input and the run loop" to receive resize ticks at all.)
- **Typing**: equivalent — caret/selection damage is small either way;
  L still wins on retina by shipping properties instead of pixels.

And one honest cost column: Tier L pays **per-layer memory** for
rasterized contents (text bitmaps especially — X11's shared glyph atlas
has no direct equivalent; mitigations if measurement demands them: an
atlas texture behind `contents`+`contentsRect`, or `CATextLayer`),
**commit overhead** proportional to layers mutated per transaction (kept
off the NAPI floor by the batched-ops call in the addon API), and
**complexity in the visuals** (edge sublayers, gradient layers) that the
raster fallback bounds.

### Measure first — the gate between the tiers

Per the exploration brief's own instruction: the retained tier is built
because the model fits, but it is _kept_ because the numbers say so. The
macOS twin of `scripts/bench` (Phase 1 exit) runs the same scenarios —
hover storm, wheel scroll on the 500-row list, virtualized re-slice,
transition storm, typing — and reports, per scenario: wall-clock frame
time, **input-to-photon** (NSEvent timestamp → the display-link
timestamp of the frame containing the response; CA has no
presentation-time protocol, but a display link plus
`CATransaction.completionBlock` brackets it within a frame), CPU time,
and RSS. Tier S is the baseline; Tier L must beat it where the model
says it should (scroll, transitions, resize) and must not regress
typing or cold mount. If a scenario shows Tier S already saturating the
display's refresh with headroom on target hardware, that scenario's
Tier-L machinery (e.g. layer collapsing) is deferred — measured, not
assumed, in both directions. The numbers land in this document's
successor the way wayland.md carries its measurements.

## Windowing semantics: what maps, what bends, what breaks

| react-x11 today                                    | macOS                                                                                                      | verdict                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `<window>`, WM-managed                             | `NSWindow` (titled), delegate events for move/resize/close/focus                                           | maps; the app _can_ place itself (unlike Wayland)                           |
| `<window x y>` screen position                     | `setFrameOrigin` (flip Y against the screen frame)                                                         | maps                                                                        |
| auto-sizing (`width: 'auto'`)                      | measure first, then size the window before ordering front — same commit-phase shape as `realize()`         | maps cleanly                                                                |
| `<popup>` (override-redirect, self-placed)         | borderless non-activating `NSPanel`, `addChildWindow` to the anchor's window, screen-coordinate placement  | maps — `anchor.js` flip/clamp math survives against `NSScreen.visibleFrame` |
| `<popup grab>` dismissal                           | no pointer grabs; local+global event monitors, or key-window resignation                                   | bends — same UX, different mechanism                                        |
| `decorations: false`                               | `styleMask: [.borderless]` (or `.fullSizeContentView` for CSD-ish looks)                                   | maps                                                                        |
| `states`: maximized/fullscreen/minimized/attention | `zoom:`, `toggleFullScreen:`, `miniaturize:`, `requestUserAttention:`; readback via delegate notifications | maps; `sticky`/`below`/`skip_taskbar`/`shaded` have no equivalent           |
| `alwaysOnTop`                                      | `window.level = .floating`                                                                                 | maps                                                                        |
| `transientFor`                                     | `addChildWindow:` / sheets                                                                                 | maps for the dialog case                                                    |
| `wmClass`, `onClientMessage`, size-increment hints | —                                                                                                          | gone; bundle identity lives in Info.plist                                   |
| `transparent`                                      | `isOpaque = false`, clear background — always composited, no compositor probe needed                       | maps _better_; `useSupports('transparency')` is constant-true               |
| frame clock (Present + fence + estimator)          | `CADisplayLink` (macOS 14+) / `CVDisplayLink`                                                              | simpler; per-window, refresh-rate-aware                                     |
| scale ladder (env → XSETTINGS → Xft → RandR)       | `backingScaleFactor` + `windowDidChangeBackingProperties`                                                  | collapses to one authoritative, live source                                 |
| screens (`useScreens`)                             | `NSScreen.screens` + change notification                                                                   | maps                                                                        |
| appearance ladder                                  | `NSApp.effectiveAppearance` KVO + `NSColor.controlAccentColor`; accent-change notification                 | upgrades the existing osascript rung                                        |
| clipboard (selections, INCR, targets)              | `NSPasteboard` (+ lazy providers for the ownership model); no PRIMARY selection                            | maps; `transfer.js` MIME plumbing reusable; INCR dies unmourned             |
| DnD (XDND)                                         | `NSDraggingSource`/`NSDraggingDestination` on the hosting view                                             | maps; the `dropAccept`/`onDrag*` prop contract holds                        |
| global menu (D-Bus registrar, in-window fallback)  | `NSApp.mainMenu` — **always present**, delegation never fails                                              | maps _better_; see §Menus                                                   |
| file dialogs (portal → osascript → drawn)          | `NSOpenPanel`/`NSSavePanel` replace the osascript rung                                                     | upgrades                                                                    |
| a11y (AT-SPI over D-Bus)                           | `NSAccessibility` protocol, virtual `NSAccessibilityElement` tree fed from the same `a11y.js` model        | maps; the model carries, the bridge is new (the Chromium/Flutter shape)     |
| idle / keep-awake                                  | `IOPMAssertion` / `NSProcessInfo` activity                                                                 | maps                                                                        |
| startup notification, `activateWindow`             | `NSApp.activate`, `NSRunningApplication`; Launch Services owns launch UX                                   | mostly dissolves                                                            |
| URI schemes / single instance (`application.js`)   | Apple Events (`kAEGetURL`) + Launch Services registration; single-instance is the platform default         | maps; same hooks (`onAppOpen`/`onAppActivate`), new plumbing                |
| tray                                               | `NSStatusItem`                                                                                             | **gained** — X11 has no core tray today                                     |
| `<glarea>` (GLX / direct CGL)                      | `CAOpenGLLayer`/`NSOpenGLContext` (deprecated but functional), or ANGLE/Metal later                        | bends; ntk's existing `cgl` direct backend is prior art                     |
| `<foreign>`, XEmbed `<Frame>`, `examples/wm.jsx`   | —                                                                                                          | **gone by design**                                                          |
| `ssh -X` remoting                                  | —                                                                                                          | X11 backend remains the remote answer                                       |
| keyboard state (Caps Lock before first key)        | `NSEvent.modifierFlags` (static read + `flagsChanged`)                                                     | maps                                                                        |

The popup row deserves the same sit-down wayland.md gave it, with the
opposite conclusion: macOS _keeps_ client-side placement, so `anchor.js`
stays the single source of truth on this backend — the math that had to
move into Wayland's positioner stays exactly where it is here, reading
`NSScreen` geometry instead of Xinerama.

## Text: the engine contract

Everything the renderer needs from text goes through one object today —
`app.fonts.layout(spans, base, options)` returning a layout with
`{width, height, draw(ctx, x, y), indexAt(x, y), caretPosition(index),
rangeBands(...)}` plus font loading (`openFont`/`loadFont`) and glyph
queries. That interface _is_ the TextEngine contract; the macOS backend
implements it over CoreText:

- **Matching**: family list + weight/style/`fontVariationSettings` →
  `CTFontDescriptor`/`CTFontCreateWithName`, with the CSS generic
  families mapped to system faces (`sans-serif` → SF via
  `systemFontOfSize`, which also finally answers the fontconfig-on-macOS
  wrong-font issue #86 for this backend — the right fix on the native
  path is not having fontconfig in it at all). `opsz` behaves (SF's
  optical sizing is CoreText-native).
- **Shaping/wrapping/bidi/truncation**: `CTFramesetter` over an
  attributed string built from the same span list (spans map to
  attribute ranges — the nested-`<text>` model transfers directly).
- **Metrics for yoga**: the same framesetter answers `measureContent`,
  so measure and render cannot disagree. Whole-pixel answers, per the
  yoga content-floor rules.
- **Carets/hit/selection**: `CTLineGetStringIndexForPosition`,
  `CTLineGetOffsetForStringIndex`, line origins → `indexAt`,
  `caretPosition`, `rangeBands` — the `<textinput>`/selection surface,
  method-for-method.
- **Raster**: draw the frame into a bitmap for the node's layer
  (`contentsScale`-aware); glyph-run-level drawing
  (`CTFontDrawGlyphs`) backs the `drawGlyphs`/`positioned` context
  extensions the terminal and code-editor components use.

The glyph-run seams are part of that contract on both backends (issue
#432, over @windowkit/appkit 0.3's glyph natives — windowkit/appkit#1).
The face `fonts.match()` returns answers ntk's `glyphIdFor(cp)` (`null`
when unmapped), `advanceOf(id, size)` and `shape(text, size)` beside
`metrics(size)` — which reports ntk's `lineGap`/`lineHeight` alongside
CoreText's `leading` — and the manager answers `fallbackFor(cp, family,
opts)` off the app's loaded faces and then CoreText's cascade. The
context answers `drawGlyphs(op, src, positioned)`,
`createSolidPicture(r, g, b, a)` and `Render.PictOp.{Over, Src}` with
ntk's exact run contract, grouping the runs by face and size into one
`CTFontDrawGlyphs` per colour, so a renderer written against ntk's
context — `<Terminal backend="vt">` — runs unchanged. Three things
differ from ntk and are stated where they live: `shape()` runs the text
through the typesetter (`fontShapeText`), and a glyph from a run
CoreText substituted carries that face as `font`, which `drawGlyphs`
honours — so an emoji cluster in Menlo comes out as the emoji, where ntk
shapes `.notdef`; every op draws as Over, which for the opaque inks text
uses is what Src does too; and the transform scales glyphs as well as
their origins, because CoreGraphics draws text through the CTM like
everything else.

The alternative — reusing ntk's fontkit shaping stack on macOS and
rasterizing through the Wayland Tier-A span compositor — is recorded,
not chosen: it buys byte-identical metrics across backends (one test
suite, one wrap behavior) at the cost of client-side font matching
against the macOS font system (the exact pain #86 documents), no
system-font niceties, and a hard dependency on the Wayland renderer
workstream. The seam keeps it swappable if cross-backend metric parity
turns out to matter more than platform-correct text; the default is the
platform's own text system, matching how every other ladder in this
project prefers the platform's own answer.

Grayscale antialiasing (macOS dropped subpixel AA in Mojave) means
self-rastered text is not visibly second-class — the field's CPU-raster
toolkits look native on modern macOS.

**IME** is the reason to be on this text stack eventually:
`NSTextInputClient` on the hosting view, routed to the focused node's
composition events (`CompositionStart/Update/End` already exist in the
event vocabulary), gives dead keys, marked text and CJK input the way
the platform means it — the capability X11 issue #272 wants and cannot
yet have. Phase 5, but the view is written with the protocol stubs from
day one.

## Input and the run loop

Event mapping is mechanical — the normalized shapes already exist and the
dispatcher never sees platform structs:

- Mouse/wheel: NSEvent → `{x, y}` flipped to top-left (POC does this),
  buttons, click counts (`clickCount` → `detail`), `scrollingDeltaX/Y`
  with `hasPreciseScrollingDeltas` → the `smooth` wheel flag (macOS is
  the smooth-scroll platform; the wheel pipeline already handles pixel
  deltas), enter/exit via a tracking area, per-window routing by
  `windowNumber`.
- Modifiers: `modifierFlags` → `shiftKey/ctrlKey/altKey/metaKey`
  (⌘ = meta, ⌥ = alt — the DOM's own macOS convention, which the event
  API borrowed already).
- Keys: `keyCode` (kVK) + `characters`/`charactersIgnoringModifiers` →
  `keysym` (rule above), `codepoint`, `key`, `repeat`. The Latin-chord
  rule from `keyboard.js` (shortcuts keep working under a Cyrillic
  layout) is reimplemented from
  `charactersByApplyingModifiers:`/the kVK position map — same behavior,
  simpler source.

**The run loop is the one architectural risk in the whole plan**, so it
gets the full treatment. The POC's model — Node's loop is master, a
timer pumps `nextEventMatchingMask:` — works until AppKit runs one of
its internal modal loops (live window resize/drag, menu tracking,
drag sessions, panel runModal), which happen _inside_ the pump call: JS
is then frozen for the duration, timers queue, React cannot commit, and
only render-server animations keep moving. Three options, in ascending
order of invasiveness:

1. **Timer pump only** (POC today). Acceptable for the spike; input
   latency is the timer cadence; modal loops starve the app. Not
   shippable as the default.
2. **Timer pump + a libuv drain inside AppKit's loops** — install a
   `CFRunLoopObserver`/source that runs
   `uv_run(uv_default_loop(), UV_RUN_NOWAIT)` (plus microtask
   checkpoint) each cycle of _whatever_ run loop is spinning. AppKit's
   modal loops then keep Node alive: React commits during live resize,
   menu items update while a menu is open, timers fire. This is the
   standard libuv embedding recipe pointed the other way, and it is
   bounded addon work. The risk to design for is re-entrancy — JS
   running from inside a native frame that a JS call started — which the
   addon guards with an in-pump flag (no nested drains) and by keeping
   drains off the pump's own cycle.
3. **Full inversion** — `[NSApp run]` owns the process, libuv embedded
   as a slave (the Electron shape: watch `uv_backend_fd` on a helper
   thread, wake the main loop, drain there). Most correct, most
   invasive; not needed until proven needed.

**Decision: build 2, keep 1 as the fallback switch, hold 3 in reserve.**
Exit criterion for Phase 0: during a live window resize, a React
state-driven relayout visibly tracks the drag — that single demo proves
the drain works where it matters most.

The frame clock rides the display link: `requestAnimationFrame`
callbacks fire on link ticks, commits wrap in explicit `CATransaction`s,
and the "answer the input" early-flush (`flushPendingFrames` on handler
unwind) maps to committing the transaction before the pump returns to
AppKit — same policy, new mechanism. What runs today is the timer pump
with a frame interval over it (`frameInterval`; by default the period of
the display each window is on, as `listScreens` reports it — 8.3ms on a
120Hz panel, 16.7 on a 60Hz monitor — and the gate is the interval less
half a pump, so a frame lands on the first tick at or after it rather
than alternating between the tick before and the tick after), discrete
input and the wheel flushed on the event, and a window that is not on
glass deferring its frames — see "Measured" below for what each of those
was worth.

## Native controls

House rule applied: **default native, seam out.** On the Cocoa backend
core controls render with AppKit's own pixels; interaction, focus,
keyboard and a11y semantics stay the shared implementation (the
"answer-the-input" press model is behavior this project considers part
of its identity, and AppKit's own controls would take it over
wholesale — different focus ring timing, different keyboard rules,
different event routing — which is why real `NSView` controls embedded
in the layer tree are _not_ the mechanism).

The mechanism is the POC's proven one: **offscreen NSCell/control
rendering into cached images** (the WebKit/Gecko technique), keyed
`(kind, size, state, appearance, accent)`, nine-slice-stretched via
`contentsCenter` where the bezel allows, set as the control node's layer
contents. Push buttons (including the accent-filled default button),
checkbox, radio, popup, slider knob/track, switch — all render today in
both appearances with pressed/on states.

Wiring, shaped as theme policy rather than per-widget forks:

- `ThemeProvider` grows `controls: 'native' | 'drawn'` — default
  `'native'` on the Cocoa backend, `'drawn'` (and the only legal value)
  on X11. Per-instance escape hatch: `native={false}` on a control for
  the odd custom-branded button. A drawn control on macOS keeps today's
  themed rendering, so custom-designed apps lose nothing.
- Components keep their exact public contracts (`checked`/`onChange`,
  the `changeEvent` shape, `useControl` states) and swap only the
  _bezel_: where the drawn variant renders well/track/thumb boxes, the
  native variant renders a bezel-image node sized by the cell's natural
  metrics. Hover/press/focus continue to drive it — pressed bezels are
  re-keyed images, and the press state still lands on the press frame.
- The palette gains a macOS system theme whose tokens read semantic
  `NSColor`s (accent, text, separators) so _drawn_ content — cards,
  tables, custom widgets — sits harmoniously beside native bezels, and
  the desktop accent reaches `theme.accent` on this backend through the
  same explicit adoption rule as on Linux.
- Text controls stay drawn everywhere for now: `<textinput>`'s editing
  model (undo, selection, caret cadence from desktop settings) is deep
  shared behavior, and a native `NSTextField` would fork it. The native
  win for text is IME (§Text), not the bezel.
- `NSSwitch`'s knob animation: the native bezel pair + the existing
  `transition` on the thumb reproduces it; if fidelity disappoints, the
  switch is the one control worth revisiting as a real view. Menus and
  popover _panels_ are never bezel-rastered — their vibrancy needs
  private API; they go native for real (§Menus) or stay drawn.

`useSupports('nativeControls')` reports the capability so component code
and apps can branch the way `'shaders'` consumers already do.

## Menus: the global menu, finally at home

The Linux global menu was built for exactly this moment: the item
vocabulary is data (dbusmenu's), `MenuBar` draws the same array it
exports, and the pure `snapshot`/`diffSnapshots`/`IdAllocator` machinery
in `dbusmenu.js` produces stable ids and structural-vs-property diffs
with no D-Bus in sight. The macOS adapter consumes precisely that:

- `snapshot(menus)` → build/patch an `NSMenu` tree; `IdAllocator` ids
  key an `NSMenuItem` cache across re-renders; `diffSnapshots` decides
  patch-in-place (title/enabled/state) vs. rebuild (structure).
  `itemProperties()` is the one function swapped — dbusmenu props out,
  `{title, enabled, hidden, state, keyEquivalent(+mask), submenu}` in.
- Item activation carries the id back; `itemFor(id).onSelect` fires —
  the same contract the registrar path has.
- `useGlobalMenu` on this backend **always delegates** — the fallback
  drawn bar (`if (delegated) return null` in `MenuBar`) simply never
  renders, and `onGlobalMenuChange(true)` reports it. No registrar
  probing, no liveness rules: the menu bar is a platform constant.
- macOS requires the standard skeleton — the application menu
  (About/Preferences/Hide/Quit), Edit, Window — which the adapter
  synthesizes around the app's menus by default (the main customer
  ships a Mac-correct menu bar with zero configuration), with the
  app-menu items reachable as props for the apps that name their own
  (`about`, `preferences` handlers). `editmenu.js`'s item set feeds the
  standard Edit menu so text controls get theirs.
- **Accelerators invert.** On X11 the app window matches chords itself;
  in `NSMenu` the key equivalent belongs to the item. The adapter maps
  chords → `keyEquivalent` + modifier mask, and `useMenuAccelerators`
  disarms for delegated bars (it already re-anchors on delegation — the
  macOS case is "never arm"). The chord grammar gains one token:
  **`Primary`** — ⌘ on macOS, `Control` elsewhere — because
  `[['Control','S']]` written literally would demand ⌃S on a Mac.
  `matchesShortcut`/`useAccelerator` accept it too, so non-menu
  shortcuts follow the same convention. Existing menus keep working;
  examples and docs move to `Primary`.
- `ContextMenu` defaults to a native `NSMenu` popup on this backend
  (same adapter, `popUpMenuPositioningItem:`), with the drawn popup as
  the seam (`native={false}`) — the drawn one exists, works, and some
  apps will want visual consistency with custom themes. Note the native
  menu runs a tracking loop: run-loop option 2 is what keeps React
  alive while it is open (menu-item enablement updating live is the
  test).

## Custom drawing on a layer tree

The escape hatches all reduce to one rule stated in Tier L: **a node
whose content is painted code gets a raster visual** — a bitmap-backed
layer, the CG canvas2d context translated to its box, redraw on the
node's own damage claims, `contentsScale` from the window. A claim that
names the node re-rasters that node; a bare rect — an element's
`invalidate(false, rect)` for the box a dragged item moved through, the
region `scrollContents` shifts, the strip an animation ticks in —
repaints every raster visual whose ink it touches, the same
conservative answer the damage model gives a rect on X11 — and only that
part of each: the raster keeps its bitmap as the visual's composition
cache, the pass clears and clips to the claim, and `paintDamage()` names
it, so an element culls a drag step or an animation tick the way it does
on X11 instead of replaying its whole scene into a clip.

- `<canvas onDraw>`: `paintContent` runs against the CG ctx; a new
  `onDraw` closure invalidates the node (existing rule); `putImageData`
  keeps its absolute-coordinates contract via the same `info.x/y`.
- `cacheKey`/`mono`: the pattern transfers — keyed bitmaps shared
  across canvases; `mono` renders an alpha-only mask once per
  (name, size) and tints per ink via `CGContextClipToMask` + fill, so
  the a8-coverage economics survive (ink stays out of the raster key).
- `registerElement` + `Node.paint(ctx)` subclasses (all seven components
  elements): work unchanged through the raster visual. An element that
  overrides `paint` — `super.paint(ctx)` for the box, then its scene —
  has its content nowhere but in that override, so the raster replays
  the override itself, with the child walk held back (the children have
  visuals of their own). The `Context2D` dialect the consumers exercise
  — including `fillRects`, `drawGlyphs`, `positioned`, `layoutSubtree`,
  `vw/vh/em` — is part of the ctx contract on both backends.
- `ntk.Surface` offscreen allocation (charts, terminal, flow): the Cocoa
  app object supplies one. `app.createSurface(options)` answers ntk's
  `Surface` contract over a CG bitmap (`src/cocoa/surface.js`, issue
  #433), and `react-x11/ntk`'s `Surface` asks the app it is handed before
  falling through to ntk's pixmap, so a component allocates its buffer
  the same way on both backends. `getContext('2d')` is the CG context,
  `copyWithin` is one in-place copy of the surviving band (the bridge's
  `scrollSurface`, ntk#252's exact contract, clamp for clamp), and
  `ctx.drawImage(surface, …)` is one `CGContextDrawImage`. Sized in
  device pixels like the window's backing store. Two things differ from
  ntk and are stated where they live: a bitmap has one graphics state,
  so a surface has one context for its life (`destroy()` on it is a
  no-op) and `render()` brackets its callback in save/restore from the
  identity; and `format: 'a8'` throws — the coverage surfaces the paint
  cache and the shadows use stay on their X path until a consumer needs
  them here. The subpath's other drawing-adjacent names
  (`cssColorStraight`, `decodeImage`, `Image`) are pure JS already;
  `Image` as a `drawImage` source is not wired on this backend yet, and
  the X-only names stay X-only.
- `<svg>`: the declarative vocabulary (`SvgChildNode`) is portable; the
  rasterizer behind it renders through the same CG ctx.
- A future, deliberate seam — not built until a consumer needs it:
  `registerElement({ visual })`, letting an element supply a
  layer-aware visual instead of raster (a chart that wants its series
  as shape layers, say). The raster default means nobody _has_ to.

## Animations and transforms: the API the model unlocks

The existing declarative vocabulary is the seam: `transition:` and
`animation:` in styles. On X11 they run on the frame clock (JS
interpolation, repaint per frame — including the premultiplied-lerp
rule). The Cocoa presenter maps the same declarations to
`CATransaction`/`CABasicAnimation` on the affected layer properties, and
the render server interpolates. Semantics to pin when this lands
(Phase 5): timing-function parity, transition-interrupt behavior
(CA's additive animations vs. the JS loop's retargeting), and the
completion moment `onStatesChange`-style code can observe. Until then,
the JS frame loop works on Cocoa too — correctness first, offload as the
measured upgrade.

Two style capabilities currently rejected everywhere become cheap on
layers and are proposed as **capability-gated additions** rather than
macOS-only forks, keeping one style vocabulary:

- **`opacity`** — free on a layer (`opacity`); on X11 implementable as
  group-raster through an ntk `Surface` at composite time (bounded,
  cacheable). Ship on both, the X11 cost documented.
- **`transform`** (2D: translate/scale/rotate) — free on a layer;
  XRender pictures do transform, so a bounded X11 story exists for
  leaf-ish content even if the general case (transformed subtrees with
  events) is deferred. Proposed staged: layer backend first behind
  `useSupports('transforms')` + an `@supports` style block, X11 catch-up
  or documented divergence decided by real demand.

Both wait until the presenter exists; they are listed because "hardware
composited layers with animation and transformations" is half the reason
to build Tier L, and the API shape (style props + capability gates)
should be agreed before someone builds a macOS-only thing.

## Public API: what changes

Measured against both consumers, the surface holds; the deltas are
additive or mechanical:

1. **Backend selection.** `createRoot()` gains
   `backend: 'x11' | 'cocoa' | 'auto'` (default `'auto'`: Cocoa on
   darwin when the bridge is installed, else X11 via `$DISPLAY`;
   `REACT_X11_BACKEND` overrides for A/B). Backend-specific options
   stay flat but documented per backend (`display`/`stream`/`glxVisual`/
   `glPolicy` are X11's; an unknown-to-this-backend option throws with
   the usual corrective error). `createRoot({ app })` keeps working and
   is how tests inject mocks of either flavor.
2. **Capabilities.** `useSupports` grows `'nativeControls'`,
   `'globalMenu'`, `'transforms'` (when built) beside `'transparency'`
   and `'shaders'`; same store-and-settle semantics.
3. **Inert props policy** (wayland.md open question 1, now decided the
   way it leaned): same JSX everywhere; a prop with no meaning on this
   backend (`wmClass`, `xi2`, `onClientMessage`, X-only states) is
   inert with a one-time dev-mode note naming the backend — not a
   throw, so shared app code stays branch-free.
4. **Keysyms are the key vocabulary**, formally: documented as
   react-x11's own symbolic key codes (X heritage acknowledged), with
   the Cocoa input layer synthesizing them. No consumer changes.
5. **Chord grammar** gains `Primary` (§Menus). Existing tokens keep
   their literal meanings.
6. **Test harness**: `renderX11(..., { backend })` namespace gains
   `'cocoa'` (real, windowed) and `'cocoa-mock'` (headless presenter
   recorder); existing names untouched. `toPNG`/`pixelAt` on Cocoa read
   the window snapshot. Pixel _hashes_ are per-backend by construction
   (CoreText raster ≠ ntk raster); cross-backend assertions compare
   structure and behavior, not bytes.
7. **Packaging.** `node-calayers` publishes as its own package — a
   freestanding, toolkit-agnostic Cocoa bridge (its README already
   documents the host-config mapping for any reconciler), `os:
["darwin"]`, prebuilds for arm64/x64, N-API (which keeps the Bun
   door open; verify in Phase 1). react-x11 references it as an
   `optionalDependency` exactly as it does `dbus-native`: absent on
   Linux installs, absent even on macOS if the user skips optional
   deps — and `backend: 'auto'` then falls back to X11 with a
   diagnostic. The Cocoa backend code itself lives in-repo
   (`src/cocoa/…`), not a separate package: one repo, one test suite,
   one release train, the same reasoning wayland.md's open question 2
   leaned to.
8. **The name.** Nothing in this design _requires_ renaming `react-x11`,
   and both consumers import it by that name today. But this RFC is the
   moment the name becomes descriptive of one backend out of three
   planned, and pre-release is the last cheap moment to change it. The
   options are (a) keep it (Electron ships Chromium nobody renamed;
   the name becomes heritage), or (b) rename once, now, to something
   backend-neutral, with `react-x11` republished as an alias or left as
   the X11-flavored entry. **This document deliberately does not decide
   it** — it is a taste call for the maintainer — but it does say:
   decide before the Cocoa backend ships, because every README, example
   and import written after that multiplies the cost, and do not ship a
   compatibility alias _afterward_ (AGENTS.md's own shim rule).

## node-calayers: the required API

The contract to publish against — grouped, with the POC's coverage
marked. Mechanism only; policy stays in the renderer.

**App & run loop.** `initApp()`; `pump()` ✅; run-loop drain hook
(option 2: install/remove the libuv drain, with the re-entrancy guard)
🆕; display link per window (`onFrame(cb)` with timestamps, start/stop)
🆕; activation policy + `activate()`, app/dock name 🆕; termination and
`applicationShouldTerminate` routing 🆕; open-URL/open-file Apple Event
callbacks (for `onAppOpen`) 🆕.

**Windows.** create ✅ with style options (titled/borderless/panel,
non-activating, level, opaque/clear) 🆕partial; close ✅; title, frame
get/set in top-left global coords 🆕 (size ✅); min/max size, aspect 🆕;
zoom/miniaturize/fullscreen + state readback 🆕; `addChildWindow` 🆕;
delegate events — resized (live-resize ticks included), moved,
close-requested, key/main changed, backing-scale changed, screen
changed, miniaturized 🆕; `scale` ✅; snapshot ✅; per-window event
routing (window id on every event) 🆕; `requestUserAttention`,
`orderFront/out` 🆕.

**Layers.** create Layer/Text/Gradient/Shape ✅; `set(props)` for
frame/bounds/position/anchor, backgroundColor, cornerRadius (+
`cornerCurve`, `maskedCorners`), border, shadow (+ **`shadowPath`** 🆕),
opacity, zPosition, transform, `masksToBounds`, mask, `contentsScale`,
`contentsCenter`/`contentsRect`/`contentsGravity` 🆕partial;
`addSublayer` ✅ + **`insertSublayer(at/below/above)`** 🆕; remove ✅;
`bounds.origin` scroll offset (covered by `set`) ✅; **raw-buffer
contents upload** (premultiplied BGRA/RGBA + stride → layer contents,
ideally IOSurface-backed for no-copy) 🆕; image contents ✅; **batched
ops** — one call applying a serialized list of (layer, props) mutations
inside one transaction, so a big commit is one NAPI crossing 🆕;
transactions ✅ (`begin/commit`, duration, timing, `disableActions`,
completion callback 🆕); explicit animations ✅ (+ removal ✅,
`animationDidStop` callback 🆕).

**Drawing (raster fallback).** A CG bitmap surface object: create at
size×scale ✅, a canvas2d-compatible verb set over it ✅ (native-side,
one call per verb — CG covers the standard set; `fillRects` →
`CGContextFillRects` ✅; `drawGlyphs` → `CTFontDrawGlyphs` ✅), read and
write pixels ✅, hand to a layer as contents without a copy ✅
(`createSurfaceIOSurface` + `setLayerContentsIOSurface`), draw one
surface into another ✅ (`ctxDrawSurface`), shift a band in place ✅
(`scrollSurface`), copy rects between same-size surfaces ✅
(`copySurfaceRegion`). Still 🆕: a pattern fill (`createPattern`, which
`<Flow>`'s grid tiles ask for), radial gradients, a blend op for
`PictOp.Src`, and an explicit free (a surface goes with its handle's
finalizer). The alternative — rasterize JS-side and use the raw-buffer
upload — stays open; the API supports both so the choice can be
measured.

**Text.** measure ✅ → full layout object 🆕: build from span list
(attributed string), report lines/runs/origins, `indexAt`,
`caretOffset`, range rects, truncation/`maxLines`, draw-to-bitmap ✅ and
draw-into-surface 🆕, glyph-run access for `drawGlyphs` ✅
(`fontGlyphForCodepoint`, `fontGlyphAdvances`, `fontFallbackFor`,
`ctxDrawGlyphs` in 0.2.0, `fontShapeText` and `fontWithSize` in 0.3.0 —
windowkit/appkit#1);
font matching by family list/weight/style/variations → descriptor, and
loading app-supplied font files (`loadFont`) 🆕; `hasGlyph` ✅.

**Controls.** `controls.render` ✅ (push/default/checkbox/radio/popup/
slider/switch, states, sizes, appearance) — add: focus-ring state,
progress bars (bar/spinner), disclosure, natural-metrics query,
nine-slice insets per kind 🆕; `controls.isDark` ✅ → replaced by
appearance API below.

**Menus.** Build/patch NSMenu trees from an item list (title, enabled,
hidden, state/mixed, keyEquivalent+mask, separator, submenu, image?);
stable item handles for in-place patching; set as main menu; standard
app/Edit/Window skeleton helpers; context popup at screen point;
`onAction(id)`; `menuWillOpen` hook 🆕 (all new).

**Pasteboard.** read/write types (string, RTF?, file URLs, custom UTIs
mapped from MIME), change count polling, lazy provider callback 🆕.

**Drag & drop.** Begin drag session (image, items); destination
registration on the view with enter/over/exit/drop callbacks carrying
position + types 🆕.

**Screens & appearance.** `NSScreen` list (frame, visibleFrame, scale,
id) + change notification; `effectiveAppearance` (dark/light, high
contrast, reduce motion, accent + change notifications) 🆕
(replaces `appearanceIsDark` ✅).

**Cursors & misc.** Standard cursor set + hide/show (`setCursor`
parity) 🆕; `NSStatusItem` (tray; later) 🆕; open/save panels (later)
🆕; a11y virtual element tree (later, its own design) 🆕.

**Testing hooks.** `postMouseEvent` ✅ extended with modifiers, wheel,
key events 🆕; window snapshot ✅; a headless mode statement (CI:
windowed Aqua sessions on macOS runners are expected to work — verify
in Phase 1; the mock presenter keeps unit tests off the GUI entirely).

## The split: what the bridge owns, what the renderer owns

Written 2026-09-03 against react-x11 2.4.0 and `@windowkit/appkit`
0.3.0, when the question came up in the concrete form "if the bridge
grew a full canvas2d API, could it replace ntk on this backend
outright?" — with the retained tier's need to reach layers, and two
more backends on the horizon (Wayland at the canvas2d level, Windows
with primitives not yet chosen), to be held in the same design. The
answer is a division of labour, and it is mostly the one the code
already has.

**What is where today.** The bridge exports 36 `ctx*` verbs over an
opaque surface handle, 8 surface operations (create, IOSurface-backed
create and lookup, lock/unlock, size, copy rects between two surfaces,
scroll within one, hand to a layer), the CoreText natives, the layer
and transaction natives, windows, pasteboard, menu, controls, screens
and events — one N-API crossing per verb, no state, no policy. On top
of it `src/cocoa/` is ~4,500 lines: the canvas-shaped context (the
JS-visible state and the ntk dialect over the verbs), the text engine,
the layer presenter, the window with its IOSurface swapchain, the app.
What the cocoa path reaches ntk for is pure JS — colour parsing, the
shadow math, `SvgView`'s traversal, the image decoders, fontkit metrics
behind `openFont` — and no X object is constructed. So "replace ntk"
is already true in substance: on macOS ntk is a utility library and
the X implementation of the drawing dialect. The one ntk object a
consumer still handed the backend was `Surface`, and the fix for that
is dispatch (issue #433, `react-x11/ntk` asking the app), not a port.

**The dialect is the floor contract, and it lives here.** Every backend
implements canvas2d plus the ntk extensions — `fillRects`, `drawGlyphs`
with its run contract, `positioned`, Path2D as an argument to
fill/stroke/clip, the callback-shaped `getImageData`, `Render.PictOp`
numbering. That is react-x11's policy: it is what `nodes.js` and every
registered element paint against, X11 answers it through ntk's XRender
encoder, Cocoa through `CocoaContext2D` over CG verbs, Wayland will
through the `'2d-sw'` rasterizer [wayland.md](wayland.md) builds on
X11 first. The JS class stays in this repository rather than moving
into the bridge for three reasons. It is the dialect, and a dialect
defined in three repositories drifts three ways — every context fix
would become a floor bump, the way #434 cost a `^0.3.0` floor and a
lock regeneration for two natives. A wrapper that forwards to a **verb
table** is reusable by any addon that speaks the same verbs, so a
Windows addon over a Direct2D render target plugs in with no wrapper
changes at all, where a class inside `@windowkit/appkit` could never be
reused by Windows or Wayland. And the fake-bridge tests already pin it
here. The bridge's contribution is exactly the verb table — mechanism —
and that table is the native-addon contract to standardise:
`createSurface`/`surfaceSize`/`scrollSurface`/`copySurfaceRegion`/
`ctxDrawSurface`/`ctxGetImageData`/`ctxPutImageData` and the `ctx*`
verbs over an opaque handle. Cocoa's is `@windowkit/appkit`'s export
list as it stands.

**Layers are a ceiling, behind the seam that exists.** The bridge
speaks two vocabularies, raster (surfaces, verbs, text) and retained
(layers, transactions, shape and gradient layers, contents), and the
renderer chooses per window; the node model never learns which. The
retained presenter needs the raster vocabulary too — its Raster visual
replays a node's paint into a bitmap and hands the bitmap to a layer —
so canvas2d is what every backend must provide and layers are what a
backend may add, behind `noteInvalidate`, `presentFrame` and a null
`scrollRegion`: three feature-detected hooks, the X11 path
byte-identical. That is the whole integration surface, and it should
stay that size. The presenter does not move into the bridge (it
consumes the node model, which is policy), and there is no third,
hybrid mode: a node is either properties on a layer or a raster on
one, decided per node per frame.

**The channel is already node-granular.** `invalidate(layoutChanged,
node | null, reason)` reaches the presenter as `noteInvalidate(damage,
layoutChanged, reason)` — which node, what kind — and the X11 painter
is the one reducing it to rects. The layer presenter today collapses a
structural `null` into a walk of the whole tree, which is the measured
~40 ms per frame at ~1,500 nodes (the presenter bench's largest open
number). That is a presenter-internal fix — dirty-subtree pruning off
yoga's per-node layout flags and the `_reflowed` set, the same signals
the X11 path uses to keep layout dirt local — not a new channel. The
`reason` vocabulary already separates `'scroll'`, which is the
`bounds.origin` case.

**What is genuinely shared across the coming backends** is the
client-owned bitmap with double-buffered presentation. The window's
swapchain (`_ensureSurface`/`present`/`scrollRegion`/`noteFrameDamage`,
~120 lines) is written over five primitives — create, lock/unlock, copy
region between two surfaces, scroll within one, present — and a
Wayland `wl_buffer` pair, where the compositor holds the front buffer
until `release`, is the same shape (catch-up copy or buffer-age damage,
[wayland.md](wayland.md)); so is a Windows swap chain or DIB pair. The
offscreen `Surface` is the same family: written over `createSurface`,
`surfaceSize`, `scrollSurface` and `ctxDrawSurface` plus the wrapper,
behind the app seam (`app.createSurface(options)`), so a Wayland app
implements the seam over a CPU bitmap with its `'2d-sw'` context and
`copyWithin` is the memmove `scrollSurface` already is. Per backend,
then: Wayland's context is the JS rasterizer, so the dialect holds by
construction, and with no retained tier (`wl_subsurface` is too coarse)
`presentFrame` is absent and the X11 paint path runs verbatim over the
swapchain; Windows' two candidate primitive sets are exactly the two
vocabularies — a Direct2D target for the verb table, DirectComposition
visuals for a presenter — so it starts at the floor with the wrapper
and the swapchain reused and adds a composition presenter later behind
the same seam.

**In order, with the priority stated:** the existing two backends, X11
and Cocoa, become stable and performant before a third is started, so
the steps that serve them come first. (1) This section: the verb table
and the surface operations are the native-addon contract. (2) Issue
#433: `CocoaSurface` over that contract, the `createSurface` seam,
dispatch in `react-x11/ntk` — landed with this text. (3) The
presenter's dirty-subtree pruning, ahead of anything below because it
is the open number on a shipped backend. (4) Moving the context
wrapper and the swapchain under `src/backend/` with neutral names — when
a second native backend or Wayland actually starts, and not before: a
half-renamed tree is worse than either name. (5) Bridge growth stays
verb-shaped — a pattern fill for `<Flow>`'s grid tiles, radial
gradients, a blend op for `PictOp.Src` — and never a JS canvas class.

## Measured: the frame clock and the large tree

Written 2026-09-03 against react-x11 2.5.0 and `@windowkit/appkit` 0.3.0,
on an M1 Pro at 2x, from the stress scenarios `npm run bench:presenters`
grew for it — "state update → pixels" and "interaction → pixels" inside a
tree the size of an application screen (`--cells`, 1,200 labelled boxes:
3,662 nodes) — and the surface presenter, which is the default. The
numbers travel as well as any timing does; the ratios are the findings.

**What a frame cost, and what it costs now** (median flush unless said
otherwise; `cpu` is the process as a share of one core, driver ticks at
62.5Hz):

| scenario                                  | before                     | after                      |
| ----------------------------------------- | -------------------------- | -------------------------- |
| `tree` — one memoized cell per tick       | 1.25ms                     | 0.35ms                     |
| `tiny` — one of 5,000 cells (14k nodes)   | 7.2ms p95                  | 1.2ms p95                  |
| `multi` — 12 scattered cells per tick     | 11.9ms, 1,470kpx repainted | 2.8ms, 264kpx              |
| `press` — down/up, input → flush          | 4.3ms p50 / 10.2 p95       | 2.6ms p50 / 8.7 p95        |
| `scroll` — wheel notch, input → flush     | 15.2ms p50                 | 1.9ms p50                  |
| `resize` — a live tick, 40-tick drag      | 71ms, 2 full frames each   | 28ms, 1 frame + 1 catch-up |
| `occluded` — hidden window, cell per tick | 207 frames, 50% cpu        | 0 frames                   |
| `layout` — every cell reflows per tick    | 44ms (18fps)               | 44ms — see below           |

Five changes, each fenced by a test:

- **The paint reach is cached** (`Node._paintBoundsCache`, nodes.js). A
  bounded frame asked every subtree on the way to its rect whether it
  reached in, and each answer walked the subtree: a one-cell repaint cost
  the whole tree, linearly. The union is now kept until something that
  moves it announces itself — layout, a child list change, a style swap, a
  state flip, `invalidate` — with `REACT_X11_NO_BOUNDS_CACHE=1` as first
  aid. Shared with X11, and the protocol bench is unchanged by it:
  `test/paint-reach.test.js`.
- **The damage rect cap is the backend's** (`window.damageRectCap`). Four
  rects is what a pass costs the X server; a Cocoa pass is one CoreGraphics
  clip and a culled walk, so its window keeps sixteen — twelve components
  ticking at once paint their twelve rects instead of the box around them.
- **A resize tick is one frame** (`CocoaWindow._freshSurface`,
  `_routeGeometry`). Replacing the backing surface used to queue a second
  full frame behind the one already painting it, and the React-half flush
  was queued per event — and inside AppKit's resize loop no microtask runs
  until the drag ends, so a forty-tick drag ran eighty full frames on the
  mouse release: the freeze after a resize. A fresh surface now asks for a
  frame only when the flush that found it was bounded, and holds the
  present until that frame lands; the release owes at most one flush.
  `test/cocoa-frames.test.js`.
- **A live resize defers the content floors** (`_deferContentFloors`,
  nodes.js). The floors (#249) are three extra layout passes and their
  walks — 21 of the 44ms a relayout costs on this tree — and a drag calls
  the frame from inside every pointer move. A live tick lays out against
  the floors it has (exact along the main axis, a frame stale for wrapped
  text across it) and the first pump tick after the release measures once
  and lays out again: answer the input, then catch up. Only under
  `liveResizing`, which the Cocoa window reads off AppKit's flag and the
  pump clears; an X window never sets it. A content change mid-drag takes
  the measured path.
- **A window nobody can see owes nothing** (`CocoaWindow._visible`): frames
  for a window that is ordered out or miniaturized wait in the queue and
  its present waits with them; one catch-up frame when it is back. (A
  window entirely behind another application's window joined that rule in
  the pass after this one — see below.) The frame gate also moved from
  "one interval since the last frame" to
  "the first pump tick at or after it", which took a 16/24/16/24ms cadence
  to a steady 16 (52 → 56fps against the 62.5Hz driver), and the wheel is
  answered on the event like a press — AppKit already delivers scroll
  events at the display's rate, so that is once per refresh by
  construction.

The structural half of these numbers is a gate now:
`npm run bench:presenters -- --check` judges full-window frames, the share
of the window a cell repaints, frames per resize tick and frames for a
hidden window against `scripts/bench/presenters-gate.json`, and
`npm run bench:touched` runs it — with the X11 gates — only for a change
that reaches a hot path. CI's `bench-cocoa` job does the same on a macOS
runner.

**What was left, in order of what it cost** — the list that became #442,
and the pass below.

## Measured: after the frame-clock pass

Written 2026-09-03 against react-x11 2.5.0 and `@windowkit/appkit` 0.4.0
(windowkit/appkit#10, which shipped the bridge half of #442: `releaseSurface`,
every surface's bytes accounted to V8, `fps` on `listScreens`, and
`window-occlusion` events), same machine, same bench, the surface presenter.
Four of the six items are closed by it; the two that remain are the
renderer's own and are listed at the end.

| what                                                          | before                  | after                 |
| ------------------------------------------------------------- | ----------------------- | --------------------- |
| a 40-tick resize burst, no yield between ticks — rss during   | +572 to +655MB          | +12 to +14MB          |
| `anim` on the 120Hz panel                                     | 55.7fps, 32% cpu (16ms) | 113.5fps, 49% (8.3ms) |
| `hover` on the 120Hz panel, input → flush p50 / p95           | 7.2ms / 16.8            | 3.1 / 9.2             |
| `icons` — 300 mono icons re-tinted per tick, flush avg / p95  | 2.98ms / 3.35, 72% cpu  | 2.07 / 2.42, 67%      |
| `covered` — the big tree behind another window, cell per tick | a frame per tick        | 0 frames              |

- **The retired pair is released on the flip** (`CocoaWindow._releaseBacking`,
  `releaseSurface`). A resize tick allocates two window-sized IOSurfaces and
  used to leave the two it replaced to their handles' finalizers — which run
  on the event loop, and inside AppKit's resize loop the event loop does not
  run, so a drag held every pair it ever made until the release. The bridge's
  accounting alone (`napi_adjust_external_memory`) makes the collection
  prompt once the loop is back; the explicit free is what bounds the peak
  while it is not, which is the number in the table. The row is a script
  driving forty `setWindowFrame`s synchronously, the way the modal loop
  delivers them; the bench's `resize` cell yields between ticks and its rss
  column is collection noise either way now. `CocoaSurface.destroy()` and
  the layer presenter's rasters release the same way, and a bridge without
  the verb gets the drop it always had. `test/cocoa-frames.test.js`,
  `test/cocoa-surface.test.js`.
- **Each window paces itself on its own display** (`CocoaApp.frameIntervalFor`,
  `_frameDue`). The default interval is `1000 / fps` of the screen under the
  window's centre, re-read when it moves; `createRoot({ cocoa: { frameInterval
} })` still overrides it for every window. The frame queue keeps a clock per
  window, so a window on the 120Hz panel paints every refresh while one on a
  60Hz monitor paints every other pump tick. What it is worth is the `anim`
  and `hover` rows: twice the frames for half again the CPU, and input →
  flush halved, on the panel that can show it. One honest limit: the 8ms
  pump quantizes the cadence, so a 75Hz monitor (13.3ms) paints at 62.5fps
  — the gate is the interval less half a pump, and 9.3ms falls on the 16ms
  tick. `pumpInterval` is the seam; the display link (§"Input and the run
  loop") is the mechanism that would make the period exact.
- **A window entirely behind another application's window owes nothing**
  (`CocoaApp._routeOcclusion`, `CocoaWindow._visible`). AppKit's
  `windowDidChangeOcclusionState` arrives as `window-occlusion`; off, the
  window's frames wait in the queue and its present with them, exactly as an
  ordered-out window's do; on, the next pump tick runs one catch-up frame.
  `map()` resets the flag, since a show is a claim to be on glass and AppKit
  corrects it a pump later. The bench's new `covered` scenario opens a window
  of our own over the tree and is in the gate at zero frames. What is not
  free while covered is the React commit itself: the scenario's 41% CPU is
  `root.render` of a 3,662-node tree per tick, and no frame clock can take
  that.
- **The paint cache is on** (`paintCacheFor` accepts an app with
  `createSurface`; `PaintCache.coverage`). Entries are `CocoaSurface`s
  through `react-x11/ntk`'s `Surface`, composited with one `ctxDrawSurface`.
  This backend has no coverage surface, so a mono drawing is cached as
  argb32 with its colour in the key — `paintCached(ctx, box, ink)` now says
  which colour to paint in — one entry per colour rather than one for all of
  them, still one render per colour instead of one per cell per frame. A
  blurred shadow, whose blur is a pass over the mask, stays live. The `icons`
  row is the gain, and the larger cost left in that scenario is the React
  re-render of 300 unmemoized components. `test/cocoa-paint-cache.test.js`.
- **A pane's frame gate is real** (`CocoaPaneWindow.frameInFlight`). The
  early flush a discrete input gets (`flushPendingFrames`, src/frames.js) is
  safe because it is gated on the last frame having landed — that gate is
  what folds a burst into one paced frame — and the pane window answered it
  with a constant `false`. So every message the host had queued while the
  pane was busy painting got a full frame of its own: a forty-tick resize of
  `examples/frame.jsx`'s pane, whose frame costs 250–320ms, stepped through
  42 presents at 42 intermediate sizes and reached the final one twelve
  seconds after the drag had ended, each step the previous IOSurface
  stretched to the layer's new frame. A pane hears nothing back from the
  host, so a present now counts as in flight for one frame interval; the
  same burst is one frame at the size it ended on, plus the one the first
  message was answered with. `test/cocoa-frames.test.js`.

**What is left, in order of what it costs:**

1. **A full relayout of a large tree: 44ms at 3,600 nodes, 320ms at
   14,000.** Half of it is the content floors, a third is yoga through its
   JS binding (three measuring passes plus the real one, each a full tree
   of getters and setters across the wasm boundary), the rest is paint —
   1,200 rounded fills and 1,200 `CTLineDraw`s at about 4µs and 3µs each.
   The floors are the target: they are measured from scratch on every
   layout change, and an incremental version — per-subtree content
   signatures, so a padding change on a container re-measures nothing
   below it — is the change that would take a panel toggle or a theme
   switch on a big screen from 18fps to 40. Bounded, not small; it touches
   the passes `test/content-floors.test.js` pins.
2. **Nothing is drawn at a level of detail.** `tiny` shapes and draws 5,000
   five-pixel labels nobody can read. A box smaller than a pixel already
   costs one fill; text below a legible size could cost one strip. Not
   started, and the win is bounded by item 1 for the relayout half.
3. **The pump quantizes the frame period** (above): a display whose period
   is not a multiple of 8ms paints at the tick after it. A finer pump costs
   input polling; the display link costs the run-loop work §"Input and the
   run loop" describes.

## Testing

The strategy mirrors the X11 suite's shape rather than its mechanism:

- **Unit tier, headless, any OS**: `backend: 'cocoa-mock'` — the Cocoa
  presenter running against a recorded layer-op sink and a metrics-only
  TextEngine stub (the `mock-app.js` precedent). Asserts _which layer
  mutations a commit produces_ — the retained twin of the dirty-rect
  tests — plus all the shared behavioral tests, which run on the node
  model and don't care about the presenter.
- **Integration tier, macOS**: real windows on a runner's Aqua session;
  pixels via window snapshot; input via the posted-event path (the
  harness's `fireEvent` transport). Per-backend pixel baselines; the
  scenario-level structural assertions (find-by-color, behavior) shared.
- **The bench twin** (§Measure first) is part of the definition of done
  for the presenter, not an afterthought — the scroll and transition
  scenarios are the reason Tier L exists, so they are what fences it.

## The plan

Each phase has an exit that makes the next safe to start; the first two
run against today's renderer with no core changes.

- **Phase 0 — the bridge contract (node-calayers).** Close the POC gaps
  that block everything else: event modifiers + per-window routing +
  wheel/key posting, window delegates, `insertSublayer`, raw-buffer/
  IOSurface contents, batched ops, display link, run-loop drain
  (option 2), and the menu API skeleton. Publish 0.2.0 with prebuilds.
  _Exit: a demo app live-resizes with JS-driven relayout tracking the
  drag, and a native menu's items enable/disable from JS while open._
- **Phase 1 — the surface backend (Tier S).** `src/cocoa/app.js`
  implementing the ntk app/window/ctx/fonts contract; CoreText
  TextEngine v1; event mapping; `createRoot({ backend })` selection;
  `cocoa-mock` harness backend. Run the examples; port the test suite
  where the mock reaches. Build the bench twin and record Tier-S
  baselines, including input-to-photon. _Exit: `examples:widgets`,
  `tasks`, `form` fully interactive natively; suite green on
  cocoa-mock; baselines recorded._
- **Phase 2 — the presenter seam (X11-neutral refactor).** Extract
  paint/damage/flush into the X11 presenter behind the
  invalidate/flush contract; nodes keep model+events+layout. **Zero
  behavior change**, pinned by pixel gates, dirty-rect tests and
  `bench --check` on X11. _Exit: X11 suite and bench byte- and
  number-identical; the presenter interface documented in
  docs/extending.md terms._
- **Phase 3 — the layer presenter (Tier L core).** Visuals for
  box/text/image/canvas + raster fallback; clipping and scrolling via
  layer properties; popups as panels; `CATransaction` per commit.
  Measure against Tier-S baselines; apply the §Measure-first gates
  (layer-collapse and text-atlas work only where numbers demand).
  _Exit: the bench twin shows Tier L beating Tier S on scroll and
  transition scenarios and regressing none; examples run on layers;
  Tier S demoted to fallback/A-B switch._
- **Phase 4 — the platform (macOS services).** NSMenu global menu +
  `Primary` chords; native appearance/screens/scale/window-state;
  pasteboard clipboard; native control bezels behind
  `controls: 'native'`; native file dialogs; `useSupports` additions.
  _Exit: `examples:menu` is the system menu bar; `widgets` renders
  native bezels; appearance flips live without osascript._
- **Phase 5 — the deep integrations.** DnD; NSAccessibility bridge over
  the a11y model; IME via NSTextInputClient; transitions offloaded to
  CA (+ `opacity`, then `transform`, capability-gated); `<glarea>` over
  CAOpenGLLayer/ntk-cgl; tray via NSStatusItem; app lifecycle
  (open-URL → `onAppOpen`). Each is its own bounded design against a
  by-then-stable presenter. _Exit: per-feature; the a11y bridge's is
  VoiceOver reading the widgets example the way Orca reads it today._

## Open questions

1. **The name** (§Public API #8) — decide before Phase 4 ships anything
   user-visible.
2. **Layer granularity numbers** — layer-per-drawn-node is the bet;
   collapse thresholds and the text-atlas question are Phase-3
   measurements, and the §Measure-first gates decide them.
3. **Run-loop option 3** — is the drain (option 2) enough for menu
   tracking + live resize + drag sessions in practice, or does a real
   inversion become necessary? Phase 0/1 experience answers it.
4. **Transition semantics under CA** — retarget/interrupt parity with
   the JS loop needs a written spec before Phase 5 flips the default.
5. **Cross-backend text metrics** — accepted divergence (per-backend
   pixel baselines) vs. the shared-shaping option if component layout
   portability bites in practice.
6. **Bun on the Cocoa backend** — N-API under Bun is expected to work;
   verify early (Phase 1) since single-file packaging is a stated goal.
7. **`@react-x11/components` on Cocoa** — the seven registered elements
   should light up via the raster path untouched; the X-only corners
   (tray-host, embed, media-player embedding, `serverTime`) need
   per-module capability statements rather than silent absence.

## References

- [wayland.md](wayland.md) — the sibling RFC; shared inventory and the
  opposite rendering inversion.
- [remote.md](remote.md), [embedding.md](embedding.md),
  [globalmenu.md](globalmenu.md), [appearance.md](appearance.md),
  [filedialog.md](filedialog.md), [accessibility.md](accessibility.md),
  [events.md](events.md), [styling.md](styling.md),
  [extending.md](extending.md), [testing.md](testing.md) — the
  per-feature contracts this plan maps onto Cocoa.
- Apple: Core Animation Programming Guide; `CATransaction`,
  `CALayer.shadowPath`, `contentsCenter`, `NSTextInputClient`,
  `NSAccessibilityElement`, `NSDraggingSession`, `NSPasteboard`,
  `CADisplayLink` (macOS 14+).
- libuv — "Embedding libuv in other event loops" (the run-loop drain's
  recipe, pointed at AppKit).
- WebKit/Gecko form-control rendering via offscreen `NSCell` drawing —
  the native-bezel technique the POC reproduces.
- `node-calayers` POC — `~/tmp/node-calayers` (to be published; §"the
  required API" is its 0.2.0 contract).
