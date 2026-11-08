// Media capture on macOS (design/architecture/media-capture.md §5.1): the
// capture rung (src/media/capture.js) over @windowkit/appkit's capture
// verbs — AVFoundation's cameras and microphones, CoreAudio's speakers, an
// audio path that cancels echo against what it plays, CoreAudio's process
// taps for other applications' sound, and ScreenCaptureKit's screenshots. `CocoaApp.mediaCapture` is this object, and its presence is
// the capability; each part is there only where the bridge has its verbs, so
// an older bridge answers `camera` unavailable rather than failing at open.
//
// The bridge's words are Apple's and its ids are its own; what is decided
// here is the translation, and three things worth knowing:
//
//   - **A camera shows itself.** `openCamera` answers a layer the bridge
//     keeps showing the camera's newest frame — the IOSurface the capture
//     session delivered, as layer contents, never crossing into JavaScript
//     (video.md §3.5: asking for BGRA instead costs 2.7x the CPU). A
//     `<video srcObject>` lifts that layer the way it lifts a player's
//     (`CameraPresentation`, src/cocoa/sprites.js), and where the presenter
//     declines — something drawn over it — the element draws the frame
//     `cameraCopyFrame` converts. Frames reach JavaScript only while a track
//     reader asks (`cameraFrames(id, true)`), as copies of the native planes.
//   - **Opening is asynchronous.** The session starts on the bridge's
//     queue, and `camera-started` or `camera-error { name }` answers the
//     open; the name is Media Capture's (`NotAllowedError`, …) already.
//   - **One audio engine.** The microphone and every output share the
//     bridge's voice-processing path while an echo-cancelled microphone is
//     live, which is what lets it cancel what this app plays (§3). The
//     settings a microphone reports say whether that engaged.
//   - **A screen is a camera with the desktop behind it.** `getDisplayMedia`
//     opens ScreenCaptureKit's stream of a display or a window (appkit
//     0.33's `openDisplayStream`), shown on a layer of its own the way a
//     camera's session is and lifted the same way (`CameraPresentation`),
//     its frames BGRA and handed over only on request. A window minimized
//     mutes it, and a window closed ends it.
//   - **Other applications' sound is a device too** (§0.2): the bridge's
//     process taps (macOS 14.2, appkit 0.32) listed as `'systemaudio'`
//     devices — `system-audio`, every application but this one, and one per
//     application a person would pick — and opened as a microphone is, their
//     chunks in the microphone's shape. The bridge lists processes; which of
//     them is a source is decided here (`systemAudioSources`).

import { PlayerState } from './player.js';

/** Has `native` the verbs to list and open capture devices? */
export function canCapture(native) {
  return typeof native?.captureDevices === 'function';
}

const KIND = {
  camera: 'videoinput',
  microphone: 'audioinput',
  speaker: 'audiooutput',
};

const FACING = { front: 'user', back: 'environment' };

/** Ranges over a camera's formats, and the settings a browser's default
 *  would come to on it: the largest format no bigger than 1280x720, at 30
 *  frames a second or as near as it goes. */
function cameraShape(d) {
  const formats = Array.isArray(d.formats) ? d.formats : [];
  const caps = { resizeMode: ['none'] };
  if (formats.length) {
    const span = (pick) => ({
      min: Math.min(...formats.map(pick)),
      max: Math.max(...formats.map(pick)),
    });
    caps.width = span((f) => f.width);
    caps.height = span((f) => f.height);
    caps.frameRate = {
      min: Math.min(
        ...formats.map((f) => f.minFrameRate ?? f.maxFrameRate ?? 30),
      ),
      max: Math.max(...formats.map((f) => f.maxFrameRate ?? 30)),
    };
    caps.aspectRatio = {
      min: Math.min(...formats.map((f) => f.width / f.height)),
      max: Math.max(...formats.map((f) => f.width / f.height)),
    };
  }
  const facing = FACING[d.position];
  if (facing) caps.facingMode = [facing];
  const fits = formats.filter((f) => f.width <= 1280 && f.height <= 720);
  const best = (fits.length ? fits : formats).reduce(
    (a, f) => (a === null || f.width * f.height > a.width * a.height ? f : a),
    null,
  );
  const defaults = { resizeMode: 'none' };
  if (best) {
    defaults.width = best.width;
    defaults.height = best.height;
    defaults.aspectRatio = best.width / best.height;
    defaults.frameRate = Math.min(30, best.maxFrameRate ?? 30);
  }
  if (facing) defaults.facingMode = facing;
  return { caps, defaults };
}

