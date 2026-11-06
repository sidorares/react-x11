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
// A rung's verbs, all optional:
//
//   devices() → DeviceDescription[] (or a promise of them)
//   watch(changed) → unsubscribe
//   open(deviceId, settings, device) → Promise<Source>
//   displaySources({ types, thumbnail }) → Promise<DisplaySource[]>
//   openDisplay({ source, video, audio }) → Promise<{ video, audio? } | null>
//   captureScreenshot({ source, region, cursor }) → Promise<{ width, height, data }>
//   openAudioOutput({ sampleRate, channels, deviceId }) → AudioOutput
//   features → { camera, audioInput, audioOutput, screenCapture } feature maps
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

const KINDS = new Set(['videoinput', 'audioinput', 'audiooutput']);

/** A device as an app sees it: plain, frozen, and what `deviceId` in a
 *  constraint names. */
function deviceInfo(d) {
  return Object.freeze({
    deviceId: String(d.deviceId),
    groupId: d.groupId ? String(d.groupId) : '',
    kind: d.kind,
    label: d.label ?? '',
    isDefault: Boolean(d.isDefault),
    capabilities: Object.freeze({ ...(d.capabilities ?? {}) }),
  });
}

async function descriptions(rung) {
  const list = (await rung.devices()) ?? [];
  return list.filter((d) => KINDS.has(d.kind));
}

/**
 * The cameras, microphones and speakers there are now:
 * `[{ deviceId, groupId, kind, label, isDefault, capabilities }]`, `kind`
 * one of `'videoinput'`, `'audioinput'`, `'audiooutput'`. Names are there
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

const usageKey = (kind) =>
  kind === 'camera'
    ? 'NSCameraUsageDescription'
    : kind === 'microphone'
      ? 'NSMicrophoneUsageDescription'
      : 'the screen capture usage description';

// --- getUserMedia ------------------------------------------------------------------

const NOTHING_OPENS =
  'nothing on this display can open a camera or a microphone. On macOS ' +
  'that takes @windowkit/appkit with its capture verbs; on X11 and Wayland ' +
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
    const deviceKind = a.kind === 'video' ? 'videoinput' : 'audioinput';
    const candidates = devices.filter((d) => d.kind === deviceKind);
    if (candidates.length === 0) {
      throw mediaError(
        'NotFoundError',
        `there is no ${a.kind === 'video' ? 'camera' : 'microphone'} to ` +
          'open — useMediaDevices() lists what there is, and changes when ' +
          'one is plugged in',
      );
    }
    return { ...a, ...selectDevice(candidates, a.constraints) };
  });

  for (const c of chosen) {
    if (options.signal?.aborted) throw abortError();
    await ensureAllowed(
      app,
      c.kind === 'video' ? 'camera' : 'microphone',
      options.onPrompt,
    );
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
 * track of the system's sound where `audio: 'system'` is asked and the
 * display can give it (a browser's rule: audio is best effort, and a
 * stream without it is the answer where it cannot).
 *
 * ```js
 * const stream = await getDisplayMedia({ video: { frameRate: 30 } });
 * const one = await getDisplayMedia({ source: sources[0].id });
 * ```
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
      'react-x11: getDisplayMedia captures a picture: video cannot be false',
    );
  }
  let opened;
  try {
    opened = await rung.openDisplay({
      source: request.source ?? null,
      video: video === true ? {} : { ...video },
      audio: request.audio ?? false,
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
  }
  return new MediaStream(tracks);
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
 * `'audioInput'`, `'audioOutput'` or `'screenCapture'` — as
 * `{ backend, features }`, or null where no rung has it. Synchronous: every
 * rung is the app's own and knows what it can do without asking anyone.
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
    if (features) return { backend: rung.backend ?? 'unknown', features };
  }
  return NONE;
}
