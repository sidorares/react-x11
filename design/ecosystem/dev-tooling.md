# Developer tooling: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/ecosystem/dev-tooling.md](../../docs/ecosystem/dev-tooling.md),
the reference, and keep their original headings so code comments that cite
them still resolve.

## React DevTools {#react-devtools}

`react-devtools-core` is the backend half of React DevTools, made for exactly
this situation: a React tree running outside a browser page. It connects over
WebSocket to the standalone DevTools UI and streams the fiber tree, props,
hooks and profiler data. The integration lives in
`src/DevToolsIntegration.js` and costs nothing when off.

`src/Reconciler.js` checks `REACT_X11_DEVTOOLS` when you first call
`render()`/`createRoot()`, and installs the DevTools global hook _before the
first commit_ — that ordering is what makes mounted roots visible, and it
holds because a commit can only follow a root.
`REACT_X11_DEVTOOLS_HOST` and `REACT_X11_DEVTOOLS_PORT` point the backend at
a UI elsewhere, which is useful when the app runs on a headless box next to
the X server.

- `injectIntoDevTools` takes zero arguments in react-reconciler 0.33, so the
  config object passed to it is silently discarded and
  `findFiberByHostInstance` is never registered — DevTools cannot map a host
  node back to its fiber. The tree, props and highlight features do not need
  it. Do not add options to that call expecting them to do anything; the
  supported channel is `extraDevToolsConfig` on the host config.

## react-refresh {#react-refresh}

### How it reloads {#refresh-rules}

Under the hood two loader layers stack: babel (classic JSX transform plus
`react-refresh/babel`) instruments the components, and above it
`hot-module-replacement` rewrites static imports into live bindings and
wires `import.meta.hot`. The runtime half patches the DevTools global hook
before the renderer registers with it — ordering the loader guarantees by
injecting the runtime import into every hot module's prelude. The hot
boundary excludes `node_modules` and react-x11's own sources, so React,
the renderer and `react-refresh/runtime` stay singletons.

Each layer puts lines of its own above a module — babel's the refresh
prelude, hot-module-replacement's a preamble — and each says so in its source
map and composes the map of the layer beneath it. So a stack through a hot
module points at the source's own line and column, which is what
click-to-component opens: run Node with `--enable-source-maps`, which
`dev` turns on itself. The composing half is hot-module-replacement
4.0.2's, which is why that is the floor; `test/refresh-stack.test.js` fails
on 4.0.1.

The constraints are enforced errors now, not folklore:

- **One statement per prelude entry.** A `prelude` entry holding two
  statements or a newline throws, because the import rewrite replaces a
  whole import statement's span on its line.

What is _not_ enforced, so it is not rediscovered as a bug:

- **Module-scope side effects re-run on every reload** of the module and
  of everything between it and its boundary. Keep hot modules'
  top level idempotent, and keep identity that must survive (contexts,
  stores) in modules outside the hot graph — via the `ignore` seam or by
  extension. `registerElement` at module scope is safe: once the first hot
  re-import begins, a duplicate registration replaces silently instead of
  throwing (the
  [re-registration policy](../../docs/extending.md#hot-reload)) — mounted nodes keep the old
  prototype until they remount, the same staleness contract Fast Refresh
  has for classes. Remember the named-import rule applies to it like
  anything else: call it as `Host.registerElement(...)` through a
  namespace or default import.

## `0x` {#0x}

**Why 0x and not clinic.js:** Clinic's flame command is a wrapper around 0x,
so for flamegraphs it adds moving parts without adding signal. Its other
tools target server event-loop and async-I/O patterns that do not map onto a
GUI render loop, and the package has been dormant since early 2024 while 0x
keeps shipping.
