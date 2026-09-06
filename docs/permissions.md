# Permissions

May this app use the camera, the microphone, the screen, the accessibility
APIs — and how does it ask?

```jsx
import { usePermission } from 'react-x11';

function RecordButton() {
  const mic = usePermission('microphone');

  if (!mic.available) return <Button label="Record" onPress={record} />;
  if (mic.status === 'granted')
    return <Button label="Record" onPress={record} />;
  return (
    <Button
      label={mic.status === 'prompt' ? 'Allow microphone' : 'Open Settings'}
      onPress={() =>
        mic.status === 'prompt' ? mic.request() : mic.openSettings()
      }
    />
  );
}
```

## The ladder

The [file dialog](filedialog.md)'s shape again, with one rung that answers and
one that only points:

|     |                                  |                                                                                                                                                                                                                 |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **the platform's authorization** | The [cocoa backend](macos.md): macOS's privacy (TCC) status per kind, and the system's own prompt where a framework offers one — `AVCaptureDevice` for the camera and microphone, `CoreLocation`, and the rest. |
| 2   | **the Settings pane**            | `open x-apple.systempreferences:…` — any Mac, bridge or not. It cannot read a status or raise a prompt; it puts the user in front of the switch, which is all `openPrivacySettings` promises.                   |

**On Linux nothing answers yet.** The freedesktop counterparts are the
per-device portals (`org.freedesktop.portal.Camera`, `.Location`, …), which
need no bridge and are
[#466](https://github.com/sidorares/react-x11/issues/466)'s remaining half.
Until then a status query says `'unknown'` and a request rejects with a
**typed** `NoPermissionServiceError` — the signal to keep the feature behind
the answer, not a crash. `usePermission().available` is that branch as render
state.

The top rung is never chosen by naming a backend: the call asks the connection
the tree renders through whether it has an authorization API, and the cocoa
backend says so by carrying one.

## The vocabulary

```ts
type PermissionKind =
  | 'camera'
  | 'microphone'
  | 'screen-recording'
  | 'accessibility'
  | 'input-monitoring'
  | 'automation'
  | 'location';

type PermissionStatus =
  'granted' | 'denied' | 'restricted' | 'prompt' | 'unknown';
```

A status is one of five words, and two of them are not the platform's:

|                |                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `'granted'`    | use it                                                                                                         |
| `'denied'`     | the user said no; `openPrivacySettings()` is the way back                                                      |
| `'restricted'` | MDM or parental controls — the user **cannot** grant it, so no Settings button                                 |
| `'prompt'`     | not decided yet — `request()` would ask                                                                        |
| `'unknown'`    | nothing here can say. A fact about the machine, not the permission, and the reason a status query never throws |

A request answers with the **status after the user answered**, never a bare
boolean, because `'denied'` and `'restricted'` want different UI.

## `usePermission()`

```ts
const { status, available, request, refresh, openSettings } = usePermission(kind, { target? });
```

`status` starts `'unknown'` and settles once read. `request()` resolves with
the status after the user answered and updates `status` with it; a second call
while one is in flight returns the same promise, so a double-clicked button
asks once. There is **no change notification** behind a status on any
platform — the status is what was last read, on mount and after each
`request()`; `refresh()` re-reads it on your own cue, a window coming back to
the front being the usual one.

## The bare functions

```ts
import {
  permissionStatus,
  requestPermission,
  openPrivacySettings,
  permissionBackend,
} from 'react-x11';

await permissionStatus('camera'); // never rejects for anything about the machine
await requestPermission('camera'); // rejects with NoPermissionServiceError where nothing can ask
await openPrivacySettings('camera'); // true if something opened; false off macOS
permissionBackend(); // 'cocoa' | null, synchronously
```

## What each kind actually does on macOS

Not every kind has a prompt of its own, and the shape of the request follows
the framework's:

| kind                   | status                | the "prompt"                                                                                                            |
| ---------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `camera`, `microphone` | all five              | the system's in-process dialog; the answer arrives when the user clicks                                                 |
| `screen-recording`     | never `'prompt'`      | the system's go-to-Settings dialog, shown once; the request resolves at once, and a new grant needs a **restart**       |
| `accessibility`        | never `'prompt'`      | the go-to-Settings dialog; resolves at once, and the grant applies live                                                 |
| `input-monitoring`     | `'prompt'` while open | posts the prompt and resolves at once                                                                                   |
| `automation`           | per **target**        | `{ target: 'com.apple.finder' }` — the bundle id of a **running** app, or the call throws; asking blocks until answered |
| `location`             | all five              | `requestWhenInUseAuthorization`, answered through the run loop                                                          |
| `files-and-folders`    | —                     | no API: reading the folder _is_ the prompt and `EPERM` the denial; `openPrivacySettings` reaches the pane               |
| `full-disk-access`     | —                     | no API; `openPrivacySettings('full-disk-access')`                                                                       |

**Attribution is the thing to know.** A bare `node` process is attributed to
its _responsible process_ — the terminal, an IDE — or to `node` itself, and
prompts with no usage-description strings. A bundled app must carry the keys
(`NSCameraUsageDescription`, `NSMicrophoneUsageDescription`,
`NSLocationUsageDescription`, `NSAppleEventsUsageDescription`) in its
`Info.plist` — without them the request never prompts, or TCC ends the
process. See [packaging.md](packaging.md).

## What differs between the rungs

- **The Settings rung reads nothing.** `openPrivacySettings` opens the pane
  on any Mac — through the bridge on the cocoa backend, by `open` under
  XQuartz — and that is all it does; the status stays `'unknown'` on the X11
  backend because nothing there can read TCC.
- **`'unknown'` is not `'prompt'`.** An app that treats them alike will show
  an "Allow" button on Linux that rejects when pressed. Branch on `available`
  first.
