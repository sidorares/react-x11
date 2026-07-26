# AGENTS.md

Guidance for AI agents (and new contributors) working on react-x11.

## What this project is

A custom React renderer whose host environment is an X11 server, with
react-like ergonomics on top of [ntk](https://github.com/sidorares/ntk) /
[node-x11](https://github.com/sidorares/node-x11) — pure JavaScript
implementations of the X11 protocol, no native bridge.

Architecture (see NEXT_STEPS.md for the full rationale): only `<window>`
and `<popup>` map to real X11 windows; everything else is a retained
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
- `src/richnodes.js` — rich-content elements (`<markdown>`, `<html>`,
  `<svg>`, `<tex>`) wrapping ntk's document widgets in standalone mode:
  the widget's `layout(width)`/`contentHeight` feeds a yoga measure
  function, `draw(ctx, x, y)` paints, `onInvalidate` (ntk ≥ 3.4.0)
  reflows on async content (mermaid, images).
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

## Commands

- `npm test` — node:test. **Headless: no X server needed.** Primary feedback
  loop; keep it green and extend it when touching the host config.
- `npm run lint` / `npm run format` — ESLint 9 (flat config) + Prettier.
- `npm run examples:{simple,simple-nojsx,xeyes,dashboard,tasks}` — need a
  running X server (`DISPLAY` set; XQuartz on macOS, Xvfb for automation).

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
- Painting is a full-window repaint scheduled through
  `window.requestAnimationFrame` (ntk frame clock: coalescing + server
  fence). Presentation/damage is ntk's job; dirty-rect painting is a future
  optimization (NEXT_STEPS §8.4).
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

## Style

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
prop handlers, skipped on `preventDefault()`. Next: `<select>`/menus as
components, DevTools highlight-on-hover, npm publish. Open GitHub issues:
#3 window manager example, #4 top-down rendering, #13
react-native-dom-like architecture.

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
  itself (README, docs site). Caveat for agents: user-attachments has no
  API (browser session only — PATs/OAuth are rejected), so generate the
  PNGs, leave placeholders in the PR body, and hand the file paths to a
  human to drag in.
