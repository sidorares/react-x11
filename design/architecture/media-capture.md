# Media capture and real-time communication: cameras, microphones, screens, codecs and peers

_Design record, 2026-11-06, written against master at 220e1c0 (react-x11
2.56.5) and `@react-x11/components` at 27fcf7e9. It extends [video.md](video.md),
whose §8.4 ("Camera, later") this is the "later" of, and it takes the
boundary `@react-x11/components`' `docs/prd-audio.md` already drew through
sound. §0.1 is what has been built since: step 1 of §6, core's half
(react-x11 2.57), and the `@windowkit/appkit` verbs it runs on, released in
0.31.0._

---

## 0. TL;DR

- **The middle layer has no owner.** Core has the sinks (`<video frames>`,
  `<video src>`, `<audio src>`) and the permission kinds (`camera`,
  `microphone`, `screen-recording`). `@react-x11/components`' `<Html>` has
  the W3C facade (`MediaStream`, `getUserMedia`, `RTCPeerConnection`) over
  werift, with a host seam (`HtmlMediaDevices` / `MediaSourceLike`) for real
  devices that nothing fills except fake ones. What sits between — a real
  camera, a real microphone, a screen, a window, the system's audio, a
  platform encoder — exists nowhere.
- **That layer belongs in core.** Every rung of it is a native bridge verb
  on macOS and Windows (`AVCaptureSession`, ScreenCaptureKit,
  VideoToolbox; Media Foundation, Windows.Graphics.Capture, WASAPI), the
  bridge is off core's exports map, and a camera preview has to go from
  IOSurface to layer without crossing JavaScript. Same argument
  `prd-audio.md` made: when "built on the public API" fails on one backend,
  the feature belongs upstream.
- **RTC, recording and the web's object model belong in components.**
  werift and libav.js are about 50 MB, most apps want neither, and both are
  buildable on core's tracks and codecs.
- **Web nouns, React verbs, frames handed over directly.** Core adopts the
  web's vocabulary wherever it is free — constraint dictionaries, `kind`
  strings, error names, codec strings, a minimal `MediaStream`, WebCodecs —
  and not its object model. Acquisition is hook state rather than
  try/catch; frames come off a track by callback; screen sources can be
  enumerated. The full W3C model (EventTarget, `navigator.mediaDevices`,
  `RTCPeerConnection`, `MediaRecorder`, `MediaStreamTrackProcessor`) lives in
  components, where it doubles as the polyfill that lets existing WebRTC
  SDKs run unmodified.
- **Two constraints shape the design.** Echo cancellation needs the far-end
  signal, so microphone capture and audio output are one core module (§3).
  And on Linux only X11 screen capture is reachable from pure JavaScript:
  PipeWire hands buffers over as file descriptors Node's `net` cannot
  receive, and v4l2 needs `ioctl` (§4).

### 0.1 Built, 2026-11-06: step 1, core's half

The reference is [docs/media.md](../../docs/media.md). In `src/media/`:

- **Tracks and streams** (`stream.js`). `MediaStream` and
  `MediaStreamTrack` over a **shared source**. Sources are pooled by backend,
  then by `kind|deviceId|settings`, and a source stops when its last track
  does, so two hooks asking for one camera at one size are one session. That
  is §7's second open question answered: the count owns the device, not the
  hook and not the component. `applyConstraints` moves a track to the pooled
  source at the new settings. A device with no other track is let go first,
  because a camera that runs one session at a time would refuse the second
  open. Frames come off a track by callback (`onFrame`), and a source is
  told whether anybody reads frames at all (`wantFrames`). `onChange`
  replaces EventTarget, and `stop()` fires it too, so an element showing
  the track lets go of it.
- **Constraints** (`constraints.js`). SelectSettings simplified to what a
  desktop device describes: a range per number, a list per choice, the
  default device first among equals. `advanced` is not read.
- **The ladder** (`capture.js`). A rung is an object with some of `devices`,
  `watch`, `open`, `displaySources`, `openDisplay`, `captureScreenshot` and
  `openAudioOutput`, and each operation takes the first rung with its verb.
  `app.mediaCapture` comes first, which is the Cocoa rung or the test fakes.
  The X11 rung comes second, for the screen only. Permission is the existing
  ladder's, asked just before a device opens. A refusal with the status
  still `notDetermined` gets its own `NotAllowedError` message, the video.md
  §3.5 trap.
