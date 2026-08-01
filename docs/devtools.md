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
- **props, hooks and state** when selecting a component;
- **highlight-on-hover** — hovering an element in the tree tints its rect
  in the X11 window;
- the Profiler's commit list and flamegraph. **Not** its Timeline view,
  which needs `injectProfilingHooks` — this reconciler build does not
  expose it, so there is nothing to enable.

`REACT_X11_DEVTOOLS_HOST` / `REACT_X11_DEVTOOLS_PORT` point the backend at
a non-default standalone (e.g. devtools on another machine — handy when the
X app runs on a headless box).

The same backend, minus the socket, powers `react-x11/test`'s component
inspection: `inspect()`/`setHook` in
[testing.md](testing.md#inspectnode-and-sethook) drive the renderer
interface the backend registers at injection, entirely in-process — no
standalone app, no `ws`, no env variable. If a test run does set
`REACT_X11_DEVTOOLS=1`, the two share one renderer registration (see the
guard in `connect()`).

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

## Other debugging aids

- `REACT_X11_DEBUG_LAYOUT=1` — outline every laid-out node, color-coded by
  tree depth.
- Refs: drawn elements expose the retained node (`abs` rect, `scrollTo`,
  …); `<window>`/`<popup>` expose the live ntk window (`getContext('2d')`,
  `queryTree`, `setCursor`, …).
- The in-process X server (`x11/lib/xserver`) renders headlessly and reads
  pixels back — see `test/integration.test.js` for the harness pattern,
  which is also how the README screenshots are generated.
