# 3D: the two backends

`<Canvas3D>` and the scene elements inside it draw through one of two OpenGL
pipelines, and which one decides what the scene can contain:

|                | **direct**                                                                                 | **indirect**                                                       |
| -------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| how it draws   | OpenGL ES 2 on the GPU; frames reach the server as dma-buf descriptors over DRI3 + Present | GL commands encoded into the X connection                          |
| shaders        | **yes** — `<shaderMaterial>`, GLSL ES 1.00                                                 | none; the protocol encodes no shader objects                       |
| geometry       | vertex buffers on the GPU                                                                  | immediate mode compiled into display lists                         |
| lighting       | per fragment                                                                               | per vertex                                                         |
| cost per frame | one Present request                                                                        | matrices, material state and one `CallList` per mesh               |
| where it runs  | a local connection to a Linux server with DRI3, plus ntk's optional `x11-dri` addon        | any server that allows indirect contexts, including over a network |

**The scene graph is identical.** `<mesh>`, `<group>`, the geometries, the
standard materials, the lights and the `camera` prop mean the same thing on
both, and the same JSX renders on both. Only the renderer differs — that is
the whole reason the split is where it is.

The default is indirect, because it is what react-x11 has always used and
because the two expose different raw GL APIs to `onDraw`. Turn the other on
per app:

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

Everything about how the backend is chosen and why it might be unavailable —
the `GLError` codes, `app.glCapabilities()`, the addon — is ntk's, and is
documented in [ntk's context-gles.md](https://github.com/sidorares/ntk/blob/master/docs/context-gles.md).

## Shader materials

![A torus whose surface is banded and rim-lit by a fragment shader](img/shader-material.png)

`<shaderMaterial>` runs your GLSL, with three.js's names already declared so
a shader written for r3f — or copied out of a tutorial — compiles unchanged.
The torus above is `examples/shader.jsx`: the vertex shader displaces the
surface along its normals and the fragment shader bands and rim-lights it,
neither of which the fixed-function pipeline can express at all.

```jsx
const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = `
  varying vec2 vUv;
  uniform float uTime;
  uniform vec3 uColor;
  void main() {
    float wave = 0.5 + 0.5 * sin(vUv.x * 20.0 + uTime);
    gl_FragColor = vec4(uColor * wave, 1.0);
  }
`;

<Canvas3D camera={{ position: [0, 0, 3] }} frameLoop="always">
  <mesh>
    <planeGeometry args={[2, 2]} />
    <shaderMaterial
      vertexShader={vertexShader}
      fragmentShader={fragmentShader}
      uniforms={{ uTime: { value: t }, uColor: { value: [0.2, 0.6, 1] } }}
    />
  </mesh>
</Canvas3D>;
```

Declared for you, as three.js declares them: attributes `position`, `normal`
and `uv`; uniforms `projectionMatrix`, `modelViewMatrix`, `modelMatrix`,
`viewMatrix`, `normalMatrix` and `cameraPosition`. `<rawShaderMaterial>`
declares nothing at all, also as in three.js.

`uniforms` takes three.js's `{ name: { value } }` shape (a bare value works
too), and the setter follows the JavaScript type:

| value                     | goes out as                                         |
| ------------------------- | --------------------------------------------------- |
| a number                  | `uniform1f`                                         |
| a boolean                 | `uniform1i`                                         |
| 2, 3 or 4 numbers         | `uniform2fv` / `3fv` / `4fv`                        |
| 9 numbers                 | `uniformMatrix3fv`                                  |
| 16 numbers                | `uniformMatrix4fv`                                  |
| `{ width, height, data }` | uploaded as a texture, bound to a unit, `uniform1i` |

A matrix has to be a typed array or a 9/16-long array — nothing else
distinguishes a `mat3` from three `vec3`s.

**Changing a uniform never recompiles anything.** Programs are cached by
shader source, so animating one is a uniform write per frame, which on the
direct backend costs nothing measurable. A shader that will not compile or
link is reported once through `onError` — with the driver's own log, which is
the only thing that says what to fix — and that mesh is skipped rather than
taking the render down.

Asking for `<shaderMaterial>` on a connection with no direct backend throws
when the element is created, naming the actual reason ntk found. That check
happens up front rather than at draw time, because a blank surface is a much
worse way to learn it — but it does mean a scene that would rather degrade
has to ask first:

