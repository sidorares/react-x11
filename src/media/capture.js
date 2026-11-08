// Media capture: the devices, the tracks they give, the screen — through
// whatever this display can actually do (design/architecture/media-capture.md).
//
// A ladder, like every desktop service here, and found by capability: a
// **rung** is an object with some of the verbs below, and each operation
// takes the first rung that has its verb. Two rungs today:
//
//   1. **`app.mediaCapture`** — the backend's own: the Cocoa app over
//      `@windowkit/appkit`'s capture verbs (src/cocoa/capture.js) —
//      AVFoundation's cameras and microphones, a voice-processing audio path,
//      ScreenCaptureKit's screenshots — or the fake devices `react-x11/test`
//      installs (src/testing/media.js).
//   2. **X11** (src/media/x11capture.js) — the screen, and only the screen:
//      `GetImage` on the root window, which is pure JavaScript and works
//      against a remote display, the reason this project exists. Cameras and
//      microphones on Linux need PipeWire's file descriptors or v4l2's
//      `ioctl`, which Node's sockets cannot reach (§4); they are a later rung.
//
// **Other applications' sound is a device** (§0.2): a rung lists it as
// devices of kind `'systemaudio'` — `system-audio`, every application but
// this one, and `system-audio:<appId>` for one application — and opens it
// with `open` as it opens a microphone. The web has no kind for it: on Linux
// a browser lists a PulseAudio monitor as an `'audioinput'`, and a microphone
// picker fills with "Monitor of …" entries. A kind of its own keeps those out
// of a call's microphone list, and keeps a microphone from standing in for an
// application that was asked for by name, or the other way round.
//
// A rung's verbs, all optional:
//
//   devices() → DeviceDescription[] (or a promise of them)
//   watch(changed) → unsubscribe
//   open(deviceId, settings, device) → Promise<Source>
//   displaySources({ types, thumbnail }) → Promise<DisplaySource[]>
//   openDisplay({ source, video, audio }) → Promise<{ video, audio? } | null>
//   captureScreenshot({ source, region, cursor }) → Promise<{ width, height, data }>
//   openAudioOutput({ sampleRate, channels, deviceId }) → AudioOutput
//   features → { camera, audioInput, audioOutput, screenCapture, systemAudio }
//              feature maps
//
// where a DeviceDescription is `{ deviceId, groupId, kind, label, isDefault,
// capabilities, defaults }` and a Source is what src/media/stream.js shares.
//
// **Labels before permission, ids that stay put** (§2.2). A browser hides
// both until a grant, against fingerprinting by a site; a native app has no
// origin and macOS lists devices with their names before anyone is asked. So
// a device picker renders before consent and only the frames are gated — by
// the permission ladder (src/permissions.js), asked here just before a
// device is opened.

import { liveApps } from '../trace-registry.js';
import {
  permissionBackend,
  permissionStatus,
  requestPermission,
} from '../permissions.js';
import {
  constraintsCopy,
  normalizeTrackConstraints,
  selectDevice,
} from './constraints.js';
import { errorFromBackend, mediaError } from './errors.js';
import { encodePNG } from './png.js';
import {
  acquireSource,
  deviceTrack,
  MediaStream,
  MediaStreamTrack,
  soleSource,
} from './stream.js';
import { x11CaptureFor } from './x11capture.js';

/** The app to ask when the caller did not say: the one there is, or the
 *  one showing a window. */
function soleApp() {
  const apps = liveApps();
  if (apps.length <= 1) return apps[0] ?? null;
  const showing = apps.filter((app) => (app._rootChildren ?? []).length > 0);
  return showing.length === 1 ? showing[0] : null;
}

export const appFor = (options) => options?.app ?? soleApp();

/** The rungs that capture on `app`, best first. */
export function captureRungs(app) {
  const rungs = [];
  if (app?.mediaCapture) rungs.push(app.mediaCapture);
  const x11 = x11CaptureFor(app);
  if (x11) rungs.push(x11);
  return rungs;
}

/** The first rung on `app` that has `verb`, or null. */
export function rungWith(app, verb) {
  return captureRungs(app).find((r) => typeof r[verb] === 'function') ?? null;
}

// --- devices -------------------------------------------------------------------

const KINDS = new Set([
  'videoinput',
  'audioinput',
  'audiooutput',
  'systemaudio',
]);

/** The id of every other application's sound, and the start of each one's:
 *  `system-audio:<appId>`. */
export const SYSTEM_AUDIO = 'system-audio';

