# 3D graphics on Windows

**Status: a report, with one measurement that changes the plan.** Written
2026-09-19 against react-x11 2.16.1 on Windows 11 build 26200, with a GeForce
GTX 1080 Ti. [windows.md](windows.md) is the backend's design record and says
`<glarea>` is ANGLE; this is the report that asks whether it has to be.

## What react-x11's 3D story actually is

`<glarea>` is **a GL surface in the layout and nothing above it**
([gl.md](gl.md)). The scene graph — meshes, materials, lights,
post-processing — is `@react-x11/components/three`, which brings its own
reconciler and renders through that surface. So "3D support" on a backend is
one question: can `onDraw` be handed a working GL context, and can what it
draws reach the screen composited with everything else?

Three answers ship today, and they are different APIs rather than three
spellings of one:

| | how it draws | shaders |
| --- | --- | --- |
| **direct** (X11) | GLES 2 on the GPU via the `x11-dri` addon; frames reach the server as dma-buf over DRI3 + Present, or over Apple-DRI on XQuartz | yes |
| **indirect** (X11) | GL commands encoded into the X connection | no — the protocol encodes no shader objects |
| **Cocoa** | the same `x11-dri` CGL context, rendering into IOSurfaces presented as a `CALayer` sublayer | yes |

The shape worth noticing: **`x11-dri` is not an X11 thing.** It is the GL
addon, and the Cocoa backend uses it with the X-specific half swapped out.
wayland.md's open question 4 already anticipated renaming it to a
display-server-neutral GL addon; Windows is the third platform that would want
it, which turns that open question into a decision worth taking.

## What Windows can give, measured

`scripts/win32-probe.jsx`'s sibling in the bridge, `glProbe()`, creates a
throwaway window, sets a pixel format, and asks. On this machine:

```
vendor          NVIDIA Corporation
renderer        NVIDIA GeForce GTX 1080 Ti/PCIe/SSE2
version         4.6.0 NVIDIA 582.66      (core profile)
glsl            4.60 NVIDIA
maxTextureSize  32768
extensions      392
```

That is **OpenGL 4.6 core out of `opengl32.dll`, with nothing shipped**. It is
the measurement that matters, because docs/windows.md's plan — ANGLE, two DLLs
beside the app — was written on a Mac from Microsoft's documentation and from
what the browsers do, and the browsers ship ANGLE for reasons that are theirs
rather than ours: they must run identically on every driver, including the
broken ones, and they sandbox the GPU process.

The catch, and it is the whole reason ANGLE keeps a rung below: **without a
vendor driver, `opengl32.dll` is the 1.1 software rasterizer.** That is a
virtual machine with no passthrough, a CI runner, a fresh install before
Windows Update has fetched the driver, and some remote-desktop sessions. GL
1.1 has no shaders, no framebuffer objects and no vertex buffers — it is not
a degraded direct backend, it is the indirect backend's feature set with none
of its portability.

## The recommendation: a ladder, not a choice

The same discipline the desktop integrations follow — find the mechanism,
report an honest feature set, degrade in the right direction:

1. **WGL** — `wglCreateContextAttribsARB` for a 3.3-or-better core context on
   the vendor's driver. This is the rung that answers on an ordinary desktop,
   and it ships nothing. GLSL, framebuffer objects, vertex buffers,
   instancing: everything the direct backend's contract promises.
2. **ANGLE** — EGL and GLES 2/3 over Direct3D 11, two DLLs beside the app, an
   `optionalDependency` the way `x11-dri` is. It answers where WGL's version
   probe comes back below 3.3, which is exactly the driverless case. D3D11
   has a WARP software device, so this rung works on a CI runner where WGL
   does not.
3. **nothing**, said plainly — `onError` with a message that names what is
   missing, which is what `<glarea>` already does on this backend today.

Reversing 1 and 2 would be defensible and is what a browser would do. It is
not what this project should do: shipping two DLLs to every app to avoid a
driver check costs every Windows user the download and the packaging story,
and react-x11's own rule is that `npm install` never compiles and rarely
downloads.

## The hard part is presentation, not the context

Getting a GL context is a day. Getting its output onto the screen *composited
with the rest of the window* is the design problem, and Windows makes it
harder than either shipped backend does.

The window's content is a DirectComposition surface, and a GL context cannot
draw into one. Three ways out were on the table:

- **A child HWND with its own context.** This looks like the X11 model
  exactly: a `<glarea>` there is a child X window on a GL visual, stacked
  above the parent's content, and `glnodes.js` already positions it from the
  parent's yoga rect and already knows that a child window cannot be
  overlapped by the parent's 2D content. The Windows version would be a child
  HWND with a pixel format and a WGL context, and `SwapBuffers` on its own
  DC. Cheapest by far, and it reuses the node layer's existing shape rather
  than inventing one.

  **It does not work, and this was built and measured before that was
  believed.** A window that presents through a DirectComposition target is
  shown by DWM *from that visual tree*; the window's redirection bitmap — the
  surface a child HWND's pixels go to — is not part of what is composited.
  So the child was invisible with the composition tree above it, invisible
  with the tree below it (`CreateTargetForHwnd`'s `topmost` argument, both
  ways), invisible with the window created without
  `WS_EX_NOREDIRECTIONBITMAP` so that a redirection bitmap existed at all,
  and invisible through a transparent hole punched in the 2D layer over its
  rect — that hole showed the desktop. The GL side was healthy throughout:
  with the 2D layer silenced, the same frame appeared in full.

  There is no ordering that puts the two together, because they are not two
  layers of one thing.