// A microphone is resampled and downmixed by the bridge to whatever is
// asked, and voice processing brings all three of its switches.
const MICROPHONE_CAPABILITIES = Object.freeze({
  sampleRate: { min: 8000, max: 48000 },
  channelCount: { min: 1, max: 2 },
  echoCancellation: [true, false],
  noiseSuppression: [true, false],
  autoGainControl: [true, false],
});
const MICROPHONE_DEFAULTS = Object.freeze({
  sampleRate: 48000,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
});

// A tap is resampled and mixed by the bridge to whatever is asked, and it is
// the applications' own sound: nothing to cancel, suppress or level.
const SYSTEM_AUDIO_CAPABILITIES = Object.freeze({
  sampleRate: { min: 8000, max: 192000 },
  channelCount: { min: 1, max: 2 },
  echoCancellation: [false],
  noiseSuppression: [false],
  autoGainControl: [false],
});
const SYSTEM_AUDIO_DEFAULTS = Object.freeze({
  sampleRate: 48000,
  channelCount: 2,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
});

/** The device every system-audio source's id begins with, and its own: every
 *  application but this one (`SYSTEM_AUDIO` in src/media/capture.js, which
 *  this backend does not import). */
const SYSTEM_AUDIO_ID = 'system-audio';

const systemAudioDevice = (deviceId, label, more = {}) => ({
  deviceId,
  groupId: '',
  kind: 'systemaudio',
  label,
  isDefault: deviceId === SYSTEM_AUDIO_ID,
  playing: false,
  capabilities: SYSTEM_AUDIO_CAPABILITIES,
  defaults: SYSTEM_AUDIO_DEFAULTS,
  ...more,
});

/**
 * The sources a person would pick from, out of the processes the bridge
 * lists — every process connected to the audio server, most of them daemons
 * that never make a sound: `system-audio` first, then one source per
 * application that has a Dock icon or is playing now, a browser's renderers
 * and an app's helpers under the application they run from, and a tool in no
 * bundle (`afplay`) while it plays. This process is none of them, nor is the
 * application it runs from.
 */
export function systemAudioSources(processes, self = process.pid) {
  const own = processes.find((p) => p.pid === self);
  const ownApp = own ? own.app?.bundleId || own.bundleId || null : null;
  const apps = new Map();
  const tools = [];
  for (const p of processes) {
    if (p.pid === self) continue;
    const appId = p.app?.bundleId || p.bundleId || null;
    if (appId) {
      if (appId === ownApp) continue;
      let app = apps.get(appId);
      if (!app) {
        const label = p.app?.name || p.name || appId;
        app = { appId, label, playing: false, show: false };
        apps.set(appId, app);
      }
      app.playing ||= Boolean(p.playing);
      app.show ||= Boolean(p.playing || p.app?.regular);
    } else if (p.playing) {
      tools.push(
        systemAudioDevice(
          `${SYSTEM_AUDIO_ID}:pid:${p.pid}`,
          p.name || `process ${p.pid}`,
          { pid: p.pid, playing: true },
        ),
      );
    }
  }
  const shown = [...apps.values()]
    .filter((a) => a.show)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((a) =>
      systemAudioDevice(`${SYSTEM_AUDIO_ID}:${a.appId}`, a.label, {
        appId: a.appId,
        playing: a.playing,
      }),
    );
  return [
    systemAudioDevice(SYSTEM_AUDIO_ID, 'System audio', {
      playing: shown.some((s) => s.playing) || tools.length > 0,
    }),
    ...shown,
    ...tools,
  ];
}

/** What a system-audio device id asks the bridge to tap: everything (`{}`),
 *  one application (`{ bundleId }`) or one process (`{ pid }`). */
function tapTarget(deviceId) {
  const rest = deviceId.slice(SYSTEM_AUDIO_ID.length + 1);
  if (!rest) return {};
  if (rest.startsWith('pid:')) return { pid: Number(rest.slice(4)) };
  return { bundleId: rest };
}

