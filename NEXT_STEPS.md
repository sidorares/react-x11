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
> 1. **3D components over indirect GLX** — the one large feature going in
>    before 1.0.0; plan and phase status in
>    [docs/glx-plan.md](docs/glx-plan.md). Phases 0-3 are merged: ntk 3.6.0
>    for the protocol blockers, then `<glarea>`, the `<mesh>` scene tree on
>    a display-list compiler, and lights. Left: textures, mesh pointer
>    events, README screenshots.
> 2. **Queued behind it (§11):** the menu/tooltip **safe polygon** (done)
>    and the **focus-state** gaps (done: window focus, the public focus API,
>    `tabIndex` ordering, focus scopes/modals and focus restore) — next in
>    §11 is the AT-SPI accessibility work the research in §11.3 scopes out.
> 3. Then merge release-please #17 and publish 1.0.0.
> 4. Upstream (ntk): distribute half-leading inside TextLayout itself
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
`Switch`, `ProgressBar` shipped in `src/components/` with a shared
merged theme (`ThemeProvider`; `SelectThemeProvider` is an alias) and a
`useControl` hook (hover/focus, click + Space/Enter, disabled). Gallery:
`examples/widgets.jsx`. Still open:

- **Slider** — DONE: `ev.capturePointer()` exposes pointer capture to
  userland, and `Slider` is built on it (drag past the widget bounds,
  arrows/Home/End/PageUp/Down)
- **Switch animation** — DONE via style transitions, not a per-widget
  requestAnimationFrame loop: the thumb is absolutely positioned and slides
  on `left`, and the same `transition` declaration eases the track colour.
  The frame loop runs only while something is unfinished
  ([docs/styling.md](docs/styling.md))
- **Tooltip** — DONE: `useAnchor(ref)`/`anchorRect()` extracted from
  `Select` (and now flip at screen edges), `Tooltip` built on them
- **Dialog** — DONE: a modal over `<popup trapFocus grab>`, centred with
  `centerRect()`; see §11.2
- **Menu/MenuBar, ContextMenu** — DONE: built on `useAnchor`, with
  separators, disabled items, shortcuts, checkmarks, nested submenus and
  full keyboard navigation; `examples/menu.jsx` rewritten on them
- **Demo themes — DONE.** `examples/themes.js` carries GitHub, macOS and
  Windows in light and dark, switched at runtime by
  `npm run examples:theming`, which also demonstrates a window size query.
  The palette grew shape tokens (`radius`, `radiusSmall`, `borderWidth`,
  `fontSize`, `paddingX`, `paddingY`) — without them a theme is only a
  recolour. Exercising it turned up a paint bug: `display: 'none'` left a
  node out of the layout but kept painting it, which never showed while
  `hidden` was the only way to hide anything
- **Tree — DONE.** Disclosure rows with the keyboard model a file browser
  has: Up/Down over the visible rows, Right/Left to open and step in or
  close and step out, type-ahead by prefix, and a twisty that opens a
  branch without moving the selection. Branch-ness is `children` being an
  array, so an empty one is a directory whose contents are not loaded yet
- **Tabs / SplitPane — DONE.** The two containers an application window is
  built from: `Tabs` (one panel at a time, roving focus, horizontal or
  vertical, lazy panels) and `SplitPane` (a draggable divider, keyboard
  resizable, clamped against the live container size). `examples/app.jsx`
  hosts `form`, `widgets` and `tasks` as tabs by importing the panel each
  now exports — new controls get demonstrated there rather than in yet
  another example. Still missing, roughly in order: Table with
  virtualization, undo/redo in the text controls, a generic Popover, and a
  file open/save dialog
- **Horizontal scrolling — DONE.** `<scrollview>` scrolls on both axes:
  `scrollX`/`contentWidth`, a second draggable bar, `scrollTo({x, y})`,
  horizontal wheel and Shift+wheel, and `scrollIntoView` on both axes. The
  extent is measured through the subtree the way `scrollWidth` is, so a row
  stretched to the viewport with overflowing cells — a table — still has
  something to scroll
- **`Select`/menu keyboard — DONE.** Arrows, Home/End, PageUp/PageDown,
  type-ahead, submenus. Keyboard navigation
  is done (#34: Up/Down/Home/End/Enter/Escape, shared pointer+keyboard
  highlight, active option scrolled into view)

