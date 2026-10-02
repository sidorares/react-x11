# Video: decoding a stream, capturing one, and putting the frames on the screen

_Design record, 2026-09-08, **reviewed 2026-10-02** against master at 65e323a
(react-x11 2.30.0, ntk ^8.17.8, `@windowkit/appkit` ^0.19.0,
`@windowkit/win32` ^0.0.6, `@windowkit/wayland` ^3.1.1, node-x11 4.2.3 in
the lockfile). §0.2 is what has been built since — track 1 of §12 and the
Cocoa half of track 2. §0.1 is what
moved in the month between the two dates and what it changed here; §6 is
the element, §7 the seam it rides, §8 the two consumers it is for, §12 what
can be built now and in what order, and §13 the spikes every number came
from — two of them new, and one of them overturning the conclusion the first
version of this record drew for macOS. The mechanism it extends is
[sprites](../extending.md#parts-of-your-drawing-on-layers-of-their-own),
which shipped where
[element-owned layer contents](element-layer-contents.md) was designed; the
constraint it runs into on X11 is the one
[protocol efficiency](protocol-efficiency.md) measures everywhere else._

---

## 0. TL;DR

- **No X11 extension decodes video.** The one that did — XvMC — is dead,
  and the things that replaced it (VA-API, VDPAU, NVDEC) are not
  extensions at all but C libraries that borrow a `Display*`. On X11 the
  decoder is always ours, in our process, and X's only job is moving
  finished frames to the screen without a copy per pixel. Nothing about
  that changed, and nothing will.
- **On Cocoa both halves are OS services.** VideoToolbox decodes in
  hardware into `CVPixelBuffer`s that are already IOSurfaces, and
  `AVPlayerLayer` is a `CALayer` that shows an `AVPlayer`, which takes a
  URL and does the rest.
  Measured: 1.87ms per 1080p H.264 frame, hardware, every frame
  IOSurface-backed (§3.3).
- **The trap that decided the first version of this record is not a trap
  on screen.** A `CALayer` whose `contents` is a YUV IOSurface rasterizes
  _nothing_ through `render(in:)` — that measurement stands — and shows the
  picture **on screen**, through the render server, for every two-plane
  and packed layout tried: `420v`, `420f` and `2vuy` all render; only the
  three-plane `y420` does not (§3.4, probed today through the window
  server's own capture). So the frame sink on macOS needs no AV layer
  class and no BGRA conversion: a plain layer and an NV12 surface, which
  costs **0.40ms of CPU per 1080p frame** for the copy and the commit
  (§3.4.1). `AVPlayerLayer` is for _sources_ — a URL, with audio, seeking
  and HLS — not a workaround.
- **The seam this needs shipped, under another name.** #499's
  `presentedSurface()` was never built; what landed is **sprites**
  (#819/#821/#828): a node offers parts of its drawing, the surface
  presenter lifts each onto a layer under promotion's rules — the same
  z-order test, the same clip boxes, the same hole, the same "declining is
  always safe" — and today every part's content is a raster the presenter
  paints by calling the part's own `paint`. Video is one addition to that
  vocabulary: **a part whose content is a source** rather than a paint
  (§7). Everything else about lifting a video is already written and
  tested.
- **So a cross-backend `<video>` is one element with two sources.**
  `frames`, a sink the application feeds decoded frames into, on every
  backend; and `src`, a URL the platform plays itself, on the backends that
  have a platform player — AVFoundation now, Media Foundation when the
  Windows half lands — refused with a typed error where there is none (§6).
  Presented two ways everywhere: lifted onto a layer when the frame says it
  can be, drawn into the window's bitmap when it cannot.
- **Two consumers, one element.** A `<video>` in a form is the element.
  A `<video>` inside `@react-x11/components`' `<Html>` is the element too,
  mounted beside the document at the box's rect the way `<Html>` already
  mounts a core `<textinput>` for an `<input>` (§8) — not a second video
  implementation inside the HTML renderer, and not a new seam.
- **Windows has the pieces and none of the design.** The win32 backend is
  a DirectComposition visual tree per window with `<glarea>` on a visual of
  its own and a pane host that already attaches a surface _from a handle_ —
  which is precisely what `IMFMediaEngine`'s windowless swapchain hands
  out. §4 is the plan and the list of things to probe on a Windows machine
  before writing any of it.
- **The X11 numbers that set the budget still stand.** A 1080p frame
  through core `PutImage` costs 33ms with a round trip (§2.5); SHM halves
  it and is already in ntk; Xv is now in node-x11 **and in the lockfile**
  (4.2.3), untouched by anything here; XQuartz still answers "no adaptors
  present", so every Xv path still needs the drawn fallback by
  construction.

### 0.1 Review, 2026-10-02: what moved

| the record said, 2026-09-08                                                                                                                 | the tree says, 2026-10-02                                                                                                                                                                                                                                     | what it changes here                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| a video node is an element-owned layer on #499's `presentedSurface()`, which should answer a layer                                          | #499 is closed, nothing of it built; **sprites** shipped instead (`src/nodes/sprites.js`, `src/cocoa/sprites.js`), a per-frame accessor in the shape of `opaqueRect()` whose parts are rasters painted by the presenter                                       | §7: the seam is a sprite part with `contents`, not a new accessor                                        |
| a `CALayer` draws no YUV IOSurface; use `AVSampleBufferDisplayLayer` or pay 2.1× the decode for BGRA                                        | **on screen it draws every two-plane and packed layout**; the blank was `render(in:)`, a CPU path (§3.4)                                                                                                                                                      | the Cocoa frame sink is a plain layer and two bridge verbs, not an AV class; AV verbs are for `src` only |
| the implementing PR should first verify that the render server scans out a YUV surface                                                      | verified: `420v`, `420f`, `2vuy` render; `y420` and `f420` (three planes) do not; colour attachments change the matching                                                                                                                                      | NV12 is the sink's native format on macOS; I420 is interleaved on the way in                             |
| the bridge should grow `createVideoLayer`, `enqueueSampleBuffer`, `flushVideoLayer` and a synchroniser (against `@windowkit/appkit` ^0.7.0) | 0.19.0: `createSurfaceIOSurface`, `surfaceFromIOSurfaceID`, `setLayerContentsIOSurface`, `surfaceIsInUse`, a `surface-released` event, `snapshotWindow` through `CGWindowListCreateImage`; still no CoreVideo, CoreMedia, VideoToolbox, AVKit or Metal linked | §9: the verb list, in two releases                                                                       |
| whether `snapshotWindow` composites sublayers is open, and decides what the tests can assert                                                | it is the window server's composite, and today's capture holds an `AVPlayerLayer`, an `AVSampleBufferDisplayLayer` and the YUV tiles                                                                                                                          | pixel tests on Cocoa go through `snapshotWindow`; no `render(in:)`                                       |
| two backends                                                                                                                                | four: win32 (`src/win32/`, DirectComposition, `<glarea>` on a visual, a pane host over `CreateSurfaceFromHandle`) and Wayland (`src/wayland/`, dma-buf only, its own GLES rasterizer, no subsurfaces bound)                                                   | §4 and §5, new                                                                                           |
| Xv is a lockfile refresh away                                                                                                               | the lockfile has node-x11 4.2.3 (`PutImage`, `ShmPutImage`, `QueryImageAttributes`, `StopVideo`, both notify selectors); ntk still has no Xv wrapper and the renderer calls none of it                                                                        | the Xv rung is gated on nothing upstream; it is still work                                               |
| camera capture is a separate element, later                                                                                                 | unchanged — and the on-screen result makes both `AVCaptureVideoPreviewLayer` and a raw `2vuy` surface viable layer contents, where the first version doubted both                                                                                             | §3.5's conclusion softens; the element is still later                                                    |
| the ecosystem has nothing to play a video with                                                                                              | `@react-x11/components` has `<MediaPlayer>` (mpv or VLC embedded over `<foreign>`, X11 only, transport over mpv's JSON IPC) and `<Html>` lays a `<video>` out as its poster, or a 300×150 box; neither plays a frame on macOS                                 | §8: what each becomes                                                                                    |

### 0.2 Built, 2026-10-02

- **Core** (§12 track 1): `VideoFrames` (`src/videoframes.js`,
  `createVideoFrames`, `useVideoFrames`), `<video>` (`src/nodes/video.js`)
  drawn on every backend through a `Surface` of its own, `objectFit` for
  `<video>` and `<image>` (`src/nodes/fit.js`), `poster`, HTML's sizing,
  `onLoadedMetadata`, the typed refusal of `src` (`NoMediaPlaybackError`)
  and `useSupports('mediaPlayback')`, false everywhere until a player lands.
  The JavaScript conversion (`frameToRGBA`) applies the matrix and the
  range and no transfer function.
- **The `contents` sprite kind** (§7) in `src/cocoa/sprites.js`, and the
  lift in `src/cocoa/video.js`: a ring of up to four video surfaces, each
  push written and the layer repointed in the push. Measured on the real
  bridge, threaded: sixty pushes, one window frame — the lift's.
- **`@windowkit/appkit` release A** (§9), with the shapes the work settled
  on: `createVideoSurface(width, height, { format, colorSpace, range })`,
  `writeVideoSurface(target, format, planes, { strides, … })` — whose target
  may also be a 2D surface, which is the drawn presentation's whole native
  half — `videoSurfaceIsInUse`, `releaseVideoSurface` and `videoFormats()`.
  The surface holds the IOSurface alone, not the CVPixelBuffer it was made
  through: a pixel buffer keeps a use count on its surface, and
  `IOSurfaceIsInUse` would answer true for one nothing shows.
  `videoSurfacePlanes` was not needed: the copy is 0.07ms at 1080p.
- **A colour finding the record did not have.** With CoreVideo's tags
  alone, Core Animation shows a surface tagged BT.709 throughout with the
  exact 709 curve — while `AVPlayerLayer`, VideoToolbox's pixel transfer,
  Core Image, and Core Animation itself for any other tagging use Apple's
  1.961 gamma: a video-range Y′=47 was sRGB 51 on such a layer and 40 under
  `AVPlayerLayer` playing the same clip. So §3.4's "colour attachments are
  read" was half the story: the bridge names each video surface's colour
  space as the one CoreVideo makes of its tags, which puts a lifted frame on
  the player's curve exactly, and every drawn frame goes through
  VideoToolbox, about 1ms at 1080p. A frame lifted, drawn, and played by
  `AVPlayerLayer` agree to within two levels on screen (the bridge's
  `test/video-surface.js` and `test/player.js`).

Also: the presenter bench's `video` scenario and its gate rule (§9) — a
lifted sink holds to no window frame per push, a rule read as skipped over a
bridge without video surfaces. Not built yet: the player (§12 track 3) and
the Windows and Wayland rungs.

## 1. The asymmetry, stated once

Every other feature in `docs/architecture/` has the same shape on every
backend: a rule, N implementations, one set of semantics. Video does not,
and pretending otherwise would produce an API that is a lie on half the
backends.

On macOS, "play this video" is a supported product: hand `AVPlayer` a URL,
attach `AVPlayerLayer`, and you have hardware decode, HLS, A/V sync,
seeking, HDR and colour management, none of it ours. On Windows the same
product is Media Foundation's `IMFMediaEngine`, whose event vocabulary is
HTML5's media element verbatim. On X11 and Wayland every one of those is a
component someone assembles — a demuxer, a decoder, a clock, a colour
conversion, a presentation path — and the display server contributes only
the last one, badly on X11 unless you leave the protocol for a native
library, and not at all on Wayland, which is a buffer handoff by design.

The design consequence is that the _element_ is shared and the _source_ is
not. A `<video>` whose only prop is a URL would work beautifully on Cocoa
and be a lie on X11, where nothing in this project can open a URL and
produce frames. A `<video>` whose only prop is a frame sink is honest
everywhere but throws away the whole of AVFoundation. §6 is the resolution:
both, with the frame sink as the primitive and the URL as the convenience
of the backends that have a player, asked for with `useSupports` and refused
with a typed error elsewhere.

## 2. X11

### 2.1 Xv, which does not decode

Xv is the extension people mean when they say "the video extension", and
the first thing to be clear about is that it is a **presentation**
extension. It converts colour, it scales, and it puts the result in a
drawable. It does not decode anything.

The model is ports on adaptors. `QueryAdaptors` on a window answers the
adaptors a screen has; each has ports, a type mask (`ImageMask` is the one
that matters — an adaptor that accepts images from client memory rather
than from a capture source), and the visuals it can draw into. You
`GrabPort` one, ask `ListImageFormats` for the FOURCCs it takes (`YV12`,
`I420`, `UYVY`, `YUY2`…), ask `QueryImageAttributes` for the plane pitches
and offsets at your size, and then push a frame per `PutImage` — or
`ShmPutImage`, which is the same request with a shared-memory segment in
place of the payload.

Two things it gives you that are worth the trouble:

- **The colour conversion is the server's.** You push planar YUV at
  1.5 bytes per pixel; the driver produces RGB. For 1080p that is 3.1MB
  per frame instead of 7.9MB, and no CPU of ours touches a pixel.
- **The scale is the server's too**, with `QueryBestSize` to ask what it
  would prefer, and the drawable rectangle chosen per frame — so a resized
  video costs nothing extra on our side.

And the caveats, which are why it is not simply the answer:

- **Overlay adaptors and compositing do not mix.** A hardware overlay
  writes past the compositor; under a compositing WM you want a textured
  adaptor, which every modern driver provides, but the distinction is not
  visible in the protocol and the failure is a black or misplaced
  rectangle.
- **There is no clock.** Xv presents when you ask. Pacing, A/V sync and
  vsync are entirely yours — which is exactly the seam the
  [frame pacer](frame-pacing.md) already owns for everything else.
- **It may not exist.** Measured on this machine: XQuartz advertises
  `X-Video Extension version 2.2` and answers `no adaptors present`. The
  extension is there and useless. Any Xv path needs a fallback by
  construction, not as a nicety.
- **Where it draws.** A textured adaptor's `PutImage` lands in the
  drawable it names. Named at our window it is overwritten by the next
  present of ntk's backing pixmap, and named at a child window of its own
  it stacks above everything drawn, which is the z-order flaw `<glarea>`
  and `<MediaPlayer>` both live with. The honest target is the **backing
  pixmap itself**, at the fitted rect, as a step of the paint pass — then
  the frame composites in paint order and the present carries it. Whether
  ntk will name that pixmap to a caller is a small seam to ask for, and
  the question the Xv rung starts with.

### 2.2 The decode extensions, and what replaced them

**XvMC** is the one X extension that ever did decode: it took MPEG-2
macroblocks, IDCT and motion compensation onto the GPU. It is effectively
dead — a handful of drivers, MPEG-2 and some MPEG-4 only — and it is
unreachable from a protocol client anyway, because the client API is a
vendor `libXvMC*.so` the application dlopens, not wire requests. It is
mentioned here so that the next person who finds it in a list of
extensions does not spend an afternoon on it.

**VA-API, VDPAU, NVDEC** are what people actually use, and none of them
is an X extension. They are C libraries that use X only to obtain a
display and, optionally, to present: `vaPutSurface(Drawable)`,
`VdpPresentationQueueTargetCreateX11`. Underneath they go to DRI and the
kernel. A pure-JS protocol client cannot speak them at all; reaching them
means a native addon, at which point the addon may as well own decode and
presentation together.

The conclusion is the TL;DR's: **on X11 we decode, always.** In practice
that means ffmpeg through a native addon, a WASM decoder, or a subprocess
pipe — and that is a dependency decision (§10), not a rendering one.

### 2.3 The transports

Given frames in our memory, three ways to get them onto the screen, in
ascending order of how little they copy.

**MIT-SHM.** `ShmPutImage` moves a frame through shared memory instead of
the socket. ntk already has this — `ShmUploader` in
`node_modules/ntk/lib/shm-upload.js`, reached through the app's `shm`
getter and used by `putImageData` and by `Image` uploads: a pool of
segments rounded up to a 64KB quantum, the first upload of a size going
out as core `PutImage` while a segment warms behind it, and each segment
returned on `ShmCompletion`. Its own measurements put it at roughly 2× on
uploads, and it is available on XQuartz here. This is the floor of any X11
video path, it is already built, and **the frame sink's drawn presentation
gets it for free** by writing into an ntk `Surface` (§6.3).

**DRI3 + Present.** The modern zero-copy present: `PixmapFromBuffer`
imports a dma-buf fd as a Pixmap, `PresentPixmap` flips it with
`target_msc`/`divisor`/`remainder` for vsync, and
`PresentCompleteNotify`/`PresentIdleNotify` hand back both a frame clock
and buffer recycling. node-x11 ships `dri3.js` and `present.js`, and
`x11-dri` is already an optional dependency. The blocker is the direction:
the DRI3 _receive_ side — importing a buffer somebody else allocated — is
not wired, and that is precisely the direction a hardware decoder needs.
This is the right long-term path and the largest piece of work in this
document.

**GLX / direct GL.** Upload Y and CbCr as textures and convert in a
fragment shader. This works **today**, through `<glarea>`, with no new
protocol at all: see [gl.md](../gl.md) and the direct-GL notes in
[glx.md](../glx.md). It is the fastest thing to prototype and it costs a
`<glarea>`'s constraints — the node owns a real child window or layer, and
its pixels cannot be read back through the X path. It is also, as it
happens, the shape of the Wayland answer (§5), where the backend's whole
2D context is a GLES rasterizer.

### 2.4 What node-x11 has

Until 2026-09-07 `lib/ext/xv.js` implemented the half of Xv that asks
questions and none of the half that answers with pixels. That gap is
closed —
[sidorares/node-x11#294](https://github.com/sidorares/node-x11/issues/294)
was fixed by
[#295](https://github.com/sidorares/node-x11/pull/295) — and, since this
record was first written, **installed**: the lockfile carries 4.2.3, so
`npm ci` now gets the image path. The refresh the first version asked for
has happened.

| Xv minor opcode                                 | 4.1.0 | 4.2.0+  |
| ----------------------------------------------- | ----- | ------- |
| 0–4 version, adaptors, encodings, port grab     | yes   | yes     |
| 5–8 `PutVideo`/`PutStill`/`GetVideo`/`GetStill` | no    | no      |
| 9 `StopVideo`                                   | no    | **yes** |
| 10 `SelectVideoNotify` / 11 `SelectPortNotify`  | no    | **yes** |
| 12–16 best size, port attributes, image formats | yes   | yes     |
| 17 `QueryImageAttributes`                       | no    | **yes** |
| 18 `PutImage`                                   | no    | **yes** |
| 19 `ShmPutImage`                                | no    | **yes** |

5–8 remain absent on purpose — they are the capture-card half of the
extension, as dead as XvMC, and §3.5's answer to "where do camera frames
come from" is not Xv.

Two things about the implementation that bound what this document can
assume:

- **`PutImage` refuses a frame the connection cannot carry**, rather than
  sending it and having the server drop the connection over a bad request
  length. The 40-byte header plus a padded payload has to fit
  `max_request_length`, which without BIG-REQUESTS is 256KB. A 1080p
  `I420` frame is 3.1MB, so **`PutImage` alone cannot carry an HD frame on
  a connection without BIG-REQUESTS**, and will say so instead of failing
  mysteriously.
- **`ShmPutImage` sidesteps that entirely**, because its 52 bytes carry a
  `SHMSEG` and no payload. So for HD it is not an optimisation over
  `PutImage`; it is the path.

What is still missing is ours: ntk has no Xv wrapper (its only `xv`
substrings are `Xvfb` and `glxVisual`), and nothing in `src/` requires the
extension. The rung is gated on nobody but us (§12).

### 2.5 Measured: what the naive path costs

The question that decides whether "decode in-process and `PutImage` the
result" is even worth prototyping. A 1920×1080 frame at depth 24, pushed
to an offscreen pixmap with a `GetInputFocus` round trip after each so the
server has demonstrably consumed it, on XQuartz over a unix socket, M1 Pro:

| path                                  | median  | min     | p95     |
| ------------------------------------- | ------- | ------- | ------- |
| core `PutImage`, 7.9 MiB BGRA, + sync | 33.19ms | 25.22ms | 48.26ms |

That is **238 MiB/s and a 30.1fps ceiling** with zero time left for
layout, paint, or the rest of the application — for one video, at 1080p,
on a local socket. It is a bound rather than a Linux number (XQuartz is
not a DRI-backed server), but it is the right order of magnitude for the
shape of the problem, and it prices the alternatives:

- `420v` instead of BGRA is 3.1MB instead of 7.9MB — **2.6× less to
  push**, before SHM.
- SHM removes the socket copy; ntk's own figure is ~2× on uploads.
- Xv does both _and_ moves the colour conversion and the scale off our
  CPU — which is why it was worth the upstream request even though the
  extension is absent on XQuartz.

What follows for the element: on X11 the sink wants **BGRA frames**, and
says so (§6.3's `preferredFormats`), because a decoder that can emit BGRA
does the conversion in C for nothing, and one that cannot leaves it to a
JavaScript loop over two million pixels. At 720p — the size a video in a
form actually is — a BGRA frame is 3.7MB, which by the two numbers above
the SHM path puts on the screen in the order of ten milliseconds on
XQuartz — derived, not measured, and owed a measurement by the bench
scenario in §12. That is the honest X11
budget until the Xv rung, and a document that said otherwise would be
read by someone building a 4K player on a `PutImage`.

## 3. Cocoa

### 3.1 Decode

`VTDecompressionSession` is the primitive: build a
`CMVideoFormatDescription` from the stream's parameter sets, feed it
`CMSampleBuffer`s, get `CVPixelBuffer`s. Ask for IOSurface backing with
`kCVPixelBufferIOSurfacePropertiesKey` and every output buffer is a
surface the render server can already read.

Measured on this machine (macOS 15.2 then, M1 Pro),
`VTIsHardwareDecodeSupported`:

| codec      | hardware |
| ---------- | -------- |
| H.264      | yes      |
| HEVC       | yes      |
| ProRes 422 | yes      |
| AV1        | no       |
| VP9        | no       |

AV1 is the one to plan around: hardware AV1 decode arrives with M3-class
silicon, so an AV1 stream on this machine is a software path or nothing.

Above VideoToolbox, AVFoundation supplies the parts we would otherwise
write: `AVAsset` + `AVAssetReader` for files frame by frame, `AVPlayer` /
`AVPlayerItem` for URLs including HLS,
`AVPlayerItemVideoOutput.copyPixelBuffer(forItemTime:)` to pull frames in
step with a display link, `AVCaptureVideoPreviewLayer` for a camera, and
ScreenCaptureKit for the screen.

### 3.2 The presentation ladder

Every rung is a `CALayer`, which is why all of them compose with layer
promotion and with the sprite order unchanged.

1. **`AVPlayerLayer`** — set `player`, set `videoGravity`, done. No pixel
   code and no JS in the frame path at all. Everything about the source is
   AVFoundation's. **The rung for `src`.**
2. **`AVSampleBufferDisplayLayer`** — enqueue `CMSampleBuffer`s from our
   own demuxer or socket; it decodes and schedules them itself, and
   `AVSampleBufferRenderSynchronizer` with a `CMTimebase` is how it is
   synchronised against audio. The rung for "a compressed stream that is
   not a file or a URL" — which no consumer in §8 has yet.
3. **A plain `CALayer` whose `contents` is the decoded IOSurface** — the
   rung this repo is already standing on, since `setLayerContentsIOSurface`
   is how `<glarea>`, the `<Frame>` pane host and the window swapchain all
   present. **The rung for `frames`**, now that §3.4 says it takes YUV.
4. **`CAMetalLayer` + `CVMetalTextureCache`** — zero-copy `MTLTexture`
   from the pixel buffer, full shader control, our own colour conversion
   and scaling. Nothing here needs it.
5. `CAOpenGLLayer` — legacy, and `<glarea>`'s neighbourhood.

### 3.3 Measured

The 2026-09-08 spike encodes a synthetic sequence with VideoToolbox,
decodes it back, and times each step. 1920×1080 H.264, 60 frames, hardware
acceleration confirmed on the session, every output buffer IOSurface-backed:

| step                                         | median  |
| -------------------------------------------- | ------- |
| decode a 1080p H.264 frame, default output   | 1.868ms |
| decode the same frame, output forced to BGRA | 3.917ms |
| `layer.contents = ioSurface`                 | 0.04µs  |

At 1280×720 the same measurement is 1.143ms for H.264 and 0.932ms for
HEVC. The flip is **below the resolution of a microsecond timer**, because
the assignment itself is a pointer swap and the transaction commit is
where CA's cost lives.

`AVSampleBufferDisplayLayer` accepted all 30 compressed sample buffers it
was offered headless, with `status` rendering and no error.

### 3.4 The YUV surface: blank through `render(in:)`, drawn on screen

A hardware decoder's natural output is `420v` — bi-planar 8-bit
video-range YCbCr, two planes, 3.1MB for 1080p. Our swapchain surfaces are
BGRA. The obvious move is to hand the decoder's surface straight to the
existing `setLayerContentsIOSurface` verb.

The first version of this record measured that through
`CALayer.render(in:)` and got an empty box: 0 of 4096 pixels for a decoded
`420v` frame, 0 of 4096 for a captured packed `2vuy` one, against BGRA and
`CGImage` controls at 4096 of 4096 through the same probe. It read that as
"a `CALayer` takes any YUV IOSurface and draws none of them", recommended
AV layer classes for everything, and — to its credit — ended with "whether
the render server scans out a YUV surface on screen is not settled by it,
and that is the very first thing the implementing PR should check".

Checked today (`scripts/spikes/video/yuvscan.swift`, §13): ten tiles in a
borderless window, each a `CALayer` on screen, the window captured
through the window server (`screencapture -l`, the same source as the
bridge's `snapshotWindow`), and the centre pixel of each tile read back.
macOS 15.8.1, M1 Pro:

| layer `contents`                               | on screen, window-server capture | `render(in:)`, 2026-09-08 |
| ---------------------------------------------- | -------------------------------- | ------------------------- |
| BGRA IOSurface — control                       | blue, as filled                  | 4096 / 4096 px            |
| `420v` IOSurface, 2 planes, video range        | **green, as filled**             | 0 / 4096 px               |
| `420f` IOSurface, 2 planes, full range         | **green, as filled**             | —                         |
| `2vuy` IOSurface, 1 packed plane               | **green, as filled**             | 0 / 4096 px               |
| `y420` IOSurface, 3 planes, video range        | nothing: the tile is transparent | —                         |
| `f420` IOSurface, 3 planes, full range         | nothing: the tile is transparent | —                         |
| `AVSampleBufferDisplayLayer`, 30 H.264 frames  | red, as encoded                  | —                         |
| `AVPlayerLayer`, a `.mov` written by the probe | magenta, as encoded              | —                         |
| `CGImage` — control                            | orange, as drawn                 | 4096 / 4096 px            |

Three conclusions, and the first two overturn what was written here before:

- **The render server draws YUV layer contents.** `render(in:)` is a CPU
  path that does not, which is a fact about testing, not about the screen
  (§13 says what to test through instead). The "free" path is free.
- **Two planes or packed, not three.** Every bi-planar and packed layout
  tried renders; the three-plane planar ones — what ffmpeg calls
  `yuv420p`, the default output of nearly every decoder — draw nothing:
  the layer is transparent and the window shows through.
  So the sink's native format on macOS is **NV12**, and an I420 frame is
  interleaved into one on the way in: a loop the bridge's write verb does
  over 1.5 bytes per pixel, in the same pass as the copy it has to make
  anyway.
- **Colour attachments are read, and change the picture.** A second
  `420v` tile with a BT.601 matrix and an sRGB colour space attached
  rendered a visibly lighter green than the bare one. The sink has to say
  what its bytes mean (§6.3: `colorSpace`, `range`), and the bridge has to
  attach it to the surface — the Generic-RGB default has bitten this
  backend before (#820), and a video that is subtly the wrong colour is
  the kind of defect nobody files.

The cost of the three ways out stays on record because two of them are
still what `src` and a compressed stream use, and because the number is
what proves the sink should not convert: forcing BGRA out of the decoder
costs **2.1× the decode** (3.917ms against 1.868ms) plus 8.3MB per surface
against 3.1MB; `AVSampleBufferDisplayLayer` takes YCbCr natively and brings
A/V sync; Metal is its own render loop.

#### 3.4.1 Measured: what the frame sink costs through a plain layer

The question §6.3 rests on: when decoded bytes arrive from a decoder — over
a pipe, from an addon, from a WASM module — what does it cost to show them
through rung 3? `scripts/spikes/video/sinkcost.swift` stands a `memcpy`
into a locked IOSurface in for the read, points a layer at it inside a
transaction, and paces the loop to 60Hz so the render server has a real
frame per iteration. 1920×1080, a ring of three surfaces, 240 frames,
process CPU from `getrusage`, two runs each:

| format      | bytes per frame | CPU per frame  | note                                      |
| ----------- | --------------- | -------------- | ----------------------------------------- |
| NV12 (420v) | 3.11 MB         | 0.40 – 0.43 ms | the copy and the commit; nothing converts |
| BGRA        | 8.29 MB         | 0.69 – 0.72 ms | the same, over 2.7× the bytes             |

The wall time per iteration is the 60Hz pacing, not a cost. So a
1080p60 sink lifted onto a layer is **about 25ms of CPU per second**
in the process that feeds it, before the decoder; the decoder is the
whole budget, and the presentation is noise beside it. That is the number
that says the sink needs no JS frame per video frame and no pacer claim:
a `push()` on a lifted sink writes the surface and repoints the layer
right there, and react-x11's own frame clock is not involved until the
next frame re-decides the lift (§7).

### 3.5 Capture: the same stack, one step shorter

A webcam is the same set of API calls with the decode removed.
`AVCaptureSession` delivers `CMSampleBuffer`s carrying IOSurface-backed
`CVPixelBuffer`s — the same objects a `VTDecompressionSession` produces —
and `AVCaptureVideoPreviewLayer` is a `CALayer`, so rung 1 of §3.2 serves a
camera exactly as it serves a file. And since §3.4, so does rung 3: a
camera's native `2vuy` frame is a layer content the screen shows.

Three things separate capture from playback, and only one of them is work.

**The permission half is already built.** `camera` and `microphone` are
first-class kinds in [permissions.md](../permissions.md) —
`usePermission('camera')`, `permissionStatus`, `requestPermission`,
`openPrivacySettings` — translated in `src/cocoa/permissions.js` onto the
bridge's `authorizationStatus`/`requestAuthorization` verbs, which are
`AVCaptureDevice`'s underneath (the one place the bridge links
AVFoundation today). A capture element does not need to touch TCC at all.

**Discovery needs no authorization.** `AVCaptureDevice.DiscoverySession`
enumerates cameras and microphones, names included, while the status is
still `notDetermined` — no prompt, no indicator light. A device picker can
be built and rendered before consent; only the frames are gated.

**The conversion is not free, and this is the finding.** A camera's native
delivery is YUV — `2vuy` at the 720p preset here. Asking the output for
BGRA instead is one line and is the conventional capture configuration.
Measured, 1280×720, 60 frames per configuration, camera live:

| output configuration | delivered | process CPU   | delivery interval | our callback |
| -------------------- | --------- | ------------- | ----------------- | ------------ |
| native, no settings  | `2vuy`    | 4.16ms/frame  | 33.5ms            | 0.054ms      |
| `videoSettings` BGRA | `BGRA`    | 11.12ms/frame | 33.0ms            | 0.095ms      |

**+6.96ms per frame, 2.67×**, charged to our own process rather than to the
camera daemon, on another thread — so it burns a core rather than dropping
frames, which is precisely the kind of cost the frame pacer cannot see.
The absolute figures amortize one-time session setup over 60 frames; the
delta is the trustworthy part.

So capture reaches the same conclusion as playback by the same route: do
not convert. Hand the session to `AVCaptureVideoPreviewLayer`, or hand its
native surfaces to a plain layer; both are on the screen.

**What the tests cannot do.** A running `AVCaptureVideoPreviewLayer` with a
live connection rasterized 0/4096 through `layer.render(in:)` — which, after
§3.4, is unsurprising rather than alarming. Capture pixel tests go through
the window server's capture like every other layer's, or through an
`AVCaptureVideoDataOutput` tap.

**One packaging finding, because it will cost someone an afternoon.** A
correctly signed `.app` carrying `NSCameraUsageDescription` and a
`CFBundleIdentifier`, executed directly from a shell, answered
`requestAccess` with `granted = false` while `authorizationStatus` stayed
`notDetermined` — a refusal that never prompted. Launched through
LaunchServices (`open`), so that the app is its own responsible process,
the same binary prompted and was granted. This is the same shape as the
notification rung's trap in [packaging.md](../packaging.md), and the same
rule applies: **a falsy grant with the status still `notDetermined` is not
a denial**, and code that reads it as one tells the user they declined
something they were never asked.

## 4. Windows

_Written on a Mac against the bridge's source at v0.0.6 and
[windows.md](../windows.md). Nothing below has been run; §4.3 is what to
run first._

### 4.1 What the backend has

A window on win32 is a DirectComposition **visual tree**: one target, one
root visual whose content is a virtual surface in `B8G8R8A8`, painted one
`BeginDraw` per damage rect and committed once per frame
([windows.md](../windows.md#rendering)). Under the root visual hang the
children an element can own today, each on a visual of its own:

- **`<glarea>`**, a composition swapchain filled through a WGL context and
  `WGL_NV_DX_interop2`, added at the _bottom_ of the children
  ([windows-gl.md](../windows-gl.md)). A child HWND was built, measured
  invisible in every variant, and abandoned
  ([windows-embedding.md](../windows-embedding.md)).
- **A `<Frame>` pane**, attached from a surface _handle_ another process
  presents into: `DCompositionCreateSurfaceHandle` on the pane's side,
  `CreateSurfaceFromHandle` and a visual on the host's
  (`paneAttach`, `paneSetRect` with its clip).
- **Layers**, a premultiplied virtual surface on a visual at the _top_ of
  the children, which is what `<glarea>`'s drawn children paint on
  (`layerCreate`, `layerBeginDraw`, `layerScroll`).

What it does not have is a presenter that decides, per frame, whether an
element's content may sit on a visual of its own: the Windows retained tier
and promotion are a Phase 4 probe in windows.md, not code, and the sprite
seam is asked on macOS only. So on win32 today a visual is where
`<glarea>`'s is — above the 2D surface, under the layers, and under
whatever the 2D surface paints after it is not. There is no Media
Foundation, no YUV, no `DXGI_FORMAT_NV12` anywhere in the bridge, and
`windowPixels` reads the window back through `PrintWindow`.

### 4.2 The plan

**`src` is `IMFMediaEngine`**, the platform's player, which has two ways to
show a picture and the backend wants both, in this order:

1. **Frame-server mode first.** `TransferVideoFrame` copies the current
   frame into a D3D11 texture on request; the backend draws that texture
   into the window's surface at the fitted rect, in paint order, like an
   `<image>` whose bytes changed. A copy per frame — but a GPU copy, and
   correct under every tooltip, popup and fade, with no new z-order rule.
   This is the drawn presentation of §7, and on Windows it is the one that
   ships first because nothing there can yet decide the other.
2. **Windowless swapchain mode second.** `EnableWindowlessSwapchainMode`,
   `GetVideoSwapchainHandle`, and the handle goes to the exact call the
   pane host already makes — `CreateSurfaceFromHandle` onto a visual at
   the element's rect. Zero copies, the engine presents on its own clock,
   and the overlay planes can scan it out where the GPU has them. It
   needs what `<glarea>` lacks: a per-frame answer to "is anything drawn
   over this", which is the Windows half of promotion. Until then it is
   `<glarea>`'s stacking, and a video element should not inherit that
   quietly.

The engine's notifications — `LOADEDMETADATA`, `TIMEUPDATE`, `PLAYING`,
`PAUSE`, `ENDED`, `ERROR` — are the element's events already (§6.1); the
bridge forwards them as it forwards everything else, in batches, off the
engine's work queue onto Node's thread.

**`frames` is a texture.** A decoded frame arrives as bytes; the bridge
puts them in a `D3D11_USAGE_DYNAMIC` texture and the drawn presentation
composites it. BGRA is the floor. NV12 is the better transport —
`DXGI_FORMAT_NV12` textures are routine, and a flip-model composition
swapchain in NV12 on a visual of its own is what windows.md's rendering
section already names for video — but whether the adapter will create one
is a `CheckFormatSupport` question per machine, and the fallback is a
`ID3D11VideoProcessor` blit to BGRA. Both are probes, not plans.

### 4.3 What to probe first, on the Windows machine

In the order that decides the most for the least:

1. `IMFMediaEngine` from a bridge thread: create it from
   `MFMediaEngineClassFactory` on the UI thread with a DXGI device manager
   over the bridge's D3D11 device, load a file URL, confirm
   `LOADEDMETADATA` and the frame size, and `TransferVideoFrame` into a
   texture the 2D surface can draw. That is the whole drawn path.
2. `EnableWindowlessSwapchainMode` + `GetVideoSwapchainHandle` +
   `CreateSurfaceFromHandle` on a visual: does the picture appear, does
   `paneSetRect`'s clip apply to it, and does it respect the visual's
   place among the children?
3. `windowPixels` over 1 and 2: does `PrintWindow` with full-content
   rendering see a swapchain visual's frame? It decides what the tests can
   assert without a capture tool.
4. `CheckFormatSupport(DXGI_FORMAT_NV12)` with `DISPLAY` and
   `TEXTURE2D`, and a composition swapchain in NV12: on the GPU in the
   machine and on WARP, since CI is WARP.
5. The cost of the frame-server copy at 1080p60: a GPU copy is cheap, and
   the number is still owed before it is called cheap here.
6. Media Foundation's threading against the bridge's UI thread: the engine
   wants a multithreaded apartment and a work queue; the UI thread is an
   STA for OLE. Confirm the notify callback can post to the bridge's event
   batch without a wait on the UI thread.

## 5. Wayland

The Wayland backend presents dma-bufs and nothing else: every frame is
drawn by its own GLES rasterizer into a GPU target and handed over through
`zwp_linux_dmabuf_v1`; `wl_shm` is bound for screen capture only; and
`wl_subcompositor` is never bound, by design — a subsurface would be a
second swapchain, a second frame clock and a second import per frame
([wayland-backend.md](../wayland-backend.md)). Its `<glarea>` is a
rectangle of the window's own target, not a surface of its own.

That makes its video story the shortest one here and, for the frame sink,
the cheapest: **the backend's 2D context is already a GL rasterizer**, so
decoded planes go up as textures and the colour conversion is a sampler in
a fragment shader — the GLX transport of §2.3, native to the backend rather
than bolted on, and with no conversion in JavaScript for any format. The
sink's drawn presentation on Wayland takes NV12, I420 and BGRA alike and
prefers whichever the decoder emits. Nothing lifts: there is no layer to
lift onto and no compositor-side scaler asked for, and `wp_viewporter` is
used for the window's fractional scale only.

`src` has no answer on Wayland for the same reason it has none on X11 — no
display-server player exists; GStreamer and PipeWire are libraries, and
the application that wants them brings them (§8.3) — so
`useSupports('mediaPlayback')` is false there and `<video src>` refuses the
way it does on X11. The zero-copy future is the same shape as X11's DRI3
one: a decoder that exports dma-buf fds (VA-API does) and a subsurface that
imports them, both of which the backend has deliberately not built, and
neither of which a form with a video in it needs.

## 6. The element

### 6.1 `<video>`

```jsx
// a file or URL the platform plays itself — AVFoundation today,
// Media Foundation when the Windows half lands
<video
  src="file:///Users/me/clip.mp4"
  autoPlay
  muted
  loop
  style={{
    width: 320,
    height: 180,
    objectFit: 'contain',
    backgroundColor: '#000',
  }}
  onLoadedMetadata={({ width, height, duration }) => setDuration(duration)}
  onTimeUpdate={({ currentTime }) => setAt(currentTime)}
/>;

// frames the application decodes — every backend
const frames = useVideoFrames({ width: 1280, height: 720, format: 'NV12' });
useEffect(() => {
  const decoder = startDecoder(url, frames.preferredFormats);
  decoder.on('frame', (planes, time) => frames.push(planes, { time }));
  return () => decoder.stop();
}, [frames, url]);
<video frames={frames} style={{ width: '100%', aspectRatio: 16 / 9 }} />;
```

A `<video>` is a **drawn** node like `<image>` — it joins yoga, it is in
the paint order, it is hit-tested like anything — not a `drawn: false`
child window like `<glarea>` or `<foreign>`. That is the whole point of
§7: a video in a form sits _under_ the form's popups and tooltips and
_inside_ its scroll panes, and a child window can do neither.

| prop                                                                |                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src`                                                               | A path or URL, played by the platform. Where `useSupports('mediaPlayback')` is false the element reports one typed `onError` on a microtask and shows its `poster` — never a silent black box, the rule `<foreign>` set in #531. |
| `frames`                                                            | A `VideoFrames` sink (§6.3). Mutually exclusive with `src`, and passing both throws, the way `<image>`'s `src`/`picture`/`drawable` do.                                                                                          |
| `poster`                                                            | An `ImageSource`, shown until the first frame and whenever there is nothing to show.                                                                                                                                             |
| `autoPlay`, `loop`, `muted`, `volume`, `playbackRate`               | HTML's names and HTML's defaults: nothing plays until asked. Meaningful with `src`; a sink plays what it is pushed.                                                                                                              |
| `paused`                                                            | Controlled when present, the shape `<MediaPlayer paused>` already has. Left out, the element is uncontrolled and the handle drives it.                                                                                           |
| `onLoadedMetadata({ width, height, duration })`                     | The stream's size is also the element's natural size, kept to its ratio when the style names one axis; before it is known, HTML's 300×150.                                                                                       |
| `onPlay`, `onPause`, `onEnded`, `onTimeUpdate`, `onError`           | `onTimeUpdate` is coalesced to a few a second, as HTML's is, so a progress bar costs a render per tick and not per frame.                                                                                                        |
| `ref` → `{ play(), pause(), seek(seconds), currentTime, duration }` | The imperative half, for the same reason `HTMLMediaElement` has one: a seek is an event, not a state.                                                                                                                            |
| `role`, `aria-label`                                                | `video` by default — a role the accessibility model gains with the element, AT-SPI's `ROLE_VIDEO` beside `img`'s `IMAGE` — named by `aria-label`; the frames themselves are not described.                                       |

Style, in `style` like everything else: `width`/`height` as any element;
`objectFit` — `'contain'` by default, `'cover'`, `'fill'` — decides where
the picture goes in the box, and `backgroundColor` is what shows in the
bars. `objectFit` is a new paint property and applies to `<image>` as well
in the same change, since an image stretched to its box has wanted it for
as long as there has been an `<image>`; `borderRadius` on a `<video>` is
legal and costs the drawn presentation on macOS (§7), which the docs say
in one sentence next to the prop.

### 6.2 What `useSupports('mediaPlayback')` answers

Whether `<video src>` plays on this display: true on Cocoa once the player
verbs ship, true on win32 once §4's first probe becomes code, false on X11
and Wayland for good, false on every backend until then. It is a property
of the display's pipeline, which is what `useSupports` answers; the
desktop-service shape (`{ available, backend, features }`) is for things
that come and go while the process runs, and a platform player does not.
`frames` needs no capability: it works everywhere, at a cost that differs.

### 6.3 `VideoFrames`, the sink

```ts
createVideoFrames(app, {
  width, height,
  format: 'NV12' | 'I420' | 'BGRA',
  colorSpace?: 'bt709' | 'bt601' | 'bt2020', // default bt709
  range?: 'video' | 'full',                   // default video
}): VideoFrames

interface VideoFrames {
  readonly width: number; readonly height: number; readonly format: VideoFormat;
  /** this backend's order of preference, for a decoder that can choose */
  readonly preferredFormats: readonly VideoFormat[];
  push(planes: Buffer | readonly Buffer[], opts?: { strides?: number[]; time?: number }): void;
  close(): void;
}

useVideoFrames(options): VideoFrames // stable across renders; new when size, format or colour changes; nothing to close
```

Three rules, each of which is a cost somewhere:

- **The newest frame is the frame.** A `push` while the last one is not yet
  shown replaces it; nothing queues. A sink is a mirror of a decoder's
  output, not a transport with back-pressure, and the decoder's own clock
  is the pacing — exactly as a `<canvas>` animation's is.
- **Every format is accepted everywhere; the cheap one differs.** A decoder
  that can choose reads `preferredFormats`; one that cannot still works,
  with the conversion charged where it happens:

  | backend | lifted                                                         | drawn                                                                                                           | `preferredFormats`     |
  | ------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------- |
  | Cocoa   | NV12 as is; I420 interleaved on the write (bridge); BGRA as is | BGRA; NV12/I420 converted in the bridge by VideoToolbox, colour-matched to sRGB, about 1ms at 1080p             | `NV12`, `I420`, `BGRA` |
  | X11     | —                                                              | BGRA into an ntk `Surface` (SHM where the server has it); NV12/I420 converted in JS, which is not free at 1080p | `BGRA`                 |
  | win32   | later: an NV12 swapchain on a visual (§4.2)                    | BGRA into a texture; NV12/I420 through the video processor, or in JS until then                                 | `BGRA`, then `NV12`    |
  | Wayland | —                                                              | NV12, I420 and BGRA as textures; YUV sampled in the shader, no conversion anywhere                              | `NV12`, `I420`, `BGRA` |

- **`push` is not a frame.** On a lifted sink it writes a surface from the
  ring and repoints the layer in a transaction of its own, and react-x11's
  frame clock does not run — 0.4ms of CPU at 1080p (§3.4.1) and no claim
  for the [pacer](frame-pacing.md) to price. On a drawn sink it claims the
  element's content rect, bounded, and the next frame composites the new
  bytes like an `<image>` whose `src` changed — priced like any claim, and
  the first thing a profile of an X11 player shows.

Where the bytes come from is the application's business (§10), and the
sink's design keeps it that way: an `ffmpeg` child process writing
`rawvideo` to a pipe, a WASM decoder, a native addon over libmpv or VA-API
all end in the same `push`.

## 7. The seam: a sprite whose content is a source

Sprites ([extending.md](../extending.md#parts-of-your-drawing-on-layers-of-their-own),
`src/nodes/sprites.js`, `src/cocoa/sprites.js`) are how an element hands
parts of its drawing to the surface presenter, which lifts each onto a
`CALayer` above the window's bitmap under promotion's rules: asked every
frame after layout and before the damage is taken; refused when anything
painted after the element reaches into the part, when the element or an
ancestor fades, when a rounded clipping ancestor does not hold all of it,
when it sits inside a `<glarea>`, or when a side exceeds 8192 device
pixels; cut by a box layer with `masksToBounds` to every square clipping
ancestor; a hole in the element's own paint from the frame `spritesLifted`
says so; the bitmap under it claimed on the way onto a layer and off it.
Today a part's content is always a raster: the presenter calls the part's
`paint` into a surface of its own and hands that surface to the layer, and
paints again when the `version` changes.

A video is a part whose content the presenter does **not** paint:

```js
sprites() {
  if (!this.source || !this.frameRect) return null;
  return [{ key: 'video', rect: this.frameRect, clip: this.contentBox(), contents: this.source }];
}
```

- `contents` is a `VideoFrames` sink, or the player a `<video src>` made.
  A part with `contents` has no `paint` and no `version`, and for now no
  `animations` — nothing in §8 wants a video that fades on the render
  server, and a fade on the element itself is a refusal, as it is for
  every sprite.
- **Lifted**, the layer's content is the source's: for a sink, the ring
  surface `push` last wrote, repointed by `push` itself between frames
  (§6.3); for a player, the `AVPlayerLayer` the bridge made, added under
  the clip box at the part's place in the one order every layer above the
  bitmap shares. The element paints its bars and leaves the hole.
- **Declined**, the element draws the source's current frame itself:
  `source.draw(ctx, rect)`, a `drawImage` of the sink's BGRA surface, or
  of the frame the bridge pulls from the player on request
  (`AVPlayerItemVideoOutput`, one verb, lazily made, §9). Every reason a
  sprite is declined is a reason a video is drawn for a while — a tooltip
  over it, a dialog's dim, a rounded card that does not hold it — and
  since declining is decided per frame, the cost lasts exactly as long as
  the reason.
- **Everything else is promotion's, unchanged**: the z-order test asked
  at the part's extent, the clip boxes, the claim of the bitmap under it,
  the one order with the promoted nodes. A `contents` part makes
  `SpriteLayers` skip its raster and ask the source for a layer or a
  surface, and that is the whole change on the presenter's side.

Why not a child window or layer of the element's own, the way `<glarea>`
has one: because a `<glarea>`'s layer sits at a fixed `zPosition` above
everything the presenter draws, is never clipped by an ancestor, and
cannot be drawn over — `<MediaPlayer>`'s own documentation explains that
its transport bar cannot be a sibling `<box>` for exactly this reason. A
video in a form is content, and content lives in the paint order. The
sprite seam is the one that lets a thing be on a layer when it can and in
the bitmap when it must, and that is the property this element needs
most.

Why not `Node._promoted`, promotion's own hole: because promotion lifts a
plain `<box>` for an animation it can express, and re-rasters the node's
children into the layer itself. A video's content is nobody's raster.

And why `<video>` is the first implementer and not only a consumer: the
element's one part is itself, which is the simplest possible sprite — and
it proves the `contents` kind for any registered element that wants to
show a live source inside its own drawing, a chart with a camera feed in
its corner being the obvious one. The **X11, Wayland and win32 presenters
never ask**, so the same element draws itself there as it always would.

## 8. The two consumers

### 8.1 A `<video>` in a form

The element of §6, with nothing between the application and it. On macOS,
`<video src>` with the player verbs: no JS in the frame path, audio and
seeking from AVFoundation, lifted under the form's own popups and tooltips
and drawn for the frames a dialog dims it. On X11, `useSupports` says no to
`src`, and the application decodes into `frames` — the ecosystem's job to
make that one line, below.

### 8.2 A `<video>` inside `<Html>`

`@react-x11/components`' `<Html>` is one registered element, `<htmlview>`,
that parses, lays out and paints a document into the window's own context.
Its `<video>` today is its `poster` as an image box, or a 300×150 frame
with nothing in it; its `<audio>` is nothing at all; and it has no hook by
which a host supplies a renderer for a tag. It lifts a CSS animation onto
a layer through the sprite seam (#620), and it mounts **real core widgets
beside the document** for form controls — a `<textinput>` at an `<input>`'s
rect, cut to the box's clip and faded by its opacity, reported through
`onControls` — on the rule its source states: _a drawn control is a picture
of a control_.

A drawn video is a picture of a video, and the same rule gives the same
answer. `<Html>` reports its media boxes the way it reports its controls —
rect, clip, opacity, and the attributes `src`, `poster`, `autoplay`,
`loop`, `muted` — and its React half mounts a core `<video>` beside the
document at each, absolutely positioned and clipped exactly as a widget is.
Everything the element knows applies: it lifts on macOS when its part is
clear, it draws when it is not, it scrolls with the pane because its `abs`
does, and `src` refuses where `useSupports` says so, which `<Html>` turns
into the poster it shows today. `onResource` grows a `kind: 'video'` so a
host that has a decoder can answer a URL with a `frames` sink instead,
and a host that has none declines and gets the poster.

What `<Html>` decides for itself, and should say in its docs: a video box
that something later in the document paints over — an overlay of controls,
a caption positioned across it — is declined and stays a poster, the same
`paintedAfter` rule its sprites already apply, because a sibling mounted
above the document would hide the overlay. HTML's `controls` attribute is
not drawn by `<Html>`: the transport bar an application wants is its own
React, over or under the box, the position `<MediaPlayer>`'s docs already
take. And `<audio>` is not this element: a sound with no box is a player
with no presentation, which is a different feature and a smaller one.

### 8.3 `<MediaPlayer>`, and where a decoder comes from

`<MediaPlayer>` embeds mpv or VLC over `<foreign>`, drives it over mpv's
JSON IPC, and is X11-only because `--wid` is an X mechanism; on macOS it
reports `unavailable`. It keeps doing that: an application that already
has mpv and an X display has a player with audio, subtitles and every
codec, and nothing here replaces it. What changes is its ceiling. Its
window stacks above everything drawn, so it cannot be scrolled under a
header, dimmed by a dialog or overlaid by a transport bar — and a backend
of it that decodes into a `<video frames>` sink instead of a window has
none of those limits, on every backend, at the cost of the audio path and
the sink's bytes. The shape of that backend is the ecosystem's decision,
not this record's; the two candidates are an `ffmpeg` child process
writing `rawvideo` to a pipe (pure JS, silent, every backend), and a native
addon over libmpv's software render API (audio, seeking, subtitles, every
backend, one prebuilt binary). Either one makes `<MediaPlayer>` the thing
a React developer reaches for and `<video>` the primitive it stands on,
which is the right order.

### 8.4 Camera, later

The same `frames` shape with the bytes from a capture session — on macOS
the `2vuy` surfaces §3.5 measured, as layer contents or as bytes — behind
a `createCameraFrames({ deviceId })` that owns device selection and the
session's lifetime. The permission half needs nothing new. A separate
piece of work, after this, on the same element.

## 9. Where the code goes

| piece                             | where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the element                       | `src/nodes/video.js` beside `image.js`, the kind in `src/nodes/kinds.js` and `src/Reconciler.js`, `VideoProps` in `src/types/elements.d.ts`, a line in `test/types/api.tsx`; `objectFit` in `src/styles.js` for `<video>` and `<image>` both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| the sink                          | `src/videoframes.js` — pure: formats, the ring, the conversion policy, `preferredFormats` — with a presentation per backend behind it: ntk `Surface` on X11, `src/cocoa/video.js`, `src/win32/video.js`, `src/wayland/video.js`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| the sprite kind                   | the `contents` field in `src/nodes/sprites.js`'s contract and `src/node.d.ts`; `src/cocoa/sprites.js` skips the raster for it; `src/cocoa/promotion.js` unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| the capability                    | `mediaPlayback` in `src/appcontext.js`'s `FEATURES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| the player, Cocoa                 | `src/cocoa/player.js` over the verbs below, in the shape of `src/cocoa/glarea.js`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| the player, win32                 | `src/win32/player.js` over `IMFMediaEngine`, after §4.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| bridge verbs, `@windowkit/appkit` | release A, the sink: `createVideoSurface({ width, height, format, colorSpace, range })` → `{ handle, iosurfaceId }` with the colour attachments set; `writeVideoSurface(handle, planes)`, which interleaves I420 into NV12; an optional `videoSurfacePlanes(handle)` answering `Buffer`s over the locked planes so a pipe read lands in the surface with no copy at all. Reuse, unchanged: `setLayerContentsIOSurface`, `surfaceIsInUse`, `surface-released`, `releaseSurface`. Release B, the player: `createPlayer({ url })`, `playerSet(id, { rate, volume, muted, loop })`, `playerSeek(id, seconds)`, `playerLayer(id)` answering a layer handle `addSublayer` takes, `playerCopyFrame(id)` answering a BGRA surface for the drawn presentation, `releasePlayer(id)`; events `player-metadata`, `player-time`, `player-rate`, `player-ended`, `player-error`. Release C, capture, later |
| bridge verbs, `@windowkit/win32`  | after §4.3: `mediaCreate`, `mediaSet`, `mediaSeek`, `mediaFrame` (frame-server), `mediaRelease` and the engine's events; later `mediaAttach` onto a visual, over the pane host's `CreateSurfaceFromHandle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Xv                                | a thin wrapper in ntk over node-x11's requests, port and format negotiation, `ShmPutImage` as the HD path, a clean decline where `QueryAdaptors` answers none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| docs                              | a `<video>` section in [elements.md](../elements.md); the ladder in [macos.md](../macos.md) and [windows.md](../windows.md); the `contents` part in [extending.md](../extending.md); this file is the record they point at                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| tests                             | `test/video.test.js` — pixels, fit, the poster, the refusal — on the mock and the in-process X server; `test/cocoa-video.test.js` over `test/helpers/cocoa-bridge.js` for which verbs a lift and a decline send; a real-bridge check through `snapshotWindow`; a sink scenario in `scripts/bench/protocol.js` and a rule in `presenters-gate.json` that a lifted sink paints no window frame per pushed frame                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| spikes                            | `scripts/spikes/video/` — `yuvscan.swift` and `sinkcost.swift`, this PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 10. What is not here, and why

- **A decoder.** react-x11 will not ship one. On Cocoa and Windows `src`
  does not need one; everywhere, `frames` takes what the application
  decodes. Bundling ffmpeg would be the largest dependency in the project
  by an order of magnitude, and would land on every user of a toolkit most
  of whom want a button. §8.3 is where a decoder belongs.
- **Audio for `frames`, and therefore A/V sync.** A sink is silent frames,
  on every backend, and says so. `src` has audio wherever it has a player.
  A `frames` source that also carries audio is the libmpv shape of §8.3,
  and its sync is the decoder's.
- **Seeking, buffering, HLS, DRM.** All the platform player's where there
  is one and entirely absent otherwise. Anything the element exposes that
  only works with `src` is documented as `src`-only, in the way
  [macos.md](../macos.md) documents the rest of that backend's asymmetries.
- **A compressed-stream source.** `AVSampleBufferDisplayLayer` and its
  synchroniser are the right rung for one, no consumer has asked, and the
  verb count would double. When one does, it is a third source prop on the
  same element and the same sprite.
- **`<audio>`.** A player with no box is not this element.
- **Fullscreen, picture-in-picture, the lock screen's now-playing.** Window
  state is `useWindowState()`'s; the rest is desktop integration with its
  own ladder.
- **Reading a lifted video's pixels through the X path.** Like `<glarea>`,
  a lifted video is not in the window's bitmap. On macOS `snapshotWindow`
  sees it (§3.4); on X11 there is nothing lifted to miss.

## 11. Decisions the implementing PRs have to make, and the suggested answer

| question                       | suggested answer                                                                                                                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the seam                       | a sprite part with `contents` (§7), not a new accessor and not a child window; `<video>` offers itself as its one part                                                                                                                              |
| the element's primitive        | `frames`, a sink, on every backend; `src` is the convenience of the backends with a player                                                                                                                                                          |
| `src` where there is no player | one typed `onError`, the poster stays, `useSupports('mediaPlayback')` to ask first — never a black box                                                                                                                                              |
| the sink's native format       | NV12 on macOS (two planes render, three do not), BGRA on X11 and win32 until their fast paths exist, anything on Wayland; published as `preferredFormats`                                                                                           |
| pixel format on Cocoa          | YUV through a plain layer — **not** BGRA, measured at 2.1× the decode on playback and 2.67× the process CPU on capture for the same picture — and not an AV layer class for a sink, which §3.4 made unnecessary                                     |
| colour                         | the sink names `colorSpace` and `range`; the bridge attaches them to the surface; the defaults are BT.709 video range, and a test pins that the bare and the attached surface differ, since §3.4 saw them differ                                    |
| bridge verbs, Cocoa            | two for the sink, six and five events for the player, in two releases (§9); the sink first, because it ships the whole element on macOS without AV                                                                                                  |
| the frame clock                | a lifted sink's `push` is not a react-x11 frame and is not priced (§6.3); a drawn sink's is, exactly like any other claim; a player's layer costs the frame nothing                                                                                 |
| the hole                       | the element's, through `spritesLifted`, as for every sprite; the bars are painted always, the picture only when drawn                                                                                                                               |
| rounded video corners          | legal, and the drawn presentation; say so beside the prop rather than mask a layer that cannot be                                                                                                                                                   |
| X11 v1                         | BGRA frames into an ntk `Surface` with SHM; Xv second, into the backing pixmap if ntk will name it; DRI3 import as the real answer                                                                                                                  |
| Xv fallback                    | mandatory: `QueryAdaptors` answering none is every Mac, and the drawn path is the decline                                                                                                                                                           |
| win32 v1                       | `IMFMediaEngine` in frame-server mode, drawn in paint order; the swapchain visual waits for the Windows half of promotion                                                                                                                           |
| tests                          | the fake bridge for what reaches the natives; `snapshotWindow` for pixels on Cocoa, never `render(in:)`; on X11 that the element paints the same with and without SHM; on every backend that a declined video and a lifted one show the same pixels |
| `<Html>`                       | mounts a core `<video>` beside the document, as it mounts a `<textinput>`; declines a box something paints over; grows `onResource` by `kind: 'video'`                                                                                              |
| camera                         | a `frames` source with device selection and a session, later, on the same element                                                                                                                                                                   |

## 12. What can be built now, and in what order

Five tracks. The first ships on every backend with no bridge release and
no upstream; the next two are two `@windowkit/appkit` releases; the fourth
waits for a Windows machine; the fifth is the ecosystem's.

1. **Core, now.** `VideoFrames`, `<video frames>` drawn through an ntk
   `Surface` on X11 and the shared 2D dialect on Cocoa and win32, NV12 and
   I420 converted to BGRA where a backend cannot take them, `objectFit`
   for `<video>` and `<image>`, `poster`, the typed refusal of `src`,
   `useSupports('mediaPlayback')` answering false everywhere, the `contents`
   sprite kind in `src/cocoa/sprites.js` behind a feature test for the
   verbs that do not exist yet. Pixel tests on the mock and the in-process
   server; a 720p sink scenario in the protocol bench, which is what makes
   the SHM path's effect visible. The whole element is usable from this
   step: an application with `ffmpeg` on its `PATH` plays a file on X11
   and on macOS in forty lines, silently, at the drawn cost.
2. **`@windowkit/appkit` release A — the sink's two verbs** (§9). Then the
   Cocoa presenter lifts a `<video frames>` and a 1080p60 feed costs the
   process 25ms of CPU a second (§3.4.1) and react-x11 no frames at all.
   The acceptance test is the gate rule: a lifted sink paints no window
   frame per pushed frame, over the fake bridge; and a real-bridge
   `snapshotWindow` that shows the pushed colour.
3. **`@windowkit/appkit` release B — the player.** `<video src>` on macOS
   with audio, seeking and HLS from AVFoundation; `mediaPlayback` true
   there; the drawn presentation through `playerCopyFrame` so a dialog's
   dim or a rounded card still shows the picture. The first `<video>` a
   form developer meets is this one.
4. **Windows, on the Windows machine.** §4.3's probes, then `src` through
   `IMFMediaEngine` in frame-server mode and `frames` through a dynamic
   texture, both drawn; the swapchain visual and the NV12 swapchain when
   the backend has the Windows half of promotion to decide them.
5. **`@react-x11/components`.** `<Html>` reports media boxes and mounts
   `<video>`s; `onResource` learns `video`; `<MediaPlayer>` keeps mpv and
   VLC and grows a `frames` backend — `ffmpeg` first, since it is pure JS
   and silent is still a video, libmpv when someone wants audio on macOS.

After those, in order of value: the Xv rung on X11 (into the backing
pixmap, if ntk will name it), the camera source, DRI3 import on X11 and
a dma-buf subsurface on Wayland for the zero-copy decoders, and a
compressed-stream source over `AVSampleBufferDisplayLayer` when a consumer
appears.

## 13. The spikes

Every number above came from a program that uses the platform directly —
no bridge, no renderer, no React — so that what it measures is the
platform and not our use of it.

**`scripts/spikes/video/yuvscan.swift`** (2026-10-02) answers §3.4's
on-screen question. It builds eight `CALayer`s in a borderless window:
BGRA and `CGImage` controls, `420v`, `420f`, `2vuy`, `y420` and `f420`
surfaces made through `CVPixelBufferCreate` with IOSurface backing and
filled with one YCbCr colour per plane, an `AVSampleBufferDisplayLayer` fed
thirty H.264 frames a `VTCompressionSession` encodes from solid red, and an
`AVPlayerLayer` playing a `.mov` an `AVAssetWriter` writes from solid
magenta. Two seconds in it captures the window through
`screencapture -l <windowNumber>` — the window server's composite, the
same source as `CGWindowListCreateImage` and therefore as the bridge's
`snapshotWindow`, and the only capture a Swift program on this SDK is
still allowed — and prints the centre pixel of each tile. Build and run
with `swiftc -O -swift-version 5 -o yuvscan yuvscan.swift && ./yuvscan`;
a capture that comes back empty is the Screen Recording permission, not
the layer. The controls are the part that makes the YUV rows meaningful.

**`scripts/spikes/video/sinkcost.swift`** (2026-10-02) answers §3.4.1. It
rotates three 1920×1080 surfaces, copies a prepared frame into each
plane of the next one, repoints a layer at it inside a transaction, and
paces to 60Hz; `getrusage` around 240 iterations gives the process CPU per
frame, for NV12 and BGRA in turn, twice each. The `memcpy` stands in for
the read from a decoder; a verb that answers `Buffer`s over the locked
planes removes even that.

The **2026-09-08 spikes** behind §2.5, §3.1–3.3 and §3.5 are described
there and were not committed; their shapes: encode synthetic frames with a
`VTCompressionSession` to get a real stream with parameter sets, decode
them back with and without BGRA forced, time each frame, check
`CVPixelBufferGetIOSurface`, assign the surface to a layer two thousand
times for the flip cost, probe rasterization with `render(in:)` against
controls; push a 1920×1080 depth-24 image to an offscreen pixmap with core
`PutImage` and a `GetInputFocus` round trip after each; run an
`AVCaptureSession` at 1280×720 for 60 frames twice, native and BGRA, with
`getrusage` around each run, from a bundle launched through
LaunchServices so that the authorization request prompts, keeping nothing
of what the camera saw.

## 14. Verdict

The Cocoa half got smaller in the month since this was first written, and
for a good reason: the thing it was designed around turned out not to be
there. A plain layer shows a YUV surface on screen, the seam that lifts
part of an element onto a layer has shipped and been tested on something
else, and the bridge can already address an IOSurface by id. What is left
for a frame sink on macOS is two verbs and a field on a sprite; what is
left for a URL is the player verbs, which are the first AVFoundation the
bridge will link for anything but a permission prompt.

The X11 half is exactly as large as it was, and this record's main
service there is still to say so before someone spends a week on it: the
transport that exists in the protocol is capped near 30fps at 1080p, the
one that would fix it is now installed and still absent on every Mac, and
the one that is right is the largest piece of work here. A sink the
application feeds, drawn through the surface every retained-surface
element already draws through, is honest, is small, and is the version of
this that ships on four backends at once.

Windows has every piece a player needs except a decision about stacking,
which is promotion's to make there as it was on macOS, and a drawn
presentation that needs no such decision. Wayland is a rasterizer, so its
sink is a shader.

The thing not to build is still the API that hides the difference — and
the thing not to build twice is the element: a video inside a document is
the same `<video>` as one in a form, mounted where the document says it
goes.
