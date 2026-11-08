# Cameras, microphones and the screen

Cameras, microphones, speakers and the screen, as tracks a `<video>` and an
`<audio>` play and an app reads frames from.

```jsx
import { useMediaDevices, useUserMedia } from 'react-x11';

function Preview() {
  const { cameras } = useMediaDevices();
  const [deviceId, setDeviceId] = useState(null);
  const call = useUserMedia({
    video: { deviceId, width: 1280, frameRate: 30 },
    audio: { echoCancellation: true },
  });

  if (call.status === 'denied') return <AskForCamera />;
  return (
    <box style={{ flexGrow: 1 }}>
      <video
        srcObject={call.stream}
        style={{ flexGrow: 1, objectFit: 'cover', backgroundColor: '#000' }}
      />
      <Select
        value={deviceId}
        onChange={setDeviceId}
        options={cameras.map((c) => ({ value: c.deviceId, label: c.label }))}
      />
    </box>
  );
}
```

The vocabulary is the web's wherever the web has a word for it: constraint
dictionaries, `kind` strings, error names, `MediaStream` and
`MediaStreamTrack`. Code written against `getUserMedia` in a browser ports as
written. Three things differ, all on purpose:

- **Acquisition is render state.** `useUserMedia` is
  `permissions.query`, then `getUserMedia` in a `try`/`catch`, then a watch on
  the track, folded into one hook. `getUserMedia` is still there for code
  outside React.
- **Labels before permission, ids that stay put.** A browser hides device
  names until the page is granted one, and gives each site its own ids, to
  stop fingerprinting across sites. A desktop app has no site. Names are
  listed before anyone is asked, so a device picker renders before consent.
  Only the frames wait for it.
- **Frames come straight off a track.** `track.onFrame(fn)` is how an encoder,
  a speech model or a level meter reads them. A browser needs a
  `MediaStreamTrackProcessor` or a canvas round trip.

The whole W3C object model (`navigator.mediaDevices`, `RTCPeerConnection`,
`MediaRecorder`, EventTarget) belongs to `@react-x11/components`. It wraps
this API, and it is what lets existing WebRTC SDKs run unmodified.

## Where it works

|                            | macOS                                      | X11                       | Wayland, Windows |
| -------------------------- | ------------------------------------------ | ------------------------- | ---------------- |
| devices, `useMediaDevices` | AVFoundation, CoreAudio                    | —                         | —                |
| camera                     | `AVCaptureSession`, shown on its own layer | —                         | —                |
| microphone                 | voice processing (echo cancelled)          | —                         | —                |
| `createAudioFrames`        | the same audio engine                      | —                         | —                |
| `captureScreenshot`        | ScreenCaptureKit                           | `GetImage` on the root    | —                |
| `getDisplayMedia`          | not yet                                    | the root, read per frame  | —                |
| `displaySources`           | displays                                   | monitors and WM's windows | —                |

**macOS** needs a `@windowkit/appkit` with the capture verbs (its
`capture.mm`). With an older bridge every row answers unavailable, never a
crash. The first device listing in a process loads AVFoundation's camera
plug-ins, 100 ms to over a second; it runs off the UI thread, which is one
more reason `useMediaDevices` starts empty and unsettled.

**X11** has the screen and nothing else. A camera or microphone on Linux needs
PipeWire's file descriptors or v4l2's `ioctl`, and Node's sockets cannot reach
either. Those rungs come later, as spawned helpers and a prebuilt PipeWire
bridge. X11 screen capture is pure JavaScript and works against a remote
display.

Ask before rendering something that needs one:

```js
const camera = useDesktopCapability('camera');
const screen = useDesktopCapability('screenCapture');
if (screen.features.enumerate) showSourcePicker();
```

These four capabilities (`camera`, `audioInput`, `audioOutput`,
`screenCapture`) are settled on the first frame, because the backend answers
without asking another process. `available` says whether there is a
mechanism at all. Whether a camera is plugged in right now is what
`useMediaDevices` says.