### 3. Renderer gaps found while building the above

- **Pointer capture for userland** — DONE: `ev.capturePointer()` /
  `ev.releasePointer()` route move/up to the capturing node, released on
  mouseup and on unmount; hover freezes during a capture
- **Multi-line `<textarea>`** — DONE (#32), and the polish that was listed
  here after it (Ctrl+arrow word movement, PageUp/Down, Shift+click extend,
  the drawn scrollbar) has since landed too. The scrollbar is draggable in
  both `<textarea>` and `<scrollview>`
- **Bidi caret polish** — caret positions are bidi-correct now (ntk
  caret API), but arrow keys still move logically; visual-order movement
  - split caret at direction boundaries is a later refinement
- **Full-surface mask composites — DONE upstream.** Both paths are now
  bounded: glyphs in ntk 3.5.2 (sidorares/ntk#81 — rectangular clips go
  through `SetPictureClipRectangles` server-side, `TextLayout.draw`
  batches the whole layout) and fills/strokes in 3.5.3
  (sidorares/ntk#83 — mask work bounded to the path bbox). A clipped
  paragraph now costs the same as an unclipped one, and 50 small boxes
  dropped 8.16 -> 0.22 Mpx. Still full-surface: `drawImage` (two sites),
  and react-x11 repaints the whole window per frame (§8.4 below).
- **`opacity`** — needs offscreen composition (pixmap + Composite);
  ntk can do it, renderer needs a group-opacity paint path
- **Dirty-rect painting** — still full-window repaint per frame
  (NEXT_STEPS §8.4 below); fine so far, measure before optimizing
- **Stacking of real windows** — DONE for child `<window>`s: JSX order
  (and `zIndex`) is the stacking order, applied with ConfigureWindow
  `sibling`+`stackMode` once per commit. The same fix made `insertBefore`
  handle _moves_ at all — it used to splice a keyed child in a second time
  and abort yoga on the duplicate `insertChild`. Still open: `<popup>`s
  are siblings of every other app's window under the screen root, so tree
  order says nothing useful about them; top-level windows are the WM's
  (use `alwaysOnTop`)
- ~~WM close button~~ DONE: `<window onCloseRequest>` opts into
  WM_DELETE_WINDOW and dispatches at discrete priority (unmount/hide/quit
  is the handler's choice); see examples/windows.jsx
- **Keyboard**: AltGr/compose/IME not handled (ntk TODO), key repeat is
  server-side (works), keymap beyond index 0/1 unhandled

### 3a. Styling — DONE

Style moved out of the flat prop namespace into `style` (object or array,
flattened left-to-right), with element semantics keeping the props. That is
what removed the `<window>` `width`/`height` collision and let the WM size
hints unnest from `sizeHints`. Inline `:hover`/`:focus`/`:active`/`:disabled`
blocks resolve in the renderer — a repaint, no React render — and are
restricted to paint properties so a pointer move can never reflow the tree.
`createStyles` hoists and validates; an unknown style property is an error
instead of a silent no-op. `transition` animates numbers and colours off the
window's frame clock, starting from what is on screen so an interrupted
transition reverses. `$token` style values resolve against the nearest
`theme` prop, so a hoisted style can follow the palette with no React
context, and `'@width >= 600'` blocks restyle for the window's size —
layout included, since they only re-run inside a layout pass a resize
already required. See [docs/styling.md](docs/styling.md).

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
10. **Focus events and `SetInputFocus`.** `lib/events_map.js` has no entry
    for X `FocusIn`/`FocusOut` (events 9/10) and no `FocusChange` mask, so a
    client cannot tell when its window gains or loses keyboard focus, and
    ntk exposes no wrapper for `SetInputFocus` even though node-x11 has the
    request. Both are prerequisites for §11.2 here.

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
  example — both done. Window-manager example via SubstructureRedirect —
  **done** (`examples/wm.jsx`, issue #3). ntk's `child-event` turned out to
  drop the event payload, so a ConfigureRequest arrived without the
  geometry needed to answer it; fixed upstream along with property reads
  and the rest of the WM surface (ntk 3.9.0), over substructure redirect in
  node-x11's in-process server (3.2.0) so it can be tested headlessly.
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

## 11. Queued after the 3D work

Found while using the widget set. Both are worth doing before 1.0.0 gets
much use, and neither depends on the GLX work.

### 11.1 "Safe polygon" for menus, submenus and tooltips — DONE

Submenus open and switch **on hover with no delay and no exit tolerance**
(`Menu.js`, the `hover(index)` path). Moving the pointer diagonally from a
parent row toward its open submenu passes over the sibling rows in between,
each of which immediately re-points `path` and closes the submenu the user
was aiming at. Tooltips have the same shape of problem: any pixel outside
the trigger dismisses them, so a tooltip with interactive content cannot be
reached.

Fixed: the helpers live in `src/components/anchor.js` (`movingToward`,
`safePolygon`, `pointInPolygon`, `screenPoint`, `SAFE_HOVER_DELAY`), and
both `MenuLevel` and `Tooltip` use them; a tooltip now also stays up while
the pointer is over it, so tooltip content is reachable. What follows is
the original description.

The fix is floating-ui's [`safePolygon`](https://floating-ui.com/docs/usehover#safepolygon):
while a child surface is open, build a triangle from the pointer's position
to the two near corners of the child rect, and treat "still inside that
triangle (or moving toward the child)" as "still hovering the parent" —
plus a small close delay as the fallback. Notes for the implementation:

- It belongs next to the other popup geometry in `src/components/anchor.js`
  (a `useSafeHover(anchorRect, childRect)` hook), not in the renderer: it is
  a widget-level policy, and `MenuBar`, `ContextMenu`, `Select` and
  `Tooltip` should all share it.
- Everything it needs already exists: pointer coordinates on the synthetic
  events, the child's screen rect from `anchorRect`, and mousemove already
  coalesced to one per frame by ntk's frame clock.
- The tolerance has to be in **screen** coordinates, because the parent and
  the child are different X windows (`<popup>`).
- Worth a hermetic test: synthesize a diagonal pointer path across a sibling
  row and assert the submenu stays open, which is exactly the bug today.

### 11.2 Focus state — audit and gaps (DONE)

Done since: X `FocusIn`/`FocusOut` and `SetInputFocus` are exposed by ntk
(sidorares/ntk#89) and used here — the focused node keeps focus across a
window blur but stops looking active; `focus()`/`blur()`/`focused` and
`autoFocus` are public; focusing inside a `<scrollview>` scrolls into view;
and popups can hold a pointer grab so a press anywhere else dismisses them
(gap 3's real fix, and the cause of menus surviving a click on the window
frame).

The rest of the list is done too:

- **`tabIndex` ordering** — DOM sequential focus order (positive indices
  ascending, then the implicit-zero group in tree order); `tabIndex={-1}`
  is focusable by press/`focus()` but never tabbed to, and an explicit
  `tabIndex` implies `focusable`. `disabled` opts back out.
- **Focus scopes** — `trapFocus` on any node (a `<popup>`, in practice)
  owns a scope: Tab only visits focusables inside it, a press outside it
  does not move focus, and popping the scope restores focus to whatever
  had it before — so `<popup trapFocus grab>` + `autoFocus` _is_ a modal
  dialog, with no per-widget bookkeeping. Scopes nest.
- **Focus inside a popup** — an override-redirect window never gets the X
  input focus, so a popup's `EventManager` now **delegates focus to the
  owner window's** (`EventManager.focusManager`): a node inside the popup
  can be the owner window's focused node, keys arrive at the owner and
  dispatch to it, then bubble out through the popup's place in the JSX
  tree. That removes the reason for the focusable-proxy trick, though
  `Menu`/`Select` still use theirs (their rows are not focusable and the
  trigger wants the keys — a press inside a popup on nothing focusable
  deliberately leaves the owner's focus alone).

`Dialog` (`src/components/Dialog.js`) is the first consumer: a modal in a
`<popup trapFocus grab>` centred over the owner window, Escape to close,
`autoFocus` inside to pick the first stop, focus handed back on close —
demoed by the "Clear" confirmation in `examples/form.jsx`. It does **not**
enforce pointer modality (widgets behind it stay clickable); a full-window
overlay in the owner window would, and is the obvious follow-up along with
converting `Menu`/`Select` to the delegated focus path. The original audit
follows.

Everything below is how it works **today**; the state lives in
`EventManager` (`src/events.js`), one instance per `<window>`:

- `focused` is a node reference; mousedown moves it to the nearest focusable
  ancestor of the hit node, Tab/Shift+Tab cycle `_focusables()` in tree
  order, and `forget()` clears it on unmount.
- "Focusable" is `props.focusable ?? node.focusableByDefault` (true for
  `<textinput>`/`<textarea>`), and the widgets opt in through `useControl`.
- Key events are routed to `focused` (falling back to the window node), so
  focus is what makes keyboard input work at all.

The gaps, roughly in the order they bite:

1. **X focus changes are invisible to us.** ntk maps no event name and no
   mask for X `FocusIn`/`FocusOut` (events 9 and 10 — see
   `ntk/lib/events_map.js`), so when the window manager moves input focus to
   another window, react-x11 never hears about it: focus rings stay lit, the
   `<textinput>` caret keeps blinking, and no `onBlur` fires. **This is an
   ntk change first** (§8) — event names, masks, and `FocusChange` in the
   computed event mask — then a react-x11 change to gate node focus on
   window focus.
2. **We never call `SetInputFocus`.** node-x11 has the request; nothing in
   ntk or here uses it. Without it a node's `focus()` cannot pull keyboard
   input to its window, and a modal dialog cannot take focus on open.
3. **Popups cannot hold focus.** Override-redirect windows never receive X
   input focus, so `Menu` keeps a focusable proxy node in the _owner_ window
   and routes keys from there (`Menu.js`, "the popup is override-redirect
   and never gets focus itself"). It works, but it is a workaround every
   popup-based widget has to re-implement — model it once as a focus scope
   that a `<popup>` can own.
4. **No public focus API.** Components reach into
   `node.root.events.focus(node)`. There should be `ref.focus()` /
   `ref.blur()`, an `autoFocus` prop, and `document.activeElement`-ish
   access for widgets that need it.
5. **Tab traversal is thin**: no `tabIndex` ordering, no focus trap for
   modal popups, and focusing a node inside a `<scrollview>` does not scroll
   it into view even though `scrollIntoView(node)` exists.
6. **Focus is not restored** when a popup closes; menus do it by hand.

### 11.3 Accessibility — what the target actually is

Research, not a plan yet. Conclusion first: **being a pure-JS X11 client
does not block accessibility**, because Linux a11y does not go over the X
protocol at all.

- **AT-SPI2 is the interface**, and it is
  [D-Bus, not X](https://www.freedesktop.org/wiki/Accessibility/AT-SPI2/):
  applications expose a tree of objects on a separate _accessibility bus_,
  implementing interfaces (`Accessible`, `Component`, `Text`, `Value`,
  `Action`, …) whose XML introspection lives in
  [at-spi2-core/xml](https://github.com/GNOME/at-spi2-core). Toolkit-less
  applications are expected to
  [drive the bridge themselves](https://wiki.linuxfoundation.org/accessibility/atk/at-spi/at-spi_on_d-bus)
  rather than inherit it from GTK/Qt. For us that means a D-Bus client
  library and a service that mirrors the retained node tree — no native ATK,
  no C bindings.
- **Screen reader**: Orca. The modern stack is moving Wayland-ward — AT-SPI
  2.56 added an `a11y-manager` backend and switched from hardware keycodes
  to XKB keysyms for Mutter 48 / GNOME 48
  ([LWN](https://lwn.net/Articles/1025127/)) — but that is about how the
  _screen reader_ gets its input, not about the app-side interface. An
  AT-SPI implementation keeps working for X11 clients, including under
  Xwayland.
- **The prop shape to copy is React Native's**, not ARIA's: `accessible`,
  `accessibilityLabel`, `accessibilityHint`, `accessibilityRole`,
  `accessibilityState` (`disabled`, `selected`, `checked`, `busy`,
  `expanded`), `accessibilityValue`, plus accessibility actions. RN maps
  that one prop set onto two very different native APIs, and react-native-web
  maps the same props onto ARIA — good evidence the vocabulary survives a
  third mapping, onto AT-SPI roles and states.
- **Dependency on §11.2**: AT-SPI's focus notion is what a screen reader
  follows, so `focus:` / `state-changed:focused` events can only be emitted
  once window-level focus is tracked properly. Do the focus work first.
- Size: a live D-Bus service (tree + `Component` geometry from `node.abs`,
  `Text` from the text nodes, state changes on prop updates) is a sizeable
  project on its own — a `@react-x11/a11y` sibling package is probably the
  right shape, kept out of the core render path.
