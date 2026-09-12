# A native macOS backend

**Status: shipped, and still being extended.** This began life as a research
RFC written 2026-09-01 against react-x11 2.2.1, and the backend it planned is
now in the tree: `src/cocoa/` is ~8,800 lines across 23 modules, the bridge
published as **[`@windowkit/appkit`](https://www.npmjs.com/package/@windowkit/appkit)**
(an `optionalDependency`, `^0.9.0` as of react-x11 2.11.0), and
`createRoot()` selects it **by default on macOS**. Where this document says
`node-calayers`, read `@windowkit/appkit`: that is what the POC was called
before it was published.

What has landed, against §"The plan" at the foot of this page: **Phase 0**
(the bridge contract) and **Phase 1** (the surface presenter, still the
measured default), then most of **Phases 4 and 5** — the system menu bar,
native control bezels, native file panels, notifications, appearance,
screens and scale, the pasteboard, drag and drop, `<glarea>` over CGL,
`NSStatusItem` and the Dock, Apple-Event app lifecycle,
`useSupports('nativeControls')`, and layer promotion for animation.

**Phase 2 did not happen, and that is the good news.** It proposed
extracting X11's paint/damage/flush into a presenter behind a formal
invalidate/flush contract, as an X11-neutral refactor pinned by the pixel
gates. What the code does instead is cheaper and safer: the surface
presenter _is_ the existing paint machinery, drawing into the window's
bitmap, and the seam is a handful of **optional hooks feature-detected on
the window object** — `presentFrame`, `noteInvalidate`, `scrollRegion`,
`animateNode`, `cancelNodeAnimation` (`src/cocoa/window.js`, read at
`src/nodes/animation.js`). A window that does not define them gets today's path
byte for byte, which is the guarantee Phase 2 wanted without the refactor
it asked for. Nothing is documented in `extending.md` terms because there
is no interface to document.

**Phase 3** is therefore partial rather than blocked: the full layer
presenter is real (`src/cocoa/presenter.js`, `CocoaLayerPresenter` — one
CALayer per drawn node) but stays behind `cocoa: { presenter: 'layers' }`
while §"Measure first" is open, and layer promotion covers the animation
case on the default path.

**Not built**, and honestly the interesting remainder: an `NSAccessibility`
bridge over the a11y model (on Cocoa `createRoot()` leaves the AT-SPI bridge
off and puts nothing in its place), IME through `NSTextInputClient`, a
`'cocoa'` backend for `react-x11/test`, `opacity`/`transform` as style
properties, and the `Primary` chord token. §"Open questions" is still live,
and the name question (§Public API #8) was answered by inaction: the package
is still `react-x11`.

The line counts and inventories below are measurements taken when this was
written, not estimates; where a companion number comes from
[wayland.md](wayland.md), it is cited rather than re-measured. Sections
titled "Measured:" were added as the work landed and each names the commit
it was measured at.

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
  assigns it. A `<foreign>` rendered here says so — one `onError`, no
  `onReady`, an empty box — and `useSupports('embedding')` is false, so a
  component can ask before rendering one (#531).
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

_Kept as written, because it is the record of what was de-risked before any
of this was built. The package is published as `@windowkit/appkit` now, and
every "known POC limit" at the foot of this section has since been closed._

`node-calayers` (then local, `~/tmp/node-calayers`) settles the risky
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
§"The bridge: the required API".

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

What Tier S cannot do, structurally: make scrolling cheap (the blit
becomes a `memmove` + upload), or exploit retina (2× is 4× the raster
and 4× the upload). It is a correct port with X11's cost model on
hardware that offers a better one. Offloading an animation it can — not
structurally, but for the few nodes that animate, which get a layer of
their own above the bitmap (§"Layer promotion" below, issue #483).

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

| react-x11 today                                    | macOS                                                                                                      | verdict                                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `<window>`, WM-managed                             | `NSWindow` (titled), delegate events for move/resize/close/focus                                           | maps; the app _can_ place itself (unlike Wayland)                                |
| `<window x y>` screen position                     | `setFrameOrigin` (flip Y against the screen frame)                                                         | maps                                                                             |
| auto-sizing (`width: 'auto'`)                      | measure first, then size the window before ordering front — same commit-phase shape as `realize()`         | maps cleanly                                                                     |
| `<popup>` (override-redirect, self-placed)         | borderless non-activating `NSPanel`, `addChildWindow` to the anchor's window, screen-coordinate placement  | maps — `anchor.js` flip/clamp math survives against `NSScreen.visibleFrame`      |
| `<popup grab>` dismissal                           | no pointer grabs; local+global event monitors, or key-window resignation                                   | bends — same UX, different mechanism                                             |
| `decorations: false`                               | `styleMask: [.borderless]` (or `.fullSizeContentView` for CSD-ish looks)                                   | maps                                                                             |
| `states`: maximized/fullscreen/minimized/attention | `zoom:`, `toggleFullScreen:`, `miniaturize:`, `requestUserAttention:`; readback via delegate notifications | maps; `sticky`/`below`/`skip_taskbar`/`shaded` have no equivalent                |
| `alwaysOnTop`                                      | `window.level = .floating`                                                                                 | maps                                                                             |
| `transientFor`                                     | `addChildWindow:` / sheets                                                                                 | maps for the dialog case                                                         |
| `wmClass`, `onClientMessage`, size-increment hints | —                                                                                                          | gone; bundle identity lives in Info.plist                                        |
| `transparent`                                      | `isOpaque = false`, clear background — always composited, no compositor probe needed                       | maps _better_; `useSupports('transparency')` is constant-true                    |
| frame clock (Present + fence + estimator)          | `CADisplayLink` (macOS 14+) / `CVDisplayLink`                                                              | simpler; per-window, refresh-rate-aware                                          |
| scale ladder (env → XSETTINGS → Xft → RandR)       | `backingScaleFactor` + `windowDidChangeBackingProperties`                                                  | collapses to one authoritative, live source                                      |
| screens (`useScreens`)                             | `NSScreen.screens` + change notification                                                                   | maps                                                                             |
| appearance ladder                                  | `NSApp.effectiveAppearance` KVO + `NSColor.controlAccentColor`; accent-change notification                 | the osascript rung already feeds accent + ink into the palette; in-process later |
| clipboard (selections, INCR, targets)              | `NSPasteboard` (+ lazy providers for the ownership model); no PRIMARY selection                            | maps; `transfer.js` MIME plumbing reusable; INCR dies unmourned                  |
| DnD (XDND)                                         | `NSDraggingSource`/`NSDraggingDestination` on the hosting view                                             | maps; the `dropAccept`/`onDrag*` prop contract holds                             |
| global menu (D-Bus registrar, in-window fallback)  | `NSApp.mainMenu` — **always present**, delegation never fails                                              | maps _better_; see §Menus                                                        |
| file dialogs (portal → osascript → drawn)          | `NSOpenPanel`/`NSSavePanel` replace the osascript rung                                                     | upgrades                                                                         |
| a11y (AT-SPI over D-Bus)                           | `NSAccessibility` protocol, virtual `NSAccessibilityElement` tree fed from the same `a11y.js` model        | maps; the model carries, the bridge is new (the Chromium/Flutter shape)          |
| idle / keep-awake                                  | `IOPMAssertion` / `NSProcessInfo` activity                                                                 | maps                                                                             |
| startup notification, `activateWindow`             | `NSApp.activate` + `makeKeyAndOrderFront:`, `NSRunningApplication`; Launch Services owns launch UX         | `activateWindow` **shipped** (`CocoaApp.raiseWindow`); startup dissolves         |
| URI schemes / single instance (`application.js`)   | Apple Events (`kAEGetURL`) + Launch Services registration; single-instance is the platform default         | maps; same hooks (`onAppOpen`/`onAppActivate`), new plumbing                     |
| tray                                               | `NSStatusItem`                                                                                             | **gained** — X11 has no core tray today                                          |
| `<glarea>` (GLX / direct CGL)                      | `CAOpenGLLayer`/`NSOpenGLContext` (deprecated but functional), or ANGLE/Metal later                        | bends; ntk's existing `cgl` direct backend is prior art                          |
| `<foreign>`, XEmbed `<Frame>`, `examples/wm.jsx`   | —                                                                                                          | **gone by design**                                                               |
| `ssh -X` remoting                                  | —                                                                                                          | X11 backend remains the remote answer                                            |
| keyboard state (Caps Lock before first key)        | `NSEvent.modifierFlags` (static read + `flagsChanged`)                                                     | maps                                                                             |

The popup row deserves the same sit-down wayland.md gave it, with the
opposite conclusion: macOS _keeps_ client-side placement, so `anchor.js`
stays the single source of truth on this backend — the math that had to
move into Wayland's positioner stays exactly where it is here, reading
`NSScreen` geometry instead of Xinerama.

## Desktop integrations: what an app does outside its own windows

The handful of things an app says to the desktop rather than draws — a file
dialog, a permission prompt, a drag to another app, a tray icon, a Dock badge,
a raise from a launcher. This is the survey of where each stands on the cocoa
backend, what already works (including the crude `osascript`/shell rungs that
need no bridge), and what is blocked on a native addition — each gap has a
`@windowkit/appkit` ticket for the bridge and a react-x11 ticket for the
consumer, so the work is tracked rather than rediscovered.

| integration                       | today on cocoa                                                                                                                                                                                                                                                                                                                                    | the better way (bridge gap)                         | tickets                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| **file open/save**                | **shipped** — `NSOpenPanel`/`NSSavePanel` as a sheet, the ladder's top rung (`docs/filedialog.md`)                                                                                                                                                                                                                                                | — (bridge 0.5)                                      | react-x11#461 → windowkit/appkit#14 (done)                      |
| **raise / app switcher**          | **shipped** — `activateWindow()` = `NSApp.activate` + order-front                                                                                                                                                                                                                                                                                 | —                                                   | this PR (`CocoaApp.raiseWindow`)                                |
| **deep links** (`useAppOpen`)     | **shipped** — Apple Events → `useAppOpen`/`useAppActivate`; Quit → the primary window's close request                                                                                                                                                                                                                                             | — (bridge 0.5)                                      | react-x11#465 → windowkit/appkit#18 (done)                      |
| **drag & drop** (external)        | **shipped** — `NSDraggingDestination`/`Source` behind the same `dropAccept`/`onDrag*`/`dragData` props                                                                                                                                                                                                                                            | — (bridge 0.5)                                      | react-x11#462 → windowkit/appkit#16 (done)                      |
| **clipboard**                     | **shipped**, text only — `useClipboard()` and the text controls' copy and paste, over `NSPasteboard.general` as `CLIPBOARD`. `PRIMARY` is X11-only, not a missing rung: nothing on macOS is filled by selecting, so selecting copies nothing, a middle click pastes nothing, and no other selection reaches the pasteboard (`docs/clipboard.md`)  | typed items, for a multi-flavour copy               | —                                                               |
| **system tray**                   | **shipped** — `useTray()` over `NSStatusItem` (the freedesktop half stays #353)                                                                                                                                                                                                                                                                   | — (bridge 0.5)                                      | react-x11#463 (macOS half of #353) → windowkit/appkit#17 (done) |
| **Dock badge / attention / menu** | **shipped** — `setBadge`/`useBadge` (LauncherEntry on Linux), `demands_attention` bounces, `useDockMenu`                                                                                                                                                                                                                                          | — (bridge 0.5)                                      | react-x11#464 → windowkit/appkit#15 (done)                      |
| **activation policy / app name**  | **shipped** — `createRoot({ cocoa: { activationPolicy, appName } })`                                                                                                                                                                                                                                                                              | — (bridge 0.5)                                      | react-x11#464 → windowkit/appkit#15 (done)                      |
| **permissions** (TCC)             | **shipped** — `usePermission()`/`requestPermission()` over the bridge; `openPrivacySettings` on any Mac                                                                                                                                                                                                                                           | — (bridge 0.5); Linux portals are #466's other half | react-x11#466 → windowkit/appkit#19 (done)                      |
| **notifications**                 | **shipped** — `notify()` over `UNUserNotificationCenter` in a bundle, `osascript` for a bare `node`; `org.freedesktop.Notifications` on Linux                                                                                                                                                                                                     | — (bridge 0.5)                                      | react-x11#469 → windowkit/appkit#26 (done)                      |
| **calendar** (EventKit)           | **shipped** — `useDesktopCalendarEvents()` over `EKEventStore`, an `osascript` child under XQuartz; Evolution Data Server on Linux                                                                                                                                                                                                                | — (bridge 0.8)                                      | react-x11#504 → windowkit/appkit#39, #40 (done); writes are #41 |
| **eyedropper** (`useEyedropper`)  | **shipped** — `pickScreenColor()` over `NSColorSampler`, the ladder's top rung (`docs/eyedropper.md`); the system draws the loupe out of process, so no Screen Recording grant of our own. A bridge before 0.9 has no rung at all — `supported` is false, and the X11 rung needs a pointer grab and a root read the cocoa `X` stub has neither of | — (bridge 0.9)                                      | react-x11#517 → windowkit/appkit#46 (done)                      |

Two of these have a **freedesktop counterpart worth having in core with no
bridge at all**, because they are D-Bus like the portal and the global menu
already are: the Dock badge (`com.canonical.Unity.LauncherEntry`, one signal
under the app's `.desktop` id) and the permission prompts (the per-device
portals — `org.freedesktop.portal.Camera`, `.Location`). Both are tracked on
the react-x11 tickets above so the cross-backend API is designed once.

The pattern for every rung here is `docs/filedialog.md`'s ladder: the desktop's
own mechanism where there is one, a crude shell-out beneath it, and a typed
"cannot do this here" at the floor — never a silent no-op.

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
  yoga content-floor rules. **A width offer of zero is the min-content
  question**, not a degenerate layout — it is how yoga measures the floor
  under `minWidth: 'auto'` — and CoreText cannot be asked it directly: its
  breaker makes progress whatever width it is given, so a paragraph offered
  zero (or a pixel) comes back broken _inside_ its words. So the engine
  breaks the text itself, at the UAX#14 opportunities of the same
  `linebreak` package ntk wraps with, and has CoreText shape and measure the
  result — one unbreakable run per line, whose widest is the longest word.
  Both backends therefore agree on where a line may break and on what a
  `<text>` in a flex item is allowed to shrink to
  (`brokenAtEveryOpportunity`, src/cocoa/fonts.js;
  test/cocoa-text-floor.test.js). **A paragraph that elides is asked a
  different question**, and the engine answers it here too: it has somewhere
  to put the text it cannot show, so its floor is the `…` it would end in
  rather than its longest word. Eliding needs a width, which the zero offer
  is not, so the cap and the cut are made in the text — the first
  `maxLines - 1` broken lines and then the mark, in the face of the run the
  cut fell in — and CoreText is asked for neither
  (`cappedToEllipsis`). Left to elide unbounded it keeps the line count and
  puts everything over it back on the last line, which floored every
  `textOverflow: 'ellipsis'` label at max-content and made it overflow
  sideways rather than give way.
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

**What happened instead.** Option 2 was never built: doing a frame's work
inside the delegate callbacks (`CocoaApp._afterInput`) met the exit
criterion without it, and option 1 is what ships. When the drain was finally
probed (2026-09-11) its re-entrancy risk turned out to be concrete rather
than theoretical — a `uv_run` nested under a JS call runs timers and never
drains the microtasks they queue — and the shape that removes both of option
1's costs on stock Node and Bun is a fourth one: AppKit keeps the main thread
in a real `[NSApp run]` and the JS moves to a worker. §"JS on a worker: a UI
thread of the bridge's own" below.

The frame clock rides the display link: `requestAnimationFrame`
callbacks fire on link ticks, commits wrap in explicit `CATransaction`s,
and the "answer the input" early-flush (`flushPendingFrames` on handler
unwind) maps to committing the transaction before the pump returns to
AppKit — same policy, new mechanism. What runs today is the timer pump
with a frame interval over it (`frameInterval`; by default the period of
the display each window is on, as `listScreens` reports it — 8.3ms on a
120Hz panel, 16.7 on a 60Hz monitor — with a frame that falls between
two pump ticks given a one-shot timer of its own, so the period is the
display's whatever the pump's cadence — and, since the frame pacer, a
frame asked for between two ticks armed on the spot rather than looked at
by the next tick), discrete input and the wheel flushed on the event, and
a window that is not on glass deferring its frames — see "Measured" below
for what each of those was worth.

What the clock cannot know is whether a frame is worth painting. It has no
fence: the X11 frame waits for the server to consume the last one, and a
window fed off an input path — a streaming terminal — self-paces to what
the server can composite; here the "server" is CoreGraphics on the JS
thread and the frame is due whenever the display is, so the same window
paints every refresh and the thread paints screens nobody reads. That is
`frameRate`'s job ([elements.md](elements.md#framerate--pacing-the-frames-under-a-flood),
[architecture/frame-pacing.md](architecture/frame-pacing.md)): a window
under `'adaptive'` holds a claim while its recent frames have spent more
than their share of the thread, priced by what the flush _and the present_
cost — `CocoaWindow.present` reports the flip and its catch-up copy back
to the node, because a damage-sized memcpy per frame is a millisecond the
flush never saw. Off by default; `cocoa: { frameInterval }` stays the
clock's own cap over everything on it.

## JS on a worker: a UI thread of the bridge's own

The run loop above leaves two costs standing, and the Windows PRD names
them: input waits for the pump, and a modal loop freezes Node
([windows.md](windows.md#what-the-cocoa-backend-does-and-what-it-costs)).
Its answer on Windows is a UI thread of the addon's own — one thread creates
every window and runs every modal loop, JS stays on Node's thread, and events
cross through a `napi_threadsafe_function`
([windows.md](windows.md#three-shapes-on-windows)). Win32 allows that because
a window belongs to the thread that created it. AppKit does not: an
`NSWindow` made anywhere but the main thread is an exception that ends the
process — `createWindow2` called from a worker aborts with _"NSWindow should
only be instantiated on the main thread!"_

So on macOS the same shape runs with the roles swapped. **The UI thread is
the process main thread, parked in a real `[NSApp run]` for the life of the
app, and the renderer — React, layout, painting, CoreText — moves to a
`worker_threads` Worker.** The rest of the Windows design carries over
unchanged: the three rules that keep two threads from deadlocking
([windows.md](windows.md#the-rules-that-keep-it-from-deadlocking)), one
wake per frame for commands, events in batches, and the bounded resize
handshake ([windows.md](windows.md#resize-where-the-threads-meet)). The
bridge's half is filed as
[windowkit/appkit#49](https://github.com/windowkit/appkit/issues/49),
with the probe's code.

### Why the JS has to leave the main thread

Options 2 and 3 above keep the JS where it is and run libuv from inside
AppKit's loops, and both nest: the addon is only ever entered from JS, so a
`uv_run` it starts from inside `[NSApp run]` runs under the JS call that got
it there. The probe below pumped the main thread's own loop that way, from a
common-modes timer: the main thread's `setInterval` callbacks fired, three of
three, and **none of the microtasks or next-ticks they queued ever ran**.
Node drains them when the outermost callback scope closes, and a scope opened
under a JS call is never the outermost — the failure
[#484](https://github.com/sidorares/react-x11/pull/484) found inside the
pump, now for every callback. An inversion that does not nest needs whoever
owns `main()` to own the outer loop, which is why Electron patches libuv and
NodeGui ships a forked Node; and Bun has no libuv loop to embed at all. On
stock `node` and `bun`, a worker is the shape that frees the JS.

A worker wakes on the same kind of threadsafe call, and its deliveries are
outermost: a microtask queued inside one ran 0.01–0.02 ms later (p50), so a
handler's `setState` commits on the event that caused it.

### Measured: the probe

2026-09-11, Apple M1 Pro, macOS 15.2, Node 26.0.0 and Bun 1.4.0, react-x11
at e372289. The probe is an addon of its own, about 600 lines, in the shape
proposed here: a command queue drained by a version-0 `CFRunLoopSource` in
`kCFRunLoopCommonModes`, events out through one threadsafe call per wake
with motion folded, a layer-hosting window like the bridge's, and the
bounded resize wait. Its worker ran a 5 ms timer and posted a layer change
every 16 ms through every phase.

|                                               | today: the 8 ms pump                        | the probe: JS on a worker                                                |
| --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| an event reaching JS                          | waits for the next tick, 0–8 ms             | 0.02 ms p50; p95 0.13 ms idle, 1.3–1.8 ms inside a modal loop            |
| JS through menu tracking                      | frozen — a drag held a 25 ms timer for 31 s | the 5 ms timer's worst gap: 14.0 ms                                      |
| JS through an `NSAlert`'s `runModal`          | frozen                                      | 9.7 ms                                                                   |
| JS through a live resize                      | only the delegate callbacks run             | 12.5 ms                                                                  |
| a layer change posted by JS                   | inline                                      | applied 0.02 ms later, p50, whatever mode the run loop is in             |
| a frame at the new size, during a live resize | same thread, same call                      | 39 of 39 ticks inside a 50 ms wait; waited 3.1 ms p50 for 3 ms of layout |
| the main thread busy for 300 ms               | JS frozen                                   | JS timers unaffected, worst gap 6.1 ms                                   |
| JS busy for 200 ms                            | every window frozen                         | windows live; the 10 events JS missed arrive as one batch                |

Layer changes landed inside the menu's `NSEventTrackingRunLoopMode` (72 of
them) and the alert's `NSModalPanelRunLoopMode` (75), which is what a
source in the common modes buys. The shipped bridge, loaded in a worker,
answered the rest of the design's questions: all 182 verbs load, CoreGraphics
drawing with readback and CoreText work from the worker, `createWindow2`
aborts, and `measureControl` with `drawControlIntoSurface` draws correct
pixels and then segfaults the process at exit — bezels stay on the UI
thread.

What the probe did not show: a hardware live resize (it posts mouse events
into the same tracking loop), a real drag session (a real `beginDrag` holds
the pointer for about 30 seconds), or anything on glass, which this
machine's session cannot capture.

### Who owns what

| thread                    | owns                                                                                                                                                                                                                                                                                                   | reaches the other by                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| the main thread — UI      | `NSApplication` and its delegate; every `NSWindow`, view and panel and their delegates; the menu bar, the Dock, status items; the cursor; the pasteboard; drag sessions, file panels, the colour sampler; control bezels; the `CATransaction` that applies each frame's layer changes; the resize wait | batched events through one threadsafe function per environment; state it publishes under a lock |
| the worker — the renderer | React, layout, the node tree; CoreGraphics into IOSurface-backed surfaces; CoreText and fonts; `<glarea>`'s CGL context                                                                                                                                                                                | commands queued to the UI thread, one wake per frame                                            |

Pixels stay on the worker, and they are most of a frame. What crosses is
the frame's layer changes, as one batch the UI thread applies in one
transaction — one commit, so the frame and a resized window's geometry
can land together, which a commit of the worker's own could not promise.
EventKit, notifications, permissions and the colour sampler already answer
through threadsafe functions from queues of their own and follow whichever
environment calls them.

### The bridge's half

[windowkit/appkit#49](https://github.com/windowkit/appkit/issues/49)
is the proposal, in five parts:

- **The threading core**
  ([#50](https://github.com/windowkit/appkit/issues/50)):
  `runMain()`, the command queue, events built as plain records on the UI
  thread and made into JS values on the worker, published state, exit
  through `runMain`'s return value, signals forwarded. Pump mode stays, and
  one verb body serves both: parsed on the calling thread, run inline on the
  main thread and queued from any other.
- **The AppKit verbs**
  ([#51](https://github.com/windowkit/appkit/issues/51)):
  of 182, the surfaces, drawing, layouts and fonts stay on the calling
  thread untouched; the rest become commands, handles allocated at the call,
  published reads, or answers that arrive later.
- **Frames across the boundary**
  ([#52](https://github.com/windowkit/appkit/issues/52)):
  one batch of layer changes per frame, and IOSurface buffers that change
  hands by event, because the flip now happens when the UI thread applies
  the batch rather than when JS asks for it.
- **The live-resize handshake**
  ([#53](https://github.com/windowkit/appkit/issues/53)).
- **Control bezels on the UI thread**
  ([#54](https://github.com/windowkit/appkit/issues/54)),
  answered asynchronously with `BezelStore`'s cache in front.

The bridge is closer to this than its synchronous API suggests. Everything
AppKit asks it synchronously is already answered from state the renderer set
earlier — the drop response, the drag source's masks, the Dock menu,
`windowShouldClose:` (always no, with a close request to JS) and
`applicationShouldTerminate:` (always cancel, with a quit request) — which
is rule two of the Windows design, followed before it was written down.

### The renderer's half

Threaded mode is the default on macOS: `node app.js`, `bun app.jsx` and
`tsx app.jsx` run the app on a worker, with nothing in the app or on the
command line asking for it. It needs a bridge with `runMain()`,
@windowkit/appkit 0.10. What it costs at startup, and how to skip it, is in
[packaging.md](packaging.md#on-macos-the-app-moves-onto-a-worker).

- **The move** (`src/cocoa/relaunch.js`, reached from `src/bootstrap.js`,
  the first import of `src/index.js`). An entry's imports finish before its
  body runs, so when react-x11 is evaluated on the main thread the app has
  not run a line. It starts a Worker on that same entry, with the same
  `execArgv` and a shared environment, and parks the main thread in
  `Atomics.wait` — no AppKit yet — until the worker says what it needs. The
  first cocoa `createRoot` asks for AppKit (`requestAppKit`), and the main
  thread launches it and enters `runMain()`; an app that never makes one,
  an X11 app on XQuartz or a script, never launches AppKit and never gets a
  Dock tile. It is synchronous throughout, `process.exit` being the main
  thread's only way out, because a top-level await would cost the CommonJS
  builds and `require()` of the package. It declines, and the app keeps the
  pump, off macOS; with `REACT_X11_THREADED=0` or `REACT_X11_BACKEND=x11`;
  for a REPL or `-e`; in a single executable, whose entry is not a file a
  worker can load; under a test runner; and when react-x11 is imported
  after the app started running. It tells that last case by Node's
  `performance.nodeTiming.loopStart`, -1 until the event loop turns, and in
  Bun, which reports 1 there from the first line, by the entry's record in
  the module cache, absent until the entry has run (both measured).
- **`react-x11/cocoa-main`** (`src/cocoa/main.js`) is the same move asked
  for by name — `node --import react-x11/cocoa-main app.js`,
  `bun --preload react-x11/cocoa-main app.jsx` — before the entry is loaded
  at all, which spares the main thread loading the entry's imports for
  nothing, and without the checks. Off macOS, and inside a Worker the app
  starts, it does nothing.
- **The worker's side** (`bootstrapWorker`), set up by the same import on
  the worker, which recognises the shared state in its `workerData`; the
  pieces are `src/cocoa/threaded.js`'s. Stdout, stderr and the console
  write straight to fds 1 and 2: a Worker's own forward through its
  parent's loop, which is parked, and Bun's console bypasses
  `process.stdout` altogether. `process.exit` asks the main thread first
  (`requestExit`) and then ends the worker, which is also how Node's own
  handling of an uncaught error reaches it, with code 1; `exit()` on the UI
  thread, the probe's first try, raced static destructors. The worker says
  it is done after the app's last exit listener — kept last, since Node
  runs a worker's exit listeners through `process.emit` and Bun calls them
  directly (measured) — and the main thread ends the process on that, so
  an app's exit handlers finish as they would in a process of its own. It
  prints its own uncaught error, because the parked main thread never runs
  its loop again to hear the worker's `'error'`. A `signal` event is
  re-emitted on the worker's `process`, and one nobody listens for exits
  128 + n. The first cocoa root waits for `runMain` before it builds the
  app: until the run starts the bridge has published nothing, and an app
  that asked `listScreens()` then got `[]` and took scale 1 on a 2x panel
  (measured). What the app imports before react-x11 runs before this
  set-up, so a module that logs as it loads belongs after it.
- **One channel** (`openThreadedChannel`). The bridge takes one `connect`
  per environment, so the bootstrap opens it before the entry runs and
  fans the batches out — signals to itself, the rest to `CocoaApp`. What a
  subscriber throws leaves the delivery once every subscriber has had the
  batch, and the bridge makes it the worker's uncaught exception. Before
  0.10 it was swallowed: an exception out of a threadsafe function's
  callback is, under Node's default policy, a warning — the app went on
  with its window up and the error gone (measured, and fixed in the bridge
  as windowkit/appkit#65).
- **`CocoaApp`** (`src/cocoa/app.js`) is fed by the batches
  (`_routeBatch`): each event is routed as the pump routes it, what the
  inputs owe — React's half, the paint, the present (`_afterInput`) — is
  paid once per batch, and then comes the frame tick the pump did. No
  interval and no `pump2`; every frame gets a timer of its own, and
  `_routeGeometry`'s coalesced second flush is the pump's alone. The display link ticking from the UI thread through the same
  channel, the Windows PRD's frame thread
  ([windows.md](windows.md#the-frame-clock)), is still to come.
- **Windows are keyed by the handle.** `createWindow2` answers a handle at
  the call; `windowNumber` and the published frame arrive with
  `window-created`, and every window event names the handle.
- **The fence.** A flip is a command the UI thread applies later, so the
  buffer it takes off glass is still on glass when the call returns.
  `CocoaWindow.frameInFlight()` — the X11 contract's fence, which the pump
  never needed — holds the window's next frame and its catch-up copy until
  `surface-released` names that buffer. A new size is never in flight: it
  paints into a new pair that nothing shows. A release that never comes
  lets go after 100 ms, and the scroll blit settles the catch-up before it
  moves a band.
- **The resize handshake.** Each flip is a recorded frame committed with
  the size it was painted at, in AppKit's own points, and each window asks
  AppKit to wait for it for `cocoa: { resizeWait }` ms — 50 by default, 0
  for none. The layer presenter's frame commits its size too.
- **A live resize is what AppKit brackets**: `liveResizing` is set between
  the bridge's `window-live-resize` begin and end (windowkit/appkit#63), in
  both modes. AppKit's tracking loop reports a resize per pointer move and
  nothing when the drag stops, so the pump used to read the end as "a pump
  tick ran", and a worker, which no AppKit loop holds, has nothing like
  that to read; a drag that pauses now stays a drag, and the catch-up frame
  runs on the tick after the release.
- **Answers that come later.** `clipboard.read()` and `targets()`;
  `CocoaWindow.snapshot()`, a promise now on both threads; the drop's
  payload, read from the event's `items`; and bezels. `BezelStore.prefetch`
  asks for every kind's metrics beside the rest of startup — 41–49 ms cold,
  where the yoga load beside it takes 15–50 — so layout reads them
  synchronously as before. A bezel not drawn yet is null: its canvas draws
  the one it had and repaints when the new one lands, and a bezel drawn at
  rest brings its pressed twin, so a press never waits for one.
- **Tests.** The 22 `test/cocoa-*.test.js` files drive fake bridges that
  answer synchronously and keep passing on the pump;
  `test/cocoa-threaded.test.js` drives the same app over a fake in a
  worker's shapes, `test/cocoa-relaunch.test.js` pins when the move
  happens and the worker's side of the hand-off, and
  `test/cocoa-threaded-launch.test.js` runs real apps with the real bridge
  — moved by the import, by the launcher, kept on the pump, and one that
  never makes a root (it skips without a bridge that has `runMain`).
  The contract the renderer needs is the X11 one, asynchronous from the
  start, which [windows.md](windows.md#the-rules-that-keep-it-from-deadlocking)
  makes the same point about.

Measured 2026-09-11, M1 Pro, Node 26.0.0 and Bun 1.4.0, the bridge built
from its main branch at 0b17653: `createRoot` took 92 ms on the worker and
102 ms with the pump, for one window; the launch test's three cases —
the entry on a worker with its window made and painted, `process.exit(7)`,
and an uncaught error printed with exit 1 — pass under both runtimes; and
`examples/app.jsx` ran under the launcher with nothing on stderr. On the
published 0.10.0, spawn to the first painted window of a one-window app,
median of seven: Node 471 ms on the pump, 544 ms moved by the import,
462 ms moved by the launcher; Bun 408, 446 and 385 ms; memory 170, 219 and
186 MB under Node, 150, 182 and 159 MB under Bun. `examples/raster-gate.jsx`,
started with no flag under Bun and under `node --import tsx`, kept
animating through a live resize at 48–62 fps.

The activation policy is the launch's: the launcher has launched AppKit
before the app's code runs, so `cocoa: { activationPolicy }` can only
switch it afterwards, when a Regular launch has already shown its Dock
tile. The bridge reads `APPKIT_ACTIVATION_POLICY` as it launches
(windowkit/appkit#67) — `APPKIT_ACTIVATION_POLICY=accessory node --import
react-x11/cocoa-main app.js` for a menu-bar app, or `LSUIElement` in a
bundle's `Info.plist` — and an app whose option disagrees with how it
launched is told so, naming the variable.

What it does not do yet, each noted where it lives:

- A drop's binary types, an image, are offered and read as nothing: the
  event carries the text and URL forms, and a worker cannot read the drag
  pasteboard inside the callback.
- The layer presenter's colour transitions start from the declared value,
  since `presentationValue` answers later on a worker.
- A transparent window's shadow is recomputed a frame interval after a
  flip, rather than once the flip has committed.
- `process.stdin` still forwards through the parked main thread.

### What changes for an app

- About **16 MB** of RSS for the worker's isolate (a bare `node` at 46.5 MB,
  62.5 MB with one idle worker) and **26–31 ms** before the worker runs its
  first line.
- The idle app stops waking 125 times a second: the pump is an 8 ms
  interval whether anything happens or not.
- Inside a Worker, `process.chdir()` throws, `process.on('SIGINT')` is never
  called (the launcher forwards signals), `process.env` is a copy unless it
  is shared, and `process.stdin` forwards through the main thread the way
  stdout does.
- `--inspect` attaches to the main thread; the app is the worker target
  beside it.
- Packaging: a single-executable build has to carry the worker's entry
  beside the main one ([packaging.md](packaging.md)), and
  `bun build --compile` has to be given it as an entry point.

### Not probed yet

- A hardware live resize, a real drag session, and pixels on glass.
- `<glarea>`'s `x11-dri` CGL context inside a worker.
- `react-x11/refresh`'s module hooks inside a worker.
- The fence and the scroll blit on glass: the fence keeps the next paint
  off the buffer being shown, and the blit settles its catch-up first, but
  neither has been looked at on screen.
- IME and NSAccessibility, neither built yet: both are questions AppKit asks
  the view synchronously, and both take the answer the Windows design gives
  them — the caret rect and a copy of the accessibility tree, pushed ahead
  to the UI thread.

### The order

The bridge's core and every verb have landed (windowkit/appkit#50–#54), and
so have a batch-fed `CocoaApp` and the move that makes threaded mode the
default on macOS. Pump mode stays, unchanged, as the off switch
(`REACT_X11_THREADED=0`) and wherever the move declines — a single
executable first among them. Still to take under threaded mode: an
input-to-photon measurement and the resize cell of the Cocoa bench, which
runs its columns on the pump — perceived latency is the metric this
project grades on, and latency is what the change is for.

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
- A native control is **two boxes**: the footprint the caller's `style`
  sizes, and the control itself — bezel, title and press wash — at AppKit's
  metrics, centred in it. One box could not be both, because a cell's title
  is _placed_ against the bezel's bottom edge rather than centred in the
  box, and a `height`, a `flexGrow` or a parent's align-stretch moved the
  box without moving the bezel the system draws at one size: the label
  ended up below the control it names (#510). The role, the handlers, the
  focus ring and the ref stay on the control, so the slack around it is
  slack — a press there does nothing, as it does in AppKit.
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

**A popup on this backend is sized as an NSMenu.** Where the backend
renders native controls, `<ContextMenu>`, a `<MenuBar>`'s dropdowns and a
`<Select>`'s list take NSMenu's geometry rather than the palette's — 22pt
rows, 5pt of padding, 11pt separators, the 13pt menu font at regular
weight, a 5pt highlight radius — read off `NSMenu.size` (`NATIVE_MENU` in
`components/native.js`). The drawn menu's 30pt rows of 14px medium text
read as another toolkit's beside the menus the system's own controls open.
The menu bar itself keeps the drawn metrics: a bar is not an NSMenu.

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
  the X-only names stay X-only. An element that composites such a surface
  over its box on **every** frame — a terminal, a chart on a socket — pays
  that composite and the window swapchain's catch-up copy behind it to move
  pixels it already has; making the element's surface its own layer instead,
  the way `<glarea>` and layer promotion already do, is designed in
  [architecture/element-layer-contents.md](architecture/element-layer-contents.md)
  (#499) and not built.
- `<svg>`: the declarative vocabulary (`SvgChildNode`) is portable; the
  rasterizer behind it renders through the same CG ctx.
- A future, deliberate seam — not built until a consumer needs it:
  `registerElement({ visual })`, letting an element supply a
  layer-aware visual instead of raster (a chart that wants its series
  as shape layers, say). The raster default means nobody _has_ to.

### Stroking a path with many subpaths

`CGContextStrokePath` is **quadratic in the number of subpaths** in the
path it is handed. Measured on this machine — closed 13-vertex rings
scattered over a 1024×1024 surface, a 2px line, one `ctx.stroke()`:

| rings | vertices | one stroke | chunked (what ships) |
| ----: | -------: | ---------: | -------------------: |
|   500 |    6,500 |      20 ms |                14 ms |
| 1,000 |   13,000 |      59 ms |                29 ms |
| 2,000 |   26,000 |     208 ms |                56 ms |
| 4,000 |   52,000 |     986 ms |               113 ms |

The subpath count is the driver, not the vertex count: one 26,000-vertex
subpath strokes in 4ms where two thousand 13-vertex ones take 208. It was
found rasterizing vector map tiles — a `buildings` layer is one feature of
a couple of thousand building outlines, accumulated into one path
(react-x11 issue #456).

So `CocoaContext2D.stroke` splits such a path into several
`CGContextStrokePath` calls, cut at subpath boundaries — a chunk closes at
the first `moveTo` past 512 points or 128 subpaths, which is within 5% of
the best chunk for every shape swept. **The backend picks the size, not the
caller**, because the right size is a fact about CoreGraphics that no
caller can know, and because the X11 context wants the exact opposite: there
a stroke is an a8 coverage mask over the path's bounding box uploaded with
one `PutImage`, so a bigger path is _fewer_ uploads over the same pixels,
and batching for one backend pessimizes the other.

Two things are deliberately left whole, both because splitting them would
be a loss:

- **A hairline** — a device-space width of 1 or less, so `lineWidth` times
  the CTM's scale. Below that width CoreGraphics strokes through a path
  that is already linear in the subpath count (the 2,000-ring path above
  costs 7ms at 1px, whole), and splitting it is a **2× regression**: the
  per-call setup with nothing to win back.
- **Anything that composites** — a translucent `strokeStyle`, a
  `globalAlpha` below 1, a live shadow. Each chunk paints separately, so a
  pixel that two subpaths' strokes each half cover is inked twice at half
  coverage rather than once at full, and reads a little lighter. That is
  the one visible difference chunking can make, and it is confined to the
  seams where subpaths overlap under an opaque ink, where blending the same
  colour twice changes only the antialiased fringe. `ctx.strokeChunking =
false` turns the split off for a caller that needs those seams exact, and
  `REACT_X11_NO_STROKE_CHUNKING=1` for a whole process.

`fill` is not chunked and cannot be: the winding rule is a property of the
path as a whole, so a hole in a shape stops being a hole once its ring is
in a different call.

The path is recorded in JS alongside the native one so a chunk can be
re-issued — a flat number array, reused across paths. It costs an ordinary
paint nothing measurable (20,000 rounded-rect fill+strokes: 601ms before,
597ms after; 20,000 twelve-segment polylines: 113ms before, 116ms after),
and the record is what puts the whole path back if a `fill`, a `clip` or
more path building follows a stroke that consumed it. `test/cocoa-stroke-chunking.test.js`.

### Compositing a surface at a translate

An element that owns a surface presents it every frame: the terminal's
grid, a retained scene, anything that rasters once and shows the result
many times. `ctx.drawImage(surface, x, y)` is how it says so, and on this
backend that was `CGBitmapContextCreateImage` of the whole source plus
`CGContextDrawImage` — a CGImage built and a blend run, every frame, for
pixels that were only ever going to be copied. In
sidorares/react-x11-components#69 §6's profile it is 1.7ms of a 6ms
`<Terminal backend="vt">` frame, the second-largest line after the cell
background fills.

The context takes canvas's own way of saying "do not blend, replace" —

```js
ctx.globalCompositeOperation = 'copy';
ctx.drawImage(surface, x, y);
```

— and, where that is all it is, sends the composite as a row memcpy
(`blitSurface`) instead. `scripts/cocoa-composite-probe.mjs` prices the
two routes against the real bridge; on an M1 Pro, 200 composites a cell:

| source          | destination       | CGImage draw |  memcpy |
| --------------- | ----------------- | -----------: | ------: |
| 125×45 grid @2x | the whole surface |       1.37ms |  0.42ms |
| 125×45 grid @2x | a third of it     |       0.36ms |  0.14ms |
| 125×45 grid @2x | one row's damage  |      0.033ms | 0.012ms |
| 80×24 grid @2x  | the whole surface |       0.35ms |  0.18ms |

`globalCompositeOperation` itself is `ctxSetBlendMode`, and the vocabulary
is the **bridge's** rather than a table kept on this side: the names are
canvas's own, and the verb answers whether the mode is now the one asked
for. So this backend never goes stale against a bridge that grows an op,
and never claims one it would not draw. 0.7.0 knows the whole canvas set
— the Porter-Duff ops ntk maps to XRender's, plus the separable and
non-separable blend modes CoreGraphics has and XRender does not, which a
caller reaching for `multiply` should know are macOS-only until ntk grows
them. Two things about it are worth knowing. A bridge without the verb —
anything before 0.7.0 — **refuses** everything but `source-over` rather
than accepting it and drawing something else, so the detection a caller
writes is canvas's own: assign, then read the property back. An op
applies inside what the draw covers rather than across the whole surface —
a browser's `copy` clears everything the drawing missed, where
`kCGBlendModeCopy` and XRender's `Src` both leave it alone, so the two
backends agree with each other and differ from a browser together. And the
`op` argument a `drawGlyphs` call carries is still ignored; text composites
through the context's mode like everything else.

The blit is an optimization and never a difference, so every way the
memcpy would not be exactly what the draw produces turns it off and the
draw happens: an op other than `copy`, a transform that is not a
whole-pixel translate, a `globalAlpha` below 1, a live shadow, a
destination size that differs from the source's, a fractional source
rect, and a surface composited into itself.

The clip is the interesting one. A memcpy cannot see a CGContext's clip,
and a paint pass is clipped to its damage rect — so the context tracks
the clip **as a rect** beside the CTM it already tracked, and hands it to
the verb. It tracks only what it can state exactly: a single `rect` path
under an axis-aligned transform landing on whole pixels. A rounded
corner, an arc, a polygon, two rects, a half-pixel edge or a rotation all
resolve to "there is a clip and I cannot name it", which turns the blit
off until a `restore()` pops back past it. The clips a paint pass
actually sets — the damage rect, a square-cornered `overflow` — are the
ones it recognises.

`test/cocoa-composite.test.js` pins both halves: the decisions over a
fake bridge — including a bridge with neither verb and one whose
vocabulary is smaller, which is what the feature detection is for — in
CI, and, where the real bridge loads, that the blit and the draw are
pixel-identical.

## Animations and transforms: the API the model unlocks

The existing declarative vocabulary is the seam: `transition:` and
`animation:` in styles. On X11 they run on the frame clock (JS
interpolation, repaint per frame — including the premultiplied-lerp
rule), and so do they on the surface presenter. **The layer presenter
hands them to the render server** where the node's own layer expresses
the property — a plain `<box>`'s `backgroundColor`, `borderColor`,
`borderWidth` and `borderRadius` — and schedules no frames for them: the
style goes to its target, which is the layer's model value, and the frame
that sends it attaches an explicit animation carrying the pixels there
(`CocoaLayerPresenter.animate`, `@windowkit/appkit` >= 0.5). A loop is one
repeating animation and costs no JS frames at all. Everything else — a
colour on text, a layout property, any node that paints as a raster — stays
on the frame clock, byte-identical to before; the presenter can only decline,
never break. **The surface presenter takes the same animations** by
promoting the node to a layer of its own for as long as it animates —
the next section — so `examples/animation.jsx` is the demonstration on
either: its frame counter reads 0 while the plain-box loops keep going,
and they keep going through a deliberate two second block of the JS
thread.

The three semantics [the design](architecture/animation.md) said to pin:

- **Timing parity** is control points, not names. `transition`'s ease-out
  is cubic-bezier(0.33, 1, 0.68, 1) to within 0.003 and the loop easings
  map the same way (`EASING_CONTROL_POINTS`, styles.js), where CA's named
  `easeOut` is a different curve — test/style.test.js pins both facts.
- **Interruption**: a length retargets _additively_ — the model goes to the
  new target and a delta animation `(old − new) → 0` joins the one still
  running — so a change of mind mid-flight is continuous with nothing read
  back; a colour cannot be additive and restarts from the presentation
  value the bridge reports.
- **Completion** is the bridge's `animation-end` event, so the node model
  drops the entry when the render server says so, not when a timer guesses.

Not offloaded yet, in the order they would pay: `opacity` and transforms
(they do not exist as style properties — the design's §3.4), an absolutely
positioned node's offsets as `position`, and `boxShadow`'s components.

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

## Layer promotion: the animated few on their own layers above the surface presenter

The presenter choice above is all-or-nothing, and for the shape of app
that most wants the retained tier — a large scene with one or two
animated elements in it — neither answer was right. `surface` could not
offload an animation at all: every transition frame was a JS repaint plus
an upload, and a stalled JS thread stopped the animation dead. `layers`
offloaded it and paid for the whole rest of the scene: a pan is a
whole-scene re-raster (`scrollRegion` is nulled in layers mode), and every
raster visual carries its own bitmap. The hybrid is what browsers call
**layer promotion**, and it is the surface presenter's default (issue
#483): keep the bitmap for the scene, and give the handful of nodes that
actually animate a CALayer of their own above it. `src/cocoa/promotion.js`
is the whole of it.

**Why it was cheap here.** The mechanism already shipped, for `<glarea>`.
The surface presenter's pixels are the window root layer's `contents`,
and a layer's contents draw _below_ its sublayers — so a promoted sublayer
composites over the bitmap for free, and there was no compositing to
write. The hole in the 2D raster was already an idiom (`GlAreaNode.paint`
is empty): a promoted node is skipped by the paint walk (`Node._promoted`),
so the walk paints what is behind it and nothing else. The animation
seam was already presenter-agnostic — `animateNode` / `cancelNodeAnimation`
are feature-detected on the window, and `_offloadDeclined` hands a
property back to the frame clock whenever a presenter cannot take it — and
the bookkeeping of what the render server runs was one class
(`LayerAnimations`, presenter.js) once it was lifted out of the layer
presenter; the two differ only in which node has a layer.

**What a promoted node is.** A property box — its background, border and
radius as properties of its layer, the same `propBoxProps` the layer
presenter sends, which is exactly the vocabulary the render server
animates. Its children, if it has any, ride the layer as one raster
sublayer painted by the node's own `_paintChildren` walk (a `Visual` and a
`RasterState` from the layer presenter, used standalone), repainted for the
claims that reach into it and for a change in where the children sit —
the hover card in `examples/animation.jsx` promotes with its two captions.
A promoted node inside a promoted node leaves a hole in its parent's
raster and sits on a layer of its own above it; every promoted layer is
flat on the window root, ordered by paint order. Hit testing never moves:
the node tree stays the source of truth for input on every presenter, so
promotion changes pixels and nothing else.

**The policy** is not inferred from the scene, and there is no style prop
to get wrong: a node is promoted because it has a transition or a loop on
a property a layer can express — a plain `<box>`'s `backgroundColor`,
`borderColor`, `borderWidth`, `borderRadius` — for as long as it has one
and a second after, and returns to the bitmap then. The second is
`IDLE_GRACE_MS`: a hover card fades in and, a moment later, out; a palette
step ends one transition and starts the next; a toast pulses again.
Demoting on the last frame of each cost a layer and a repaint of the hole
per round trip — the first run of the bench made 96 layers for 48 cards —
and a second is longer than any such gap. Nothing can promote two hundred
nodes by mistake, and there is nothing to document on a backend that may
decline it.

**The hard part is z-order.** A promoted layer sits above _all_ the 2D
content, so promotion is only correct where nothing paints over the node.
Browsers answer the general case with overlap testing that cascades
promotions upward through the stacking context — precisely the machinery
worth not having. The cheap rule instead: a node is promoted only when
nothing painted after it in the walk reaches into its bounds — no later
sibling at any level (a later subtree counts where it puts ink, so a
layout-only container laid over the node is no overlap, and a later
subtree that is itself promoted is on a layer above and does not count),
no ancestor's border ring or focus ring (both are painted after the
children), no scrollbar — and only when every clipping ancestor holds the
whole of it, because the layer would not be clipped. All of it is
answered from `paintOrder()` and the cached paint reach, and the same test
runs again every frame, later-painted nodes first, so a node that becomes
overlapped, hidden, clipped or non-plain (a `:hover` that adds a shadow)
returns to the bitmap in the frame that finds it, the animation handed
back to the clock. Overlays, toasts, drag ghosts, spinners and floating
cards pass by construction; a hover fade on a row in the middle of a list
does not, and stays on the clock. Declining is always safe — the frame
clock runs the animation exactly as it does with promotion off — and a
refusal is remembered until the next layout, so the same scene does not
cost a frame's decline per retarget.

**The frame.** `WindowNode.flush()` gives the presenter its word in after
layout and before the damage is taken (`window.prepareFrame`, feature-
detected like `presentFrame`): whatever it moves onto or off a layer
claims the bitmap under it in that same frame, so a node is never painted
at its target before a declined animation restarts from its start, and a
demoted node is back in the bitmap in the frame its layer goes. A
promoted node's own claims — a retarget, a hover flip, a caption changing
inside it — are answered on the layer and cost the bitmap nothing: the
`noteInvalidate` channel the layer presenter listens on answers `true`,
`WindowNode.invalidate` records a frame with nothing in it for the bitmap,
and the frame runs the presenter's half and paints no pixel (`hovertree`
below: 0kpx a frame). The scroll blit's safety gate skips a promoted node
for the same reason — its pixels are not in the bitmap the band is cut
from — which is what makes a pan under a pulsing toast a blit
(`pananim`), on a backend where the toast's per-frame claim used to poison
every notch.

**What to expect, and how to stop it.** An animation on a plain box
costs one frame to start and, a second after the last one ends, one to
come back, and the render server draws every frame between — through a
busy JS thread, at the display's rate — while the bitmap keeps the frame
for everything else, the scroll blit included. What it costs is a CALayer
and, for a node with children, a bitmap the size of their reach, for as
long as the node animates and the second after.
`createRoot({ cocoa: { promote: false } })` or `REACT_X11_COCOA_PROMOTE=0`
keeps every animation on the frame clock, which is what the presenter
bench's `surface` column measures; `true` / `=1` turns it on regardless
of the bridge. `test/cocoa-promotion.test.js` pins the contract over the
fake bridge; `test/animation-example.test.js` walks the example through
it.

**One thing it found, and the bridge it needs.** A promoted node is the
same node drawn two ways in turn, and the two had to agree to the pixel
or every hover would flash. They did not: a layer's `backgroundColor` went
through `@windowkit/appkit`'s `CGColorCreateGenericRGB` while its surfaces
are sRGB, so `#dbe7f4` rastered as (219, 231, 244) and composited as
(228, 236, 245) — paler, on every layer the layer presenter ever set, and
a colour animation there landed on a model value that did not match its
own `to`. [windowkit/appkit#33](https://github.com/windowkit/appkit/pull/33)
makes every colour crossing the bridge sRGB and adds `colorSpace()` to
say so, and shipped as `@windowkit/appkit` 0.5.1, the range this package
asks for; against it the same card differs by at most six units of one
channel, in the antialiasing. Promotion is on by default **only where the
bridge answers `'sRGB'`** — on 0.5.0 it stays off unless asked for — so
nobody gets the flash for free, and the bridge upgrade is what turned it
on.

**Measured**, 2026-09-06, this machine (a 120Hz panel; the window on a
60Hz monitor where it says 59fps), 4s per cell, `npm run bench:presenters
-- --scenario=anim,animtree,hovertree,pananim,scroll,tree`; `surface` is
promotion off, `promoted` on. Frames are what the JS side painted;
`ticks` are the scenario's own changes (a palette step every 15, a hover
flip or a wheel notch every one).

| scenario    | column   | frames / ticks | flush avg / p95 | damage a frame     | cpu  | what it says                                       |
| ----------- | -------- | -------------- | --------------- | ------------------ | ---- | -------------------------------------------------- |
| `anim`      | surface  | 455 / 235      | 2.17 / 2.51ms   | 2170kpx            | 46%  | every frame of every fade, all 48 cards            |
|             | promoted | 16 / 241       | 2.80 / 6.92ms   | 136kpx             | 17%  | one frame a palette step; 48 layers, made once     |
|             | layers   | 16 / 241       | 2.21 / 3.26ms   | —                  | 17%  |                                                    |
| `animtree`  | surface  | 208 / 120      | 14.58 / 16.97ms | 2031kpx            | 108% | cannot keep up: the fades repaint the grid         |
|             | promoted | 243 / 243      | 0.91 / 1.87ms   | 13kpx              | 54%  | the grid's one cell a tick; the fades cost nothing |
|             | layers   | 244 / 244      | 2.75 / 3.75ms   | —                  | 67%  | a visual per node of the grid                      |
| `hovertree` | surface  | 476 / 242      | 0.28 / 0.38ms   | 43kpx              | 14%  | input→flush p50 2.80ms                             |
|             | promoted | 242 / 242      | 0.31 / 0.39ms   | 0kpx               | 11%  | p50 2.86ms; the bitmap paints nothing              |
|             | layers   | 241 / 241      | 1.38 / 1.65ms   | —                  | 22%  | p50 2.75ms                                         |
| `pananim`   | surface  | 702 / 243      | 0.65 / 1.82ms   | 817kpx, 31% full   | 24%  | the toast's claim poisons every notch's blit       |
|             | promoted | 219 / 242      | 1.57 / 2.01ms   | 525kpx, 0% full    | 22%  | the blit, exactly `scroll`'s                       |
|             | layers   | 220 / 243      | 1.89 / 2.28ms   | 2520kpx, 100% full | 17%  | a whole-scene re-raster a notch                    |
| `scroll`    | promoted | 220 / 243      | 1.45 / 1.86ms   | 525kpx             | 20%  | as surface: 1.49 / 2.01ms, 525kpx, 21%             |
| `tree`      | promoted | 243 / 243      | 0.47 / 0.65ms   | 4kpx               | 49%  | as surface: 0.42 / 0.57ms, 4kpx, 47%               |

So both halves at once: the animation's frames match `layers`, the flush
and the scroll match `surface`, and `animtree` and `pananim` beat both.
The 54% left in `animtree` is the React commit of a 3,700-node tree per
tick, which `tree` prices at 47% with no animation at all. The gate keeps
it: `scripts/bench/presenters-gate.json`'s `promoted` rules judge the
promoted column on frames per tick, full frames and damage share, next to
the surface column's own.

## Running as an app bundle

A react-x11 process is a `node` (or `bun`) process, and AppKit names, icons
and identifies an app by the **bundle its executable lives in**: run from the
shell, the menu bar says "node", the Dock shows the generic icon, and the
defaults domain — where AppKit remembers window frames and whether a tab
bar is showing — is `node`'s or `bun`'s, shared with every other script
that runtime ever ran. `examples/form/` is the example of the fix:

```
npm run examples:form:app   # builds examples/form/build/Guestbook.app and opens it
```

[`make-app.sh`](../examples/form/make-app.sh) copies `Info.plist`, renders
`icon.svg` into an `.icns` with the system's own tools (Quick Look, `sips`,
`iconutil`), and makes the executable with `bun build --compile`: one Mach-O
with bun's runtime, the example and react-x11 inside it, at
`Contents/MacOS/Guestbook`. AppKit takes an app's main bundle from the
running executable's path, so a real binary there is the whole trick — no
launcher, nothing to find at launch time.

What a compiled binary cannot contain is the Cocoa bridge's native addon,
which the backend loads with `require` from a file. The bundle carries it
as `Contents/Resources/calayers.node`, and the compile entry,
[`main.js`](../examples/form/main.js), names it through the backend's
`REACT_X11_CALAYERS_PATH` seam — relative to `process.execPath`, so the
bundle can be moved — before importing the example. `Info.plist` carries
the name, the identifier (`com.example.guestbook`), the icon,
`NSHighResolutionCapable` (without it AppKit renders at 1×) and
`LSEnvironment` naming the Cocoa backend. Launch Services then reports the
process as the app:

```
$ lsappinfo info -only name,bundleid,bundlepath "$(lsappinfo find pid=<pid>)"
"LSDisplayName"="Guestbook"
"CFBundleIdentifier"="com.example.guestbook"
```

(A script can be a bundle's executable too, and there is a way to make
AppKit take the bundle rather than the interpreter as the main one —
`#!/usr/bin/env -S CFProcessPath=<this file> bun` sets CoreFoundation's
process path before the interpreter starts — but the compiled binary needs
no such trick, and nothing installed on the machine at launch time.)

### Distributing the bundle

What `make-app.sh` builds is a developer's bundle: it runs where it was
built, and nowhere else without three more steps.

- **Signing.** The binary is unsigned. Gatekeeper lets an unsigned app run
  from a build directory, but not one that arrived in a download (the
  quarantine attribute) — for that it wants a Developer ID signature with
  the hardened runtime, then notarization. Sign **inside-out, and not
  with `--deep`**: Apple DTS says not to use it ("Signing a Mac Product
  For Distribution" and "Creating distribution-signed code for Mac",
  forums threads 128166 and 701514) and to sign nested code first, with
  entitlements on the main executable only. So: the addon in `Resources`,
  without entitlements, then the app with them:

  ```sh
  ID="Developer ID Application: NAME (TEAMID)"
  codesign --force --timestamp --sign "$ID" Guestbook.app/Contents/Resources/calayers.node
  codesign --force --timestamp --options runtime --entitlements bun.plist \
    --sign "$ID" Guestbook.app
  ditto -c -k --keepParent Guestbook.app Guestbook.zip
  xcrun notarytool submit Guestbook.zip --keychain-profile notary --wait
  xcrun stapler staple Guestbook.app
  ```

  `bun.plist` is the five entitlements from Bun's "Code signing on macOS"
  (`allow-jit`, `allow-unsigned-executable-memory`,
  `disable-executable-page-protection`, `allow-dyld-environment-variables`,
  `disable-library-validation`). For a copy handed to a colleague, the
  same two `codesign` lines with `--sign -` and
  `xattr -dr com.apple.quarantine` on the receiving end are the short
  path. The machine this was written on has no signing identity: the
  ad-hoc steps were run, the Developer ID ones are Apple's documentation —
  [packaging.md](packaging.md#developer-id-or-the-app-store) keeps the
  line between the two.

- **The Mac App Store is a different bundle.** The store requires App
  Sandbox, and a `bun build --compile` binary does not start under it.
  Measured 2026-09-08 (macOS 15.2, bun 1.4.0): this bundle re-signed with
  only `com.apple.security.app-sandbox` dies every time — `SIGTRAP` in
  `_libsecinit_appsandbox` for the bare binary, `SIGABRT` in HIServices'
  `_RegisterApplication` inside the bundle, after the kernel logs
  `Sandbox: Guestbook deny(1) mach-lookup com.apple.coreservices.launchservicesd`
  (oven-sh/bun#15661, open). The same example as a node single executable
  (`node --build-sea`, node 26) in this bundle's shape — same plist, same
  `calayers.node` in `Resources` — runs sandboxed, launched by `open`,
  registered with Launch Services, in its own container, with no sandbox
  denial logged. So a store build is packaging.md's tier 3 inside its
  tier 5, signed with "Apple Distribution", packaged with `productbuild`
  and uploaded with Transporter; the recipe, the two esbuild defines the
  form example needs today, and what was and was not run are in
  [packaging.md](packaging.md#developer-id-or-the-app-store). Bun stays
  fine for Developer ID, which needs no sandbox.
- **Architecture.** `bun build --compile` targets one CPU and the bridge's
  prebuilds are one per CPU; the script builds for the machine it runs on.
  A universal bundle is two builds and `lipo` — for the executable and for
  `calayers.node` alike.
- **Paths.** The compiled binary is self-contained, and `main.js` finds the
  addon relative to `process.execPath`, so the bundle can be moved, zipped
  and dragged into `/Applications`. Nothing in it refers to the repo.
- **Size.** About 70MB, nearly all of it bun's runtime; the example and
  react-x11 are a few hundred kilobytes of it. The node SEA of the same
  example, the store shape, is 142MB.

**The tab bar under bun.** Without a bundle, a window opened by `bun` is in
the `bun` defaults domain, and once anything has turned on the tab bar for
one of our windows there — View → Show Tab Bar, or a stray shortcut — AppKit
persists it as
`NSWindowTabbingShoudShowTabBarKey-NSWindow-CALBackendDelegate-(null)-VT-FS`
and every window the bridge opens from then on wears a 28pt tab bar. It also
shifts the content view down by that much, which the bridge's
`getWindowFrame` does not report (windowkit/appkit#12), so every popup lands
a bar's height off. Clear it with

```
defaults delete bun "NSWindowTabbingShoudShowTabBarKey-NSWindow-CALBackendDelegate-(null)-VT-FS"
```

or run the app as a bundle, whose own domain has never seen the key. The
durable fix is the bridge's: `tabbingMode = NSWindowTabbingModeDisallowed`
on every window it opens.

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
   `'embedding'` (false here), `'globalMenu'`, `'transforms'` (when built)
   beside `'transparency'` and `'shaders'`; same store-and-settle semantics.
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
7. **Packaging.** The bridge publishes as its own package — a
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

## The bridge: the required API

The contract that was published against, grouped, with the POC's coverage
marked at the time (✅ had it, 🆕 was the work). Mechanism only; policy
stays in the renderer. `@windowkit/appkit` has since grown past this list —
its own README is the current reference; this is the shape it was asked
for.

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
(`copySurfaceRegion`), the blend mode a `globalCompositeOperation` sets ✅
(`ctxSetBlendMode`, 0.7.0) and a row memcpy between surfaces of any two
sizes ✅ (`blitSurface`, 0.7.0 — issue #498; the context feature-detects
both, so an older bridge draws every composite as a CGImage under
source-over). Still 🆕: a pattern fill (`createPattern`,
which `<Flow>`'s grid tiles ask for), radial gradients, and an explicit
free (a surface goes with its handle's finalizer). The alternative — rasterize JS-side and use the raw-buffer
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
numbering. That is react-x11's policy: it is what `src/nodes/` and every
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
the same seam. [windows.md](windows.md) is that backend's PRD.

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

- **The paint reach is cached** (`Node._paintBoundsCache`, src/nodes/invalidate.js). A
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
  src/nodes/window/size.js). The floors (#249) were three extra layout passes and their
  walks — 21 of the 44ms a relayout cost on this tree, before they were
  measured incrementally (§"Measured: incremental floors") — and a drag
  calls the frame from inside every pointer move. A live tick lays out against
  the floors it has (exact along the main axis, a frame stale for wrapped
  text across it) and the first frame tick after the release measures once
  and lays out again: answer the input, then catch up. Only under
  `liveResizing`, which the Cocoa window holds between AppKit's begin and
  end of the drag (`window-live-resize`); an X window never sets it. A content change mid-drag takes
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
  construction. (Mostly: a trackpad lands two in one tick often enough
  that the window now gates it — see "The wheel is gated to the display too" below.)

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
  flush halved, on the panel that can show it. One honest limit at the
  time: the 8ms pump quantized the cadence, so a 75Hz monitor (13.3ms)
  painted at 62.5fps — the gate was the interval less half a pump, and
  9.3ms fell on the 16ms tick. The pass below gives such a frame a timer
  of its own.
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
- **The wheel is gated to the display too** (`CocoaApp._routeWheel`,
  `CocoaWindow._flippedRecently`). The wheel's early flush painted and
  flipped for every scroll event, and a trackpad lands two in one pump
  tick often, so the second frame was drawn into the buffer the first
  flip had taken off glass microseconds before — while the WindowServer
  could still be compositing from it. A scroll's frame blits before it
  repaints what the shift got wrong, and a composite caught between the
  two shows the blit alone: a held `position: 'sticky'` header dragged up
  a pixel for a frame, or the rows under it painted over it and then
  corrected. Everything else in a scrolling pane moves anyway, which is
  why this hid until something was meant to hold still. Now the first
  event of a burst is answered on the spot and the rest fold into the
  next paced frame, and a frame that answered the wheel restarts the
  window's clock, so the pump does not flip again a few milliseconds
  after it. Only the wheel: a resize paints into a pair it has just made,
  and gating its ticks cost the live resize a frame after the drag
  (`resize` in the presenter gate caught it). `test/cocoa-frames.test.js`.

**What was left, in order of what it cost** — the three items of #445,
measured in the pass below: a full relayout of a large tree (44ms at 3,600
nodes, half of it the content floors measured from scratch), nothing drawn
at a level of detail, and the pump quantizing the frame period.

## Measured: incremental floors, the strip, the frame timer

Written 2026-09-03 against the pass above (react-x11 2.5.0, `@windowkit/appkit`
0.4.0), same machine, same bench, the surface presenter — the three items
#445 ranked, in its order.

| what                                                                 | before          | after           |
| -------------------------------------------------------------------- | --------------- | --------------- |
| `layout` — 3,662 nodes, the container's padding toggling: fps, flush | 18.4fps, 43.8ms | 34.4fps, 19.9ms |
| `tiny` — 14,452 nodes, 5px labels: the frame the grid reflows on     | 320ms           | 175ms           |
| `anim` on a 75Hz monitor                                             | 56.3fps         | 70.4fps         |
| `anim` on the 120Hz panel                                            | 108–113fps      | 108.6fps        |

- **The floors are measured incrementally** (`collectFloorStale`,
  `probeHeightFloors`, `contentSpan`, src/nodes/window/floors.js). Every node keeps the
  extent it was last measured at — what it needs from the box around it,
  on each axis — and a measurement re-reads only the nodes whose subtree
  changed, taking the rest at the number they carry. Which subtrees
  changed is yoga's own record: a style setter, a child that came or went
  and a text that asked to be re-measured all mark their node and every
  node above it dirty, and the walk goes down that path and no other. So
  a padding change on a container measures the container and nothing
  below it, a row that mounts measures itself alone, and a colour change
  measures nothing. The passes are paid for only where a floor is going
  to be written from what they find: the width pass runs when content
  changed under a node on a row's main axis, and the heights are settled
  the other way round — the real layout runs first, a walk over the nodes
  it moved asks each leaf, in JavaScript and out of its own layout cache,
  whether its height at its new width is the height it had, and only if
  one says otherwise (or content changed under a node a height floor is
  written on) do the two height passes run and the layout again. On the
  `layout` cell that is one pass over yoga where it was four, and a walk
  over two nodes where it was four walks over 3,600: the floors went from
  22ms of the frame to 6, of which 4 is the one yoga pass. What is left
  of that frame is paint — 1,200 rounded fills and 1,200 `CTLineDraw`s,
  about 15ms — and React's own commit. `test/content-floors.test.js`
  counts the nodes each kind of change measures and the passes it runs.
- **Text below a legible size is a strip** (`TextNode._paintsStrip`).
  Under six logical pixels a label is a smudge of its ink, and a
  rectangle per line over the band the letters sit in, in that ink at the
  coverage small text has, is the same smudge for one fill instead of a
  glyph run. Logical pixels, because what is legible is a physical
  question: a 5px label is the same size on a 2x panel as on a 1x
  monitor. `createRoot({ textStripBelow })` moves the line and `0` keeps
  glyphs at every size (`REACT_X11_TEXT_STRIP_BELOW` for a process that
  cannot reach `createRoot`); the layout is untouched either way — the
  strip is as wide as the line the shaping settled. What it is worth is honest: on CoreGraphics a `CTLineDraw` of a three-glyph label costs about what a fill does, so the `tiny` cell on the surface presenter is unchanged by it (48–49fps either way) — its reflow frame is the 5,000 rounded cell fills, not the labels; on X11 the strip takes the cell's flush p95 from 86ms to 12ms, the glyph path's periodic expensive frames gone.
  `test/text-strip.test.js`.
- **A frame due between two pump ticks gets a timer of its own**
  (`CocoaApp._armFrameTimer`, `_frameDue`). The gate is now a millisecond
  under the interval — a timer's drift, no more — and a frame the next
  tick would be late for is run by a one-shot at the moment it is due,
  which runs the frame queue and presents; a present commits its own
  transaction, so nothing waits for the pump. The clock is kept on the
  display's period rather than on the moment a frame happened to run, so
  a tick that took a frame a little early or a timer that fired a little
  late moves nothing. The 75Hz row is what it is worth; the 120Hz panel,
  whose period the 8ms pump already fit, is unchanged. What the pump
  alone still does is poll AppKit's events, which `pumpInterval` stays
  the cadence of; the display link (§"Input and the run loop") would take
  input latency under it. `test/cocoa-frames.test.js`.

**What is left, in order of what it costs:** the paint of a large tree —
the fills and the line draws, which only not repainting can take away: a
paint cache over the cells that did not change, or the layers presenter —
then yoga's own pass at about a millisecond per thousand nodes, and React's
commit of a tree that re-renders unmemoized.

## Measured: the flood, under the frame pacer

Written 2026-09-07 against react-x11 2.8.3 and `@windowkit/appkit` 0.6.0,
same machine, the surface presenter, `npm run bench:presenters --
--scenario=stream --columns=surface`: a window-sized element repainting its
whole box on every claim, claimed every 2ms by a timer standing in for a
producer — the shape of a terminal under `cat`. The rows are `--frame-rate`
([elements.md](elements.md#framerate--pacing-the-frames-under-a-flood)).

| `--frame-rate` |   fps | paint share of wall | cpu | producer: claims/s |
| -------------- | ----: | ------------------: | --: | -----------------: |
| `display`      | 120.0 |                 58% | 72% |                244 |
| `adaptive`     |  36.1 |                 21% | 27% |                529 |
| `30`           |  29.7 |                 19% | 24% |                539 |
| `throughput`   |   8.8 |                  9% | 13% |                592 |

The default paints every refresh and starves its producer of half its
ticks; `'adaptive'` holds paint at the budget and gives the producer all of
them. The design and the rest of the numbers are in
[architecture/frame-pacing.md](architecture/frame-pacing.md). Two things
here are the backend's own: `CocoaWindow.present` reports the flip and its
catch-up copy to the node, so the frame is priced by what the thread
spent and not just by the flush; and `CocoaApp._requestFrame` arms the
frame timer for a request that arrives between two pump ticks, so a held
claim lands at its wait rather than at its wait rounded up to the pump.
The structural gate is unchanged: every rule holds at the default, which
is what every scenario but `stream` runs at.

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

### The swapchain, in pixels

Counting bridge calls is the right shape for a frame clock and the wrong
one for a fast path whose only observable is the picture. The scroll blit
is the case: `scrollRegion` shifts a band inside the **back** buffer, the
frame repaints only the strips the shift exposed, and what carries the
band into the other buffer is the flip's catch-up copy over the rects
`noteFrameDamage` collected. A catch-up covering the wrong rects leaves a
buffer one shift stale, and a pan then smears — a staircase of duplicated
content at increasing offsets, which is what issue #458 reports.

Two harnesses answer it, and they answer the same question:

- `test/cocoa-scroll-blit.test.js` runs in CI on any OS. Its bridge holds
  real rasters — a byte per pixel, `ScrollSurface` and `CopySurfaceRegion`
  written out with the natives' own clamping — and the proof obligation is
  one line: render the same pane into two windows, delete `scrollRegion`
  on the second (which is how the scroll blit feature-detects a backend without
  the fast path), and the buffer handed to the layer must hold the picture
  the repaint painted. Then the frames a pan meets: bursts coalesced into
  one frame, a frame painted but not presented, a present held or
  occluded, a resize mid-gesture, and two fuzzers over all of it.
- `scripts/cocoa-blit-probe.mjs` is the same comparison over the real
  bridge — CoreGraphics contexts, IOSurfaces, an actual swapchain — for
  when the question is whether the bridge does what the model says. Not
  part of the suite (it needs macOS); run it when the swapchain or the
  bridge's surface verbs change.

Both also count the blits, because two windows that both repainted agree
about everything and prove nothing.

## The plan

Each phase has an exit that makes the next safe to start; the first two
run against today's renderer with no core changes.

- **Phase 0 — the bridge contract.** Close the POC gaps
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
   Answered 2026-09-11, and neither: a nested drain never drains
   microtasks, and an inversion needs whoever owns `main()`. The answer is
   JS on a worker with AppKit parked on the main thread — §"JS on a worker:
   a UI thread of the bridge's own", with the bridge's half filed as
   [windowkit/appkit#49](https://github.com/windowkit/appkit/issues/49).
4. **Transition semantics under CA** — retarget/interrupt parity with
   the JS loop needs a written spec before Phase 5 flips the default.
5. **Cross-backend text metrics** — accepted divergence (per-backend
   pixel baselines) vs. the shared-shaping option if component layout
   portability bites in practice.
6. **Bun on the Cocoa backend** — N-API under Bun is expected to work;
   verify early (Phase 1) since single-file packaging is a stated goal.
   Answered in two halves: `make-app.sh` is that single file and it runs,
   and it cannot be the App Store one — a bun binary does not start under
   App Sandbox (§Distributing the bundle), so that build is node's SEA.
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
- Distribution: Apple, "App Sandbox" (the store requirement) and "Porting
  just-in-time compilers to Apple silicon" (`allow-jit` matters only under
  the hardened runtime); Apple DTS on the forums, "Signing a Mac Product
  For Distribution" (thread 128166) and "Creating distribution-signed code
  for Mac" (701514) — inside-out signing, no `--deep`; Bun, "Code signing
  on macOS" in the executables guide; Node, `tools/osx-entitlements.plist`;
  oven-sh/bun#15661 for bun under App Sandbox.
- WebKit/Gecko form-control rendering via offscreen `NSCell` drawing —
  the native-bezel technique the POC reproduces.
- [`@windowkit/appkit`](https://www.npmjs.com/package/@windowkit/appkit) —
  the bridge this document specified, as published. §"The bridge: the
  required API" was its 0.2.0 contract.