/** The capture rung over the bridge, with the parts its verbs allow. */
export class CocoaMediaCapture {
  constructor(app) {
    const native = app._native;
    this.app = app;
    this._native = native;
    this.backend = 'cocoa';
    this._watchers = new Set();
    /** open sources and outputs, by the bridge's id: what an event names */
    this._sources = new Map();
    // A source opening or open holds the process, as a socket does: the
    // bridge's events reach JavaScript through a function that does not, so
    // a script with no window awaiting a camera or a screen's stream exited
    // before the answer came (`_hold`).
    this._keepAlive = null;
    this._outputs = new Map();
    this.features = {};

    const has = (verb) => typeof native[verb] === 'function';
    this.devices = () => this._devices();
    this.watch = (fn) => {
      this._watchers.add(fn);
      return () => this._watchers.delete(fn);
    };
    this._taps = has('openSystemAudio') && has('audioProcesses');
    if (has('openCamera') || has('openMicrophone') || this._taps) {
      this.open = (deviceId, settings, device) =>
        this._open(deviceId, settings, device);
    }
    if (has('openCamera')) {
      this.features.camera = Object.freeze({
        hotplug: true,
        labelsBeforePermission: true,
        nativePreview: true,
      });
    }
    if (has('openMicrophone')) {
      this.features.audioInput = Object.freeze({
        hotplug: true,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        resample: true,
      });
    }
    if (this._taps) {
      this.features.systemAudio = Object.freeze({
        applications: true,
        excludesSelf: true,
        resample: true,
        hotplug: true,
        playing: true,
      });
    }
    if (has('openAudioOutput')) {
      this.openAudioOutput = (options) => new CocoaAudioOutput(this, options);
      this.features.audioOutput = Object.freeze({
        deviceSelection: true,
        echoReference: true,
      });
    }
    const streams = has('openDisplayStream');
    if (streams) this.openDisplay = (request) => this._openDisplay(request);
    if (has('captureScreenshot') || streams) {
      if (has('captureScreenshot')) {
        this.captureScreenshot = (options) => this._screenshot(options);
      }
      if (has('screenCaptureDisplays')) {
        this.displaySources = (options) => this._displaySources(options);
      }
      this._windows = has('screenCaptureWindows');
      this.features.screenCapture = Object.freeze({
        picker: false,
        enumerate: has('screenCaptureDisplays'),
        screens: true,
        // ScreenCaptureKit's stream, where the bridge has it (appkit 0.33)
        streams,
        windows: this._windows,
        cursor: true,
        // a stream's sound is the process taps' (`systemAudio`), which
        // getDisplayMedia pairs it with
        systemAudio: false,
        excludeWindows: has('setWindowSharing'),
        screenshot: has('captureScreenshot'),
        thumbnails: false,
      });
    }
  }

  /** The bridge lists on a queue of its own and answers through a
   *  callback, since its first listing loads AVFoundation's camera plug-ins
   *  (100 ms to over a second); a bridge that answers at once is taken at
   *  its word. */
  _devices() {
    const devices = new Promise((resolve) => {
      const now = this._native.captureDevices((list) => resolve(list));
      if (Array.isArray(now)) resolve(now);
    }).then((list) => (list ?? []).map((d) => this._device(d)));
    if (!this._taps) return devices;
    // the processes take a few milliseconds to describe, and the first
    // listing tens: off the UI thread, like the devices
    const sources = new Promise((resolve) => {
      const now = this._native.audioProcesses((list) => resolve(list));
      if (Array.isArray(now)) resolve(now);
    }).then((list) => systemAudioSources(list ?? []));
    return Promise.all([devices, sources]).then(([a, b]) => [...a, ...b]);
  }

  /** A device as the bridge lists it, in the capture seam's shape. */
  _device(d) {
    const kind = KIND[d.kind];
    const out = {
      deviceId: String(d.id),
      groupId: d.groupId ? String(d.groupId) : '',
      kind,
      label: d.name ?? '',
      isDefault: Boolean(d.isDefault),
      capabilities: {},
      defaults: {},
    };
    if (kind === 'videoinput') {
      const { caps, defaults } = cameraShape(d);
      out.capabilities = caps;
      out.defaults = defaults;
    } else if (kind === 'audioinput') {
      out.capabilities = MICROPHONE_CAPABILITIES;
      out.defaults = MICROPHONE_DEFAULTS;
    }
    return out;
  }