/** A device as an app sees it: plain, frozen, and what `deviceId` in a
 *  constraint names. */
function deviceInfo(d) {
  const info = {
    deviceId: String(d.deviceId),
    groupId: d.groupId ? String(d.groupId) : '',
    kind: d.kind,
    label: d.label ?? '',
    isDefault: Boolean(d.isDefault),
    capabilities: Object.freeze({ ...(d.capabilities ?? {}) }),
  };
  if (d.kind === 'systemaudio') {
    // which application, for a picker's icon; and whether it is making a
    // sound now, which is what a person scans the list for
    if (d.appId) info.appId = String(d.appId);
    info.playing = Boolean(d.playing);
  }
  return Object.freeze(info);
}

async function descriptions(rung) {
  const list = (await rung.devices()) ?? [];
  return list.filter((d) => KINDS.has(d.kind));
}

/**
 * The cameras, microphones and speakers there are now, and the applications'
 * sound: `[{ deviceId, groupId, kind, label, isDefault, capabilities }]`,
 * `kind` one of `'videoinput'`, `'audioinput'`, `'audiooutput'` and
 * `'systemaudio'` — which also say `appId` and `playing`. Names are there
 * before any permission, and ids are the same next launch. Resolves `[]`
 * where nothing can list devices — an ordinary state, not an error.
 */
export async function enumerateDevices(options = {}) {
  const rung = rungWith(appFor(options), 'devices');
  if (!rung) return [];
  return (await descriptions(rung)).map(deviceInfo);
}

/** `fn()` whenever a device comes or goes, or a default changes; the answer
 *  unsubscribes. Nothing is called where nothing can tell. */
export function watchDevices(fn, options = {}) {
  const rung = rungWith(appFor(options), 'watch');
  return rung ? rung.watch(fn) : () => {};
}

// --- permission ------------------------------------------------------------------

/**
 * Asked just before a device is opened: a decided "no" rejects without a
 * prompt, an undecided one prompts, and a backend that cannot say (X11, a
 * test with no permission service) opens and lets the device answer.
 * `onPrompt` hears that the system is asking, for a hook's `'prompt'`.
 */
async function ensureAllowed(app, kind, onPrompt) {
  if (!permissionBackend({ app })) return;
  let status = await permissionStatus(kind, { app });
  if (status === 'granted' || status === 'unknown') return;
  if (status === 'prompt') {
    onPrompt?.(kind);
    status = await requestPermission(kind, { app });
  }
  if (status === 'granted') return;
  if (status === 'prompt') {
    // the trap video.md §3.5 measured: a process the system does not take
    // for an app of its own is refused without ever being asked
    throw mediaError(
      'NotAllowedError',
      `the ${kind} was refused without the user being asked. macOS does ` +
        'that for a process it does not take for an app of its own — node ' +
        'run from a shell, a bundle without the usage description key — so ' +
        'this is not the user saying no. Launch the app bundle through ' +
        `LaunchServices (\`open\`), with ${usageKey(kind)} in its ` +
        'Info.plist (docs/packaging.md).',
    );
  }
  throw mediaError(
    'NotAllowedError',
    `the ${kind} is not allowed (${status}). openPrivacySettings(` +
      `'${kind}') puts the user in front of the switch.`,
  );
}

const USAGE_KEYS = {
  camera: 'NSCameraUsageDescription',
  microphone: 'NSMicrophoneUsageDescription',
  'system-audio-recording': 'NSAudioCaptureUsageDescription',
};
const usageKey = (kind) =>
  USAGE_KEYS[kind] ?? 'the screen capture usage description';

// --- getUserMedia ------------------------------------------------------------------

const NOTHING_OPENS =
  'nothing on this display can open a camera or a microphone. On macOS ' +
  'that takes @windowkit/appkit 0.31 or later — `npm ls @windowkit/appkit` ' +
  'says which this app has; on X11 and Wayland ' +
  'there is no camera or microphone rung yet (design/architecture/' +
  "media-capture.md §4); in a test, fakeMediaDevices(app) from 'react-x11/" +
  "test' gives one. Ask useDesktopCapability('camera') or " +
  "useDesktopCapability('audioInput') before asking for one.";

