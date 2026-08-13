# React DevTools

react-x11 speaks to the standalone React DevTools app over its WebSocket
bridge.

## Setup

```sh
npm i -D react-devtools-core ws   # already dev deps of this repo

# terminal 1 — the standalone UI (listens on :8097)
npx react-devtools

# terminal 2 — any app/example with the bridge enabled
REACT_X11_DEVTOOLS=1 npm run examples:dashboard
```

Order matters only in that the standalone should be listening when the app
starts (the backend retries, so starting the app first also works after a
few seconds).

What you get:

- the **component tree**, live as the app updates;
- **props, hooks and state** when selecting a component, and editing any of
  them — the edit goes through the reconciler's own override path, so the
  app really re-renders;
- **highlight-on-hover** — hovering an element in the tree tints its rect
  in the X11 window;
- **"highlight updates when components render"** — the rects that just
  re-rendered are outlined, in DevTools' own colour ramp (teal for a first
  render through amber for one that keeps re-rendering), fading out on the
  backend's clock;
- the **element picker** — the crosshair in the DevTools toolbar. While it
  is on, the pointer belongs to DevTools: motion tints whatever is under
  it, a click selects that element in the tree, `Escape` gives up. The app
  sees none of those events;
- the **style editor** — the box model and the flattened `style` of a
  selected element, editable live. Host elements are hidden by the default
  component filter, so turn that filter off (⚙ → Components → uncheck
  "host components") to have something with a style to select;
- the Profiler's commit list and flamegraph, including **"reload and start
  profiling"**, which re-execs the app with profiling already on so the
  mount itself is recorded. **Not** its Timeline view, which needs
  `injectProfilingHooks` — this reconciler build does not expose it, so
  there is nothing to enable;
- **DevTools' own settings** — component filters, console patching — kept
  between runs, in `$XDG_CACHE_HOME/react-x11/devtools.json`
  (`~/Library/Caches/react-x11/devtools.json` on macOS).

With `REACT_X11_CLICK_TO_COMPONENT=1` as well, an Alt+Click also selects
the clicked element in the DevTools tree on its way to opening the source
([click-to-component.md](click-to-component.md)).

`REACT_X11_DEVTOOLS_HOST` / `REACT_X11_DEVTOOLS_PORT` point the backend at
a non-default standalone (e.g. devtools on another machine — handy when the
X app runs on a headless box). `REACT_X11_DEVTOOLS_STATE` moves the
settings file.

DevTools has no network panel — nothing in its protocol carries network
data, and no injection would change that. For that, `node --inspect` and
`chrome://inspect` still work alongside all of this.

## Opening the source from the DevTools panel

The inspected-element panel already shows where a component was written —
`file:///…/tasks.jsx:42:7`, from the same React 19 call-site stacks
click-to-component reads, absolute and source-mapped. Making that line
_clickable_ is a standalone-side setting, and it has two independent
routes:

- **Spawn an editor.** The standalone launches one itself, choosing it from
  `REACT_EDITOR` (a full command line, shell-quoted), else — on macOS — by
  looking through `ps x` for an editor that is already running, else
  `VISUAL`, else `EDITOR`. It knows each editor's argument style — vim
  takes `+42`, sublime and the JetBrains editors take `file:42` — so this
  is the route to reach for:

  ```sh
  REACT_EDITOR=cursor npx react-devtools
  ```

- **Open a URL.** ⚙ → General → "Open local files directly in your code
  editor", with the VS Code preset or a custom template using `{path}`,
  `{line}` and `{column}`. The frontend turns our `file://` source into a
  plain path before filling it in. The setting lives in the standalone's
  own storage, not the app's.

Both are configured where the standalone runs, which may be a different
machine from the app. Neither is something the app can inject: the source
location is all the backend is asked for, and it is already sent.
Click-to-component ([click-to-component.md](click-to-component.md)) is the
app-side answer to the same question, and the one that works when DevTools
runs somewhere without your editor on it.

