# AGENTS.md

Guidance for AI agents (and new contributors) working on react-x11.

## What this project is

A custom React renderer whose host environment is an X11 server, with
react-like ergonomics on top of [ntk](https://github.com/sidorares/ntk) /
[node-x11](https://github.com/sidorares/node-x11) — pure JavaScript
implementations of the X11 protocol, no native bridge.

Architecture (see NEXT_STEPS.md for the full rationale): only `<window>`,
`<popup>`, `<glarea>` and `<foreign>` map to real X11 windows (`<glarea>`
because GLX needs its own visual, `<foreign>` because the window is another
process's); everything else is a retained
lightweight node — one yoga-layout node each — painted into the owning
window's double-buffered 2d context on ntk's frame clock, with synthetic
capture/bubble events dispatched via front-to-back hit testing. X11
windows are created **top-down in the commit phase**
(`WindowNode.realize()`): `createInstance` performs no X11 calls (the
render phase is discardable under concurrent React), and every
CreateWindow names its actual parent from the start — no ReparentWindow,
no override-redirect staging (issue #4).

## Layout

- `src/index.js` — public entry (`createRoot`; the legacy
  `render`/`unmountComponentAtNode` pair was retired in #114).
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
- `src/foreignnodes.js` — `<foreign>`: another process's window, embedded.
  A second `drawn: false` node, over ntk's `XEmbedSocket` (docs/embedding.md).
  Two things here are not obvious and are commented at length. **Teardown is
  synchronous** — `WindowNode` destroys its own X window in the same turn, and
  `DestroyWindow` takes every inferior with it, so a release that waits for a
  round trip releases a window that is already gone; the client is reparented
  to the root and dropped from the save set before the container goes, and
  **never destroyed**. And **no focus proxy**: the classic XEmbed embedder
  gives the X focus to an InputOnly window that forwards keys, which here
  would read as the toplevel losing focus and would put every key past the
  React tree before any handler saw it. The X focus stays on our window and
  forwarding happens in `defaultKeyDown`/`defaultKeyUp`, which is what makes
  the rule "app chords first, everything else forwards" mechanical.
- `src/frame/` — `<Frame>`: a pane of the application in its own process,
  its window embedded over `<foreign>` (docs/frame.md). Four small files
  along the seams: `protocol.js` (pure — the six messages, the callback
  table with its one-update grace window, argument sanitizing), `env.js`
  (the context bridge: `createFrameContext`, the `FrameEnv` accumulator the
  theme publishes into), `index.js` (the host: fork, supervision,
  coalesced updates, fallback), `childmain.js` + `child.js` (the pane
  bootstrap behind an injectable transport, which is what lets the tests
  run a real pane in-process over a loopback — `test/frame.test.js` forks
  for real exactly once, over a TCP bridge onto the in-process server).
  Two things are deliberate and easy to undo: the **update listener goes up
  before the pane module import starts** (a store the tree subscribes to
  later — a listener scoped to the mounted tree would drop every update
  that landed during the import), and the host's transport listeners
  **outlive the effect cleanup until the exit**, because a `useFrameClose`
  handler flushing through a callback prop sends its `invoke` after the
  unmount message.
- `src/scene3d.js` — the 3D scene tree inside a `<glarea>`: `<mesh>`,
  `<group>`, geometry/material nodes and the renderer that compiles each
  geometry into a server-side **display list** (a frame is matrices +
  material state + one `CallList` per mesh). `src/geometry3d.js` generates
  the primitives, `src/mat4.js` is the matrix math, `src/raycast3d.js` +
  `src/pointer3d.js` are picking and mesh pointer events.
- `src/svgnodes.js` — `<svg>` over ntk's `SvgView`: `SvgNode` (sized from
  its viewBox like `<image>`, cached as coverage when the drawing is one
  colour) and `SvgChildNode`, the declarative SVG elements underneath it,
  serialized into the DOM SvgView consumes. It used to hold `<markdown>`,
  `<html>` and `<tex>` beside it, over ntk's document widgets; those were
  removed in 2.0 — a document rendered as one opaque widget can neither be
  selected across blocks nor re-rendered a block at a time, and the
  successors are `<Markdown>`/`<Formula>` in `@react-x11/components`,
  composed from public host elements.
- `src/yoga.js` — the layout engine. Enums synchronously, WebAssembly
  behind `loadLayout()`, which `createRoot()` awaits before anything builds
  a node. **Never import `yoga-layout`'s default entry** — it is a
  top-level await, and one import costs every app the single-executable
  build (docs/packaging.md); `test/yoga.test.js` enforces this.
- `src/anchor.js` — where a `<popup>` goes: `anchorRect` and the screen
  area it flips and clamps against. Core rather than widget code because
  **both** callers need it and only one is a widget — a `<popup anchor>`
  with an `'auto'` size learns how big it is inside `realize()`, after the
  content is measured and before `CreateWindow`, which is past the last
  moment React could have handed it a position (issue #255). So the window
  places itself from the same functions the widgets call, and the two agree
  by construction. `at` anchors to a rect _inside_ a node — a caret — and
  is node-relative so that everything which moves the node keeps it true.
- `src/components/` — the widget set, plain React over the host
  primitives (no reconciler support needed). One module per widget, with
  the shared plumbing in `theme.js` (palette, `useTheme`, `useControl`),
  `anchor.js` (the React half of the above: `useAnchor`,
  `useAnchorTracking`, label measurement), `typeahead.js` and
  `keys.js`. `index.js` re-exports the public names.
- `src/menuitem.js`, `src/dbusmenu.js`, `src/globalmenu.js` — the global
  menu (#112). `menuitem.js` is the item vocabulary, which is
  `com.canonical.dbusmenu`'s rather than one of our own **so that the array
  `MenuBar` draws is the array that serialises** — one authoring model, no
  translation layer. `dbusmenu.js` is pure: stable ids across re-renders, and
  the diff that decides between `ItemsPropertiesUpdated` (revision unchanged)
  and `LayoutUpdated`, which is a performance decision rather than a
  cosmetic one. `globalmenu.js` is the wire: registrar detection, the export,
  the KDE window properties, and `useGlobalMenu`. Two traps live there and
  are commented at length — detection means a **live owner** (the opposite of
  `hasService()`'s rule, because a registrar is a directory rather than a
  feature), and every call to it carries `NO_AUTO_START`, without which
  tidying up after a dead panel launches a new registrar nobody reads.
  `scripts/globalmenu-host.mjs` is a panel in a terminal; there is no
  installable dbusmenu client to test against otherwise.
- `src/application.js`, `src/activate.js`, `src/apphooks.js` — custom URI
  schemes and single instances (#173). `application.js` is the bus half and
  **imports neither react nor X11**, so the seam it would be extracted along
  stays visible; what keeps it here is that `RequestName` has to land on the
  same connection as the menu and the portals, or the desktop sees two
  half-applications. Two traps live there: the object path is _derived_ from
  the app id with dashes becoming underscores (get it wrong and the launch
  reaches a path nobody serves, which looks like nothing happening), and the
  interface is **exported before `RequestName`**, because the daemon delivers
  the queued activating call the instant the name is owned. `activate.js` is
  the raise, and it is the part users judge the feature by — `_NET_ACTIVE_WINDOW`
  with a wrong timestamp is refused by the WM while every layer reports success.
  `npm run labs:urischeme` is the manual harness for the two dispatch paths
  a broker cannot fake.
- `src/styles.js` — flat style props → yoga setters; paint prop
  classification; text style resolution. Also the **logical** edges
  (`paddingStart`, `marginEnd`, `borderStartWidth`, `start`/`end`) and the
  `direction` that decides what they mean: yoga resolves those for the
  layout, and `Node.direction` (nodes.js) resolves the same rule a second
  time for everything outside it — which side a scrollbar sits on, which
  edge a logical border paints, the base level a paragraph of neutral
  characters shapes at. The floor under it is the palette's `direction`,
  seeded from the locale. Also the two prop sets the
  **inheritance** rule is written as: `INHERITED_TEXT_PROPS` (the ink, the
  face, the size — what travels down the tree) and `LOCAL_TEXT_PROPS` (what
  shapes a node's own box and therefore cannot arrive from above). Which
  side a text property is on decides who has to react when it moves, so a
  new one goes in exactly one of them. And the two places a style means more
  than it says: `resolveComputedStyle` (the `flex` shorthand, and the
  defaults `overflow: 'scroll'` implies) and `applyLayoutDefaults` (the yoga
  defaults that are not CSS's — `flexShrink`, see the gotcha below).
- `src/decorations.js` — the two style values that are a small language
  rather than a number: `backgroundImage`'s `linear-gradient(...)` and
  `boxShadow` (#345). Pure — strings in, geometry out — so the renderer half
  in `nodes.js` is only compositing, and the grammar is testable without a
  server. Two things there are not obvious and are commented at length. The
  gradient line carries **padding at both ends with the end colours pinned to
  it**, because past its last stop an XRender gradient is transparent rather
  than clamped (`RepeatPad` is unset, sidorares/ntk#271) — and that cannot be
  caught by a pixel test, since node-x11's in-process RENDER clamps by
  construction where a real server does not. And a CSS blur radius is _twice_
  the gaussian's sigma while the kernel helpers take the kernel's edge
  length, so the two numbers that look interchangeable are the two that must
  not be. The blur is **baked into the shadow's pixels**
  (ntk's `blurCoverage`, ntk >= 8.6) rather than set as a filter on its
  picture: a picture's filter is re-run by the server on **every composite**,
  so the cached-and-hit path still paid a full kernel per frame — 1.6s for
  one card's `:hover` on XQuartz, against 1.5ms baked. Two things follow that
  are easy to undo. The surface's padding comes from the same `shadowReach`
  ntk builds the kernel with, because a surface padded by less than the
  kernel's reach ends the shadow in a straight line down its own edge. And
  `blurCoverage` returns a **new** surface and destroys the one it was given,
  which is why `paintcache`'s `after` hook honours what it returns rather
  than mutating in place. `test/shadow-blur-baked.test.js` pins the shape of
  it — that the cached surface's picture carries no convolution filter — and
  `npm run bench` prices it, but only since the `convolvedPixels` metric
  (#414): every other number is identical either way, which is how this
  survived a full bench run at 277M convolved pixels.

## Pre-release: there is nothing to be compatible with

The package is published, but nothing has been announced or marketed and
there are no users. So **backwards compatibility is not a consideration.**
When a better name, a better shape or a better default needs a breaking
change, propose the breaking change — don't design around the old one, don't
add an alias, don't keep a deprecated path working beside the new one. A
compatibility shim added now is a shim that will still be there when the API
does have users, and it will have shaped everything built on top of it in
between.

What this does _not_ excuse: the change still has to be the better design and
still has to land completely — every call site, the `.d.ts`, the type test,
`docs/`, the examples and the website demos in the same PR (see "The
documentation site"). A rename that leaves half the tree on the old name is
worse than either name. The release automation carries the rest: the commit
type is what release-please reads, so a breaking change says so in the
footer (`BREAKING CHANGE:`) and gets the version bump on its own.

When the reason for a change is only "this is what it has always been
called", that is not a reason yet.

## Answer the input, not the outcome

Perceived latency is the metric, and it is measured from the input, not from
the work (see also "Protocol efficiency" below, which is about the cost of
the work itself — a different axis). **Every input gets a visible answer on
the event that started it**, even when the event that _does_ something is a
later one.

The failure mode this exists for: a `<Switch>` toggles on the mouse button
**release**, because that is when a click is. Perception starts at the
**press**. Hold the button half a second — which an unhurried user does
without noticing — and that is half a second of a control that has visibly
not heard you, followed by a state change that now reads as the machine
being slow. Nothing about the code is slow. The control simply said nothing
for the part of the gesture the user was watching.

So a control has a presentation for **every state the pointer can put it
in**, and they are all distinct: resting, hovered, held, and back to hovered
on release. The press state is drawn on the press _even when the press
itself does nothing_ — it is not a promise that something happened, it is
an acknowledgement that the input arrived, and the release is still what
acts. Same for the keyboard, and same for anything with a latency behind it:
show the answer to the input first, and let the outcome catch up.

Concretely, in this codebase:

- `:active` is the press state and the renderer maintains it over the whole
  **press chain** — the node hit and its ancestors, the same rule `:hover`
  follows — because the node actually under the pointer is whatever the
  control is built out of, a label or a thumb, not the control. It narrows
  as the pointer leaves the chain and grows back as it returns, so it always
  means "releasing now activates this", which is the same
  nearest-common-ancestor rule the click is synthesized on (`src/events.js`,
  `_setPressed`).
- Prefer a **state block** to React state: `:hover`/`:active` are a repaint
  of one node, where React state re-renders the widget and its label. Reach
  for `useControl`'s `pressed` only when the part that has to change is not
  on the press chain — a `<Checkbox>`'s well is a sibling of the label the
  press lands on, and no state block can cross that.
- A palette has a pressed step for every family that has a hover
  (`accentActive`, `surfaceActive`, `textMutedActive`, `dangerActive` — the
  status family's one pressable member). A theme that names only
  the hover gets one derived from it — `stepBeyond` takes the step the
  palette already made and takes it again, so it darkens a light theme and
  lightens a dark one.
- A `transition` on the pressed property is fine and often better: what
  matters is that the change _starts_ on the press frame, not that it
  finishes there.
- Where the honest answer to a press is more than a tint, **move the action
  to the press**. `Select` opens its menu on the mousedown: a dropdown is
  there to be looked at, so holding the button and seeing nothing wastes
  exactly the time the user was waiting. Safe because the open popup's
  pointer grab takes the next press itself, so dismiss and toggle never
  both run. The rest stay on the release, because that is what a click is
  and because a press you can still change your mind about is worth having.

Known gap, so it is not rediscovered as a bug: **the keyboard has no press
state.** Space and Enter fire on the down, so the activation is immediate,
but nothing draws held-ness — X sends KeyRelease/KeyPress pairs for
auto-repeat and neither ntk nor node-x11 implements XKB's
`DetectableAutoRepeat`, so a held key is indistinguishable from a fast
series of taps and `:active` would strobe at the repeat rate. It needs the
XKB extension upstream first.

## Decide it, then leave a way out

A feature ships with a **default that serves the main customer out of the
box** — no configuration, no decision asked of someone who has not got the
context to make it — and **a seam for everyone else**. Both halves, always:
a default with no override strands the edge case, and an override with no
default makes every app answer a question most of them do not have.

The main customer is whoever will hit this most, not whoever is loudest in
the issue. Work out what they would pick if they knew everything you know,
make that the behaviour with no arguments, and write down why in the place
the default lives.

The seam is not ceremonial and it is not a boolean by reflex. Give it the
shape of the real disagreement:

- A **config value** when the answer is a fact about the app — an id, a
  timeout, a name it is known by.
- An **enumerated choice** when there are a few defensible answers and the
  cost of a wrong one is only that it fits badly.
  `startupNotification.completeOn` is `'paint' | 'map' | 'manual'` because
  those are the three honest moments an app can call itself started.
- A **hook** when the answer is code we cannot write — `notifyStartupComplete()`
  exists for an app that is up only when it says so.
- An **off switch** when a whole feature can be someone else's job. Every
  feature core turns on for you needs one, because sooner or later an
  embedder owns the thing we assumed was ours.

Two failure modes to watch for, both of which read as thoughtfulness:

- **A default that is only a guess with an escape hatch bolted on.** If the
  documentation for the default is "or set this to the other thing", the
  decision has not been made — it has been forwarded.
- **A seam nobody can reach.** An override that needs internal state, or
  fires before the app can install it, is not an override. If the honest
  signal is internal — "the first flush that painted" — the seam has to be
  in core, next to the signal, rather than approximated from outside.

And a default that turns something _on_ still owes the same discipline as
one that turns something off: state what it does, what it costs, and how to
stop it, in one place — see docs/desktop.md for the worked example.

## Commands

- `npm test` — node:test. **Headless: no X server needed.** Primary feedback
  loop; keep it green and extend it when touching the host config.
- `npm run lint` / `npm run format` — ESLint 9 (flat config) + Prettier.
- `npm run typecheck` — `tsc` over the declarations and `test/types/api.tsx`.
  Runs in CI beside lint. **A prop change is not done until the `.d.ts` and a
  line in the type test change with it** — hand-written declarations drift
  silently otherwise, and nothing else catches it.
- `npm run examples:{app,theming,simple,simple-nojsx,xeyes,dashboard,tasks,menu,form,selection,widgets,windows,wm}`
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
  hook signature changed remounts alone. Runs under the supported entry
  point, `src/refresh/` (issue #317): `--import react-x11/refresh/register`
  chains a sync babel loader (JSX classic + `react-refresh/babel`,
  `retainLines`, plus a per-module boundary footer) under
  `hot-module-replacement`'s ESM hooks (Node ≥ 22.15,
  `module.registerHooks`); `src/refresh/index.js` is the runtime half,
  auto-imported into every hot module's prelude, exposing `onReload` for
  tools. A module whose exports are all components self-accepts, so no
  accept handlers are written by hand. The constraints — no
  _named_-import calls at module top level (bindings become `let`s
  initialized in a microtask — use the default import, e.g.
  `React.createContext`), classic JSX runtime only, one statement per
  injected prelude line — are enforced as transform/registration errors
  (`test/refresh-transform.test.js` pins the messages;
  `test/refresh-hot.test.js` is the end-to-end reload). Identity that
  must survive a reload (contexts, stores) lives in its own untouched
  module (`examples/tasks-context.js`), or behind the `ignore` option of
  `registerRefresh` (`react-x11/refresh/loader`).
- `npm run screenshots` — regenerate the README/docs images
  (`docs/img/*.png`) headlessly: renders the real examples into the
  in-process X server, drives them through the real event pipeline, and
  sets text in a system sans-serif (Arial / Liberation / DejaVu — small
  serif text reads as a document, not a UI). Run it whenever a change
  affects how the examples look.
  A 3D shot is **not** something that script can produce: the in-process X
  server has no GL, and on XQuartz GL renders where `GetImage` cannot read
  it, so anything showing a `<glarea>` has to be captured by hand on a real
  server with indirect GLX (`docs/glx.md`).
  **Pixels come out of `scripts/capture.js` and nowhere else**, and
  `test/capture.test.js` pins it. Every script here used to hand-roll "the
  server gives BGRA" and swap the channels itself; ntk 5.3.0 made
  `getImageData` speak straight RGBA the way canvas does, and `screenshots`
  then regenerated every PNG with its reds and blues exchanged — for a whole
  ntk major, because a committed screenshot has no other reader and CI does
  not diff them. A window of ours goes through `captureWindow`; a drawable
  we do not own — a WM frame — through `captureDrawable`, which asks the
  display for the pixel layout rather than assuming one. The script also
  pins the `<textinput>` caret **on** before capturing, alongside the frozen
  clock and heap usage: a blinking caret made `tasks.png` differ run to run,
  which is what makes a dirty tree after a regeneration meaningless.
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

## Writing an example

`examples/` is being reworked from a changelog into a set of **applications**:
each file arrived with a feature and demonstrates that feature's API surface,
which is the right artifact when it lands and the wrong one a year later. The
rules below are what that rework decided; the per-app plan lives outside this
file, but these outlive it.

**An example is a program, not a panel.** If a reader would not want to keep
it running, it belongs in the labs — the harnesses for things CI cannot check
(clipboard interop, XDND against a file manager, the desktop's appearance) and
the perf instruments. Those are worth keeping and are not the tour.

**Demonstrate core, and only core.** No example imports
`@react-x11/components`. These files exist to show what this package can do,
and one that reaches for the sibling package answers a different question —
one that package's own examples are there to answer. It also means an example
never breaks on someone else's release.

**Do not build on what is leaving.** `Tree` has moved to
`@react-x11/components`, and `Calendar`/`DatePicker` with it; `Table` is being
reduced to a plain table with no sorting and no virtualisation; `Tabs`,
`PasswordInput`'s scribble mask is going the same way; `Tree`, `Calendar`,
`DatePicker` and `Canvas3D` have gone; `<markdown>`, `<html>` and `<tex>` are
already gone (#315). An example that wants a sortable virtual list **builds
one**, and that is the better lesson: core gives the primitives, the examples
show the way up from there. `examples/monitor.jsx` hand-rolls exactly that
over ~780 rows.

**Every app carries its own tests.** Written with `react-x11/test`, which is
otherwise undemonstrated — and it is what stops an example rotting silently
when core changes underneath it. Nothing else forces one to keep working.

**Put a seam where the world is.** A transport, a sampler, a spawn: the thing
that talks to the outside goes behind an interface the tests can replace.
`chat`'s transport and `monitor`'s sampler are the worked examples. Two traps
found the hard way — a fake that answers a question the real one cannot yet
answer hides the state the UI most needs to get right, and a fake that
resolves instantly leaves nothing to assert about the state in between.

**Say what does not work.** Where an example meets a real gap — no IME
([#272](https://github.com/sidorares/react-x11/issues/272)), no `opacity`, no
per-node container query — name it and link the issue rather than steering
around it. That matches how `docs/` already handles compatibility ladders, and
a reader who hits the same wall is better served by a sentence than by a
silence.

**Check it on a real display.** This is the one that keeps being relearned.
The headless harness renders with the font a test hands it, never the one
fontconfig picks, and it clicks where a user hovers. Every visual defect in
the recent examples work — text three pixels low, a badge riding high, a
sparkline reflowing every row once a second, a load graph drawn as a solid
block, a header that never lined up with its table — passed a green suite and
was obvious the moment somebody looked. Run it, capture it, look at it.

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

## The system icon set

`src/components/Icon.js` holds the glyphs the widgets are drawn with, and
they are the whole set: an icon added here is a decision about what the
library is, not a convenience. Four rules, all of which someone will
otherwise relitigate.

**Affordances, not nouns.** The set holds glyphs that say something about
_the control_ — there is more here, this one is chosen, this closes, this is
hidden. It holds no nouns: no folder, no document, no save, no printer.
Nouns belong to an icon theme (lucide, an XDG theme, the app's own art),
they are unbounded in number, and a widget set that starts shipping them has
taken on a design system. That single rule answers "should X be added?"
without a debate; PasswordInput's Caps Lock key is drawn locally rather than
here for exactly this reason.

**One shape per idea.** Before the set, core drew a chevron four ways: a
filled caret in Select, Tree and Table, a stroked chevron in Calendar, and a
`▸` text glyph in Menu — tofu on a machine without it, which is the warning
docs/components.md gives applications about string icons. The caret is gone.
If a new widget needs a mark, it takes one from the set or the set grows by
one, deliberately.

**Colour and size are themable; geometry is not.** Colour rides `theme`, the
one channel that walks the node tree, or is handed over at the call site;
`size` derives from `theme.fontSize` the way the popup radii do. The
_drawings_ are core's vocabulary, and an application that wants a different
chevron wants an icon library — which it is welcome to bring, since a
`<svg>` or a `<canvas>` goes anywhere an `<Icon>` does. There is
deliberately no per-icon override slot: that is a registry, and a registry is
the icon-library problem rather than this one.

**A `mono` drawing never names a colour.** The glyphs ride `<canvas mono>`,
whose whole promise is that the ink comes from `style.color`, so one drawing
serves every state a control puts it in. A drawing that sets its own
`fillStyle` breaks that; `test/icons.test.js` asserts it for every name.

`mono` buys an **a8 coverage** entry: the colour is applied at composite time
and therefore out of the cache key, so one rendered copy per name and size
serves every ink. That needs **ntk ≥ 7.3.3** and the floor is load-bearing
rather than cosmetic — earlier versions composite coverage as empty under any
clip they cannot express as a rectangle
([ntk#243](https://github.com/sidorares/ntk/issues/243)), and a widget sits
inside clips like that routinely. `examples/tasks.jsx` nests a rounded card,
a scrolled list, a rounded row and a checkbox well; five of its six ticks
came out blank while every unit test passed.

Two things came out of that and are worth keeping:

- **A dependency floor deserves a test that fails on a downgrade.** The one in
  `test/icons.test.js` drives ntk's API directly — an a8 `Surface` composited
  under a circular clip — because no tree built from `<box>` reaches that
  path: react-x11's own clips are rectangles. A react-x11-level test for it
  passed happily against the broken version, which is the trap.
- **This shape of paint bug survives every assertion about layout, keys and
  cache statistics.** `npm run screenshots` and a look at `docs/img/` is what
  catches it — regenerate on the base first and diff, since the rasterizer
  shifts edges on its own.

**The ink comes from the cascade; the size does not.** `color` is an
inherited property (docs/styling.md), and a `mono` drawing reads exactly what
a `<text>` beside it would — so an icon in a row that dims itself dims with
it, and a `:hover` block that sets `color` on the row reaches the glyph the
same way it reaches the label. Nothing is handed over at the call site, and
an `<Icon color=…>` now means "this mark is not the colour of the text
around it" rather than "someone remembered". `size` stays out of it on
purpose: a glyph has no baseline and no ascent, so it derives from the
palette's `fontSize` rather than from whatever text is nearby, which keeps a
chevron the same size in a row that shrank its label.

Not a font, and the reasoning is on record so it is not re-derived: ntk's
FontManager does take font bytes, and glyphs composite through a solid source
picture, so a column of chevrons would be one CompositeGlyphs. It loses on a
binary artifact plus a generation toolchain in an otherwise pure-JS package,
baseline rather than box alignment, unhinted mush at 12px, and an icon name
routed through text layout and the accessibility tree. Revisit only if a
profile of a large Tree shows composite count dominating.

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
requests, bytes, replies, Render composites, **the pixel area those
composites touch** and **the multiply-accumulates inside that area**. Those
last two exist because the others hide the most common regression: a change
can add almost nothing to the wire while multiplying the server's work many
times over.

Area and taps are two different assumptions, and both get away from you:

- `Mpx` is area, and assumes a pixel costs the same everywhere.
- `convMpx` is `kernel_w × kernel_h × area`, summed over any `convolution`
  filter the composite's source or mask carries. A picture's filter is
  re-applied by the server on _every_ composite that reads it, so the same
  request over the same rectangle is one tap a pixel or 3721 depending on
  picture state neither the request count nor the area looks at. Equal to
  `Mpx` means nothing is filtered; `--hotspots` names the kernels.

The gap between them is issue #413: a blurred `boxShadow` set the filter on
its cached coverage instead of baking the blur in, every shadowed repaint
re-convolved (~700x slower on a real display), and requests, bytes,
composites, area, stalls, dups, churn and the rendered pixels were all
unchanged across the fix.

- `npm run bench -- --save` rewrites `scripts/bench/baseline.json`
- `npm run bench -- --check` fails if a metric regressed past tolerance

For a live app rather than the bench scenarios, `REACT_X11_TRACE=summary`
(or `requests`, or `chrome:/tmp/t.json` for Perfetto) traces the protocol
with the same splitter, `REACT_X11_DEBUG_PAINT=1` flashes damage rects and
`=full` warns — with reason and stack — on silent full-window repaints,
which are the regression class the bench numbers hide until re-run. See
docs/debugging.md; the switches are read once at startup and cost nothing
when off.

Re-run it when touching painting, layout flushing, or anything in ntk's
drawing path, and update the baseline in the same PR that changes it, so
the diff records the cost.

## An error you hit is an error an app developer will hit

Whenever an error turns up while researching, benchmarking or sketching —
even in throwaway code, even when it was your own mistake — stop and ask
two questions (this is ntk's policy too, sidorares/ntk#170; it found
sidorares/ntk#121 before any user filed it):

1. **Can an app developer reach this?** If yes, you have found a bug
   report before anyone wrote it. Look hardest at ambient facts about the
   machine — no `$DISPLAY`, no fontconfig, no GLX, no window manager, an
   XQuartz quirk — because your box is not the deployment target, and a
   container has none of those things.
2. **Can the error say what to do about it?** Say what was expected, what
   was found, and what to change — a fix instruction, the diagnostics to
   work one out, or a link to the page that explains it.

react-x11's consumer makes the first question bite harder than usual: a
React developer with DOM habits and no X11 vocabulary. The layers under us
— ntk, node-x11, yoga, fontconfig, the server itself — all throw in _their_
vocabulary, from stacks that name nothing the developer wrote. A
`BadWindow` with a sequence number, a `spawnSync fc-match ENOENT` from the
first text layout: nothing there to search for, no JSX element, no
component. The renderer's job is to be the translation layer for errors
too, not just for drawing.

The house style already has the pattern; hold new errors to it:

- The unknown-element error names the tag **and lists the supported set**
  — and [docs/ecosystem.md](docs/ecosystem.md)'s compatibility table is
  built out of those messages being specific enough to be rows.
- A handler throw is reported with the handler name, the element, and the
  component that rendered it, plus _why_ no error boundary could catch it
  and that dispatch continues (`src/errors.js`).
- A style property passed flat throws naming the property and showing the
  corrected JSX.

Two failure classes are specifically ours:

- **ntk version skew.** The renderer feature-detects ntk APIs and
  degrades. Degrading silently is right when the loss is cosmetic (no
  `setCursor` means no pointer feedback); it is wrong when it is
  load-bearing — a feature that silently never engages looks _broken_,
  not degraded, and the developer has no thread to pull. Load-bearing
  degradation says so once, in development, naming the ntk version that
  has the API.
- **The consumer may be running a different program.** X11 protocol
  conversations — XDND, selections, WM protocols — fail into _another
  application's_ UI: a reply we never send freezes a drag cursor in a
  window we do not own, for a user who will never see our stderr. For
  cross-client protocols, deadlines and watchdog replies are the error
  message; write them as deliberately as one.

The bar, so this is not a licence to rewrite every throw: the developer
must be able to reach it in a supported setup and act on what it says; the
remedy must be specific (a snippet and an `apt-get` line, not "configure
fonts"); the cheapest real fix goes first even when it is not ours; and
"your environment lacks something" is distinguished from "your call is
wrong". Where the fix is longer than a sentence, the message links to
`docs/` — and a test pins that anchor, because a URL in a string literal
is the one kind of doc link nothing in CI checks.

## Gotchas

- The package is **ESM** (`"type": "module"`). ntk is ESM with top-level
  await in its graph; yoga-layout is ESM WASM. Everything imports statically
  now (no `require`).
- ntk comes from npm. Yoga is **ours** (`src/yoga.js`) — it used to be
  imported from ntk so that renderer and ntk's document widgets shared one
  WASM instance, but those widgets are gone and the renderer is the only
  layout consumer left. Import the engine from `./yoga.js`, never from
  `yoga-layout` directly (see the note under Layout). `<textinput>` caret
  math uses ntk 3.3.0's `TextLayout.caretPosition`/`indexAt`.
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
  - **a node only claims damage if something it _draws_ changed.** Paint
    style is compared by value, so a style object React rebuilt with the same
    contents costs nothing; every non-style prop is compared too, because
    that is where a subclass's content lives — `<image src>`, `<canvas
onDraw>`, `value`, `placeholder`. `children` and event handlers are
    skipped, child mutations having their own invalidation paths. Adding a
    prop that affects paint needs nothing; adding paint-relevant _style_
    means adding it to `paintPropsChanged`, which is why `borderStyle` is
    named there explicitly alongside `color`.

  Damage is a **list of rects, capped at four**, not the box around them, so
  two changes at opposite corners no longer repaint everything between them.
  The frame paints a pass per rect and clips each pass to that one rect —
  deliberately, because ntk's server-side clip fast path only recognises a
  single rectangle and a multi-rect clip path falls back to rasterizing a
  full-surface mask. Rects that overlap are merged rather than kept, since a
  node inside two of them would otherwise be painted twice, which is wrong for
  anything translucent. And a list whose rects nearly fill their box collapses
  back to the box, because a pass is not free: `SPLIT_SAVING` is the threshold.

  Presentation is ntk's job, and the two halves have to match to be worth
  anything: **ntk >= 3.10.2** copies just the rects the drawing reported, where
  earlier versions blit the whole window however little changed. That was the
  floor in `package.json` for a long time for this reason rather than for an
  API — against 3.10.1 the region list still computes and paints correctly, it
  just does not reach the screen any faster (NEXT_STEPS §8 item 4). The floor
  is now **4.3.0**, and that one _is_ an API: `Window.scrollRegion`, which the
  scroll-blit path below calls. The reporting channel is the clip:
  ntk takes each operation's clip rectangle as the region it might have touched,
  so a pass that is not clipped reports nothing and gives up the bound for the
  whole frame — which is why the frame clips per rect even though culling
  already skips the work.

  A scroll is the one layout change that carries a damage bound:
  `invalidate(true, node)` asserts the reflow is confined to that node's
  subtree _and_ that the node clips its children, so both the old and the new
  position of anything that moved are inside the bound. the `Scrollable` mixin is the
  only caller. Everything else still passes no node and repaints in full.
  `_subtreeBounds()` stops at a node that `clipsChildren()` for the same
  reason: a scroll pane's content extent is not what reaches the surface, and
  mid-scroll it can be ninety thousand pixels away.

  On top of that bound sits the **scroll-blit fast path** (issue #138,
  `_applyScrollBlits`): when a frame is a _pure_ single-axis scroll of one
  viewport, the surviving band is `CopyArea`'d inside ntk's backing pixmap
  (`Window.scrollRegion`, ntk >= 4.3.0 — the floor, though the call stays
  feature-detected so a mock or a deduped older copy degrades rather than
  throws) and the frame's
  damage narrows to the exposed strip plus the scrollbar repair rects — per
  wheel notch on a 500-row list that is 44 requests and 0.065 Mpx of
  Composite work instead of 89 and 0.33. Everything about it is a gate that
  falls back to the plain repaint: too-small viewports and page-sized jumps
  are not worth the bookkeeping (`SCROLL_BLIT_MIN_AREA`,
  `SCROLL_BLIT_MIN_KEEP`), fractional offsets and diagonal deltas cannot
  blit, a border/borderRadius on the scroll pane, an overlapping
  non-descendant, a debug overlay or DevTools highlight all bail.

  A claim landing inside the viewport used to bail too. It now goes into a
  per-frame **ledger** on the scrolling node (issue #398), recorded at
  `invalidate` time — _before_ rects coalesce and hide it, the reason the
  check was there at all (issue #295) — and repainted after the `CopyArea`,
  moved by the frame's delta when the claim predates the layout pass. The
  blit translates the previous frame's rendering, which is correct
  everywhere the content did not change; the ledger is the list of places
  it did. It still bails when a claim covers the viewport, when there are
  more than `BLIT_MAX_CLAIMS` of them, or when what they add up to
  (`BLIT_MAX_CLAIM_AREA`, and `SCROLL_BLIT_MAX_REPAINT` once the damage cap
  has merged them with the strip and the scrollbar column) stops being
  cheaper than the one pass it replaced. The case this exists for is the
  **virtualized list**, whose own re-slice commit claims inside the viewport
  on every scroll frame by construction — the spacers resize and the
  entering rows mount — so the fast path used to fire on the first wheel
  notch of a flick and never again. Three things feed the ledger the truth:
  a claim from inside the viewport is clipped to it (`_claimBounds`, so a
  spacer ninety thousand pixels tall does not coalesce the scroll's claim
  into a damage rect many times the viewport), the container's child-list
  claims go per-child instead of naming its own box, and the layout diff
  runs under a scroll with the shift subtracted so it reports the children
  that really moved rather than the ones that only rode the blit.

  The invariant, pinned by a pixel test in
  `test/scroll-blit.test.js`, is that a blitted frame is byte-identical to
  the repaint it replaced; `REACT_X11_NO_SCROLL_BLIT=1` turns the path off
  for A/B measurement and as field first aid. The bench's scroll scenario is
  baselined **with the blit live**, and that is what fences it: `--check`
  only fails on an _increase_, so against fallback numbers a change that
  silently stopped the fast path from firing would pass unnoticed. The fence
  is verifiable — `REACT_X11_NO_SCROLL_BLIT=1 npm run bench -- --check` must
  fail, and does (887 requests and 3.28 Mpx against a 437 / 0.65 baseline).
  The virtualized-list scenario beside it is fenced the same way, and is
  what prices the ledger: ten notches cost 295 requests / 0.56 Mpx with it
  and 785 / 3.20 without.

  **Where scrolling actually spent its time was neither of those.** Profiling a
  50,000-row table found the cost in ntk's `clip()`: intersecting a clip
  allocated a full-surface a8 pixmap, rasterized into it and composited the
  whole surface — per clip, and a frame nests them constantly. 3412 of 3900
  Composite requests over twenty wheel notches came from there. Fixed upstream
  in sidorares/ntk#107, shipped in **ntk 3.10.1**. Per wheel notch on the
  50,000-row table, same harness, only the ntk clip code differing:

  |                 | 3.10.0 | 3.10.1 |
  | --------------- | ------ | ------ |
  | requests        | 2542   | 1242   |
  | Composite calls | 242    | 25     |
  | Composite Mpx   | 153.8  | 2.1    |

  `scripts/bench/protocol.js` now has a nested-clip scenario, which is the
  shape no scenario had before, which is why nothing caught it. Client-side
  work is not the bottleneck for scrolling: layout and paint together were
  0.0ms next to what the server then had to redraw.

  Beware that `text: paragraph, inside a rect clip` **flaps by three
  requests** between runs — 43/40/43 on identical code. `--check`'s tolerance
  absorbs it, but it means a small real regression there would not be caught,
  and a baseline saved on a lucky run can look like a regression on the next.
  Not diagnosed; suspect glyph-page upload batching.

  **A clip that clips nothing is not free.** Each one rebuilds an a8 mask
  server-side — a `FillRectangles` plus trapezoid rasterization — and ntk
  brackets every glyph run under a clip with a `SetPictureClipRectangles`
  pair. `Table` sets `overflow: hidden` on every cell so that _long_ text
  truncates, and then almost every cell's text fits: 191 clips a frame, a
  handful of which do anything. `_paintChildren` now skips a clip when
  `_childrenCanOverflow()` says nothing reaches outside it, which took a
  scroll frame from 1242 requests and 1098ms to 1014 and 692ms in the
  in-process server. Rounded corners are never skipped — the clip is not a
  rectangle then — and the test is inset by a pixel because antialiasing puts
  ink just outside a glyph's box. `test/integration.test.js` checks that a
  child which really does overflow is still cut; it fails if clipping is
  disabled.

  Two traps when measuring this by hand (both hit while building
  `examples/stress/`):

  - **Never put a live counter next to what you are measuring.** A changing
    number re-measures its `<text>`, a re-measure is a layout change, and a
    layout change is a full repaint by definition — so the readout makes
    every frame report `FULL WINDOW` and destroys the thing it was reporting
    on. Log to stdout instead; `examples/stress/perf.js` wraps `flush()`.
  - **The first click on a control is not a clean measurement.** Pressing a
    button also changes its own hover and active styling, so that frame
    legitimately covers the button as well as whatever the press did. Warm up
    with one click and measure the next.
  - **An animation frame arrives with `needsPaint` still false.**
    `_advanceAnimations` sets it from _inside_ `flush`, so instrumentation that
    samples the flags on entry counts every other frame and misses a transition
    entirely. Test `root._animating.size > 0` as well.

  Three routes to an unbounded repaint, all found by hovering controls in
  `examples/stress/` and watching the log say `FULL WINDOW`, all now tested in
  `test/dirty-rect.test.js`:

  - **`NO_DAMAGE` must not mark the window dirty.** Contributing "no region" is
    not the same as contributing "unknown": a commit in which every node says
    so has genuinely nothing to repaint and should schedule no frame at all.
    Falling through to `needsPaint` left the window dirty with no region
    recorded, which repaints everything — so an identical re-render, which is
    what hovering a control that ignores its own hover state produces, cost a
    full-window repaint.
  - **`onDraw` matches `/^on[A-Z]/`,** so `_paintChanged` skips it as an event
    handler and `CanvasNode.applyProps` is the only thing that notices a new
    closure. It has to claim damage, and it has to claim it _bounded_ — every
    re-render of a component drawing through `<canvas>`, which is what a
    `Checkbox` tick and a `Select` chevron are, otherwise repainted the window.
  - **An animation must claim a region per frame, including its last.** A
    transition is a repaint every frame for its duration. Nodes that _finish_
    on a tick need claiming too, and the claim has to be decided _before_
    ticking, because a finished tick clears `_anim` and with it any way to tell
    a layout animation from a paint-only one. See `damageForAnimation`: an
    out-of-flow node animating a layout property is bounded by its parent,
    which contains both where it was and where it is going.

- **A commit's per-insert bookkeeping is amortized, not paid per row**
  (issue #397). React mounts a subtree one `insertBefore` at a time, so a
  virtualized list's re-slice — a hundred rows into one pane, per commit, for
  the length of a scrollbar scrub — used to pay for the whole pane per row: a
  `paintBounds()` walk for the before-damage, a scan of every sibling in front
  of the new row to find its yoga slot, and two `indexOf` over the child list.
  O(rows x pane), and about a third of commit time in the profile that found
  it. Three pieces of bookkeeping replaced the scans:

  - `_childListBefore()` walks the subtree **once per node per frame** and
    hands the same rect to every later mutation. Sound because nothing is laid
    out or painted between two mutations of one frame, so a child still in the
    list carries the rect it was last painted at and one that leaves later was
    inside the first walk's bound. `root._reflowed` is the marker for the
    window — joined at the first claim, cleared by `flush()`.
  - `_nonYogaKids` counts the children standing outside the parent's yoga tree
    (`<window>`, `<popup>`, text chunks), so the usual all-boxes list answers
    `_yogaIndexAt` with the child index instead of a walk.
  - `_indexOfChild` remembers a child's slot and **proves** it before use —
    `children[i] === child`, a node appearing in the list once — rather than
    trusting it, so a stale hint costs a scan and never a wrong answer.
    `_spliceChild` refreshes the two slots it knows, which is what keeps a run
    of inserts in front of the same trailing sibling off the scan entirely.

  Mounting 100 rows into an 800-row pane: 785k `_subtreeBounds` visits down to
  23k, 89k `_joinsYoga` calls to 900, 55ms of `insertBefore` to 4ms.
  `test/child-list-commit.test.js` fences the shape — the same commit against
  a pane four times as long asks the same number of questions — and pins the
  pixels against a full repaint. The pane in that pixel test is deliberately
  smaller than the rows it holds and does not clip them: a row that leaves is
  in no layout diff, and the arrangement claimed _after_ layout no longer
  reaches the band it occupied, so the pre-mutation walk is the only thing
  that erases it.

- **A stalled frame clock under synthetic input.** ntk paces
  `requestAnimationFrame` behind a fence (a `GetInputFocus` whose reply
  confirms the server consumed the last frame). Driving events with
  `wnd.emit()` rather than through the server can leave a frame scheduled and
  never run, so a fixed sleep returns with the tree committed but **not laid
  out** — every `abs` still `0,0,0,0`, which makes a synthesized click land at
  the window origin and hit whatever is in the corner. Call `root.flush()`
  (clearing `root._scheduled` first) instead of sleeping: it is the same frame
  the scheduler would have run. `test/dirty-rect.test.js` and
  `scripts/check-stress.jsx` both do this.

- **Request count is not a proxy for cost here; pixel work is.** ntk brackets
  every glyph run under a clip with a `SetPictureClipRectangles` pair, which is
  379 requests a scroll notch — 37% of all of them. Deleting every one of them
  changed the frame time by _nothing_, 681ms either way: they are 8-byte
  requests with no server pixel work behind them. The change that did move the
  needle was skipping clips nobody needed, because each of those rebuilt an a8
  mask. Measure a change in wall clock or in Composite pixels before optimising
  a request count — `npm run bench` reports both for that reason.
- **A clip bounds the pixels, not the drawing.** Anything drawn per line, per
  row or per cell has to be culled to the viewport by the code that draws it:
  the clip discards what falls outside, but only after the request has been
  built, sent and turned into a masked composite. `<textarea>` drew a fill
  per selected line, so Ctrl+A in a 400-line value cost 422 requests to light
  the seven lines on screen; drawing only the visible ones — and drawing them
  as one `ctx.fillRects` batch (ntk >= 7.6, one `Render.FillRectangles`) —
  made it 25, and flat in the size of the value. `test/selection-batch.test.js`
  measures the two sizes against each other rather than pinning a number.
- **Interpolate colours premultiplied.** `transparent` is _black_ at zero
  alpha, so lerping the four straight channels drags every fade-in towards
  black on the way: half way from `transparent` to a near-white hover fill
  lands on mid grey, and the brightness curve is not even monotonic — it dips
  dark and comes back. `Tabs` and `Tree` transition `backgroundColor` between
  `transparent` and a hover fill, so moving hover between two adjacent items
  faded one out as the other faded in and flashed a grey rectangle across both
  before settling. Measured off the window: `#c0c0c2` mid-transition against
  endpoints of `#ffffff` and `#f1f2f6`. `interpolate` premultiplies, lerps and
  divides the alpha back out, which is what CSS specifies for this exact
  reason. The endpoints are identical either way, which is why only a
  monotonicity test catches it.
- **Layouts sized against one font break in another.** `sans-serif` is
  whatever fontconfig hands you, and a row of things sized by their own text
  compresses only as far as the words inside it (see the content floors
  below) — past that it overflows and gets clipped. Three buttons that sat
  comfortably in a 250px card under the test fonts ran off the edge of it on
  a real desktop. Rows of buttons or chips want `flexWrap: 'wrap'`.
  `npm run stress:check -- --wide` renders the whole app in a monospace UI
  face and fails on any node overflowing a pinned-width ancestor, which is
  the pass that would have caught it.
- **`flexShrink` defaults to 1 and every flex item carries a content floor**
  (#249, `nodes.js`: `contentSpan`, `writeContentFloors`). Yoga defaults the
  shrink to 0 and has no floor at all, and **neither of its two answers is
  usable on its own**: with 0 a row never squeezes into the space it has, and
  with 1 everything collapses to nothing — scrolling stops existing, because
  a pane's content shrinks to its viewport. CSS has both halves, so the
  renderer measures the missing one: one min-content pass per axis on any
  frame that changes the layout, written onto the yoga nodes as
  `minWidth`/`minHeight` and taken back off before the next measurement.
  Things to know before touching it:
  - the measuring passes run **`measuringExactly`** (yoga's pixel grid off).
    Rounded sizes summed with exact paddings make a floor a pixel too tall,
    and a floor that exceeds the natural size does not hold a box, it
    _grows_ it — a pixel per nesting level, all the way up.
  - the measuring passes also **borrow `flexShrink`** (`setMeasuringShrink`):
    min-content means "nothing gives", so a pass run at the real default
    would answer that the content needs no room at all.
  - `_floorsDirty` is what keeps this off the input path — `invalidate()`
    sets it for every layout change **except a scroll**, which moves no yoga
    node.
  - the deliberate deviation from CSS is that a **named size is kept**: CSS
    floors an item at `min(its size, its content)`, which is fine on the web
    where a `<div>` is a block container and its children are not flex items,
    and is not fine here where every box is a flex container. `minHeight: 0`
    is how a style asks for CSS's answer.
  - `flexBasis` still wins over `width` on the main axis, so spreading a
    `flexBasis: 0` style into a fixed-width box collapses it to nothing.

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
  paint/event root). A scrolling `<box>` applies its offset during `absolutize`,
  so painting and hit testing see shifted rects; it defaults `minWidth` and
  `minHeight` to 0, which is what lets a viewport be smaller than what is
  inside it (CSS's own rule, and the content floors read it). The wheel default
  action (EventManager) scrolls the nearest enclosing scroll pane unless
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
- **A `<window>` size may be `'auto'`, and leaving it out means `'auto'`** —
  sized from its content, capped at the monitor's work area
  (`src/screens.js`, read once during `createRoot` so the answer is
  synchronous later). `WindowNode._measureNatural()` runs **before
  `CreateWindow`**, which is the whole point: the window is born the right
  size rather than resized into it after mapping. Two things about it are
  easy to undo by accident. The **second layout pass is not redundant** —
  the first has no available width so nothing wraps, and a height taken from
  it cuts wrapped text off; and ntk must **never see the keyword**, so
  `windowAttributes` drops an auto axis and `realize()` writes the resolved
  number back. Afterwards `_refit()` keeps an auto window on its content
  until `_userSized` — a ConfigureNotify that does not match
  `_requestedSize`, i.e. the user dragging an edge or a WM overriding —
  hands the size over for good. `_requestedSize` has to name **both** axes on
  every configure, since the echo does.
- Windows cannot be nested inside `<box>` (throws); raw strings are only
  legal inside `<text>` (throws otherwise).
- **Never test an unreleased ntk by symlinking the checkout into
  `node_modules`.** ntk then resolves `x11` from _its own_ `node_modules`
  while the tests import `x11/lib/xserver` from this one, so the client and
  the in-process server are different module instances and property work
  fails with `Bad atom` on ChangeProperty/GetProperty — deterministically,
  and with nothing in the message pointing at the cause. `npm pack` in the
  ntk checkout and `npm install --no-save /tmp/ntk-<version>.tgz` instead;
  that resolves one `x11` and the suite passes.
- ntk's `cssColor` returns **premultiplied** components (right for XRender,
  since 3.9.1). Anything heading for **GL** or for **interpolation** wants
  `cssColorStraight` — `glClearColor` and material colours take unassociated
  alpha, and a lerp that formats its result back into an `rgba()` string only
  round-trips on straight values. `src/glnodes.js`, `src/scene3d.js` and
  `src/styles.js` use the straight parser for exactly that reason. Note that
  opaque colours are identical either way, so a test with `#000000` and
  `#ffffff` cannot tell the two apart.
- **A frame that claims no damage repaints everything**, deliberately — the
  safe default when nothing can say what changed. It also means a test that
  changes one thing cannot demonstrate a missed repaint: with nothing bounding
  the region, the fallback covers the bug and the test passes either way. Pair
  it with a second change that _does_ bound the frame. Three tests in
  `test/dirty-rect.test.js` passed with the bug planted before their premises
  were tightened, so each now asserts its own premise.
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
phase 2 (events, scrolling), phase 3's `<popup>` and `<textinput>`
(on ntk 3.2.0: clipboard, cursors, setLineDash), and the layout debug
overlay (`REACT_X11_DEBUG_LAYOUT=1`). Element default actions (textinput
editing, wheel scrolling, Tab traversal) run via the `default*` methods on
nodes AFTER user prop handlers, skipped on `preventDefault()` — a documented
seam a registered element implements too (#251, docs/extending.md). The window-manager example
(issue #3) is done — on ntk 3.9.0 and node-x11 3.2.0, which grew the
substructure-redirect support it needed. Also done since: the widget set
including `Select`, `Menu`/`MenuBar`/`ContextMenu`, `Tabs`, `Tree`,
`SplitPane` and a virtualized `Table`; DevTools highlight-on-hover (the
DOM-ish host-instance contract, `getClientRects` + `ownerDocument`);
TypeScript declarations; and undo/redo in `<textinput>`/`<textarea>`.
`react-x11` is published on npm, with release-please keeping a release PR
open for the next version.

The right-click edit menu for the text controls is done too (#90,
`src/editmenu.js`), which closed **#88** — including its second half, where
right-click used to collapse the selection.

The AT-SPI accessibility work is done and in core (NEXT_STEPS §11.3,
[docs/accessibility.md](docs/accessibility.md)): standard `role`/`aria-*`
props on every element, `src/a11y.js` (the model) + `src/atspi.js` (the
bridge), Orca-verified. An element core did not write reaches the same feed
through the node seam (#257): `a11yRole`, `a11yTextState()` +
`notifyA11yTextChanged()`, and the two optional writes `a11ySetSelection` /
`a11yReplaceText` — normalized in `customTextState()` so a third-party
editor is read by the paths `<textinput>` is read by, never by a second
model. An element that draws _things_ rather than text says so the same way
(#304): `a11yScene()` lists them, `notifyA11ySceneChanged()` says the list
moved, `a11ySceneAction()` takes what an AT does to one — reconciled by
`id` into objects carrying ordinary `role`/`aria-*` props, so the whole
model reads them as it reads a `<box>`. Next: a generic Popover and a file open/save
dialog. **#85** (keyboard layout switching ignored) is done — ntk decodes
the active XKB group, and `src/keyboard.js` keeps shortcuts on the Latin
keysym even where XQuartz's keymap rewrite has left no Latin group
(docs/events.md "Layouts"). One open issue left from that pair: **#86**
`sans-serif` resolves to a CJK font on macOS.

The **system hooks** are in ([docs/system.md](docs/system.md)): `useScreens()`
(Xinerama for the geometry during `createRoot`, a RandR walk behind it for
names/primary/mm/refresh), `useWindowState()` (`_NET_WM_STATE` via ntk's
`statechange`, VisibilityNotify, focus), `useIdle()`/`useKeepAwake()` (SYNC
`IDLETIME` alarms, no polling, with MIT-SCREEN-SAVER under them),
`useKeyboardState()` (XKB `StateNotify` — Caps Lock before the first
keystroke, which `PasswordInput` wanted), `useDesktopSettings()` and
`useLocale()`. The last one is not only a hook: **the caret cadence, the
double-click window and the drag threshold were four hardcoded constants and
now come off XSETTINGS**, so `Net/CursorBlink: 0` — an accessibility setting —
finally stops the caret blinking. Worth knowing when working here: the
in-process test server has RENDER, BIG-REQUESTS and XC-MISC and _none_ of
those extensions, so the reply decoders are tested as pure functions and the
stores through their `set*ForTests` seams — the end-to-end walks only happen
against a real display. Three bugs in this work were only visible there
(`available` leaking a whole monitor record, XQuartz's synthetic 1 Hz mode,
and its literal `empty` XKB layout); `scripts/` has no probe for it, so run
one by hand against `$DISPLAY` before believing a protocol path.

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