/**
 * A camera, a microphone or both, as a `MediaStream`:
 *
 * ```js
 * const stream = await getUserMedia({
 *   video: { width: 1280, frameRate: 30 },
 *   audio: { echoCancellation: true },
 * });
 * ```
 *
 * The web's constraints (src/media/constraints.js) choose the device and
 * its settings. Rejects as a browser does: `NotFoundError` where there is no
 * device of a kind asked for, `OverconstrainedError` where a required
 * constraint cannot be met, `NotAllowedError` where the user or the system
 * said no, `NotReadableError` where the device would not open — in use by
 * another app, or gone. The tracks are the caller's to `stop()`;
 * `useUserMedia` does that for a component.
 */
export async function getUserMedia(constraints, options = {}) {
  if (
    constraints === null ||
    typeof constraints !== 'object' ||
    (!constraints.video && !constraints.audio)
  ) {
    throw new TypeError(
      'react-x11: getUserMedia needs { video } or { audio }, or both — for ' +
        'example getUserMedia({ video: true })',
    );
  }
  const app = appFor(options);
  const asked = [];
  for (const kind of ['video', 'audio']) {
    const c = normalizeTrackConstraints(kind, constraints[kind]);
    if (c) asked.push({ kind, constraints: c, raw: constraints[kind] });
  }
  const rung = rungWith(app, 'open');
  if (!rung) throw mediaError('NotFoundError', NOTHING_OPENS);

  // every choice made before anything is asked or opened, so a request that
  // cannot be met fails without a prompt for the half that could
  const devices =
    typeof rung.devices === 'function' ? await descriptions(rung) : [];
  const chosen = asked.map((a) => {
    const deviceKind =
      a.kind === 'video'
        ? 'videoinput'
        : namesSystemAudio(a.raw)
          ? 'systemaudio'
          : 'audioinput';
    const candidates = devices.filter((d) => d.kind === deviceKind);
    if (deviceKind === 'systemaudio') {
      candidates.push(...unlistedApplications(rung, candidates, a.raw));
    }
    if (candidates.length === 0) throw noDevice(deviceKind);
    return { ...a, deviceKind, ...selectDevice(candidates, a.constraints) };
  });

  for (const c of chosen) {
    if (options.signal?.aborted) throw abortError();
    await ensureAllowed(app, PERMISSION_OF[c.deviceKind], options.onPrompt);
  }

  const tracks = [];
  try {
    for (const c of chosen) {
      if (options.signal?.aborted) throw abortError();
      const shared = await acquireSource(rung, c.device, c.settings);
      tracks.push(
        deviceTrack(shared, {
          device: c.device,
          rung,
          settings: c.settings,
          constraints: c.raw === true ? {} : c.raw,
        }),
      );
    }
  } catch (err) {
    for (const t of tracks) t.stop();
    throw err;
  }
  if (options.signal?.aborted) {
    for (const t of tracks) t.stop();
    throw abortError();
  }
  return new MediaStream(tracks);
}

const abortError = () =>
  new DOMException('react-x11: the request was aborted', 'AbortError');

const PERMISSION_OF = {
  videoinput: 'camera',
  audioinput: 'microphone',
  systemaudio: 'system-audio-recording',
};

function noDevice(deviceKind) {
  if (deviceKind === 'systemaudio') {
    return mediaError(
      'NotFoundError',
      "there is no other applications' sound to record here. On macOS " +
        'that takes macOS 14.2 and @windowkit/appkit 0.32 or later; ' +
        'elsewhere there is no rung for it yet (design/architecture/' +
        "media-capture.md §0.2). useDesktopCapability('systemAudio') says " +
        'so before asking.',
    );
  }
  return mediaError(
    'NotFoundError',
    `there is no ${deviceKind === 'videoinput' ? 'camera' : 'microphone'} ` +
      'to open — useMediaDevices() lists what there is, and changes when ' +
      'one is plugged in',
  );
}

/** The ids an audio constraint's `deviceId` names, however it is written:
 *  bare, a list, or under `exact` and `ideal`. */
function namedIds(raw) {
  const id = raw && typeof raw === 'object' ? raw.deviceId : undefined;
  const forms =
    id !== null && typeof id === 'object' && !Array.isArray(id)
      ? [id.exact, id.ideal]
      : [id];
  return forms.flat().filter((v) => typeof v === 'string');
}

/** Whether audio constraints ask for other applications' sound: a `deviceId`
 *  that is `system-audio` or one of its applications'. */
function namesSystemAudio(raw) {
  return namedIds(raw).some(
    (id) => id === SYSTEM_AUDIO || id.startsWith(`${SYSTEM_AUDIO}:`),
  );
}

