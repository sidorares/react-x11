# 3D: `<glarea>` and the three ways underneath it

react-x11 gives you a **GL surface in the layout** and nothing above it. A
scene graph — meshes, materials, lights, post-processing — is
[`@react-x11/components/three`](ecosystem.md), which brings its own
reconciler and renders through the surface described here.

```jsx
<glarea
  style={{ flexGrow: 1 }}
  clearColor="#0b1021"
  frameLoop="always"
  onCreated={(gl) => gl.Enable(gl.DEPTH_TEST)}
  onDraw={(gl, { width, height }) => {
    /* one frame */
  }}
/>
```

`examples/viewer3d.jsx` is the worked example: a model viewer that orbits,
and the display-list discipline the indirect backend demands.

## The three ways

`<glarea>` and `onDraw` are the same everywhere. What is underneath is not:
these are different APIs, not three spellings of one, and which one a
connection has decides what `onDraw` can do.

|                | **direct** (X11)                                                                                                               | **indirect** (X11)                                                 | **Cocoa**                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| how it draws   | OpenGL ES 2 on the GPU (DRI3 + Present on Linux, Apple-DRI on macOS/XQuartz)                                                   | GL 1.x commands encoded into the X connection                      | CGL — OpenGL 4.1 core on Metal — presented as a sublayer                                    |
| shaders        | **yes**, GLSL ES 1.00                                                                                                          | none                                                               | **yes**                                                                                     |
| render targets | **yes** — framebuffer objects                                                                                                  | none                                                               | **yes**                                                                                     |
| geometry       | vertex buffers on the GPU                                                                                                      | immediate mode compiled into display lists                         | vertex buffers on the GPU                                                                   |
| lighting       | per fragment                                                                                                                   | per vertex                                                         | per fragment                                                                                |
| where it runs  | a local connection, plus ntk's optional `x11-dri` addon: a Linux server with DRI3, or macOS/XQuartz with Apple-DRI (ntk 8.4.0) | any server that allows indirect contexts, including over a network | any Mac, on the Cocoa backend — it needs the same optional `x11-dri` addon and nothing else |

The Cocoa column hands `onDraw` the same WebGL-shaped `gl` table as X11
direct. `glPolicy: 'indirect'` is an error there, and says so: there is no X
server to speak GLX to.

**win32** and **Wayland** have no column because they hand `onDraw` the same
direct API and report `gl.backend === 'direct'` too. On win32 a `<glarea>` is
a WGL context composited under the window's own visual, so it composites with
the window's alpha where an X11 surface does not. On Wayland it is drawn into
the window's own backing target, between the tree's 2D paint and its
children's panes, rather than being a surface of its own.

On X11 the default is indirect. Turn direct on per app:

```jsx
const root = await createRoot({ glPolicy: 'auto' });
```

`'auto'` uses direct where it is available and indirect otherwise, which is
usually what you want: most modern desktops **refuse** indirect GLX — Xorg
1.17 and later, and Xwayland, ship with it off — and those are exactly the
machines where direct works. `'direct'` and `'off'` are the strict forms, and
`'indirect'` is the default. One run can be switched without touching code:

```sh
NTK_GL_POLICY=direct npm start
```

Which flavor a connection got is `app.glCapabilities().flavor` — `'dri3'` or
`'appledri'`. Both spell the context the same way, so nothing above the
policy has to branch on it; it is worth reading when a machine that should
have direct does not.