| capability      | features                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `camera`        | `hotplug`, `labelsBeforePermission`, `nativePreview` (frames go camera → layer without crossing into JavaScript)   |
| `audioInput`    | `echoCancellation`, `noiseSuppression`, `autoGainControl`, `resample`, `hotplug`                                   |
| `audioOutput`   | `deviceSelection`, `echoReference` (what is played is what the echo canceller subtracts)                           |
| `screenCapture` | `picker`, `enumerate`, `screens`, `windows`, `cursor`, `systemAudio`, `excludeWindows`, `screenshot`, `thumbnails` |

## Devices

```js
const { devices, cameras, microphones, speakers, settled } = useMediaDevices();
```

Each device is `{ deviceId, groupId, kind, label, isDefault, capabilities }`.
`kind` is `'videoinput'`, `'audioinput'` or `'audiooutput'`.
`capabilities` gives a range per number (`width: { min, max }`) and a list per
choice. The list is empty with `settled: false` on the first frame, and fills
in a tick later. It follows devices as they are plugged in and out.

`enumerateDevices()` and `watchDevices(fn)` are the same outside React.

## `useUserMedia`

```js
const call = useUserMedia(constraints, { start });
// { status, stream, error, start(), stop() }
```

It opens when the component mounts, and again when the constraints change.
Constraints are compared by value, so an object literal written fresh on
every render does not reopen anything. Pass `{ start: false }` to wait for
`start()`. The tracks it opened stop when the component unmounts.

| `status`        |                                                                                        |
| --------------- | -------------------------------------------------------------------------------------- |
| `'idle'`        | before a start, and after `stop()`                                                     |
| `'prompt'`      | the system is asking the user                                                          |
| `'pending'`     | the device is opening                                                                  |
| `'live'`        | `stream` is playing                                                                    |
| `'denied'`      | `NotAllowedError`: the user or the system said no                                      |
| `'unavailable'` | `NotFoundError`: no device of a kind asked for, or nothing here can open one           |
| `'error'`       | anything else, in `error`: in use by another app (`NotReadableError`), overconstrained |
| `'ended'`       | every track ended other than by `stop()`: the camera unplugged                         |

**One device at one setting is one session.** Two components asking for the
same camera at the same size share one capture session, and it stops when
the last track over it does. A preview and a call screen mounted together do
not fight over the camera.

### Constraints

The web's dictionaries: `true` for a kind at its defaults, or an object.

```js
{
  video: {
    deviceId: id,                       // a preference: another camera stands in
    width: 1280,                        // a preference: the nearest it can do
    frameRate: { ideal: 30, max: 60 },
    facingMode: { exact: 'user' },      // a requirement
  },
  audio: { echoCancellation: true, sampleRate: 16000, channelCount: 1 },
}
```

A bare value or `{ ideal }` is a preference, and the device and settings
nearest to it win. `{ exact }`, `{ min }` and `{ max }` are requirements. A
request that no device can meet rejects with an `OverconstrainedError` whose
`constraint` names the requirement. A device that ran at a setting reports
it in `track.getSettings()`. A camera's sizes are a list, so `width: 1000`
comes back as the nearest one.

Video: `deviceId`, `groupId`, `width`, `height`, `aspectRatio`, `frameRate`,
`facingMode`, `resizeMode`. Audio: `deviceId`, `groupId`, `sampleRate`,
`sampleSize`, `channelCount`, `latency`, `echoCancellation`,
`noiseSuppression`, `autoGainControl`. Where `audioInput`'s `resample`
feature is true, any `sampleRate` and `channelCount` arrives as asked, so a
speech model gets `{ sampleRate: 16000, channelCount: 1 }` without resampling
anything itself. `advanced` is not read.

### Errors

`getUserMedia` rejects with a `DOMException` named as a browser's:

| `name`                 | means                                                                    |
| ---------------------- | ------------------------------------------------------------------------ |
| `NotFoundError`        | no camera or microphone, or nothing on this display can open one         |
| `NotAllowedError`      | the permission is denied, or the user said no to the prompt              |
| `NotReadableError`     | the device would not open: another app has it, or it went away           |
| `OverconstrainedError` | a requirement no device meets; `err.constraint` names it                 |
| `AbortError`           | the request was aborted (`signal`), or the device closed while it opened |