- **Hooks** (`hooks.js`). `useMediaDevices`; `useUserMedia`, which starts on
  mount; `useDisplayMedia`, which waits for `start()` because a picker
  nobody asked for is the wrong default. One status addition to §2.2's list:
  `'ended'`, for every track ending other than by the hook's own `stop()`
  (a camera unplugged).
- **`createAudioFrames`** (`audioframes.js`). The prd-audio sink: planar
  floats, queued, nothing dropped, `currentTime`, `latency` and `queued`.
  There is no `useAudioFrames`, because the sink owns a native output and
  making one in render is a side effect React may discard.
- **Elements.** `<video srcObject>`: a track whose source has a
  presentation of its own (a macOS camera) is shown the way a player is.
  Any other track's frames go into a sink of the node's own, remade when
  the size or format changes. `<audio srcObject>` plays through
  `createAudioFrames` at the rate the track arrives in, with `sinkId` for
  the device.
- **X11** (`x11capture.js`). Screens are monitor rectangles of the root, and
  windows come from `_NET_CLIENT_LIST`, read from the window itself.
  `GetImage` decodes by the server's own layout, and frames are BGRA while
  wanted. There is no XDamage, MIT-SHM or cursor yet.
- **Cocoa** (`src/cocoa/capture.js`). The rung over the verbs §6 asks
  `@windowkit/appkit` for. Each part exists only where its verb does. A
  camera's `layer` is lifted through the sprite seam as a player's is
  (`CameraPresentation`, a `PlayerState`), and the session's one layer goes
  to the first part that lifts it.
- **`react-x11/test`**. `fakeMediaDevices(app)`: components'
  `fake-media.ts` generator (bars, a tone), plus a speaker on a manual clock,
  a screen and a window, hot-plug, a picker answer, and a permission table
  the existing `usePermission` reads.

**One measured finding, which answers part of §7's third question.** On
XQuartz the root window holds nothing of what is on the screen. In
rootless mode each X window is a Mac window. A window painted `#ff00ff`
read back as `ff00ff` through `GetImage` on the window, and as `000000`
through `GetImage` on the root at the same place (XQuartz 2.8, quartz-wm,
2026-11-06). So the X11 rung reads a window from the window itself, not
from its rectangle of the root, and refuses screens where the server has
`Apple-WM`, saying why (`features.screens: false`). On XQuartz a
160×120 window streamed at a 33.8 ms median frame gap at
`frameRate: 30`. The in-process X server cannot stand in for this: its
`GetImage` reads only the target's own raster, so its tests paint the root
itself.

