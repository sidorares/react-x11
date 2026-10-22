# React DevTools

react-x11 speaks to the standalone React DevTools app over its WebSocket
bridge.

## Setup

```sh
npm i -D react-devtools-core   # already a dev dep of this repo

# terminal 1 — the standalone UI (listens on :8097)
npx react-devtools

# terminal 2 — any app/example with the bridge enabled
REACT_X11_DEVTOOLS=1 npm run examples:dashboard
```

Either order works: the backend retries every two seconds, so an app
started first attaches a moment after the UI comes up. Under
`npx react-x11 dev` the bridge is on by default wherever
`react-devtools-core` is installed — run `npx react-devtools` and the app
shows up, `REACT_X11_DEVTOOLS=0` turns it off — and where it is not
installed while a UI is listening, `dev` says what to install.

What you get:

- the **component tree**, live as the app updates;
- **props, hooks and state** when selecting a component, and editing any of
  them — the app really re-renders;
- **highlight-on-hover** — hovering an element in the tree tints its rect
  in the window;
- **"highlight updates when components render"** — the rects that just
  re-rendered are outlined in DevTools' own colour ramp (teal for a first
  render through amber for one that keeps re-rendering), fading out;
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
  mount itself is recorded. **Not** its Timeline view, which this reconciler
  build does not support;
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
data. For that, `node --inspect` and `chrome://inspect` still work alongside
all of this.

## Opening the source from the DevTools panel

The inspected-element panel already shows where a component was written —
`file:///…/tasks.jsx:42:7`, absolute and source-mapped. Making that line
_clickable_ is a standalone-side setting, with two independent routes:

- **Spawn an editor.** The standalone launches one itself, choosing it from
  `REACT_EDITOR` (a full command line, shell-quoted), else — on macOS — an
  editor already running, else `VISUAL`, else `EDITOR`. It knows each
  editor's argument style (vim's `+42`, sublime's and JetBrains' `file:42`),
  so this is the route to reach for:

  ```sh
  REACT_EDITOR=cursor npx react-devtools
  ```

- **Open a URL.** ⚙ → General → "Open local files directly in your code
  editor", with the VS Code preset or a custom template using `{path}`,
  `{line}` and `{column}`. The setting lives in the standalone's own
  storage, not the app's.

Both are configured where the standalone runs, which may be a different
machine from the app; the app cannot inject either.
[Click-to-component](click-to-component.md) is the app-side answer to the same
question, and the one that works when DevTools runs somewhere without your
editor on it.

The same backend, minus the socket, powers `react-x11/test`'s component
inspection: `inspect()`/`setHook` in
[testing.md](testing.md#inspectnode-and-sethook) run entirely in-process — no
standalone app, no `ws`, no env variable. A test run that also sets
`REACT_X11_DEVTOOLS=1` shares one renderer registration with them.

## How it works (and its sharp edges)

The bridge is installed by `createRoot()` when `REACT_X11_DEVTOOLS` is set (by
`react-x11 dev`, earlier, before React Refresh loads). Its socket is `ws` from
`react-devtools-core`'s own dependencies, so `ws` is not a separate install.
What an app can notice while it is on:

- **It does not keep the process alive.** The backend's retry timer and socket
  are unref'd, so the process still exits when the app's last window closes;
  the app's own `setTimeout` and `WebSocket` are untouched.
- **Browser-ish globals appear.** `self` and `window` are set to the global
  where absent, `requestAnimationFrame`/`cancelAnimationFrame` are shimmed
  where absent, and `localStorage`/`sessionStorage` are defined (the store
  behind DevTools' settings file).
- **`Error.stackTraceLimit` is raised to 50** (never lowered), because React
  reads hook names and sources off a stack captured at each hook call and a
  loader such as `tsx` eats the default 10 frames. Without it, hooks show with
  no names and no source lines.
- **Selecting a component with hooks can blank the DevTools window.** That is
  the standalone app's own renderer process aborting, upstream of anything the
  app sends. Turning ⚙ → Components → "Always parse hook names for the
  selected element" off makes it intermittent rather than reliable;
  restarting `npx react-devtools` reconnects to the app, which is unaffected.

Design notes and maintainer notes:
[design/devtools.md](../design/devtools.md#how-it-works-and-its-sharp-edges).

## Other debugging aids

- `REACT_X11_DEBUG_LAYOUT=1` — outline every laid-out node, color-coded by
  tree depth.
- Refs: drawn elements expose the retained node (`abs` rect, `scrollTo`,
  …); `<window>`/`<popup>` expose the live ntk window (`getContext('2d')`,
  `queryTree`, `setCursor`, …).
- The in-process X server (node-x11's `lib/xserver`) renders headlessly and
  reads pixels back; `react-x11/test` is built on it
  ([testing.md](testing.md#pixels)).