Everything about how the backend is chosen and why it might be unavailable —
the `GLError` codes, `app.glCapabilities()`, the addon — is ntk's, and is
documented in [ntk's context-gles.md](https://github.com/sidorares/ntk/blob/master/docs/context-gles.md).

`npm run labs:direct-gl` is the shader path on a real display, and reports
both the flavor and which backend actually drew.

## Raw GL through `onDraw`

`onDraw(gl, { width, height, node })` hands you the context itself, and
there are two spellings of GL to write against — camelCase ES 2 against
PascalCase OpenGL 1.x. Nothing translates between them. Branch on
`gl.backend`, which is `'direct'` or `'indirect'`; the Cocoa path reports
`'direct'`, because that is the API it hands you:

```jsx
<glarea
  onDraw={(gl) => {
    if (gl.backend === 'direct') gl.clear(gl.COLOR_BUFFER_BIT);
    else gl.Clear(gl.COLOR_BUFFER_BIT);
  }}
/>
```

Code written against one spelling will not run on the other, which is why
the default X11 policy does not switch under an app that never asked for it.
A scene written for the direct API runs unchanged on the Cocoa backend; one
written for indirect GLX does not run there at all.

**On the indirect backend, geometry belongs in a display list.** Every
immediate-mode vertex is a command on the wire, so a mesh re-sent per frame
costs kilobytes per frame (about 96 KB for a 1 000-triangle mesh) while a
compiled list costs one `CallList`. Names are yours to choose — `GenLists` is
a round trip, and this is the backend where round trips are the thing to
avoid.

### What indirect GLX encodes

Indirect GLX is a fixed-function OpenGL 1.x pipeline, and these are the
commands it can carry:

| available      |                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| immediate mode | `Begin`/`End`, `Vertex3f`, `Normal3f`, `Color3f/4f`, `TexCoord2f`                                                                                       |
| matrices       | `MatrixMode`, `LoadIdentity`, `LoadMatrixf`, `MultMatrixf`, `Push/PopMatrix`, `Translatef`, `Rotatef`, `Scalef`, `Frustum`, `Ortho`                     |
| lighting       | `Lightfv`, `LightModelf`, `Materialfv`, `Materialf`, `ColorMaterial`, `ShadeModel`                                                                      |
| texturing      | `TexImage2D`, `BindTexture`, `TexParameter*`, `TexEnv*`, `TexGen*`                                                                                      |
| state          | `Enable`/`Disable`, `Clear*`, `DepthFunc`, `DepthMask`, `BlendFunc`, `AlphaFunc`, `CullFace`, `FrontFace`, `PolygonMode`, `Viewport`, `Scissor`, `Fog*` |
| display lists  | `CallList`, `ListBase`, `NewList`/`EndList`/`DeleteLists`                                                                                               |

There are **no GLSL shaders, no VBOs, no vertex arrays** (`DrawArrays` and
`VertexPointer` are not encoded), **no framebuffer objects and no
instancing**, and ARB assembly programs are not supported. These are limits
of the protocol, not of an implementation: shader materials and
post-processing need the direct backend.

## Input

The pointer over a surface is the tree's, on every backend: `onMouseDown`,
`onMouseMove`, `onMouseUp`, `onClick`, `onWheel` and the rest fire at the
`<glarea>` — or at a child drawn over it (below) — and bubble, with
`ev.localX`/`localY` measured from the target's corner, which is what a
scene picks with. Nothing needs to listen on the surface's own window, and
nothing should: on X11 a listener there takes the event away from the tree
([elements.md](elements.md#glarea) says why).

## 2D over the surface

A `<glarea>`'s children are drawn above it — a legend, a toolbar, a label
over the scene — laid out in its box and hit before it. They are ordinary
elements. On the Cocoa backend they composite with the GL frame,
translucency and all. On X11 each is drawn on an opaque pane over the
surface, so what a child leaves unpainted shows the surface's `clearColor`
([elements.md](elements.md#glarea) has the table).
`useSupports('glOverlay')` asks whether a connection draws them;
`examples/labs/gl-overlay.jsx` runs one on both backends.

The answer is no on XQuartz: the macOS window server composites every GL
surface there above everything the X server draws. The children are laid out
and not drawn, and a development build warns once. On macOS the Cocoa backend
is the one that composites a HUD over GL.

## When there is no surface at all

`onError(err)` fires when no GL context could be made: no GLX, indirect
disabled, no matching visual. `err.code` is one of ntk's `GLXError` values,
`GLX_INDIRECT_DISABLED` being the usual one. Without a handler the failure is
a console warning and the element draws nothing, which looks like a bug in
your scene rather than a fact about the machine — so handle it and say what
the reader can do.

## Testing

Test a GL app on **what it emits**, not on pixels: GL renders where `GetImage`
cannot read it (on XQuartz a capture reads back white), so a screenshot of a
window with a `<glarea>` has a hole where the scene is. On the direct
backend, `gl.readPixels` inside `onDraw` is the only way to see the frame.

This repo's `test/glarea.test.js` shows the pattern: node-x11's in-process X
server with its GLX emulator registered, so a frame's GL calls land on a
`RecordingBackend` — no display, no GPU, no addon.

Design notes: [design/gl.md](../design/gl.md), and the indirect backend's
design in [design/glx.md](../design/glx.md).
