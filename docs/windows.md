# A native Windows backend

**Status: research PRD.** No code. Written 2026-09-11 against react-x11
2.11.0 (`13ffb34`) and `@windowkit/appkit` 0.9 — and, unlike
[wayland.md](wayland.md) and [macos.md](macos.md), written **on a Mac**:
nothing below has been run on Windows yet. The line counts are measurements
from that date. Every claim about Windows comes from Microsoft's
documentation or from shipping source code — Chromium, Firefox, Electron,
Flutter, winit, Qt, SDL — and the sources are listed in §References. Where
the sources left a question open it is marked unverified rather than
guessed, and the claims the design leans on hardest are gathered in
§"What to probe first", the checklist for the first session on a Windows
machine.

It started from an architecture brief for "a modern Win32 toolkit
backend": Win32 windows, Direct3D 11 with a flip-model swapchain under
DirectComposition, Direct2D and DirectWrite, `WM_POINTER`, TSF, per-monitor
DPI, UI Automation, OLE. Most of it is right for this project. Some of its
defaults are right for a toolkit that owns its process and wrong for an
addon loaded into someone else's `node.exe`, and one of them — a
`FLIP_DISCARD` swapchain as the window's content — would give up the part
of the architecture this project has spent the most work on. §"The brief,
cross-checked" goes through it point by point.

## What this is, and is not

This is the plan for the **third backend family**, and the step that makes
react-x11 cross-platform rather than a Linux-and-Mac project: X11 and Cocoa
ship, Wayland is researched ([wayland.md](wayland.md)), and this is
Windows. Like both of those it is **a backend beside the others, not a
migration**. X11 stays the remote answer ([remote.md](remote.md)) and the
window-manager story; the Cocoa path is untouched; nothing below changes
how either works — except to lift the pieces of `src/cocoa/` that were
always backend-neutral into a shared home, which macos.md §"The split"
already scheduled for "when a second native backend or Wayland actually
starts".

The goals are the project's standing ones:

- **a small, portable codebase.** Windows is macOS's case of the
  native-module clause, not Wayland's: there is no wire protocol to speak,
  only DLLs and COM interfaces, so the bridge is a compiled addon by
  necessity. What keeps the rule's spirit is what kept it on macOS — the
  addon is **thin and mechanism-only** (§"The bridge");
- **the whole range of desktop UI** the platform permits — applications,
  utilities, tray tools;
- **the best experience available per system** — input-to-photon first,
  then stability, then client CPU and memory.

The walls, up front:

- **A window manager cannot be written.** DWM is the compositor and every
  top-level frame is its body; there is no substructure redirect and no
  reparenting of other programs' frames. `examples/wm.jsx` stays X11.
  (Shell-adjacent tools that move and size other programs' windows — the
  tiling helpers — can be written against `SetWindowPos`, except against
  elevated windows; nothing here plans one.)
- **No network transparency.** Remote Desktop remotes the whole session and
  an app has no say in how. The X11 backend remains the answer when the
  display is elsewhere.
- **WinUI 3 and the Windows App SDK are not the substrate.** They are a
  widget framework — the Windows analogue of what this project _is_, not
  of what it rides on. Their relevance is interop, later: hosting XAML
  content, or being hosted, through Content Islands.
- **Embedding bends rather than breaks.** Unlike macOS and Wayland, Windows
  has cross-process child windows — Chromium parents its own GPU process's
  window that way — so `<foreign>` keeps a rung, though not XEmbed's focus
  protocol (§"Windowing semantics").

## What Windows actually changes

X11 is "the client encodes drawing, the server rasterizes". Wayland is "the
client rasterizes, the compositor composites". macOS is "the client mutates
a retained layer tree, the render server composites and animates it".
Windows is a fourth shape: **the client rasterizes, into retained
composition surfaces that DWM composites.** It sits between the two
inversions [macos.md](macos.md) describes:

- **Like Wayland, the pixels are ours.** There is no server-side drawing
  protocol to encode into. GDI still exists and is not worth using — no
  alpha, antialiasing that is not worth the name, CPU only — so the drawing
  is Direct2D on the app's own Direct3D device, which is the Wayland plan's
  Tier D shape with a rasterizer the platform maintains instead of one of
  ours.
- **Like macOS, the compositor keeps a retained tree.** DirectComposition
  gives an app a tree of visuals that DWM composites, and — the part that
  matters most here — a DirectComposition **surface keeps its pixels
  between frames**, takes an update of any rectangle of itself
  (`IDCompositionSurface::BeginDraw` with an update rect: every pixel inside
  is redrawn, every pixel outside is kept), and **scrolls its own
  contents** (`IDCompositionSurface::Scroll`). That is the X11 performance
  architecture verbatim: damage rects become `BeginDraw` rects, the scroll
  blit becomes one `Scroll`, the paint cache and the cull are untouched —
  and, unlike the Cocoa swapchain, no catch-up copy is ours to owe, because
  the retention is DirectComposition's job, done on the GPU.

Two more differences decide the rest of this document:

