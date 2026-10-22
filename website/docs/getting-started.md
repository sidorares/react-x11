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
X11 protocol in JavaScript, and yoga-layout, which is WASM. The native
bridges for macOS and Windows arrive prebuilt, and there is no toolkit to
have installed.

You need **Node 20.19 or newer** and somewhere to draw:

| where               | what to run                                                                        |
| ------------------- | ---------------------------------------------------------------------------------- |
| macOS               | nothing — the native **Cocoa** backend is the default there                        |
| Windows             | nothing — the native **win32** backend is the default there                        |
| Linux desktop       | nothing — `$DISPLAY` is already set                                                |
| headless / CI       | `Xvfb :99 & export DISPLAY=:99`                                                    |
| a disposable screen | `Xephyr :10 -screen 1200x800 & export DISPLAY=:10`                                 |
| someone else's box  | `ssh -X`, and draw to your own display over the wire                               |
| macOS, but on X11   | [XQuartz](https://www.xquartz.org/), a fresh terminal, and `REACT_X11_BACKEND=x11` |

The Cocoa backend arrives with react-x11 as an optional dependency
(`@windowkit/appkit`, prebuilt — nothing compiles); if it is not installed,
a Mac falls back to X11. The win32 backend does the same with
`@windowkit/win32`. Or skip all of that and use the
**[playground](/playground)**, which runs a JavaScript X server in the page.

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

## The entry point

```js
import { createRoot } from 'react-x11';
```

`await createRoot(options?)` is the whole of it. With no options it opens a
connection to whichever backend this machine has — Cocoa on macOS, win32 on
Windows, else X11 via `$DISPLAY` (Wayland is opt-in, with
`backend: 'wayland'`) — and gives you `{ app, render(element), unmount() }`, where
`app` is that backend's app object (on X11, the ntk App and its one X
connection).

```js
const root = await createRoot({ backend: 'x11', display: ':1' });
const root = await createRoot({ app }); // a connection you already have
```

`createRoot({ app })` is how the hermetic tests drive the renderer against
an in-process X server with no `$DISPLAY` at all. `root.render(element,
callback?)` applies mounts and updates **synchronously**; painting happens a
frame later, on the window's frame clock. Every option is in the
**[docs index](/docs/reference)**.

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

React **Fast Refresh**, without a bundler: edit a component while the
program runs and it updates in place — the X connection, the window and
component state (a task list, half-typed text in an input) all survive. A
component whose hook signature changed remounts by itself.

Export the component rather than mounting it, and hand the file to
`react-x11 dev`:

```jsx title="app.jsx"
import React from 'react';

export default function App() {
  const [count, setCount] = React.useState(0);
  return (
    <box style={{ padding: 24, gap: 12, alignItems: 'flex-start' }}>
      <text style={{ fontSize: 22, color: '#1c4e80' }}>
        hello from react-x11
      </text>
      <box
        style={{ backgroundColor: '#1c4e80', borderRadius: 6, padding: 10 }}
        onClick={() => setCount(count + 1)}
      >
        <text style={{ color: '#ffffff' }}>clicked {count} times</text>
      </box>
    </box>
  );
}
```

```bash
npx react-x11 dev app.jsx
```

Click the button a few times, then change the greeting and save: the text
changes and the count stays. `dev` mounts the file's default export, and
while the tree renders no `<window>` it shows it in one of its own, titled
after the file — render a `<window>` and yours takes its place.

Break something and save, and the error opens in a window: the message, the
source around the line, and the stack, each line of which opens in your
editor on a click (`REACT_X11_EDITOR=code` for VS Code; Cursor otherwise). A
save that does not compile leaves the app running beside it. Fix it and save
again, and the window goes.

The first run asks to install what hot reload is built from — Babel,
`react-refresh` and `hot-module-replacement`, as dev dependencies, so an app's
users never download them — with the project's own package manager. It needs
Node 22.15 or newer; the app itself runs on Node 20.19.

A save reloads in place when the file **exports only components, named with
a capital** — `export default function App()`, not an anonymous arrow. A
file that breaks the rule still runs, and `dev` says when it starts that
saving it will not reload it, and why. Identity that has to survive a
reload — a context, a store — goes in a module of its own that the reload
does not touch.

### The same file, without `dev`

`node`, `tsx` and `bun` run a file; they mount nothing, and they supply no
`<window>`. A file that should also run on its own renders its window and
mounts itself where no hot reload is running:

```jsx
import ReactX11 from 'react-x11';

// …the component, now inside a <window title="hello">

if (!import.meta.hot) {
  const root = await ReactX11.createRoot();
  root.render(<App />);
}
```

Under `dev` the guard is false and `dev` mounts the export; anywhere else
the file mounts itself. It is `ReactX11.createRoot()` rather than a named
`createRoot` because the hot loader compiles the file, and at a module's top
level a **named** import is still undefined — the loader stops with an
error saying so. Inside a component, named imports are fine.

`dev` is a host for `react-x11/refresh`, which also runs as
`node --import react-x11/refresh/register main.jsx` for a tool that hosts it
itself. The file named on that command line is never reloaded, so the
components go in modules it imports. Both routes, and what is enforced
where, are in
**[dev tooling](/docs/reference/ecosystem/dev-tooling#react-refresh)**; a
running example is `npm run examples:tasks:hot` in the repo.

### Not `bun --hot`

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
hovering a component in the tree tints its rect in the app's window. See
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
`dashboard`, `tasks`, `form`, `widgets`, `menu`, `theming`, `windows`,
`viewer3d` (raw GL in a `<glarea>`) — and `wm`, a reparenting **window
manager** whose frames are react-x11 components, which is X11 only.

```bash
npm run examples:app     # the showcase: SplitPane + Tabs hosting three panels
```