/**
 * An application asked for by id that is not listed — not running yet, or
 * not making a sound — as a device that can still be opened, where the rung
 * can tap one application: its tap waits for it, so a note taker can start
 * on a call app before the call does. Its capabilities are `system-audio`'s.
 */
function unlistedApplications(rung, listed, raw) {
  const all = listed.find((d) => d.deviceId === SYSTEM_AUDIO);
  if (!all || !rung.features?.systemAudio?.applications) return [];
  const known = new Set(listed.map((d) => d.deviceId));
  return namedIds(raw)
    .filter(
      (id) =>
        id.startsWith(`${SYSTEM_AUDIO}:`) &&
        !id.startsWith(`${SYSTEM_AUDIO}:pid:`) &&
        !known.has(id),
    )
    .map((id) => ({
      ...all,
      deviceId: id,
      label: id.slice(SYSTEM_AUDIO.length + 1),
      appId: id.slice(SYSTEM_AUDIO.length + 1),
      isDefault: false,
      playing: false,
    }));
}

// --- the screen --------------------------------------------------------------------

/**
 * The screens and windows there are to capture, where this display lets an
 * app list them (`features.enumerate` in `useDesktopCapability(
 * 'screenCapture')`): `[{ id, kind: 'screen' | 'window', name, x, y, width,
 * height, thumbnail? }]`. Pass one's `id` as `source` to `getDisplayMedia`
 * or `captureScreenshot` to skip the picker; `thumbnail: { width, height }`
 * asks for an RGBA picture of each, no larger than that. Resolves `[]` where
 * only a system picker can choose.
 */
export async function displaySources(options = {}) {
  const rung = rungWith(appFor(options), 'displaySources');
  if (!rung) return [];
  return rung.displaySources({
    types: options.types ?? ['screen', 'window'],
    thumbnail: options.thumbnail ?? null,
  });
}

/**
 * A screen or a window as a `MediaStream`: one video track, and an audio
 * track of the system's sound where `audio: 'system'` is asked — or of one
 * application's with `audio: { appId }` — and the display can give it (a
 * browser's rule: audio is best effort, and a stream without it is the
 * answer where it cannot).
 *
 * ```js
 * const stream = await getDisplayMedia({ video: { frameRate: 30 } });
 * const one = await getDisplayMedia({ source: sources[0].id });
 * const call = await getDisplayMedia({ audio: { appId: 'us.zoom.xos' } });
 * ```
 *
 * A screen rung that gives no sound of its own is paired with the
 * `'systemaudio'` source of the same name, through the same permission
 * `getUserMedia` asks for it. Audio without a picture is `getUserMedia({
 * audio: { deviceId: 'system-audio' } })`: the web's `getDisplayMedia`
 * always captures a picture, and this one keeps to that.
 *
 * Where the display has a picker it is shown, and a user who chooses nothing
 * rejects it with `NotAllowedError`, as a browser's does. `source` skips it
 * where the display lets sources be listed. Rejects with
 * `NotSupportedError` where nothing can capture the screen.
 */
export async function getDisplayMedia(request = {}, options = {}) {
  const app = appFor(options);
  const rung = rungWith(app, 'openDisplay');
  if (!rung) {
    throw mediaError(
      'NotSupportedError',
      'nothing on this display can capture the screen. ' +
        "useDesktopCapability('screenCapture') says so before asking.",
    );
  }
  await ensureAllowed(app, 'screen-recording', options.onPrompt);
  const video = request.video === undefined ? true : request.video;
  if (video === false) {
    throw new TypeError(
      'react-x11: getDisplayMedia captures a picture: video cannot be ' +
        "false. Other applications' sound alone is getUserMedia({ audio: " +
        "{ deviceId: 'system-audio' } }).",
    );
  }
  const audio = displayAudio(request.audio);
  let opened;
  try {
    opened = await rung.openDisplay({
      source: request.source ?? null,
      video: video === true ? {} : { ...video },
      audio,
    });
  } catch (err) {
    throw errorFromBackend(err, 'the screen could not be captured');
  }
  if (!opened?.video) {
    throw mediaError(
      'NotAllowedError',
      'nothing was chosen to share — the user dismissed the picker',
    );
  }
  const tracks = [
    new MediaStreamTrack({
      shared: soleSource(opened.video),
      constraints: video === true ? {} : constraintsCopy(video),
    }),
  ];
  if (opened.audio) {
    tracks.push(
      new MediaStreamTrack({
        shared: soleSource(opened.audio),
        constraints: {},
      }),
    );
  } else if (audio) {
    const sound = await systemAudioTrack(app, audio, options);
    if (sound) tracks.push(sound);
  }
  return new MediaStream(tracks);
}