  /** The displays, in points as the bridge has them: through a callback,
   *  which is the one form a worker may use. */
  _displays() {
    return new Promise((resolve) => {
      const now = this._native.screenCaptureDisplays((list) => resolve(list));
      if (Array.isArray(now)) resolve(now);
    }).then((list) => list ?? []);
  }

  _open(deviceId, settings, device) {
    const native = this._native;
    if (device.kind === 'systemaudio') {
      return this._openTap(deviceId, settings, device);
    }
    const video = device.kind === 'videoinput';
    if (video && typeof native.openCamera !== 'function') {
      return Promise.reject(notSupported('a camera'));
    }
    if (!video && typeof native.openMicrophone !== 'function') {
      return Promise.reject(notSupported('a microphone'));
    }
    return new Promise((resolve, reject) => {
      let made;
      try {
        made = video
          ? native.openCamera(deviceId, {
              width: settings.width,
              height: settings.height,
              frameRate: settings.frameRate,
            })
          : native.openMicrophone(deviceId, {
              sampleRate: settings.sampleRate,
              channels: settings.channelCount,
              echoCancellation: settings.echoCancellation,
              noiseSuppression: settings.noiseSuppression,
              autoGainControl: settings.autoGainControl,
            });
      } catch (err) {
        reject(err);
        return;
      }
      const source = video
        ? new CocoaCameraSource(this, made, device, settings)
        : new CocoaMicrophoneSource(this, made, device);
      source._opening = { resolve: () => resolve(source), reject };
      this._add(source);
    });
  }

  /** A tap of other applications' sound, answered by `system-audio-started`
   *  or `system-audio-error`. */
  _openTap(deviceId, settings, device) {
    if (!this._taps) return Promise.reject(notSupported('system audio'));
    return new Promise((resolve, reject) => {
      let made;
      try {
        made = this._native.openSystemAudio({
          ...tapTarget(deviceId),
          sampleRate: settings.sampleRate,
          channels: settings.channelCount,
        });
      } catch (err) {
        reject(err);
        return;
      }
      const source = new CocoaSystemAudioSource(this, made, device);
      source._opening = { resolve: () => resolve(source), reject };
      this._add(source);
    });
  }

  /** The displays as sources, in pixels — a display's own, which is what a
   *  screenshot of it comes back in — where the bridge has them in points. */
  async _displaySources({ types }) {
    const [screens, windows] = await Promise.all([
      types.includes('screen') ? this._displays() : [],
      types.includes('window') && this._windows ? this._windowList() : [],
    ]);
    const out = screens.map((d, i) => {
      const s = d.scale ?? 1;
      return {
        id: `display:${d.id}`,
        kind: 'screen',
        name: d.name || `Display ${i + 1}`,
        primary: i === 0,
        x: Math.round(d.x * s),
        y: Math.round(d.y * s),
        width: Math.round(d.width * s),
        height: Math.round(d.height * s),
      };
    });
    // a window in this app's pixels, as a region of one is read
    const s = this.app.scale ?? 1;
    for (const w of windows) {
      const app = w.app?.name ?? '';
      const title = w.title ?? '';
      out.push({
        id: `window:${w.id}`,
        kind: 'window',
        name: app && title ? `${app} — ${title}` : app || title || 'Window',
        title,
        appId: w.app?.bundleId || undefined,
        pid: w.app?.pid || undefined,
        x: Math.round(w.x * s),
        y: Math.round(w.y * s),
        width: Math.round(w.width * s),
        height: Math.round(w.height * s),
      });
    }
    return out;
  }

  /** The windows a person would share, frontmost first; none where the
   *  bridge was refused the list. */
  _windowList() {
    return new Promise((resolve) => {
      this._native.screenCaptureWindows((list) => resolve(list));
    }).then((list) => (Array.isArray(list) ? list : []));
  }

