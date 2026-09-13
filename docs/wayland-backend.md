# The Wayland backend

**Status: a working backend, opt-in.** react-x11's own reconciler renders a
window on a real Wayland compositor (mutter/GNOME, sway, labwc) with
decorations — the compositor's where it draws them, client-side where it
does not — text, shadows, paths, images, live partial repaints, pointer and
keyboard input decoded against the compositor's keymap, a clipboard, popups,
layer-shell docks and panels, and a screen capture with an eyedropper on
top — drawn on the GPU and handed over as dma-buf, on **Node or Bun**, with
no X server and no Xwayland anywhere in the path.

This is the companion to [wayland.md](wayland.md), the research RFC it
implements. Where the two disagree, this one is the one that ran.

```bash
REACT_X11_BACKEND=wayland node your-app.mjs     # x11-dri >= 0.9 (native socket)
REACT_X11_BACKEND=wayland bun  your-app.mjs     # or Bun's bun:ffi transport
node examples/wayland-gl.mjs                    # GPU plasma, paced by the compositor
node examples/wayland-ui.mjs                    # every drawing primitive, no React
node --import tsx --test test/wayland/          # the suite: no display needed
```

The backend is never chosen by `'auto'`: X11 stays the default on Linux
because the remote case ([remote.md](remote.md)) is the flagship reason this
project exists and Wayland has no network transparency.

## How to tell it is not Xwayland

A GNOME session answers `$DISPLAY` too, through Xwayland, so "the window
appeared" proves nothing. Three checks that do:

- **Unset `DISPLAY`.** The Wayland backend never opens it; the X11 backend
  cannot start without it.
  ```bash
  env -u DISPLAY REACT_X11_BACKEND=wayland node app.mjs   # works only natively
  ```
- **Ask the app.** `root.app.backend === 'wayland'`, and `root.app.X` is the
  stand-in from `app.js` — no `display.screen`, no `X.require`. The examples
  print the transport they connected through (`connected via x11-dri` or
  `fdpass-bun`) and never import an X module at all.
- **Ask the desktop.** `xlsclients` and `xwininfo -root -tree` list Xwayland
  clients; a native window is absent from both. GNOME's Looking Glass
  (`Alt+F2`, `lg`, Windows tab) shows it as a `MetaWindowWayland`, and its
  frame is this backend's own titlebar (`decorations.js`) rather than
  mutter's Adwaita frame, which only Xwayland windows get.

## What runs

| piece              | file                                                     | what it does                                                           |
| ------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| connection         | `connection.js`                                          | fd-capable transport (native or bun:ffi), vendored protocol JSON       |
| shell              | `window.js`                                              | xdg toplevels and popups, deferred `ack_configure`, fractional scale   |
| GPU presentation   | `swapchain.js`, `dmabuf.js`, `glcontext.js`, `target.js` | backing target → per-buffer damage → dma-buf                           |
| 2d context         | `context2d.js`, `glyphatlas.js`                          | rects/rounded rects (SDF), paths (stencil), gradients, images, text    |
| input              | `seat.js`, `xkb.js`, `keysymnames.js`, `input.js`        | pointer frames, keymap parsing, key repeat, routing                    |
| decorations        | `decorations.js`, `ssd.js`                               | the client-side frame, and xdg-decoration to hand it to the compositor |
| layer surfaces     | `layershell.js`                                          | docks, panels, wallpapers, overlays — wlr-layer-shell                  |
| screen capture     | `screencopy.js`, `shm.js`                                | wlr-screencopy / ext-image-copy-capture into `wl_shm`; the eyedropper  |
| offscreen surfaces | `surface.js`                                             | the paint cache and scroll blits, over a render target                 |
| clipboard          | `clipboard.js`, `fdutil.js`                              | `wl_data_device` + primary selection, over pipes                       |
| the app            | `app.js`, `backendwindow.js`, `nullable.js`              | what `createRoot({ backend: 'wayland' })` renders through              |
| tests              | `test/wayland/`                                          | an in-process compositor, and the pure parts                           |