/** `getDisplayMedia`'s `audio`, as a rung reads it: `false`, `'system'` or
 *  `{ appId }`. `true` is the web's way to ask for whatever sound there is,
 *  which here is the system's. */
function displayAudio(audio) {
  if (audio === undefined || audio === null || audio === false) return false;
  if (audio === true || audio === 'system') return 'system';
  if (typeof audio === 'object' && typeof audio.appId === 'string') {
    return { appId: audio.appId };
  }
  throw new TypeError(
    `react-x11: getDisplayMedia's audio is ${JSON.stringify(audio)} — ` +
      "expected false, 'system', or { appId } for one application's sound",
  );
}

/** The `'systemaudio'` track a screen's stream is paired with, or null where
 *  there is none to open or it was not allowed: best effort, as a browser's
 *  audio is. */
async function systemAudioTrack(app, audio, options) {
  const deviceId =
    audio === 'system' ? SYSTEM_AUDIO : `${SYSTEM_AUDIO}:${audio.appId}`;
  if (!rungWith(app, 'open')?.features?.systemAudio) return null;
  try {
    const stream = await getUserMedia(
      { audio: { deviceId: { exact: deviceId } } },
      { app, signal: options.signal, onPrompt: options.onPrompt },
    );
    return stream.getAudioTracks()[0] ?? null;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return null;
  }
}

/**
 * One picture of a screen, a window or a part of one:
 *
 * ```js
 * const shot = await captureScreenshot();
 * await fs.writeFile('shot.png', shot.png());
 * ```
 *
 * `source` is a `displaySources()` id (the primary screen without one),
 * `region` a `{ x, y, width, height }` within it in its own pixels. Resolves
 * `{ width, height, data, png() }`, `data` straight RGBA — `getImageData`'s
 * shape — and `png()` the same encoded. Rejects with `NotAllowedError`
 * where the system will not let the app read the screen, and with
 * `NotSupportedError` where nothing here can.
 */
export async function captureScreenshot(options = {}) {
  const app = appFor(options);
  const rung = rungWith(app, 'captureScreenshot');
  if (!rung) {
    throw mediaError(
      'NotSupportedError',
      'nothing on this display can read the screen. ' +
        "useDesktopCapability('screenCapture').features.screenshot says so " +
        'before asking.',
    );
  }
  await ensureAllowed(app, 'screen-recording');
  let shot;
  try {
    shot = await rung.captureScreenshot({
      source: options.source ?? null,
      region: options.region ?? null,
      cursor: Boolean(options.cursor),
    });
  } catch (err) {
    throw errorFromBackend(err, 'the screen could not be read');
  }
  return screenshotOf(shot);
}

/** What a rung answered, as the object `captureScreenshot` resolves. */
function screenshotOf({ width, height, data }) {
  const pixels =
    data instanceof Uint8ClampedArray
      ? data
      : new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  return {
    width,
    height,
    data: pixels,
    png: () => encodePNG(width, height, pixels),
  };
}

// --- what a rung can do, for the capability probes ----------------------------------

const NONE = null;

/**
 * The feature map a capability answers for `app` — `'camera'`,
 * `'audioInput'`, `'audioOutput'`, `'screenCapture'` or `'systemAudio'` —
 * as `{ backend, features }`, or null where no rung has it. Synchronous:
 * every rung is the app's own and knows what it can do without asking
 * anyone.
 */
export function captureCapability(app, name) {
  return capabilityOf(app, name);
}

/** The same, once every rung that has something left to ask — the X11
 *  rung, whether the server is XQuartz — has asked it. */
export async function settledCaptureCapability(app, name) {
  await Promise.all(captureRungs(app).map((r) => r.ready?.()));
  return capabilityOf(app, name);
}

function capabilityOf(app, name) {
  for (const rung of captureRungs(app)) {
    const features = rung.features?.[name];
    if (!features) continue;
    // a stream of the screen comes with the system's sound where a rung
    // records it, whether or not the screen's rung does (`getDisplayMedia`)
    if (
      name === 'screenCapture' &&
      features.streams &&
      !features.systemAudio &&
      rungWith(app, 'open')?.features?.systemAudio
    ) {
      return {
        backend: rung.backend ?? 'unknown',
        features: { ...features, systemAudio: true },
      };
    }
    return { backend: rung.backend ?? 'unknown', features };
  }
  return NONE;
}
