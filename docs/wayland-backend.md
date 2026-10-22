# The Wayland backend

**Status: a working backend, opt-in.** react-x11's own reconciler renders a
window on a real Wayland compositor (mutter/GNOME, sway, labwc) with
decorations — the compositor's where it draws them, client-side where it
does not — text, shadows, paths, images, live partial repaints, pointer,
touch, pen and keyboard input decoded against the compositor's keymap, an
input method, a clipboard, drag and drop, popups, layer-shell docks and
panels, and a screen capture with an eyedropper on top — drawn on the GPU
and handed over as dma-buf, on **Node or Bun**, with no X server and no
Xwayland anywhere in the path.

It implements the research RFC in [design/wayland.md](../design/wayland.md);
where the two disagree, this page is what ran. How it is built, what was
measured and what is left are in the
[design notes](../design/wayland-backend.md).

```bash
REACT_X11_BACKEND=wayland node your-app.mjs     # x11-dri >= 0.9 (native socket)
REACT_X11_BACKEND=wayland bun  your-app.mjs     # or Bun's bun:ffi transport
node examples/wayland-gl.mjs                    # GPU plasma, paced by the compositor
node examples/wayland-ui.mjs                    # every drawing primitive, no React
node --import tsx --test 'test/wayland/*.test.js'   # the suite: no display needed
```