**The bridge** (`@windowkit/appkit`'s `src/capture.mm`, windowkit/appkit#130,
released in 0.31.0 and react-x11's floor since). `captureDevices` (also through a callback, since the first listing
loads AVFoundation's camera plug-ins: 1.5 s cold, ~110 ms warm, ~1 ms after),
`capture-devices` only when what a listing shows changed (an engine's own
`CADefaultDeviceAggregate-<pid>` device is otherwise announced as a new
device the moment an output starts), `openCamera` with an
`AVCaptureVideoPreviewLayer` and the session on a queue of its own,
`cameraFrames`/`cameraCopyFrame`, one `AVAudioEngine` for microphones and
outputs with voice processing while an echo-cancelled microphone is open, an
`AVAudioSinkNode` for 10 ms input (a tap's buffers are 100 ms at the least),
`captureScreenshot` over `SCScreenshotManager`, and `setWindowSharing`. Three
places it differs from the contract §0.1's Cocoa rung was first written
against, and the rung follows the bridge: a screenshot answers one value
(`{ width, height, scale, data }` or `{ error, name }`); an open microphone
answers what was asked, and `microphone-started` what the engine did; and
display listing and device listing take a callback, which is the only form a
worker may use for the first. Measured over the real bridge here (macOS 15.8,
M1 Pro): this Mac's FaceTime camera lists only `420v` formats, so a frame is
never converted; a window painted `#e01a33` read back through react-x11's
`captureScreenshot` as `224, 25, 51`; an excluded window came back with every
pixel clear; 0.2 s pushed into `createAudioFrames` played out on the device
clock. The camera and the microphone were not opened: this process has no
grant, and the tests skip rather than prompt.

**`<window excludeFromCapture>`**: on Cocoa through `setWindowSharing`,
sent as a command behind the window's making and ahead of its showing.

**Not built in this step:** the global shortcut hook, Linux cameras and
microphones, `getDisplayMedia` on Cocoa (SCStream), mirroring a self-view
(there is no `transform` style), and the components half.

## 1. The apps this is measured against

Five applications, each to be written with as little non-portable code as
possible:

1. a video calling app;
2. a screenshot app;
3. a screen casting / recording app;
4. a client for an existing WebRTC-based chat or voice service (LiveKit,
   Jitsi, Matrix calls, a WHIP ingest);
5. a transcriber / note taker.

| needed                           | call | shot | cast | rtc client | notes | native behind it                                                                                               |
| -------------------------------- | :--: | :--: | :--: | :--------: | :---: | -------------------------------------------------------------------------------------------------------------- |
| device list + hot-plug           |  ●   |      |  ○   |     ●      |   ●   | `AVCaptureDevice.DiscoverySession` / MMDevice + MF / sysfs + PipeWire                                          |
| camera track                     |  ●   |      |  ○   |     ●      |       | `AVCaptureSession` / MF capture / v4l2                                                                         |
| microphone track, echo-cancelled |  ●   |      |  ○   |     ●      |   ●   | VoiceProcessingIO / communications-mode capture / PipeWire `echo-cancel`                                       |
| audio output sink                |  ●   |      |      |     ●      |       | `prd-audio.md`'s plan                                                                                          |
| screen / window capture stream   |  ○   |      |  ●   |     ○      |       | ScreenCaptureKit / Windows.Graphics.Capture / ScreenCast portal / X11 SHM `GetImage` + XDamage + XFixes cursor |
| one-shot screenshot              |      |  ●   |      |            |       | the eyedropper's ladder (`src/screencolor.js`)                                                                 |
| system-audio loopback            |      |      |  ●   |            |   ●   | ScreenCaptureKit audio or a CoreAudio process tap / WASAPI (process) loopback / Pulse monitor source           |
| a window left out of capture     |  ○   |  ●   |  ●   |            |       | `NSWindow.sharingType = .none` / `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`                            |
| global hotkey                    |      |  ●   |  ●   |            |   ●   | portal `GlobalShortcuts` / `XGrabKey` on the root / `RegisterEventHotKey` / `RegisterHotKey`                   |
| encoders, hardware H.264         |  ○   |      |  ●   |     ●      |       | VideoToolbox / Media Foundation; nothing on Linux short of ffmpeg or VA-API                                    |
| peer connection + data channels  |  ●   |      |  ○   |     ●      |       | werift (pure TypeScript)                                                                                       |
| recording to a file (muxing)     |      |      |  ●   |            |   ○   | mediabunny (pure TypeScript, already in werift's closure)                                                      |
| speech to text                   |      |      |      |            |   ●   | the application's (whisper.cpp, ONNX, a cloud API)                                                             |

● = central to the app, ○ = nice to have.

### 1.1 What exists, 2026-11-06

**Core:**

- `<video frames>` over `VideoFrames` (NV12 / I420 / BGRA) on every
  backend; `<video src>` and `<audio src>` over the platform player on
  macOS, Windows planned (video.md §4).
- `usePermission('camera' | 'microphone' | 'screen-recording')`, answering
  on macOS only; Linux's portals are not wired (docs/permissions.md).
- The eyedropper's screen ladder: `NSColorSampler`, the Screenshot portal's
  `PickColor`, X11 (`src/screencolor.js`).
- `useKeepAwake`, notifications, the tray, the file dialog — the services
  around these apps.
- **No global shortcut.** `grabKey` is used internally, by popups, and is
  not a public hook.

**`@react-x11/components`:**

- `<MediaPlayer>` over mpv, VLC or ffmpeg into `<video frames>`.
- `<Html>`'s page realm has the W3C media and WebRTC facade
  (`src/html/media-devices.ts`, `rtc.ts`), with werift and libav.js's
  `webm-vp9` build as optional peers (`docs/prd-webrtc.md`): VP8 at 640×480
  costs 3.8 ms a frame, Opus 0.14 ms per 20 ms; no published libav.js build
  has H.264.
- `fakeMediaDevices` (`src/html/fake-media.ts`): a test pattern, a tone, a
  fake screen.
- `docs/prd-audio.md` has placed `createAudioFrames`, `decodeAudioBytes` and
  `<audio src>` in core and the Web Audio engine in components.

## 2. API shape: web nouns, React verbs, frames handed over directly

### 2.1 Where compatibility wins

- **Data shapes.** Constraint and settings dictionaries (`deviceId`,
  `width`, `height`, `frameRate`, `facingMode`, `echoCancellation`,
  `noiseSuppression`, `autoGainControl`, `sampleRate`, `channelCount`),
  `kind` strings (`'videoinput'`, `'audioinput'`, `'audiooutput'`), error
  names (`NotAllowedError`, `NotFoundError`, `NotReadableError`,
  `OverconstrainedError`), codec strings (`'avc1.42E01F'`, `'vp8'`,
  `'opus'`). Free to adopt, they carry what developers already know, and
  they make the components facade a thin wrapper. `MediaDeviceCapabilities`
  and `MediaSettings` in components' `media-devices.ts` are already this
  vocabulary; core takes the same field names.
- **A minimal `MediaStream` and `srcObject`.** `getTracks()`,
  `getVideoTracks()`, `getAudioTracks()`; a track has `kind`, `label`,
  `getSettings()`, `getCapabilities()`, `applyConstraints()`, `muted`,
  `readyState`, `stop()`. Cheap, and `<video srcObject={stream}>` ports as
  written.
- **WebCodecs.** `VideoEncoder`, `VideoDecoder`, `AudioEncoder`,
  `AudioDecoder`, each `configure` / `encode` / `output` callback /
  `flush`, plus `isConfigSupported` as the capability answer. Small, well
  designed, and a one-to-one fit for VideoToolbox's and Media Foundation's
  sessions.
- **All of RTC and `MediaRecorder`.** The value of app 4 is running
  livekit-client, mediasoup-client, matrix-js-sdk or PeerJS unmodified, and
  SDP's semantics are the protocol's anyway. There is nothing to simplify
  that would not break interop.

### 2.2 Where simplicity wins

- **Acquisition is render state.** The web makes an app call
  `permissions.query`, then `getUserMedia` in a try/catch, then watch the
  track. Core folds it into one hook in `usePermission`'s vocabulary:

  ```jsx
  const call = useUserMedia({
    video: { deviceId, width: 1280, frameRate: 30 },
    audio: { echoCancellation: true },
  });
  // call.status: 'idle' | 'prompt' | 'pending' | 'live' | 'denied' | 'unavailable' | 'error'
  // call.stream, call.error, call.start(), call.stop()
  <video
    srcObject={call.stream}
    style={{ objectFit: 'cover', transform: 'scaleX(-1)' }}
  />;
  ```

  `getUserMedia(constraints)` stays as the promise form for code outside
  React and for the facade.

- **Labels before permission, ids that stay put.** The web hides labels
  until a grant and digests ids per origin, to stop cross-site
  fingerprinting. A native app has no origin, and macOS lists devices with
  their names while the status is still `notDetermined` (video.md §3.5). A
  device picker renders before consent; only the frames are gated. The
  components facade digests ids and hides labels for `<Html>` pages, where
  the threat is real.
- **Frames come straight off a track.** The web needs
  `MediaStreamTrackProcessor` (Chromium-only) or a canvas round trip. Core:
  `track.onFrame(cb) → unsubscribe`, handing a `VideoFrame` in the shape
  `VideoFrames` already uses (`planes`, `strides`, `time`) or planar
  `Float32Array` audio (`MediaAudioData`'s shape: `{ sampleRate, channels,
frames, time }`). Video is newest-wins, audio drops nothing. The facade
  builds `MediaStreamTrackProcessor`'s `ReadableStream` on top.
- **Screen sources can be listed.** The web forbids it and offers only the
  browser's picker. Following "Decide it, then leave a way out": the
  **system picker is the default** (`SCContentSharingPicker` on macOS 14+,
  the ScreenCast portal, `GraphicsCapturePicker`), and `displaySources()` —
  ids, names, kinds, thumbnails, Electron's `desktopCapturer.getSources` as
  prior art — is the seam for an app that draws its own.
  `features.enumerate` is false where only a portal answers.

  ```jsx
  const share = useDisplayMedia({
    video: { cursor: 'always', frameRate: 30 },
    audio: 'system', // or false, or { appId } for one application's sound
    // source: sourceId, to skip the picker where features.enumerate is true
  });
  ```

- **Things the web has no word for**, named for what they do:
  `captureScreenshot({ source, region }) → { width, height, data, png() }`
  and `<window excludeFromCapture>`.
- **No audio graph in core.** Output is the push sink `prd-audio.md`
  specified (`createAudioFrames(app, { sampleRate, channels })`, with
  `currentTime`, `latency`, `close()`); `<audio srcObject>` is that sink fed
  from a track.

## 3. Echo cancellation makes input and output one module

A call on laptop speakers needs acoustic echo cancellation, and an echo
canceller needs the far-end reference: exactly the samples being played. On
macOS that is VoiceProcessingIO, one audio unit doing both directions; on
Windows a communications-category capture stream paired with its render
endpoint; on Linux PipeWire's `echo-cancel` module, which wraps a sink and
a source together.

So `useUserMedia({ audio: { echoCancellation: true } })` and
`<audio srcObject>` / `createAudioFrames` cannot be designed apart. They
are one core audio module, which routes playback through the
voice-processing path whenever an echo-cancelled capture is live, and whose
feature map says honestly where it cannot (`features.echoCancellation:
false`, and the setting comes back `false` in `getSettings()`, as a browser
reports it).

## 4. Linux: what pure JavaScript can and cannot reach

- **X11 screen capture is pure JavaScript.** SHM `GetImage` (already in
  ntk), XDamage to capture only what changed, XFixes for the cursor image.
  It works against a remote display, which is the reason this project
  exists. `captureScreenshot` and `getDisplayMedia` on X11 need no native
  code.
- **PipeWire is out of reach of `net`.** It hands buffers over as file
  descriptors (`SCM_RIGHTS`), which Node's sockets cannot receive. That
  blocks the ScreenCast portal (which answers with a PipeWire node), the
  Camera portal, and PipeWire-native audio.
- **v4l2 needs `ioctl`.** Device discovery through `/sys/class/video4linux`
  is readable; capture is not.
- **PulseAudio's protocol is reachable** (`prd-audio.md` §Linux), and
  `pipewire-pulse` answers it, so audio — microphone, output, monitor
  sources for loopback — has a pure-JavaScript rung.

Two rungs, cheapest to ship first:

1. **Spawned helpers**, as `<MediaPlayer backend="ffmpeg">` already does:
   `ffmpeg -f v4l2`, `gst-launch-1.0 pipewiresrc ! … ! fdsink`,
   `pw-record` / `parec`. Present where the tool is installed; absent is an
   ordinary state, not an error.
2. **A prebuilt `@windowkit/pipewire`** (an `optionalDependency`, in the
   shape of the other bridges) consuming PipeWire streams into
   `VideoFrames`-shaped frames. The clean answer for Wayland screen capture
   and cameras.

## 5. The split

### 5.1 Core (react-x11)

| piece                                                                                       | why it is core                                                                                                          |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `mediaDevices` (`enumerateDevices`, `devicechange`) and `useMediaDevices()`                 | a desktop-service ladder, the notifications shape; native bridge verbs                                                  |
| `getUserMedia` / `useUserMedia` → tracks, with echo cancellation                            | bridge verbs; input and output are one module (§3)                                                                      |
| `getDisplayMedia` / `useDisplayMedia`, `displaySources()`, system-audio loopback            | bridge verbs; shares the picker and permission ladder                                                                   |
| `captureScreenshot()`                                                                       | shares the eyedropper's ladder nearly line for line                                                                     |
| `<video srcObject>`, `<audio srcObject>`, `createAudioFrames`                               | renderer internals: a macOS camera preview goes IOSurface → layer with no JavaScript copy (video.md §3.5)               |
| `<window excludeFromCapture>`                                                               | a window prop                                                                                                           |
| a global shortcut hook                                                                      | a desktop service with its own ladder                                                                                   |
| WebCodecs-shaped platform codecs                                                            | bridge-only on macOS and Windows; `prd-audio.md`'s argument                                                             |
| Linux portals: Camera, ScreenCast, and the permission statuses they imply                   | closes the gap docs/permissions.md already states                                                                       |
| fake camera, microphone and screen in `react-x11/test`                                      | beside `src/testing/media.js`; components' `fakeMediaDevices` generator moves here and `<Html>`'s WPT runner imports it |
| `useSupports` / `desktopCapability`: `camera`, `audioInput`, `audioOutput`, `screenCapture` | availability as a feature set: `screenCapture` → `{ picker, enumerate, windows, cursor, systemAudio, excludeWindows }`  |

### 5.2 `@react-x11/components`

| piece                                                                                                                                                                            | why it is here                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `./rtc`: `RTCPeerConnection`, `RTCDataChannel`, `getStats` over werift; core's codecs where `isConfigSupported` says yes, libav.js otherwise                                     | a minority of apps, buildable on core, about 50 MB. The host half moves out of `<Html>` so pages and plain apps share one engine |
| `installWebMediaGlobals()`: `navigator.mediaDevices`, `MediaStream`, `RTCPeerConnection`, `MediaStreamTrackProcessor`, `MediaRecorder` on `globalThis`, wrapping core            | what lets existing WebRTC SDKs run unmodified                                                                                    |
| `MediaRecorder` (WebM / MP4 through mediabunny)                                                                                                                                  | buildable on core's tracks and codecs                                                                                            |
| `<DevicePicker>`, `<VideoTile>` / `<VideoGrid>`, `<AudioLevelMeter>`, `<ScreenRegionSelector>` (a fullscreen overlay with a magnifier), `<SourcePicker>`, `<RecordingIndicator>` | composed UI on public host elements                                                                                              |
| resampling, voice-activity detection, the Web Audio engine                                                                                                                       | heavy or niche; `prd-audio.md` already placed the engine here                                                                    |

### 5.3 Neither

Speech-to-text models, signalling for an application's own call protocol,
an SFU, service-specific SDKs. These are the application's or the wider
ecosystem's.

## 6. Order

1. **Core, the devices.** Device list, camera and microphone tracks,
   `<video srcObject>`, `createAudioFrames` and `<audio srcObject>` on
   macOS first — the `AVCaptureSession` path video.md §3.5 already
   measured, native `2vuy` surfaces as layer contents. X11 screen capture,
   `captureScreenshot`, the fake devices in `react-x11/test`.
2. **Core, the screen.** `getDisplayMedia` on every backend's ladder,
   `excludeFromCapture`, system-audio loopback, the global shortcut hook.
3. **Components, RTC.** Move `<Html>`'s host side into `./rtc`, add the
   globals installer, and hold it against livekit-client end to end.
4. **Core, codecs.** WebCodecs over VideoToolbox and Media Foundation —
   hardware H.264, which is what interop with existing services needs and
   what no libav.js build offers. Then components' `MediaRecorder` on it.
5. **Linux natively.** `@windowkit/pipewire`, with the spawned helpers as
   the rung below.

The note taker needs almost nothing from components — microphone, system
loopback and a `{ sampleRate: 16000, channelCount: 1 }` constraint the
platform resamples to — which makes it the right first example app to prove
step 1, with its own tests in `react-x11/test` against the fake devices.

## 7. Open questions

- **Track frames as a callback or a `ReadableStream`?** The callback is
  simpler and cheaper; the stream is what WebCodecs pipelines are written
  against. The proposal is the callback in core and the stream in the
  facade; revisit if core's own encoders want backpressure.
- **Does `useUserMedia` own the device lifetime, or the component?**
  Answered in §0.1: neither. A ref-counted source per device and settings
  is shared across hooks.
- **Screen capture on XQuartz.** Measured in §0.1: the root holds nothing
  at all, not even the X screen. Windows are read from themselves, screens
  are refused with the reason, and the Cocoa rung is the one that answers
  for the Mac's screen.
- **Codecs on Linux.** VA-API is a C library borrowing a `Display*`
  (video.md §2.2); whether a prebuilt bridge for it is worth the closure, or
  ffmpeg spawned with `-c:v h264_vaapi` is the rung, is to measure.
- **What werift lacks for app 4** — simulcast, congestion control, the
  RTCP feedback an SFU expects — is in `prd-webrtc.md` §"Where werift
  differs"; LiveKit and Jitsi interop is the test that settles it.
