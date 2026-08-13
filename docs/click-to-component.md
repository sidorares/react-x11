# Click to component

Alt+Click any rendered element to jump straight to the JSX line that created
it, in your editor. On macOS/XQuartz that's **Option+Click** — Option is
what XQuartz maps to X11's Mod1 by default; the installed-feature log line
says whichever one applies to your platform.

## Setup

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

With React DevTools attached as well (`REACT_X11_DEVTOOLS=1`, see
[devtools.md](devtools.md)), the same click also selects that element in the
DevTools tree — one click to the source _and_ to its props. Nothing changes
when DevTools is absent, which is the usual case.

`REACT_X11_EDITOR` picks the editor (`cursor` by default): `code`,
`code-insiders`, `windsurf`, `vim`, `nvim`, or any other value, treated as a
custom URI scheme.

## How it works

`src/ClickToComponent.js`, installed from `Reconciler.js` when either
`REACT_X11_CLICK_TO_COMPONENT` or `REACT_X11_EDITOR` is set. No
babel/jsx-source plugin, no build-time instrumentation:

- every host node already carries a reference to the fiber that created it
  (`node._reactFiber`, set in `createInstance`). It is this feature's own
  back-reference, not a DevTools one: `findFiberByHostInstance` is gone
  from react-reconciler 0.33, and click-to-component works with DevTools
  absent;
- React 19 captures a real `Error` at every JSX call site in development
  mode (`fiber._debugStack`) and tracks who rendered what
  (`fiber._debugOwner`) — no `__source`/`__self` babel transform needed;
- Node's `--enable-source-maps` (already on for both the plain `tsx`
  examples and `examples:tasks:hot`'s loader) has rewritten that Error's
  stack to original source before we ever see it, so resolving a location
  is just parsing stack-trace text and skipping frames inside
  `node_modules` — no source-map library required (this is the one place
  the design diverges from a browser DOM version of the same idea: a
  browser doesn't remap `Error.stack` for you, so a tool like
  [show-component](https://github.com/sidorares/show-component) has to
  resolve source maps itself at runtime).

Alt+Click is recognized in `EventManager._onMouseDown`
(`src/events.js`) — `native.buttons & MOD.Alt` is X11's `Mod1Mask` bit, the
same `buttons` bitmask every synthetic event's `altKey` reads — ahead of the
normal press handling, so it never also starts a drag or moves focus.

GUI editors (cursor/code/code-insiders/windsurf, or any unrecognized
`REACT_X11_EDITOR` value treated as a raw scheme) are opened by navigating
their registered URI scheme — `open cursor://file/abs/path:line:col` on
macOS, `xdg-open` elsewhere — the same idea show-component uses in a
browser via `window.location.href`, just handed to the OS instead. This is
noticeably faster than spawning the editor's CLI shim directly: a CLI like
`cursor -g ...` is a wrapper script that re-detects and re-execs the real
app on every call, while the URI scheme is delivered straight to the
already-running instance by Launch Services / xdg-open. vim and nvim have
no URI scheme to navigate, so those are still spawned directly with a
`+call cursor(line, column)` argument.

## Caveats

- Needs React running in development mode (fiber debug fields are stripped
  in production builds).
- A node's `_reactFiber` is only refreshed on mount, not on every update —
  usually harmless (the JSX call site of a given element rarely moves
  between renders of the same tree shape), but a node that was
  conditionally re-typed can point at a stale-but-structurally-similar
  fiber.