- **`WGL_NV_DX_interop2`** — render GL into a texture shared with the D3D11
  device and put that on a composition visual. This is the one that
  composites properly. docs/windows.md flags it as "a driver's promise rather
  than the system's": it is present on NVIDIA and AMD, absent on some Intel
  configurations, and absent from WARP.
- **ANGLE into a composition swapchain**, which is docs/windows.md's plan and
  is the only one that is both composited and universal — because ANGLE is
  already D3D11, so its output is a D3D texture by construction.

**What shipped is the second**, not because it was the plan but because the
first is not a route. Each surface owns a swap chain made for composition,
shown by a visual of its own stacked over the window's 2D visual, and the GL
context draws into a Direct3D texture the frame copies into that swap chain.
What a child window is on X11 and a subview is on Cocoa, said in this
platform's terms — and it composites with the window's alpha, which the child
route would not have.

The consequence for the plan below is that **G5 came first**. ANGLE is still
the rung this needs for a machine with no vendor driver, for an Intel
configuration without the interop extension, and for CI on WARP — and it is
now a *fallback* under a working composited path rather than the step before
one.

## How much API is actually needed

Measured against `@react-x11/components` at `3b82678`, the GL map renderer
(`src/maps/gl/`) uses:

- **64 functions** — `createBuffer`, `bindBuffer`, `bufferData`,
  `createVertexArray`, `bindVertexArray`, `vertexAttribPointer`,
  `vertexAttribDivisor`, `drawArraysInstanced`, `createShader`,
  `shaderSource`, `compileShader`, `createProgram`, `linkProgram`,
  `getUniformLocation`, the `uniform*` family, `createFramebuffer`,
  `framebufferTexture2D`, `renderbufferStorage`, `texImage2D`,
  `texSubImage2D`, `stencilOpSeparate`, `readPixels`, and the state setters.
- **49 constants.**

That is a **WebGL 2** shape — instancing and vertex array objects are in it —
over what is, underneath, OpenGL 3.3 core. Sixty-four functions is a bounded,
mechanical binding job rather than an open-ended one, and it is a fraction of
WebGL 2's full surface (~150), because a renderer that knows what it is
drawing does not use all of it.

Note that two naming conventions exist in the tree and both are real:
`gl.Enable` / `gl.CallList` (the indirect backend's immediate mode, which
`examples/viewer3d.jsx` is written against) and `gl.enable` / `gl.bindBuffer`
(the direct backend's WebGL shape). A Windows context implements the second.

## What `three` needs beyond that

`@react-x11/components/three` renders through the same surface, so it needs
the same context and no more — but it exercises more of the table than the map
renderer does (cube maps, mipmaps, depth textures, more of the `uniform*`
family). Budget the full WebGL 2 surface for it rather than the measured 64.

## The plan

- **Phase G0 — the probe.** `glProbe()` in the bridge, reporting vendor,
  renderer, version, GLSL and whether a core context could be created. Done;
  the numbers above are its output. It is also what the ladder branches on.
- **Phase G1 — a context. Done, though not as written.** A `<glarea>` was to
  become a child window with a WGL core context. It does not: a window
  presenting through DirectComposition has no redirection bitmap, so a child
  HWND composites nowhere and is invisible whatever it draws. The context is
  made against a hidden window and its output reaches the screen through G5
  below. `app.chooseGLConfig` answers, so `glnodes.js` takes its existing
  path. The context is an **ES** one (`WGL_CONTEXT_ES_PROFILE_BIT_EXT`),
  because the shaders these examples ship are GLSL ES and desktop GLSL 1.10
  rejects things like `mat3(mat4)` that ES 1.00 allows.
- **Phase G2 — the table. Done.** Entry points above GL 1.1 come from
  `wglGetProcAddress`, which is per-context and must be resolved after the
  context is current. `maps-gl` draws, and so does the `configurator`
  example's laptop.
- **Phase G3 — the overlay and the input.** `gloverlay.js`'s panes over the
  surface, and the rule `glnodes.js` already states: the surface selects no
  pointer input, so the pointer reaches the tree by propagation. On this
  backend the surface is a visual rather than a window and selects no input
  at all, so the second half is free; the panes are the work.
- **Phase G5 — composited GL. Done, and first.** `WGL_NV_DX_interop2` onto a
  composition visual, because the child-window route above is not a route.
  It is what makes a `<glarea>` participate in the window's alpha instead of
  punching a hole in it — and a hole, as it turns out, would not have shown
  the surface anyway.
- **Phase G4 — ANGLE as the lower rung**, for the driverless case, for an
  Intel configuration without the interop extension, and for CI on WARP,
  behind the same `chooseGLConfig` seam. Now a fallback under a working
  composited path rather than the step before one.

## Open questions

1. **`x11-dri`'s name, a third time.** windows.md's open question 9 and
   wayland.md's open question 4 are the same question, and Windows is the
   platform that settles it: the addon is the GL context and the WebGL-shaped
   table, and the display system is a parameter. A Windows context could be a
   fourth backend inside it rather than a second GL addon in `@windowkit`.
2. ~~**Whether the child HWND is acceptable as the shipped answer**~~ —
   **settled, and not by taste.** A child HWND is not an answer at all here:
   `WS_EX_NOREDIRECTIONBITMAP` is what lets the window present through
   DirectComposition, and DWM drops the redirection bitmap a child window
   would composite into. The question was whether a hole in the window was
   acceptable; it turned out a hole would not have shown the surface anyway.
3. **Which rung CI gets.** WARP gives D3D11 and therefore ANGLE, and gives
   WGL nothing. If `<glarea>` is to be tested at all on a GitHub runner, G4
   stops being optional.
