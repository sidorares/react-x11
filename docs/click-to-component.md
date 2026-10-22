# Click to component

Alt+Click any rendered element to jump straight to the JSX line that created
it, in your editor. On macOS that's **Option+Click**, on both backends: the
Cocoa backend maps ⌥ to Mod1 itself, and XQuartz maps it there by default
("Option keys send Alt_L and Alt_R" in its Input preferences). The
installed-feature log line says whichever one applies to your platform.

## Setup

Under `react-x11 dev` it is already on. Elsewhere:

```sh
REACT_X11_EDITOR=code npm run examples:tasks   # naming an editor enables it
# or, to use the default (cursor):
REACT_X11_CLICK_TO_COMPONENT=1 npm run examples:tasks
```

Alt/Option+Click a task row, a button, anything — its owning component's source
opens at the exact line, the clicked element flashes blue for a moment, and
the console prints what was resolved:

```
[click-to-component] TaskRow → examples/tasks.jsx:42:7
```

Alt+Shift+Click also logs the full ownership chain (who rendered who, up to
the root) to the console — handy when the immediate owner is a shared
wrapper rather than the component you actually meant.

## Elements you didn't write

An element rendered by an installed component — a design system's
`<Toolbar>`, a chart library's internals — has its JSX call site inside that
package, not in your code. Clicking one resolves to the nearest owner up the
chain that _is_ your source: the `<Toolbar ... />` line in your file that put
it on screen. The console line says how far it had to climb, so a location
that doesn't match what you clicked is never a surprise:

```
[click-to-component] App → src/ui/App.tsx:432:7 (1 owner up from the clicked <box>)
```

When no owner in the chain is application source (a screen rendered entirely
by a package), the package's own file is opened instead and the line is
marked `— inside an installed package`. Only a tree with no React debug info
at all resolves to nothing.

With React DevTools attached as well (`REACT_X11_DEVTOOLS=1`, see
[devtools.md](devtools.md)), the same click also selects that element in the
DevTools tree — one click to the source _and_ to its props. Nothing changes
when DevTools is absent, which is the usual case.

`REACT_X11_EDITOR` picks the editor (`cursor` by default): `code`,
`code-insiders`, `windsurf`, `vim`, `nvim`, or any other value, treated as a
custom URI scheme. `react-x11 dev`'s error window opens a line the same way,
through the same variable.

## How it works

It is installed when `REACT_X11_CLICK_TO_COMPONENT` or `REACT_X11_EDITOR` is
set, unless `REACT_X11_CLICK_TO_COMPONENT=0` — the way to turn it off under
`react-x11 dev`, which sets it to `1` when it is unset. No babel/jsx-source
plugin and no build step: React 19's development-mode call-site stacks and
owner chain are all it reads.

- **Locations are as good as the stack.** It reads the source location off
  `Error.stack`, so run with Node's `--enable-source-maps` (on in the `tsx`
  examples) or locations point at compiled output.
- **Alt+Click is taken before normal press handling**, so it never also
  starts a drag or moves focus.
- **GUI editors are opened through their URI scheme** —
  `open cursor://file/abs/path:line:col` on macOS, `xdg-open` elsewhere — which
  reaches the already-running instance; vim and nvim are spawned with a
  `+call cursor(line, column)` argument.

Design notes: [design/click-to-component.md](../design/click-to-component.md#how-it-works).

## Caveats

- Needs React running in development mode (fiber debug fields are stripped
  in production builds).
- The editor is launched detached, so a failure is only visible as a
  warning: an editor whose URI scheme nothing claims (`REACT_X11_EDITOR`
  naming an editor that isn't installed) prints
  `click-to-component — \`open cursor://...\` exited 1` next to the
  resolved location rather than silently doing nothing.
- A node's `_reactFiber` is only refreshed on mount, not on every update —
  usually harmless (the JSX call site of a given element rarely moves
  between renders of the same tree shape), but a node that was
  conditionally re-typed can point at a stale-but-structurally-similar
  fiber.