```jsx
const shaders = useSupports('shaders');
<mesh>
  <boxGeometry args={[1, 1, 1]} />
  {shaders ? (
    <shaderMaterial {...glsl} />
  ) : (
    <meshPhongMaterial color="#e0533d" />
  )}
</mesh>;
```

`<Canvas3D fallback>` does not cover this: it is for a surface with no GL
context at all, and a connection can have perfectly good indirect GL and no
shaders.

### Runtimes

Direct rendering needs a runtime that can send a file descriptor over a unix
socket, because that is how DRI3 hands the server a buffer. `x11` does it
through Node's internal `process.binding('pipe_wrap')`:

| runtime | direct                                                     | indirect |
| ------- | ---------------------------------------------------------- | -------- |
| Node    | yes                                                        | yes      |
| Bun     | **no** — `process.binding('pipe_wrap')` is not implemented | yes      |

Under Bun, `glPolicy: 'auto'` falls back to indirect GLX and
`useSupports('shaders')` is false. `npm run examples:shader` shows what that
looks like.

## What the direct backend does with the standard materials

Same inputs, same look, different pipeline:

| element                    | becomes                               |
| -------------------------- | ------------------------------------- |
| `<meshBasicMaterial>`      | unlit; colour, `opacity`, `map`       |
| `<meshLambertMaterial>`    | per-fragment diffuse                  |
| `<meshPhongMaterial>`      | + Blinn-Phong specular, `shininess`   |
| `<ambientLight>`           | a constant term                       |
| `<directionalLight>`       | a light direction, no attenuation     |
| `<pointLight>`             | a position with distance attenuation  |
| `<spotLight>`              | + cone cutoff and `penumbra`          |
| `transparent` / `opacity`  | alpha blending, with depth writes off |
| `side="double"` / `"back"` | culling off / front-face culling      |
| `map`                      | a texture, uploaded once              |

The program is generated per material configuration **and per light count**,
so a scene with two lights compiles a two-light shader. ES 2 guarantees very
few uniform vectors, and a fixed eight-light shader would not fit the
minimum. The eight-light cap is kept anyway, so a scene lights the same on
both backends.

Two differences you can see, both improvements the GPU makes free:

- **lighting is per fragment.** Fixed-function GL shades per vertex, so a
  large triangle lit from close by bands visibly. This is also what three.js
  does with the same material names.
- **large geometries just work.** Above 65535 vertices the index buffer
  cannot address them, so the geometry is expanded to a flat triangle list
  rather than wrapping — a `<sphereGeometry>` with enough segments really
  does get there.

## `useFrame`

The per-surface frame clock. `delta` is seconds since the previous frame, so
motion runs at the same speed whatever the frame rate:

```jsx
function Spin() {
  const [angle, setAngle] = useState(0);
  useFrame((state, delta) => setAngle((a) => a + delta));
  return <mesh rotation={[0, angle, 0]}>…</mesh>;
}
```

`state` carries `{ gl, backend, width, height, elapsed, frame, camera }`.
Subscribing **makes the surface animate**: a `<Canvas3D>` redraws on demand
by default, and a clock nothing drives would tick once and stop. Unmount the
subscriber and it goes quiet again.

This is not r3f's escape from re-rendering. There, `useFrame` mutates an
Object3D in place and React never hears about it; the scene here is described
by props, so a callback that wants to move something sets state and the change
lands on the next frame. What it replaces is a ref to the window and a raw
`requestAnimationFrame`.

## Raw GL through `onDraw`

`onDraw(gl, { width, height })` hands you the context itself, and the two
backends spell GL differently — camelCase ES 2 against PascalCase OpenGL 1.x.
Nothing translates between them. Branch on `gl.backend`:

```jsx
<Canvas3D
  onDraw={(gl) => {
    if (gl.backend === 'direct') gl.clear(gl.COLOR_BUFFER_BIT);
    else gl.Clear(gl.COLOR_BUFFER_BIT);
  }}
/>
```

Code written against one backend will not run on the other, which is why the
default policy does not switch under an app that never asked for it.

## Testing

Both renderers are tested on **what they emit**, not on pixels, because that
is where the property that matters lives — geometry reaches the GPU once and
a frame never re-sends vertices:

- `test/scene3d-shader.test.js` records the GL call stream against a fake
  `gl` and asserts the uploads, the program cache, the generated shader
  sources, the uniform mapping and the draw state. No X server, no GPU, no
  addon — it runs anywhere.
- `test/scene3d.test.js` does the same for indirect, on the encoded GLX bytes.

See also [glx.md](glx.md) for the indirect backend's design, and what its
transport can never do.
