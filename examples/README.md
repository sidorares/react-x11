# Examples

Runnable demos, each a single file you can read top to bottom. They all need
an X server — a Linux desktop, XQuartz on macOS, or `Xvfb`/`Xephyr` for
something disposable — and they all read `$DISPLAY`.

```sh
npm run examples:simple        # start here
```

Every example also exports its `App` (and most export a panel) and skips
auto-running under `REACT_X11_NO_AUTORUN=1`, so the screenshot scripts and
tests can import them without opening a window.

## The tour

Roughly in the order worth reading them:

|                                      |                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| [`simple.jsx`](simple.jsx)           | hello world: flex layout and text, no pixel math. `npm run examples:simple`                  |
| [`simple-nojsx.js`](simple-nojsx.js) | the same thing in plain node with `React.createElement` — no build step at all               |
| [`xeyes.jsx`](xeyes.jsx)             | the `<canvas>` escape hatch: custom drawing plus hooks for state and polling                 |
| [`dashboard.jsx`](dashboard.jsx)     | context for theming, `useState`/`useEffect`/`useMemo`, a custom hook, hover and focus states |
| [`tasks.jsx`](tasks.jsx)             | `useReducer`, dispatch through context, list rendering, `<scrollview>`, keyboard throughout  |
| [`form.jsx`](form.jsx)               | `<textinput>`, `Select`, `RadioGroup`, `Slider`, `Checkbox`, and a modal `Dialog`            |
| [`widgets.jsx`](widgets.jsx)         | the gallery: every standard component in one window, with a live `<markdown>` preview        |
| [`menu.jsx`](menu.jsx)               | `MenuBar` and `ContextMenu` over real `<popup>` windows that flip at screen edges            |
| [`theming.jsx`](theming.jsx)         | the style engine end to end: three themes in light and dark, switched at runtime             |
| [`richtext.jsx`](richtext.jsx)       | `<markdown>` with mermaid and math, a live `<tex>` formula, JSX `<svg>`, `<image>`           |
| [`windows.jsx`](windows.jsx)         | many top-level windows from one React tree, sharing state, closing via `onCloseRequest`      |
| [`app.jsx`](app.jsx)                 | the showcase: `SplitPane` + `Tabs` hosting `form`, `widgets` and `tasks` as panels           |
| [`gl.jsx`](gl.jsx)                   | raw GL in a `<glarea>`, compiled to a server-side display list                               |
| [`three.jsx`](three.jsx)             | a react-three-fiber-shaped `<Canvas3D>` scene: meshes, lights, textures                      |
| [`wm.jsx`](wm.jsx)                   | **a reparenting window manager** — see below                                                 |

`app.jsx` is where a new control should get demonstrated: it imports the
panel each of `form`, `widgets` and `tasks` exports, so adding a widget
there shows it off without yet another example file.

The two GL examples need a server with **indirect GLX** enabled — it is off
by default nearly everywhere. Xorg takes `+iglx` on the command line or
`AllowIndirectGLX` in the config; XQuartz has its own setting:

```sh
defaults write org.xquartz.X11 enable_iglx -bool true   # then restart XQuartz
```

## Hot reloading

```sh
npm run examples:tasks:hot     # then edit examples/tasks.jsx while it runs
```