**Permission** is the [permission ladder](permissions.md)'s, asked just
before a device opens. A decided "no" rejects without a prompt. An
undecided one prompts, during `status: 'prompt'`.

On macOS one refusal is not the user saying no. Run node from a shell, or a
bundle without `NSCameraUsageDescription`, and the request comes back
refused while the status still says nobody was asked. The error says so,
and [packaging](packaging.md) has the fix: launch the app bundle through
LaunchServices.

## Tracks and streams

`MediaStream`: `getTracks()`, `getVideoTracks()`, `getAudioTracks()`,
`getTrackById()`, `addTrack()`, `removeTrack()`, `clone()`, `active`, and
`new MediaStream(tracks)` to make one.

`MediaStreamTrack`: `kind`, `label`, `readyState` (`'live'` or `'ended'`),
`muted`, `enabled`, `getSettings()`, `getCapabilities()`, `getConstraints()`,
`applyConstraints()`, `clone()`, `stop()`.

- **`enabled = false`** stops frames reaching `onFrame`, and an element
  showing the track shows nothing. The source keeps running. This is a
  call's "camera off" button.
- **`muted`** is the system's: another app took the camera, or the lid
  closed. It comes back on its own.
- **`applyConstraints()`** moves the track to a source running at the new
  settings. Where a requirement cannot be met, it rejects and changes
  nothing.
- **`onChange(fn)`** hears `readyState`, `muted`, `enabled` and settings
  changes. There is no EventTarget: state is something a component
  subscribes to, not an event it listens for.

### Frames

```js
const off = track.onFrame((frame) => encoder.encode(frame));
```