The same backend, minus the socket, powers `react-x11/test`'s component
inspection: `inspect()`/`setHook` in
[testing.md](testing.md#inspectnode-and-sethook) drive the renderer
interface the backend registers at injection, entirely in-process — no
standalone app, no `ws`, no env variable. If a test run does set
`REACT_X11_DEVTOOLS=1`, the two share one renderer registration (see the
guard in `connect()`).

## Watching the wire

The bridge is a plain WebSocket carrying text frames of `{"event": …,
"payload": …}` — no CDP, no binary framing. `scripts/devtools-proxy.mjs`
sits in the middle of it and prints what goes past, decoding the packed
`operations` arrays (the tree deltas) into readable lines:

```sh
npx react-devtools                      # terminal 1 — the real UI on :8097
npm run devtools:proxy                  # terminal 2 — :8098 -> :8097
REACT_X11_DEVTOOLS=1 REACT_X11_DEVTOOLS_PORT=8098 npm run examples:dashboard
```

```
 0.008 ▲ app operations 193B
       · renderer 1, root 1
       · add root 1
       · add 3 <Counter> (Function) under 2
 0.291 ▼ devtools inspectElement {"id":3,"rendererID":1,…}
```

`--only`/`--skip` filter by event name, `--full` prints whole payloads, and
`--jsonl FILE` appends every frame for later analysis.

## How it works (and its sharp edges)

`src/DevToolsIntegration.js`. When `REACT_X11_DEVTOOLS` is set, the hook is
installed from `render()`/`createRoot()` rather than at import time — a
top-level await there would make every bundle of react-x11 ESM-only, which
rules out a single executable ([packaging.md](packaging.md)). The ordering
guarantee is the same: a commit can only follow a root, and there is no way
to get one without awaiting the install. It connects the backend and
registers the renderer via `injectIntoDevTools`.

Notes for maintainers:

- **`injectIntoDevTools()` takes no arguments** in react-reconciler 0.33.
  What it reports comes from the host config — `rendererPackageName`,
  `rendererVersion`, `extraDevToolsConfig` — and an argument passed here is
  ignored without a word, which is how react-x11 shipped for a while with
  its renderer name and version quietly missing (#121). A test in
  `test/smoke.test.js` asserts what reaches the hook, so the next
  reconciler bump cannot repeat it.
- react-devtools-core v7 requires `initialize()` before
  `connectToDevTools`, exposes its API on the **default export** under
  node ESM interop, and expects browser-ish globals (`self`, `window`) —
  all handled in `prepare()`.
- The Highlighter only emits `showNativeHighlight` for host instances that
  implement `getClientRects()` returning a non-empty rect, and anything
  with `getClientRects` is measured at mount through
  `instance.ownerDocument.documentElement` — nodes therefore expose both
  (see `Node.getClientRects` / the `ownerDocument` stub in
  `src/nodes.js`).
- Highlight events arrive on the backend agent
  (`hook.reactDevtoolsAgent`, or the `'react-devtools'` hook event);
  `attachHighlightAgent` maps the public instance to its owning window
  node and paints a translucent overlay.
- **What makes the native paths run at all** is
  `isReactNativeEnvironment()`, which the backend defines as
  `window.document == null`. That is true for a node process with
  `window = global`, so the backend takes React Native's route everywhere:
  it _asks the host_ to draw the highlight and the update outlines, and to
  drive the picker, instead of drawing into a DOM overlay of its own. Every
  injection below is one of those asks.
- **Update outlines**: the backend counts updates, picks each rect's colour
  and expires it on its own clock, then emits `drawTraceUpdates`
  (`[{node, color}]` — the whole live set, every time) and
  `disableTraceUpdates`. `attachTraceUpdatesAgent` groups them by window
  and hands each root the rects; `WindowNode.setTraceUpdates` is a dumb
  overlay that replaces rather than accumulates. It schedules those redraws
  on `requestAnimationFrame`, which node does not have — `prepare()`
  installs an unref'd `setTimeout` shim, and without it the first traced
  commit throws inside the backend.
- **The picker**: with no `window.addEventListener` to install, the backend
  emits `startInspectingNative` and waits. `attachPickerAgent` takes the
  pointer through `setInspectHandler` (events.js) — motion, press and
  release are answered and go no further — and calls `agent.selectNode()`
  then `agent.stopInspectingNative(true)`. Cancelling from the DevTools
  side arrives as a bridge message with no host-facing event, so the
  picker also listens on `agent._bridge` directly; without that a
  cancelled picker would keep swallowing the app's input.
- **The style editor** needs three things and is offered only if it gets
  them: `resolveRNStyle` (our `flattenStyle`, minus state blocks, which are
  not editable values), `nativeStyleEditorValidAttributes`
  (`STYLE_PROP_NAMES`), and `instance.measure(cb)` on host instances for
  the box model — RN's contract, implemented by `Node.measure`. Edits
  arrive as `overrideValueAtPath` on `['style']` with the value wrapped in
  an array, which works here only because a react-x11 `style` prop already
  takes an array.
- **Reload and profile** is gated on a backend check that asks whether
  synchronous XHR works, so `isReloadAndProfileSupported: true` is passed
  explicitly. Registering a renderer does not start profiling, either — the
  run that comes back from the restart starts it itself, before the first
  commit, which is the only reason to restart at all.
- `localStorage`/`sessionStorage` are **defined** on the global rather than
  assigned: reading `global.localStorage` first is what makes node print
  its `--localstorage-file` warning on every DevTools run.
- `test/devtools.test.js` drives the real backend over a socket for all of
  the above; the fake-agent tests in `test/smoke.test.js` prove the drawing
  but not that the backend still asks for it.

## Other debugging aids

- `REACT_X11_DEBUG_LAYOUT=1` — outline every laid-out node, color-coded by
  tree depth.
- Refs: drawn elements expose the retained node (`abs` rect, `scrollTo`,
  …); `<window>`/`<popup>` expose the live ntk window (`getContext('2d')`,
  `queryTree`, `setCursor`, …).
- The in-process X server (`x11/lib/xserver`) renders headlessly and reads
  pixels back — see `test/integration.test.js` for the harness pattern,
  which is also how the README screenshots are generated.