  /** A display or a window as a stream: the source the stream is, answered
   *  once `display-started` or `display-error` says how the start went. */
  async _openDisplay({ source, video = {} }) {
    const ask = {
      frameRate: numberOf(video.frameRate) ?? 30,
      cursor: video.cursor !== 'never',
    };
    const width = numberOf(video.width);
    const height = numberOf(video.height);
    if (width) ask.width = width;
    if (height) ask.height = height;
    let label = 'Screen';
    let surface = 'monitor';
    if (source != null) {
      const [kind, value] = String(source).split(':');
      if (kind === 'display') ask.display = Number(value);
      else if (kind === 'window') {
        ask.window = Number(value);
        surface = 'window';
      } else {
        throw Object.assign(new Error(`there is no source ${source}`), {
          name: 'NotFoundError',
        });
      }
    }
    if (surface === 'window' && this._windows) {
      const w = (await this._windowList()).find((one) => one.id === ask.window);
      label = w?.title || w?.app?.name || 'Window';
    } else {
      const displays = await this._displays();
      const d =
        ask.display === undefined
          ? displays[0]
          : displays.find((one) => one.id === ask.display);
      label = d?.name || 'Screen';
    }
    const made = this._native.openDisplayStream(ask);
    const stream = await new Promise((resolve, reject) => {
      const s = new CocoaDisplaySource(this, made, { label, surface, ask });
      s._opening = { resolve: () => resolve(s), reject };
      this._add(s);
    });
    return { video: stream };
  }

  /** One picture. `region` is in the source's pixels and the bridge's
   *  `rect` in points, so it is divided by the display's scale — the
   *  window's, for a window. The bridge answers `{ width, height, scale,
   *  data }`, or `{ error, name }`. */
  async _screenshot({ source, region, cursor }) {
    const ask = { cursor: Boolean(cursor) };
    let scale = this.app.scale ?? 1;
    if (source != null) {
      const [kind, value] = String(source).split(':');
      if (kind === 'display') ask.display = Number(value);
      else if (kind === 'window') ask.window = Number(value);
      else {
        throw Object.assign(new Error(`there is no source ${source}`), {
          name: 'NotFoundError',
        });
      }
    }
    if (region) {
      if (ask.window === undefined) {
        const displays = await this._displays();
        const d =
          ask.display === undefined
            ? displays[0]
            : displays.find((one) => one.id === ask.display);
        scale = d?.scale ?? scale;
      }
      ask.rect = {
        x: region.x / scale,
        y: region.y / scale,
        width: region.width / scale,
        height: region.height / scale,
      };
    }
    const answer = await new Promise((resolve) =>
      this._native.captureScreenshot(ask, resolve),
    );
    if (!answer || answer.error) {
      throw Object.assign(new Error(answer?.error ?? 'no picture came back'), {
        name: answer?.name ?? 'NotReadableError',
      });
    }
    return answer;
  }

  _add(source) {
    this._sources.set(source.id, source);
    this._hold();
  }

  _remove(id) {
    this._sources.delete(id);
    this._hold();
  }

  /** A timer that keeps the event loop alive while there is a source, and
   *  none once there is not. */
  _hold() {
    if (this._sources.size > 0 && this._keepAlive === null) {
      this._keepAlive = setInterval(() => {}, 2 ** 30);
    } else if (this._sources.size === 0 && this._keepAlive !== null) {
      clearInterval(this._keepAlive);
      this._keepAlive = null;
    }
  }

  /** Every source stopped and the hold let go: the app is closing
   *  (`CocoaApp.close`). */
  close() {
    for (const source of [...this._sources.values()]) source.stop();
    this._sources.clear();
    this._hold();
  }

  /** A capture event from the bridge (`CocoaApp._route`). */
  _route(ev) {
    switch (ev.type) {
      case 'capture-devices':
      case 'audio-processes':
        for (const fn of [...this._watchers]) fn();
        return;
      case 'audio-output-low':
        return;
      default:
        this._sources.get(ev.id)?._event(ev);
    }
  }
}

/** A constraint as one number: the number itself, or its exact, ideal or
 *  max — what a stream is started at, since a screen is not chosen among
 *  devices by fitness. */
function numberOf(c) {
  if (typeof c === 'number') return Number.isFinite(c) && c > 0 ? c : null;
  if (c && typeof c === 'object') {
    for (const key of ['exact', 'ideal', 'max']) {
      const v = c[key];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    }
  }
  return null;
}

function notSupported(what) {
  return Object.assign(
    new Error(`this @windowkit/appkit cannot open ${what}; a newer one can`),
    { name: 'NotSupportedError' },
  );
}