Edited components update in place through React Fast Refresh — the
connection, the window and component state (the task list, half-typed input)
all survive. [`tasks-hot.jsx`](tasks-hot.jsx) is the accept boundary,
[`hmr-register.mjs`](hmr-register.mjs) is the loader chain, and
[`tasks-context.js`](tasks-context.js) exists so context identity survives a
reload. The constraints on what may live inside a hot module are in
[AGENTS.md](../AGENTS.md#commands).

## The window manager

[`wm.jsx`](wm.jsx) is a real reparenting window manager: it takes over the
root window, puts every application's window inside a frame it draws, and
moves, resizes, focuses and closes them.

- [`wm-core.js`](wm-core.js) — the protocol half: claim the root, answer map
  and configure requests, keep the client list, EWMH, alt+tab
- [`wm.jsx`](wm.jsx) — the React half: frames, taskbar, drag gestures

Every frame is an ordinary `<window>`. The titlebar, its three buttons and
the eight resize handles are components with `onMouseDown` handlers, and the
application being managed is a foreign X window reparented inside.

Drag the titlebar to move and any edge or corner to resize. The three
titlebar buttons are minimize, maximize and close, in that order;
double-clicking the titlebar also maximizes. Click anywhere in a window to
focus and raise it, or alt+tab to cycle. Minimized windows go to the
taskbar and come back when you click them there.

**Only one window manager may run on a display at a time**, so it cannot
just be started alongside the one you already have — it will exit with
`another window manager is already running on this display`. Pick one of the
two ways below.

### A nested server (recommended, and safe)

`Xephyr` is an X server that displays in a window on your existing desktop.
Nothing outside that window is affected, and you can kill it at any time.

```sh
Xephyr :10 -screen 1200x800 &          # a 1200x800 "screen" in a window
DISPLAY=:10 npm run examples:wm        # the window manager owns :10
DISPLAY=:10 xterm &                    # give it something to manage
DISPLAY=:10 xclock -geometry 200x200 &
```

Any X client works, including the other examples in this folder:

```sh
DISPLAY=:10 npm run examples:widgets
```

On Linux, `Xephyr` is usually in a package called `xserver-xephyr` or
`xorg-x11-server-Xephyr`. On macOS it ships with XQuartz at
`/opt/X11/bin/Xephyr`, and runs inside your XQuartz session.

> **macOS:** if `DISPLAY=:10` fails with `ECONNREFUSED`, use
> `DISPLAY=unix/:10`. node-x11 used to read a plain `:N` on macOS as TCP
> port `6000+N`; `unix/` forces the socket and works on every version.

### Replacing the window manager you already have

If you want it managing your real session, the previous window manager has
to go. How depends on the platform.

**Linux.** Start a bare X session and make this the window manager it
launches, rather than fighting a desktop environment:

```sh
echo "cd $PWD && exec npm run examples:wm" > ~/.xinitrc
startx
```

Replacing the window manager of a _running_ session works with the
standalone ones (`openbox`, `i3`, `xfwm4` — stop it, start this) but not
under GNOME, where `mutter` is the session compositor and killing it logs
you out.

**macOS.** XQuartz starts `quartz-wm` from
`/opt/X11/etc/X11/xinit/xinitrc.d/99-quartz-wm.sh`, whose first line is a
hook for exactly this:

```sh
[ -n "${USERWM}" -a -x "${USERWM}" ] && exec "${USERWM}"
```

So point `USERWM` at an executable and XQuartz runs it _instead of_
`quartz-wm`. Do not just kill `quartz-wm`: that script `exec`s it, making it
the X session's main process, so killing it takes the whole session down.

1. Write a launcher, somewhere stable, and make it executable:

   ```sh
   cat > ~/react-x11-wm.sh <<'EOF'
   #!/bin/sh
   # XQuartz hands us DISPLAY=:N, which older node-x11 reads as TCP on macOS.
   # Harmless once that is fixed, and it cannot be worked around from outside:
   # the window manager is started *by* the server.
   [ "${DISPLAY#*/}" = "$DISPLAY" ] && DISPLAY="unix/$DISPLAY"
   export DISPLAY
   cd /path/to/react-x11
   exec node --import ./node_modules/tsx/dist/loader.mjs examples/wm.jsx \
     > /tmp/react-x11-wm.log 2>&1
   EOF
   chmod +x ~/react-x11-wm.sh
   ```

   Use an absolute path to `node` if you use a version manager — XQuartz is
   launched by `launchd` and will not have your shell's `PATH`.

2. Put it in the environment `launchd` hands to XQuartz, then restart
   XQuartz so the new session picks it up:

   ```sh
   launchctl setenv USERWM ~/react-x11-wm.sh
   osascript -e 'tell application "XQuartz" to quit'
   open -a XQuartz
   ```

3. Open something to manage — XQuartz's Applications menu, or:

   ```sh
   xterm &
   ```

   `/tmp/react-x11-wm.log` has anything that went wrong.

To put `quartz-wm` back:

```sh
launchctl unsetenv USERWM
osascript -e 'tell application "XQuartz" to quit'
open -a XQuartz
```

XQuartz runs **rootless** by default: each top-level X window becomes a
macOS window and there is no visible root, so the desktop background and the
taskbar have nowhere to appear. For the full effect turn that off before
restarting —

```sh
defaults write org.xquartz.X11 rootless -bool false
```

— which gives a real full-screen X root; XQuartz's menu then has an item for
switching between it and macOS. Set it back to `true` when you are done.

### Writing your own

The things that are easy to get wrong — why a frame must not unmount while
it holds a client, why the frame needs redirecting too, why `ButtonPress`
cannot be selected on a client window — are collected in
[AGENTS.md](../AGENTS.md#writing-a-window-manager). `test/wm.test.js` drives
the whole thing headlessly against node-x11's in-process X server, which is
the fastest way to try a change.
