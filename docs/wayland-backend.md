# The Wayland backend

**Status: a working backend, opt-in.** react-x11's own reconciler renders a
window on a real Wayland compositor (mutter/GNOME) with client-side
decorations, text, shadows, paths, images, live partial repaints, pointer and
keyboard input decoded against the compositor's keymap, a clipboard, and
popups — drawn on the GPU and handed over as dma-buf, on **Node or Bun**, with
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

## What runs

| piece                | file               | what it does                                                        |
| -------------------- | ------------------ | ------------------------------------------------------------------- |
| connection           | `connection.js`    | fd-capable transport (native or bun:ffi), vendored protocol JSON    |
| shell                | `window.js`        | xdg toplevels and popups, deferred `ack_configure`, fractional scale |
| GPU presentation     | `swapchain.js`, `dmabuf.js`, `glcontext.js`, `target.js` | backing target → per-buffer damage → dma-buf |
| 2d context           | `context2d.js`, `glyphatlas.js` | rects/rounded rects (SDF), paths (stencil), gradients, images, text |
| input                | `seat.js`, `xkb.js`, `keysymnames.js`, `input.js` | pointer frames, keymap parsing, key repeat, routing |
| decorations          | `decorations.js`   | titlebar, borders, resize edges, buttons — CSD for GNOME            |
| offscreen surfaces   | `surface.js`       | the paint cache and scroll blits, over a render target              |
| clipboard            | `clipboard.js`, `fdutil.js` | `wl_data_device` + primary selection, over pipes          |
| the app              | `app.js`, `backendwindow.js` | what `createRoot({ backend: 'wayland' })` renders through |
| tests                | `test/wayland/`    | an in-process compositor, and the pure parts                        |

## What was measured

Everything below was run on this machine (mutter, virtio-gpu/virgl over an
Apple M1 Pro host, 2488×1668 @ 75Hz). Numbers from a VM's GPU are the VM's;
the protocol numbers are not.

### The protocol layer is not the cost

Asked first, because it decides whether a native protocol bridge is
justified. Measured with `wayland-client` (the fork), per request and per
event:

| measure                               | Bun            | Node (native socket) |
| ------------------------------------- | -------------- | -------------------- |
| encode + write, async API             | 0.32 M req/s   | 0.20 M req/s         |
| encode + write, `$` synchronous API   | 0.49 M req/s   | **0.67 M req/s** (1.5 µs) |
| decode + dispatch                     | 2.3 M ev/s     | **3.0 M ev/s** (0.33 µs) |
| round trip `sync` → `done`, plain socket | 0.141 ms p50 | 0.119 ms p50         |
| round trip, fd-capable socket         | 0.178 ms p50 (reader thread) | **0.097 ms p50** |

A frame issues a handful of requests and input peaks near a thousand events
a second: the JavaScript protocol layer is one to two orders of magnitude
below anything visible. **No native protocol bridge was built, on purpose.**
The one native piece is the socket itself, and only because Node cannot
receive descriptors at all; its round trip turned out lower than Node's own
`net.Socket`'s, and the thread-hop cost of the Bun transport (~37 µs) is real
but not worth acting on.

### Where a frame goes

| phase                                    | p50      |
| ---------------------------------------- | -------- |
| `makeCurrent`                            | 0.04 ms  |
| draw                                     | 0.05 ms  |
| Wayland (attach / damage / commit)       | 0.09 ms  |
| **`Surface.swap()`**                     | 24.5 ms  |

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
comes round. GBM names the buffer only *after* the swap, so the copy uses the
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
  Bun only. Bun *exports* libuv's symbol names but several are stubs that
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
  work area.
- **`fillText` only sees the first font family** of a `font` shorthand and
  strokes text as a fill.
- **Server-side decorations** where a compositor offers `xdg-decoration`
  (KDE, wlroots) could replace the client-side frame; GNOME does not.
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
compositor-private by design. Panels and docks want `layer-shell`, which
GNOME does not advertise.

## Changes outside `src/wayland/`

- `src/Reconciler.js` — a `'wayland'` rung in `resolveBackend()`. Additive;
  `'auto'` never selects it.
- `src/nodes/boxpaint.js` — prefers `ctx.fillShadow` when a context has it.
- `wayland-client` (fork) — fd send/receive, the `$` synchronous request
  namespace, and callback requests returning their `done` payload. 229
  tests pass.
- `x11-dri` — `UnixSocket`, `pipe`, `socketpair`, `memfdCreate`; a
  self-test that passes a real descriptor through a socketpair.