## What was measured

Everything below was run on this machine (mutter, virtio-gpu/virgl over an
Apple M1 Pro host, 2488×1668 @ 75Hz). Numbers from a VM's GPU are the VM's;
the protocol numbers are not.

### The protocol layer is not the cost

Asked first, because it decides whether a native protocol bridge is
justified. Measured with `wayland-client` (the fork), per request and per
event:

| measure                                  | Bun                          | Node (native socket)      |
| ---------------------------------------- | ---------------------------- | ------------------------- |
| encode + write, async API                | 0.32 M req/s                 | 0.20 M req/s              |
| encode + write, `$` synchronous API      | 0.49 M req/s                 | **0.67 M req/s** (1.5 µs) |
| decode + dispatch                        | 2.3 M ev/s                   | **3.0 M ev/s** (0.33 µs)  |
| round trip `sync` → `done`, plain socket | 0.141 ms p50                 | 0.119 ms p50              |
| round trip, fd-capable socket            | 0.178 ms p50 (reader thread) | **0.097 ms p50**          |

A frame issues a handful of requests and input peaks near a thousand events
a second: the JavaScript protocol layer is one to two orders of magnitude
below anything visible. **No native protocol bridge was built, on purpose.**
The one native piece is the socket itself, and only because Node cannot
receive descriptors at all; its round trip turned out lower than Node's own
`net.Socket`'s, and the thread-hop cost of the Bun transport (~37 µs) is real
but not worth acting on.

### Where a frame goes

| phase                              | p50     |
| ---------------------------------- | ------- |
| `makeCurrent`                      | 0.04 ms |
| draw                               | 0.05 ms |
| Wayland (attach / damage / commit) | 0.09 ms |
| **`Surface.swap()`**               | 24.5 ms |

The cost is `swap()`, and it is environmental: with no compositor at all,
`swap()` is 0.07 ms and `glFinish()` is ~10 ms — the same at 64×64 as at
720×480. Size-independent means host round-trip latency, not fill rate; this
is virgl in a VM. On bare metal the number should mostly disappear and must
be re-measured there before any conclusion about the backend's performance is
drawn from it.

The 2d context on the UI demo: 252 quads, 239 glyphs and 2 paths in **23
draw calls**.

## The design, where it is not the obvious one

**A backing target, not the swapchain, is what gets painted.** react-x11's
renderer repaints dirty rectangles into a persistent surface, as it would an
X pixmap. A GBM swapchain rotates, so the buffer a frame lands in last showed
the frame before last, and a partial repaint into it leaves stale pixels
everywhere else. So the renderer paints into a persistent render target
(`target.js`) and the changed rectangles are copied into whichever buffer
comes round. GBM names the buffer only _after_ the swap, so the copy uses the
union of what every known buffer still owes — and everything, until a full
rotation has passed without meeting a new buffer. The tests pin the rule
(`swapchain.test.js`); a React counter ticking at 400 ms presents frames
with **one** damage rectangle.

**Analytic shapes first, stencil second.** Rounded rectangles — most of a
UI — are signed distance fields in the fragment shader: antialiased without
multisampling, and every box in a window batches into one draw. Arbitrary
paths (`<svg>`, `ctx.fill(path2d)`) are flattened by ntk's own `flattenPath`
and filled stencil-then-cover on the target's stencil attachment. Strokes
are the union of segment quads and join polygons under the non-zero rule.
Box shadows are a feathered SDF (`ctx.fillShadow`, which `boxpaint.js` now
prefers when a context has it) rather than a CPU blur through the paint
cache.

**The ack is deferred to the frame that adopts it.** `xdg_surface.configure`
is acknowledged immediately before the commit of a frame painted at the
configured size, not on arrival — acking early tells the compositor the
next commit is at the new size, and a buffer painted at the old one is then
shown stretched.

