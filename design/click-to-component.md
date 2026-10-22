# Click to component: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/click-to-component.md](../docs/click-to-component.md), the reference, and keep
their original headings so code comments that cite them still resolve.

## Elements you didn't write

`REACT_X11_EDITOR` picks the editor (`cursor` by default): `code`,
`code-insiders`, `windsurf`, `vim`, `nvim`, or any other value, treated as a
custom URI scheme. `react-x11 dev`'s error window opens a line the same way,
through the same variable (`src/editor.js`, shared by both).

## How it works

`src/ClickToComponent.js`, installed from `Reconciler.js` when either
`REACT_X11_CLICK_TO_COMPONENT` or `REACT_X11_EDITOR` is set, and
`REACT_X11_CLICK_TO_COMPONENT` is not `0` — the way to turn it off under
`react-x11 dev`, which sets it to `1` when it is unset. No
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
  is just parsing stack-trace text and skipping the frames React and this
  renderer add on top of the call site (`react`, `react-reconciler`,
  `scheduler`, `react-x11`'s own `src/`) — no source-map library required
  (this is the one place
  the design diverges from a browser DOM version of the same idea: a
  browser doesn't remap `Error.stack` for you, so a tool like
  [show-component](https://github.com/sidorares/show-component) has to
  resolve source maps itself at runtime).

Frames from _other_ packages are deliberately kept rather than skipped: a
call site inside an installed component is a real location, it just isn't
one in your source, and telling those apart is what lets the resolver climb
the `_debugOwner` chain to the line that is. Skipping every `node_modules`
frame instead walks past the library component entirely and lands on
whichever frame of yours happens to be deeper in the render stack — usually
the `render()` call at startup, which looks like an answer and isn't.

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
