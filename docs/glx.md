# 3D over indirect GLX

How the 3D scene elements work, and what the transport can never do. The API
itself is in
[elements.md](elements.md#3d-scene-mesh-group-geometries-materials) and
[components.md](components.md#canvas3d) — this page is the design underneath
them, kept because the constraints explain most of the API's shape.

`<glarea>` is a real X child window on a GLX visual, and everything drawn
into it travels as **indirect GLX**: the GL protocol encoded into the same X
connection as everything else. No direct rendering, no native bindings, no
GPU driver bindings — the same pure-JS story as the rest of the stack.

The cost of that reach is a **fixed-function OpenGL 1.x pipeline**, and that
single fact decides the rest.

## What the protocol encodes

node-x11's `glxrender.js` encodes 70 GL commands:

| available      |                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| immediate mode | `Begin`/`End`, `Vertex3f`, `Normal3f`, `Color3f/4f`, `TexCoord2f`                                                                                       |
| matrices       | `MatrixMode`, `LoadIdentity`, `LoadMatrixf`, `MultMatrixf`, `Push/PopMatrix`, `Translatef`, `Rotatef`, `Scalef`, `Frustum`, `Ortho`                     |
| lighting       | `Lightfv`, `LightModelf`, `Materialfv`, `Materialf`, `ColorMaterial`, `ShadeModel`                                                                      |
| texturing      | `TexImage2D`, `BindTexture`, `TexParameter*`, `TexEnv*`, `TexGen*`                                                                                      |
| state          | `Enable`/`Disable`, `Clear*`, `DepthFunc`, `DepthMask`, `BlendFunc`, `AlphaFunc`, `CullFace`, `FrontFace`, `PolygonMode`, `Viewport`, `Scissor`, `Fog*` |
| display lists  | `CallList`, `ListBase` (+ `NewList`/`EndList`/`DeleteLists` in `glx.js`)                                                                                |

There are **no GLSL shaders, no VBOs, no vertex arrays** (`DrawArrays` and
`VertexPointer` are not encoded), **no framebuffer objects and no
instancing**. `ProgramString`/`BindProgram` expose ARB _assembly_ programs,
which are out of scope.

That rules out, permanently and by protocol: shader materials,
post-processing, shadow maps, instanced meshes and GPU picking. Each throws
an error naming the reason rather than rendering something that only looks
right — `UNSUPPORTED_KINDS` in `src/scene3d.js` is the list.

## Why display lists are mandatory

With no vertex arrays, geometry can only be sent as immediate-mode commands.
A 1 000-triangle mesh is ~3 000 `Vertex3f` + 3 000 `Normal3f` commands —
about **96 KB per frame** if re-sent every frame, or 5.7 MB/s at 60fps for
one modest mesh.

So each geometry is compiled into a **server-side display list** once, and a
frame sends only matrices, material state and one `CallList` per mesh. A
static scene costs O(meshes) requests per frame instead of O(vertices).

This is the AGENTS.md "Protocol efficiency" rule set applied literally — use
server-side primitives, batch, never re-send what the server already has —
and because it is a protocol property rather than an intention,
`test/scene3d.test.js` asserts it on the encoded command stream: a
6 000-vertex sphere compiles once, and the steady-state frame is under 30 GL
commands with no vertices in it.

The cache is keyed by geometry identity. A geometry prop change recompiles
that one list; a transform or material change is per-frame state only, so the
same list is shared by meshes that differ in material.

## The shape of the tree

```
<Canvas3D>  ->  <glarea> host element  ->  real X child window with a
                                            GLX visual + its own colormap
                     |
                GLContext (ntk)   MakeCurrent -> context tag
                     |
              Scene node tree (parallel to the drawn-node tree)
                     |
     commit: compile dirty geometries -> display lists
     frame:  Clear -> camera matrices -> per mesh: PushMatrix,
             MultMatrixf, material state, CallList, PopMatrix -> SwapBuffers
```

`<glarea>` is one of the three elements that legitimately needs its own X
window (NEXT_STEPS §4): GLX needs its own visual and cannot share the
XRender pipeline the 2D elements draw through.

The scene tree is **separate from the drawn-node tree** — no yoga, no hit
testing against the 2D tree, no painting into the parent's 2d context. To
layout, `Canvas3D` is a leaf sized by ordinary layout props.

## Naming

The top-level component is **`Canvas3D`**, not `Canvas`: react-x11 already
has a `<canvas>` host element (the 2D `onDraw` escape hatch) that `<Canvas>`
would shadow badly in a codebase using both. Everything inside reuses
react-three-fiber names wherever the concept survives translation to
fixed-function GL, so r3f knowledge transfers:

| r3f name                                                                                        | maps to                                             |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `<mesh>`, `<group>`                                                                             | matrix push/pop + `CallList`                        |
| `<boxGeometry>`, `<planeGeometry>`, `<sphereGeometry>`, `<cylinderGeometry>`, `<torusGeometry>` | generated vertex/normal/uv arrays, `args` as in r3f |
| `<bufferGeometry>`                                                                              | explicit `position`/`normal`/`uv`/`index` arrays    |
| `<meshBasicMaterial>`                                                                           | lighting disabled, `Color3f`                        |
| `<meshLambertMaterial>`                                                                         | `Materialfv` diffuse + ambient                      |
| `<meshPhongMaterial>`                                                                           | + `GL_SPECULAR`, `GL_SHININESS`                     |
| `<ambientLight>`                                                                                | `LightModelfv(GL_LIGHT_MODEL_AMBIENT)`              |
| `<directionalLight>`                                                                            | `Lightfv` position with `w = 0`                     |
| `<pointLight>`                                                                                  | `w = 1` + attenuation                               |
| `<spotLight>`                                                                                   | + `SPOT_CUTOFF`, `SPOT_DIRECTION`, `SPOT_EXPONENT`  |

Fixed-function GL has **8 light units**. More than eight non-ambient lights
warns and uses the first eight; `<ambientLight>` costs no unit.

**The camera is a prop, not an element.** There is no
`<perspectiveCamera>`/`<orthographicCamera>` — `Canvas3D` and `<glarea>`
take `camera={{ position, target, up, fov, near, far }}`, or
`{ orthographic: true, zoom }`. Animate by changing props from a
`requestAnimationFrame` loop on the window ref (`examples/three.jsx`), or set
`frameLoop="always"`; there is no `useFrame` hook.

## Testing

The primary tests are **hermetic and assert the encoded GLX command
stream**, not pixels: that a geometry compiles to one display list, that a
frame emits matrices plus `CallList` rather than thousands of `Vertex3f`,
and that a transform change re-sends no geometry. That is the property that
actually matters, and checking it needs no GL at all —
`test/scene3d.test.js` and `test/glarea.test.js`.

Pixels are the awkward part. On XQuartz, GL renders into a Metal surface the
compositor owns rather than into the X drawable, so `GetImage` reads back
white and `docs/img/three.png` has to be captured by hand from
`npm run examples:three` on a real server with indirect GLX — which is why
`npm run screenshots` skips it. The documentation site's playground is the
exception that renders GL headlessly: node-x11's browser GLX emulator
replays the same protocol onto WebGL2.

## Open questions

- Is there a depth-buffer-capable visual reachable via `GetVisualConfigs` on
  both XQuartz and Xvfb/llvmpipe?
- Can a `<glarea>` be composited with 2D content drawn over it, or does the
  GL child window always sit on top? (Likely always on top, so a HUD overlay
  would need a sibling window.)

## Scope discipline

Indirect GLX is a 1990s fixed-function pipeline reached over a network
protocol. The value is _reach_ — 3D in a pure-JS X11 client with no native
dependencies — not performance or fidelity. A plausible-looking API that
quietly fails on anything modern would be worse than a small one with honest
edges, which is why unsupported r3f names throw with the reason.
