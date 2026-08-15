---
title: Getting started
sidebar_position: 2
slug: /getting-started
---

# Getting started

## Install

```bash
npm install react-x11 react
```

Nothing compiles. react-x11 pulls in [ntk](https://sidorares.github.io/ntk/)
and [node-x11](https://sidorares.github.io/node-x11/), which implement the
X11 protocol in JavaScript, and yoga-layout, which is WASM. There is no
native module and no toolkit to have installed.

You need **Node 20.19 or newer** and an X server to draw to:

| where               | what to run                                                     |
| ------------------- | --------------------------------------------------------------- |
| Linux desktop       | nothing — `$DISPLAY` is already set                             |
| macOS               | [XQuartz](https://www.xquartz.org/), then open a fresh terminal |
| headless / CI       | `Xvfb :99 & export DISPLAY=:99`                                 |
| a disposable screen | `Xephyr :10 -screen 1200x800 & export DISPLAY=:10`              |
| someone else's box  | `ssh -X`, and draw to your own display over the wire            |

Or skip all of that and use the **[playground](/playground)**, which runs a
JavaScript X server in the page.

## A first program

```jsx title="hello.jsx"
import React from 'react';
import { createRoot } from 'react-x11';

function App() {
  return (
    <window width={360} height={180} title="hello">
      <box
        style={{
          flexGrow: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#f4f6f8',
        }}
      >
        <text style={{ fontSize: 22, color: '#1c4e80' }}>
          hello from react-x11
        </text>
      </box>
    </window>
  );
}

const root = await createRoot();
root.render(<App />);
```

JSX needs a loader. [Bun](https://bun.com/) transforms it natively, so there
is nothing to add:

```bash
bun hello.jsx
```

Under Node, [`tsx`](https://tsx.hirok.io/) is the shortest route:

```bash
npx tsx hello.jsx
```

If you would rather not have a build step at all, `React.createElement`
works exactly as well and runs under plain `node`; the repo's
[`examples/simple-nojsx.js`](https://github.com/sidorares/react-x11/tree/master/examples/simple-nojsx.js)
is the same program written that way.

## The two entry points

```js
import { createRoot, render } from 'react-x11';
```

`await createRoot(container?)` is the modern one. With no argument it
connects to `$DISPLAY` and gives you `{ app, render(element), unmount() }`,
where `app` is the ntk App — one X connection. Pass an existing ntk App to
render into a connection you already have, which is how the hermetic tests
drive the renderer against an in-process X server with no `$DISPLAY` at all.

`render(element, callback?, container?)` is the legacy entry point. Both
apply mounts and updates **synchronously**; painting happens a frame later,
on ntk's frame clock.

## Styling in one minute

Everything CSS has a concept for goes in `style`; everything else is a prop.
No name means both, which is what keeps `<window width>` unambiguous — that
is the real X window's geometry, not a yoga property.

```jsx
<window
  title="Editor"
  width={900}
  height={600}
  minWidth={400}
  resizable
  style={{ flexDirection: 'row', backgroundColor: '#1e1e1e' }}
/>
```

Passing a style property flat throws in development, naming the fix. The
full model — pseudo-states, size queries, theme tokens, transitions,
`createStyles` — is in **[Styling](/docs/reference/styling)**.

## Hot reloading

React **Fast Refresh** works, under
[hot-module-replacement](https://github.com/sidorares/hot-module-replacement)'s
ESM loader hooks (Node ≥ 22.15). Edit a component while the program is
running and it updates in place — the X connection, the mounted window and
component state (a task list, half-typed text in an input) all survive. A
component whose hook signature changed remounts by itself.

The repo wires it up in three small files you can copy:

| file                                                                                                        | job                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`examples/hmr-register.mjs`](https://github.com/sidorares/react-x11/tree/master/examples/hmr-register.mjs) | the transform half — a sync babel loader (classic JSX + `react-refresh/babel`) chained under the HMR hooks |
| [`examples/hmr-refresh.js`](https://github.com/sidorares/react-x11/tree/master/examples/hmr-refresh.js)     | the runtime half — injects the refresh runtime into the reconciler; must be the entry's first import       |
| [`examples/tasks-hot.jsx`](https://github.com/sidorares/react-x11/tree/master/examples/tasks-hot.jsx)       | the accept boundary, calling `performReactRefresh()`                                                       |

```bash
git clone https://github.com/sidorares/react-x11 && cd react-x11 && npm install
npm run examples:tasks:hot     # then edit examples/tasks.jsx while it runs
```

Two constraints apply _inside_ a hot module: no calls on **named** imports
at module top level (those bindings become `let`s initialised in a
microtask — use the default import, `React.createContext`), and identity
that must survive a reload (contexts, stores) belongs in its own module that
the reload does not touch.

`bun --hot` is not a substitute. Its `import.meta.hot` API belongs to the
bundler and dev server, not the CLI runtime, where the property is
`undefined` — so there is no way to declare an accept boundary, and a reload
re-instantiates every module including `react`. The reconciler that is still
mounted then holds a different React than the reloaded components call, and
the first hook throws `resolveDispatcher(...) is null`. `bun --watch` works,
but it restarts the process: new connection, new window, no state. Fast
Refresh needs the loader hooks above.

## React DevTools

The standard standalone app, over its WebSocket bridge:

```bash
npx react-devtools                                # 1. the standalone UI
REACT_X11_DEVTOOLS=1 npx tsx hello.jsx            # 2. your app, bridge on
```

Component tree, props, hooks and the Profiler, plus highlight-on-hover:
hovering a component in the tree tints its rect in the X11 window. See
**[DevTools](/docs/reference/devtools)** for the rest, including
`REACT_X11_DEBUG_LAYOUT=1`, which outlines every laid-out node when a
flexbox is not doing what you expect.

## TypeScript

Types ship with the package — there is no `@types/react-x11`. One tsconfig
option points JSX at react-x11:

```json title="tsconfig.json"
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react-x11"
  }
}
```

react-x11 owns the JSX namespace rather than augmenting React's, which it
could not do anyway: `text`, `image`, `canvas`, `html` and `svg` are DOM
element names too, already declared with incompatible props. Owning it is
also what makes `<div>` a compile error. See
**[TypeScript](/docs/reference/typescript)**.

## Reading the examples

The repo carries a
[tour of runnable examples](https://github.com/sidorares/react-x11/tree/master/examples),
each a single file: `simple`, `xeyes` (the `<canvas>` escape hatch),
`dashboard`, `tasks`, `form`, `widgets`, `menu`, `theming`,
`windows`, `three` — and `wm`, a reparenting **window manager** whose frames
are react-x11 components.

```bash
npm run examples:app     # the showcase: SplitPane + Tabs hosting three panels
```
