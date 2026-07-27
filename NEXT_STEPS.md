# NEXT_STEPS.md — making react-x11 actually usable

> **Status (2026-07-27):** Phases 0–5 are done and merged: the widget set
> (#30), examples overhaul + `<window onCloseRequest>` (#31), multi-line
> `<textarea>` (#32), `Select` keyboard navigation + `scrollview`
> `scrollIntoView` (#34), framed screenshots via the real WM (#36), and
> window-manager hints as `<window>` props (#37). Pointer capture
> (`ev.capturePointer()`) and `Slider` are the newest.
>
> Upstream, all released: ntk **3.5.0** — `WM_NORMAL_HINTS`, `WM_CLASS`,
> `_NET_WM_WINDOW_TYPE`, always-on-top (ntk#77) — on node-x11 **3.1.2**,
> which carries the Apple-WM `FrameHitTest` fix (node-x11#229).
>
> npm publish still waits on release-please **PR #17 (1.0.0)**.
>
> **Plan (next session):**
>
> 1. Merge release-please #17 and publish 1.0.0.
> 2. Type-ahead in menus and `Select` (jump to the entry matching typed
>    letters).
> 3. `<textarea>` polish: Ctrl+arrow word movement, PageUp/Down,
>    Shift+click extend, drawn scrollbar.
> 4. `Select` follow-ups: type-ahead (jump to the option matching typed
>    letters) and PageUp/PageDown in the open menu.
> 5. Upstream (ntk): distribute half-leading inside TextLayout itself
>    (makes the #29 paint shift a no-op) + an opt-in cap-height trim
>    (`text-box-trim` analog); `maxLines`/ellipsis for `<text>`.

---

## Roadmap refresh — what's missing now (for the next session)

### 1. Expose ntk's rich-content widgets as elements — DONE (PR #27)

Shipped in `src/richnodes.js`: `<markdown>`,
`<html>`, `<svg>`, `<tex>` wrap the ntk document widgets in standalone
mode — `layout(width)`/`contentHeight` feed a yoga measure function,
`draw(ctx, x, y)` paints into the window context, `linkAt` is wired into
the mousedown default action (`onLink` prop), and `<scrollview>` wrapping
works via the normal measured-height path. Async content (mermaid models,
HTML images) reflows through the widgets' `onInvalidate` hook —
implemented upstream as sidorares/ntk#75, released in **ntk 3.4.0**
(the dependency is bumped). `<mermaid>` needs no dedicated element
(markdown fences cover it); `<paragraph>` stays out (see below —
maxLines/ellipsis would be a TextLayout feature first).

Left for later: per-link pointer cursor (cursor is per-node today),
`<tex>` baseline alignment with surrounding `<text>`.

### 2. Standard UI components (plain React, like `Select`)

Mostly DONE (PR #30): `Button`, `Checkbox`, `Radio`/`RadioGroup`,
`Switch`, `ProgressBar` shipped in `src/components.js` with a shared
merged theme (`ThemeProvider`; `SelectThemeProvider` is an alias) and a
`useControl` hook (hover/focus, click + Space/Enter, disabled). Gallery:
`examples/widgets.jsx`. Still open:

- **Slider** — DONE: `ev.capturePointer()` exposes pointer capture to
  userland, and `Slider` is built on it (drag past the widget bounds,
  arrows/Home/End/PageUp/Down)
- **Switch animation** — thumb snaps today; animate via
  requestAnimationFrame on the window ref, or step-render
- **Tooltip** — DONE: `useAnchor(ref)`/`anchorRect()` extracted from
  `Select` (and now flip at screen edges), `Tooltip` built on them
- **Menu/MenuBar, ContextMenu** — DONE: built on `useAnchor`, with
  separators, disabled items, shortcuts, checkmarks, nested submenus and
  full keyboard navigation; `examples/menu.jsx` rewritten on them
- **`Select` type-ahead / PageUp-PageDown** — keyboard navigation itself
  is done (#34: Up/Down/Home/End/Enter/Escape, shared pointer+keyboard
  highlight, active option scrolled into view)

### 3. Renderer gaps found while building the above

- **Pointer capture for userland** — DONE: `ev.capturePointer()` /
  `ev.releasePointer()` route move/up to the capturing node, released on
  mouseup and on unmount; hover freezes during a capture
- **Multi-line `<textarea>`** — DONE (#32). Polish left: Ctrl+arrow word
  movement, PageUp/Down, Shift+click extend, drawn scrollbar
- **Bidi caret polish** — caret positions are bidi-correct now (ntk
  caret API), but arrow keys still move logically; visual-order movement
  - split caret at direction boundaries is a later refinement
- **`opacity`** — needs offscreen composition (pixmap + Composite);
  ntk can do it, renderer needs a group-opacity paint path
- **Dirty-rect painting** — still full-window repaint per frame
  (NEXT_STEPS §8.4 below); fine so far, measure before optimizing
- **Stacking of real windows** — `insertBefore` for `<window>`/`<popup>`
  ignores order (X ConfigureWindow stackMode not modelled)
- ~~WM close button~~ DONE: `<window onCloseRequest>` opts into
  WM_DELETE_WINDOW and dispatches at discrete priority (unmount/hide/quit
  is the handler's choice); see examples/windows.jsx
- **Keyboard**: AltGr/compose/IME not handled (ntk TODO), key repeat is
  server-side (works), keymap beyond index 0/1 unhandled

### 4. Ecosystem / DX

- npm publish (merge release-please #17 → 1.0.0, then examples via
  `npx`?), CHANGELOG is automated
- README screenshots are now committed under `docs/img/` and regenerated
  by script (see AGENTS.md Pull requests section for the rule: PR-only
  images go to GitHub attachments, committed images only when globally
  useful — README qualifies)
- API docs live in `docs/` (elements/components/events/devtools)
- window-manager example (#3) — SubstructureRedirect is plumbed in ntk
  (`child-event`); would exercise `<foreign>`-style window wrapping
- react-native-dom-like packaging (#13) and mylittledom reuse (#10) are
  superseded by the native architecture; consider closing those issues

Goal: **react-like ergonomics on top of ntk** — good enough to develop and debug
real GUI apps. This document records the current state, what we learned from
other React renderers, the target architecture, and a phased roadmap. It also
separates work that belongs in **ntk** from work that belongs **here**.

Research basis: a source-level inventory of ntk 3.0.0 (`node_modules/ntk/lib`,
plus the source checkout with docs/tests) and an architecture survey of ink,
react-nodegui, react-native-gtk4, React Native Fabric, react-three-fiber,
@pixi/react, react-blessed, mylittledom, and Flutter.

---

## 1. Where we are

- One host component: `<window>` → a real X11 window per element
  (`src/Reconciler.js`). Layout is manual pixel math (see `examples/xeyes.js`),
  painting is imperative `onExpose` + `getContext('2d')`.
- ntk 3 already ships far more than the renderer uses:
  - XRender-backed canvas-like 2D context (paths, transforms, clips,
    gradients incl. conical, Porter-Duff composite ops, images)
    — `lib/renderingcontext_2d.js`.
  - A complete text stack: fontconfig discovery, fontkit shaping, bidi
    (UAX#9), line breaking (UAX#14), server-side glyph caching, `TextLayout`
    with alignment — `lib/text/*`.
  - yoga-layout + a postcss CSS cascade — but **only inside `HtmlView`**
    (`lib/widgets/htmlview.js`, `lib/widgets/css.js`); there is no general
    layout tree on ntk objects.
  - Per-window frame clock: event coalescing (mousemove=last, expose=union),
    fence-based server sync, `requestAnimationFrame`, double-buffered backing
    store — `lib/window.js`.
  - Document widgets: `HtmlView`, `MarkdownView`, `SvgView`, `TexView`,
    mermaid — all windowless, with a standalone `layout(width)` +
    `draw(ctx, x, y)` mode that makes them embeddable.
  - An in-process pure-JS X server (in node-x11) with XRender — hermetic
    tests with pixel readback, no `$DISPLAY` (already used by
    `test/integration.test.js`).
- What ntk does **not** have: interactive widgets (no button/input/scrollview),
  a retained scene graph, rect-level damage tracking (presentation is a
  full-window `CopyArea`), or any hit-testing/spatial index.
- Known bug found during this review: `Window` creation **silently drops
  `overrideRedirect`** (ntk `lib/window.js` hardcodes the `CreateWindow`
  value list) — yet `src/Reconciler.js:77` relies on it for child windows.
  Child-window mounting only works because reparent+map happens fast enough
  that the WM usually doesn't intervene.

## 2. What other renderers teach us

Condensed conclusions from the survey (details in the projects themselves):

- **Layout lives on the host node.** Every single-threaded renderer (ink,
  mylittledom; NodeGui inside its C++ FlexLayout) hangs one yoga node
  directly on each host instance and mirrors child-list mutations into it.
  Only Fabric uses a separate immutable shadow tree, and only because it
  needs multi-threaded/concurrent layout. We are single-threaded: **one yoga
  node per host instance, no shadow tree.**
- **Commit flush pattern (ink):** `resetAfterCommit` → compute layout →
  repaint, throttled to a frame budget. ntk's per-window frame clock +
  `requestAnimationFrame` is exactly the right sink for that.
- **Text is never generic children.** Everyone either throws from
  `createTextInstance` or funnels strings into a dedicated `<text>` host
  component whose yoga node carries a **measure function** calling the real
  text engine, with memoization and an explicit "text changed → markDirty"
  path. ink additionally squashes nested `<Text>` spans into one styled
  paragraph so wrapping happens over the whole run — we should copy that.
- **Nobody uses a spatial index for hit testing.** mylittledom scans a
  front-to-back stacking-ordered render list for first clip-rect containment;
  Flutter recursively hit-tests children front-to-back and records the path;
  r3f raycasts **only against objects that have handlers** (the one
  optimization that matters). See §5.
- **Fabric's view-flattening criteria** ("does this node need a real native
  view?") is the same question as our "does this element need a real X
  window?" — their answer: only when it forms a stacking context, has visual
  props, or has event handlers; everything layout-only is flattened.
  Our default is inverted (see §4): almost nothing needs a real X window.
- **mylittledom is prior art for exactly our problem** (issue #10): retained
  element tree + yoga + typed style properties with dirty-bit triggers
  (`dirtyLayout` / `dirtyClipping` / `dirtyRendering`), dirty-rect damage
  merging, front-to-back painting with painted-area subtraction, W3C
  capture/bubble events, focus list. Its style code is MIT and stealable in
  spirit even if not literally.

## 3. Target architecture

Three layers, replacing "one X window per element":

```
React element tree
      │  react-reconciler (mutation mode; keep updateContainerSync for tests)
      ▼
Retained node tree (lightweight JS objects, one per host element)
  • node.yoga        — yoga-layout node (created in createInstance,
                        freeRecursive'd on removal, ink-style)
  • node.style       — typed style object (layout props → yoga setters,
                        paint props → dirty-rect)
  • node.handlers    — event handlers, counted (r3f eventCount trick)
  • node.window      — ONLY for the few real-X-window element types (§4)
      ▼
Paint pipeline (per top-level <window>)
  resetAfterCommit:
    1. calculateLayout(window.width, undefined) on the dirty root
    2. diff computed rects → accumulate dirty rects
    3. schedule paint via wnd.requestAnimationFrame (ntk frame clock
       already does coalescing + server fencing)
  paint:
    walk the stacking-ordered render list, clip to dirty rects,
    draw into the window's single 2d context (backing store gives us
    flicker-free presentation for free)
```

Notes:

- ntk's `Window.setState({visible, x, y, width, height})` was explicitly
  written "for future react-renderer use" (declarative diffing of window
  geometry) — `commitUpdate` for `<window>` should use it instead of the
  current hand-rolled move/resize calls.
- Modernize the public API to `createRoot(container?) → { render, unmount }`
  alongside the legacy `render()`; keep sync flushing available because the
  tests pin it.
- Event pipeline (new, in react-x11): translate ntk window events into
  synthetic events with capture → target → bubble phases over the node tree;
  synthesize `mouseenter`/`mouseleave` by diffing the hover path; pointer
  capture; a focus list with Tab traversal; keyboard events routed to the
  focused node (ntk already attaches `ev.codepoint`). Use
  `DiscreteEventPriority` for clicks/keys and `ContinuousEventPriority` for
  mousemove via the existing update-priority plumbing.

## 4. Which elements get a real X window vs. drawn client-side

Historic X11 wisdom ("a window per widget: the server does clipping, expose
tracking, and event routing for you") is what GTK1/2-era toolkits did — and
what GTK3+/Qt5+ abandoned. Sub-windows can't be alpha-composited against
siblings, cost a round trip and a server resource each, flicker on
move/resize, can't be positioned sub-pixel, and fight the compositor. ntk's
per-window backing store + frame clock makes the client-side path cheap and
tear-free. So:

**Real X window (own `Window` object) — only when the server gives us
something we cannot do client-side:**

| Element                                        | Why it needs a real window                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `<window>` (top-level)                         | WM interaction: title, decorations, close protocol, resize events                                                              |
| `<popup>` / menus / tooltips / combo dropdowns | Must escape the parent window's bounds; needs `overrideRedirect` (or EWMH window types) — **blocked on the ntk attribute bug** |
| `<glarea>`                                     | GLX needs its own visual/drawable; can't share the XRender pipeline                                                            |
| `<foreign windowId={…}>`                       | Embedding external clients (XEMBED-ish); ntk's `createWindow({id})` foreign-window adoption already supports the wrapper side  |
| (later) video / shm surfaces                   | Different presentation path                                                                                                    |

Server-side wins we keep at this granularity: per-window expose coalescing,
frame pacing/fencing, input masks — all already in ntk.

**Client-side drawn (nodes in one window's render list) — everything else:**
`<box>`, `<text>`, `<image>`, `<canvas>`, buttons, inputs, scroll content.
Reasons: free overlap with antialiasing and alpha, zero per-element server
cost, animatable without flicker, one damage/paint pipeline, and hit testing
we control (§5). A scrollview is a clip rect + translation on the render
list, not a child window (optionally optimized later with `CopyArea`
scrolling inside the same window).

This is Fabric's flattening logic with the default flipped: an element is
"promoted" to a real window only for the reasons in the table, never because
it has event handlers or a background color.

## 5. Hit testing — and the kd-tree question

Recommendation: **no spatial index initially.** Every drawn-UI system
surveyed (mylittledom, Flutter, Pixi, r3f) uses a z-ordered walk:

1. Keep a render list per window, sorted by stacking context (zIndex, then
   tree order) — the same list painting uses.
2. Hit test = front-to-back scan for the first node whose clip-rect chain
   contains the point; then dispatch along the ancestor path
   (capture/bubble).
3. r3f's optimization: only nodes with `eventCount > 0` (plus their ancestor
   chains) participate in the scan. UIs have thousands of drawn rects but
   dozens of interactive ones.

A linear scan over a few hundred interactive rects is nanoseconds per event;
mousemove is already coalesced to once per frame by ntk. If a profiler ever
shows this hot (huge node-graph editors, 10k+ interactive elements), the
right structure for axis-aligned rects is an **R-tree or uniform grid built
over the render list after each layout** — not a kd-tree (kd-trees index
points; rectangles need overlap-aware structures). Design the render list as
an interface so an index can be slotted in without touching dispatch.

## 6. Layout & CSS: reuse ntk's, don't add dependencies

**yoga-layout: reuse, but move ownership.** ntk already depends on
yoga-layout ^3.2.1. react-x11 should drive yoga itself (per-node, incremental,
measure funcs) rather than through `HtmlView`, whose yoga usage is
rebuild-the-whole-tree-per-layout — fine for static documents, wrong for an
interactive retained tree. To guarantee a single WASM instance and no version
skew, **ntk should re-export its Yoga instance** (`export { Yoga }`) and
react-x11 should consume that rather than declaring its own yoga dependency.

**CSS: style objects as props, not a selector cascade.** React composition
replaces what selectors do; ink is the ergonomic model
(`<box flexDirection="row" gap={2} borderStyle=…>` or a `style` object).
So react-x11 needs:

- a typed style table mapping layout props → yoga setters and paint props →
  invalidation kind (borrow ink's `styles.ts` prop list and mylittledom's
  dirty-trigger idea);
- **value parsers reused from ntk**: `cssColor`/`parse-color` for colors,
  `canvas-fontstyle` for font shorthand, the `{px}/{pct}/auto` length tokens
  from `lib/widgets/css.js`.

The full postcss cascade (`parseStylesheet`, `computeStyles`, specificity)
stays in ntk for `HtmlView`. If app-level theming/stylesheets are wanted
later, extract that cascade into a DOM-agnostic ntk module and layer it on —
don't block the widget work on it. No new layout/CSS dependencies either side.

**Text measurement:** `<text>` nodes get a yoga measure function backed by
ntk's `FontManager.layout` / `TextLayout` (which already memoizes shaping);
cache per (content, style, width), and mark the yoga node dirty on text or
style change. Nested `<text>` spans squash into one styled paragraph
(ink's virtual-text pattern) so wrapping is paragraph-wide.

## 7. Component roadmap

Primitives (the renderer core):

- `<box>` — flex container; background, border (incl. radius via
  `roundRect`), padding, `overflow: hidden` (clip), zIndex, opacity.
- `<text>` — styled text + nested spans; the only place string children are
  legal (`createTextInstance` keeps throwing elsewhere, with a pointer to
  `<text>`).
- `<image>` — ntk `Image`/`decodeImage` + server upload cache; yoga measure
  or aspectRatio like `HtmlView` does.
- `<canvas onDraw={ctx => …}>` — the escape hatch; a retained render-list
  node whose paint calls back into user code (replaces today's raw
  `onExpose` idiom, keeps xeyes-style apps possible).
- `<scrollview>` — clip + offset + wheel handling (buttons 4/5 already
  arrive as mousedown), drawn scrollbars.
- `<window>` (kept), `<popup>`, `<glarea>`, `<foreign>` — the real-window
  set from §4.

Widgets (can start life in this repo as plain React components over the
primitives — they need no reconciler support once focus/hover/events exist):

- `<button>`, `<checkbox>`/`<radio>`, `<slider>`, `<select>` (needs
  `<popup>`), `<listview>`.
- `<textinput>` — the hardest and most valuable for "actually usable":
  caret + selection rendering via `TextLayout` glyph positions, keyboard
  editing, X11 selections/clipboard (see ntk list — needs a helper),
  double-click word select. Single-line first; multi-line later.
- Rich content: `<html>`, `<markdown>`, `<svg>`, `<tex>` as thin wrappers
  over ntk's widgets in standalone mode (`layout(width)` +
  `draw(ctx, x, y)` + `contentHeight` slots directly into a yoga measure
  function). Needs `onInvalidate` (already in ntk's source repo for
  markdown/mermaid async content — must be in the next published version).

Deliberately out of scope for now: accessibility (AT-SPI), IME/compose input,
Wayland.

## 8. Changes that belong in ntk

File these as ntk issues; react-x11 should not work around them long-term.

1. **Bug: `createWindow` drops window attributes.** `CreateWindow` hardcodes
   `{bitGravity, eventMask}`; `overrideRedirect`, `cursor`, `backgroundPixel`,
   `saveUnder`, input-only class are all silently ignored (`lib/window.js`).
   react-x11 passes `overrideRedirect: true` today and it does nothing.
   Blocking `<popup>`.
2. **UTF-8 window titles + EWMH** — DONE. `_NET_WM_NAME` shipped in ntk
   3.3.0; `WM_NORMAL_HINTS`, `WM_CLASS`, `_NET_WM_WINDOW_TYPE` and
   always-on-top in **ntk 3.5.0** (sidorares/ntk#77), surfaced here as
   `<window resizable sizeHints wmClass windowType alwaysOnTop>` and a
   default `windowType="dropdown_menu"` on `<popup>`. Note the type hint is
   _additive_, not a replacement for override-redirect: the spec asks for it
   on override-redirect windows so compositors can style menus consistently,
   while override-redirect is still what stops the WM repositioning them.
   Still missing upstream: `_NET_WM_ICON`, `_NET_WM_STATE` (fullscreen /
   maximize / minimize), `_NET_WM_PID`.
3. **Re-export the Yoga instance** so renderer and HtmlView share one WASM
   module and version.
4. **Rect-level presentation.** `_presentNow` blits the full window; accept
   dirty rects from the renderer and `CopyArea` only those. Coarse full-window
   blit is fine at first but wasteful for caret blink / hover highlights.
5. **Clipboard/selection helper.** Raw `selection_request`/`selection_clear`
   events exist; ntk should own CLIPBOARD/PRIMARY acquisition, TARGETS
   negotiation, and string transfer. Prerequisite for `<textinput>`.
6. **Cursor support** (cursor font or Xcursor) — pointer feedback for
   buttons/inputs/resize handles.
7. **2D context gaps that widget painting will hit:** `setLineDash` (focus
   rings), round line caps/joins (currently degraded to square/bevel),
   `strokeText` or outline-text helper; document that `clearRect` fills
   opaque white. ARGB/depth-32 window visuals for translucent popups
   (`createPixmap` already hardcodes depth 32 with a TODO — windows don't).
8. **Publish ntk 3.x to npm** (currently consumed from git) and include the
   `onInvalidate` MarkdownView API already present in the source repo.
9. (Nice-to-have) `queryPointer` promise variants and any other cb-only APIs
   used by examples.

## 9. Phased plan

**Phase 0 — unblock (small PRs):**
ntk items 1–3 and 8; `createRoot` API here; `commitUpdate` via
`wnd.setState`.

**Phase 1 — the drawn layer:**
retained node tree + yoga per node; `<box>`, `<text>`, `<image>`;
resetAfterCommit → layout → dirty rects → paint on ntk's frame clock.
Success test: xeyes rewritten with zero manual layout math, and a hermetic
integration test asserting pixels via the in-process X server.

**Phase 2 — interaction:**
synthetic event system (capture/bubble, enter/leave, pointer capture), hit
testing per §5, hover/active/focus state, Tab traversal; `<button>`,
`<checkbox>`, `<slider>`, `<scrollview>`, `<canvas>`.

**Phase 3 — text input & popups:**
`<textinput>` (with ntk clipboard + cursor work), `<popup>`, `<select>`,
menus/tooltips.

**Phase 4 — rich content & special surfaces:**
`<markdown>`/`<html>`/`<svg>`/`<tex>` wrappers, `<glarea>`, `<foreign>`.

**Phase 5 — developer experience (the "debugging" half of the goal):**

- Debug overlay: paint layout rects / dirty-rect flashing
  (mylittledom's `debugPaintRects`, Flutter's repaint rainbow) toggled by
  env var alongside the existing `REACT_X11_DEVTOOLS` bridge.
- DevTools: highlight-on-hover from the DevTools tree to the window
  (we own hit rects, so this is easy), inspect computed yoga layout.
- Hot reload example (react-refresh + a file watcher), widget-gallery
  example, window-manager example via SubstructureRedirect
  (`child-event`/`map_request` support already exists in ntk) — issue #3.
- npm publish with the examples runnable via `npx`.

## 10. Open questions

- Stacking: is zIndex-per-node enough, or do we model full stacking
  contexts (opacity groups need offscreen composition via pixmap + `Composite`
  — ntk can do it, but defer until something needs it)?
- `insertBefore` for real X windows is still unmodelled (X `ConfigureWindow`
  stackMode) — matters once `<popup>` exists; drawn nodes get correct order
  from the render list for free.
- Should the widget set (Phase 2/3) live in this package or a
  `@react-x11/widgets` sibling once primitives stabilize?
- ESM migration here (ntk is ESM-with-TLA; the dynamic-import dance in
  `src/Reconciler.js` disappears if react-x11 goes ESM).
