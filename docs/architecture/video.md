# Video: decoding a stream, and putting its frames on the screen

_Design record, 2026-09-08. Written against master at bf48860 (react-x11
2.9.0, ntk ^8.7.0, `@windowkit/appkit` ^0.7.0, node-x11 4.1.0). **Nothing
is implemented with this document.** §7 is the shape the implementing PR
takes, §9 is the spike every number here came from, and §10 says what it
would cost. The mechanism it extends is
[element-owned layer contents](element-layer-contents.md); the constraint
it runs into on X11 is the one
[protocol efficiency](protocol-efficiency.md) measures everywhere else._

---

## 0. TL;DR

- **No X11 extension decodes video.** The one that did — XvMC — is dead,
  and the things that replaced it (VA-API, VDPAU, NVDEC) are not
  extensions at all but C libraries that borrow a `Display*`. On X11 the
  decoder is always ours, in our process, and X's only job is moving
  finished frames to the screen without a copy per pixel.
- **On Cocoa both halves are OS services.** VideoToolbox decodes in
  hardware into `CVPixelBuffer`s that are already IOSurfaces, and
  `AVSampleBufferDisplayLayer` is a `CALayer` that takes _compressed_
  sample buffers and does the rest. Measured here: 1.87ms per 1080p H.264
  frame, hardware, every frame IOSurface-backed (§3.3).
- So a cross-backend `<video>` is not one feature built twice. It is **one
  element with two very different insides**, and the honest API is a node
  that shows _frames from a source_ — where Cocoa delegates the whole
  source to AVFoundation and X11 exposes a frame sink you feed.
