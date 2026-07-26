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
- the Profiler tab.

`REACT_X11_DEVTOOLS_HOST` / `REACT_X11_DEVTOOLS_PORT` point the backend at
a non-default standalone (e.g. devtools on another machine — handy when the
X app runs on a headless box).

## How it works (and its sharp edges)

`src/DevToolsIntegration.js`. When `REACT_X11_DEVTOOLS` is set, the module
installs the DevTools global hook at import time (top-level await, so the
hook exists before the first commit), connects the backend, and registers
the renderer via `injectIntoDevTools`.

Notes for maintainers:

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
