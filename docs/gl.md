# 3D: `<glarea>` and the two backends

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

## The two backends

Which one a connection has decides what `onDraw` can do, because they are
different APIs — not two spellings of one.

|                | **direct**                                                                                 | **indirect**                                                       |
| -------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| how it draws   | OpenGL ES 2 on the GPU; frames reach the server as dma-buf descriptors over DRI3 + Present | GL commands encoded into the X connection                          |
| shaders        | **yes**, GLSL ES 1.00                                                                      | none; the protocol encodes no shader objects                       |
| render targets | **yes** — framebuffer objects                                                              | none; the protocol encodes no framebuffer objects                  |
| geometry       | vertex buffers on the GPU                                                                  | immediate mode compiled into display lists                         |
| lighting       | per fragment                                                                               | per vertex                                                         |
| cost per frame | one Present request                                                                        | matrices, material state and one `CallList` per mesh               |
| where it runs  | a local connection to a Linux server with DRI3, plus ntk's optional `x11-dri` addon        | any server that allows indirect contexts, including over a network |

The default is indirect, because it is what react-x11 has always used. Turn
the other on per app:

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

## Raw GL through `onDraw`

`onDraw(gl, { width, height, node })` hands you the context itself, and the
two backends spell GL differently — camelCase ES 2 against PascalCase
OpenGL 1.x. Nothing translates between them. Branch on `gl.backend`:

```jsx
<glarea
  onDraw={(gl) => {
    if (gl.backend === 'direct') gl.clear(gl.COLOR_BUFFER_BIT);
    else gl.Clear(gl.COLOR_BUFFER_BIT);
  }}
/>
```

Code written against one backend will not run on the other, which is why the
default policy does not switch under an app that never asked for it — and
why `examples/viewer3d.jsx` reports which backend it got rather than
pretending it can draw on both.

**On the indirect backend, geometry belongs in a display list.** Every
immediate-mode vertex is a command on the wire, so a mesh re-sent per frame
costs kilobytes per frame while a compiled list costs one `CallList`. Names
are yours to choose — `GenLists` is a round trip, and this is the backend
where round trips are the thing to avoid.

## When there is no surface at all

`onError(err)` fires when no GL context could be made: no GLX, indirect
disabled, no matching visual. `err.code` is one of ntk's `GLXError` values,
`GLX_INDIRECT_DISABLED` being the usual one. Without a handler the failure is
a console warning and the element draws nothing, which looks like a bug in
your scene rather than a fact about the machine — so handle it and say what
the reader can do.

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