/** What a camera and a microphone share: the open's answer, the end, the
 *  mute, and the listener. */
class CocoaSource {
  constructor(capture, made, device) {
    this.capture = capture;
    this.id = made.id;
    this.label = device.label;
    this.device = device;
    this.muted = false;
    this._events = null;
    this._opening = null;
    this._stopped = false;
  }

  get _native() {
    return this.capture._native;
  }

  listen(events) {
    this._events = events;
    if (this.muted) events.muted(true);
  }

  capabilities() {
    return this.device.capabilities;
  }

  _event(ev) {
    switch (ev.type) {
      case 'camera-started':
      case 'microphone-started':
      case 'system-audio-started':
      case 'display-started':
        // what the engine did, where it says: voice processing engaged or not
        this._started?.(ev);
        this._opening?.resolve();
        this._opening = null;
        return;
      case 'camera-error':
      case 'microphone-error':
      case 'system-audio-error':
      case 'display-error':
        if (this._opening) {
          this._forget();
          this._opening.reject(
            Object.assign(new Error(ev.message ?? 'it failed'), {
              name: ev.name ?? 'NotReadableError',
            }),
          );
          this._opening = null;
          return;
        }
        this._gone();
        return;
      case 'camera-ended':
      case 'microphone-ended':
      case 'system-audio-ended':
      case 'display-ended':
        this._gone();
        return;
      case 'camera-muted':
      case 'microphone-muted':
      case 'display-muted':
        this.muted = Boolean(ev.muted);
        this._events?.muted(this.muted);
        this._mutedChanged?.();
        return;
      default:
        this._other(ev);
    }
  }

  _other() {}

  _gone() {
    this._forget();
    this._events?.ended();
  }

  _forget() {
    this.capture._remove(this.id);
  }
}

/** A camera's session: its layer, its settings, and its frames on request. */
class CocoaCameraSource extends CocoaSource {
  constructor(capture, made, device, asked) {
    super(capture, made, device);
    this.kind = 'video';
    this.layer = made.layer ?? null;
    this._settings = {
      width: made.width ?? asked.width,
      height: made.height ?? asked.height,
      frameRate: made.frameRate ?? asked.frameRate,
      resizeMode: 'none',
    };
    if (device.defaults?.facingMode) {
      this._settings.facingMode = device.defaults.facingMode;
    }
    this.aspect = {
      format: made.format,
      colorSpace: made.colorSpace,
      range: made.range,
    };
    this._presentations = new Set();
    /** the presentation whose part holds the layer, if one does */
    this._liftedBy = null;
  }

  settings() {
    return {
      ...this._settings,
      aspectRatio: this._settings.width / this._settings.height,
    };
  }

  wantFrames(on) {
    if (this._stopped) return;
    this._native.cameraFrames?.(this.id, Boolean(on));
  }

  /** What a `<video>` shows it through: the layer, lifted, and the frame
   *  `cameraCopyFrame` converts, drawn. Null where the bridge gave no
   *  layer, and the element reads frames off the track instead. */
  present() {
    if (this.layer == null || this._stopped) return null;
    const presentation = new CameraPresentation(this);
    this._presentations.add(presentation);
    return presentation;
  }

  /** The camera's newest frame, converted, into the bitmap `handle`:
   *  `{ width, height, time, written }`, or null when it has none newer than
   *  the last one taken. What a drawn `<video>` and a pane's are shown. */
  copyFrameTo(handle) {
    if (this._stopped || typeof this._native.cameraCopyFrame !== 'function') {
      return null;
    }
    return this._native.cameraCopyFrame(this.id, handle);
  }

  _other(ev) {
    if (ev.type !== 'camera-frame' || !this._events) return;
    this._events.frame({
      format: ev.format,
      width: ev.width,
      height: ev.height,
      planes: ev.planes,
      strides: ev.strides,
      time: ev.time,
      colorSpace: ev.colorSpace ?? 'bt709',
      range: ev.range ?? 'video',
    });
  }

  _mutedChanged() {
    for (const p of this._presentations) p._state();
  }

  _gone() {
    super._gone();
    for (const p of [...this._presentations]) p._state();
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._forget();
    for (const p of [...this._presentations]) p._state();
    this._native.closeCamera(this.id);
  }
}