**Everything the renderer sees is content-relative device pixels.** The
surface is larger than the content by the client-side frame, and the
compositor speaks logical pixels; the two conversions happen in
`backendwindow.js` and `input.js` and nowhere else.

**The keymap is parsed, not dlopen'd.** The compositor sends an XKB keymap
as a file descriptor; `xkb.js` reads keycodes, types (modifier → level
maps), symbols per group, and resolves virtual modifiers like `LevelThree`
to real ones through `interpret` + `modifier_map` — so AltGr works because
the keymap says which bit it is, not because Mod5 was assumed. The output is
both the X core `keycode2keysyms` table the accelerator code already speaks
and a full `decode()` for levels 3 and 4. Key repeat is synthesised at the
seat's advertised rate; compositors do not repeat.

**`createWindow` is synchronous.** React's commit phase cannot await, and
that is where windows are realised. Nothing about Wayland needs the
asynchrony — a request is one-way and the client allocates ids — so the
library grew a synchronous namespace (`Wl_interface.$`) and the only
genuinely asynchronous step, binding globals, happens once in `open()`.

## Decorations: whose frame

`decorations.js` draws a titlebar because mutter will not, and that stays
the default where nothing better is offered. Where a compositor advertises
`zxdg_decoration_manager_v1` — wlroots (sway, labwc), KDE — each toplevel
creates a decoration object before its first commit and asks for
server-side decorations (`ssd.js`). The compositor's answer is a
`configure(mode)` that is part of the surface's configure sequence, so it
is adopted on the same ack as the size it arrived with: 'server' switches
the client-side frame off (insets to zero, no titlebar painted, the content
grows into the whole surface, which the tree sees as a resize), 'client'
leaves it on. Before the first frame, where the compositor imposed no size,
the surface is refitted to the content the tree asked for, so a floating
window comes up the size it was declared and not a titlebar taller.

`createRoot({ decorations })` says what to ask for: `undefined`/`true`/
`'server'` prefer the compositor's frame, `'client'` never asks for it, and
`false` — as does `<window decorations={false}>` — wants no frame at all.
A frameless window still creates the decoration object where the protocol
exists, to _decline_ server-side: sway frames every toplevel that has not
said `client_side`.

## Layer surfaces: docks, panels, wallpapers

Where the compositor advertises `zwlr_layer_shell_v1`, a `<window>` whose
`windowType` is one of these is not an `xdg_toplevel` but a layer surface
(`layershell.js`), the same `wl_surface`, frame loop and input underneath:

| `windowType`     | layer        | anchored to                                       | exclusive zone |
| ---------------- | ------------ | ------------------------------------------------- | -------------- |
| `'dock'`         | `top`        | the edge its shape and position imply (see below) | its thickness  |
| `'desktop'`      | `background` | all four edges                                    | -1             |
| `'notification'` | `top`        | top and right, 12px in                            | 0              |
| `'splash'`       | `overlay`    | nothing — the compositor centres it               | 0              |

A dock's edge is read the way an X window manager reads the same window:
wide and at `y={0}` is a top panel, wide otherwise a bottom one; tall and at
`x={0}` a left dock, tall otherwise a right one. Its size is what the tree
measured (or `width`/`height`), so a 560×56 dock sits centred on its edge
with 56px reserved; anchoring it to both ends of the edge stretches it:

```jsx
<window windowType="dock" height={56}>…</window>
<window windowType="dock" height={40} layerShell={{ anchor: ['bottom', 'left', 'right'] }}>…</window>
<window layerShell={{ layer: 'overlay', anchor: 'bottom', margin: { bottom: 40 } }}>an OSD</window>
```

