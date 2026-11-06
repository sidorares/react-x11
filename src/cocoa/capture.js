// Media capture on macOS (design/architecture/media-capture.md §5.1): the
// capture rung (src/media/capture.js) over @windowkit/appkit's capture
// verbs — AVFoundation's cameras and microphones, CoreAudio's speakers, an
// audio path that cancels echo against what it plays, and ScreenCaptureKit's
// screenshots. `CocoaApp.mediaCapture` is this object, and its presence is
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
    this._outputs = new Map();
    this.features = {};

    const has = (verb) => typeof native[verb] === 'function';
    this.devices = () => this._devices();
    this.watch = (fn) => {
      this._watchers.add(fn);
      return () => this._watchers.delete(fn);
    };
    if (has('openCamera') || has('openMicrophone')) {
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
    if (has('openAudioOutput')) {
      this.openAudioOutput = (options) => new CocoaAudioOutput(this, options);
      this.features.audioOutput = Object.freeze({
        deviceSelection: true,
        echoReference: true,
      });
    }
    if (has('captureScreenshot')) {
      this.captureScreenshot = (options) => this._screenshot(options);
      if (has('screenCaptureDisplays')) {
        this.displaySources = (options) => this._displaySources(options);
      }
      this.features.screenCapture = Object.freeze({
        picker: false,
        enumerate: has('screenCaptureDisplays'),
        screens: true,
        windows: false,
        cursor: true,
        systemAudio: false,
        excludeWindows: has('setWindowSharing'),
        screenshot: true,
        thumbnails: false,
      });
    }
  }

  _devices() {
    return this._native.captureDevices().map((d) => {
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
    });
  }

  _open(deviceId, settings, device) {
    const native = this._native;
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
      this._sources.set(source.id, source);
    });
  }

  async _displaySources({ types }) {
    if (!types.includes('screen')) return [];
    return this._native.screenCaptureDisplays().map((d, i) => ({
      id: `display:${d.id}`,
      kind: 'screen',
      name: d.name ?? `Display ${i + 1}`,
      primary: i === 0,
      x: d.x,
      y: d.y,
      width: d.width,
      height: d.height,
    }));
  }

  _screenshot({ source, region, cursor }) {
    const ask = { cursor: Boolean(cursor) };
    if (source != null) {
      const [kind, value] = String(source).split(':');
      if (kind === 'display') ask.display = Number(value);
      else if (kind === 'window') ask.window = Number(value);
    }
    if (region) ask.rect = { ...region };
    return new Promise((resolve, reject) => {
      this._native.captureScreenshot(ask, (err, shot) =>
        err ? reject(err) : resolve(shot),
      );
    });
  }

  /** A capture event from the bridge (`CocoaApp._route`). */
  _route(ev) {
    switch (ev.type) {
      case 'capture-devices':
        for (const fn of [...this._watchers]) fn();
        return;
      case 'audio-output-low':
        return;
      default:
        this._sources.get(ev.id)?._event(ev);
    }
  }
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
        this._opening?.resolve();
        this._opening = null;
        return;
      case 'camera-error':
      case 'microphone-error':
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
        this._gone();
        return;
      case 'camera-muted':
      case 'microphone-muted':
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
    this.capture._sources.delete(this.id);
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

/**
 * A camera as a `<video>` shows it: a player in all but name — a layer the
 * bridge keeps current, a frame to copy where it is drawn — so the element
 * and the sprite presenter need nothing of their own for it. A session has
 * one layer, and a layer one superlayer, so of several `<video>`s showing
 * one camera the first lifted holds it and the rest draw (`liftable`).
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
    const source = this.source;
    if (this.released || source._stopped || !surface?._surfaceHandle)
      return null;
    if (typeof source._native.cameraCopyFrame !== 'function') return null;
    return source._native.cameraCopyFrame(source.id, surface._surfaceHandle);
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