- **The Cocoa half is mostly already designed.** A video node is an
  element-owned layer: `presentedSurface()`'s contract from
  [#499](element-layer-contents.md) — answer a layer and a rect, leave a
  hole in the bitmap, re-decide every frame, decline safely — is unchanged.
  What changes is the layer's _class_, and the hard half of that design
  (the IOSurface pair, the flip, the damage-sized catch-up copy)
  **disappears**, because AVFoundation owns the buffer rotation. That is
  an argument for stating the seam as "a node contributes a layer" rather
  than "a node contributes a presentable `Surface`".
- **The trap that decides the Cocoa design.** A decoder hands back
  biplanar `420v`, not BGRA. `CALayer` _accepts_ a `420v` IOSurface as
  `contents` — assignment succeeds, `contents` is non-nil — and rasterizes
  **nothing** (0/4096 px, against BGRA and CGImage controls that both give
  4096/4096; §3.4). Asking VideoToolbox for BGRA instead costs **2.1× the
  decode** and 2.6× the memory. So the "free" path through the existing
  `setLayerContentsIOSurface` verb is not free, and the bridge should grow
  AV verbs rather than route video through the swapchain's pixel format.
- **The X11 number that sets the budget.** A 1920×1080 depth-24 frame
  through core `PutImage` costs **33.19ms** median with a round trip
  (238 MiB/s) — a 30fps ceiling with nothing left over, measured on
  XQuartz (§2.5). That is the argument for Xv, which would push 3.1MB of
  `420v` instead of 7.9MB of BGRA _and_ have the server do the colour
  conversion and the scale.
- **What is missing to try it:** node-x11 ships
  [`lib/ext/xv.js`](https://github.com/sidorares/node-x11/blob/master/lib/ext/xv.js)
  with the discovery-and-control half of Xv and **no way to move a pixel** —
  minor opcodes 0–4 and 12–16 are there, 5–11 and 17–19 are not. Adding
  `XvQueryImageAttributes` (17), `XvPutImage` (18) and `XvShmPutImage`
  (19) is bounded wire code against a stable spec, and is filed upstream.

## 1. The asymmetry, stated once

Every other feature in `docs/architecture/` has the same shape on both
backends: a rule, two implementations, one set of semantics. Video does
not, and pretending otherwise would produce an API that is a lie on one
side.

On macOS, "play this video" is a supported product: hand `AVPlayer` a URL,
attach `AVPlayerLayer`, and you have hardware decode, HLS, A/V sync,
seeking, HDR and colour management, none of it ours. On X11, every one of
those is a component someone assembles: a demuxer, a decoder, a clock, a
colour conversion, and a presentation path — and the X server contributes
only the last one, badly, unless you leave the protocol for a native
library.

The design consequence is that the _element_ is shared and the _source_ is
not. A `<video>` whose prop is a URL would work beautifully on Cocoa and
be a lie on X11, where nothing in this project can open a URL and produce
frames. A `<video>` whose prop is a frame sink is honest everywhere but
throws away the whole of AVFoundation. §4 is the resolution: both, with
the frame sink as the primitive and the URL as the Cocoa-only convenience
that is documented as such.

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
pipe — and that is a dependency decision (§6), not a rendering one.

### 2.3 The transports

Given frames in our memory, three ways to get them onto the screen, in
ascending order of how little they copy.

**MIT-SHM.** `ShmPutImage` moves a frame through shared memory instead of
the socket. ntk already has this, with a segment pool, a size quantum and
`ShmCompletion`-gated recycling, in `node_modules/ntk/lib/shm-upload.js`;
its own measurements put it at roughly 2× on uploads, and it is available
on XQuartz here. This is the floor of any X11 video path and it is already
built.

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

**GLX / direct GL.** Upload Y, U and V as three textures and convert in a
fragment shader. This works **today**, through `<glarea>`, with no new
protocol at all: see [gl.md](../gl.md) and the direct-GL notes in
[glx.md](../glx.md). It is the fastest thing to prototype and it costs a
`<glarea>`'s constraints — the node owns a real child window or layer, and
its pixels cannot be read back through the X path.

### 2.4 What node-x11 has

`lib/ext/xv.js` in node-x11 4.1.0 implements the half of Xv that asks
questions and none of the half that answers with pixels. Verified against
the file:

| Xv minor opcode                                 | in node-x11 4.1.0 |
| ----------------------------------------------- | ----------------- |
| 0 `QueryExtension` (version)                    | yes               |
| 1 `QueryAdaptors`                               | yes               |
| 2 `QueryEncodings`                              | yes               |
| 3 `GrabPort` / 4 `UngrabPort`                   | yes               |
| 5–8 `PutVideo`/`PutStill`/`GetVideo`/`GetStill` | **no**            |
| 9 `StopVideo`                                   | **no**            |
| 10 `SelectVideoNotify`                          | **no**            |
| 11 `SelectPortNotify`                           | **no**            |
| 12 `QueryBestSize`                              | yes               |
| 13–15 port attributes                           | yes               |
| 16 `ListImageFormats`                           | yes               |
| 17 `QueryImageAttributes`                       | **no**            |
| 18 `PutImage`                                   | **no**            |
| 19 `ShmPutImage`                                | **no**            |

Two consequences. The obvious one: you can enumerate adaptors, grab a
port, list its formats and set its brightness, and then have no way to
show it a frame. The quieter one: the file **already registers event
parsers** for `XvVideoNotify` and `XvPortNotify`, and opcodes 10 and 11
are how you would subscribe — so those parsers are currently unreachable.

The three that matter for video are bounded, well-specified wire code
against a spec that has not moved in decades: `PutImage` is a 40-byte
header plus the padded payload, `ShmPutImage` is 52 bytes and no payload,
`QueryImageAttributes` is a 16-byte request whose reply carries
`num_planes`, `data_size`, and then the pitch and offset arrays that tell
you how to lay out the planes you are about to send. Filed upstream as
[sidorares/node-x11#294](https://github.com/sidorares/node-x11/issues/294).

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
  CPU, which is why it is worth the upstream request even though the
  extension is absent on XQuartz.

## 3. Cocoa

### 3.1 Decode

`VTDecompressionSession` is the primitive: build a
`CMVideoFormatDescription` from the stream's parameter sets, feed it
`CMSampleBuffer`s, get `CVPixelBuffer`s. Ask for IOSurface backing with
`kCVPixelBufferIOSurfacePropertiesKey` and every output buffer is a
surface the render server can already read.

Measured on this machine (macOS 15.2, M1 Pro), `VTIsHardwareDecodeSupported`:

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
promotion and with #499's arrangement unchanged.

1. **`AVPlayerLayer`** — set `player`, set `videoGravity`, done. No pixel
   code and no JS in the frame path at all. Everything about the source is
   AVFoundation's.
2. **`AVSampleBufferDisplayLayer`** — enqueue `CMSampleBuffer`s from our
   own demuxer or socket; it decodes and schedules them itself. On macOS
   14+ the work goes through its `sampleBufferRenderer`
   (`AVSampleBufferVideoRenderer`), and `AVSampleBufferRenderSynchronizer`
   with a `CMTimebase` is how it is synchronised against audio. This is
   _the_ rung for "a video stream" that is not a file or a URL.
3. **A plain `CALayer` whose `contents` is the decoded IOSurface** — the
   rung this repo is already standing on, since `setLayerContentsIOSurface`
   is how both `<glarea>` and the window swapchain present. See §3.4 for
   why this rung is not the free win it looks like.
4. **`CAMetalLayer` + `CVMetalTextureCache`** — zero-copy `MTLTexture`
   from the pixel buffer, full shader control, our own colour conversion
   and scaling.
5. `CAOpenGLLayer` — legacy, and `<glarea>`'s neighbourhood.

### 3.3 Measured

The spike (§9) encodes a synthetic sequence with VideoToolbox, decodes it
back, and times each step. 1920×1080 H.264, 60 frames, hardware
acceleration confirmed on the session, every output buffer IOSurface-backed:

| step                                         | median  |
| -------------------------------------------- | ------- |
| decode a 1080p H.264 frame, default output   | 1.868ms |
| decode the same frame, output forced to BGRA | 3.917ms |
| `layer.contents = ioSurface`                 | 0.04µs  |

At 1280×720 the same measurement is 1.143ms for H.264 and 0.932ms for
HEVC. The flip is not 0.03ms as #499's window flip measures — it is
**below the resolution of a microsecond timer**, because the assignment
itself is a pointer swap and the transaction commit is where CA's cost
lives.

`AVSampleBufferDisplayLayer` accepted all 30 compressed sample buffers it
was offered headless, with `status` rendering and no error — so the
enqueue path does not require a window to be validated in a test.

### 3.4 The `420v` trap, which decides the design

A hardware decoder's natural output is `420v` — bi-planar 8-bit
video-range YCbCr, two planes, 3.1MB for 1080p. Our swapchain surfaces are
BGRA. The obvious move is to hand the decoder's surface straight to the
existing `setLayerContentsIOSurface` verb and be done in an afternoon.

Measured, that silently produces an empty box:

| layer `contents`           | accepted | rasterized (`render(in:)`) |
| -------------------------- | -------- | -------------------------- |
| `420v` IOSurface, 2 planes | yes      | **0 / 4096 px**            |
| BGRA IOSurface — control   | yes      | 4096 / 4096 px             |
| `CGImage` — control        | yes      | 4096 / 4096 px             |

The controls are the point. `CALayer.render(in:)` is a CPU path that does
not handle everything, so a lone blank result would prove nothing — but a
BGRA IOSurface of exactly the shape `src/cocoa/surface.js` ships today
renders fully through the same probe, and so does a `CGImage`. The
biplanar surface is accepted, reports non-nil `contents`, and draws
nothing.

Three ways out, priced:

- **Force BGRA out of the decoder** (`kCVPixelBufferPixelFormatTypeKey` in
  the decompression session's image-buffer attributes). It works, and it
  costs **2.1× the decode** — 3.917ms against 1.868ms — plus 8.3MB per
  surface against 3.1MB.
- **Use `AVSampleBufferDisplayLayer`**, which takes YCbCr natively because
  that is what it is for, and brings A/V sync with it.
- **Convert on the GPU** with Metal or Core Image, which is rung 4 and its
  own render loop.

Which is why the recommendation in §7 is that the bridge grows AV verbs
rather than that video is routed through the swapchain's pixel format. The
cheapest-looking path is measurably the most expensive one.

One caveat stated plainly: this measures the path that can be measured
headless. Whether the **render server** scans out a biplanar surface
on screen is not settled by it, and that is the very first thing the
implementing PR should check — because the failure mode is silent, and a
silent failure on a path that reports success is the expensive kind.

## 4. The element both backends share

A video node is an element-owned layer. Everything
[#499](element-layer-contents.md) established applies without amendment:

- the accessor is asked every frame, beside `opaqueRect()`;
- the node's `paint` leaves a hole (`Node._promoted`), exactly as
  `GlAreaNode.paint` does;
- the z-order rule is promotion's, unchanged — nothing painted after the
  node may reach into its bounds, and every clipping ancestor must hold
  all of it;
- **declining is always safe**, and is re-decided every frame;
- hit testing does not move: the node tree stays the source of truth for
  input on every presenter.

What differs is instructive. #499's hard half is the **buffer discipline**
— two IOSurfaces, a flip, a damage-sized catch-up copy — because the
element draws into a surface the render server is reading asynchronously.
A video layer has none of that: AVFoundation owns the rotation, and the
element never touches a pixel. So video is the _easier_ consumer of the
seam, and it is the one that shows the seam is stated one notch too
narrowly. `presentedSurface()` answering a `Surface` cannot express "this
node is an `AVSampleBufferDisplayLayer`". `presentedLayer()` answering an
opaque layer handle, of which a presentable `Surface` is one kind, can
express both.

That is the one substantive change this document proposes to #499's
design, and it is cheap to make **before** #499 is built and expensive
after.

On X11 the same node declines, and the element composites its frames
through `ctx.drawImage(surface, …)` — the code every retained-surface
element already has, fed by whichever transport §2.3 the build has.

## 5. Where the code goes

| piece                         | file                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| the element and its props     | `src/elements.js`, `src/nodes.js` — a node beside `GlAreaNode`                                                              |
| the layer, Cocoa              | `src/cocoa/promotion.js` (a second kind of candidate) and a new `src/cocoa/video.js`, in the shape of `src/cocoa/glarea.js` |
| the accessor                  | `src/node.d.ts`, `test/types/extend.tsx`                                                                                    |
| the frame sink, both backends | ntk `Surface` + `drawImage`, unchanged                                                                                      |
| Xv, if it happens             | node-x11 `lib/ext/xv.js` upstream, then a thin ntk wrapper                                                                  |
| bridge verbs                  | `@windowkit/appkit` — see §7                                                                                                |
| docs                          | a section in [elements.md](../elements.md) and the ladder in [macos.md](../macos.md); this file is the record they point at |

## 6. What is not here, and why

- **A decoder.** react-x11 will not ship one. On Cocoa it does not need
  to; on X11 the element takes frames and the application chooses how it
  gets them. Bundling ffmpeg would be the largest dependency in the
  project by an order of magnitude, and would land on every user of a
  toolkit most of whom want a button.
- **Audio, and therefore A/V sync.** On Cocoa this is
  `AVSampleBufferRenderSynchronizer` and it is nearly free. On X11 there is
  no audio in this project at all, so a video element there is _silent
  frames_, and saying so up front is better than an API that implies
  otherwise.
- **Seeking, buffering, HLS, DRM.** All AVFoundation's on one side and
  entirely absent on the other. Anything the element exposes that only
  works on Cocoa must be documented as Cocoa-only, in the way
  [macos.md](../macos.md) documents the rest of the backend's asymmetries.
- **Camera capture.** `AVCaptureVideoPreviewLayer` is one more rung on the
  same ladder, but it is a TCC-gated privilege
  ([permissions.md](../permissions.md)) and a separate feature.
- **Reading a video node's pixels.** Like `<glarea>`, a layer-backed video
  node is not in the window's bitmap, so a screenshot through the X path
  cannot see it. Whether `snapshotWindow` on Cocoa composites sublayers is
  an open question the spike did not answer, and it decides what the tests
  can assert.

## 7. Decisions the implementing PR has to make, and the suggested answer

| question                  | suggested answer                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the seam                  | `presentedLayer()`, not `presentedSurface()` — a presentable `Surface` and a video layer are two kinds of one thing, and #499 has not shipped yet                   |
| the element's primitive   | a frame sink: the node takes decoded frames, on both backends                                                                                                       |
| the Cocoa convenience     | a source prop that AVFoundation handles end to end, documented Cocoa-only, refused with a clear error on X11 rather than silently blank                             |
| pixel format on Cocoa     | `420v` through AV verbs. Not BGRA through `setLayerContentsIOSurface`: measured at 2.1× the decode and 2.6× the memory, for the same picture                        |
| bridge verbs              | `createVideoLayer`, `enqueueSampleBuffer`, `flushVideoLayer`, and the synchroniser's rate/timebase — an appkit release, unlike #499 which needs none                |
| the first thing to verify | that the render server scans out a biplanar surface on screen (§3.4). If it does, rung 3 becomes viable as a fallback and the verb count drops                      |
| the frame clock           | a video layer CA drives is **not** priced by the [pacer](frame-pacing.md) — it costs the frame nothing. A JS-fed frame sink is, exactly like any other claim        |
| X11 v1                    | SHM `PutImage` of frames the application supplies, through the existing `Surface`. Xv second, once node-x11 has the three requests; DRI3/Present as the real answer |
| Xv fallback               | mandatory, not optional: `QueryAdaptors` answering none is the XQuartz case and must be a clean decline to the SHM path                                             |
| colour                    | carry the pixel buffer's YCbCr matrix, transfer function and primaries; set `layer.colorspace` explicitly. The Generic-RGB default has bitten this backend before   |
| tests                     | the fake bridge for what reaches the natives, the real one for pixels; on X11, that the element paints identically with and without any acceleration                |

## 8. Sequencing

Three pieces, each useful alone, and the first two are not blocked on
anything:

1. **The seam, renamed.** Land `presentedLayer()` as #499's accessor
   before #499 ships. No video code, no bridge release — it is a naming
   decision with a two-week window.
2. **The X11 half.** A frame-sink element over the existing `Surface` and
   SHM upload, with a bench scenario. Ships without a bridge, without
   upstream, and without a decoder — the application brings frames.
3. **The Cocoa half.** appkit AV verbs, `src/cocoa/video.js`, and the
   promotion candidate. Needs an appkit release, and should not start
   until §3.4's on-screen question is answered.

Upstream, in parallel and on its own clock:
[node-x11#294](https://github.com/sidorares/node-x11/issues/294) for the
three Xv requests, which unblocks the Xv rung whenever it lands.

## 9. The spike

Every Cocoa number above came from a Swift program that uses VideoToolbox,
Core Video and Core Animation directly — no bridge, no renderer, no React
— and the X11 number from a node script over node-x11 alone. Both are
reproduced in `scripts/spikes/` by the implementing PR; the shapes are:

- **Cocoa.** Encode N synthetic frames with a `VTCompressionSession` to
  get a real compressed stream with parameter sets; decode them back
  through a `VTDecompressionSession` with and without
  `kCVPixelBufferPixelFormatTypeKey` forced to BGRA, timing each frame and
  checking `CVPixelBufferGetIOSurface`; assign the resulting surface to a
  `CALayer` 2000 times for the flip cost; probe rasterization with
  `layer.render(in:)` against a BGRA-IOSurface control and a `CGImage`
  control; instantiate `AVSampleBufferDisplayLayer` and enqueue the
  compressed buffers.
- **X11.** Create an offscreen pixmap, push a 1920×1080 depth-24 image
  with core `PutImage`, and follow each with a `GetInputFocus` round trip
  so the median is the server's real cost and not the socket buffer's.

The controls are the part worth keeping. The `420v` result is only
meaningful because BGRA and `CGImage` go through the same probe and come
back whole.

## 10. Verdict

The Cocoa half is small and mostly designed: a promotion candidate, a
layer class, and four bridge verbs, on a seam whose hard problem — z-order
— is already written and tested, and whose _other_ hard problem — buffer
rotation — video simply does not have. The measurements say to reach for
AVFoundation's own layer rather than to route video through our swapchain,
and they say it with a number rather than a preference.

The X11 half is not small, and this document's main service is to say why
before someone spends a week on it. There is no decode extension to reach
for; the transport that exists in the protocol is capped near 30fps at
1080p; the transport that would fix it (Xv) cannot move a pixel from
node-x11 today and is absent on XQuartz besides; and the transport that is
actually right (DRI3 import + Present) is the largest piece of work here.
A v1 that takes frames from the application and composites them through
the existing `Surface` is honest, is small, and is the only version of
this that ships on both backends at the same time.

The thing not to build is the API that hides the difference.