/**
 * A display or a window as ScreenCaptureKit streams it: a camera in all but
 * the device — a layer the bridge keeps showing the newest frame, its frames
 * BGRA on request, its size and rate changed without stopping
 * (`reconfigure`, which `applyConstraints` asks).
 */
class CocoaDisplaySource extends CocoaSource {
  constructor(capture, made, { label, surface, ask }) {
    super(capture, made, {
      label,
      capabilities: {
        frameRate: { min: 1, max: 120 },
        displaySurface: [surface],
      },
    });
    this.kind = 'video';
    this.layer = made.layer ?? null;
    this._surface = surface;
    this._settings = {
      width: ask.width ?? 0,
      height: ask.height ?? 0,
      frameRate: ask.frameRate,
      displaySurface: surface,
      cursor: ask.cursor ? 'always' : 'never',
      resizeMode: 'crop-and-scale',
    };
    this._presentations = new Set();
    this._liftedBy = null;
    this._configuring = [];
  }

  /** `display-started` says the size the frames come at. */
  _started(ev) {
    this._settings.width = ev.width;
    this._settings.height = ev.height;
    if (typeof ev.frameRate === 'number')
      this._settings.frameRate = ev.frameRate;
  }

  settings() {
    return {
      ...this._settings,
      aspectRatio: this._settings.width / this._settings.height,
    };
  }

  wantFrames(on) {
    if (this._stopped) return;
    this._native.displayStreamFrames?.(this.id, Boolean(on));
  }

  present() {
    if (this.layer == null || this._stopped) return null;
    const presentation = new CameraPresentation(this);
    this._presentations.add(presentation);
    return presentation;
  }

  copyFrameTo(handle) {
    if (
      this._stopped ||
      typeof this._native.displayStreamCopyFrame !== 'function'
    ) {
      return null;
    }
    return this._native.displayStreamCopyFrame(this.id, handle);
  }

  /** Another size or rate, the stream running on; true once the bridge has
   *  done it, false where it refused, and the stream runs as it was. */
  reconfigure({ width, height, frameRate } = {}) {
    if (
      this._stopped ||
      typeof this._native.displayStreamConfigure !== 'function'
    ) {
      return false;
    }
    const ask = {};
    if (width > 0) ask.width = width;
    if (height > 0) ask.height = height;
    if (frameRate > 0) ask.frameRate = frameRate;
    if (Object.keys(ask).length === 0) return true;
    return new Promise((resolve) => {
      this._configuring.push(resolve);
      this._native.displayStreamConfigure(this.id, ask);
    });
  }

  _other(ev) {
    if (ev.type === 'display-configured') {
      if (!ev.error) {
        this._settings.width = ev.width;
        this._settings.height = ev.height;
        this._settings.frameRate = ev.frameRate;
      }
      this._configuring.shift()?.(!ev.error);
      return;
    }
    if (ev.type !== 'display-frame' || !this._events) return;
    this._events.frame({
      format: 'BGRA',
      width: ev.width,
      height: ev.height,
      planes: ev.planes,
      strides: ev.strides,
      time: ev.time,
      colorSpace: 'bt709',
      range: 'full',
    });
  }

  _mutedChanged() {
    for (const p of this._presentations) p._state();
  }

  _gone() {
    super._gone();
    for (const resolve of this._configuring.splice(0)) resolve(false);
    for (const p of [...this._presentations]) p._state();
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._forget();
    for (const resolve of this._configuring.splice(0)) resolve(false);
    for (const p of [...this._presentations]) p._state();
    this._native.closeDisplayStream(this.id);
  }
}

/** A microphone: chunks of planar floats, every one of them. */
class CocoaMicrophoneSource extends CocoaSource {
  constructor(capture, made, device) {
    super(capture, made, device);
    this.kind = 'audio';
    this._settings = {
      sampleRate: made.sampleRate,
      channelCount: made.channels,
      echoCancellation: Boolean(made.echoCancellation),
      noiseSuppression: Boolean(made.noiseSuppression),
      autoGainControl: Boolean(made.autoGainControl),
    };
    if (typeof made.latency === 'number') this._settings.latency = made.latency;
  }

