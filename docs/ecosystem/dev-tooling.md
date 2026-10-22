# Developer tooling

This is the payoff of a pure-JS stack: a react-x11 app is an ordinary Node
process, so the whole V8 and React tooling story applies unmodified. Nothing
on this page needs an adapter.

The four tools answer four different questions, and it is worth knowing which
is which before you reach for one:

| Question                                       | Tool                                             |
| ---------------------------------------------- | ------------------------------------------------ |
| Which component rendered, and with what props? | [React DevTools](#react-devtools)                |
| Was that render _wasted_?                      | [why-did-you-render](#why-did-you-render)        |
| Where did the milliseconds go?                 | [`node --inspect`](#node-inspect), [`0x`](#0x)   |
| Why is memory growing?                         | [`node --inspect`](#node-inspect) heap snapshots |

`react-scan` is not on this page: its documented entry point does not resolve
under bare Node, and its programmatic API silently never fires. See the
[negative-results register](../ecosystem.md#silent-failures). React's own
`<Profiler>` works unchanged under react-x11 and covers the same ground for
commit timings.

## React DevTools {#react-devtools}

**Out of the box — already wired behind an env var.** react-devtools-core@7.0.1.

`react-devtools-core` is the backend half of React DevTools, made for exactly
this situation: a React tree running outside a browser page. It connects over
WebSocket to the standalone DevTools UI and streams the fiber tree, props,
hooks and profiler data. The integration lives in
`src/DevToolsIntegration.js` and costs nothing when off.

```sh
npm i -D react-devtools-core

# terminal 1 — standalone UI, listens on :8097
npx react-devtools

# terminal 2 — any app
REACT_X11_DEVTOOLS=1 npm run examples:dashboard
```

`src/Reconciler.js` checks `REACT_X11_DEVTOOLS` when you first call
`render()`/`createRoot()`, and installs the DevTools global hook _before the
first commit_ — that ordering is what makes mounted roots visible, and it
holds because a commit can only follow a root.
`REACT_X11_DEVTOOLS_HOST` and `REACT_X11_DEVTOOLS_PORT` point the backend at
a UI elsewhere, which is useful when the app runs on a headless box next to
the X server.

Working today: the live component tree, props/hooks/state inspection, and
highlight-on-hover — hovering an element in the tree tints its rect in the
X11 window. See [devtools](../devtools.md) for the full walkthrough.

- **Start the standalone UI first**, or wait for the backend's retry. The app
  side retries; the UI side does not attach to an already-running app unless
  the hook was installed at startup, and `REACT_X11_DEVTOOLS` cannot be
  turned on after the fact.
- The Profiler's commit-oriented views (flamegraph, ranked) work with the dev
  reconciler. The **Timeline** view cannot — it needs `injectProfilingHooks`,
  which react-reconciler 0.33 does not expose at all.
- `injectIntoDevTools` takes zero arguments in react-reconciler 0.33, so the
  config object passed to it is silently discarded and
  `findFiberByHostInstance` is never registered — DevTools cannot map a host
  node back to its fiber. The tree, props and highlight features do not need
  it. Do not add options to that call expecting them to do anything; the
  supported channel is `extraDevToolsConfig` on the host config.

## react-refresh {#react-refresh}

**Supported — `react-x11 dev` is the command, and `react-x11/refresh` the
entry point under it.** Fast Refresh without a bundler: edit a component,
and the mounted window updates in place with hook state intact. The X
connection, the window, the task list, half-typed text in an input — all
survive.

```sh
npx react-x11 dev app.jsx
```

A new app comes set up for it: `npm create react-x11@latest my-app` (or
`npx react-x11 create my-app`) writes `src/App.jsx`, an entry for a plain
run, and a `dev` script, with the toolchain below already in its
devDependencies. Beside them go `DESIGN.md`, the app's design brief, and
`AGENTS.md`, which tells a coding agent how react-x11 differs from
react-dom, where the docs installed with the package are, and how to check
its work by rendering the app to a PNG in light and dark
(`--no-agents-md` leaves it out).

### `react-x11 dev` {#react-x11-dev}

The package's `bin`, and the route with nothing to set up. What it does,
each because the bare loader leaves it to the app:

- **It is the entry, and imports the file.** The file named on node's
  command line is the one module hot-module-replacement never watches (see
  below), so here the file is imported instead, which makes it an ordinary
  hot module: an app in one file reloads.
- **It mounts the file's default export.** A file that mounts a root of its
  own while it is imported runs as it is — `dev` sees the root appear and
  mounts nothing — and then the modules it imports reload while it does
  not. A file that runs both ways mounts itself behind
  `if (!import.meta.hot)`, which is false under `dev` and true under `node`,
  `tsx` and `bun`; `examples/tasks.jsx` is written that way. One that mounts
  itself unguarded _and_ exports only components is told, at start, that
  every save re-runs its `createRoot` and opens another window.
- **It supplies a `<window>` while the tree renders none.** The tree is
  mounted as it is; a drawn element at the root throws an error with
  `code: 'NOT_IN_WINDOW'` before anything commits, and on that `dev` mounts
  it again inside a window titled after the file, sized to its content with
  a 320×200 floor. Decided again on every reload: render a `<window>` and
  `dev`'s goes (the component remounts, so its state resets — `dev` says
  so), lose it and it comes back. A tree that renders a `<window>` _beside_
  content in none stays wrapped, with a note saying which content needs a
  window. Closing the window ends the process, as closing an app's primary
  window does.
- **It says when a save will not reload.** A module reloads in place only
  when everything it exports is a component by React Refresh's rule — a
  capitalized name — so `export default () => …` and a module exporting a
  constant beside its component run, but saving them reloads nothing. `dev`
  says so, and why, when it starts, instead of leaving the first save to
  find out.
- **It asks before it installs the toolchain.** The four packages below are
  optional peer dependencies, so an app's users never download them; `dev`
  finds the ones missing, pins them to the ranges react-x11 is written
  against, and runs the project's package manager — from its lockfile, else
  the one that launched `dev`, else npm — when you say yes, then starts
  again. With no terminal to ask on it prints the command and exits.
- **It connects to [React DevTools](#react-devtools)** whenever
  `npx react-devtools` is running, started before the app or after it —
  wherever `react-devtools-core` is installed. Where it is not, and a
  DevTools UI is listening when `dev` starts, `dev` prints the install
  command. `REACT_X11_DEVTOOLS=0` turns it off.
- **It turns on [click-to-component](../click-to-component.md).**
  Alt+Click (Option+Click on macOS) an element and its JSX line opens in
  your editor. `REACT_X11_CLICK_TO_COMPONENT=0` turns it off.
- **It runs the project's react-x11.** A second copy of the renderer is a
  root nobody refreshes, so a global or npx-cached `react-x11` hands over to
  the copy the file imports, and a file that imports none is told to
  install it.

**Errors are shown in a window**, as well as printed:

- **A render error** takes the app's tree down, as it would anywhere, and a
  window titled `app.jsx — error` stands in for it. It shows the message, the
  components it was thrown under, the source around the line, and the
  stack's frames — React's, Node's and react-x11's own counted rather than
  listed. The next save tries the app again; the save that fixes it brings
  it back, and an app that throws again is back in the window.
- **A save that does not compile** opens the same window beside the app,
  which keeps running the module's last version with its state; it closes
  once the file compiles, or when you close it.
- A line in it opens in your editor on a click, the way
  [click-to-component](../click-to-component.md) does, by
  `REACT_X11_EDITOR` (`cursor` when it is unset).
- A throw from an event handler leaves the app running, so it is only
  printed, and dispatch continues.

Stack lines point at the source's own lines, through every loader layer's
source map; `dev` turns source maps on for you. Arguments after the file
are the app's: `react-x11 dev app.jsx --size large` hands the app the
`process.argv` that `node app.jsx --size large` would. `.jsx` files are
compiled and hot; `.js` and `.mjs` run as Node runs them, and the `.jsx`
modules they import are hot. TypeScript is not supported yet.

### Under `--import` {#refresh-import}

`dev` hosts the loader in its own process; a tool that hosts it itself —
a workbench, a custom dev loop — registers it with `--import`:

```sh
node --enable-source-maps --import react-x11/refresh/register main.jsx
```

The entry — the file named on the command line — is the one module that is
**never reloaded**: hot-module-replacement starts watching a module when
another module imports it, and nothing imports the entry. So an app written
as one file does not reload at all, and nothing says so. Keep the entry to
mounting, and the components in modules it imports:

```jsx
// main.jsx — written once, never edited while the app runs
import React from 'react';
import ReactX11 from 'react-x11'; // default import: see the rules below
import App from './app.jsx'; // `export default function App() { ... }`

const root = await ReactX11.createRoot();
root.render(<App />);
```

A save that does not compile is otherwise only printed — hot-module-replacement
catches the error, and the app keeps the module's last version — so a host
that wants to show it subscribes to the loader:

```js
import { onTransform } from 'react-x11/refresh/loader';

onTransform(({ filename, error }) => {
  // error is null when filename compiled
});
```

A tool that needs the loader's options writes its own two-line `--import`
module instead of `react-x11/refresh/register`:

```js
// tool-register.mjs, then: node --import ./tool-register.mjs app.jsx
import { registerRefresh } from 'react-x11/refresh/loader';

await registerRefresh({
  extensions: ['.jsx'], // which files are hot modules
  ignore: (path) => path.includes('/stores/'), // identity that must survive
  prelude: ['globalThis.__TOOL__ = true'], // injected into every hot module
});
```

### How it reloads {#refresh-rules}

Both routes run the same loader. It instruments every `.jsx`
module and decides per module whether it is a **refresh boundary**: a
module whose exports are all components self-accepts, so an edit to it (or
to anything below it with no boundary of its own) re-evaluates up to that
module and re-renders the edited components in place. A component whose
hook signature changed remounts alone. There are no accept handlers to
write; the one optional seam is the reload event:

```js
import { onReload } from 'react-x11/refresh';

onReload(({ urls, refreshed }) => {
  console.log(`${urls.length} module(s) reloaded`);
});
```

Node 22.15 or newer is required, for synchronous `module.registerHooks`,
and the toolchain rides four optional peer dependencies, which `dev` offers
to install and `--import` expects installed:

```sh
npm install --save-dev @babel/core @babel/plugin-transform-react-jsx react-refresh hot-module-replacement
```

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

- **A named import called at module top level inside a hot module is a
  transform error.** Named imports become live bindings initialized in a
  microtask, so at module scope the value is still undefined. Use the
  default import at top level (`React.createContext(...)`, not
  `createContext(...)`); inside components anything goes. The entry is
  transformed like the rest, so a named `createRoot` import followed by a
  top-level `await createRoot()` is this error: write
  `ReactX11.createRoot()` there.
- **Only the classic JSX runtime.** `jsxRuntime: 'automatic'` throws: the
  automatic runtime appends its `react/jsx-runtime` import to the last
  import's line, which the line-oriented import rewrite breaks.
- **One statement per prelude entry.** A `prelude` entry holding two
  statements or a newline throws, because the import rewrite replaces a
  whole import statement's span on its line.

What is _not_ enforced, so it is not rediscovered as a bug:

- Under `--import`, an edit to the entry is dropped, whatever the entry
  exports: it is never watched (above), so editing it needs a restart. An
  edit anywhere else reaches the tree only if a boundary sits on its import
  chain; a module whose importers lead to the entry without passing a
  component-only module is dropped the same way. Neither says anything —
  `dev` says the second, at start, for the file it runs.
- **Module-scope side effects re-run on every reload** of the module and
  of everything between it and its boundary. Keep hot modules'
  top level idempotent, and keep identity that must survive (contexts,
  stores) in modules outside the hot graph — via the `ignore` seam or by
  extension. `registerElement` at module scope is safe: once the first hot
  re-import begins, a duplicate registration replaces silently instead of
  throwing (the
  [re-registration policy](../extending.md#hot-reload)) — mounted nodes keep the old
  prototype until they remount, the same staleness contract Fast Refresh
  has for classes. Remember the named-import rule applies to it like
  anything else: call it as `Host.registerElement(...)` through a
  namespace or default import.
- Fast Refresh needs the dev reconciler; `NODE_ENV=production` is a
  registration error. There is no production hot path, by design.

## `node --inspect` {#node-inspect}

**Out of the box.** Node built-in.

Node's V8 inspector protocol: `node --inspect` exposes a debug port, and
Chrome's `chrome://inspect` (or VS Code's auto-attach) connects a full
DevTools instance — sourcemap-aware CPU profiler, heap snapshots, allocation
timelines, live debugging.

Everything that costs time in a react-x11 app is visible as ordinary JS
frames, which is why this is the recommended profiling path:

- **CPU profiles of commits.** Reconciler frames (`performUnitOfWork`,
  `completeWork`), yoga layout (`calculateLayout`), style resolution and ntk
  paint/flush show up in one call tree. That answers "is it React, layout, or
  painting" in a single recording.
- **Heap snapshots of retained nodes.** Every drawn element is a retained
  node object reachable from the ntk window's `_reactX11Node`. Snapshot,
  filter the constructor list, and leaked subtrees — a `<popup>` that never
  unmounted, listeners held after close — are directly countable. Two
  snapshots plus "Objects allocated between…" isolates a leak per
  interaction.

```sh
# interactive: profile a running app from Chrome
node --inspect --import tsx examples/dashboard.jsx
# chrome://inspect -> Open dedicated DevTools for Node -> Performance / Memory

# capture-on-exit CPU profile, no UI needed
node --cpu-prof --cpu-prof-dir=./profiles --import tsx examples/dashboard.jsx

# heap snapshot of a live app without restarting it
kill -USR1 <pid>   # inspector comes up on :9229, then attach and snapshot
```

- **Profile with `NODE_ENV=production` when chasing React costs.** The dev
  reconciler's stack-frame bookkeeping (`runWithFiberInDEV`) inflates commit
  times and clutters the tree. For layout and paint costs it matters less.
- The inspector port is an arbitrary-code-execution door. Bind it to
  `127.0.0.1` (the default) and never expose it on a network; for remote
  boxes, tunnel it with `ssh -L 9229:localhost:9229`.
- This and the React DevTools Profiler are complementary: DevTools names the
  _components_ per commit, the V8 profiler names the _functions_.

## `0x` {#0x}

**Out of the box.** 0x@6.0.0.

A single-command flamegraph generator: `0x -- node app.js` runs the process
under the V8 sampling profiler and, on exit, writes a self-contained
interactive `flamegraph.html`. No integration at all, and the interesting
frames are directly searchable — `performUnitOfWork`/`completeWork`, `yoga`,
and your own components.

```sh
# profile an example, write the output into a throwaway dir
npx 0x --output-dir /tmp/rx11-prof -- node --import tsx examples/dashboard.jsx
# interact with the window until the slow thing happens, then Ctrl-C
# -> file:///tmp/rx11-prof/flamegraph.html

# tips inside the flamegraph UI:
#   search "yoga"              -> layout cost
#   search "performUnitOfWork" -> react reconcile cost
#   "Merge" view               -> collapses recursion for a cleaner ranking
```

**Why 0x and not clinic.js:** Clinic's flame command is a wrapper around 0x,
so for flamegraphs it adds moving parts without adding signal. Its other
tools target server event-loop and async-I/O patterns that do not map onto a
GUI render loop, and the package has been dormant since early 2024 while 0x
keeps shipping.

- Sampling profiler: sub-millisecond handlers need a longer capture to show
  up, so drive the interaction in a loop.
- Profile with `NODE_ENV=production` when measuring React itself.
- Running through the tsx loader is fine, though frames from `.jsx` files
  show transformed function names. Component names usually survive.
- 0x answers "where does CPU time go", and says nothing about _which commit_
  or _why it re-rendered_. Pair it with the DevTools Profiler and
  why-did-you-render. For heap questions use `node --inspect`; 0x is CPU-only.

## why-did-you-render {#why-did-you-render}

**Out of the box.** @welldone-software/why-did-you-render@10.0.1.

Patches the `React` namespace so that components you flag report _avoidable_
re-renders — props or hook state that changed by reference but are equal by
value. It hooks React itself, not `react-dom`, which is exactly why it works
under a custom renderer.

```jsx
import React from 'react';
import whyDidYouRender from '@welldone-software/why-did-you-render';
import { createRoot } from 'react-x11';

whyDidYouRender(React); // before anything renders

const Label = ({ user }) => <text>{`hi ${user.name}`}</text>;
Label.whyDidYouRender = true;

// Every render passes a fresh-but-equal object — the classic wasted render:
const App = () => (
  <window width={300} height={200} title="wdyr">
    <box style={{ flexGrow: 1 }}>
      <Label user={{ name: 'ada' }} />
    </box>
  </window>
);

(await createRoot()).render(<App />);
// terminal: "Label … props.user: different objects that are equal by value."
```

- Props tracking reports a re-render caused by a new-but-deep-equal object
  prop with `diffType: 'deepEquals'` and the offending path. Hook tracking
  (`trackHooks`, on by default) reports `setState` with an equal-by-value
  object the same way.
- The default notifier prints readable `console.group` output in a terminal —
  no browser console needed. A custom `notifier` receives the structured
  `{displayName, reason: {propsDifferences, hookDifferences}}` object, which
  is also how you assert on wasted renders in tests.
- Works with the automatic JSX runtime as compiled by tsx and esbuild; the
  babel alias the docs describe for webpack setups is not needed.
- **Install it before components are defined and before the first render** —
  the patch wraps `React.createElement` and the hook entry points on the
  namespace.
- Dev-only by design. With `NODE_ENV=production` React's prod build drops the
  internals it reads; under plain `node`/`tsx` you get the dev build, which
  is the right mode for it anyway.
- Updates scheduled outside an event handler flush on a delayed task in React
  19, so in a scripted repro, wait a macrotask before asserting the
  notification fired.

This complements React DevTools: DevTools tells you _that_ a component
rendered; why-did-you-render tells you the render was _wasted_ and which
value to memoize.
