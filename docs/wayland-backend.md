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

| piece              | file                                                     | what it does                                                                                      |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| connection         | `connection.js`                                          | fd-capable transport (native or bun:ffi), vendored protocol JSON                                  |
| shell              | `window.js`                                              | xdg toplevels and popups, deferred `ack_configure`, fractional scale                              |
| GPU presentation   | `swapchain.js`, `dmabuf.js`, `glcontext.js`, `target.js` | backing target → per-buffer damage → dma-buf                                                      |
| 2d context         | `context2d.js`, `glyphatlas.js`                          | rects/rounded rects (SDF), paths (coverage masks, stencil), exact clips, gradients, images, text  |
| `<glarea>`         | `glarea.js`                                              | a rect of the window's backing target as the area's GL surface; composited panes for its children |
| input              | `seat.js`, `xkb.js`, `keysymnames.js`, `input.js`        | pointer frames, keymap parsing, key repeat, routing                                               |
| touch and tablet   | `touch.js`, `tablet.js`                                  | `wl_touch` and `zwp_tablet_v2`, emulating the pointer; raw touches                                |
| decorations        | `decorations.js`                                         | titlebar, borders, resize edges, buttons — CSD for GNOME                                          |
| offscreen surfaces | `surface.js`                                             | the paint cache and scroll blits, over a render target                                            |
| clipboard          | `clipboard.js`, `fdutil.js`                              | `wl_data_device` + primary selection, over pipes                                                  |
| screens            | `outputs.js`                                             | `wl_output` + xdg_output into `screens.js`: `useScreens()`, the cap                               |
| input methods      | `textinput.js`                                           | `zwp_text_input_v3`: the compositor's IME into the composition events                             |
| the app            | `app.js`, `backendwindow.js`                             | what `createRoot({ backend: 'wayland' })` renders through                                         |
| tests              | `test/wayland/`                                          | an in-process compositor, and the pure parts                                                      |

### Running the examples

Every example runs on this backend the way it runs on X11, with the display
taken away so nothing can fall back:

```bash
env -u DISPLAY REACT_X11_BACKEND=wayland bun examples/widgets.jsx   # or node --import tsx
```

Two are X11 by nature and say so: `examples/wm.jsx` is a window manager and
`examples/xeyes.jsx` reads the root window's pointer — neither has a
Wayland counterpart. `examples/viewer3d.jsx` runs but draws its model only
through indirect GLX (it is fixed-function GL by design) and shows its own
note here, as it does under `glPolicy: 'direct'` on X11.

Two environment variables help when a desktop offers no screenshot API:
`REACT_X11_WAYLAND_TRACE=1` writes a line per presented frame, and
`REACT_X11_WAYLAND_SNAPSHOT=/tmp/frame.png` writes the backing target of
the first window at its 30th present (`REACT_X11_WAYLAND_SNAPSHOT_AT`
changes which) — the pixels the compositor was handed, read back from the
GPU.

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

**The input method is told at the end of the frame.** `zwp_text_input_v3`
wants to know which field has focus, what kind of text it holds, where its
caret is and what surrounds it, and every one of those changes repaints the
field — so the backend window calls `textInput.sync()` once per frame after
the renderer has painted, when the layout is current, and only what changed
since the last commit is sent. There is no hook into the event manager and
nothing per field. What comes back — `preedit_string`, `commit_string`,
`delete_surrounding_text`, applied together on `done` in the order the spec
fixes — lands on the same `CompositionStart/Update/End` a dead key raises,
so `<textinput>` and an application's `onCompositionUpdate` cannot tell IBus
from `compose.js`. Keys the IME consumes never reach `wl_keyboard.key`, so
key delivery is untouched; a key that arrives is one the IME declined, and
the client-side composer has its usual go at it. A `sensitive` field offers
no surrounding text and says `sensitive_data`; `inputMode` on a
`<textinput>` becomes the content purpose (`email`, `url`, `tel`, …).

**A finger and a pen are the pointer.** On X11 a tablet is an XI2 slave of
the master pointer and a touch emulates it, so every control in the tree is
written against `mousedown`/`mousemove`/`mouseup` and nothing else. The
Wayland seat keeps `wl_touch` and the tablet tools as devices of their own,
so `touch.js` and `tablet.js` make them the pointer here: the first finger
of a gesture and a tool in proximity emit the seat's own `enter`/`motion`/
`buttonpress`/`buttonrelease`/`leave`, carrying the touch `down` or tool
`down` serial (what `xdg_toplevel.move` wants when the press lands on the
titlebar), and `input.js` routes them through exactly the path the mouse
takes — frame hit-testing, popup grabs, the cursor, which a tool in
proximity follows through cursor-shape's tablet device. The emulated events
alone carry `pointerType` (`'touch'`, `'pen'`, `'eraser'`, `'mouse'`),
`pressure`, `tiltX`/`tiltY`, `rotation`, `distance` and
`tangentialPressure` in the DOM's names and ranges, so a mouse event is
unchanged and the X11 backend never sees a field it did not send. A second
finger emulates nothing; every finger also arrives raw on the window as
`touchstart`/`touchmove`/`touchend`/`touchcancel` — ntk's XI2 names, with
its `touchId` — each with the active `touches`, batched at `wl_touch.frame`.
Barrel buttons map as the desktop does: BTN_STYLUS is button 3, BTN_STYLUS2
button 2; `proximity_out` releases whatever is still held.

**`createWindow` is synchronous.** React's commit phase cannot await, and
that is where windows are realised. Nothing about Wayland needs the
asynchrony — a request is one-way and the client allocates ids — so the
library grew a synchronous namespace (`Wl_interface.$`) and the only
genuinely asynchronous step, binding globals, happens once in `open()`.