`layerShell` names anything the type's default gets wrong — `layer`,
`anchor` (an edge, an array of edges, `'all'`, `'none'`), `exclusiveZone`
(a number, `'auto'` for the thickness, `-1`), `margin`,
`keyboardInteractivity` (`'none'`, `'on-demand'`, `'exclusive'`),
`namespace`, `output` — and `layerShell={false}` keeps a dock-typed window
an ordinary toplevel. Popups from a layer surface work (a dock's menus): the
`xdg_popup` is created parentless and adopted through
`zwlr_layer_surface_v1.get_popup`. A stretched axis is the compositor's:
`resize()` on it is not granted, and the configured size wins. Without
layer-shell — GNOME — the same JSX is a toplevel, as before.

## Screen capture, and the eyedropper

`app.screenCapture` (`screencopy.js`) is there when the compositor offers
either `ext_image_copy_capture_manager_v1` (wlroots 0.19+, KDE 6.2+) or
`zwlr_screencopy_manager_v1` (sway 1.10 has this one), and null otherwise
(GNOME). `capture()` answers one frame of the output as straight RGBA, the
shape `readback.js`'s `encodePNG` takes; `pixelAt(x, y)` one device pixel
of it. The pixels land in a `wl_shm` pool (`shm.js`) whose memory is a
memfd (or an unlinked `/dev/shm` file without x11-dri), read back with
`fs.readSync` — there is no mmap in Node or Bun, and one copy of one screen
on a path nobody runs per frame is the cheaper trade than a native binding.

`pickColor()` is the eyedropper, and it is what every wlroots colour picker
does: freeze the output into a capture, show that capture as a layer-shell
overlay anchored to every edge with an exclusive keyboard, take the click
_on the overlay_ — whose coordinates are the output's — read the pixel out
of the capture, and take the overlay down. Escape cancels; Return, space and
KP_Enter pick at the pointer. It answers `{ r, g, b }` in 0–1, the portal's
units, so `src/screencolor.js` converts it with the same function as the
portal's and the cocoa sampler's. There it is rung 3 of the ladder: below
the Screenshot portal (the desktop's own picker, user-consented — GNOME's
only route, and what sway with xdg-desktop-portal-wlr uses too) and above
the X11 grab. `useEyedropper().supported` is true on a bare sway; the rung
is guarded by `app.backend === 'wayland'` because the capability is a
Wayland object through and through.

Two protocol gaps are worth knowing. The `wayland-client` fork keeps one
global per interface name, so the output bound here is the one advertised
last; `capture({ output })` and `layerShell.output` take another proxy, but
enumerating them waits on `outputs.js`. And the portal's `parent_window`
handle names an X window; a Wayland toplevel has none without xdg-foreign,
so the portal dialog floats.

## Under a second compositor

mutter was the only compositor this backend had met until sway 1.10.1 and
labwc 0.8.3 ran here, nested (`WLR_BACKENDS=wayland`) and headless
(`WLR_BACKENDS=headless`), which is also the first time a screenshot of the
whole path was possible — `grim` needs wlr-screencopy, which mutter
refuses:

```bash
WLR_BACKENDS=headless sway -c sway.conf &          # output * resolution 1280x800
WAYLAND_DISPLAY=wayland-1 REACT_X11_BACKEND=wayland node --import tsx examples/simple.jsx &
WAYLAND_DISPLAY=wayland-1 grim shot.png
```

What it showed: the window comes up in sway's own frame (title bar and 2px
border, `default_border normal 2`) with the client-side bar gone and the
content filling the surface; a `windowType="dock"` window is a bottom layer
surface with a reserved strip the tiled toplevel keeps clear of; the
capture matches what grim sees; and the eyedropper's overlay maps and the
pick resolves from a synthesised click. The one protocol bug it surfaced is
in the client library rather than the compositor: the fork refuses a null
object argument (`set_parent(null)`, `set_fullscreen(null)`,
`get_popup(null, …)`, `get_layer_surface(…, null, …)`), which
`nullable.js` encodes around until the fork accepts `allow-null`.

## The transports, and Node