  /** `microphone-started` says what the engine did: the switches as they
   *  came out, and the latency it has. */
  _started(ev) {
    for (const key of [
      'echoCancellation',
      'noiseSuppression',
      'autoGainControl',
    ]) {
      if (typeof ev[key] === 'boolean') this._settings[key] = ev[key];
    }
    if (typeof ev.latency === 'number') this._settings.latency = ev.latency;
  }

  settings() {
    return { ...this._settings };
  }

  _other(ev) {
    if (ev.type !== 'audio-input' || !this._events) return;
    this._events.frame({
      sampleRate: ev.sampleRate,
      channels: ev.channels,
      frames: ev.frames ?? ev.channels[0]?.length ?? 0,
      time: ev.time,
    });
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._forget();
    this._native.closeMicrophone(this.id);
  }
}

/** Other applications' sound: a microphone's chunks from a tap, which has no
 *  canceller, suppressor or gain to switch. */
class CocoaSystemAudioSource extends CocoaMicrophoneSource {
  constructor(capture, made, device) {
    super(capture, made, device);
    this._settings.echoCancellation = false;
    this._settings.noiseSuppression = false;
    this._settings.autoGainControl = false;
  }

  /** `system-audio-started` says the latency the tap's device has. */
  _started(ev) {
    if (typeof ev.latency === 'number') this._settings.latency = ev.latency;
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._forget();
    this._native.closeSystemAudio(this.id);
  }
}

/**
 * A camera — or a screen's stream — as a `<video>` shows it: a player in all
 * but name — a layer the bridge keeps current, a frame to copy where it is
 * drawn — so the element and the sprite presenter need nothing of their own
 * for it. A session has one layer, and a layer one superlayer, so of several
 * `<video>`s showing one source the first lifted holds it and the rest draw
 * (`liftable`).
 */
export class CameraPresentation extends PlayerState {
  constructor(source) {
    super('video');
    this.source = source;
    this.layer = source.layer;
    this.width = source._settings.width;
    this.height = source._settings.height;
    // a live source, as HTML's duration has it
    this.duration = Infinity;
    // told after the element has subscribed, the way a player's first
    // events arrive
    queueMicrotask(() => {
      if (this.released) return;
      this._event({
        type: 'player-metadata',
        width: this.width,
        height: this.height,
        duration: Infinity,
      });
      this._state();
    });
  }

  /** May a part lift the layer: no other presentation's part holds it. */
  get liftable() {
    const holder = this.source._liftedBy;
    return holder === null || holder === this;
  }

  _lifted(on) {
    if (on) this.source._liftedBy = this;
    else if (this.source._liftedBy === this) this.source._liftedBy = null;
  }

  /** Playing while the camera runs and is not muted. */
  _state() {
    const live = !this.source._stopped && !this.source.muted;
    this._event({ type: 'player-state', playing: live, rate: live ? 1 : 0 });
  }

  copyFrame(surface) {
    if (this.released || !surface?._surfaceHandle) return null;
    return this.source.copyFrameTo(surface._surfaceHandle);
  }

  // a camera is not steered from a `<video>`'s ref
  set() {}
  seek() {}

  release() {
    if (this.released) return;
    this.released = true;
    this._listeners.clear();
    this._lifted(false);
    this.source._presentations.delete(this);
  }
}

/** An output on the bridge's audio engine: a queue it pulls from. */
class CocoaAudioOutput {
  constructor(capture, { sampleRate, channels, deviceId }) {
    this.capture = capture;
    const made = capture._native.openAudioOutput({
      sampleRate,
      channels,
      ...(deviceId ? { deviceId } : {}),
    });
    this.id = made.id;
    this._latency = made.latency ?? 0;
    this.closed = false;
    capture._outputs.set(this.id, this);
  }

  write(channels) {
    if (this.closed) return 0;
    return this.capture._native.audioOutputWrite(this.id, channels);
  }

  state() {
    if (this.closed) return { currentTime: 0, queued: 0, latency: 0 };
    const s = this.capture._native.audioOutputState(this.id);
    return {
      currentTime: s?.currentTime ?? 0,
      queued: s?.queued ?? 0,
      latency: s?.latency ?? this._latency,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.capture._outputs.delete(this.id);
    this.capture._native.closeAudioOutput(this.id);
  }
}
