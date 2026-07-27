# Plan: 3D components over indirect GLX

Status: **phases 0, 1 and 2 are implemented** (2026-07-27). Phase 0 shipped
in ntk 3.6.0 (sidorares/ntk#85): the context tag, GLX visuals on
`createWindow`, visual discovery over the protocol instead of `glxinfo`.
Phase 1 is the `<glarea>` element, phase 2 the scene tree — `<mesh>`,
`<group>`, the primitive geometries and `<meshBasicMaterial>` over a
display-list compiler (docs/elements.md). Phase 3 (lights, lit materials,
camera elements) is next. Everything in "What was verified" below was
measured against XQuartz + node-x11 3.1.2 + ntk 3.5.3, not assumed.

Goal: a react-three-fiber-shaped component set — `<mesh>`, geometries,
materials, lights, a camera — rendering through **indirect GLX**, i.e. the
GLX protocol over the X connection, with no direct rendering and no native
bindings. Same story as the rest of the stack: pure JS talking protocol.

---

## 1. What was verified

**Indirect GLX renders.** A red triangle on blue, drawn through
node-x11's GLX `Render` pipeline on XQuartz. This is the feasibility gate
and it passes.

**ntk's `getContext('opengl')` is broken.** It discards the context tag:

```js
GLX.MakeCurrent(window.id, ctx, 0, () => {}); // reply thrown away
const gl = GLX.renderPipeline(ctx); // context XID, not the tag
```

`MakeCurrent`'s reply _is_ the context tag (`buf.readUInt32LE(0)`), and
every `Render` request must carry it. Passing the XID gives
`GLXBadContextTag` on every draw. Using the tag instead — XID `10485762`
vs tag `1` — makes it work. **Fixing this is the first task and it
unblocks everything else.**

**ntk cannot create a window with a chosen visual.** `CreateWindow` passes
`0, 0, 0, 0` for border/depth/class/visual, so every window is
CopyFromParent. A GLX drawable needs a visual (and matching colormap) that
the context was created for. XQuartz tolerated the mismatch in the probe;
a stock Xorg will not. Same shape of bug as the old hardcoded
`overrideRedirect` (NEXT_STEPS §8.1).

**GL output is invisible to `GetImage` on XQuartz.** The probe read back
pure white while `screencapture` showed the triangle — GL renders into a
Metal surface the compositor owns, not the X drawable. This dictates the
testing strategy (§6).

---

## 2. The hard constraint: what indirect GLX can actually do

node-x11's `glxrender.js` encodes **70 GL commands**, and they are
fixed-function OpenGL 1.x:

| available      |                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| immediate mode | `Begin`/`End`, `Vertex3f`, `Normal3f`, `Color3f/4f`, `TexCoord2f`                                                                                       |
| matrices       | `MatrixMode`, `LoadIdentity`, `LoadMatrixf`, `MultMatrixf`, `Push/PopMatrix`, `Translatef`, `Rotatef`, `Scalef`, `Frustum`, `Ortho`                     |
| lighting       | `Lightfv`, `LightModelf`, `Materialfv`, `Materialf`, `ColorMaterial`, `ShadeModel`                                                                      |
| texturing      | `TexImage2D`, `BindTexture`, `TexParameter*`, `TexEnv*`, `TexGen*`                                                                                      |
| state          | `Enable`/`Disable`, `Clear*`, `DepthFunc`, `DepthMask`, `BlendFunc`, `AlphaFunc`, `CullFace`, `FrontFace`, `PolygonMode`, `Viewport`, `Scissor`, `Fog*` |
| display lists  | `CallList`, `ListBase` (+ `NewList`/`EndList`/`DeleteLists` in `glx.js`)                                                                                |

**Not available, and not worth trying:** GLSL shaders, VBOs, vertex
arrays (`DrawArrays`/`VertexPointer` are not encoded), framebuffer
objects, instancing. `ProgramString`/`BindProgram` expose ARB _assembly_
programs — out of scope.

This rules out, permanently and by protocol: `shaderMaterial`,
post-processing, shadow maps, instanced meshes, GPU picking.

### The consequence that shapes the whole design

There are no vertex arrays, so geometry can only be sent as immediate-mode
commands. A 1 000-triangle mesh is ~3 000 `Vertex3f` + 3 000 `Normal3f`
commands ≈ **96 KB per frame** if re-sent every frame. At 60fps that is
5.7 MB/s of protocol traffic for one modest mesh.

**So display lists are mandatory, not an optimisation.** Compile each
geometry into a server-side display list once, then per frame send only
matrices and `CallList`. A static scene becomes O(number of meshes)
requests per frame instead of O(number of vertices).

This is exactly the AGENTS.md "Protocol efficiency" rule set applied — use
server-side primitives, batch, avoid re-sending what the server already
has — and it should be enforced with benchmark scenarios (§6).

---

## 3. Naming

Top-level: **`<Canvas3D>`**. It matches r3f's `<Canvas>` closely enough to
be guessable, and cannot be confused with react-x11's existing `<canvas>`
host element (the 2D `onDraw` escape hatch), which `<Canvas>` would
shadow badly in a codebase that has both. Alternatives considered:
`<GLView>` (accurate, unfamiliar), `<Scene3D>` (describes the contents,
not the surface).

Everything inside reuses r3f names wherever the concept survives the
translation to fixed-function GL, so existing r3f knowledge transfers:

```jsx
<Canvas3D camera={{ position: [0, 0, 5], fov: 60 }} width={480} height={320}>
  <ambientLight intensity={0.3} />
  <pointLight position={[4, 5, 3]} intensity={1} />

  <mesh position={[0, 0, 0]} rotation={[0, 0.4, 0]}>
    <boxGeometry args={[1, 1, 1]} />
    <meshPhongMaterial color="#2980b9" shininess={40} />
  </mesh>
</Canvas3D>
```

| r3f name                                                                                        | maps to                                            | notes                       |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------- |
| `<mesh>`, `<group>`                                                                             | matrix push/pop + `CallList`                       |                             |
| `<boxGeometry>`, `<sphereGeometry>`, `<planeGeometry>`, `<cylinderGeometry>`, `<torusGeometry>` | generated vertex/normal/uv arrays                  | `args` tuples as in r3f     |
| `<bufferGeometry>`                                                                              | explicit `position`/`normal`/`uv`/`index` arrays   | the escape hatch            |
| `<meshBasicMaterial>`                                                                           | lighting disabled, `Color3f`                       |                             |
| `<meshLambertMaterial>`                                                                         | `Materialfv` diffuse+ambient                       |                             |
| `<meshPhongMaterial>`                                                                           | + `GL_SPECULAR`, `GL_SHININESS`                    |                             |
| `<ambientLight>`                                                                                | `LightModelfv(GL_LIGHT_MODEL_AMBIENT)`             |                             |
| `<directionalLight>`                                                                            | `Lightfv` position with `w = 0`                    |                             |
| `<pointLight>`                                                                                  | `w = 1` + attenuation                              |                             |
| `<spotLight>`                                                                                   | + `SPOT_CUTOFF`, `SPOT_DIRECTION`, `SPOT_EXPONENT` |                             |
| `<perspectiveCamera>`                                                                           | `Frustum`                                          | `fov`/`aspect`/`near`/`far` |
| `<orthographicCamera>`                                                                          | `Ortho`                                            |                             |
| `useFrame(cb)`                                                                                  | ntk `requestAnimationFrame`                        |                             |

Fixed-function GL supports **8 lights** (`GL_LIGHT0..7`). Exceeding that
should warn rather than fail silently.

Deliberately **not** implemented, and should throw a clear error naming
the protocol limit: `shaderMaterial`, `<Effects>`, shadows,
`instancedMesh`.

---

## 4. Architecture

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

- `<glarea>` is already named in NEXT_STEPS §4 as one of the few elements
  that legitimately needs its own X window — GLX needs its own visual and
  cannot share the XRender pipeline.
- The scene tree is **separate from the 2D drawn-node tree**: no yoga, no
  hit testing, no painting into the parent's 2d context. `Canvas3D` is a
  leaf as far as the 2D layout is concerned, sized by normal layout props.
- **Display-list cache** keyed by geometry identity. Geometry prop change
  → recompile that list. Transform/material change → per-frame state only,
  no recompile.
- Materials are per-frame state, not baked into the list, so the same
  geometry list can be shared by meshes with different materials.

---

## 5. Phases

Each phase should land as its own PR with tests, per the usual workflow.

**Phase 0 — unblock (upstream ntk). DONE — sidorares/ntk#85.**

1. Use `MakeCurrent`'s returned context tag in
   `RenderingContextOpenGL`. Verified fix; this alone makes
   `getContext('opengl')` usable.
2. Let `createWindow` take `visual`, `depth` and `colormap` (the
   hardcoded `0, 0, 0, 0`), plus `CreateColormap`. Needed for a correct
   GLX drawable on non-permissive servers.
3. Replace the `glxinfo` shell-out with a real `ChooseFBConfig` /
   `GetVisualConfigs` path, choosing a visual with a depth buffer.
   Shelling out cannot work headlessly or on CI.

**Phase 1 — surface. DONE.** `<glarea>` host element: a child X window on
a GLX visual, sized by the parent's yoga rect, with clear colour, viewport,
`onCreated`/`onDraw`, `SwapBuffers` and a demand-or-continuous frame loop
on ntk's `requestAnimationFrame`. `Canvas3D` moves to phase 2 — the
surface duties live in the host element, so the component only earns its
keep once there is a scene tree to own.

**Phase 2 — geometry. DONE.** Display-list compiler, `<mesh>`, `<group>`,
`<bufferGeometry>` + box/plane/sphere/cylinder/torus,
`<meshBasicMaterial>`, the `camera` prop and the `Canvas3D` component.
The per-frame cost is independent of triangle count and
`test/scene3d.test.js` asserts it on the encoded command stream: a 6 000-
vertex sphere compiles once, and the steady-state frame is under 30 GL
commands with no vertices in it.

**Phase 3 — shading.** Lights, `meshLambert`/`meshPhong`, `ShadeModel`,
normals, `<perspectiveCamera>`/`<orthographicCamera>`, `<group>`.

**Phase 4 — textures.** `TexImage2D` from ntk `Image`, texture cache,
`map` prop on materials, `TexParameter` filtering/wrap.

**Phase 5 — interaction.** `onClick`/`onPointerOver` on `<mesh>` via
**client-side** raycasting against the CPU-side geometry — there is no GPU
picking here. Reuse the existing event plumbing on the `<glarea>` window.

**Phase 6 — docs and example.** `docs/3d.md`, an `examples/three.jsx`
comparable to the widget gallery, README screenshots.

---

## 6. Testing and measurement

**Hermetic command-stream tests (primary).** Assert the _encoded GLX
command stream_ rather than pixels: that a geometry compiles to one
display list, that a frame emits matrices + `CallList` and **not**
thousands of `Vertex3f`, that a transform change re-sends no geometry.
This is the property that actually matters and it needs no GL at all —
reuse `scripts/bench/xcount.js`, which already parses the request stream.
node-x11 also has a `test:glx-emu` suite worth investigating for this.

**Pixel verification (secondary, manual).** On XQuartz `GetImage` returns
white for GL content, so pixels must come from `screencapture` — the same
approach the tooltip screenshot uses. On Linux CI, Xvfb with llvmpipe and
indirect GLX enabled (`+iglx`) is the path, if it proves reliable.

**Benchmark scenarios** in `scripts/bench/protocol.js`, with committed
baselines:

- static scene, 1 000 triangles — assert per-frame requests are O(meshes),
  not O(vertices)
- geometry change — one recompile, then back to the cheap steady state
- camera-only movement — should send matrices and nothing else

The whole point of the display-list design is a protocol property, so it
should be defended by the benchmark rather than by intent.

---

## 7. Open questions

- ~~Does XQuartz's indirect GLX handle display lists reliably?~~ **Yes** —
  `examples/three.jsx` draws box/sphere/torus from display lists with depth
  testing and back-face culling on XQuartz. Lighting is still untested
  there (phase 3).
- Is there a depth-buffer-capable visual reachable via `GetVisualConfigs`
  on both XQuartz and Xvfb/llvmpipe?
- Does `SwapBuffers` interact sanely with ntk's frame clock and the
  double-buffered backing store, or does `<glarea>` need to opt out of it?
- Can a `<glarea>` be composited with 2D content drawn over it, or does
  the GL child window always sit on top? (Affects whether HUD overlays are
  possible — likely "always on top", so overlays would need a sibling
  window.)
- Is `RenderLarge` needed for compiling big display lists in one request,
  and is it correctly implemented in node-x11?

---

## 8. Scope discipline

Indirect GLX is a 1990s fixed-function pipeline reached over a network
protocol. The value here is _reach_ — 3D in a pure-JS X11 client with no
native dependencies — not performance or fidelity. A plausible-looking API
that quietly fails on anything modern would be worse than a small one with
honest edges, so unsupported r3f features should throw with a message that
names the reason.
