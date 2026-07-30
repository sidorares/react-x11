# AGENTS.md

Guidance for AI agents (and new contributors) working on react-x11.

## What this project is

A custom React renderer whose host environment is an X11 server, with
react-like ergonomics on top of [ntk](https://github.com/sidorares/ntk) /
[node-x11](https://github.com/sidorares/node-x11) — pure JavaScript
implementations of the X11 protocol, no native bridge.

Architecture (see NEXT_STEPS.md for the full rationale): only `<window>`,
`<popup>` and `<glarea>` map to real X11 windows (`<glarea>` because GLX
needs its own visual); everything else is a retained
lightweight node — one yoga-layout node each — painted into the owning
window's double-buffered 2d context on ntk's frame clock, with synthetic
capture/bubble events dispatched via front-to-back hit testing. X11
windows are created **top-down in the commit phase**
(`WindowNode.realize()`): `createInstance` performs no X11 calls (the
render phase is discardable under concurrent React), and every
CreateWindow names its actual parent from the start — no ReparentWindow,
no override-redirect staging (issue #4).

## Layout

- `src/index.js` — public entry (`render`, `createRoot`,
  `unmountComponentAtNode`).
- `src/Reconciler.js` — react-reconciler host config + render entry points.
  Written against react-reconciler 0.33 (React 19). If you upgrade
  react-reconciler, expect host config contract changes; the smoke test is
  the safety net.
- `src/nodes.js` — the retained node tree: `WindowNode` (real X window,
  paint/event/flex root), `BoxNode`, `TextNode` (+ spans/chunks),
  `ImageNode`, `CanvasNode`. Layout (yoga), painting, hit testing.
- `src/glnodes.js` — `<glarea>`: the GL surface. A child X window on a
  GLX visual (ntk's `chooseGLXConfig`), positioned by the parent's yoga
  rect, drawing `onDraw` frames on its own frame clock. First step of
  docs/glx.md.
- `src/scene3d.js` — the 3D scene tree inside a `<glarea>`: `<mesh>`,
  `<group>`, geometry/material nodes and the renderer that compiles each
  geometry into a server-side **display list** (a frame is matrices +
  material state + one `CallList` per mesh). `src/geometry3d.js` generates
  the primitives, `src/mat4.js` is the matrix math, `src/raycast3d.js` +
  `src/pointer3d.js` are picking and mesh pointer events.
- `src/richnodes.js` — rich-content elements (`<markdown>`, `<html>`,
  `<svg>`, `<tex>`) wrapping ntk's document widgets in standalone mode:
  the widget's `layout(width)`/`contentHeight` feeds a yoga measure
  function, `draw(ctx, x, y)` paints, `onInvalidate` (ntk ≥ 3.4.0)
  reflows on async content (mermaid, images).
- `src/components/` — the widget set, plain React over the host
  primitives (no reconciler support needed). One module per widget, with
  the shared plumbing in `theme.js` (palette, `useTheme`, `useControl`),
  `anchor.js` (popup placement + label measurement), `typeahead.js` and
  `keys.js`. `index.js` re-exports the public names.
- `src/styles.js` — flat style props → yoga setters; paint prop
  classification; text style resolution.
- `src/events.js` — `EventManager`: ntk window events → synthetic events
  (click synthesis, hover enter/leave diffing, wheel from X buttons 4-7,
  focus/Tab).
- `src/priority.js` — shared React update-priority state (discrete vs
  continuous events).
- `src/DevToolsIntegration.js` — opt-in React DevTools bridge
  (`REACT_X11_DEVTOOLS=1`; needs `react-devtools-core` + `ws`, dev-only).
- `examples/` — runnable demos (need a real X server, see below).
- `test/smoke.test.js` — headless tests over a mock ntk app object.
- `test/integration.test.js` — end-to-end against node-x11's in-process
  pure-JS X server with pixel-readback assertions. No `$DISPLAY` needed.
- `test/wm.test.js` — the window-manager example against that same server,
  two connections: one plays the WM, the other an application. Needs
  x11 >= 3.2.0, which is where substructure redirect landed.
- `src/index.d.ts` + `src/types/*.d.ts` — hand-written TypeScript
  declarations for the public API, and `src/jsx-runtime.{js,d.ts}` (plus the
  dev variant) so a project can set `jsxImportSource: "react-x11"` and have
  JSX check against the X11 elements. See
  [docs/typescript.md](docs/typescript.md) and the note below.
- `test/types/api.tsx` — compiled, not run: the type tests.
- `website/` — the documentation site (Docusaurus, deployed to GitHub
  Pages). It **renders `docs/`, it does not restate it** — see "The
  documentation site" below before writing anything there.

## Commands

- `npm test` — node:test. **Headless: no X server needed.** Primary feedback
  loop; keep it green and extend it when touching the host config.
- `npm run lint` / `npm run format` — ESLint 9 (flat config) + Prettier.
- `npm run typecheck` — `tsc` over the declarations and `test/types/api.tsx`.
  Runs in CI beside lint. **A prop change is not done until the `.d.ts` and a
  line in the type test change with it** — hand-written declarations drift
  silently otherwise, and nothing else catches it.
- `npm run examples:{app,theming,simple,simple-nojsx,xeyes,dashboard,tasks,menu,form,richtext,widgets,windows,wm}`
  — need a running X server (`DISPLAY` set; XQuartz on macOS, Xvfb for
  automation). `examples:app` is the showcase: it hosts `form`, `widgets`
  and `tasks` as tabs by importing the panel each of them exports, so a new
  control gets demonstrated there rather than in yet another example. All examples export their App and skip auto-running under
  `REACT_X11_NO_AUTORUN=1` so scripts/tests can import them.
- `npm run examples:wm` — the reparenting **window manager** (issue #3). It
  claims the root window, so it needs a display no other WM owns: run
  `Xephyr :10 -screen 1200x800` and point it there. `examples/wm-core.js`
  is the protocol half (claim the root, answer map/configure requests, keep
  the client list, EWMH, alt+tab) and `examples/wm.jsx` is the React half —
  each frame is a `<window>` whose titlebar, buttons and eight resize
  handles are components. Notes below under "Writing a window manager".
- `npm run examples:tasks:hot` — the tasks example with hot reloading via
  React **Fast Refresh**: edit `examples/tasks.jsx` while it runs and the
  edited components update in place — connection, window, and component
  state (the task list, half-typed input text) survive; a component whose
  hook signature changed remounts alone. `examples/hmr-register.mjs`
  chains a sync babel loader (JSX classic + `react-refresh/babel`,
  `retainLines`) under `hot-module-replacement`'s ESM hooks (Node ≥
  22.15, `module.registerHooks`); `examples/hmr-refresh.js` injects the
  refresh runtime into the reconciler (must be the entry's first import);
  `examples/tasks-hot.jsx` is the accept boundary, calling
  `performReactRefresh()` on accept. Constraints inside hot modules: no
  _named_-import calls at module top level (bindings become `let`s
  initialized in a microtask — use the default import, e.g.
  `React.createContext`), and identity that must survive a reload
  (contexts, stores) lives in its own untouched module
  (`examples/tasks-context.js`). Loader-chain gotcha: the HMR import
  rewrite emits no trailing semicolon, so anything the babel stage
  puts _after an import on the same line_ becomes a syntax error — keep
  one statement per line in injected preludes and use the classic JSX
  runtime (the automatic runtime appends its `react/jsx-runtime` import
  to the last import's line).
- `npm run screenshots` — regenerate the README/docs images
  (`docs/img/*.png`) headlessly: renders the real examples into the
  in-process X server, drives them through the real event pipeline, and
  sets text in a system sans-serif (Arial / Liberation / DejaVu — small
  serif text reads as a document, not a UI). Run it whenever a change
  affects how the examples look.
  The 3D shot (`docs/img/three.png`) is **not** regenerated by that script:
  the in-process X server has no GL, so it is captured by hand from
  `npm run examples:three` on a real server with indirect GLX. Re-capture it
  only when the 3D examples change visibly.
- `npm run screenshots:framed [scene…]` — the same examples captured
  **with the window manager's frame**, into `docs/img/framed/`
  (gitignored — the decorations are whatever WM is running locally, so
  they are generated on demand, not committed). Needs a real `DISPLAY`
  with a **reparenting** WM; `npm run screenshots` has no WM at all and
  therefore no frames. See "Framed screenshots" below.
- `npm run docs:dev` / `npm run docs:build` — the documentation site in
  `website/` (needs `npm install` in `website/` once). See below.

## The documentation site

`website/` is a Docusaurus site published to
<https://sidorares.github.io/react-x11/> by `.github/workflows/deploy-docs.yml`
on every push to master. Two rules keep it from drifting away from the code,
and both are enforced rather than asked for:

- **The API reference is not written there.** `website/scripts/sync-docs.mjs`
  copies `docs/*.md` into `website/docs/reference/` at build time — adding
  front matter, rewriting links, copying images — and that directory is
  gitignored. Edit `docs/`; the site follows. A new file in `docs/` appears
  in the sidebar on its own (unlisted files trail alphabetically after the
  ones named in `ORDER`), and a deleted one disappears, because the output
  tree is rebuilt from scratch. **Never** hand-edit `website/docs/reference/`.
  Only `intro.md` and `getting-started.md` are the site's own prose, and they
  narrate rather than specify — anything normative belongs in `docs/`.
- **The playground runs the real renderer**, so it fails when the API moves.
  `website/scripts/build-demo-bundles.mjs` bundles `src/` together with
  React, ntk, node-x11, its pure-JS X server and its GLX-over-WebGL2
  emulator into one ESM module; `static/demo/runner/index.html` boots that in
  an iframe and compiles editor JSX with sucrase. `npm test` in `website/`
  runs all three gates: `check-bundle.mjs` (the bundle loads, renders a
  tree, reads pixels back), `check-demos.mjs` (every demo in
  `website/src/demos/` mounts, paints, and responds to injected input) and
  `check-share.mjs` (the share-link codec round-trips every demo). The
  `docs` job in `.github/workflows/ci.yml` runs them on every PR. **A prop
  or component rename is not done until the demos that use it still pass.**

Share links (`?code=…`, `website/src/lib/share.mjs`) carry the whole snippet
in the URL — DEFLATE, then base64url, with a one-character scheme prefix.
There is no server and no stored snippet, so **the format is permanent**: a
link someone pasted into an issue two years ago still has to decode. Add a
new scheme letter rather than changing what `d` or `p` mean. Code that
arrives that way does not auto-run, and says so above the editor, because it
is a stranger's JavaScript running in the page.

Things that were awkward to get right, so they don't get re-broken:

- The bundle is **ESM, not an IIFE**: ntk's module graph and yoga-layout's
  WASM loader both use top-level await, which esbuild only emits in that
  format.
- **One React.** The entry resolves `react` from `website/node_modules` and
  `src/` resolves it from the repo root; two instances share no hook
  dispatcher, so the build aliases `react` to the repo's copy.
- The bundle ships a `Buffer` polyfill it installs only when there is no
  global one — true in a browser, false in node. Both check scripts
  `delete globalThis.Buffer` before importing it, or the x11 client builds
  packets node's `Buffer.isBuffer` then rejects.
- `DevToolsIntegration.js` and `ClickToComponent.js` are replaced by a stub
  at bundle time (an esbuild resolver plugin): they are dynamically imported
  behind environment variables the playground never sets, but bundling them
  would drag in `ws` and `node:child_process`.
- The demo exercises in `check-demos.mjs` locate their click targets **by
  the colour they are painted in**, not by coordinates, so moving a demo's
  layout cannot silently turn its assertion into a click on empty
  background.
- react-x11 caches its ntk App at module scope, so the runner keeps **one**
  server and one connection for the page's lifetime and unmounts between
  runs. Rebuilding the server per run would leave the second `createRoot()`
  holding a dead socket.

## TypeScript declarations

The types are hand-written against the JavaScript, so the only thing keeping
them true is `npm run typecheck` plus the cases in `test/types/api.tsx`.
Two things about the shape that are not obvious:

- **JSX comes from `react-x11/jsx-runtime`, not from augmenting React.**
  Augmentation was tried and does not compile: `text`, `image`, `canvas`,
  `html` and `svg` are DOM element names too, already declared by
  `@types/react` with incompatible props, and declaration merging cannot
  replace an existing member. Owning the namespace also makes `<div>` an
  error, which augmenting could never do.
- **`createStyles` takes a mapped parameter**, `{ [K in keyof T]: Style }`,
  not a bare `T extends Record<string, Style>`. With the bare form the
  object literal loses freshness during inference and TypeScript stops
  reporting unknown properties — the mapped form keeps `Style` as each
  value's contextual type, so a typo in a style key is caught the way the
  runtime validation catches it.

## Writing a window manager

`examples/wm.jsx` is the other side of everything above: instead of being a
client the window manager decorates, it _is_ the window manager. The things
that are easy to get wrong, all of which cost time here:

- **Frames must not unmount while they hold a client.** The client is
  reparented _into_ the frame, and X destroys children with their parent —
  so minimizing unmaps the frame rather than removing it from the tree, and
  a client that withdraws is reparented back to the root before its frame
  goes away. `addToSaveSet` covers only the case where the WM itself exits.
- **ConfigureRequest carries a value mask.** The geometry fields that the
  mask does not name hold the window's _current_ values, not a request.
  Honour the mask or you will "move" windows to where they already are.
- **Redirect the frame too, before reparenting into it.** A window's
  requests go to whoever holds SubstructureRedirect on its _parent_, and
  after the reparent that is the frame, not the root. Miss this and a
  client that resizes itself does it behind the WM's back, leaving the
  window a different size from the frame drawn around it.
- **Answer requests you refuse** (ICCCM 4.1.5). A reparented client's own
  ConfigureNotify has frame-relative coordinates, and a refused request
  produces none at all — clients that resize themselves then hang. Both are
  answered with `sendConfigureNotify` in root coordinates.
- **Do not select `ButtonPress` on a client window.** Only one client at a
  time may hold it and the application already does, so it fails with
  BadAccess. Click-to-focus uses a synchronous `grabButton` plus
  `app.allowEvents('replay')`, which hands the same click back to the app.
- **Focus only viewable windows.** `SetInputFocus` on a window that is not
  yet mapped is a BadMatch, so focus is taken after the frame is attached
  and both are mapped, not when the client is first seen.
- **Resolve keycodes from `GetKeyboardMapping`,** not from ntk's
  `keycode2keysyms`: that copy is filled from a reply that may not have
  landed, and a keycode guessed from a half-built map grabs a key nobody
  presses. Grab every keycode that carries the keysym, and every
  combination of CapsLock/NumLock — a passive grab only fires on an exact
  modifier match.
- **Drags need a real pointer grab.** react-x11's `capturePointer()` only
  routes events that already arrived at the window; the X grab is what
  keeps the server sending them once the pointer leaves the frame.
- **Icons come from two places.** `_NET_WM_ICON` (EWMH) is ARGB pixels in a
  property, what GTK and Qt set; `WM_HINTS` (ICCCM) points at a server-side
  pixmap plus an optional 1-bit mask, what xterm and the other classic
  clients still set. Reading only one leaves half the windows blank. A
  depth-1 icon is a stencil, not a picture — draw the set bits in the
  frame's foreground and leave the rest transparent, or it arrives as a
  black square.

## Framed screenshots

A reparenting WM puts the client window inside a frame window that is a
child of root, and draws the decoration into it — so the frame is ordinary
X pixels and `GetImage` can read it. On XQuartz this works because
quartz-wm renders the Aqua titlebar through the Apple-WM extension's
`FrameDraw`; on Linux any normal WM does the same with its own theme.

Two things the script has to get right:

- **Find the frame**: walk up from the client window to the ancestor whose
  parent is root. `ntk`'s `window.queryTree()` or `X.QueryTree` both do.
- **Beat occlusion**: `GetImage` on a window returns the current _screen_
  contents of that region, so an overlapping window is captured instead of
  yours. The script floats the window first — Apple-WM
  `SetWindowLevel(Floating)` where available, plus `RaiseWindow`.
  Note quartz-wm does **not** advertise `_NET_WM_STATE_ABOVE`, so on
  XQuartz the Apple-WM window level is the only always-on-top mechanism.
- Apple-WM's `SetWindowLevel` wants the **frame**, not the client: once
  reparented the client is no longer a child of root and the request
  answers `BadWindow` (opcode 130).

## Protocol efficiency

X11 is a network protocol even on a local socket. The three libraries have
distinct jobs, and this one is the layer that decides _how often_ anything
is drawn, so cost is a design concern here rather than an afterthought:

- **node-x11** — the protocol and minimal ergonomics. No policy, no
  drawing strategy.
- **ntk** — ergonomics and higher-level primitives over it; owns how
  drawing is _encoded_.
- **react-x11** — React primitives and ecosystem over ntk; owns how often
  drawing _happens_.

Rules, in rough order of how much they usually matter:

1. **Use server-side primitives instead of client-side pixel work.**
   XRender composites, glyph caches, `CopyArea`, server-side clip
   rectangles. Reach for readback or per-pixel manipulation last.
2. **Batch into as few requests as possible.** A shaped paragraph is one
   glyph run batch, not one request per word or per character. Prefer one
   request covering N items over N requests.
3. **Bound work to the damaged area.** An operation over the whole surface
   costs the same on the wire as one over a 20x20 rect and vastly more in
   the server. This is the failure mode request counts do not show.
4. **Avoid round trips.** A request that waits for a reply stalls the
   pipeline; cache what the server already told us (atoms, geometry,
   glyph pages) rather than asking again.
5. **Prefer server-side text rendering.** Shape once, upload glyphs once,
   draw whole runs.

### Measuring it

`npm run bench` runs scenarios against the in-process X server and reports
requests, bytes, replies, Render composites and **the pixel area those
composites touch**. That last metric exists because the others hide the
most common regression: a change can add almost nothing to the wire while
multiplying the server's work many times over.

- `npm run bench -- --save` rewrites `scripts/bench/baseline.json`
- `npm run bench -- --check` fails if a metric regressed past tolerance

Re-run it when touching painting, layout flushing, or anything in ntk's
drawing path, and update the baseline in the same PR that changes it, so
the diff records the cost.

## Gotchas

- The package is **ESM** (`"type": "module"`). ntk is ESM with top-level
  await in its graph; yoga-layout is ESM WASM. Everything imports statically
  now (no `require`).
- ntk >= 3.4.0 comes from npm. Yoga is imported **from ntk**, so renderer
  and ntk widgets share one WASM instance — do not add a direct
  yoga-layout dependency. `<textinput>` caret math uses ntk 3.3.0's
  `TextLayout.caretPosition`/`indexAt`.
- Text measurement runs through a yoga **measure function** calling ntk's
  `FontManager.layout` (`TextLayout`), memoized per max-width. Any change to
  text content or text style props must call `_textContentChanged()` →
  `yoga.markDirty()`. The mock app in smoke tests has no `fonts`, so text
  measures 0×0 headlessly — pixel-level text assertions live in the
  integration test (StaticFontSource + KaTeX's bundled font, no fontconfig).
- **Font family resolution shells out to `fc-match`**, so it follows `PATH`.
  On macOS that usually finds Homebrew's fontconfig before XQuartz's, and
  Homebrew's ships no macOS system-font aliases: `sans-serif` resolves to
  Hiragino Sans, whose Cyrillic sits on full-width advances while its Latin
  stays proportional — so the wrong font is easy to miss until someone types
  a non-Latin script. Put `/opt/X11/bin` first on `PATH`. This is also why
  `scripts/screenshots.jsx` names Arial / Liberation / DejaVu explicitly
  instead of asking for `sans-serif`. Nothing in the source works around it
  yet — issue #86.
- Painting is scheduled through `window.requestAnimationFrame` (ntk frame
  clock: coalescing + server fence) and is **bounded by damage** when the
  invalidation can name a region. `root.invalidate(layoutChanged, node)`
  takes the node whose appearance changed; the frame clips to its
  `paintBounds()`, refills only that much background, and `_outsideDamage()`
  skips any subtree that does not reach into it — that cull is where the
  protocol saving comes from, since the clip alone would still put every
  request on the wire. Three rules, and breaking any of them shows up as a
  pixel diff in `test/dirty-rect.test.js`:
  - **a layout change is never bounded** (`invalidate(true, ...)` ignores the
    node): a node that moved leaves stale pixels at a rect the new one does
    not cover;
  - **passing no node means the whole window.** Partial painting is opt-in
    per call site, so forgetting costs speed, not correctness. `NO_DAMAGE` is
    the third state — "I need a frame but changed nothing myself" — which is
    what `WindowNode.applyProps` passes when only its children changed;
  - **cull on `_subtreeBounds()`, never `abs`.** A child of a non-clipping
    parent can be drawn outside it, so a parent whose own rect misses the
    damage may still own a node inside it.

  Presentation is still ntk's job and still a full-window `CopyArea` — that
  costs server-side blit time, not wire traffic (NEXT_STEPS §8 item 4).

- **No X11 side effects in the render phase.** Window nodes are handles
  until `realize(parentWindow)` runs in the commit phase
  (`appendChildToContainer` for top-levels, parent `realize` recursion or
  late `appendChild` for nested windows, `commitMount` for popups).
  Creation is top-down (parent window first, children with
  `attributes.parent`), mapping bottom-up so subtrees appear at once. The
  smoke tests pin this: no `reparentTo`, no `overrideRedirect` on nested
  windows.
- `<popup>` is a `WindowNode` subclass with `isPopup = true`: allowed as a
  child of drawn nodes (bookkeeping only — no yoga, no reparent, own
  paint/event root). `<scrollview>` applies its offset during `absolutize`,
  so painting and hit testing see shifted rects; it defaults `flexShrink`
  to 1 (yoga's 0 would size the viewport to its content). The wheel default
  action (EventManager) scrolls the nearest enclosing scrollview unless
  `preventDefault()` is called.
- Closing an app right after `setTitle`/`setActions` crashed ntk <= 3.1.0
  (in-flight InternAtom chains, sidorares/ntk#62 / PR #63); the integration
  tests drain round trips via `settle(app)` before `app.close()`.
- Event handlers are **never** registered on the ntk window per-prop; the
  `EventManager` subscribes once and dispatches from current `node.props`,
  so handler updates can't go stale.
- `render()` uses `updateContainerSync` + `flushSyncWork`, so mounts/updates
  are applied synchronously — tests rely on that. Paint flushes are async
  (a tick later); tests `await` a `setImmediate` before asserting paint.
- Window geometry props are window state, not yoga style: `WindowNode`
  strips `width`/`height` before feeding props to yoga and sizes the root
  yoga node from the _actual_ window size in `flush()` (the user may have
  resized the window).
- Windows cannot be nested inside `<box>` (throws); raw strings are only
  legal inside `<text>` (throws otherwise).
- **Bun honours `tsconfig.json`'s `compilerOptions.paths` at runtime**, and
  ours maps `react-x11` at the declarations for the type tests. So inside
  this repo `bun` resolves the bare specifier to `src/index.d.ts` and dies
  on `The constant "Renderer" must be initialized`; Node ignores `paths` and
  resolves `src/index.js`. The examples import `../src/index.js` relatively,
  so they run fine under `bun` — but a script here that uses the package
  name will not. Outside the repo (a normal install) there is no such
  mapping and `bun hello.jsx` just works, which is what
  `website/docs/getting-started.md` documents.
- `bun --hot` cannot drive Fast Refresh for this renderer: `import.meta.hot`
  is `undefined` in the CLI runtime (that API is the bundler's), so no accept
  boundary can be declared, and a reload re-instantiates every module —
  `react` included. The mounted reconciler then holds a different React than
  the reloaded components call and the first hook throws
  `resolveDispatcher(...) is null`. Hot reloading stays on
  `examples/hmr-register.mjs`, which deliberately keeps `node_modules` and
  `src/` out of the hot graph for exactly this reason.

## Style

- **Style lives in `style`, never in flat props.** Layout, paint, text,
  `cursor`, `overflow`, `zIndex`, `pointerEvents` go in the `style` prop —
  an object or an array flattened left-to-right — and everything else is a
  prop: `title`, window geometry and size hints, `value`, `focusable`,
  handlers. No name means both, which is what keeps `<window width>`
  unambiguous. Passing a style property flat throws in development.
  `:hover`/`:focus`/`:active`/`:disabled` blocks resolve in the renderer as
  repaints, and may only set paint properties. See
  [docs/styling.md](docs/styling.md).
- ESM, Prettier (single quotes); run `npm run format` before committing.
- Conventional commit messages (`feat:`, `fix:`, `chore:`, ...) — releases
  are automated with release-please.

## Roadmap pointers

See NEXT_STEPS.md (the "Roadmap refresh" section is the current
source of truth for what's next). Done: phase 0 (ntk 3.1.0), phase 1 (drawn layer),
phase 2 (events, `<scrollview>`), phase 3's `<popup>` and `<textinput>`
(on ntk 3.2.0: clipboard, cursors, setLineDash), and the layout debug
overlay (`REACT_X11_DEBUG_LAYOUT=1`). Element default actions (textinput
editing, scrollview wheel) run via `_default*` hooks on nodes AFTER user
prop handlers, skipped on `preventDefault()`. The window-manager example
(issue #3) is done — on ntk 3.9.0 and node-x11 3.2.0, which grew the
substructure-redirect support it needed. Also done since: the widget set
including `Select`, `Menu`/`MenuBar`/`ContextMenu`, `Tabs`, `Tree`,
`SplitPane` and a virtualized `Table`; DevTools highlight-on-hover (the
DOM-ish host-instance contract, `getClientRects` + `ownerDocument`);
TypeScript declarations; and undo/redo in `<textinput>`/`<textarea>`.
`react-x11` is published on npm, with release-please keeping a release PR
open for the next version.

Next: a right-click menu for the text controls, a generic Popover, a file
open/save dialog. Open GitHub issues: **#85** keyboard layout switching is
ignored (non-Latin layouts always type Latin), **#86** `sans-serif`
resolves to a CJK font on macOS, **#88** no right-click menu in the text
controls — and right-click collapses the selection.

## Pull requests

- When a PR contains changes that can be detected by eye (rendering,
  widgets, layout), include screenshots **rendered by the PR's own code**
  in the PR description. Headless recipe: render into node-x11's
  in-process X server, read back with `getImageData` (BGRA byte order),
  save with `pngjs`.
- **Do not commit PR-illustration images to the repo.** Upload them as PR
  attachments instead — GitHub's user-attachments storage, the same one
  used when pasting or drag-&-dropping an image into the PR description.
  Commit an image under `docs/img/` only when it is useful beyond the PR
  itself (README, docs site).
- user-attachments still has **no public API**
  (github/community#29993) — uploading needs a browser session, so it
  can't be done with a PAT or `gh` alone. The maintainer drives it with a
  small local tool that replays the web UI's upload flow using a saved
  session cookie; if you don't have that, generate the PNGs, leave
  `<!-- drag in: name.png -->` placeholders in the PR body, and hand over
  the file paths.
- A freshly uploaded asset is **private**: its URL 404s for logged-out
  visitors until it is referenced from content they can see. Embedding it
  in the PR body is what publishes it — a bare uploaded URL is useless on
  its own.