- **A window belongs to the thread that created it, not to the main
  thread.** AppKit insists on the process's main thread, so the Cocoa
  backend pumps `NSApplication` from a Node timer, and AppKit's modal loops
  — a live resize, menu tracking, a drag session — freeze Node's event
  loop for as long as they run; macos.md §"Input and the run loop" called
  that the one architectural risk in its plan, and it is still the model
  that ships. Win32 has the same modal loops and more of them —
  `DoDragDrop` does not return until the drop — but it lets the addon run
  them on a thread of its own, so JS never sits inside one (§"Threads and
  the event loop"). It is the largest structural difference from the Cocoa
  backend, and it is in Windows' favour.
- **Fractional scale is the normal case, and it changes under a window.**
  125%, 150% and 175% are what laptops ship at, and a laptop beside an
  external monitor is two scales on one desk. The four-generation ladder in
  [scale.md](scale.md) collapses to one authoritative, per-monitor, live
  answer — the same collapse Wayland and macOS give — but "live" is the
  operative word: a window dragged to the other monitor is expected to
  re-lay itself out at that monitor's scale. That is the one renderer
  change this backend cannot ship without (§"Layout").

And three things get easier:

- **Photon time is observable — on Windows 11.** Like Wayland's
  presentation-time and unlike Core Animation, Windows 11's compositor
  reports per-display statistics — when a frame was presented, the vblank it
  met — and offers a clock to wait on. The project's first metric,
  input-to-photon, can be measured there rather than bracketed; Windows 10
  has only estimates, and brackets it as macOS does.
- **Shortcuts survive a Cyrillic layout by themselves.** Windows reports
  letter keys as virtual-key codes, and the Russian layout gives the key in
  QWERTY's C position `VK_C` — the Latin-accelerator rule `keyboard.js`
  needed code for on X11 arrives with the event (§Input).
- **The desktop is readable without asking.** No TCC, no portal: a desktop
  app can read the screen, enumerate windows and register a system-wide
  hotkey. The eyedropper, global shortcuts and window lists have a rung
  here that macOS does not give them, with integrity levels as Windows' own
  boundary instead.

## The brief, cross-checked

The brief this started from, claim by claim, against what this renderer
actually needs:

| the brief says                                                                                                                                                                                                        | for react-x11                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | lands in                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Win32 is the baseline: `RegisterClassEx`, `CreateWindowEx`, `GetMessage`/`DispatchMessage`, a `WNDPROC`; everything newer sits on an HWND                                                                             | **agree**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | §The bridge                           |
| D3D11 → flip-model swapchain (`FLIP_DISCARD`) → `CreateSwapChainForComposition` → a DirectComposition visual tree                                                                                                     | **agree on DirectComposition; not `FLIP_DISCARD`.** Its buffers come back undefined and it rules out partial presentation, so every frame would repaint the whole window — the per-buffer cost wayland.md charged a GPU swapchain with. Two Windows objects keep the damage model instead: a `FLIP_SEQUENTIAL` swapchain, whose `Present1` takes dirty rects and a scroll rect and copies the rest of the last frame forward itself, and a DirectComposition surface, which retains its pixels, takes a `BeginDraw` per rect and scrolls itself. The surface is the lean, for how it resizes | §Rendering                            |
| Direct2D + DirectWrite into the D3D surface; many toolkits take only DirectWrite and shape with HarfBuzz                                                                                                              | **agree, and DirectWrite end to end** — matching, fallback, shaping, bidi, line breaking, hit testing — the way the Cocoa backend uses CoreText rather than fontkit                                                                                                                                                                                                                                                                                                                                                                                                                          | §Text                                 |
| Windows 11's composition swapchain (`IPresentationManager`) as an opt-in fast path                                                                                                                                    | **later, and not for the 2D content**: it presents whole buffers, with no dirty rects and no scroll, and its present-at-a-time and per-buffer fences are video's and `<glarea>`'s concerns                                                                                                                                                                                                                                                                                                                                                                                                   | §Rendering                            |
| A waitable swapchain + `MsgWaitForMultipleObjectsEx` as the frame loop; paint from `WM_PAINT`/`WM_SIZE` too, because modal loops take over                                                                            | **the loop shape is right for the UI thread; the frame signal to JS comes from the display's clock.** The modal-loop problem is solved by JS not being in the loop at all                                                                                                                                                                                                                                                                                                                                                                                                                    | §Threads and the event loop           |
| DirectComposition buys per-pixel alpha without layered windows, smooth resize, cheap transform and opacity animation, and surfaces without child HWNDs — tooltips and menus can be visuals rather than windows        | **agree, except the last.** A visual cannot draw outside its window, and a menu or tooltip near the window's edge must, so `<popup>` stays a real window; everything that stays inside the window is a node already                                                                                                                                                                                                                                                                                                                                                                          | §Windowing semantics                  |
| `EnableMouseInPointer(TRUE)` + `WM_POINTER` for mouse, touch and pen through one path                                                                                                                                 | **not from an addon.** It can be called once per process and never undone, and it changes mouse delivery for every window in `node.exe`, other addons' included. Chromium does not call it either: the mouse stays on `WM_MOUSE*`, and pen and touch arrive as `WM_POINTER` without the switch                                                                                                                                                                                                                                                                                               | §Input                                |
| Raw Input for unaccelerated, high-frequency deltas                                                                                                                                                                    | **not needed** — it earns its place in pointer lock, which the API does not have                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                     |
| Direct Manipulation for precision-touchpad inertia and rubber-banding                                                                                                                                                 | **agree, later.** The wheel path scrolls correctly without it, on the high-precision wheel messages touchpads send by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                | §Input                                |
| TSF (`ITextStoreACP2`) rather than `WM_IME_*`                                                                                                                                                                         | **TSF is the target, IMM32 the first rung.** The browsers use TSF; Qt, winit, Flutter and SDL use IMM32. TSF's synchronous text-store queries meet this design's threading at its hardest point                                                                                                                                                                                                                                                                                                                                                                                              | §IME                                  |
| Per-monitor-v2 DPI from the manifest or `SetProcessDpiAwarenessContext`; `WM_DPICHANGED`'s suggested rect used verbatim; `WM_GETDPISCALEDSIZE`                                                                        | **per thread, not per process.** `node.exe`'s manifest declares no DPI awareness at all, and an addon must not set the process's: `SetThreadDpiAwarenessContext` on the addon's own UI thread gives its windows per-monitor-v2 whatever the process says. The messages: agree — and they need a renderer that can re-scale a live window                                                                                                                                                                                                                                                     | §Layout, §Threads and the event loop  |
| Custom titlebar: `WM_NCCALCSIZE` → 0, `WM_NCHITTEST`, `DwmExtendFrameIntoClientArea`; `DwmSetWindowAttribute` for dark mode, corners, Mica/Acrylic, caption colour                                                    | **agree**, with two additions. Windows 11's Snap Layouts flyout needs `WM_NCHITTEST` to answer `HTMAXBUTTON` over a drawn maximize button, and every answer is due synchronously on the UI thread, so the regions are pushed ahead from JS. And the attributes are build-gated: documented from Windows 11 (build 22000), the system backdrop from 22H2 (22621)                                                                                                                                                                                                                              | §Windowing semantics                  |
| UI Automation, provider side, through `WM_GETOBJECT`; MSAA is dead                                                                                                                                                    | **agree on UIA**, which Microsoft recommends for new work and whose providers also answer MSAA clients. Where its calls arrive is the design question                                                                                                                                                                                                                                                                                                                                                                                                                                        | §Accessibility                        |
| OLE for the clipboard and drag and drop                                                                                                                                                                               | **agree.** OLE wants a single-threaded apartment on a thread that keeps pumping messages, which the addon's own thread can guarantee and Node's main thread cannot                                                                                                                                                                                                                                                                                                                                                                                                                           | §Windowing semantics                  |
| Ship a manifest: comctl32 v6, DPI awareness, `longPathAware`, `activeCodePage` UTF-8; build ARM64 beside x64                                                                                                          | **for a packaged app.** `node app.js` runs under `node.exe`'s manifest — `supportedOS` entries and nothing else — and the addon must work without any of it: comctl32 v6 is reachable from a DLL through an activation context (`ISOLATION_AWARE_ENABLED`, a manifest at resource 2), and UTF-8 is moot, because N-API hands the addon UTF-16 directly. ARM64 and x64 prebuilds: agree                                                                                                                                                                                                       | §Packaging and identity               |
| WinUI 3 and the Windows App SDK (2.0 shipped April 2026) are a competitor; Content Islands for interop                                                                                                                | **agree** — 2.0.1 shipped on 2026-04-29                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | §What this is                         |
| Skip GDI/GDI+, layered windows, `SetWindowRgn`                                                                                                                                                                        | **agree for drawing.** GDI keeps two small jobs: reading the screen for the eyedropper, and `PrintWindow` for test snapshots                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | §The desktop around the app, §Testing |
| HWND ≈ `NSWindow`, a DComp visual tree ≈ a CALayer tree, a DXGI flip swapchain ≈ a `CAMetalLayer` drawable; "if your Cocoa backend renders through Metal, D3D11 → composition swapchain → DComp visual ports cleanly" | **the mapping is right, the premise is not ours.** The Cocoa backend does not render through Metal: its default presenter is CoreGraphics into an IOSurface pair. The symmetric design is Direct2D into a DirectComposition surface. And CALayer's _property_ vocabulary — colours, radii, borders and shadows that animate in the render server — is closer to the WinRT visual layer than to classic DirectComposition, which decides where promotion lands                                                                                                                                | §Rendering                            |
| Read Chromium's `ui/gfx/win` and viz DComp code, Ghostty's and Zed's Windows backends, GLFW's `win32_window.c`                                                                                                        | **agree**, plus Firefox's DirectComposition compositor, Electron's `node_bindings_win.cc`, and the Flutter and winit Windows shells                                                                                                                                                                                                                                                                                                                                                                                                                                                          | §References                           |

## What already carries over

Measured at `13ffb34`: `src/` is 71,814 lines of `.js`. The inventory
[wayland.md](wayland.md) took at 2.2.1 still has the same shape: the
reconciler, yoga, the style system, event synthesis, focus, text editing
and selection, the a11y model, keysyms, compose, anchors and the D-Bus
stack never name a display system, and `components/` (7,935), `frame/`
(1,306) and `refresh/` (536) carry over whole. Of `src/nodes/` (15,610,
split by concern in #536), the `window/` part (3,801) realizes against a
window object whose shape is `src/testing/mock-app.js`'s — and the Cocoa
backend is the proof that the shape can be met with no X anywhere
underneath.

The better estimate of the work is the Cocoa backend itself, because it is
the same kind of thing: `src/cocoa/` is **8,865 lines** implementing that
contract plus fifteen platform services, over a bridge of **~9,800 lines**
of Objective-C++ (`@windowkit/appkit` 0.9's `src/`) from which the backend
calls about 140 natives. A Windows backend is that shape again. How much
of the JS half comes free is the part worth planning, and `src/cocoa/` was
written with the split in mind:

| in `src/cocoa/` today                                                                                                                                                                                           |  lines | on Windows                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context2d.js` — the canvas-shaped context over a verb table                                                                                                                                                    |  1,301 | **shared.** The verb table becomes the contract two bridges implement, as macos.md §"The split" proposed. CoreGraphics' own trade-offs (stroke chunking, gradient-stop normalization) become per-bridge capabilities |
| `surface.js` — `app.createSurface`                                                                                                                                                                              |    235 | **shared**, over the same verbs                                                                                                                                                                                      |
| `promotion.js` — which nodes may promote, and the CALayer ops                                                                                                                                                   |    705 | the **policy** — the z-order test, the idle grace — shared; the ops per bridge                                                                                                                                       |
| `app.js` — the pump, the per-display frame clocks, event routing                                                                                                                                                |  1,242 | the frame queue and the routing are a template; **the pump does not exist** (§Threads and the event loop)                                                                                                            |
| `window.js` — the ntk-shaped window and its IOSurface swapchain                                                                                                                                                 |    669 | the window half is a template; the swapchain does not transfer, because a DirectComposition surface retains                                                                                                          |
| `fonts.js` — CoreText behind the engine contract                                                                                                                                                                |    984 | the contract, and the `linebreak`-driven floor and eliding, shared; DirectWrite replaces CoreText                                                                                                                    |
| `presenter.js` — the layer presenter                                                                                                                                                                            |  1,250 | Core Animation's; a Windows retained presenter is later work behind the same hooks                                                                                                                                   |
| `keymap.js` and the service modules — `dnd`, `filepanels`, `notifications`, `statusitem`, `dock`, `permissions`, `calendar`, `screencolor`, `glarea`, `globalmenu`, `bezels`, `panehost`/`panewindow`, `native` | ~2,480 | per-backend rungs behind the same hooks                                                                                                                                                                              |

Outside `src/cocoa/`, seventeen `process.platform` checks decide darwin
against Linux (`filedialog.js`, `notifications.js`, `appearance.js`,
`bus.js`, `permissions.js`, `ClickToComponent.js` and a few more); each
grows a third answer. And the D-Bus stack loses nothing but has nothing to
talk to: there is no session bus on Windows, so every D-Bus-first ladder
([dbus.md](dbus.md)) lands on its "there is no bus" floor — built
first-class for exactly this — and Windows supplies its own rungs above it
(§"The desktop around the app").

## Layout: nothing to port, one thing to build

yoga runs unchanged: layout is platform-free, and it already runs in
device pixels with whole-pixel rounding ([scale.md](scale.md)). Two
consequences of Windows' scale model are routine rather than new.
Fractional scale is the common case, so scale.md's caveat — a
one-logical-pixel hairline at 1.25× lands on one device pixel or two,
depending on where it falls — is what most Windows users will see. And
DirectWrite measures in fractional DIPs, which the text engine rounds up to
whole device pixels at the same boundary the CoreText engine does, because
a fractional measure is what makes a yoga layout blow up.

The thing to build is a **live, per-window scale**. `useScale()` is
"static for the life of the root" (scale.md): one number, chosen at
creation, on every backend. That is right for X11, which has one
coordinate space and no per-window scale protocol, and where re-scaling
mid-drag is a resize the window manager fights. Windows is the opposite
case. A laptop at 150% beside a monitor at 100% is the ordinary desk; a
per-monitor-v2 window is expected to re-lay itself out when it crosses
between them; and Windows says when, with `WM_DPICHANGED` and the
rectangle it suggests at the new scale — and before it
`WM_GETDPISCALEDSIZE` (Windows 10 1703 and later), in which the window may
answer the size it wants there. A window that ignores both is not blurry,
because Windows does not stretch a per-monitor-aware window; it is simply
the wrong physical size on the other monitor.

Until the renderer can re-scale a live window — a relayout, every
scale-keyed cache invalidated, text re-measured, the window's own
geometry converted — the backend's interim answer is to take the suggested
rectangle and scale the content visual by the ratio, which is what Windows
itself does to a window that is only system-DPI aware: the right physical
size at once, soft until the next frame at the new scale. The renderer
half is backend-neutral: Wayland's fractional-scale protocol asks for the
same thing ([wayland.md](wayland.md)), and a Cocoa window dragged from a
retina panel to a standard monitor would use it too.

## The bridge: our own, and why

### What it has to provide

The contract is the Cocoa one with Windows mechanisms under it; macos.md
§"The split" already named its pieces — a verb table over an opaque
surface handle, surface operations, text natives, windows, events, and the
platform services. Grouped:

- **App and threads** — start the UI thread; the event channel; the
  command queue; the state the UI thread publishes (window rects, DPI,
  monitors, keyboard locks); shutdown.
- **Windows** — create (overlapped, popup or tool; owner, topmost,
  no-activate, transparent), show and hide, title, geometry in physical
  pixels, minimum and maximum size, maximize, minimize, fullscreen and
  restore, flashing, DWM attributes, per-window hit-test regions and
  cursor, the window's AppUserModelID, relaunch properties and icon.
  Events: geometry, including live-resize ticks bracketed by
  `WM_ENTERSIZEMOVE` and `WM_EXITSIZEMOVE`; DPI changes with the suggested
  rect; close requests; activation; display changes.
- **Composition** — one device (Direct3D 11, Direct2D, DirectComposition)
  on the JS thread; a target and a root visual per window; the window's
  surface (`BeginDraw`/`EndDraw` per rect, `Scroll`, resize); child visuals
  for promotion, `<glarea>` and element-owned surfaces; `Commit`; frame
  statistics.
- **Drawing** — the `ctx*` verb table over a Direct2D device context, and
  the surface operations under the names `@windowkit/appkit` already
  exports (`createSurface`, `surfaceSize`, `scrollSurface`,
  `copySurfaceRegion`, `ctxDrawSurface`, `blitSurface`, `ctxGetImageData`,
  `ctxPutImageData`), so one context wrapper drives both bridges.
- **Text** — DirectWrite layouts built from span lists, their metrics, hit
  tests and drawing; font matching and fallback; the glyph-run natives of
  #432 (glyph for a code point, advances, shaping, drawing a run); fonts
  loaded from bytes.
- **Input** — mouse, wheel and pointer; keys joined to the characters they
  typed; IME composition; cursors.
- **Services** — the clipboard (formats, delayed rendering, a change
  listener); OLE drag and drop both ways, with drag images; the Common
  Item Dialog; the tray icon and popup menus; the taskbar (overlay badge,
  progress, flashing, jump lists); toasts; appearance (`UISettings`, high
  contrast); screen reading for the eyedropper; global hotkeys; UI
  Automation.
- **Testing hooks** — synthetic input posted into the window procedure; a
  snapshot through `PrintWindow`.

### What npm has

Surveyed 2026-09-11 — versions and dates from the npm registry, the
message-loop column from each project's source — with one question put to
every candidate: could it be the substrate (windows, input and
presentation) under a renderer that keeps its own layout, its own event
synthesis, its own 2D dialect and its own text engine?

| package, version (last publish)                                                                                 | what it is                                                                                                                                                                       | how it meets the message loop                                                                                                                        | fit                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `koffi` 3.2.1 (2026-09)                                                                                         | FFI over N-API — structs, unions, `__stdcall`, raw function pointers and so COM vtables; prebuilt for x64, ARM64 and ia32                                                        | the caller's; callbacks from other threads are queued to the JS thread, which its documentation warns can deadlock                                   | **the spike**, and leaf calls                                                                                              |
| `ffi-rs` 1.3.7 (2026-08)                                                                                        | FFI over napi-rs, threadsafe async callbacks                                                                                                                                     | the caller's                                                                                                                                         | a spike alternative                                                                                                        |
| `bun:ffi`                                                                                                       | Bun's built-in FFI                                                                                                                                                               | its threadsafe callbacks are marked experimental, not for production                                                                                 | leaf calls under Bun                                                                                                       |
| `libwin32` 0.12 (2026-06), `win32-api` 26.1 (2025-02)                                                           | Win32 wrappers and signature catalogs over `koffi`                                                                                                                               | `libwin32`'s window demo runs a blocking `GetMessage` loop on the JS thread, so Node's own loop never runs                                           | reference                                                                                                                  |
| `@bun-win32/*` 2.0 (2026-06)                                                                                    | Bun FFI bindings including Direct3D 11, Direct2D, DirectWrite and DirectComposition, reaching COM through vtable pointers                                                        | no message-loop story                                                                                                                                | reference, Bun only                                                                                                        |
| `@kmamal/sdl` 0.11 (2025-08)                                                                                    | SDL 2 over N-API, with WebGL and WebGPU siblings                                                                                                                                 | polled from JS by `setInterval(poll, 0)`; a live resize blocks it, and the SDL issue is closed as won't-fix                                          | no — the Cocoa pump's costs, CPU blits, x64 only                                                                           |
| `@node-3d/glfw` 7.3 (2026-08), which replaces `glfw-raub`                                                       | GLFW over N-API                                                                                                                                                                  | an idle pump on the JS thread; GLFW documents that a move, a resize or a menu blocks event processing                                                | no — OpenGL only                                                                                                           |
| `skia-canvas` 3.0 (2025-09)                                                                                     | Skia with `Window` and `App` over winit, Vulkan on Windows                                                                                                                       | by default winit's loop runs on the Node thread until the last window closes; a `'node'` mode pumps it every few milliseconds instead                | no — its own drawing API and Skia's text displace ntk's dialect and the engine contract: wayland.md's Tier C verdict again |
| `@nodegui/nodegui` 0.74 (2026-05)                                                                               | Qt 6 widgets                                                                                                                                                                     | through `qode`, a forked Node binary: a helper thread waits on libuv and posts to the Qt thread, which runs `uv_run` — Electron's code, transplanted | no — a widget toolkit and a runtime of its own                                                                             |
| `node-gtk` 4.1 (2026-07)                                                                                        | GObject bindings, GTK 4 on Windows                                                                                                                                               | GLib's loop runs libuv from a GLib source; on Windows the I/O half is marked FIXME                                                                   | no                                                                                                                         |
| `webgpu` 0.6 (2026-08)                                                                                          | Dawn for Node                                                                                                                                                                    | cannot present to a window                                                                                                                           | no                                                                                                                         |
| `winpane` 0.1 (2026-03)                                                                                         | napi-rs overlay surfaces over Direct3D 11, Direct2D, DirectComposition and DirectWrite                                                                                           | **a dedicated thread owns every window and GPU object in its own `GetMessageW` loop**; commands reach it on a channel with a `PostMessageW` wake     | reference — pre-1.0, with this document's threading shape                                                                  |
| `node-api-dotnet` 0.9 (2026-09)                                                                                 | Microsoft's JS↔.NET bridge, which reaches WinRT and the Windows App SDK                                                                                                          | .NET's; JS objects only on the JS thread                                                                                                             | no for the core — a public preview that puts .NET (and, for notifications, the Windows App SDK runtime) under every app    |
| NodeRT, `ffi-napi`, `libui-node`, `proton-native`, `react-nodegui`                                              | WinRT projections, the old FFI, libui bindings, React over libui and Qt                                                                                                          | —                                                                                                                                                    | unmaintained — the React renderers among them wrapped someone else's widget toolkit                                        |
| the leaf packages: `clipboardy`, `@napi-rs/clipboard`, `systray2`, `trayicon`, `node-notifier`, `powertoast`, … | clipboard, tray, notification and dialog integrations                                                                                                                            | PowerShell or a helper `.exe` per call, a polling loop, or data written eagerly                                                                      | no — none carries a lazy payload, and each is a few dozen lines inside the addon                                           |
| AccessKit — Windows adapter 0.35, C bindings 0.23 (2026-09)                                                     | accessibility infrastructure in Rust: the app pushes a tree, the adapter serves UI Automation from it, text ranges for single- and multi-line inputs included, rich text not yet | installed from the UI thread; answers from its own copy                                                                                              | **the reuse candidate** (§Accessibility)                                                                                   |
| `robotjs` 0.9 (2026-08)                                                                                         | input injection                                                                                                                                                                  | —                                                                                                                                                    | leaf, for the tests that want the real input stack                                                                         |

None of them is a substrate. The windowing candidates are policy layers,
and each owns something this renderer must keep. Every one that polls the
OS from the JS thread — SDL, GLFW, winit in either of `skia-canvas`'s modes
— freezes JS in Windows' modal loops, which is the Cocoa backend's
standing cost; `skia-canvas` also owns the drawing API and the text stack,
and NodeGui the widget set and the Node binary. Nothing carries lazy
clipboard payloads, drag and drop in both directions, the Common Item
Dialog or UI Automation, and nothing but a pre-1.0 overlay library reaches
DirectComposition, Direct2D and DirectWrite at all — which is where this
backend's performance and its text live.

The prior art worth reading is shapes rather than packages: `winpane`'s
dedicated thread; NodeGui's loop merge, as the thing not to need;
react-native-windows, which keeps JS on a thread of its own and posts every
mount to the UI thread that alone touches its composition visuals; and the
small addons that already run a message loop on a thread of their own
inside stock `node.exe` — `node-usb-detection`'s listener window,
`uiohook-napi`'s hook thread feeding a threadsafe function.

### The decision

**Our own addon — `@windowkit/win32` as a working name, `@windowkit/appkit`'s
sibling — mechanism only**: verbs, handles and events, no policy, no widget
logic and no JS canvas class inside it, the same export-list discipline
macos.md §"The split" set for the Cocoa bridge. It ships as an
`optionalDependency` with `os: ["win32"]` and prebuilds for x64 and ARM64,
over N-API so Bun loads it too; absent on every other platform, the way
`@windowkit/appkit` is absent on Linux.

Reuse where it pays: `koffi` is the fastest route to Phase 0's first
window, and is thrown away after it; AccessKit is the lean for UI
Automation, through its C bindings; and `robotjs` injects real input for
the tests that want the whole input stack.

### C++, and where Rust would win

**C++ with node-addon-api**, the toolchain `@windowkit/appkit` already
uses: one build and publish pipeline (`node-gyp`, prebuilds in the
package, the same install script); the Windows SDK's own headers — WRL and
C++/WinRT — are all it needs for COM and WinRT; and every reference
implementation worth reading (Chromium, Firefox, Electron, the Flutter
engine, GLFW) is C or C++ and ports line for line. AccessKit is Rust but
ships C bindings, so adopting it does not force the question.

Rust — napi-rs over `windows-rs` — is the recorded alternative, and its
advantages are real rather than fashionable: `#[implement]` makes the COM
objects this bridge has to implement (drop target, drop source, data
object, TSF's text store) safer to write, and `cargo-xwin` cross-compiles
the MSVC target from a Mac — the maintainer's machine — where C++ needs a
clang-cl setup to do the same. One language family across the windowkit
bridges wins until the cross-compile matters more than the symmetry.

## Threads and the event loop

### What the Cocoa backend does, and what it costs

AppKit must run on the process's main thread, which in a Node process is
the thread that runs JS. So the Cocoa backend does what macos.md §"Input
and the run loop" called option 1: Node's loop is the master, and a timer
pumps AppKit every 8 ms (`native.pump2()`, `src/cocoa/app.js`). Two costs
follow, and both are measured:

- **Input waits for the pump.** An event that lands just after a tick
  waits most of a pump interval before JS sees it. Frames got a timer of
  their own to escape the quantization (macos.md §"Measured: incremental
  floors, the strip, the frame timer"); input did not.
- **A modal loop freezes Node.** AppKit runs live resize, menu tracking and
  drag sessions in loops of its own _inside_ the pump call. With a drag up,
  a 25 ms `setInterval` did not fire for the drag's whole duration — 31
  seconds in the probe — and a microtask queued inside a bridge callback did
  not drain until the pump returned
  ([#484](https://github.com/sidorares/react-x11/pull/484)). The backend
  lives with it by doing a frame's work inside the callbacks that do arrive
  (`CocoaApp._afterInput`: `flushSyncWork`, `flushPendingFrames`,
  present), which is why a live resize re-lays out and a drag preview
  follows the pointer. But a timer, a socket read, an `await` or a React
  update from anything other than that callback waits for the gesture to
  end.

### Three shapes on Windows

1. **The Cocoa shape**: create the windows on Node's main thread and pump
   `PeekMessage` from a libuv timer. It works, and it inherits both costs,
   worse. The pump cannot become a wait: on Windows libuv blocks in
   `GetQueuedCompletionStatusEx` on its completion port (`uv_backend_fd`
   is -1 there), only a packet posted to that port wakes it, and a thread's
   message queue can be waited on only by `MsgWaitForMultipleObjectsEx` on
   that same thread — so no single call wakes for both, and a window on
   Node's thread can only be polled. And Windows' modal loops are more
   numerous and more total than AppKit's: `DoDragDrop` does not return
   until the drop — a drop into another program included — and neither do
   `TrackPopupMenuEx`, menu-bar tracking, `IFileDialog::Show` or a
   `MessageBox`. Every drag, menu and dialog would freeze JS. Every npm
   windowing package above that polls from the JS thread has exactly this
   behaviour.
2. **The Electron shape**: merge the loops. Electron runs libuv inside
   Chromium's Win32 message loop: a helper thread blocks on libuv's
   completion port with libuv's own timeout, gives each completion packet
   back to the port, and wakes the main thread to run one non-blocking
   `uv_run` (`shell/common/node_bindings_win.cc`, over a patched libuv).
   That needs whoever owns `main()` to own the outer loop. In stock Node
   the main thread sits in `uv_run` and an addon only ever runs as a
   callback inside it, and `uv_run` is documented as not re-entrant — the
   same reason macos.md held its option 3, "full inversion", in reserve.
   NodeGui does it on Windows with `qode`, a forked Node binary, which is
   what the shape costs when you do not own `main()`.
3. **A UI thread of the addon's own** — the recommendation. Win32 binds a
   window to the thread that created it, not to the main thread. So the
   addon starts one thread, and that thread creates every HWND, owns the
   OLE apartment and the DPI context, and runs a plain
   `GetMessage`/`DispatchMessage` loop; JS stays on Node's main thread.
   Events cross through a `napi_threadsafe_function` — `uv_async_send`
   underneath, a packet posted to libuv's completion port — so they wake
   Node's loop at once, from any thread, without waiting for a tick; each
   delivery runs in a callback scope that drains microtasks and next-ticks
   when it closes, so a handler's `setState` commits on the event that
   caused it — the #484 problem does not exist here. And every modal loop
   runs on the UI thread, where Windows expects it, while Node's loop keeps
   running: timers fire, sockets read, React commits and frames present
   during a live resize, with a menu open, and in the middle of a drag.

Shape 3 is what macos.md's option 3 was for — JS never frozen by the
platform's loops — without inverting anything, and it is available only
because Win32 permits it. It is also how the browsers split the work, and
DirectComposition is documented to allow it: its objects are not bound to a
thread, and a target needs only that the window belong to the calling
process. Chromium's GPU process creates its window on a dedicated "window
owner" thread and builds and commits the DirectComposition tree for that
window from its GPU thread (`ui/gl/child_window_win.cc`,
`ui/gl/dc_layer_tree.cc`).

### Who owns what

| thread                         | owns                                                                                                                                                                                           | reaches the others by                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Node's main thread             | React, layout, the node tree; painting through Direct2D; the content's DirectComposition device and its `Commit`; DirectWrite                                                                  | commands posted to the UI thread, one wake per frame; reading what the UI thread publishes         |
| the UI thread, one per process | every HWND and its message loop; the modal loops; the OLE apartment; the per-monitor-v2 DPI context; IME; the clipboard's owner window; the tray icon; hotkeys; the background plate (§Resize) | batched events through a threadsafe function per Node environment; state it publishes under a lock |
| the frame thread               | waiting on the display's clock                                                                                                                                                                 | a tick through the same threadsafe function                                                        |
| UI Automation's threads        | calls into the accessibility providers                                                                                                                                                         | answered from AccessKit's copy of the tree (§Accessibility)                                        |

### The rules that keep it from deadlocking

Two threads that can each wait on the other eventually will. The design is
three rules:

- **JS never waits on the UI thread.** Every JS→UI call is a command on a
  queue — create, show, move, set the title, set the cursor, push hit
  regions — batched and sent with one wake per frame, the way one
  `CATransaction` carries a frame on Cocoa. A window is created
  asynchronously: the command returns a handle at once, and the first frame
  targets it when the UI thread reports it exists. Anything JS reads back
  synchronously — window rects, monitors, the keyboard's lock state — is a
  value the UI thread _publishes_ into lock-guarded memory and JS reads
  without a hop. That is also the only correct place to get those values:
  Node's thread is DPI-unaware, and a monitor or cursor query made there
  answers in scaled-down virtual pixels. The contract makes this natural:
  the X11 app and window contract was asynchronous from the start, because
  a display server sat at the far end of a socket — clipboard reads,
  dialogs and snapshots are promises, geometry arrives as events. The Cocoa
  bridge made much of it synchronous because it could; Windows puts the far
  end back, a thread instead of a socket, and the X11-shaped contract fits.
- **What Windows asks synchronously, and JS can know in advance, is pushed
  ahead.** `WM_NCHITTEST` (every mouse move over the window),
  `WM_SETCURSOR`, `WM_GETMINMAXINFO`, the IME's candidate position and a
  drag's `DragOver` effect all need an answer before the window procedure
  returns. So JS pushes them after each commit — the hit regions of a drawn
  titlebar, the cursor of the hovered node, the size limits, the caret
  rect, the effect the last `onDragOver` chose — and the UI thread answers
  from what it holds. That is Electron's `app-region: drag` generalized,
  and it is how the X11 path already treats state the server needs without
  asking.
- **The UI thread may wait on JS — bounded, message-aware, and only where
  JS alone has the answer**: a lazy clipboard payload (`WM_RENDERFORMAT`),
  a drag's `IDataObject::GetData`, and the resize handshake below. Each
  wait has a deadline and a fallback answer, and waits in
  `MsgWaitForMultipleObjectsEx` so that sent messages keep being
  dispatched meanwhile. Because JS never waits on the UI thread, the cycle
  that would deadlock cannot form.

Two mechanics make the rules hold inside a modal loop, where the UI
thread's own loop is not the one running. The command queue's wake is a
message posted to a message-only window, whose procedure drains the queue:
a thread message (`PostThreadMessage`) would be eaten by the modal loop,
and a wait of our own does not run inside one. And the event channel
carries batches: the UI thread appends to a queue and makes one
threadsafe call per wake, consecutive motion folds to its latest position
before it crosses, and JS drains the batch in one callback — so a burst of
input is one macrotask rather than one microtask checkpoint and one commit
per message.

Drawing happens on the JS thread: the Direct3D device, the Direct2D
context and the DirectComposition device are created and used there, and
the UI thread never touches them. That matters beyond tidiness, because a
DirectComposition `Commit` submits everything pending on its device from
every thread — a device shared between two threads would commit one
thread's half-made changes with the other's frame. Where Windows ties an
object to a thread — OLE's drop target registration, the clipboard's owner
window, hotkeys, `WM_GETOBJECT` — it is the UI thread's. The
per-monitor-v2 DPI context is set there with
`SetThreadDpiAwarenessContext` before the first window, which is what makes
its windows DPI-correct under a `node.exe` whose manifest says nothing
about DPI.

### Resize: where the threads meet

A live resize is the one place the two threads must agree within a frame.
DWM moves the window's edge on the drag's own schedule; if the content
arrives later, the user sees the gap. Every platform has a handshake for
this — Wayland's `configure`/`ack_configure`, X11's
`_NET_WM_SYNC_REQUEST` — and on Windows the addon makes one. On each
`WM_SIZE` inside the size-move loop the UI thread publishes the new size,
wakes JS, and waits — bounded, pumping messages as it waits — for JS to
commit a frame at that size before it returns to Windows. It is what
Flutter's Windows embedder does: its `WM_SIZE` handling waits up to
100 ms for a frame of the new size and drops frames of the old one
(`flutter_windows_view.cc`). JS lays out, paints and commits exactly as it
does for a Cocoa resize tick, with `liveResizing` set from
`WM_ENTERSIZEMOVE`/`WM_EXITSIZEMOVE` so the content floors defer the way
they do there (`_deferContentFloors`, `src/nodes/window/size.js`).

The deadline will be missed on a big tree — the Cocoa `resize` cell
measures 28 ms a tick at 3,662 nodes (macos.md §"Measured: the frame clock
and the large tree") — so what shows when it is missed matters as much as
the handshake. Three things keep it clean. The window's surface is a
virtual surface, which keeps its content across a resize, so late content
is the last frame at its old size rather than garbage — placed at one to
one, where a swapchain would stretch it, which is why Flutter has to drop
old frames and a surface need not. The UI thread owns a **background
plate** of its own — the root visual, in the window's background colour,
resized in the same `WM_SIZE` from a device the UI thread commits by
itself, with the content's visuals from the JS thread's device beneath it
in the tree — so a newly exposed edge shows the app's background rather
than black. X11 has always done that half: it is the window's background
pixel, which `WindowNode` sets and the server paints before the client
can. And the `liveResizing` deferral keeps each tick's frame as cheap as the
tree allows.

### The frame clock

A thread of the addon's blocks on the display's clock and ticks JS through
the threadsafe function: the compositor clock on Windows 11
(`DCompositionWaitForCompositorClock`, which is not tied to the primary
monitor and wants a timeout — Chromium gives it 100 ms, because the wait
hangs if the adapter goes away), and before it `IDXGIOutput::WaitForVBlank`
on the output under the window, where Chromium's default vsync thread waits
on the primary's. The frame queue above it is the Cocoa one: per-window
intervals from the refresh rate of the monitor under the window
(`frameIntervalFor`), a discrete input answered on the spot
(`flushPendingFrames`), a window nobody can see owing nothing, and
`frameRate`'s pacing on top
([architecture/frame-pacing.md](architecture/frame-pacing.md)). What
Windows 11 adds is the far end: the compositor's target statistics say
when a frame was presented on each display, so `frameInFlight` can be the
compositor's answer rather than a guess from elapsed time, and
input-to-photon becomes a measurement — the input's timestamp against the
present time of the frame that answered it. Windows 10 has only an estimate
of the next frame, and brackets it as Cocoa does.

### Lifetimes, workers and Bun

- The event function is referenced while any window exists, so a window
  keeps Node alive the way the X socket does, and unreferenced when none
  does, so an app with no windows can exit.
- Teardown has two doors, because `process.exit()` skips environment
  cleanup hooks: the cleanup hook for an environment that ends normally,
  and a `process.on('exit')` handler for one that does not. Either one ends
  any modal loop the UI thread is in (`EndMenu`, cancelling the drag,
  dismissing the dialog), destroys the windows, posts `WM_QUIT` and joins
  with a deadline — a thread still inside a modal loop when the process
  exits is killed holding whatever it held. An event that arrives after its
  environment is gone reaches the threadsafe function's callback with no
  environment, and is dropped.
- One UI thread per process, one event function per Node environment. The
  addon can be loaded by several workers at once, and a window owned by a
  window on another thread attaches the two threads' input — which a single
  UI thread never has to reason about.
- Bun implements N-API's threadsafe functions and exports them on Windows,
  and runs the Cocoa bridge today. Two teardown crashes in them were fixed
  in August 2026 (oven-sh/bun#37031, #37201) and a Windows-only panic has
  been reported (#16210), so Phase 0 runs the event path under `bun.exe`
  as well as `node.exe`: everything above depends on it.

## Rendering

### The window's content: a DirectComposition surface

Each window gets a target, a root visual and one surface — a virtual
surface at the window's physical size, `DXGI_FORMAT_B8G8R8A8_UNORM`,
alpha-ignored for an ordinary window (which is also what lets its text be
ClearType, §Text) and premultiplied for `transparent`. The surface
presenter's contract then maps one call to one call:

- **a frame** is one `BeginDraw`/`EndDraw` per damage rect, painting
  through the Direct2D context `BeginDraw` hands back — positioned in a
  texture DirectComposition manages, at an offset the context wrapper folds
  into its transform — and then one `Commit`. Every pixel inside the rect
  is repainted (its old contents are undefined, which the paint pass's
  clear already assumes) and every pixel outside it is kept. One surface
  per device can be mid-draw at a time, which a frame's sequential rects
  never contest;
- **`scrollRegion(rect, dx, dy)`** is `Scroll` and returns `true` — the
  fast path the X11 and Cocoa windows take, with the exposed strip
  repainted by the frame's own damage;
- **`damageRectCap`** is measured, starting from Cocoa's 16: a `BeginDraw`
  has a fixed cost, so the right number of rects is a fact about
  DirectComposition rather than a choice;
- **a resize** is `IDCompositionVirtualSurface::Resize`, which keeps the
  pixels inside the new bounds, so a live-resize tick allocates nothing
  window-sized — the churn #442 measured on Cocoa (+572 MB during a 40-tick
  burst before the explicit release) has nothing to fix here — and late
  content is the last frame rather than garbage (§"Resize: where the
  threads meet");
- **reading back** is the one thing a surface refuses: the app cannot read
  its pixels. What the Cocoa window answers from its IOSurface —
  `getImageData` over the window, a snapshot — is answered here by
  `PrintWindow` once the commit has completed, or by painting the tree once
  more into an offscreen surface. Both are rare paths: tests and captures;
- **what does not transfer** from the Cocoa window: the IOSurface pair,
  `noteFrameDamage`'s catch-up copy and `_releaseBacking`.

The brief's `FLIP_DISCARD` swapchain is the one Windows presentation object
that cannot do this: its buffers come back undefined and partial
presentation is ruled out, so every frame would repaint the window. A
`FLIP_SEQUENTIAL` composition swapchain can: `Present1` carries the frame's
dirty rects and a scroll rect, and DXGI copies the rest of the previous
frame forward and performs the scroll blit itself — Firefox presents that
way too. It is the recorded alternative, and it has one thing the surface
lacks, a waitable object to pace by. The surface is the lean for how it
resizes: `ResizeBuffers` discards what a swapchain holds, so a frame that
is late during a live resize has nothing to show, where a resized virtual
surface still has the last one. Firefox also paints its WebRender tiles
into DirectComposition surfaces, a `BeginDraw` per dirty rect
(`gfx/webrender_bindings/DCLayerTree.cpp`); neither browser calls `Scroll`,
which is why it is on the probe list.

### The verb table on Direct2D

| verb                                                                                        | Direct2D                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fillRect`, `fillRects`, `strokeRect`, `clearRect`                                          | `FillRectangle`, `DrawRectangle`; `clearRect` is a `Clear` inside an axis-aligned clip                                                                                                                                                                                                                                                                                                               |
| paths — `moveTo` to `closePath`, `arc`, `ellipse`, curves — `fill`, `stroke`, `setLineDash` | an `ID2D1PathGeometry` per path; `FillGeometry` and `DrawGeometry` with an `ID2D1StrokeStyle1` for caps, joins and dashes                                                                                                                                                                                                                                                                            |
| `roundRect`                                                                                 | `FillRoundedRectangle` for one radius, a path for per-corner radii                                                                                                                                                                                                                                                                                                                                   |
| `clip`                                                                                      | `PushAxisAlignedClip` for a rect under an axis-aligned transform — the clip every paint pass sets; a layer with a geometric mask otherwise, which is the expensive one. The Cocoa context's rule, to track the clip as a rect only where it can be stated exactly, carries                                                                                                                           |
| linear and radial gradients                                                                 | `ID2D1LinearGradientBrush`, `ID2D1RadialGradientBrush` — radial being the verb the Cocoa bridge still lacks                                                                                                                                                                                                                                                                                          |
| `createPattern`                                                                             | an image brush with extend modes — the pattern fill `<Flow>`'s grid wants                                                                                                                                                                                                                                                                                                                            |
| `drawImage`, `ctxDrawSurface`, `blitSurface`, `copySurfaceRegion`                           | `DrawBitmap` and `DrawImage`; `CopyFromBitmap` for the plain copies                                                                                                                                                                                                                                                                                                                                  |
| `putImageData`, `getImageData` on a surface                                                 | `CopyFromMemory` in; a CPU-readable bitmap and `Map` out — answered RGBA, as the context's contract says                                                                                                                                                                                                                                                                                             |
| `globalAlpha`, `globalCompositeOperation`                                                   | brush or layer opacity; `SetPrimitiveBlend` covers `source-over`, `copy` and `lighter`; the other Porter-Duff operators composite through `DrawImage` from an intermediate bitmap, and `multiply` to `luminosity` through the blend effect over a copy of the destination. The vocabulary is the bridge's own and is feature-detected by assigning and reading back, as Cocoa's `ctxSetBlendMode` is |
| shadows                                                                                     | baked into the paint cache, never a live effect — the #413 rule: a filter re-run on every composite is the same trap on a GPU as on an X server                                                                                                                                                                                                                                                      |
| `drawGlyphs`                                                                                | `DrawGlyphRun`, grouped by face and size                                                                                                                                                                                                                                                                                                                                                             |

Two Direct2D facts to design around rather than discover. A device can be
lost — a driver update, a GPU reset, a laptop switching adapters — and
recovering is the resize path again: a new device, new surfaces, one full
frame, which the backend's fresh-surface logic already knows how to run.
And Windows always has a device to ask for: where there is no hardware,
WARP — Direct3D's software rasterizer, part of the OS — runs Direct2D,
which covers virtual machines without passthrough and CI runners; that
DirectComposition presents from a WARP device is the last item on the probe
list. The Wayland plan's `'2d-sw'` rasterizer, uploaded into a `BeginDraw`
rect, remains the cross-backend pixel reference rather than a fallback
Windows needs.

### Promotion, and a retained tier later

On Cocoa, promotion lifts the few nodes that animate onto CALayers above
the window's bitmap, where the render server animates `backgroundColor`,
`borderColor`, `borderWidth` and `borderRadius` while JS is busy (macos.md
§"Layer promotion"). The Windows analogue is a visual above the window's
surface, and the question is which composition API holds it:

- **Classic DirectComposition** (`dcomp.h`, the API everything above
  already uses) animates any scalar property of a visual — its offset, its
  transform, an effect group's opacity, a rectangle clip's edges and corner
  radii — with curves DWM evaluates. That covers movement, fades and a
  radius. It has no colour to animate, so a background or border transition
  stays on the frame clock, and a node promoted for movement is a raster in
  a surface of its own.
- **The WinRT visual layer** (`Windows.UI.Composition`, reached from Win32
  through the desktop interop interfaces, Windows 10 1803 and later) is
  CALayer's vocabulary almost property for property — sprite visuals with
  colour and gradient brushes, drop shadows, rounded clips — and the
  properties that matter animate in the system compositor: a brush's
  colour, a shadow's blur, colour and offset, and on Windows 11 a clip's
  corner radii, with key-frame easing that `EASING_CONTROL_POINTS` already
  expresses as cubic beziers. It also has `InteractionTracker`,
  compositor-driven touch and touchpad scrolling.

Or the visual layer from the start: its drawing surface takes the same
`BeginDraw`, `Scroll` and `Resize` (`ICompositionDrawingSurfaceInterop`),
so the window's content and its promoted nodes could share one tree —
which would also sidestep the open question of whether a classic target
and a visual-layer target can share one window. The choice is deferred to
Phase 4 on purpose and settled by a probe rather than by taste, because
the visual layer's costs are the kind only a measurement prices: Windows
10 1803 as a floor; a `DispatcherQueue` on the thread that creates its
compositor; and no explicit `Commit`, where classic DirectComposition
commits exactly when told — the atomic frame the node model relies on.

Whichever holds it, Windows adds one rule to the promotion policy that
macOS did not need: a promoted node's surface is premultiplied unless its
box is opaque, and Direct2D draws text in grayscale rather than ClearType
on a premultiplied surface, so a node with text would visibly change its
text rendering as it promoted and demoted. A node promotes on Windows if it is
opaque or has no text. The rest of the policy — the z-order rule, the
one-second grace — is `promotion.js`'s and transfers either way.

### Swapchains where they belong

- **`<glarea>`**: GL on Windows means ANGLE — EGL and GLES translated to
  Direct3D 11, what Chromium, Firefox and Qt ship — presenting into a
  composition swapchain on a child visual, the way the Cocoa `<glarea>` is
  an IOSurface sublayer; its waitable object paces that visual. Desktop
  OpenGL through the vendors' drivers exists too, but reaching a
  composition visual from it needs `WGL_NV_DX_interop2`, a driver's promise
  rather than the system's. ANGLE is two DLLs to ship, optional the way
  `x11-dri` is.
- **Element-owned surfaces**
  ([architecture/element-layer-contents.md](architecture/element-layer-contents.md)):
  a visual with a surface of its own, so a terminal's or a chart's frame is
  its own `BeginDraw` and the window's `Commit`, with the window's surface
  untouched — the constant-cost flip that design wants.
- **Video**: Media Foundation decodes into NV12 textures, and a YUV
  swapchain on its own visual lets the display's overlay planes scan it
  out without a composition pass, where the GPU has them. Its own design,
  later ([architecture/video.md](architecture/video.md) is the record on
  the other backends).
- The **composition swapchain** API of Windows 11 (present at a target
  time, per-buffer availability, statistics that include the displayed
  time) belongs to these three, not to the 2D surface.

## Text: DirectWrite behind the engine contract

The contract is the one `src/cocoa/fonts.js` states at its top, and the
Windows engine answers it over DirectWrite — the decision macos.md made for
CoreText, for the same reasons: the platform's text system is what makes
text look like the platform's, and fontconfig-shaped font resolution is
what issue #86 documents going wrong off Linux. DirectWrite is used on the
JS thread only, one layout at a time, which sidesteps the question
Microsoft's documentation leaves open — whether a shared factory is safe to
use from several threads at once.

| contract                                                                                    | DirectWrite                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fonts.layout(spans, base, { maxWidth, align, lineHeight, maxLines, overflow, direction })` | an `IDWriteTextLayout` over the joined string, the spans as formatting ranges — family, size, weight, style, and a drawing effect for colour; width, alignment and reading direction as its properties; `lineHeight`, a multiplier over the natural line height, as proportional line spacing                              |
| `width`, `height`, `lines`                                                                  | `GetMetrics`, `GetLineMetrics` — in DIPs, answered in whole pixels per the yoga content-floor rule                                                                                                                                                                                                                         |
| `indexAt`, `caretPosition`, `rangeBands`                                                    | `HitTestPoint`, `HitTestTextPosition`, `HitTestTextRange`. DirectWrite is UTF-16 like CoreText, so the code-point conversion stays at the same boundary                                                                                                                                                                    |
| `draw(ctx, x, y)`                                                                           | `DrawTextLayout` on the device context, colour fonts enabled                                                                                                                                                                                                                                                               |
| the min-content floor — a width offer of zero                                               | `DetermineMinWidth` answers it natively, where CoreText cannot, which is why the Cocoa engine breaks at the `linebreak` package's opportunities itself. Keeping the `linebreak` rule on both native backends makes them agree on where a line may break; whether DirectWrite's own breaker already agrees is a measurement |
| eliding, `maxLines`                                                                         | trimming with an ellipsis sign for one line; for several, the cap and the cut are made in the text, as `cappedToEllipsis` does on Cocoa                                                                                                                                                                                    |
| `fonts.match`, the generic families                                                         | the system font collection: `sans-serif` and `system-ui` → Segoe UI (Segoe UI Variable on Windows 11, which carries an optical-size axis the way SF does); `monospace` → Consolas, or Cascadia Mono where installed                                                                                                        |
| `fonts.fallbackFor(cp)`                                                                     | the system font fallback (`IDWriteFontFallback::MapCharacters`)                                                                                                                                                                                                                                                            |
| the face — `metrics`, `hasGlyph`, `glyphIdFor`, `advanceOf`, `shape` — and `ctx.drawGlyphs` | `IDWriteFontFace`'s glyph indices and design metrics, `IDWriteTextAnalyzer` for `shape`, `DrawGlyphRun`: the #432 run contract the terminal component draws with                                                                                                                                                           |
| `openFont`, `loadFont`                                                                      | an in-memory font file loader (Windows 10 1703) and a font set of the app's own; variable axes through `IDWriteFontFace5`; the WOFF unwrapping in `fonts.js` carries                                                                                                                                                       |

Rendering quality is the one place Windows differs from macOS in kind:
Windows users still see ClearType — subpixel antialiasing — through most of
the system, where macOS dropped it. Direct2D draws ClearType only onto a
target whose alpha is ignored, and silently falls back to grayscale on any
other, which is why an ordinary window's surface is created that way, why
`<popup transparent>` accepts grayscale, and why promotion has the rule
above. Colour glyphs — emoji — draw through the COLR tables DirectWrite
has read since Windows 8.1; COLRv1 is still a preview API.

The recorded alternative is macOS's again: ntk's fontkit shaping and the
Wayland plan's `'2d-sw'` rasterizer, for byte-identical metrics across
backends at the cost of platform-correct text. The seam keeps it
swappable; the default is DirectWrite.

## Input

### Pointer

- The mouse stays on the classic messages: `WM_MOUSEMOVE`, the button
  messages, `WM_MOUSELEAVE` from `TrackMouseEvent` (the X11 leave), and
  `SetCapture` while a button is held, which keeps a drag's motion coming
  after the pointer leaves the window. Click counting stays the renderer's
  (`detail`), with the double-click interval and distance from
  `GetDoubleClickTime` and `SM_CXDOUBLECLK` where X11 reads XSETTINGS.
- The wheel's unit is `WHEEL_DELTA`, 120 to a notch. A precision touchpad
  sends high-precision wheel messages by default — deltas as small as 1 —
  and the only opt-out is a setting in the executable's manifest, so an
  addon always gets them; the wheel pipeline already takes fractions of a
  notch as `smooth` scrolling. `SPI_GETWHEELSCROLLLINES` says what a notch
  is worth. Whether Windows adds inertia to those messages on its own is a
  probe.
- Pen and touch arrive as `WM_POINTER` messages whether or not the mouse
  does; Chromium takes exactly those two there and the mouse on the classic
  messages. Making the mouse a pointer too is `EnableMouseInPointer`, a
  switch for the whole process that can be thrown once and never undone,
  which an addon inside `node.exe` has no business throwing. The mouse
  messages Windows synthesizes from pen and touch carry a signature
  (`GetMessageExtraInfo`) that is per thread — read in the window procedure
  on the UI thread and forwarded with the event — and are dropped where the
  pointer message was already handled.
- Touchpad inertia, pinch and rubber-banding the way Windows' own apps have
  them is Direct Manipulation: on `DM_POINTERHITTEST` for a touchpad
  contact, the UI thread hands the contact to a viewport, and Direct
  Manipulation recognizes the pan and the inertia — what Chromium, Firefox
  and Flutter do, on their UI threads. On the visual layer
  `InteractionTracker` is the same thing inside the compositor. Phase 5:
  the wheel path scrolls correctly without it.

### Keyboard

- The UI thread runs `TranslateMessage`, which queues the `WM_CHAR` a key
  typed behind its `WM_KEYDOWN`. The addon pairs them — the down, then the
  characters it produced, peeked off the queue — so JS sees one event with
  `keysym`, `codepoint`, `key` and `repeat`, the shape `events.js` reads on
  every backend. winit does the same, with a queue of pending events,
  because peeking can re-enter the window procedure through sent messages.
  Characters outside the Basic Multilingual Plane arrive as two `WM_CHAR`s,
  joined before they cross.
- `keysym` comes from the virtual-key code through a table like
  `keymap.js`'s kVK one for the editing, navigation and function keys, and
  from the typed character otherwise, by the X rule the Cocoa keymap
  already implements: Latin-1 as itself, the rest at `0x01000000` plus the
  code point.
- **Shortcuts under other layouts** come from the virtual key, and the
  layouts already assign those the way `accelerators: 'latin'` wants: the
  Russian layout gives each letter key the VK of the QWERTY letter in the
  same position, and AZERTY gives each key the VK of the letter printed on
  it. Ctrl+C is where the user expects it under both, with no code of ours.
- **AltGr** arrives as Right-Alt with a synthesized Left-Control in front of
  it. The addon drops a Left-Control whose next queued message is the
  Right-Alt with the same timestamp, on layouts that have AltGr — the rule
  winit, Qt, GLFW and SDL share — and reports the level shift it is, so `@`
  on a German layout types and never matches a Ctrl+Alt chord. The known
  issue the README lists for X11 is absent here, as on Cocoa.
- Dead keys compose in the layout itself (`WM_DEADCHAR`, then the composed
  `WM_CHAR`), so this backend defaults `compose` to the system's, as the
  Cocoa one gets the character with the event — and nothing calls
  `ToUnicodeEx` without the flag that keeps it from consuming the dead-key
  state.
- **The keyboard can have a press state.** A held key repeats as
  `WM_KEYDOWN` with the previous-state bit set and no key-up in between,
  where X11 sends release/press pairs for auto-repeat — which is why
  AGENTS.md lists "the keyboard has no press state" as a known gap. On this
  backend `:active` for a held Space or Enter is drawable.
- `useKeyboardState()`: `GetKeyState` for the locks before the first key,
  `WM_INPUTLANGCHANGE` for the layout.

### IME

Input methods are where this backend can be ahead of both shipped ones:
X11 has none ([#272](https://github.com/sidorares/react-x11/issues/272)) and
Cocoa's `NSTextInputClient` is unbuilt. The surface they arrive on exists
already — the composition state machine in `events.js`
(`CompositionStart`, `Update`, `End`, each defaultable) and the preedit
model in `src/nodes/preedit.js`, which keeps a composition out of the value
and the undo history. Two Windows APIs can feed it:

| toolkit                    | IME API                                                         |
| -------------------------- | --------------------------------------------------------------- |
| Chromium                   | TSF (`ui/base/ime/win/tsf_text_store.cc`)                       |
| Firefox                    | TSF, with an IMM32 fallback (`widget/windows/TSFTextStore.cpp`) |
| Qt 6, winit, Flutter, SDL3 | IMM32                                                           |
| GLFW                       | no composition at all                                           |

- **IMM32** — `WM_IME_STARTCOMPOSITION`; `WM_IME_COMPOSITION`, with
  `ImmGetCompositionString` for the preedit, its cursor, its clause
  attributes and the committed result; `WM_IME_ENDCOMPOSITION`; and
  `ImmSetCompositionWindow`/`ImmSetCandidateWindow` fed from the caret rect
  JS pushed. Every message carries its payload, so the UI thread forwards
  and nothing waits. Reconversion works through it (Qt handles it). What
  it misses: Windows has stopped loading IMM32 input methods, so every
  modern one — the new Microsoft Japanese and Chinese IMEs included — is a
  TSF text service reaching an IMM32 window through a compatibility layer,
  and what that layer does not carry is voice typing (Win+H inserts
  nothing), the shell's handwriting, and shape-writing on the touch
  keyboard.
- **TSF** — the application implements a text store (`ITextStoreACP2`) that
  the input method queries synchronously, on the thread that activated TSF:
  the text around the caret, the selection, the screen rectangle of any
  range. A synchronous lock request must be granted inside the call or
  refused, and a rectangle may be answered "no layout yet" — so the store
  never waits on JS. It answers from a mirror of the focused field — a
  window of its text, the selection, the caret geometry — pushed per commit
  and versioned, with edits flowing back as events and change notifications
  flowing out when JS rewrites the field under an open composition.

**IMM32 first, TSF as the target.** IMM32 fits the threading rules with no
mirror and carries CJK composition and candidate lists; TSF is Phase 5,
with a mirror scoped to the focused field and nothing else. The touch
keyboard, separately, appears for a focused text field because UI
Automation says it is one — not because of either API (§Accessibility).

## Windowing semantics: what maps, what bends, what breaks

| react-x11 today                                    | Windows                                                                                                                                                                                                                                                         | verdict                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `<window>`, WM-managed                             | a top-level HWND; geometry, activation and close requests arrive as messages on the UI thread                                                                                                                                                                   | maps; the app places itself, unlike on Wayland                                                     |
| `<window x y>`                                     | `SetWindowPos` in virtual-screen coordinates, which go negative left of and above the primary monitor                                                                                                                                                           | maps                                                                                               |
| auto-sizing                                        | measure, then size before the first show — the `realize()` order                                                                                                                                                                                                | maps                                                                                               |
| `<popup>`                                          | an owned `WS_POPUP` with `WS_EX_NOACTIVATE` and `WS_EX_TOOLWINDOW` (no taskbar button, no Alt+Tab entry), placed by `anchor.js` against the monitor's work area; rounded and shadowed on Windows 11 by asking DWM, which treats the corner preference as a hint | maps — client-side placement survives, as on macOS                                                 |
| `<popup grab>` dismissal                           | no cross-application pointer grab: `SetCapture` holds only while a button is down, so dismissal watches the owner's activation and presses in the app's other windows                                                                                           | bends — the same behaviour by another mechanism                                                    |
| `decorations: false`, a drawn titlebar             | `WM_NCCALCSIZE` returns 0, `DwmExtendFrameIntoClientArea` keeps the shadow and snapping, `WM_NCHITTEST` answers from pushed regions — `HTMAXBUTTON` for Snap Layouts — and caption buttons route through `DwmDefWindowProc`                                     | maps, given a region API (open question 7)                                                         |
| maximized, minimized, fullscreen, attention        | `ShowWindow`; a borderless monitor-sized window; `FlashWindowEx`                                                                                                                                                                                                | maps                                                                                               |
| `alwaysOnTop`, `skipTaskbar`, `below`              | `HWND_TOPMOST`; `WS_EX_TOOLWINDOW` or `ITaskbarList::DeleteTab`; `HWND_BOTTOM`, which is not kept                                                                                                                                                               | maps — more of `_NET_WM_STATE` than macOS keeps; `sticky` and `shaded` have no public equivalent   |
| `transientFor`                                     | the owner window, set at creation                                                                                                                                                                                                                               | maps — an owned window stays above its owner and minimizes with it                                 |
| `wmClass`                                          | the window's AppUserModelID and relaunch properties, which decide taskbar grouping and what pinning pins                                                                                                                                                        | bends — the identity exists, under another name                                                    |
| `transparent`                                      | `WS_EX_NOREDIRECTIONBITMAP` and premultiplied DirectComposition content                                                                                                                                                                                         | maps better — always composited; `useSupports('transparency')` is constant-true                    |
| frame clock (Present, fence, estimator)            | the compositor clock or the vblank, and on Windows 11 the compositor's statistics                                                                                                                                                                               | simpler, and on Windows 11 photon time is measurable                                               |
| the scale ladder                                   | per-monitor-v2 on the UI thread; `WM_DPICHANGED` with the suggested rect taken as given                                                                                                                                                                         | collapses to one live answer, fractional most of the time — and live means re-scaling (§Layout)    |
| `useScreens()`                                     | `EnumDisplayMonitors`; `GetMonitorInfo`, whose work area is `available` exactly where X11's is an approximation; names and refresh rates from the display-configuration API; `WM_DISPLAYCHANGE` — queried on the UI thread, which is DPI-aware, and published   | maps                                                                                               |
| clipboard                                          | `CF_UNICODETEXT`, `CF_HDROP`, `HTML Format`, PNG; delayed rendering for lazy payloads, answered on the owner window's thread; `AddClipboardFormatListener` for `watch()`; no `PRIMARY`                                                                          | maps; `transfer.js`'s MIME plumbing is reusable                                                    |
| drag and drop                                      | OLE — `RegisterDragDrop` and `IDropTarget`, `DoDragDrop` and `IDropSource`, shell drag images; virtual files for a drag out that makes its file on demand. Windows' integrity levels refuse a drop from Explorer into an elevated app                           | maps — the `dropAccept`/`onDrag*`/`dragData` contract holds, and JS keeps running through the drag |
| global menu                                        | none: the drawn `MenuBar`, the fallback path anyway; a native `HMENU` bar as an opt-in rung; `ContextMenu` over `TrackPopupMenuEx` as its native rung, as `NSMenu` is on Cocoa                                                                                  | bends                                                                                              |
| `<foreign>`                                        | a cross-process child window is allowed, and costly in a known way: the two programs' input queues are attached, so a hung child hangs the parent; no XEmbed focus protocol                                                                                     | bends                                                                                              |
| `<Frame>`                                          | the host makes a composition surface handle and hands it to the pane, which presents into it through a swapchain made for it — the IOSurface design, with the host's visual tree showing what the pane draws                                                    | maps                                                                                               |
| `examples/wm.jsx`, framing other programs' windows | —                                                                                                                                                                                                                                                               | **gone by design**                                                                                 |
| startup notification, `activateWindow`             | Windows' own launch feedback; `SetForegroundWindow` under the foreground rules, where the second instance forwarding a URI first grants the running one the right to come forward (`AllowSetForegroundWindow`)                                                  | dissolves; the raise maps, with its own version of the X11 timestamp lesson                        |
| URI schemes, single instance                       | the scheme registered under `HKCU\Software\Classes` (no admin — the `.desktop` file's job), a named pipe or `WM_COPYDATA` to the running instance                                                                                                               | maps — the two-copies shape `application.js` already handles                                       |
| tray                                               | `Shell_NotifyIcon`, its menu through `TrackPopupMenuEx`                                                                                                                                                                                                         | **gained**; X11's StatusNotifierItem stays #353                                                    |
| `<glarea>`                                         | ANGLE into a composition swapchain                                                                                                                                                                                                                              | bends — two DLLs to ship                                                                           |
| eyedropper                                         | no system sampler: a rung of our own, reading the screen without a permission prompt; windows that exclude themselves from capture read as absent                                                                                                               | maps — the X11 rung's shape                                                                        |
| global key grabs                                   | `RegisterHotKey`, system-wide, no admin — registered against a window on the UI thread, because a thread hotkey's message is eaten by modal loops; a combination another app holds fails, and the Windows-key combinations are reserved                         | maps — which macOS allows only behind a permission                                                 |
| `ssh -X` remoting                                  | —                                                                                                                                                                                                                                                               | the X11 backend remains the remote answer                                                          |

The `<popup>` row is macOS's conclusion, not Wayland's: Windows keeps
client-side placement, so `anchor.js` stays the single source of truth,
reading monitor work areas instead of Xinerama. The row that is new is the
titlebar: a drawn one works on every backend today by moving the window
from `onMouseMove`, and on Windows that loses snapping, the Snap Layouts
flyout and the system's own drag — which is why the region API is an open
question for all four backends rather than a Windows-only prop.

## The desktop around the app

Every ladder in the README gets a Windows rung or an honest floor. The
D-Bus and portal rungs are absent (§"What already carries over"); the
shell-out rungs have Windows equivalents only where they are worth having.

| what                                           | the Windows rung                                                                                                                                                                                                                                                                                                                                                                          | below it                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| open/save panels, `useFileDialog()`            | the Common Item Dialog (`IFileOpenDialog`, `IFileSaveDialog`), parented to the window, its modal loop on the UI thread                                                                                                                                                                                                                                                                    | the dialog react-x11 draws                                               |
| notifications, `notify()`                      | toasts, which Windows shows only for an AppUserModelID it knows: a Start-menu shortcut carrying it, or its registration in the registry; the Windows App SDK's notification manager registers an unpackaged app for you, and brings its runtime                                                                                                                                           | a tray balloon, which Windows shows as a toast; then "unsupported", said |
| light/dark and accent, `useSystemAppearance()` | `UISettings` (the accent and foreground colours, text scale and animation settings, each with a change event, which arrives off the UI thread and is marshalled to it) and the apps-use-light-theme preference under `HKCU`; high contrast from `SPI_GETHIGHCONTRAST`; reduced motion from `SPI_GETCLIENTAREAANIMATION`; the window frame follows through `DWMWA_USE_IMMERSIVE_DARK_MODE` | the answer remembered on disk, as today                                  |
| permissions, `usePermission()`                 | none to ask: the capability-status API is for packaged apps, and an unpackaged one sits under a single "desktop apps" switch per device. The capture API's access-denied is the answer, and `ms-settings:privacy-webcam` and its siblings are the Settings-pane rung                                                                                                                      | `'unknown'` until something is attempted                                 |
| the user's calendar                            | the appointments API wants package identity                                                                                                                                                                                                                                                                                                                                               | `supported: false` unless packaged                                       |
| sampling a screen colour, `useEyedropper()`    | our own: the screen read through GDI — no consent, no capture border — plus a drawn loupe                                                                                                                                                                                                                                                                                                 | —                                                                        |
| a badge on the icon, `setBadge()`              | a taskbar overlay icon (`ITaskbarList3::SetOverlayIcon`) with the count drawn into it, once the taskbar button exists                                                                                                                                                                                                                                                                     | —                                                                        |
| the Dock menu, `useDockMenu()`                 | a jump list, whose tasks relaunch the app with arguments that arrive through the single-instance path                                                                                                                                                                                                                                                                                     | —                                                                        |
| a tray icon, `useTray()`                       | `Shell_NotifyIcon`                                                                                                                                                                                                                                                                                                                                                                        | —                                                                        |
| progress on the icon                           | `ITaskbarList3::SetProgressValue`                                                                                                                                                                                                                                                                                                                                                         | **gained** — no hook exists yet                                          |

## Accessibility: UI Automation

[architecture/accessibility.md](architecture/accessibility.md) records the
AT-SPI bridge's central decision: **no mirror tree**. Every call is
answered from the live node tree when it arrives, which works because
AT-SPI's calls arrive on the bus, asynchronously, and JS answers them when
it gets to them. UI Automation changes the premise that decision rested
on.

A UIA provider is a set of COM objects — element, fragment and
fragment-root providers, and one per control pattern (Invoke, Toggle,
Value, RangeValue, ExpandCollapse, Selection, Scroll, Text) — handed to UIA
from `WM_GETOBJECT`, and UIA calls their methods synchronously and often:
one focus change is dozens of property reads. Where the calls arrive
depends on a flag. With `ProviderOptions_UseComThreading`, which Chromium
sets, they arrive on the provider's own apartment — the UI thread; without
it, on UIA's threads. So a provider that answered from the live tree would
block a thread on JS for every read: the UI thread, freezing input while a
screen reader reads, or a UIA thread, waiting on every read for JS to be
idle — through a React commit, a layout, a paint. It is legal — a client
waits 20 seconds by default — but it paces the screen reader by the app's
busiest moment.

**So the lean on this backend is the mirror, deliberately, and AccessKit
is the one to use.** Its Windows adapter serves UIA from a tree the app
pushes and answers from its own copy on UIA's threads, with text ranges for
single- and multi-line inputs (rich text not yet), and it links into a C++
addon through its C bindings. The push is what the AT-SPI bridge already
computes for its events: `a11y.js`'s model is pure functions over the live
tree, and the bridge's per-node snapshot of what the bus was last told is
the diff an AccessKit update is made of. Actions — invoke, set a value,
focus, scroll into view — come back as requests JS handles asynchronously.
It is Chromium's shape too: the browser answers UIA from its own copy of
the page's tree. And AccessKit's macOS adapter would fill the Cocoa
backend's missing `NSAccessibility` bridge from the same push. The cost is
the one architecture/accessibility.md named — a second copy of the truth,
kept honest here by the snapshot diff rather than by construction — and it
is paid because UIA's synchronous calls make it the cheaper side of the
trade, not because the AT-SPI decision was wrong.

The alternative on record is a provider of our own answering from the live
tree through a bounded wait — no mirror, parity with AT-SPI — whose risk is
exactly the latency above. Phase 5 measures the two against Narrator and
NVDA before the choice is final; whether JAWS and NVDA read a UIA-only
tree as well as they read an IAccessible one is part of that measurement.
Either way UIA does a second job here: the touch keyboard appears for a
focused text field because UIA says it is one.

## Testing

- **Any OS, in CI**: the backend's JS half against a fake bridge, the way
  the Cocoa backend's 22 `test/cocoa-*.test.js` files run on Linux today —
  including the pixel-holding fake `test/cocoa-scroll-blit.test.js` uses to
  prove a blit against a repaint, which a DirectComposition `Scroll` needs
  just as much.
- **On a Windows runner**: GitHub's hosted runners have an interactive
  desktop in practice (at 1024×768), `windows-latest` is Windows Server
  2025, and ARM64 runners are generally available for public repositories.
  Real windows there, over WARP when there is no GPU; the composited window
  read through `PrintWindow` with `PW_RENDERFULLCONTENT` — undocumented on
  Microsoft Learn, relied on by WebRTC and Firefox for exactly this content,
  and stable only once the commit has completed; input posted into the
  window procedure through the bridge, the way `postMouseEvent` drives the
  Cocoa pump, and `robotjs` where the test wants the real input stack.
- **Fractional scale first**: the interaction tests run at 1.25 and 1.5, not
  only 1 and 2, and a window crossing between two scales is a test of its
  own. Logical and device pixels part company on every event, and a test at
  scale 1 cannot see which of the two a coordinate is in.
- `react-x11/test` keeps driving X11, as it does on macOS; a `'win32-mock'`
  harness backend is macos.md's Public API item 6 again.
- **The bench twin**: `npm run bench:presenters`' scenarios and its
  structural gate — full-window frames, frames per resize tick, frames for a
  window nobody can see — ported, plus the number no other backend can
  report: input-to-photon from the compositor's statistics, on Windows 11.

## Packaging and identity

- `node app.js` works, with two problems that are cosmetic only to a
  developer. `node.exe` is a console program, so launched from a shortcut it
  opens a console window. And the taskbar groups every `node.exe` window
  together under Node's icon, and pinning pins `node.exe` — the Windows
  version of the menu bar saying "node". The second is the addon's to fix:
  each window gets the app's AppUserModelID and relaunch properties (from
  the `appId` `registerApplication()` already takes) and the app's icon.
  The first is a packaging step.
- A **single executable** ([packaging.md](packaging.md) tier 3;
  `node --build-sea` since Node 25.5) is a copy of `node.exe` with the app
  inside, and its resources can be rewritten after the build: a manifest of
  the app's own with `rcedit`, the GUI subsystem with
  `editbin /SUBSYSTEM:WINDOWS`, then the signature. At that point the
  brief's manifest advice applies in full. Windows 11 24H2 adds a manifest setting that detaches the console
  when launched from Explorer and keeps it in a terminal. The addon rides
  beside the executable through `createRequire(process.execPath)`, as the
  Cocoa one does, with an environment variable naming it for a compiled
  bundle, as `REACT_X11_CALAYERS_PATH` does there.
- `bun build --compile` targets Windows with `--windows-hide-console` and
  icon and metadata flags, and no way to supply a manifest — and `bun.exe`'s
  own manifest has no compatibility section, which Microsoft documents as
  running the process in Vista compatibility mode. What that changes for
  DWM and DPI is a probe.
- Distribution: Authenticode signing, which SmartScreen's reputation
  follows; and MSIX as an option — the package identity that unlocks the
  calendar, the capability-status API and declared protocol activation.
- packaging.md grows a Windows tier when there is a Windows build to verify
  it against.

## The plan

Each phase has an exit that makes the next one safe to start.

- **Phase 0 — the spike (days).** A minimal addon, before anything in this
  repository changes, proving the three risky mechanisms: the UI thread
  inside stock `node.exe` and `bun.exe`, with events through a threadsafe
  function and the input-to-JS latency measured; a DirectComposition
  surface driven from the JS thread — `BeginDraw` per rect, `Scroll`,
  `Commit` — while the UI thread sits in a live-resize loop, with the
  bounded resize handshake and the background plate; and `WM_NCHITTEST`
  from pushed regions, the Snap Layouts flyout included. _Exit: during a
  live resize a JS-driven relayout tracks the drag, and a JS timer keeps
  animating while a `TrackPopupMenuEx` menu is open and while a
  `DoDragDrop` is in flight._
- **Phase 1 — the shared floor.** Move the context wrapper, `surface.js`,
  the frame queue and the promotion policy out of `src/cocoa/` into
  `src/backend/` (macos.md §"The split", step 4), with the Cocoa backend
  byte-identical — its fake-bridge tests and `bench:presenters -- --check`
  pin it. _Exit: Cocoa unchanged; the verb table written down as the bridge
  contract._
- **Phase 2 — the surface backend.** `src/win32/` — app, window, context,
  text engine — over `@windowkit/win32` 0.1: windows, the event channel,
  the Direct2D verb table, DirectWrite; `createRoot({ backend: 'win32' })`,
  and `'auto'` choosing it on Windows when the bridge is installed.
  _Exit: `examples:widgets`, `tasks` and `form` fully interactive on
  Windows; the fake-bridge suite green on every OS; bench-twin baselines
  recorded._
- **Phase 3 — input, scale and the desktop.** IMM32 composition; the
  clipboard and drag and drop over OLE; live per-window scale (§Layout),
  monitors, appearance and window state; file dialogs, notifications, the
  tray and the taskbar; single instance and URI schemes. _Exit: a window
  dragged between a 100% and a 150% monitor re-lays out at each; every
  ladder in the README has a Windows rung or an honest floor, each verified
  on hardware._
- **Phase 4 — the compositor tier.** Promotion onto composition visuals,
  with the classic-or-visual-layer question settled by its probe;
  element-owned surfaces; `<glarea>` over ANGLE. _Exit:
  `examples/animation.jsx`'s loops keep running through its deliberate JS
  block, as they do on Cocoa._
- **Phase 5 — the deep integrations.** UI Automation; TSF; Direct
  Manipulation; input-to-photon on the dashboard. _Exit: Narrator and NVDA
  read the widgets example the way Orca reads it, and a Japanese IME
  composes in place with its candidate list at the caret._

## What to probe first

The checklist for the first session on a Windows machine, in the order the
design depends on the answers:

1. **The UI thread inside `node.exe`**: an HWND on a thread the addon
   started, events through a threadsafe function, the command queue woken
   through a message-only window; input-to-JS latency (a performance-counter
   stamp at the message against one in the handler), idle and under a busy
   JS loop; then the same under `bun.exe`, whose threadsafe functions have a
   reported Windows panic.
2. **Modal loops**: a JS `setInterval` keeps its cadence through a live
   resize, a `TrackPopupMenuEx` menu, a `DoDragDrop` into Explorer and an
   `IFileDialog::Show` — and the command queue keeps draining inside each.
3. **DirectComposition across threads**: the device, and a target for the
   UI thread's window, created on the JS thread, as the documentation
   allows; `Commit` from JS while the UI thread is inside a modal loop; the
   background plate's device and the content's device in one tree.
4. **Surface costs**: what `Scroll` does exactly and what it costs —
   neither browser calls it; what several `BeginDraw`s in one frame cost
   against one covering their union; a virtual surface's resize under a
   live drag.
5. **Resize**: the bounded wait inside `WM_SIZE`, what DWM shows when the
   deadline is missed, and whether returning needs the commit to have been
   composed first — Flutter calls `DwmFlush` after the frame of the new size.
6. **Scale**: `WM_DPICHANGED` and `WM_GETDPISCALEDSIZE` on a two-monitor
   desk at 100% and 150%; the interim content-visual scale; what
   `bun.exe`'s missing compatibility section changes.
7. **Text**: ClearType on an alpha-ignored surface; `DetermineMinWidth`
   against the `linebreak` floor; Segoe UI Variable's optical size.
8. **Input**: whether Windows adds inertia to a precision touchpad's wheel
   messages; the AltGr rule on a German layout; the pointer/mouse split on
   a touch screen.
9. **IME**: the Windows 11 Japanese and Chinese IMEs through IMM32 —
   composition, clause attributes, the candidate window at a pushed caret.
10. **UI Automation**: AccessKit's adapter behind our window procedure;
    Narrator and NVDA on a two-button window; JAWS and NVDA on a UIA-only
    tree.
11. **Notifications**: a toast from an unpackaged `node.exe` with an
    AppUserModelID registered through a shortcut, and through the registry
    — whose hive the sources did not settle.
12. **CI**: an HWND, a DirectComposition surface over WARP and a
    `PrintWindow` capture on a GitHub-hosted Windows runner, x64 and ARM64.

## Open questions

1. **The bridge's name and language.** `@windowkit/win32`, in the windowkit
   organization beside `appkit`, is the lean — named for the API family it
   binds, as `appkit` is; C++ with node-addon-api, Rust the recorded
   alternative (§"The bridge").
2. **The backend's name.** `'win32'`, matching `process.platform` and the
   API family, the way `'cocoa'` names an API rather than an OS. The
   alternative is `'windows'`.
3. **Which composition API holds promoted and retained content** — classic
   DirectComposition or the visual layer. Phase 4's probe.
4. **The Windows floor.** Windows 10 1809 or later and Windows 11 —
   per-monitor-v2 needs 1703, the visual layer's desktop target 1803 — with
   the Windows 11 APIs (the compositor clock and its statistics, the DWM
   attributes, the system backdrop) as rungs rather than requirements; or
   Windows 11 only, which simplifies the frame clock and the photon
   measurement. Windows 10 reached end of support in October 2025, with
   paid extended updates after it.
5. **Text metrics across backends** — DirectWrite's, the default, or ntk's
   shared ones: macos.md's open question 5, sharper with a third backend.
6. **Accessibility** — AccessKit's pushed tree (the lean) or a provider of
   our own answering from the live tree, decided by Phase 5's measurement.
7. **A drag region in the API.** A drawn titlebar has to tell the platform
   which boxes are caption and which are buttons, for moving, snapping and
   Snap Layouts; X11 (`_NET_WM_MOVERESIZE`), Wayland (`xdg_toplevel.move`)
   and macOS have the same need. One cross-backend declaration on a
   `<box>`, not a Windows-only prop.
8. **Live per-window scale** is decided — Windows cannot ship without it —
   but its shape is not: `useScale()` becoming per-window and live is a
   public API change on every backend (§Layout).
9. **`x11-dri`'s name, again.** If `<glarea>` on Windows is ANGLE behind
   the same GLES API, the display-server-neutral GL addon wayland.md's open
   question 4 anticipated gains a third platform.

## References

Microsoft documentation:

- DirectComposition: [basic concepts](https://learn.microsoft.com/en-us/windows/win32/directcomp/basic-concepts)
  (threading, cross-device trees),
  [`IDCompositionSurface::BeginDraw`](https://learn.microsoft.com/en-us/windows/win32/api/dcomp/nf-dcomp-idcompositionsurface-begindraw),
  [`IDCompositionSurface::Scroll`](https://learn.microsoft.com/en-us/windows/win32/api/dcomp/nf-dcomp-idcompositionsurface-scroll),
  [`CreateTargetForHwnd`](https://learn.microsoft.com/en-us/windows/win32/api/dcomp/nf-dcomp-idcompositiondevice-createtargetforhwnd),
  [animation](https://learn.microsoft.com/en-us/windows/win32/directcomp/animation),
  [the compositor clock](https://learn.microsoft.com/en-us/windows/win32/directcomp/compositor-clock/compositor-clock).
- DXGI: [`DXGI_SWAP_EFFECT`](https://learn.microsoft.com/en-us/windows/win32/api/dxgi/ne-dxgi-dxgi_swap_effect),
  [`DXGI_PRESENT_PARAMETERS`](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/ns-dxgi1_2-dxgi_present_parameters),
  [the composition swapchain](https://learn.microsoft.com/en-us/windows/win32/comp_swapchain/comp-swapchain),
  [`DCompositionCreateSurfaceHandle`](https://learn.microsoft.com/en-us/windows/win32/api/dcomp/nf-dcomp-dcompositioncreatesurfacehandle).
- The visual layer: [using it with Win32](https://learn.microsoft.com/en-us/windows/uwp/composition/using-the-visual-layer-with-win32),
  [composition native interop](https://learn.microsoft.com/en-us/windows/apps/develop/composition/composition-native-interop).
- Direct2D and DirectWrite: [pixel formats and alpha modes](https://learn.microsoft.com/en-us/windows/win32/direct2d/supported-pixel-formats-and-alpha-modes)
  (ClearType), [primitive blend](https://learn.microsoft.com/en-us/windows/win32/api/d2d1_1/ne-d2d1_1-d2d1_primitive_blend),
  [multithreaded Direct2D](https://learn.microsoft.com/en-us/windows/win32/direct2d/multi-threaded-direct2d-apps),
  [`IDWriteTextLayout`](https://learn.microsoft.com/en-us/windows/win32/api/dwrite/nn-dwrite-idwritetextlayout).
- Input: [`EnableMouseInPointer`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enablemouseinpointer),
  [precision touchpad devices](https://learn.microsoft.com/en-us/windows/win32/w8cookbook/windows-precision-touchpad-devices),
  [`ITextStoreACP::RequestLock`](https://learn.microsoft.com/en-us/windows/win32/api/textstor/nf-textstor-itextstoreacp-requestlock),
  [input method requirements](https://learn.microsoft.com/en-us/windows/apps/develop/input/input-method-editor-requirements).
- Windows: [high DPI improvements for desktop applications](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-improvements-for-desktop-applications)
  (mixed-mode DPI), [custom window frames](https://learn.microsoft.com/en-us/windows/win32/dwm/customframe),
  [Snap Layouts](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-snap-layout-menu),
  [`DWMWINDOWATTRIBUTE`](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute),
  [`AllowSetForegroundWindow`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-allowsetforegroundwindow).
- Services: [`ProviderOptions`](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationcore/ne-uiautomationcore-provideroptions),
  [`RegisterDragDrop`](https://learn.microsoft.com/en-us/windows/win32/api/ole2/nf-ole2-registerdragdrop),
  [using the clipboard](https://learn.microsoft.com/en-us/windows/win32/dataxchg/using-the-clipboard),
  [sending a desktop toast](https://learn.microsoft.com/en-us/windows/win32/shell/quickstart-sending-desktop-toast),
  [`AppCapability`](https://learn.microsoft.com/en-us/uwp/api/windows.security.authorization.appcapabilityaccess.appcapability),
  [the Windows App SDK 2.0 release notes](https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/release-notes/windows-app-sdk-2-0).
- Raymond Chen on [cross-process parent and child windows](https://devblogs.microsoft.com/oldnewthing/20130412-00/?p=4683)
  and on [thread messages in modal loops](https://devblogs.microsoft.com/oldnewthing/20050426-18/?p=35783).

Source code:

- Electron [`shell/common/node_bindings_win.cc`](https://github.com/electron/electron/blob/main/shell/common/node_bindings_win.cc);
  NodeGui's [`qode` integration](https://github.com/nodegui/qode/blob/master/src/integration/node_integration_win.cc);
  libuv's [loop documentation](https://github.com/libuv/libuv/blob/v1.x/docs/src/loop.rst)
  (`uv_run` is not re-entrant); Node's [`src/node_api.cc`](https://github.com/nodejs/node/blob/main/src/node_api.cc)
  (threadsafe functions) and [`src/res/node.exe.extra.manifest`](https://github.com/nodejs/node/blob/main/src/res/node.exe.extra.manifest).
- Chromium: [`ui/gl/child_window_win.cc`](https://source.chromium.org/chromium/chromium/src/+/main:ui/gl/child_window_win.cc),
  [`ui/gl/dc_layer_tree.cc`](https://source.chromium.org/chromium/chromium/src/+/main:ui/gl/dc_layer_tree.cc),
  [`ui/gl/vsync_thread_win.cc`](https://source.chromium.org/chromium/chromium/src/+/main:ui/gl/vsync_thread_win.cc),
  [`ui/views/win/hwnd_message_handler.cc`](https://github.com/chromium/chromium/blob/main/ui/views/win/hwnd_message_handler.cc).
- Firefox [`gfx/webrender_bindings/DCLayerTree.cpp`](https://searchfox.org/mozilla-central/source/gfx/webrender_bindings/DCLayerTree.cpp);
  Flutter's [`flutter_windows_view.cc`](https://github.com/flutter/flutter/blob/master/engine/src/flutter/shell/platform/windows/flutter_windows_view.cc)
  (the resize wait); winit's [`keyboard.rs`](https://github.com/rust-windowing/winit/blob/master/winit-win32/src/keyboard.rs);
  GLFW's [`win32_window.c`](https://github.com/glfw/glfw/blob/master/src/win32_window.c).
- [AccessKit](https://github.com/AccessKit/accesskit) and
  [its C bindings](https://github.com/AccessKit/accesskit-c);
  [`winpane`](https://github.com/peteretelej/winpane);
  react-native-windows' [new architecture](https://microsoft.github.io/react-native-windows/docs/new-architecture);
  [`node-usb-detection`](https://github.com/MadLittleMods/node-usb-detection)
  and [`uiohook-napi`](https://github.com/SnosMe/uiohook-napi), message
  threads inside stock Node.

In this repository: [wayland.md](wayland.md) and [macos.md](macos.md),
whose inventories this reuses; [scale.md](scale.md),
[events.md](events.md), [accessibility.md](accessibility.md) and
[architecture/accessibility.md](architecture/accessibility.md),
[clipboard.md](clipboard.md), [drag-and-drop.md](drag-and-drop.md),
[uri-schemes.md](uri-schemes.md), [desktop.md](desktop.md) and
[packaging.md](packaging.md) — the per-feature contracts this plan maps
onto Windows.