The two packages it needs beyond react-x11's own are optional dependencies,
installed with it: [`@windowkit/wayland`](https://github.com/windowkit/wayland),
the protocol layer — a fork of `wayland-client` that passes file descriptors
— and [`x11-dri`](https://github.com/sidorares/node-x11-dri) 0.9 or later,
the GPU context and, on Node, the socket: Wayland passes file descriptors
(the keymap, shm pools, clipboard pipes) and Node's own sockets cannot. Under
Bun the socket is node-x11's `bun:ffi` transport instead.

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
- **Ask the app.** `root.app.backend === 'wayland'`, and `root.app.X` is a
  stand-in — no `display.screen`, no `X.require`. The examples print the
  transport they connected through (`connected via x11-dri` or
  `fdpass-bun`) and never import an X module at all.
- **Ask the desktop.** `xlsclients` and `xwininfo -root -tree` list Xwayland
  clients; a native window is absent from both. GNOME's Looking Glass
  (`Alt+F2`, `lg`, Windows tab) shows it as a `MetaWindowWayland`, and its
  frame is this backend's own titlebar rather than mutter's Adwaita frame,
  which only Xwayland windows get.

## What runs

| piece              | what an app gets                                                                        |
| ------------------ | --------------------------------------------------------------------------------------- |
| windows and popups | xdg toplevels and popups, fractional scale ([below](#windows-what-maps-what-bends))     |
| 2d context         | rects, rounded rects, paths, exact clips, gradients, patterns, images, text, glyph runs |
| `<glarea>`         | GLES drawing into a rectangle of the window, its children composited over it            |
| offscreen surfaces | the paint cache and scroll blits; a held `Surface` context draws at any time            |
| input              | pointer, keyboard decoded against the compositor's keymap, key repeat                   |
| touch and tablet   | fingers and pens drive the pointer, with pen fields; raw touches                        |
| input methods      | the compositor's IME (`zwp_text_input_v3`) into the composition events                  |
| decorations        | the compositor's frame where it offers one, client-side otherwise                       |
| layer surfaces     | docks, panels, wallpapers, overlays — wlr-layer-shell                                   |
| screen capture     | wlr-screencopy / ext-image-copy-capture; the eyedropper                                 |
| clipboard          | clipboard and primary selection                                                         |
| drag and drop      | both directions, in-app drops keep `e.items` by reference; no drag icon yet             |
| screens, keyboard  | `useScreens()` and `useKeyboardState()` ([system.md](system.md#on-wayland))             |
| tests              | `test/wayland/`: an in-process compositor, no display needed                            |

The keymap is the compositor's own, so AltGr and levels 3 and 4 work
because the keymap says which modifier they are, not because one is
assumed. Compositors do not repeat keys; the backend repeats them at the
seat's advertised rate.

**Touch and pen.** A finger or a tablet tool drives the same mouse events
as a mouse, and only those events carry `pointerType` (`'touch'`, `'pen'`,
`'eraser'`, `'mouse'`), `pressure`, `tiltX`/`tiltY`, `rotation`,
`distance` and `tangentialPressure`, in the DOM's names and ranges
([events.md](events.md#event-object)); a mouse event is unchanged. Only
the first finger of a gesture emulates the pointer. Every finger also
arrives raw on the window as `touchstart`/`touchmove`/`touchend`/
`touchcancel` (the X11 backend's XI2 names, with `touchId`), each with the
active `touches`, batched per touch frame. Barrel buttons map as the
desktop does — BTN_STYLUS is button 3, BTN_STYLUS2 button 2 — and a tool
leaving proximity releases whatever it still held.

**Input methods.** IBus or whatever the compositor runs reaches
`<textinput>` and `onCompositionStart`/`Update`/`End` exactly as a dead key
does. Keys the IME consumes never arrive as key events. A `sensitive`
field offers the IME no surrounding text and says `sensitive_data`;
`inputMode` on a `<textinput>` becomes the content purpose (`email`, `url`,
`tel`, …).

**`<glarea>`** is a rectangle of the window's own GPU target, not a child
surface: the area gets the shared GLES context with `viewport`, `scissor`
and `bindFramebuffer(null)` re-based on its rect, the tree's 2D is drawn
under it and the panes its children paint on are blended over it.

**Perspective images.** `ctx.drawImageProjected(image, m)` draws an image
through a 3×3 projection (a plane turned out of the page, as CSS
`rotateY()` in a `perspective` turns one) as one exact quad. It answers
`false` and draws nothing where a corner is behind the viewer, for the
caller to draw the part in front some other way. Only this backend has it
(XRender on glamor folds the image, CoreGraphics and Direct2D draw through
an affine matrix alone): test with `'drawImageProjected' in ctx` and tile
where it is absent.

**Glyph runs.** `ctx.drawGlyphs(op, src, positioned)`, for callers that
place their own glyphs (a terminal grid, a tabular column), is spelled as on
X11 and Cocoa: the op `ctx.Render.PictOp.Over`, the source
`ctx.createSolidPicture(r, g, b, a)` — or, as Cocoa also takes, a CSS
colour string, a premultiplied `[r, g, b, a]`, or `null` for the fill style
in force.

### Running the examples

Every example runs on this backend the way it runs on X11, with the display
taken away so nothing can fall back:

```bash
env -u DISPLAY REACT_X11_BACKEND=wayland bun examples/widgets.jsx   # or node --import tsx
```

Two are X11 by nature and say so: `examples/wm.jsx` is a window manager and
`examples/xeyes.jsx` reads the root window's pointer — neither has a
Wayland counterpart. `examples/viewer3d.jsx` draws its model here through
its direct half, GLES on the window's own GPU target — the same half X11
uses under `NTK_GL_POLICY=direct`.

Environment variables, for desktops with no screenshot API and for
debugging:

- `REACT_X11_WAYLAND_TRACE=1` writes a line per presented frame.
- `REACT_X11_WAYLAND_SNAPSHOT=/tmp/frame.png` writes the backing target of
  the first window at its 30th present (`REACT_X11_WAYLAND_SNAPSHOT_AT`
  changes which) — the pixels the compositor was handed, read back from the
  GPU.
- `REACT_X11_WAYLAND_FRAME_STALL_MS` is how long a frame callback may go
  unanswered before the window counts as not shown (2000; `0` turns that
  off) — see
  [A surface the compositor stops showing stops drawing](#a-surface-the-compositor-stops-showing-stops-drawing).
- `REACT_X11_GL_DEVICE` names the DRM node to render on.

The GPU context is made on `glPolicy.devicePath`, else on
`REACT_X11_GL_DEVICE`, else on the first render node, and a device named
either way is the only one tried. A machine with no render node at all — a
GitHub-hosted runner, a Hyper-V or VirtualBox guest — usually still has a
card node Mesa renders on in software, so the backend then tries each
`/dev/dri/card*` in turn; headless weston with its GL renderer accepts what
it makes on a hosted runner.

## Windows: what maps, what bends

The compositor owns placement, stacking and focus, so some of what a
`<window>` asks for on X11 means less here:

- **Position.** A toplevel cannot place itself: `x`/`y` on a `<window>` are
  ignored, not an error, and the compositor's placement is final. A
  toplevel's own position reads `0, 0`; no client knows where it is on
  screen.
- **Popups** are placed relative to their parent window, and the compositor
  slides and flips them to stay on screen — the policy `anchorRect` gets
  from react-x11 on X11. A press outside a grabbing popup, or Escape, is
  the compositor's to act on; it hides the popup and the tree hears
  `onDismiss` as it would on X11.
- **Focus and raising** are the compositor's to give. `focus()` asks
  through xdg-activation and is ignored without a recent user interaction;
  attention requests go the same way; `raise()` and `lower()` do nothing.
- **States.** Maximised, fullscreen and minimised map; there is no
  un-minimise request. Always-on-top, sticky and workspaces have no
  equivalent.
- **Size.** A window sizes itself, except while the compositor imposes a
  size — maximised, tiled, or mid-resize — when the size it asks for is
  not applied.
- **Type and class.** `windowType` matters only where layer-shell exists
  ([below](#layer-surfaces-docks-panels-wallpapers)); the window's class
  (`app_id`) is fixed at creation.
- **A window the compositor is not showing does not draw** — next section.

## A surface the compositor stops showing stops drawing

After the first present a window draws only when the compositor sends it a
frame callback, and a compositor is entitled never to send one to a
surface it is not showing — covered, on another workspace, minimised, the
screen locked. There is no timer-driven fallback, on purpose: painting
into a surface nobody sees is work for nothing.

The silence is **not an error**: nothing rejects, and React goes on
re-rendering into a window that does not draw, which from outside looks
like a hang. So the stall is reported twice over:

- **On stderr, once per window, in development**, when the window still had
  something to draw. One line, naming the compositor as the reason and saying
  the app is not hung.
- **In the tree**, as [`useWindowState().presenting`](system.md#presenting-and-the-wayland-frame-clock),
  which also folds into `visible` — so an app can stop animating and
  simulating rather than feeding a loop nobody is turning, which is what
  every map, chart and game on this backend wants anyway.

Nothing has to be done to recover: the pending frame callback fires the
moment the surface is shown again, drawing resumes and `presenting` flips
back. The deadline is two seconds; `REACT_X11_WAYLAND_FRAME_STALL_MS`
changes it, and `0` turns the watch off entirely, timer, warning and all.

## Decorations: whose frame

The backend draws its own titlebar where the compositor will not (mutter),
and asks for the compositor's frame where `zxdg_decoration_manager_v1` is
offered — wlroots (sway, labwc), KDE. When the compositor agrees, the
client-side frame goes away and the content grows into the whole surface,
which the tree sees as a resize; a window not yet shown comes up the size
it was declared, not a titlebar taller.

`createRoot({ decorations })` says what to ask for: `undefined`/`true`/
`'server'` prefer the compositor's frame, `'client'` never asks for it, and
`false` — as does `<window decorations={false}>` — wants no frame at all.
A frameless window still creates the decoration object where the protocol
exists, to _decline_ server-side: sway frames every toplevel that has not
said `client_side`.

## Layer surfaces: docks, panels, wallpapers

Where the compositor advertises `zwlr_layer_shell_v1`, a `<window>` whose
`windowType` is one of these is not an `xdg_toplevel` but a layer surface,
the same `wl_surface`, frame loop and input underneath:

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
an ordinary toplevel. Popups from a layer surface work (a dock's menus). A
stretched axis is the compositor's: `resize()` on it is not granted, and
the configured size wins. Without layer-shell — GNOME — the same JSX is a
toplevel.

## Screen capture, and the eyedropper

`app.screenCapture` is there when the compositor offers either
`ext_image_copy_capture_manager_v1` (wlroots 0.19+, KDE 6.2+) or
`zwlr_screencopy_manager_v1` (sway 1.10 has this one), and null otherwise
(GNOME). `capture({ output, cursor })` resolves to one frame of the output
as straight RGBA, `{ width, height, data }`; `pixelAt(x, y)` to one device
pixel of it, as 0–255 channels. Each call is a fresh capture of the whole
output — for many pixels, `capture()` once; for anything per frame, not at
all.

`pickColor()` is the eyedropper, the way every wlroots colour picker works:
it freezes the output into a capture, shows it as a full-screen
layer-shell overlay that takes the keyboard, and reads the pixel under the
click — so it needs layer-shell as well as a capture protocol. Escape
cancels; Return, space and KP_Enter pick at the pointer. It answers
`{ r, g, b }` in 0–1. `useEyedropper()` uses it below the Screenshot portal
(the desktop's own, user-consented picker — GNOME's only route, and what
sway with xdg-desktop-portal-wlr uses too), so `useEyedropper().supported`
is true on a bare sway. Where the compositor has neither the portal's
picker nor capture plus layer-shell, `supported` is false: leave the
eyedropper button undrawn.

Two limits. With several outputs, the one captured by default is the one
the compositor advertised last; `capture({ output })` and
`layerShell.output` take another `wl_output` proxy. And a portal dialog (file chooser, colour picker) is modal
to its window only where the compositor has **xdg-foreign**; without it, or
from a popup, the dialog floats.

## Under a second compositor

The backend runs on sway and labwc as well as mutter, nested
(`WLR_BACKENDS=wayland`) or headless (`WLR_BACKENDS=headless`). Headless
sway plus `grim` is a way to screenshot an app with no desktop at all —
`grim` needs wlr-screencopy, which mutter refuses:

```bash
WLR_BACKENDS=headless sway -c sway.conf &          # output * resolution 1280x800
WAYLAND_DISPLAY=wayland-1 REACT_X11_BACKEND=wayland node --import tsx examples/simple.jsx &
WAYLAND_DISPLAY=wayland-1 grim shot.png
```

## Not supported yet

- **Multisampling.** Paths filled with a gradient, solid paths larger than
  512×512 after clipping, and clips to anything but one axis-aligned
  rectangle have aliased edges; rounded rectangles, smaller solid paths and
  text are antialiased.
- **`<Frame>` panes.** A `<Frame>` fails at once: its `fallback` renders and
  no pane is started ([frame.md](frame.md)).
- **The drag icon.** Drag and drop works both ways, but the drag shows no
  icon: `<popup dragPreview>` is not drawn.
- **Input methods, the rest of it.** A preedit that hides its cursor puts
  the caret at the end, and the only content hints sent are `multiline`
  and `sensitive_data`.
- **Tablet pads** — the buttons, rings and strips on the tablet itself are
  ignored.
- **`useScreens().source` reads `'test'`**, as it does on macOS and Windows.
- **`fillText`** uses only the first family of a `font` shorthand, and
  strokes text as a fill.
- **`ext-image-copy-capture`** has not been run against a compositor yet
  (sway 1.10 offers only wlr-screencopy).

## Things that are gone, not missing

Window managers (`examples/wm.jsx`), global grabs, reading other windows,
screen coordinates, `GetImage`, XEmbed/`<foreign>`, and `ssh -X` are
compositor-private by design. Panels and docks are `layer-shell`, and a
screen read is `screencopy` — both wlroots and KDE, neither GNOME, where the
same JSX is a toplevel and the same pick is the portal's.
