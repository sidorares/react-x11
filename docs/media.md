# Cameras, microphones and the screen

Cameras, microphones, speakers, the screen and the sound other applications
play, as tracks a `<video>` and an `<audio>` play and an app reads frames
from.

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
| `getDisplayMedia`          | ScreenCaptureKit streams (appkit 0.33)     | the root, read per frame  | —                |
| `displaySources`           | displays and windows                       | monitors and WM's windows | —                |
| other applications' sound  | CoreAudio process taps (macOS 14.2)        | —                         | —                |

**macOS** needs `@windowkit/appkit` 0.32 or later, which is what react-x11
installs, and other applications' sound needs macOS 14.2 as well. Screen
streams need 0.33. An older bridge answers unavailable for every row it
cannot do, rather than crashing: 0.32 has everything but screen streams, and
0.31 has everything but those and other applications' sound. The first device listing in a process loads AVFoundation's camera
plug-ins, 100 ms to over a second; it runs off the UI thread, which is one
more reason `useMediaDevices` starts empty and unsettled. In a `<Frame>` pane
the host captures for the pane, so all of this works there too: what a pane's
capture costs is in [frame.md](frame.md#sizing-stacking-input).

**X11** has the screen and nothing else. A camera or microphone on Linux needs
PipeWire's file descriptors or v4l2's `ioctl`, and Node's sockets cannot reach
either. Other applications' sound on Linux is a PulseAudio monitor source,
whose protocol is reachable, and is a rung still to come. Those rungs come later, as spawned helpers and a prebuilt PipeWire
bridge. X11 screen capture is pure JavaScript and works against a remote
display.

Ask before rendering something that needs one:

```js
const camera = useDesktopCapability('camera');
const screen = useDesktopCapability('screenCapture');
if (screen.features.enumerate) showSourcePicker();
```

These five capabilities (`camera`, `audioInput`, `audioOutput`,
`screenCapture`, `systemAudio`) are settled on the first frame, because the
backend answers without asking another process. `available` says whether there is a
mechanism at all. Whether a camera is plugged in right now is what
`useMediaDevices` says.

| capability      | features                                                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `camera`        | `hotplug`, `labelsBeforePermission`, `nativePreview` (frames go camera → layer without crossing into JavaScript)                                                                    |
| `audioInput`    | `echoCancellation`, `noiseSuppression`, `autoGainControl`, `resample`, `hotplug`                                                                                                    |
| `audioOutput`   | `deviceSelection`, `echoReference` (what is played is what the echo canceller subtracts)                                                                                            |
| `screenCapture` | `picker`, `enumerate`, `screens`, `streams` (`getDisplayMedia` works), `windows`, `cursor`, `systemAudio` (a stream comes with sound), `excludeWindows`, `screenshot`, `thumbnails` |
| `systemAudio`   | `applications` (one application on its own), `excludesSelf` (this app's sound is left out), `resample`, `hotplug`, `playing`                                                        |

## Devices

```js
const { devices, cameras, microphones, speakers, systemAudio, settled } =
  useMediaDevices();
```

Each device is `{ deviceId, groupId, kind, label, isDefault, capabilities }`.
`kind` is `'videoinput'`, `'audioinput'`, `'audiooutput'` or `'systemaudio'`,
other applications' sound ([below](#other-applications-sound)), which also
says `appId` and `playing`.
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

## Other applications' sound

```jsx
const { systemAudio } = useMediaDevices();
const others = useUserMedia(
  { audio: { deviceId: 'system-audio', sampleRate: 16000, channelCount: 1 } },
  { start: false },
);
```

What the other applications play, all of them or one, as an audio track: what
a note taker transcribes beside the microphone, what a recorder keeps.

- **`system-audio`** is every application but this one. Where
  `features.excludesSelf` is true, this app's own sound is left out: its
  notification sounds, its `<audio>`, a call it plays back.
- **`system-audio:<appId>`** is one application: an id from the list, or one
  the app already knows, a bundle id on macOS (`'system-audio:us.zoom.xos'`).
  A browser plays through helper processes, and so does an Electron app; the
  application's entry takes them in. One that is not running opens anyway and
  is silence until it plays, so a recording can start before the call does.
- A tool that belongs to no application (`afplay`) is listed while it plays.

These are devices of their own kind, `'systemaudio'`, listed in
`useMediaDevices().systemAudio`, with `system-audio` first. The list follows
applications as they start, quit and make a sound, and `playing` says which
ones are making one. They are not `'audioinput'` devices, because a
microphone picker would then fill with applications. A Linux browser does
that with PulseAudio monitors. So an `audio` request without a
`system-audio` `deviceId` gets a microphone, and one with it never does, not
even as the web's nearest device standing in.

The track behaves as a microphone's does: planar floats in 10 ms chunks,
nothing dropped, at the `sampleRate` and `channelCount` asked (stereo at 48
kHz by default). `echoCancellation`, `noiseSuppression` and `autoGainControl`
are always `false`. Silence arrives as silence, so a chunk's `time` counts
from when recording started, not from the first sound.

**Permission** is its own kind, `'system-audio-recording'`, asked before the
first one opens. On macOS it is System Audio Recording, under Privacy &
Security › Screen & System Audio Recording, and a bundle needs
`NSAudioCaptureUsageDescription`. **macOS records silence rather than fail
when it is refused**, so the status is read first and a refusal rejects with
`NotAllowedError`. macOS has no public call for this status. Where the bridge
cannot read it, it is `'unknown'`, and the first recording raises the system's
prompt on its own.

`getDisplayMedia({ audio: 'system' })`, or `{ audio: { appId } }`, pairs a
screen's stream with the same sound where both exist
(`screenCapture.features.systemAudio`). Sound without a picture is
`getUserMedia`: the web's `getDisplayMedia` always captures a picture, and so
does this one.

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
sources can be listed. `audio: 'system'` (or `true`), and `{ appId }` for one
application, are best effort: where the display cannot give that sound, or it
is not allowed, the stream has no audio track.
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

On **macOS**, a screenshot and a stream need the Screen Recording
permission. A source is a display (`display:<id>`, listed by
`displaySources()` in pixels) or a window by its number (`window:<number>`,
the title bar included). `displaySources()` lists the windows a person would
share, frontmost first, each named by its application and title, with its
own `title`, `appId` and `pid`. There is no system picker here: an app picks
from `displaySources()`, and with no `source` the stream is of the main
display.

A `getDisplayMedia` stream is ScreenCaptureKit's, which needs
`@windowkit/appkit` 0.33:

- `video: { width, height }` is a box to fit, aspect kept; a width or a height
  alone sets the other. `frameRate` is a ceiling (30 by default), and a still
  screen sends no frames at all. `cursor: 'never'` leaves the pointer out.
- A `<video srcObject>` shows it on a layer of its own, as a camera, with no
  frame crossing into JavaScript. `track.onFrame` hands over BGRA frames, the
  newest only.
- `applyConstraints({ frameRate, width, height })` changes the running
  stream; one the system refuses rejects with `OverconstrainedError`.
- A window minimized, hidden or on another space mutes the track. A window
  closed ends it within a second, and so does the user stopping the share from
  the menu bar.
- `audio` pairs the stream with other applications' sound, the process taps
  above, through the same System Audio Recording permission.

A bridge before 0.33 takes screenshots and streams nothing:
`features.streams` is false, and `getDisplayMedia` rejects with
`NotSupportedError`. A capture holds a script's process open while a source
is open, as a socket does, so a script with no window can await one; stop
the tracks to let it end.

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
- a screen and a window;
- `system-audio` and one application, `system-audio:com.example.player`,
  playing a 660 Hz tone. An application asked for by an id that is not listed
  opens as silence.

Where the app has no permission service, it gets one answering from a table.

```js
const app = createMockApp();
const fake = fakeMediaDevices(app, { permission: 'prompt' });
await renderX11(<Call />, { app, backend: 'mock' });
fake.last('video').tick(); // one frame, now
fake.setPermission('camera', 'denied');
fake.unplug('fake-camera'); // its tracks end
fake.setPlaying('system-audio:com.example.player', false);
fake.failNextOpen = { name: 'NotReadableError', message: 'in use' };
fake.outputs[0].samples(); // what <audio srcObject> played
```

A source makes frames on a timer only while something reads them. `tick()`
makes one on demand.

For a real camera, microphone and screen, `npm run labs:media-capture`
(`examples/labs/media-capture.jsx`) puts every capability in one window: what
the display says it can do, the permissions, the devices, a camera preview, a
microphone meter, a tone through the audio out, screenshots, other
applications' sound with a meter and a WAV of what it heard, and a log of what
each step answered.