A video frame is `{ format, width, height, planes, strides, time,
colorSpace, range }`, the shape [`VideoFrames.push`](elements.md#video)
takes. `format` is `'NV12'`, `'I420'` or `'BGRA'`, whichever the source
delivers natively. Video is newest-wins: a reader slower than the camera
sees fewer frames, never older ones.

Audio is `{ sampleRate, channels, frames, time }`: planar `Float32Array`s,
one per channel, about 10 ms at a time. No chunk is dropped.

`time` is in seconds, on the source's clock. The planes and channels belong
to the source until the next frame, so a reader that keeps one copies it.

A source delivers frames to JavaScript only while somebody reads them. On
macOS a `<video srcObject>` showing a camera reads none: the camera's own
layer shows it.

## `<video srcObject>` and `<audio srcObject>`

```jsx
<video srcObject={call.stream} style={{ objectFit: 'cover' }} />
<audio srcObject={remote} volume={0.8} sinkId={speakerId} />
```

`<video srcObject>` shows the stream's first live video track. It is laid
out at the track's size, follows the stream as tracks are added and ended,
and calls `onLoadedMetadata` with `duration: Infinity`. A macOS camera is
lifted onto a layer of its own, its frames never crossing into JavaScript.
When something is drawn over it, the element draws the newest frame
instead. Any other track's frames are read off it and shown as `frames`
would show them. A disabled or muted track shows the poster, or the
background.

There is no mirroring yet: a self-view that should read like a mirror
cannot be flipped, because there is no `transform` style.

`<audio srcObject>` plays the first live audio track through a
`createAudioFrames` sink at the rate it arrives in. `muted`, `volume` and
`paused` decide what is heard, and `sinkId` picks the output device. Where
nothing can play audio, it reports one `NoAudioOutputError` through
`onError`.

`srcObject`, `src` and `frames` are exclusive; passing two throws.

## `createAudioFrames`

```js
const out = createAudioFrames(app, { sampleRate: 48000, channels: 2 });
out.push([left, right]); // Float32Array per channel, -1 to 1
if (out.queued < 0.1) decodeMore();
// out.currentTime: seconds played, by the device's clock; out.latency
out.close();
```

A sink for audio an app decoded or received: queued, played in order,
nothing dropped, silence when it runs dry. There is no graph, mixer or
resampler, so a sink plays the rate it was made with and refuses another.
Keep `queued` near the latency the app can live with. `push` also takes a
microphone chunk as it arrives (`{ channels, frames, sampleRate }`).

On macOS it plays through the same audio engine as an echo-cancelled
microphone. What it plays is what the canceller subtracts, so a call on
laptop speakers does not hear itself. Where nothing can play,
`createAudioFrames` throws `NoAudioOutputError`. Make one in an effect, not
during render: it opens the device.

## The screen

```js
const shot = await captureScreenshot({ source, region });
await fs.writeFile('shot.png', shot.png());

const share = useDisplayMedia({ video: { frameRate: 30 } });
<button onPress={share.start} />;
<video srcObject={share.stream} />;
```

**`captureScreenshot({ source, region, cursor })`** reads the screen once.
It resolves `{ width, height, data, png() }`, where `data` is straight RGBA
(`getImageData`'s shape). `source` is an id from `displaySources()`, the
primary screen without one. `region` is `{ x, y, width, height }` within the
source.

**`getDisplayMedia({ video, audio, source })`** captures a screen or a
window as a stream. Where the display has a picker it is shown, and choosing
nothing rejects with `NotAllowedError`. `source` skips the picker where
sources can be listed. `audio: 'system'` is best effort: where the display
cannot give the system's sound, the stream has no audio track.
`useDisplayMedia` is its hook. Unlike `useUserMedia`, it **waits for
`start()`**: sharing a screen is something a user asks for, and a picker
should not open just because a component mounted.

**`displaySources({ types, thumbnail })`** lists `[{ id, kind, name, x, y,
width, height, thumbnail? }]`, where the display lets an app list them
(`features.enumerate`). An app that draws its own picker uses this. The
system picker is the default.

On **X11** there is no picker, since an X server has none and any client may
read the root window. The default source is the primary monitor. A window
is read from the window itself, so a window over it is not in the picture.
On a server with no compositing manager, the covered part of a window is
undefined. A stream reads its source per frame, only while something reads
its frames. The cursor is not drawn in yet, and there is no XDamage gating
yet.

**XQuartz has no screen to read.** Rootless mode draws each X window as a
Mac window of its own, and the root window is black wherever a window is.
There, `features.screens` is false, a screen source rejects with a
`NotSupportedError` that says why, and `displaySources()` lists only
windows. Windows capture as they do anywhere else. The Mac's screen is the
Cocoa backend's to capture.

On **macOS**, a screenshot needs the Screen Recording permission. A source
is a display (`display:<id>`, listed by `displaySources()` in pixels) or a
window by its number (`window:<number>`, the title bar included). A
`getDisplayMedia` stream there comes with ScreenCaptureKit's stream verbs,
in a later release.

**`<window excludeFromCapture>`** keeps a window out of every screenshot and
recording, this app's own included: a recording indicator, a password
overlay. It is set before the window is first shown. On macOS 15 an excluded
window captures as fully clear pixels. Only macOS has this
(`features.excludeWindows`); X11 has nothing like it.

## Testing

`fakeMediaDevices(app)` from `react-x11/test` gives an app what a browser's
fake devices give its tests:

- a camera drawing colour bars, with a band that moves a row a frame and the
  frame's number along the bottom;
- a microphone playing a 440 Hz tone;
- a speaker whose clock the test moves;
- a screen and a window.

Where the app has no permission service, it gets one answering from a table.

```js
const app = createMockApp();
const fake = fakeMediaDevices(app, { permission: 'prompt' });
await renderX11(<Call />, { app, backend: 'mock' });
fake.last('video').tick(); // one frame, now
fake.setPermission('camera', 'denied');
fake.unplug('fake-camera'); // its tracks end
fake.failNextOpen = { name: 'NotReadableError', message: 'in use' };
fake.outputs[0].samples(); // what <audio srcObject> played
```

A source makes frames on a timer only while something reads them. `tick()`
makes one on demand.
