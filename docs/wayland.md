# A native Wayland backend

**Status: research RFC.** No code. Written 2026-08 against react-x11 2.2.1,
ntk 8.7.0, node-x11 4.1.0, x11-dri 0.6.0; the line counts and library
versions below are measurements from that date, not estimates. Two upstream
issues were filed from this research
([x11-dri#19](https://github.com/sidorares/node-x11-dri/issues/19),
[x11-dri#20](https://github.com/sidorares/node-x11-dri/issues/20)) and one
upstream capability landed just before it
([node-x11#290](https://github.com/sidorares/node-x11/pull/290)).

## What this is, and is not

This is a plan for a **second backend, not a migration**. X11 stays a
first-class target: the remote case ([remote.md](remote.md)) is the
flagship reason this project exists, old X11-only systems stay supported,
and nothing below proposes touching how the X11 path works. The question
this document answers is what it would take to run the same React tree
natively on a Wayland compositor — no Xwayland in the picture — on the
systems where that is the better experience.

The goals that shape every choice here are the project's standing ones:

- **a small, portable codebase** — no compiled dependencies where possible;
  a native module is admissible where a runtime leaves no other way to
  reach a required OS facility, or where a hot path is significantly faster
  compiled and the pure path remains as fallback;
- **the whole range of desktop UI** — full applications, small utilities,
  tray tools, panels and desktop-integration services, window managers;
- **the best experience available per system** — perceived performance
  first (input-to-photon), then stability, then client CPU and memory.

One goal meets a hard wall immediately and it is better to say so up top:
**a window manager cannot be a Wayland client.** Compositing, stacking and
input routing are the compositor's own body, not a role a client can take.
`examples/wm.jsx` and the window-management half of the API remain X11-only
under this plan; the shell-adjacent use cases that _can_ be served
client-side (panels, docks, launchers, lock screens, tray tools) map to
their own protocols and are covered below. Being the compositor — a
react-x11 embedded in a wlroots- or Smithay-class host — is a different
project and out of scope here.

## What Wayland actually changes

Wayland's wire protocol is a **control plane**. Objects, requests, events;
interfaces defined in XML; two 32-bit words of header and 32-bit-aligned
arguments in host byte order
([the spec](https://wayland.freedesktop.org/docs/book/Protocol.html), and
[wayland-book.com](https://wayland-book.com/) as the readable tour). What it
does not carry — ever, not just at setup — is drawing. There is no
`PolyFillRectangle`, no RENDER `Composite`, no `PutImage`. A client hands
the compositor **finished pixels** by reference: a `wl_buffer` naming
either shared memory (`wl_shm`) or a GPU buffer
([linux-dmabuf](https://wayland.app/protocols/linux-dmabuf-v1)), attached
to a surface, damaged, committed. Surface state is double-buffered and
atomic — everything set since the last `commit` applies in one step.

That deletes the premise of ntk's rendering layer. It is tempting to read
this codebase as "canvas-like drawing code that happens to target X11", and
most planning mistakes would start there. ntk's 2d context is an **XRender
encoder**: fills are server-side trapezoids or rectangles, gradients are
`CreateLinearGradient` objects, text is `CompositeGlyphs` against a
server-resident glyph cache, `drawImage` is a `Composite`, and a `Surface`
is a pixmap+picture pair. The server rasterizes and composites; the client
describes. On Wayland the client rasterizes and composites, full stop —
which is why the largest workstream below is a renderer, not a protocol.

The other structural inversion: on X11 the client asks and the server
answers (`GetGeometry`, `QueryPointer`, properties); requests take effect
as issued. On Wayland the client **requests and the compositor decides**,
answering with `configure` events the client must ack. A window does not
know its own screen position, cannot place itself in globals, and cannot
read other windows. Several react-x11 features live or die on that line —
the inventory is below.

Two things get simpler, and they are not small:

- **Frame pacing.** ntk earns its frame clock the hard way — Present
  completions, a fence fallback, a quantile estimator over completion
  history to guess the refresh rate. Wayland hands the same thing over
  directly: `wl_surface.frame` callbacks say "now is a good time to draw",
  and [presentation-time](https://wayland.app/protocols/presentation-time)
  reports when a committed frame actually reached the screen, with clock
  id, refresh interval and flags. For a project whose stated first goal is
  input-to-photon, this is the first target where **photon time is
  observable**, not inferred.
- **Scale.** The four-generation ladder in [scale.md](scale.md) —
  environment, XSETTINGS, `Xft.dpi`, RandR-millimetre audit — collapses to
  `wl_output.scale` plus
  [fractional-scale-v1](https://wayland.app/protocols/fractional-scale-v1)
  with [viewporter](https://wayland.app/protocols/viewporter): authoritative,
  per-output, and live.

## What already carries over

Measured against 2.2.1 (`src/`, excluding `.d.ts`):

| slice                                                                                                                                                         | lines   | Wayland fate                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------- |
| portable core — reconciler, yoga, styles/decorations parsing, palette, a11y tree + AT-SPI, keysym tables, compose, text selection model, D-Bus stack, anchors | ~16,200 | unchanged                                 |
| `components/` + `frame/` + `refresh/`                                                                                                                         | ~8,700  | unchanged (`<Frame>`'s host seam changes) |
| X-touching modules                                                                                                                                            | ~23,400 | see below                                 |

The 23,400 overstates the rewrite. `nodes.js` is 11,515 lines of which only
`WindowNode` + `PopupNode` (~3,100) speak X — `BoxNode`, `TextNode`,
`ImageNode`, `CanvasNode`, `TextInputNode` and the layout/paint/hit-test
machinery drive a 2d context and never name the display system. The honest
rewrite surface is **~9–10k lines**: window realize/present, `events.js`,
`dnd.js`, `clipboard.js`, `screens.js`, `windowstate.js`, `scale.js`,
`keyboardstate.js`, `compositing.js`, `inputtime.js`, `startup.js`.

On the ntk side the split is starker. The portable half of a renderer
**already exists** there, built for the local-raster path and for glyphs:

- `rasterize.js` — analytic coverage accumulation (the font-rs algorithm),
  outlines/polygons in, A8 out;
- `path.js` — Path2D, flattening, stroking, transforms;
- `shadow.js` — `blurCoverage`, separable gaussian, baked once;
- `text/` — fontkit faces, shaping, bidi, line breaking, layout — the
  entire text stack short of the final composite;
- `fontconfig.js`, `imagedata.js` (premultiply/unpremultiply, pixel
  layouts), `color.js`, `region.js`.

What does not exist is the piece XRender was doing: the **span
compositor** — A8 coverage × paint source → premultiplied ARGB with
Porter-Duff, clipping, gradient evaluation, transformed image sampling —
and a client-side **glyph atlas** where the server-side `GlyphSet` used to
be. That is the gap, whatever tier below fills it.

Desktop integration is the pleasant surprise: it was built D-Bus- and
portal-first, X as a fallback rung ([dbus.md](dbus.md),
[filedialog.md](filedialog.md), [appearance.md](appearance.md),
[eyedropper.md](eyedropper.md), [globalmenu.md](globalmenu.md), AT-SPI in
[accessibility.md](accessibility.md)). On Wayland those modules mostly
_lose a rung_ rather than gain one. The X-only integration channels
(`xsettings.js`, startup-notification's X path, the eyedropper's crosshair
grab) simply end at the ladder's portal rung.

## The transport: file descriptors, both ways

Everything in Wayland that moves bulk data moves a descriptor: the
compositor sends every client its keymap **as an fd**; `wl_shm` pools go
over as fds; clipboard and drag-and-drop hand the receiving side a pipe fd
and stream content through it. Descriptors ride SCM_RIGHTS ancillary data,
matched to `fd`-typed arguments **by order, not by message** — the spec is
blunt that "any byte of the stream, even the message header, may carry the
ancillary data". A transport that cannot receive descriptors is not a
limited Wayland client; it is not a Wayland client.

Where the runtimes stand:

| runtime    | send fds                                                     | receive fds                                                         | verdict                       |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------- |
| Node       | yes — node-x11's `fdpass.js` via `process.binding` internals | **no** — an arriving fd on a libuv-read socket aborts the process   | needs a small native module   |
| Bun        | yes — `bun:ffi` → `sendmsg(2)` (node-x11 4.1.0)              | **yes** — `bun:ffi` → `recvmsg(2)` + a poll thread (node-x11 4.1.0) | works today, pure JS + dlopen |
| Node+addon | yes                                                          | yes — an addon owning the socket end to end (~200 lines of C)       | the eventual portable answer  |

Node upstream is not coming:
[nodejs/node#53391](https://github.com/nodejs/node/issues/53391) — filed
specifically for Wayland — is closed "not planned". Bun landed in
[node-x11#290](https://github.com/sidorares/node-x11/pull/290)
(`lib/fdpass-bun.js`, 884 lines): `dlopen` of libc, no compiler and no
headers, two transports. The default keeps Bun's own socket and adds
`sendFds()`; `receiveFds: true` owns the descriptor end to end — `recvmsg`
on the main thread, readiness from a worker blocked in `poll(2)` — because
Bun's reader silently drops ancillary data it did not ask for. Three
properties make it a Wayland transport with zero changes: it connects to
**any** unix path, it is `net.Socket`-shaped with real backpressure, and
its ownership contract (sent fds consumed; received fds owned by the caller
once taken) is the one Wayland's object model wants.

**Decision: prototype on Bun.** It is the only runtime where the whole
stack stays JS-plus-dlopen today. The Node fallback is not abandoned — it
is a bounded ~200-line native module that owns one socket, and `x11-dri`
already exists as a home for exactly this kind of gap-filler — but it is
not on the critical path, and building Bun-first keeps the prototype free
of a compile step. This matches the portability goal's own exception
clause: a compiled module is admissible where the runtime leaves no other
option, and on Node it does.

## The protocol layer: mostly already written

Prior art, surveyed 2026-08:

- **[node-wayland-client](https://github.com/sdumetz/node-wayland-client)**
  (npm `wayland-client` 3.0.0, Apache-2.0, active — last commit 2026-06).
  Pure TS, zero runtime dependencies; parses `wayland.xml` (or precompiled
  JSON) and generates typed proxies. The core is **~1,270 lines** —
  `display.ts` 382, `interface.ts` 257, `args.ts` 231 — with ~2,350 lines
  of tests. The socket is injected through the constructor, the `fd`
  argument type is already encoded in all three codec paths, and the one
  missing piece is a single guard: a request whose signature contains an
  `fd` throws `"sending ancillary data not supported"`. The README asks
  for exactly the contribution this project would make.
- **[westfield](https://github.com/udevbe/westfield)** /
  [Greenfield](https://github.com/udevbe/greenfield) — a full Wayland
  **server** in TypeScript for a browser-hosted compositor. Wrong
  direction, but proof the wire level is comfortable in JS, and its XML
  codegen is worth reading.
- Everything else (2013-era `node-wayland` bindings to libwayland) is dead.

So the layer is either **adopt `wayland-client` and contribute the fd
path** (a few hundred lines against node-x11's Bun transport), or write an
in-house equivalent in node-x11's idiom (~1.5–2.5k lines plus codegen).
Adopt-first is the default; the fork-shaped risk — the project is one
person's — is mitigated by its size: this is a library we could absorb,
not a dependency we would be stuck on. Either way the per-protocol cost
after that is ~zero, because every interface is generated from XML.

The shopping list, mapped to what each protocol replaces here:

| protocol                                                                   | stands in for                                                     |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| core (`wl_compositor`, `wl_shm`, `wl_seat`, `wl_output`, `wl_data_device`) | connection, buffers, input, screens, clipboard/DnD                |
| [xdg-shell](https://wayland.app/protocols/xdg-shell)                       | `WM_*`/EWMH window lifecycle, `<popup>` placement                 |
| xdg-decoration                                                             | asking for server-side decorations (often refused)                |
| [linux-dmabuf](https://wayland.app/protocols/linux-dmabuf-v1)              | the GPU tier's buffer handoff                                     |
| fractional-scale-v1 + viewporter                                           | the whole of `scale.js`'s ladder                                  |
| [presentation-time](https://wayland.app/protocols/presentation-time)       | Present completions; adds real photon timestamps                  |
| cursor-shape-v1                                                            | server-side cursor names                                          |
| primary-selection                                                          | the PRIMARY half of [clipboard.md](clipboard.md)                  |
| xdg-activation                                                             | `_NET_ACTIVE_WINDOW` + startup notification's focus half          |
| [layer-shell](https://wayland.app/protocols/wlr-layer-shell-unstable-v1)   | `_NET_WM_STRUT_PARTIAL` — panels/docks (wlroots + KDE; not GNOME) |
| ext-session-lock, ext-idle-notify                                          | lock screens; `useIdle()`                                         |
| text-input-v3                                                              | the input-method story `compose.js` approximates                  |

## Rendering: the tiers

First, what the field does — because "software rendering on Wayland" is
sometimes assumed to be a second-class citizen, and it is not:

| toolkit                  | rasterizer                                                                                                                    | handoff    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------- |
| QtWidgets                | CPU raster engine                                                                                                             | `wl_shm`   |
| GTK4                     | GSK — cairo (CPU), GL, Vulkan; [Vulkan default on Wayland since 4.16](https://blog.gtk.org/2024/01/28/new-renderers-for-gtk/) | either     |
| foot, most wlroots tools | pixman (CPU)                                                                                                                  | `wl_shm`   |
| Firefox                  | WebRender (GPU), software WebRender fallback                                                                                  | dmabuf/shm |

CPU-to-shm is mainstream, and the one systemic cost it had — the
compositor's copy to GPU-visible memory — was addressed on the compositor
side in 2026:
[KWin 6.7 imports page-aligned shm buffers as udmabufs](https://zamundaaa.github.io/wayland/2026/05/06/making-wl-shm-fast.html)
and samples them directly, taking KWin from 80–90% of a core to ~20% while
a CPU-rendered app scrolls. The client's whole obligation is page-aligned
pool allocations and GPU-friendly strides (~256-byte multiples; ≈1.6%
padding at 4K). Any pool we write complies from day one.

Also load-bearing for everything below: `wl_shm` +
`wl_surface.damage_buffer` preserves ntk's **dirty-rectangle model
verbatim** — paint the damaged rects into the mapped buffer, report
exactly those rects, commit. The entire performance architecture
(`MAX_DIRTY_RECTS`, scroll blits as `memmove`, the paint cache) transfers
without redesign. A GPU swapchain does _not_ preserve it — buffers rotate,
so damage must be tracked per buffer age or the frame fully redrawn — which
is half the argument for the tier ordering below.

### Tier A — our own span compositor, pure JS

Extend what ntk already has (coverage rasterizer, paths, shadows, text
shaping) with the missing span compositor and a client glyph atlas, and
register it as a sibling 2d context. The seam already exists and is the
whole reason this is tractable: every context registers in
`Drawable.renderingContextFactory` (`'2d'`, `'x11'`, `'opengl'`, `'gles'`,
`'cgl'` today), and `nodes.js` asks for a context by name and never looks
behind it.

- **Portability: perfect.** JS + typed arrays; runs everywhere including
  the in-process test server.
- **Performance: the open question, but a bounded one.** A widget UI
  repaints small dirty regions; the analytic rasterizer measures ~25µs for
  a 20px icon; glyphs come out of an atlas as `memcpy`+blend. The risk is
  large-area work — full-window gradients, big images under transform —
  where JS with no SIMD pays. Mitigations exist per-hot-path (see tiers
  below); the floor is validated by every pixman-based tool on the desktop.
- **Why it is first anyway:** it can be built and shipped **on the X11
  backend first** as `getContext('2d-sw')`, diffed against XRender output
  with the existing pixel-hash gates and benches — a reference
  implementation and a working test harness on day one, no Wayland in the
  loop. It also answers standing X11 wants: rendering where RENDER is poor
  or absent, and one day feeding DRI3/Present directly.

### Tier B — a Wasm rasterizer

[CanvasKit](https://skia.org/docs/user/modules/canvaskit/) (Skia compiled
to Wasm, full `CanvasRenderingContext2D`) or
[tiny-skia](https://github.com/linebender/tiny-skia) behind a thin binding.
No native toolchain — Wasm loads everywhere — so this **respects the
portability rule** while buying SIMD and two decades of Skia's raster
tuning.

The catch is not speed but scope: adopting Skia's canvas means adopting
Skia's text, fonts and geometry, displacing ntk's own text stack — the
part of this codebase most worth keeping. The honest use of this tier is
narrower: **a span-filling kernel behind Tier A's API** (tiny-skia fits;
CanvasKit does not slice that thin), swapped in per-context where
profiling says the JS compositor is the bottleneck. Same API, same tests,
a hot-path exception exactly as the goals allow.

### Tier C — a native 2d library

[skia-canvas](https://github.com/samizdatco/skia-canvas) ships prebuilt
Skia with GPU raster and the canvas API; published comparisons put
CanvasKit ~25× behind it on some workloads (numbers to re-measure on ours,
not to inherit). This is the "just works, fastest today" tier and a
legitimate prototyping shortcut — the RFC's own preference for a compile
step over a blocked prototype applies. It is not the destination: a
multi-megabyte native dependency for every app contradicts the packaging
story, and its GPU path duplicates Tier D with less control. If used, it
hides behind the same `renderingContextFactory` name so nothing above the
seam knows.

### Tier D — our own accelerated 2d over x11-dri

The addon misnamed by history: `x11-dri`'s `Gpu` is **GBM + EGL + GLES on
a DRM render node and never touches X**. Its swapchain output is already
the exact shape the Wayland GPU path consumes —
`surface.swap()` → `{ fd, stride, offset, modifier }` →
`zwp_linux_dmabuf_v1.create_params.add(...)` → `wl_buffer` — and dmabuf
import is fd-**send** only, which even plain Node can do. A
NanoVG-shaped renderer (stencil-then-cover fills, glyphs and gradients as
textures) over the existing `dri.gl` binding gives GPU 2d with the text
stack still ours.

Filed from this research, both small and both blocking this tier:

- [x11-dri#19](https://github.com/sidorares/node-x11-dri/issues/19) — the
  EGL config never asks for stencil bits, while the binding exports the
  full stencil API against it. Stencil-then-cover needs `stencilSize`.
- [x11-dri#20](https://github.com/sidorares/node-x11-dri/issues/20) — no
  in-place resize (a drag-resize rebuilds the swapchain per frame), and
  GEM handle reuse across recreation makes the documented `key`-cache
  pattern silently unsafe. Wants `resize()` + a `generation` counter.

Costs to keep in view: per-buffer damage tracking replaces the shm model's
free dirty rects; a render-node requirement (fall back to Tier A where
there is none — same seam); and it is a compiled dependency, prebuilt for
common platforms, `dlopen`-degrading elsewhere — inside the goals'
exception, but an exception.

**Recommendation:** A first, validated on X11 before Wayland exists; D as
the performance tier sharing all the Wayland plumbing; B as a swappable
kernel inside A if profiling demands it; C at most as a prototype-phase
crutch. All four sit behind one context name, chosen by policy the way the
GL backends already are.

## Windowing semantics: what maps, what bends, what breaks

| react-x11 today                                                        | Wayland                                                                                                          | verdict                                                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `<window>`, WM-managed                                                 | `xdg_toplevel`; states arrive in `configure` and are acked, not set                                              | maps — state model inverts to request/answer                                     |
| `<popup>` (override-redirect, self-placed)                             | `xdg_popup` + `xdg_positioner`: anchor rect, gravity, constraint adjustment; compositor places and dismisses     | maps _better_ — but only for anchored popups                                     |
| `<popup x y>` at screen coordinates                                    | —                                                                                                                | **gone**; no client knows screen coordinates                                     |
| `anchorRect` flip/clamp in `realize()`                                 | the same policy, expressed as positioner flags, executed compositor-side                                         | our one-source-of-truth design survives; the math moves                          |
| decorations (WM frames; `_MOTIF_WM_HINTS`)                             | client-side by default; xdg-decoration is advisory and GNOME declines server-side                                | **new work**: draw and hit-test our own titlebar/borders/resize edges            |
| `windowstate.js` (`_NET_WM_STATE` set)                                 | `set_maximized`/`set_fullscreen`/`set_minimized` + configure states; attention via xdg-activation                | maps; `_NET_WM_DESKTOP`, `ABOVE`, user-time have no equivalents                  |
| struts (panels reserving edges)                                        | layer-shell — wlroots and KDE, **not GNOME**                                                                     | maps with a hole                                                                 |
| frame clock (Present + fence + refresh estimator)                      | `wl_surface.frame` + presentation-time                                                                           | simpler and more honest; photon time becomes measurable                          |
| `keyboardstate.js` (XKB over the wire)                                 | keymap arrives as an fd; interpret with libxkbcommon (`bun:ffi`, ~300 lines) — do not hand-write a keymap parser | maps; `keyboard.js`'s Latin-accelerator resolution survives unchanged above it   |
| clipboard/DnD (selections, INCR, XDND)                                 | `wl_data_device`: offers are pipe fds, content streams                                                           | maps; the INCR machinery dies unmourned; MIME plumbing in `transfer.js` reusable |
| `<foreign>` / `<Frame>` (XEmbed,[embedding.md](embedding.md))          | `wl_subsurface` is same-client; xdg-foreign is parenting, not embedding                                          | **gone by design**; `<Frame>` becomes a parented toplevel or an in-process pane  |
| `examples/wm.jsx`, window lists, global grabs, `GetImage` screen reads | compositor-private                                                                                               | **gone by design**; portals cover capture with consent                           |
| eyedropper X rung                                                      | portal `PickColor` rung already first                                                                            | loses the fallback rung only                                                     |
| `ssh -X` remoting ([remote.md](remote.md))                             | no network transparency; [waypipe](https://gitlab.freedesktop.org/mstoeckl/waypipe) proxies fds over ssh         | X11 backend remains the remote answer                                            |
| tray                                                                   | StatusNotifierItem was always D-Bus                                                                              | unchanged                                                                        |

The one to sit with is the popup row: `anchor.js` exists because a
`<popup>` must place itself with no round trip available, flipping and
clamping against screen geometry the client had to learn. Wayland's
positioner is that exact policy as protocol — a cleaner home for the
intent, and the end of the screen-coordinate escape hatch in the same
stroke. The API consequence (some props meaning nothing on one backend) is
an open question below, not something to paper over.

## Testing

The X11 suite's superpower is `x11/lib/xserver` — a 3,828-line pure-JS X
server, in-process, no display. The Wayland twin is **smaller**, because
the hard part of that server is the drawing protocol and Wayland has none:
a mock compositor implements the registry, surface/buffer lifecycle,
`configure` handshakes and seat event injection — and every committed
buffer is **plain memory the test can read**. Pixel assertions stop being
`GetImage` round trips and become array reads; `fireEvent` maps to
injecting seat events; the harness stays "real protocol, zero display",
which is the property worth preserving.

## The plan

Each phase has an exit that makes the next one safe to start.

- **Phase 0 — the spike (days).** Bun + `wayland-client` + node-x11's fd
  transport: bind globals, memfd a page-aligned pool, put a solid-colour
  `xdg_toplevel` on a real compositor, and receive the keymap fd. _Exit:
  fd receive proven end-to-end; adopt-vs-write settled for the protocol
  layer._
- **Phase 1 — software 2d, on X11 (the long pole, start immediately).**
  The span compositor + glyph atlas as `'2d-sw'` behind the factory seam;
  diffed against XRender via the pixel-hash gates; benched against the
  scenarios in `scripts/bench`. _Exit: visual parity on the gates;
  interactive scenarios within an agreed factor of XRender locally._
- **Phase 2 — surface + shell.** `WaylandWindow` beside ntk's `Window`
  (frame clock, damage, backing pool); `WindowNode.realize()` grows a
  second path; configure/ack, CSD drawing, `xdg_popup` placement. _Exit:
  the examples that need no embedding run natively._
- **Phase 3 — input and integration.** Seat events into the synthetic
  event system; xkbcommon keymaps; clipboard/DnD over pipes; scale,
  outputs, activation; the portal-first modules verified with their X
  rungs dark. _Exit: the component test suite green on the mock
  compositor._
- **Phase 4 — the accelerated tier.** The GLES renderer over x11-dri
  (after [#19](https://github.com/sidorares/node-x11-dri/issues/19)/
  [#20](https://github.com/sidorares/node-x11-dri/issues/20)), dmabuf
  handoff, buffer-age damage. _Exit: chosen scenarios beat Tier A on a
  render-node machine; automatic fallback proven._
- **Phase 5 — the payoff.** presentation-time-driven latency measurement;
  input-to-photon on the dashboard; scheduling tuned against real photon
  timestamps. _Exit: the number the project optimizes for, finally
  measured rather than modeled._

## Open questions

1. **API surface.** Is the Wayland backend API-compatible-minus-features
   (same JSX, some props inert, `<foreign>` absent) or a declared subset?
   Current lean: same JSX, loud dev-mode warnings on inert props, feature
   detection à la `app.capabilities`.
2. **Where the code lives.** ntk grows `WaylandWindow` beside `Window`
   behind the same `App`/`Drawable` contracts vs. a sibling package.
   Current lean: inside ntk — the factory seam and the portable raster
   half are already there.
3. **Runtime floor.** Bun-only until when? Current lean: prototype through
   Phase 2 on Bun alone; decide on the Node addon when someone needs it,
   not before.
4. **x11-dri's name.** Its GBM/EGL core is display-server-neutral and this
   plan leans on it twice (GPU tier, and possibly the Node fd/xkb shims).
   Splitting a `dri-core` out is upstream's call; noted here so the
   dependency direction is explicit.
5. **libxkbcommon.** `dlopen` it (compiled, but universally present on
   Wayland systems) vs. a pure-JS keymap interpreter. Current lean:
   dlopen — a keymap parser is the kind of code this project writes well,
   but not before a working backend exists.

## References

- [The Wayland Book](https://wayland-book.com/) — the tour worth reading
  end to end.
- [Protocol and model of operation](https://wayland.freedesktop.org/docs/book/Protocol.html) —
  the wire format, normatively.
- [wayland.app](https://wayland.app/protocols/) — every protocol, browsable;
  start with [xdg-shell](https://wayland.app/protocols/xdg-shell).
- [wayland.xml](https://gitlab.freedesktop.org/wayland/wayland/-/blob/main/protocol/wayland.xml)
  and [wayland-protocols](https://gitlab.freedesktop.org/wayland/wayland-protocols) —
  the codegen inputs.
- [Making wl_shm fast](https://zamundaaa.github.io/wayland/2026/05/06/making-wl-shm-fast.html) —
  the page-alignment contract this plan adopts.
- [node-wayland-client](https://github.com/sdumetz/node-wayland-client),
  [westfield](https://github.com/udevbe/westfield) — prior art.
- [node-x11#290](https://github.com/sidorares/node-x11/pull/290),
  [nodejs/node#53391](https://github.com/nodejs/node/issues/53391) — the
  fd story.
- [x11-dri#19](https://github.com/sidorares/node-x11-dri/issues/19),
  [x11-dri#20](https://github.com/sidorares/node-x11-dri/issues/20) — filed
  from this research.
- [NanoVG](https://github.com/memononen/nanovg) — the GPU-2d shape Tier D
  follows; [CanvasKit](https://skia.org/docs/user/modules/canvaskit/),
  [tiny-skia](https://github.com/linebender/tiny-skia),
  [skia-canvas](https://github.com/samizdatco/skia-canvas) — Tiers B/C.
