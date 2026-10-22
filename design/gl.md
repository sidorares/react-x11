# 3D: `<glarea>` and the three ways underneath it: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/gl.md](../docs/gl.md), the reference, and keep
their original headings so code comments that cite them still resolve.

## The three ways

|                | **direct** (X11)                                                                                                                                                                                                       | **indirect** (X11)                                                 | **Cocoa**                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| how it draws   | OpenGL ES 2 on the GPU, in two flavors: on Linux frames reach the server as dma-buf descriptors over DRI3 + Present, and on macOS/XQuartz the server exports the window's surface over Apple-DRI and CGL draws into it | GL commands encoded into the X connection                          | CGL — OpenGL 4.1 core on Metal — into IOSurface-backed framebuffers, presented as a sublayer |
| shaders        | **yes**, GLSL ES 1.00                                                                                                                                                                                                  | none; the protocol encodes no shader objects                       | **yes**                                                                                      |
| render targets | **yes** — framebuffer objects                                                                                                                                                                                          | none; the protocol encodes no framebuffer objects                  | **yes** — it draws into one                                                                  |
| geometry       | vertex buffers on the GPU                                                                                                                                                                                              | immediate mode compiled into display lists                         | vertex buffers on the GPU                                                                    |
| lighting       | per fragment                                                                                                                                                                                                           | per vertex                                                         | per fragment                                                                                 |
| cost per frame | one Present request                                                                                                                                                                                                    | matrices, material state and one `CallList` per mesh               | a swap between two targets; the WindowServer composites                                      |
| where it runs  | a local connection, plus ntk's optional `x11-dri` addon: a Linux server with DRI3, or macOS/XQuartz with Apple-DRI (ntk 8.4.0)                                                                                         | any server that allows indirect contexts, including over a network | any Mac, on the Cocoa backend — it needs the same optional `x11-dri` addon and nothing else  |

The Cocoa column is the X11 direct path with the X-specific half swapped
out: the same `x11-dri` CGL context and the same WebGL-shaped `gl` table,
but instead of attaching to a surface an X server exported, frames render
into IOSurfaces and present by handing the surface's id to the area's own
`CALayer`. `glPolicy: 'indirect'` is the one setting that is an error there
and says so — GLX is a protocol, and there is no server to speak it to.

The two other backends have no column because they hand `onDraw` the same
direct API the Cocoa one does, and report `gl.backend === 'direct'` too. On
**win32** a `<glarea>` is a WGL core context drawing into a Direct3D texture
that is copied into a composition swap chain under the window's own visual
([windows-gl.md](windows-gl.md)), so it composites with the window's alpha
where an X11 surface does not. On **Wayland** it is not a surface of its own
at all: it is a rectangle of the window's backing target, drawn by the
window's own GLES context between the tree's 2D paint and its children's
panes (`src/wayland/glarea.js`).

On X11 the default is indirect, because it is what react-x11 has always
used. Turn the other on per app:

## Raw GL through `onDraw`

Code written against one spelling will not run on the other, which is why
the default X11 policy does not switch under an app that never asked for it
— and why `examples/viewer3d.jsx` reports which one it got rather than
pretending it can draw on both. It also means a scene written for the direct
API runs unchanged on the Cocoa backend, and one written for indirect GLX
does not run there at all.

## 2D over the surface

A `<glarea>`'s children are drawn above it — a legend, a toolbar, a label
over the scene — laid out in its box and hit before it. They are ordinary
elements. Core paints them on panes stacked over the surface, from the
window's own frame. On the Cocoa backend Core Animation composites the
panes with the GL frame, translucency and all. On X11 a pane is an opaque
child window, so what a child leaves unpainted shows the surface's
`clearColor` ([elements.md](../docs/elements.md#glarea) has the table).
`useSupports('glOverlay')` asks whether a connection draws them;
`examples/labs/gl-overlay.jsx` runs one on both backends.

The answer is no on XQuartz. The macOS window server composites every GL
surface there above everything the X server draws, so nothing can be drawn
over one. The children are laid out and not drawn, and a development build
warns once. On macOS the Cocoa backend is the one that composites a HUD
over GL.

So a HUD is not GL's business: its text is set by the app's own text
engine, its controls take their own input, and nothing is rasterized into a
texture.

## Testing

A GL app is tested on **what it emits**, not on pixels — which is also the
only option, because GL renders where `GetImage` cannot read it (see
[glx.md](glx.md)):

- `test/glarea.test.js` drives node-x11's in-process X server with its GLX
  emulator registered, so a frame's GL calls land on a `RecordingBackend`.
  No display, no GPU, no addon.
- `test/viewer3d.test.js` does the same for the example, and says in its
  header which claim that harness cannot see and where it is measured
  instead.

See also [glx.md](glx.md) for the indirect backend's design, and what its
transport can never do.
