# NEXT_STEPS.md — making react-x11 actually usable

> **Status (2026-07-30, audited against the tree):** Phases 0–5 are done and
> merged, and so is the **3D work over indirect GLX** in full — `<glarea>`,
> the `<mesh>` scene tree on a display-list compiler, lights, textures and
> mesh pointer events. [docs/glx.md](docs/glx.md) is no longer a plan: #93
> turned it into the design document behind the shipped API.
>
> Since then: a **documentation site** with react-x11 running in the browser
> (#92), and a right-click edit menu for the text controls (#90).
>
> Upstream, all released: **ntk 4.0.0** on **node-x11 (x11) 3.3.0**. Between
> them they carry the window-manager surface, focus events, clipboard,
> cursors, the ~10x faster software RENDER compositor, the RENDER colour
> guard, and region-based damage. ntk 4 dropped mermaid — see
> [sidorares/ntk#106](https://github.com/sidorares/ntk/issues/106).
>
> **Published npm version is 1.2.0**; release-please **PR #69 is 2.0.0**,
> holding the breaking change from #68 (style is the only style channel).
> Everything above — the site included — is unreleased until it merges.
>
> **Plan (next session):**
>
> 1. Decide on **2.0.0** and merge #69.
> 2. **§11 accessibility (AT-SPI) — DONE, and in core rather than the
>    sibling package this line used to predict.** Orca reads the widget
>    gallery: roles, names, states, live text editing, AT-driven activation
>    and value changes. Standard `role`/`aria-*` props on every element,
>    `src/a11y.js` (the model) + `src/atspi.js` (the bridge) on the D-Bus
>    layer that was already here, off silently wherever there is no bus.
>    See [docs/accessibility.md](docs/accessibility.md) and §11.3.
> 3. **#85 (keyboard layout switching) is done**: ntk reads the active group
>    out of the event state, so a Cyrillic layout types Cyrillic, and
>    `src/keyboard.js` resolves the Latin keysym for shortcuts — from the
>    Latin group where there is one, from the physical position where
>    XQuartz's keymap rewrite has left none. That leaves **#86**
>    (`sans-serif` resolves to a CJK font on macOS) as the oldest open one,
>    and AltGr as the piece §15 still owns. The rest of
>    the backlog is now filed too — #113–#130 here, and the upstream half as
>    sidorares/ntk#115–#126, sidorares/node-x11#243–#247 and
>    sidorares/dbus-native#389–#392.
> 4. Upstream (ntk): distribute half-leading inside TextLayout itself
>    (makes the #29 paint shift a no-op) + an opt-in cap-height trim
>    (`text-box-trim` analog); `maxLines`/ellipsis for `<text>` (neither
>    exists in `src/` yet).
> 5. **Write the pages that do not exist** (#128): remote display — the
>    case the architecture is actually for, and the only one with no page
>    at all — security (X11 has no client isolation, and the `-X`/`-Y`
>    decision), and packaging (§13). The ecosystem half of that list is
>    answered: [docs/ecosystem.md](docs/ecosystem.md) and a page per
>    category beside it say which npm libraries work here, which need an
>    adapter and which cannot. None of the three left is engineering, all
>    three are load-bearing, and the first two are an afternoon each.
> 6. **Decide the §12 list before merging #69.** Every rename in it is one
>    commit while 2.0.0 is unreleased and a deprecation cycle afterwards.

---

## Roadmap refresh — what's missing now (for the next session)

### 1. Expose ntk's rich-content widgets as elements — DONE (PR #27)

Shipped in `src/richnodes.js`: `<markdown>`,
`<html>`, `<svg>`, `<tex>` wrap the ntk document widgets in standalone
mode — `layout(width)`/`contentHeight` feed a yoga measure function,
`draw(ctx, x, y)` paints into the window context, `linkAt` is wired into
the mousedown default action (`onLink` prop), and a scrolling `<box>` wrapping
works via the normal measured-height path. Async content (HTML images)
reflows through the widgets' `onInvalidate` hook — implemented upstream as
sidorares/ntk#75, released in **ntk 3.4.0** (the dependency is bumped).
`<paragraph>` stays out (see below — maxLines/ellipsis would be a
TextLayout feature first).

Left for later: per-link pointer cursor (cursor is per-node today),
`<tex>` baseline alignment with surrounding `<text>`.

### 2. Standard UI components (plain React, like `Select`)

Mostly DONE (PR #30): `Button`, `Checkbox`, `Radio`/`RadioGroup`,
`Switch`, `ProgressBar` shipped in `src/components/` with a shared
merged theme (`ThemeProvider`, `useTheme`) and a
`useControl` hook (hover/focus, click + Space/Enter, disabled). Gallery:
`examples/widgets.jsx`. Still open:

- **Slider** — DONE: `ev.capturePointer()` exposes pointer capture to
  userland, and `Slider` is built on it (drag past the widget bounds,
  arrows/Home/End/PageUp/Down)
- **Switch animation** — DONE via style transitions, not a per-widget
  requestAnimationFrame loop: the thumb is absolutely positioned and slides
  on `start`, and the same `transition` declaration eases the track colour.
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
  another example. Table with virtualization is DONE (built on
  `onViewport`), and undo/redo in the text controls is DONE (#84:
  coalescing runs, snapshot history, `undo()`/`redo()`/`canUndo`/`canRedo`
  on the node). The **right-click menu for the text controls** is DONE too
  (#90, issue #88): `src/editmenu.js` builds it from the node's own
  capabilities, and the selection-collapse half of that issue went with it —
  a right-click inside a selection keeps it, only one outside moves the
  caret (`defaultMouseDown`), which is what GTK and Qt do. Still missing:
  a generic Popover, and a file open/save dialog
- **Horizontal scrolling — DONE.** A scroll container scrolls on both axes:
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
  both `<textarea>` and a scrolling `<box>`
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
- **Dirty-rect painting** — done for the paint-only paths. A node that
  changes appearance without moving records its region, and the frame then
  clips to it, refills only that much background, and skips emitting drawing
  for any subtree that does not reach into it. Hovering one row of forty:
  4500 -> 644 bytes out, 41 -> 4 composites, 0.283 -> 0.015 Mpx. Layout
  changes still repaint in full, and deliberately: a node that moved leaves
  stale pixels at a rect the new one does not cover. `test/dirty-rect.test.js`
  pins the invariant by painting each case twice — bounded, then full — and
  comparing the readbacks.

  **Arbitrary React updates are bounded too.** A commit calls `applyProps` on
  every node it walked, and React rebuilds sibling style objects on every
  render, so the union used to cover the container. Now a node only claims
  damage if something it _draws_ changed: paint-relevant style compared by
  value, plus any non-style prop, since that is where a subclass's content
  lives — `<image src>`, `<canvas onDraw>`, a `value`, a `placeholder`.
  `children`, event handlers and `style` are skipped, the first because child
  mutations invalidate through their own paths. One row of forty recoloured
  through `setState`: 5160 -> 732 bytes out, 45 -> 4 composites, 0.297 ->
  0.015 Mpx, damaging 386x14 instead of the window.

  The fallback is safe by construction: if no node claims damage, the frame
  repaints everything. That is worth knowing when writing tests here — a
  single changed prop cannot demonstrate a missed repaint, because nothing
  bounds the region. It takes a second change that _does_ bound it.

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
- **Keyboard**: AltGr and IME not handled, key repeat is server-side
  (works). ~~Compose and dead keys~~ done (#276), and ~~keymap beyond
  index 0/1~~ done (**issue #85**): ntk reads the active group from bits
  13–14 of the event state, so a non-Latin layout types, and
  `src/keyboard.js` keeps shortcuts on the Latin keysym — including under
  XQuartz, which has no groups at all and rewrites the keymap instead, so
  after a switch no group holds Latin and the keycode is what is left.
  `onContextMenu` is done (#90) — dispatched from button 3,
  `preventDefault()` suppresses the built-in edit menu

  Two of the three consequences this list used to carry are gone; the
  first and the last remain, in increasing order of severity:

  - **AltGr is dead.** `@` on a German layout, `€` on most European ones,
    `ł` on Polish, `ã` on US-International — none of them can be typed.
    The blocker is not the level rule any more, it is that the **core
    keyboard map is ambiguous**: four keysyms on a keycode are two groups
    of two levels under `us,ru` and one group of four levels under
    `us(intl)`, and nothing in the core protocol tells them apart. The
    request that would is XkbGetMap, which node-x11 does not implement, so
    ntk reads groups only and refuses to guess at levels 3–4.
  - ~~**No Compose and no dead keys.**~~ Done in #276: a trie over the
    built-in sequences, plus `$XCOMPOSEFILE`/`~/.XCompose` on request, and
    a preedit in the text controls (`src/compose.js`, docs/events.md).
  - **No input method at all.** No preedit string arriving from another
    process, no candidate window, no commit event. The preedit _model_ is
    there now — `<textinput>` has somewhere for uncommitted text to live —
    but nothing fills it from ibus, fcitx or XIM, so CJK is still absent.

  Staged in §15; the level rule and the Compose engine are
  sidorares/ntk#116. Stage 1 is entirely inside ntk and is worth more than
  any widget polish left on this list — it is the difference between "works
  for English" and "works". Stage 0, saying so in `README.md` and under
  `<textinput>` in [docs/elements.md](docs/elements.md), costs nothing and
  should not wait for stage 1.

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

- npm publish — DONE, `react-x11` is on npm and CHANGELOG is automated;
  release-please keeps a release PR open for the next version. Note that
  **1.2.0 is still the published version** while the open release PR is
  **2.0.0** — it carries the breaking change from #68 (style is the only
  style channel), so everything since, the documentation site included, is
  unreleased. Still open: running the examples via `npx`? (there is no `bin`
  field yet)
- README screenshots are now committed under `docs/img/` and regenerated
  by script (see AGENTS.md Pull requests section for the rule: PR-only
  images go to GitHub attachments, committed images only when globally
  useful — README qualifies)
- API docs live in `docs/` (elements/components/events/devtools)
- **`docs/` is reference-only** (#128). Every page is either a feature tour
  or an API listing: no tutorial, no troubleshooting page, no FAQ. That
  works for a reader already sold. The one who has not decided yet gets
  intro → getting-started → the reference pages → "read `examples/`", and
  the errors they will actually hit have no page at all:
  `Cannot open display` with no `$DISPLAY` (XQuartz needs a _fresh_
  terminal after install, which nothing says);
  `fontconfig matching needs node (fc-match CLI)` in a container;
  `sans-serif` resolving to a CJK font on macOS (#86, a filed bug with no
  troubleshooting entry); `SyntaxError: Unexpected token '<'` from a `.jsx`
  under plain `node`; and
  `react-x11: <box height=…> is a style property`, which is a deliberately
  good error that deserves a page explaining the model. A
  `docs/troubleshooting.md` keyed by the **exact error text**, so a search
  engine lands on it, is the highest ratio of usefulness to effort in the
  documentation. The library half of that gap is closed —
  [docs/ecosystem.md](docs/ecosystem.md) plus a page per category beside it
- **The site has an in-page X server and the docs do not use it.** Every
  runnable snippet in `docs/` could carry an "open in playground" link with
  its source; the bundle and the share/permalink machinery already exist
  (`website/scripts/check-share.mjs`). "Click to run this in your browser,
  against a real X server implementation" is a documentation experience
  approximately no systems library has, and it is already built
- **A `bin` field** (the open question above) plus `examples` in `files`,
  so `npx react-x11 examples <name>` works. Scoped as the _demo_ runner,
  not an app runner: the examples already export their `App` and honour
  `REACT_X11_NO_AUTORUN`, so it is a switch statement. The app runner —
  `react-x11 app.jsx` setting up the JSX loader — is worth it separately,
  because it deletes the "JSX needs a loader, here are three options"
  paragraph from the first-run experience
- window-manager example (#3) — DONE, `examples/wm.jsx` + `examples/wm-core.js`
  on ntk 3.9.0 / node-x11 3.2.0, with `test/wm.test.js` driving it headlessly
- react-native-dom-like packaging (#13) and mylittledom reuse (#10) are
  superseded by the native architecture — both closed, along with #4

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
  - Document widgets: `HtmlView`, `MarkdownView`, `SvgView`, `TexView` —
    all windowless, with a standalone `layout(width)` +
    `draw(ctx, x, y)` mode that makes them embeddable.
  - An in-process pure-JS X server (in node-x11) with XRender — hermetic
    tests with pixel readback, no `$DISPLAY` (already used by
    `test/integration.test.js`).
- What ntk does **not** have: interactive widgets (no button/input/scroll pane),
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

| Element                                        | Why it needs a real window                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<window>` (top-level)                         | WM interaction: title, decorations, close protocol, resize events                                                                                                        |
| `<popup>` / menus / tooltips / combo dropdowns | Must escape the parent window's bounds; needs `overrideRedirect` (or EWMH window types) — **blocked on the ntk attribute bug**                                           |
| `<glarea>`                                     | GLX needs its own visual/drawable; can't share the XRender pipeline                                                                                                      |
| `<foreign windowId={…}>`                       | Embedding external clients — **done** (issue #269, docs/embedding.md): XEmbed over ntk's `XEmbedSocket`, plus the plain-reparent path `xterm -into` and `mpv --wid` need |
| (later) video / shm surfaces                   | Different presentation path                                                                                                                                              |

Server-side wins we keep at this granularity: per-window expose coalescing,
frame pacing/fencing, input masks — all already in ntk.

**Client-side drawn (nodes in one window's render list) — everything else:**
`<box>`, `<text>`, `<image>`, `<canvas>`, buttons, inputs, scroll content.
Reasons: free overlap with antialiasing and alpha, zero per-element server
cost, animatable without flicker, one damage/paint pipeline, and hit testing
we control (§5). A scroll pane is a clip rect + translation on the render
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
- Scrolling — clip + offset + wheel handling (buttons 4/5 already
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
  HtmlView async content — must be in the next published version).

Deliberately out of scope for now: accessibility (AT-SPI), IME/compose input,
Wayland.

## 8. Changes that belong in ntk

File these as ntk issues; react-x11 should not work around them long-term.

1. **Bug: `createWindow` drops window attributes** — DONE (sidorares/ntk#56).
   `CreateWindow` used to hardcode `{bitGravity, eventMask}` and silently
   ignore `overrideRedirect`, `cursor`, `backgroundPixel`, `saveUnder` and
   the input-only class; `lib/window.js` now passes the full attribute set
   through, which is what unblocked `<popup>`.
2. **UTF-8 window titles + EWMH** — DONE. `_NET_WM_NAME` shipped in ntk
   3.3.0; `WM_NORMAL_HINTS`, `WM_CLASS`, `_NET_WM_WINDOW_TYPE` and
   always-on-top in **ntk 3.5.0** (sidorares/ntk#77), surfaced here as
   `<window resizable sizeHints wmClass windowType alwaysOnTop>` and a
   default `windowType="dropdown_menu"` on `<popup>`. Note the type hint is
   _additive_, not a replacement for override-redirect: the spec asks for it
   on override-redirect windows so compositors can style menus consistently,
   while override-redirect is still what stops the WM repositioning them.
   Still missing upstream: `_NET_WM_ICON` and `_NET_WM_PID` (neither appears
   in ntk's `lib/`), and `_NET_WM_STATE` beyond always-on-top — ntk sets
   `_NET_WM_STATE_ABOVE` but exposes no fullscreen / maximize / minimize.
3. **Re-export the Yoga instance** so renderer and HtmlView share one WASM
   module and version — DONE (sidorares/ntk#58), `import { Yoga } from 'ntk'`.
4. **Rect-level presentation** — DONE (sidorares/ntk#110). A drawing operation
   reports its clip rectangle through `_markDirty`, the window accumulates the
   union, and the present copies that instead of the surface. No caller API:
   an operation that was not clipped reports nothing and the frame falls back
   to a full blit, and that fallback absorbs, so one unbounded operation keeps
   the whole frame unbounded rather than copying less than was drawn. A hover
   repaint of two tab headers went from 4.20 Mpx copied to 0.03. Scrolling
   barely moved — those frames repaint most of the window anyway.

   The box that was left — two small changes at opposite corners copying
   everything between them — is gone too, on both sides at once: DONE
   (sidorares/ntk#112, released as **3.10.2**, plus the renderer half in this
   repo). Damage is a short list of rectangles
   rather than the box around them: the renderer paints a pass per rectangle,
   each clipped to just that one so ntk's server-side rectangular-clip fast
   path still applies, and ntk accumulates the reported clips into a list and
   copies each. Both lists are capped — 4 rectangles in the renderer, where one
   costs a whole pass over the tree, 8 in ntk, where one costs a CopyArea — and
   both collapse back to the surrounding box when splitting would not save at
   least a quarter of it, so nothing changes for the common case of changes near
   each other. Measured through the stress app's Damage panel, "scattered" mode
   (four cells at the corners of a 24x16 grid): **2508 kpx painted and copied
   per five frames, down to 51 kpx** — 49x. "every cell" is unchanged at 2508
   kpx, which is what makes that number mean something, and hovering two
   adjacent tab headers is unchanged at 33 kpx because the collapse rule
   declines to split it.

5. **Clipboard/selection helper** — DONE (sidorares/ntk#69). ntk owns
   CLIPBOARD/PRIMARY acquisition, TARGETS negotiation and string transfer,
   including INCR for large payloads; this is what `<textinput>` cut/paste
   runs on.
6. **Cursor support** — DONE (sidorares/ntk#68), surfaced here as the
   `cursor` style property.
7. **2D context gaps that widget painting will hit:** `setLineDash` (focus
   rings) and round line caps/joins are DONE (sidorares/ntk#70). Still open:
   `strokeText` or an outline-text helper (nothing in ntk's `lib/`), a note
   that `clearRect` fills opaque white, and ARGB/depth-32 window visuals for
   translucent popups (`createPixmap` hardcodes depth 32 — windows don't).
8. **Publish ntk 3.x to npm** — DONE, ntk is on npm (3.9.0 latest) with
   release-please, and the `onInvalidate` API shipped in 3.4.0.
9. (Nice-to-have) `queryPointer` promise variants and any other cb-only APIs
   used by examples.
10. **Focus events and `SetInputFocus`** — DONE (sidorares/ntk#89).
    `FocusIn`/`FocusOut` and the `FocusChange` mask are mapped, and
    `window.focus(revertTo)` wraps `SetInputFocus`. This is what §11.2 was
    waiting on.
11. **One PR for the property writers, not seven** (sidorares/ntk#118, with
    the `_NET_WM_STATE` half as sidorares/ntk#117 and the react-x11 props
    as #122). `setProperty(name, value, {type, format})` and `atom(name)`
    already exist in `lib/window.js`, so most of the missing window
    properties are three-line methods over machinery that is already there.
    Batch them: `addProtocol` (read-modify-write — the current
    `WM_PROTOCOLS` write **clobbers**, so every protocol added after the
    first silently erases the one before it), `sendClientMessage`,
    `setWmHints` (the `input`/`WM_TAKE_FOCUS` model — this is the "keyboard
    sometimes doesn't work under a reparenting WM" bug), `setPid` +
    `WM_CLIENT_MACHINE` + `_NET_WM_PING`, `setIcon` (`_NET_WM_ICON`),
    `setState` for the thirteen `_NET_WM_STATE` atoms rather than only
    `ABOVE`, `setMotifHints` for an undecorated window, `setTransientFor`
    (sidorares/ntk#126, which is what #130 needs) and the
    `USPosition`/`PPosition` hints. Each of these on its own is a
    three-repo release chain — node-x11 → ntk → here — and batching is what
    makes that survivable.

    **Trap on all of them:** `setProperty` is `async` and its two
    `InternAtom` awaits can reject while the connection is closing, while
    `WindowNode._applyWindowHints` calls the hint setters synchronously and
    drops the promises. Every new property setter inherits that
    unhandled-rejection hazard until they are wrapped the way `setTitle`
    wraps its deferred chain (the `safeRelease` + serial-guard pattern in
    `lib/window.js`).

    The two that unblock a whole persona each: `_NET_WM_STATE_FULLSCREEN`
    plus `_MOTIF_WM_HINTS` with `decorations=0`, which is
    `<window fullscreen undecorated>` and is the entire ask of anyone
    shipping a kiosk or an appliance; and `_NET_WM_ICON`, which is a short
    writer and is the difference between "a program" and "an app" in the
    taskbar and the alt-tab list. `examples/wm-core.js` already _reads_
    `_NET_WM_ICON`; nothing writes it.

12. **Delete the `keysym` dependency** (sidorares/ntk#115). ntk uses
    exactly one thing from it — `keysym.fromKeysym(sym).unicode` in
    `lib/window.js` — and the package reads its JSON tables with
    `fs.readFileSync(__dirname + …)` at module load, which is why nothing
    importing ntk can be bundled or put in a Node SEA (§13). The rule it
    implements is small: keysyms `0x01000000..0x0110FFFF` map to
    `sym & 0xFFFFFF`, Latin-1 keysyms map to themselves, and the remainder
    is a table. Inline it as `lib/text/keysym-unicode.js`, a plain object
    literal, zero I/O. That unblocks bundling, SEA and the browser build at
    once and drops a 2013 unmaintained transitive off the dependency
    surface. The website has already written the replacement —
    `website/scripts/browser-shims/keysym.js`, whose comment says exactly
    this — so the knowledge exists and is trapped in the docs site.
13. **The XKB level rule and a Compose engine** (sidorares/ntk#116, §15
    stage 1). Replace `symInd = capital ? 1 : 0` with the real level
    resolution, then a Compose/dead-key trie, and emit through a new event
    that carries a **string** rather than a codepoint —
    `wnd.on('textinput', ({ text, preedit, cursor }) => …)` — so the
    renderer never has to know which backend produced it. node-x11 ships
    `lib/ext/xkb.js` and nothing uses it.
14. **Buffer the output stream** (sidorares/node-x11#244, §14). This one is
    node-x11 rather than ntk: `xcore.js` does `pack_stream.put(packet)`
    then `pack_stream.flush()` per request unconditionally, and
    `framebuffer.js`'s `flush()` walks the queue writing each buffer with
    no `writev` and no concatenation, so the 86 requests of the mount bench
    scenario are 86 writes for 3652 bytes. Add an explicit flush policy —
    accumulate, and force a flush when a reply-expecting request is queued
    (`xcore.js` already knows which those are), when the buffer crosses
    16 KB, when the loop is about to idle, or on an explicit `X.flush()` —
    and concatenate the queue into one write. **The right high-level flush
    point is ntk's `_present()`: one write per frame**, which is
    sidorares/ntk#125. Then `setNoDelay(true)` on TCP connections, exposed
    as `createClient({ tcpNoDelay })`, which is only safe once the
    buffering lands.

## 9. Phased plan

**Phase 0 — unblock (small PRs):** DONE. ntk items 1–3 and 8 have all
shipped, along with 5, 6 and 10; `createRoot` and `commitUpdate` via
`wnd.setState` are in. What is left of §8 is items 4, 7 and 9, plus the
EWMH remainder in item 2 — none of it blocking.

**Phase 1 — the drawn layer:**
retained node tree + yoga per node; `<box>`, `<text>`, `<image>`;
resetAfterCommit → layout → dirty rects → paint on ntk's frame clock.
Success test: xeyes rewritten with zero manual layout math, and a hermetic
integration test asserting pixels via the in-process X server.

**Phase 2 — interaction:**
synthetic event system (capture/bubble, enter/leave, pointer capture), hit
testing per §5, hover/active/focus state, Tab traversal; `<button>`,
`<checkbox>`, `<slider>`, a scroll pane, `<canvas>`.

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
  `@react-x11/widgets` sibling once primitives stabilize? **Answered, and
  worth writing down rather than leaving open: the widgets stay in core,
  and the siblings that do get split out live in this repo as npm
  workspaces.** The widgets are plain React over the primitives with no
  extra dependency, so splitting them buys nothing and costs a
  peer-version matrix. The one package that still wants to be separate is
  `@react-x11/desktop` (D-Bus: portals, notifications, tray, #129) — and in
  its own repository every change becomes another land-release-bump chain on
  top of the node-x11 → ntk → here one that already exists. Workspaces with
  release-please's manifest mode, versioned in lockstep, keeps it to one
  release. (`@react-x11/a11y` used to be the second name on this list, and
  the global menu used to be on `desktop`'s. Both shipped in core instead:
  §11.3 records why for AT-SPI, and the global menu is a property of
  `MenuBar`, which is core — #112. Both ride the same D-Bus floor, and that
  floor is core's own optionalDependency, so the dependency argument no
  longer applied to either.)
- Where do the rich-content formats belong — ntk, here, or their own module?
  Analysed in [RICH_CONTENT.md](RICH_CONTENT.md); the decision and the staged
  plan live in [sidorares/ntk#106](https://github.com/sidorares/ntk/issues/106).
  Mermaid is **dropped outright** rather than extracted — it was 155 MB of
  install closure for a grammar. html and markdown move here behind subpath
  exports; svg and tex stay in ntk. Selectable text still needs one read-only
  ntk accessor rather than a rewrite. That supersedes the "left for later"
  note in §1 and adds items to §8.
- ESM migration here (ntk is ESM-with-TLA; the dynamic-import dance in
  `src/Reconciler.js` disappears if react-x11 goes ESM). **Stale on both
  halves.** `package.json` already declares `"type": "module"`, and there
  is no top-level await anywhere in ntk's `lib` — the TLA is in
  `yoga-layout`'s `wrapAssembly(await loadYoga())`, which ntk re-exports,
  so going ESM would not have removed it either. The dynamic imports in
  `src/Reconciler.js` are env-gated feature loading for
  `REACT_X11_DEVTOOLS` and `REACT_X11_CLICK_TO_COMPONENT`, not an ESM
  workaround; they are themselves top-level awaits and are not going
  anywhere. What replaces the question is a stated runner support matrix,
  to go in the testing page §16 asks for: `node --test` and Vitest with
  `environment: 'node'` are supported (**not** jsdom — a jsdom environment
  defines `window` and `document` and silently changes how several
  libraries behave); Jest works with `--experimental-vm-modules` and is
  unsupported; Jest with a CJS transform **cannot** work, because the
  transform cannot represent yoga's top-level await. Write the negative
  result down and do not build a Jest preset.

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
`autoFocus` are public; focusing inside a scroll container scrolls into view;
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
   modal popups, and focusing a node inside a scroll container does not scroll
   it into view even though `scrollIntoView(node)` exists.
6. **Focus is not restored** when a popup closes; menus do it by hand.

### 11.3 Accessibility — DONE, in core

Shipped: a full AT-SPI2 bridge inside react-x11 itself —
[docs/accessibility.md](docs/accessibility.md) is the reference. The shape,
where it follows the research below and where it deliberately does not:

- **In core, not `@react-x11/a11y`.** The dependency argument for a sibling
  package dissolved when the D-Bus layer landed in core as an
  `optionalDependency` (docs/dbus.md): the bridge rides the same
  `dbus-native`, is dynamically imported only when a root exists, and adds
  nothing to the install closure. A sibling package would have bought a
  peer-version matrix and a "why is my app not accessible" FAQ entry
  (answer: you did not install the extra package), and an accessibility
  layer that is opt-in is an accessibility failure.
- **The prop shape is the web's, not React Native's.** The research below
  recommended `accessibilityRole`/`accessibilityState`; by the time the
  bridge landed, RN 0.71+ itself had adopted `role`/`aria-*`, and the
  widgets here had been carrying web-style `role` strings for months. So:
  `role`, `aria-label`, `aria-checked`, `aria-valuenow`, … on every host
  element, plus `onAccessibilityAction` for AT-driven value writes and
  `announce()` for live-region-style messages.
- **No mirror.** `src/a11y.js` computes roles/names/states as pure
  functions over the retained tree (unit-testable with no bus);
  `src/atspi.js` answers D-Bus calls from the live tree and keeps only a
  per-exported-node snapshot to diff precise events from. Renderer hot
  paths pay one nullable hook slot each, trace-registry style.
- **The ladder is small**: dbus-native installed → session bus →
  `org.a11y.Bus.GetAddress` → connect + `Embed`. Every rung fails into a
  silent, costless off (ssh, CI, macOS/Windows X servers). `NO_AT_BRIDGE`
  is honoured (and set by `react-x11/test`, so suites do not parade
  phantom apps through a live screen reader); `AT_SPI_BUS_ADDRESS` is the
  test seam; `REACT_X11_A11Y=1` makes the climb explain itself.
- **Coverage**: Accessible/Component/Action/Value/Text/EditableText +
  Cache and the event streams (focus, state-changed, text-changed with
  real diffs, children-changed, window activate, announcements). Verified
  hermetically against an in-process bus (`test/atspi.test.js`), and live:
  Orca speaks the widget gallery — "Press me — button", "check box
  checked", "horizontal slider, 80 percent" — and can press, adjust and
  type into it over the bus.
- **The testing story ships with it.** `renderX11({ a11y: true })` returns
  the assistive-technology spy — the same hook feed the bridge consumes,
  observed in-process with no bus, so an app asserts focus order, keyboard
  cycling, "nothing nameless" and announced state changes synchronously
  (`test/a11y-spy.test.js` is the copyable set). `npm run a11y:probe` is
  the same idea against a live desktop: the AT side of the wire in
  dbus-native, sharing the spy's `utteranceOf` model.
- **Deferred, recorded in the docs page**: relations (needs an id
  registry), the Selection and Table container interfaces, key-event
  forwarding via DeviceEventController, soft-wrap line granularity in
  `<textarea>`.

The original research follows.

Conclusion first: **being a pure-JS X11 client
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
  once window-level focus is tracked properly. That prerequisite is now
  met — §11.2 is done, on ntk's focus events (sidorares/ntk#89) — so this
  is unblocked rather than waiting.
- Size: a live D-Bus service (tree + `Component` geometry from `node.abs`,
  `Text` from the text nodes, state changes on prop updates) is a sizeable
  project on its own — a `@react-x11/a11y` sibling package is probably the
  right shape, kept out of the core render path.

### 11.4 Local accessibility — DONE (#117)

The half that needs no bus and no screen reader, and that the AT-SPI work
above builds on. Three gaps, all of them the renderer knowing something and
not acting on it:

- **A focus ring.** `outlineWidth`/`outlineColor`/`outlineOffset` are paint
  properties, painted outside the border box and invisible to yoga — the
  reason CSS has `outline` as well as `border`. `:focus-visible` joins the
  state keys, set by everything except a press, so a ring appears for the
  keyboard and not for the mouse. **Every focusable node draws one without
  opting in**, from `focusRing`/`focusRingWidth`/`focusRingOffset` on the
  theme, because a keyboard user cannot opt into needing it.
- **A scroll container answers the keyboard** and is a tab stop whenever it has
  somewhere to scroll, so a pane of unfocusable content is readable without
  a pointer — WCAG 2.1.1, and previously a wheel or nothing.
- **`hitSlop`**, hit testing only: `Switch` and `Slider` were 20px and 16px
  targets against WCAG 2.2 SC 2.5.8's 24, and both now answer over 24
  without a pixel of the drawing or the layout moving.

What this section called "the natural next step" — role props something
actually reads — is done as part of §11.3: the widgets' `role` strings
turned out to be the right vocabulary (the web's), the `aria-*` props
joined them, and the AT-SPI bridge mirrors the tree they describe. The
test queries' `roleOf` now answers from the same model, so tests select by
exactly what a screen reader hears.

## 12. Before 2.0.0 freezes the API

1.2.0 is what is published; #69 is 2.0.0 and unreleased. Every rename in
this section costs one commit while that is true, and costs a deprecation
cycle, a codemod and a migration guide afterwards. Several of them are not
judgement calls at all — the types, the docs and the implementation already
disagree, and the only question is which of the three wins.

### 12.1 `createRoot` takes options, and a root owns its connection

Today `createRoot(container?)` takes an ntk App, and the connection is made
by `connectApp()`, which calls ntk's `createClient()` **with no arguments**
and memoises the result in a module-level `cachedNtkApp`. `createClient`
takes an options object — `fontSource`, `glxVisual`, `onXError`, and which
display to connect to — and none of it is reachable (#114). In order of
severity:

- You cannot render to a display other than `$DISPLAY`. Not awkwardly —
  there is no parameter.
- You cannot supply a `fontSource`, so #86 has no user-side workaround.
- `onXError` is unset, so ntk warns instead and protocol errors that no
  request callback claims are effectively invisible.
- **Two `createRoot()` calls with no argument silently share one fiber
  root**, because `roots` is keyed by container and both resolve the same
  memoised app. The second `render()` replaces the first tree with no
  warning.
- `Root.unmount()` goes through `unmountComponentAtNode` and never closes
  the app, so the socket stays open and the process does not exit.
- Nothing listens for the connection ending. A server going away is
  silence.

So: `createRoot(options?)` with `display`, `app` (borrow a connection you
already have — what the tests actually mean today), `fonts`, `scale`
(§12.5), `screen`, `onXError`, the three React error callbacks, and
`onDisconnect`. Delete `cachedNtkApp`; each root without `app` opens its own
connection and closes it, a root given `app` borrows and must not. Key
`roots` off the root object.

**Trap:** `onDisconnect` invites a reconnect loop, and a reconnect is not a
reconnect — every window id, pixmap, glyph set and font is invalidated with
the connection. Do not promise reconnection; document the pattern (tear the
root down, build a new one, re-render) and stop there.

Fold in a `react-x11/ntk` subpath re-exporting `createClient`,
`StaticFontSource` and `Clipboard`, so a user who needs a font source does
not `npm install ntk` separately and hope the version matches the one we
resolved. Also worth surfacing there: node-x11's `seq2stack` debug mode,
which maps a protocol error back to the JS stack that sent the request. It
is the most useful debugging facility in the stack and it is currently
unreachable.

### 12.2 Errors have to survive

Three separate holes, one options bag (#113):

- `src/Reconciler.js` passes React three arrow stubs that each take only
  `(error)`. React 19 calls them with `(error, errorInfo)`, and
  `errorInfo.componentStack` — the entire reason error boundaries are
  debuggable — is dropped on the floor. Forward both, make all three
  overridable, and run the stack through the frame-stripping already
  written for `src/ClickToComponent.js` so the top of the trace is the
  user's component and not eight frames of react-reconciler.
- **The default uncaught printer must set `process.exitCode = 1`.** A GUI
  process that crashed its tree and exits 0 lies to CI and to systemd.
- `src/events.js` dispatches capture and bubble in two loops and calls
  `handler(ev)` **bare**. A throwing `onClick` unwinds through the
  dispatcher into ntk's socket data handler, where there is no error
  boundary because React is not on the stack — the handler was called from
  an X event, not from a render. Same for `onDismiss` and
  `onCloseRequest`. Wrap each invocation, route the throw to the root's
  reporter with the node's element type and handler name attached. The
  default should log and continue dispatching — one bad tooltip handler
  should not kill the frame loop — but it must be overridable, because for
  a kiosk "crash loudly" is the correct policy.

### 12.3 The naming sweep

Every widget invented its own callback name: `Button.onPress`,
`Slider.onChange(value)`, `Tree.onSelect`/`onActivate`,
`Menu.onSelect(item)`, `Dialog.onClose`, against the host elements'
`<popup onDismiss>` and `<window onCloseRequest>`. One rule, applied
everywhere: **`onChange(value)`** for a controlled value,
**`onSelect(id)`** for a selection change, **`onActivate(id)`** for "the
user chose this thing", **`onClick(ev)`** for a control with no value, and
**`onRequestClose(ev)`** for "the user asked to dismiss this; you decide
whether it closes" on `<window>`, `<popup>` and `Dialog`.

In the same pass: several widgets accept flat style props (`Dialog width`
and `height`, `ProgressBar height`, `Slider height`, `Tooltip fontSize`,
`Menu fontSize`) while host elements throw on exactly that. It is not a
rule violation — widgets are plain components and `assertNoFlatStyleProps`
only runs on host elements — but it teaches the opposite of what we enforce
one level down. Move them into `style`.

And a real bug hiding in the same area: `Button` spreads
`{ theme, ...props, ...boxProps, style }`, so a caller-supplied `onClick`
**clobbers** `useControl`'s activation handler. Space and Enter keep working
while the mouse silently does something else. Compose the two handlers
rather than letting one overwrite the other.

### 12.4 `<textinput onChange>` hands you a raw string

`this.props.onChange?.(next)` — a bare string, where every other event in
the system is a synthetic event object, and `src/events.js` already builds
that shape. Make it one, put the value on both `ev.value` and
`ev.target.value`, and add the `name` prop that does not exist today
(#115). This is what stands between us and every DOM form library:
`react-hook-form` and `formik` both read `e.target.name` and
`e.target.value`, and the distance from "real adapter" to "fifty-line
adapter" is exactly this change. Same treatment for `onSubmit`, whose
declared signature is `(text: string, ev: unknown)` — the `unknown` is an
admission.

### 12.5 HiDPI — pick the mechanism before anything freezes

There is no notion of a pixel scale anywhere in react-x11, ntk or the app
(#116). `src/nodes.js` creates yoga nodes on the default Config
(pointScaleFactor 1); `src/styles.js` passes `fontSize` straight through as
a device-pixel size; nothing reads `Xft.dpi`, `GDK_SCALE`/`QT_SCALE_FACTOR`,
or the RandR per-output mm/pixel ratio. **On a 4K panel at `Xft.dpi=192` —
the default GNOME/KDE 2× setup — every widget and every glyph renders at
exactly half the size of every GTK and Qt app on the same desktop.** That is
not cosmetic; the app is unreadable, and it is the state on a large share of
the machines people actually run.

Scale is a **root** concern, not a style concern, because it has to multiply
layout, font sizes and the paint transform together. Three wiring points,
all small: one `Yoga.Config` per root with `setPointScaleFactor(scale)`;
multiply the resolved font pixel size in `src/styles.js`; and
`ctx.scale(scale, scale)` once at the top of `WindowNode.flush`, with the
`<window width/height>` props multiplied on the way to `createWindow`.
`node.abs` and `getClientRects()` stay in **logical** units, so `anchorRect`
and everything built on it need no change. Yoga's point scale is exactly the
answer to the objection that a float scale breaks the integer dirty-rect
math: layout stays logical, computed edges snap to physical pixels so
borders stay crisp, and rounding damage rects outward at the paint boundary
holds the invariant.

`'auto'` resolves the way GTK4 and Qt6 do: `GDK_SCALE`/`QT_SCALE_FACTOR` →
`Xft.dpi` parsed out of the root window's `RESOURCE_MANAGER` property → the
RandR primary output's `pixel_width / (mm_width / 25.4) / 96` rounded to the
nearest 0.25 → 1. Plus `REACT_X11_SCALE` to override. Static at startup is
an acceptable v1 — a mid-session DPI change is rare and we do not select
root-window events today — but say so rather than leaving it to be
discovered.

**Separately, and do not confuse the two:** the hardcoded component
constants (`DefaultTheme.fontSize`, `paddingX`/`paddingY`, the Checkbox and
Radio wells, `SLIDER_THUMB`, the Switch geometry) should move into the theme
regardless, as `theme.controlSize`, `theme.thumbSize` and friends. That is a
user-facing accessibility knob — scale type and controls independently of
the display — where root `scale` is a display-correctness mechanism.
Shipping both without distinguishing them double-scales everything.

### 12.6 The smaller breaking items

- **Refs.** A ref on a drawn element gives the react-x11 node; a ref on
  `<window>`/`<popup>` gives the raw ntk `Window`, so there is no way to
  reach the `WindowNode` — its children, its theme, its layout root, its
  screen origin. Invert it: the ref is the react-x11 node in both cases,
  with `node.ntk` as the escape hatch. One rule instead of two.
- **`DrawnNode.type`.** The declaration says `readonly type: string`; the
  implementation sets `this.kind` and there is no `get type()` anywhere.
  Add the getter — `type` is the right public name (#120).
- **`node.screenRect()`.** `getClientRects()` is in window coordinates and
  the screen origin lives on `window._screenOrigin`, so everything needing
  screen coordinates re-derives it by reaching into a private field —
  `src/components/anchor.js` already does, with a comment explaining why.
  Anchoring, drag-and-drop, accessibility and IME candidate placement all
  want this.
- **`AnchorOptions` is wrong in four places** (#120) — DONE (#255): the
  declaration was the wrong one. `gap` and `flip` never existed; the options
  are the ones `anchorRect` actually destructures, `at` among them, and the
  return type says `null` for a node with no `.abs`, which is what it does.
- **`<window onResize|onExpose|onCloseRequest>` forward the raw ntk event**
  while the types declare `SyntheticEvent<NtkWindow>`. Wrap them, since
  every other handler in the system receives a synthetic event.
- **`<image width|height>` and `<svg width|height>`** are documented, read
  by the measure code, and **throw** in development because neither node
  declares `semanticNames` (#118). Reachable only in production, where they
  are silently accepted — the worst possible split. `style={{ width }}`
  already works, so delete the branches and the doc lines.
- **Delete the legacy entry points.** The three-way overloaded
  `render(element, callback?, container?)` and its partner
  `unmountComponentAtNode` both exist for familiarity with an API React
  itself removed in 18. The default export goes with them.
- **`SelectThemeProvider`** — DONE: deleted, a back-compat alias with
  nothing to be compatible with.
- **`ThemeProvider` is two theming systems wearing one name** (#119) —
  DONE: it is a real component now, supplying the context _and_ the prop
  scope from one merged palette, so `<ThemeProvider value={dark}>` over
  `<box style={{ color: '$text' }}>` paints. It plants the prop on a box it
  renders (`style` overrides that box's `{ flexGrow: 1 }`), or on the
  window itself above a `<window>`, which may not sit inside a box. A
  `$token` with no theme anywhere above it now warns in dev — the one
  theming mistake that was otherwise silent, since the whole style is
  stripped rather than one value failing.
- **Export the hooks every app writes by hand.** `useAnchor` and (since
  #119) `useTheme` are exported; the rest are not. Add `useApp`,
  `useWindow`, `useWindowSize`, `useScreen` and `useClipboard` — the last
  of which wraps
  a feature that ships today, is reachable only through an internal
  `node._clipboardApi()`, and is documented in zero pages.
- **A `screen` option on `createRoot`.** Multiple X _screens_ (`:0.0`,
  `:0.1`) are separate root windows that no window can move between —
  Zaphod multihead, and more usefully multi-GPU signage and control rooms.
  `display.screen` is an array and every consumer hardcodes `[0]`.
  Constrain a root to one screen and let a program open two roots; do
  **not** build a migration abstraction, because X does not allow it and an
  API that mostly throws is worse than none. This is here only because the
  option is free this week.

### 12.7 Then say what stability means

Write a short stability page and ship it with the release, then hold it:
exported functions and components, host element names and their props, and
style property names are covered by semver; node classes, `Renderer` and
anything reached through `root.app` are escape hatches that may change in a
minor; **exact pixel output is not covered**, because text shaping and
layout follow fontkit and yoga and a patch bump to either can move a glyph.
Pin them if you snapshot. Adopt React's `experimental_` prefix so the
ambitious things can ship before their shape is frozen, and add
`warnOnce(oldName, newName, since)` in DEV — without it every future rename
is a hard break.

One structural hazard to write down now: `files: ["src"]` publishes every
internal module, and the `exports` map is the only thing keeping them
private. The moment a `./test` or `./offscreen` subpath is added, someone
will add `"./*": "./src/*"` for convenience and the entire internal tree
becomes API by accident. Add a test asserting the `exports` key set equals
an expected list, so that cannot happen without a decision.

## 13. Distribution

Nothing in this document has ever asked how an end user ships the result,
and the answer, reproduced from a clean directory, is that they cannot.

1. **A single-file bundle fails.** Bundling with
   `esbuild --bundle --platform=node --format=esm` produces a bundle that
   throws at load: `Dynamic require of "events" is not supported`, from
   node-x11's `xcore.js`. node-x11 is CJS and esbuild's interop cannot
   resolve `require('events')`. Workaroundable with a `--banner:js` that
   reconstructs `require` from `node:module`, and not discoverable —
   sidorares/node-x11#246.
2. **With that worked around it fails again, and this one is a hard stop.**
   `keysym@0.0.6` does `fs.readFileSync(__dirname + '/data/keysyms.json')`
   at module load. It is imported by ntk's `lib/window.js` and sits on the
   critical path of every keypress. It cannot be bundled, cannot go in a
   Node SEA — the SEA documentation is explicit that module loading does
   not read from the file system — and cannot go in an AppImage without
   shipping `node_modules`. §8 item 12 deletes it (sidorares/ntk#115).
3. **The default font source shells out to a CLI.** `FontconfigFontSource`
   calls `fc-match` through `child_process` and then opens font _files_
   from host paths. A slim container, a kiosk image, a SEA or an AppImage
   has neither. No document mentions this, and the error when it happens
   names fontconfig rather than the packaging decision that caused it —
   sidorares/ntk#121.
4. **No `.desktop` entry, no icon install, no autostart.** A Linux GUI app
   without one has no launcher entry, no MIME associations, no
   `DBusActivatable` and no autostart.

The cruel part is that the hard bit is already solved, for the browser:
`website/scripts/browser-shims/keysym.js` is a drop-in replacement whose
comment says precisely why the original cannot be bundled, and
`website/scripts/build-demo-bundles.mjs` bundles the whole stack with
esbuild. That knowledge needs to come out of the docs site.

Fix the two blockers upstream, then productize as a packaging page (#128)
with four tiers and a working configuration for each:

| tier                      | what it is                                      | what it needs                                          |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| `npm i` + `node app.js`   | the default                                     | nothing                                                |
| one `.mjs`                | `esbuild --bundle --platform=node --format=esm` | the keysym fix, an ESM entry for node-x11              |
| SEA binary                | `node --experimental-sea-config`                | the above, `mainFormat: "module"`, fonts as SEA assets |
| AppImage / flatpak / .deb | desktop distribution                            | the above, plus `.desktop` and icons                   |

Worth saying explicitly in that page: **yoga-layout is already
bundler-safe** — its WASM is base64-inlined in
`dist/binaries/yoga-wasm-base64-esm.js`, so there is no `.wasm` file to ship
alongside the binary. That is a real differentiator against every
native-canvas alternative and nobody knows it.

Two API pieces belong with it. `createRoot({ fonts: 'system' | 'bundled' |
FontSource })`, where `'bundled'` is a `StaticFontSource` over a font subset
shipped in the package — the website already does exactly this
(`website/scripts/demo-fonts.js`) — because `'bundled'` is the only correct
default for a container, a SEA or a kiosk, **and it makes rendering
deterministic**, which sidesteps #86 for anyone who opts in and is what an
image-diff test harness needs. And a `.desktop` generator rather than prose,
`writeDesktopEntry({ id, name, exec, icon, categories, mimeTypes,
startupWmClass })`, with the icon PNGs generated from a React component
through the offscreen renderer (#124) so the app icon, `_NET_WM_ICON` and
the launcher icon all come from one source.

The generator now has a second customer and therefore a second reason to
exist: custom URI schemes (#173) need `MimeType=x-scheme-handler/…`,
`DBusActivatable=true` and a `StartupWMClass` that matches the window's
`wmClass` prop, and [docs/uri-schemes.md](docs/uri-schemes.md) currently ships
that as a snippet to paste. It stays prose deliberately — a library that writes
into `~/.local/share` on import is a surprise, and it cannot work for a
system-installed or Flatpak app — so whatever this becomes must be a command
the **app author** runs, never something that happens implicitly.

Finally, a CI `bundle` job that runs the esbuild build and executes the
result against Xvfb. It is the only way the two blockers stay fixed; both
were introduced silently by transitive dependencies and neither was noticed
for years.

## 14. Remote display, and the protocol ceiling

The central architectural claim in the README is that the wire carries
drawing rather than pixels, which is worth the most exactly when the display
is somewhere else. There is no page about that. `ssh -X` appears once in the
entire docs tree, as one row of the "you need an X server" table in
`website/docs/getting-started.md`. Nothing anywhere mentions latency, `-X`
versus `-Y`, `ForwardX11Timeout`, when `-C` helps, Xvnc, Xpra, or what
actually costs a round trip.

The bench has the raw material for the argument. Mounting a window with 40
boxes and labels is 86 requests, 3652 bytes and **3 replies**; every
paint-only scenario in `scripts/bench/baseline.json` costs exactly one.
Replies are what a link charges for — bytes are nearly free at these sizes
and round trips are not — and `replies` is the only column that tracks them.
What is missing is the latency half: nothing in the repo measures what those
replies cost at a realistic RTT, so the page cannot yet be written with
numbers rather than adjectives. Three pieces of work follow:

1. **A remote-display page** (#128). The measurements below once they
   exist; `-X` versus `-Y` and why we should be the toolkit that works
   under `-X`; the twenty-minute `ForwardX11Timeout` and the fact that
   several distributions ship `ForwardX11Trusted yes` and quietly turn `-X`
   into `-Y`; why `-C` is usually the wrong lever here and where it is the
   right one; XQuartz, Xvnc, containers, multi-seat; Xwayland yes for app
   windows and no for shell components. And, honestly, where VNC still wins
   — video, and an existing app you cannot rewrite — because the comparison
   is only credible with that in it.
2. **An RTT mode in the bench, and `replies` as a gate.**
   `scripts/bench/protocol.js` already collects and prints `replies`, and
   the `--check` loop asserts on requests, bytes, composites and composite
   pixels — everything except the one metric that predicts how the app
   feels on a link. Add it, with a _tighter_ tolerance than the others
   (round trips should be near-constant per scenario), and add
   `npm run bench -- --rtt 80`, which is a delaying `Transform` around the
   stream pair `test/integration.test.js` already builds. Then a code path
   that adds a round trip fails CI instead of failing a user's WAN link.
3. **The unmeasured ceiling: one socket write per request.** §8 item 14.
   One write per request, no `writev`, no concatenation, and no
   `setNoDelay` anywhere in the tree — so TCP X connections run with Nagle
   on, which is invisible on the Unix socket where all the benchmarking
   happens and is not invisible on a WAN. Turn it off without buffering
   first and you trade a stall for packet amplification, which is worse on
   lossy links. Buffer, flush per frame, then disable Nagle. Add `writes`
   and `flushes` to `baseline.json` while doing it — `xcount.js` already
   wraps `write`, so it is one line — and the 277-request clips scenario
   should collapse to a handful of writes.

One more remote-specific cost, worth a paragraph in the page and then a fix
(sidorares/ntk#122): `<image src>` uploads raw BGRA through `PutImage` with
no compression, so a 1920x1080 photograph is 8.3 MB on the wire. It is
uploaded **once** and cached as a server-side pixmap, which is the right
design, but there is no downscale-before-upload path — scaling with
`style={{ width, height }}` scales on the server, after you have paid for
the full-resolution transfer. Decoding, box-filtering in JS and uploading
the size actually drawn is a small change and a bigger remote win than any
protocol micro-optimisation on this list.

## 15. Keyboard levels, Compose, and input methods

§7's "deliberately out of scope for now: accessibility (AT-SPI),
IME/compose input, Wayland" was written before the widget set,
`<textinput>`, `<textarea>`, undo/redo and the edit menu shipped. It has not
aged well: a text-editing toolkit that cannot type Japanese, Chinese,
Korean, Thai, or a French `é` on a US-International layout is an
English-only toolkit, and nothing currently says so while i18next is
documented as working and ntk shapes bidi text.

Being pure JS does not block any of this, which is why it ranks where it
does. XIM is an X11 protocol carried over ClientMessages and window
properties, implementable directly on node-x11. ibus exposes
`org.freedesktop.IBus.InputContext` on the session bus with
`ProcessKeyEvent(keyval, keycode, state)` plus `UpdatePreeditText` and
`CommitText` signals; fcitx5 speaks D-Bus too, and both implement XIM as a
fallback.

**Stage 0 — say it, today.** A paragraph in `README.md` under Known issues
and one under `<textinput>` in [docs/elements.md](docs/elements.md). A user
who discovers this by typing into a demo concludes the project is broken; a
user who reads it concludes it is honest. Costs nothing, blocks nothing.

**Stage 1 — fix key→text in ntk** (§8 item 13, sidorares/ntk#116) — **done**,
and it closed #85 with it. ntk decodes group and level against the keymap
and the event state, Caps applies only where the two levels are a case pair,
and the Compose engine lives on this side (`src/compose.js`, #276). What it
does not reach is levels 3–4, the AltGr row: the core map cannot say whether
those two entries are a second group or a third and fourth level, and
XkbGetMap is what would settle it.

**Stage 2 — a preedit model in the renderer, backend-agnostic** — **done**
(#276). `onCompositionStart` / `onCompositionUpdate` / `onCompositionEnd` on
the text controls, using react-dom's names because they are the names people
know. `TextInputNode` keeps `_preedit` next to `_caret` and draws it at the
caret. What is still owed is the caret's **screen rect** back to a backend,
so a candidate window lands in the right place — `node.screenRect()`
(§12.6).

**Stage 3 — the backends**, in `@react-x11/desktop/im` for ibus and fcitx
over D-Bus, and `react-x11/xim` for XIM. Keep XIM: it works with any XIM
server, and it works **over a forwarded display where the remote box has no
session bus**, which is precisely the deployment this project is best at.
XIM is ClientMessage and properties, so it belongs next to the protocol, not
in the D-Bus package.

## 16. Testing as something users can have

The substrate here is unusually good and the product is unusually absent.
`node --test` runs about ten thousand lines across fifteen files with no X
server, and seven of those files drive node-x11's in-process pure-JS X
server and read real pixels back with `GetImage`. None of it is reachable by
anyone who installs the package: `exports` lists exactly `.`,
`./jsx-runtime` and `./jsx-dev-runtime`, and `files` is `["src"]`. Meanwhile
seven test files each rebuild `createServer` + `createStreamPair` +
`StaticFontSource` from scratch and seven others import a hand-rolled
193-line mock 2d context.

Ship `react-x11/test` (#123). `x11` and `pngjs` are already in the install
closure through ntk, so the dependency cost is genuinely zero.

- `renderX11(<App/>, { width, height, backend, fonts, rtt, trace })`
  returning the real `WindowNode` root, not an opaque handle — every
  existing test reaches into `root._ctx`, `root._lastDamage`,
  `root._lastDamageRects` and `root.flush()`, and a shipped harness weaker
  than the private one is not worth shipping. Make those four supported
  names and keep the underscored ones as aliases for a major.
- `act()` that owns all three phases. `await React.act(...)` works today —
  the claim that `act` is broken is wrong, and the real defect is narrower:
  the documented `render(el, cb, app)` path resolves its callback before
  passive effects run, so a mount effect that calls `setState` has not
  landed when the test asserts. Every existing test works around it with an
  ad-hoc `setImmediate` or the `settle()` round-trip helper. React's `act`
  flushes React, not the frame; this renderer paints on ntk's frame clock,
  and the server has seen nothing until a reply round-trips. The helper has
  to flush React, then the frame clock, then drain the connection.

  While in there: `warnsIfNotActing: false` in the host config is **dead
  configuration** — react-reconciler 0.33 reads it as a bare expression
  statement and discards it; the warning is gated on
  `globalThis.IS_REACT_ACT_ENVIRONMENT`. Delete the key or comment it as
  inert.

- **Real input, through the real translation layer.** Tests currently do
  `wnd.emit('mousedown', …)`, which skips keycode→keysym lookup, modifier
  masks, wheel-button mapping, click-detail timing, pointer capture and
  grabs — i.e. most of `src/events.js`. node-x11's server already has
  `injectPointerMove`, `injectButton` and `injectKey` in
  `lib/xserver/input.js`, plus a real US keymap with `keycodeForKeysym`,
  and **nothing in this repo uses any of it.** Build
  `fireEvent`/`userEvent` on those. Budget for fixing real bugs when it
  lands: injected input goes through the server's grab and focus state
  machine, so `<popup grab>` dismissal, `trapFocus` scopes and pointer
  capture become testable for the first time, and some of them will fail on
  first contact.
- **Pixel and snapshot helpers**, which `test/integration.test.js` has
  already written and debugged: `readPixels`, BGRA→RGB, a tolerance
  compare, a `waitForPixel` poll. Ship them, and drop the default tolerance
  from 40 to something honest once fonts are pinned — 40 will not notice a
  wrong colour token.
- **Pin the fonts, and write down why.** Glyph _indices_ travel on the wire
  here, so font resolution is a determinism hazard in a way it is not for a
  DOM renderer. `scripts/screenshots.jsx` already freezes `TZ`, `Date` and
  `process.memoryUsage` with exactly the right rationale, and then resolves
  the font family through fontconfig anyway. `test/integration.test.js`
  does it correctly with a `StaticFontSource`. The rule: **no test or
  snapshot script resolves a family through `FontconfigFontSource`** — with
  one deliberately unpinned smoke test that asserts the resolved family
  _name_, since pinning otherwise makes #86 undetectable.
- `withFrameClock(clock => …)`, because `setAnimationClock` exists at
  `src/nodes.js:266` precisely so tests can drive transitions and is
  unreachable from the package — `test/style.test.js` reaches it through
  `await import('../src/nodes.js')` and hand-restores it in six places,
  each of which would leak if the test threw.

The cheapest real win in this section is not the harness though — it is that
`test/dirty-rect.test.js` already contains a **differential oracle**,
`paintBothWays`, which paints a change bounded and then in full and compares
the readbacks. It is applied to a hand-written list of scenarios. Randomise
the input with a seeded generator over a small tree grammar and it becomes a
property test with an oracle that cannot lie: partial paint ≡ full paint for
any tree and any mutation; `mount(B)` ≡ `mount(A)` then `update(A→B)`, which
is the property that catches `commitUpdate` bugs and which nothing currently
tests; permuted `insertBefore`/`removeChild` sequences producing the same
child list must produce the same paint; and the same mutations must produce
an identical opcode histogram, because non-determinism there means something
is keyed on iteration order or a timer. A small seeded generator, no new
dependency.

And the CI gaps, which are cheap and currently total: `npm run bench --
--check` is not run by anything, despite the baseline being checked in;
neither is `stress:check`; there is no xvfb job, so nothing ever runs
against a real X server; and `npm run screenshots` regenerates
`docs/img/*.png` with nothing comparing them.