**The monitors are a fold over the registry.** Each `wl_output` is its own
global, so `outputs.js` binds every one (through a second `wl_registry`,
because the library files globals by interface name and keeps one) and
publishes the layout into `screens.js` the way the cocoa backend does:
names from `wl_output.name` (`DP-1`, `eDP-1`), logical rects from
xdg_output where the compositor has it and from the mode over the scale
where it does not, converted to the renderer's device pixels at
`app.scale`. Hot-plug is `global`/`global_remove` on that registry. Two
things the protocol does not have are stood in for: a **primary** (the
output at the origin), and a **work area** — `xdg_toplevel.configure_bounds`
is the monitor less its panels, sent to a window ahead of its configure, so
a window's bounds become the usable rect of the output it has entered, and
every monitor carries its own rect so no head is clamped by another's. The
densest output also seeds `app.scale` before the first window exists, which
is the difference between a first layout at 2x and one corrected a frame
later; and where a compositor offers neither fractional-scale-v1 nor
`preferred_buffer_scale`, a surface's buffer scale is that of the output it
entered.

**A `<glarea>` is a rectangle of the backing target.** On X11 it is a child
window and on macOS a sublayer; a subsurface here would be a second
swapchain, a second frame clock and a second dma-buf import per frame for
what is already one GL context drawing into one target. So `glarea.js`
hands the area the shared GLES table with `viewport`, `scissor` and
`bindFramebuffer(null)` re-based on its rect (the Cocoa backend's own
trick, prototype-delegated), and the frame loop orders the three layers:
the tree's 2D is flushed under, the area draws over, and the panes its
children were painted on — offscreen targets, `createOverlayPane` — are
blended over that, translucent. One thing a shared target needs that a
child window never did: when the tree repaints under a static scene, the
scene is asked for its frame before the present, so the background never
shows through for a frame.

**Paths are antialiased on the CPU, and clips are exact on the stencil.**
A solid fill that fits the budget (512×512 after cutting to the clip) goes
through ntk's analytic coverage rasteriser — the same pixels the X11
backend's local raster and every glyph get — into a per-frame mask atlas,
drawn like a glyph; gradients and bigger shapes stay on stencil-then-cover.
`clip()` with anything but one axis-aligned rectangle sets bit 7 of the
stencil where the shape is (the low seven bits stay the winding count) and
every batch under it tests that bit; nested clips intersect in place,
`restore()` re-renders the restored list. The scissor still narrows to the
bounds, so the test is only paid inside them. `test/wayland/context2d-gpu.test.js`
reads the pixels back on any machine with a render node.

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

- **Multisampling.** Stencil-then-cover (gradients, shapes past the CPU
  budget) and stencil clips are aliased at the edge. MSAA is the fix, and it
  is not the few lines it looks like: GLES 3.0 cannot `blitFramebuffer`
  _into_ a multisampled framebuffer, so the scroll blits and the partial
  repaints the backing target exists for would have to be re-expressed as
  textured draws, and every read of the target (a present, `getImageData`,
  a `drawImage` of a surface) as a resolve first. virgl here reports
  `MAX_SAMPLES` of 1, so none of it could be validated; it waits for a
  machine that can run it.
- **`<Frame>` panes.** The out-of-process pane path (`createPaneHost`) is
  macOS-only today — the pane presents an IOSurface id. Linux wants the same
  over a memfd or dma-buf fd on the pane channel; until then `<Frame>` here
  degrades the way it does without embedding.
- **Bun's fd transport, upstream.** node-x11's `fdpass-bun.js` gave up on a
  healthy socket when Bun's GC interrupted its `poll(2)` sixty-four times
  in a row (EINTR is a retry, not a failure); the fix is applied to the
  installed copy here and prepared for node-x11. Until it ships, an
  `npm install` brings the bug back under Bun (Node's native transport is
  unaffected).
- **Drag-and-drop.** The data device is bound and the clipboard uses it;
  the DnD half (`wl_data_device.start_drag`, enter/motion/drop) is not
  wired to `dnd.js`.
- **Input methods, the rest of it.** The preedit's cursor is drawn (a
  heavier underline under the segment being converted) but nothing is done
  with a hidden cursor beyond putting the caret at the end, and the only
  content hints sent are `multiline` and `sensitive_data` — no
  `spellcheck`/`auto_capitalization`, which the tree has no notion of.
- **Tablet pads.** The buttons, rings and strips on the tablet itself
  (`zwp_tablet_pad_v2`) are accepted and ignored: the tree has no vocabulary
  for them. Hiding a tool's cursor (`cursor: 'none'`) wants a null surface in
  `set_cursor`, which the client library's argument check refuses today, so
  the last shape stays; the pointer's own `'none'` has the same gap.
- **`useScreens().source` reads `'test'`**, as it does on macOS: both
  backends publish through `setScreensForTests`, the one seam `screens.js`
  has, and it stamps the source. A `source` argument on it is the fix.
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
- `src/nodes/preedit.js` — the composition may carry a cursor
  (`cursorBegin`/`cursorEnd` on the composition event); without one the
  caret is at the end of the preedit, as before. `src/events.js` —
  `_composition` passes those extra fields through. Additive on both
  backends.
- `wayland-client` (fork) — fd send/receive, the `$` synchronous request
  namespace, and callback requests returning their `done` payload. 229
  tests pass.
- `x11-dri` — `UnixSocket`, `pipe`, `socketpair`, `memfdCreate`; a
  self-test that passes a real descriptor through a socketpair.