Descriptors are the protocol: the keymap, shm pools and clipboard pipes all
arrive as fds, and Node's sockets abort on them
([nodejs/node#53391](https://github.com/nodejs/node/issues/53391), closed).

- **`x11-dri` `UnixSocket`** (>= 0.9): a `uv_poll` over an `AF_UNIX` socket,
  `recvmsg`/`sendmsg` with `SCM_RIGHTS`, no thread. Works on Node. Two
  things it had to get right that a first version did not: N-API values made
  from a libuv callback need a handle scope, and callbacks from the loop must
  go through `napi_make_callback` — `napi_call_function` from there runs the
  callback but never drains the promise-job queue, so a client awaiting its
  first reply hangs until an unrelated timer turns the loop. `pipe()`,
  `socketpair()` and `memfdCreate()` came with it.
- **node-x11's `fdpass-bun.js`**: `bun:ffi` to libc, with a reader thread.
  Bun only. Bun _exports_ libuv's symbol names but several are stubs that
  abort the process (`uv_poll_init` among them), so the native socket is
  never attempted under Bun; there is nothing to probe for safely.

## What is left

- **`<glarea>` on the backing target.** Raw GL content that binds
  framebuffer 0 draws at the swapchain, not the target. Wants the
  `bindFramebuffer(null)` redirection x11-dri's Apple targets already do.
- **Antialiased paths.** Stencil-then-cover is aliased. A multisampled
  target with a resolve blit is a few lines (`renderbufferStorageMultisample`
  is there); virgl reports `MAX_SAMPLES` of 1, so it could not be measured
  here.
- **Non-rectangular clips** fall back to the bounding box
  (`ctx.clipApproximations` counts them). A stencil clip layer is the fix.
- **Drag-and-drop.** The data device is bound and the clipboard uses it;
  the DnD half (`wl_data_device.start_drag`, enter/motion/drop) is not
  wired to `dnd.js`.
- **Text input v3.** IME composition goes through `compose.js`'s dead-key
  tables; `zwp_text_input_v3` would give real preedit.
- **Touch and tablet.** The seat handles pointer and keyboard only.
- **Screens.** `wl_output` geometry and names are not fed into
  `screens.js`; `availableArea` answers null (no limit) rather than the
  work area. The screen capture binds one output on its own for now.
- **`fillText` only sees the first font family** of a `font` shorthand and
  strokes text as a fill.
- **`ext-image-copy-capture`** is implemented to the protocol text but has
  not run against a compositor: sway 1.10 advertises only wlr-screencopy,
  and GNOME neither. wlroots 0.19 (sway 1.11) is where to try it.
- **Publishing.** The fork of `wayland-client` (fd support, `$`) and x11-dri
  0.9 (`UnixSocket`) are local checkouts; react-x11 consumes both through
  `node_modules` symlinks that an `npm install` prunes:
  ```bash
  ln -sfn /home/andrey/wayland      node_modules/wayland-client
  ln -sfn /home/andrey/node-x11-dri node_modules/x11-dri
  ```

## Things that are gone, not missing

Window managers (`examples/wm.jsx`), global grabs, reading other windows,
screen coordinates, `GetImage`, XEmbed/`<foreign>`, and `ssh -X` are
compositor-private by design. Panels and docks are `layer-shell`, and a
screen read is `screencopy` — both wlroots and KDE, neither GNOME, where the
same JSX is a toplevel and the same pick is the portal's.

## Changes outside `src/wayland/`

- `src/Reconciler.js` — a `'wayland'` rung in `resolveBackend()`. Additive;
  `'auto'` never selects it.
- `src/nodes/boxpaint.js` — prefers `ctx.fillShadow` when a context has it.
- `src/screencolor.js` — rung 3 of the eyedropper's ladder, the Wayland
  backend's own picker, guarded by `app.backend === 'wayland'`; and the
  portal's `parent_window` handle is left empty on that backend, where an
  X window id would be a lie.
- `wayland-client` (fork) — fd send/receive, the `$` synchronous request
  namespace, and callback requests returning their `done` payload. 229
  tests pass.
- `x11-dri` — `UnixSocket`, `pipe`, `socketpair`, `memfdCreate`; a
  self-test that passes a real descriptor through a socketpair.
