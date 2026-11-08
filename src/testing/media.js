// A platform player for a test: what `<video src>` and `<audio src>` open on
// an app that has none — the mock, the in-process X server — recording what
// it is told and saying what a test makes it say.
//
// It is the same `PlayerState` the Cocoa players are (src/cocoa/player.js),
// so the events a test sends are turned into state, and into an element's
// `onPlay`, `onTimeUpdate` and the rest, by the code a real player's go
// through. Installing it is what makes `useSupports('mediaPlayback')` true:
// the answer is whether the app can make a player (src/mediaplayback.js).

import { PlayerState } from '../cocoa/player.js';

let seq = 0;

/** One player, as `app.createPlayer` made it. */
class FakePlayer extends PlayerState {
  constructor(src, options) {
    super(options.element);
    this.id = `fake-player-${++seq}`;
    this.src = String(src);
    this.options = { ...options };
    /** Each `set` and `seek`, in order: `['set', settings]`, `['seek', s]`. */
    this.calls = [];
  }

  set(settings = {}) {
    if (this.released) return;
    this.calls.push(['set', { ...settings }]);
  }

  seek(seconds) {
    if (this.released || !Number.isFinite(seconds)) return;
    this.currentTime = Math.max(0, seconds);
    this.calls.push(['seek', this.currentTime]);
  }

  copyFrame() {
    return null;
  }

  release() {
    this.released = true;
    this._listeners.clear();
  }

  // --- what a test makes it say ------------------------------------------------

  /** The item is ready: its length, and for a video its size. */
  ready({ duration = 1, width = 0, height = 0 } = {}) {
    this._event({
      type: 'player-metadata',
      id: this.id,
      width,
      height,
      duration,
    });
  }

  /** It starts, or with `false` stops, playing. Not `playing`, which is
   *  the state this sets. */
  state(playing = true) {
    this._event({
      type: 'player-state',
      id: this.id,
      playing,
      rate: playing ? 1 : 0,
    });
  }

  /** It has got to `currentTime` seconds. */
  time(currentTime) {
    this._event({ type: 'player-time', id: this.id, currentTime });
  }

  /** It reached the end of an item that does not loop. */
  end() {
    this._event({ type: 'player-ended', id: this.id });
  }

  /** The item failed. */
  fail(message = 'failed') {
    this._event({ type: 'player-error', id: this.id, message });
  }
}

/**
 * Give `app` a platform player that plays nothing: every player it makes,
 * in order, and the newest. Call it before the first render that asks
 * `useSupports('mediaPlayback')`.
 */
export function fakeMediaPlayers(app) {
  const players = [];
  app.createPlayer = (src, options = {}) => {
    const player = new FakePlayer(src, options);
    players.push(player);
    return player;
  };
  return {
    players,
    get last() {
      return players.at(-1) ?? null;
    },
  };
}

// --- capture: cameras, microphones, speakers and a screen that are not there --
//
// What a browser's fake devices are to its own tests (Chrome's
// `--use-fake-device-for-media-stream`), behind the capture seam
// (src/media/capture.js) as `app.mediaCapture`: a camera drawing colour bars
// with a white band that moves a row a frame and the frame's number in black
// and white squares along the bottom, a microphone playing a 440 Hz tone, a
// speaker, a screen and a window, and other applications' sound — everything,
// and one application playing a 660 Hz tone. Every source makes frames on a timer that
// does not keep the process alive, and on `tick()` for a test that wants
// them one at a time. Installing it is what makes `useDesktopCapability(
// 'camera')` and the rest true, and where the app has no permission service
// it gets one, answering from `setPermission`, so `usePermission('camera')`
// and `getUserMedia` read the same table.
//
// `@react-x11/components`' `<Html>` hands the same generator to a page's
// `navigator.mediaDevices` in its tests.

/** Bars across, a television test card's, in Y, Cb, Cr (BT.601, video
 *  range): white, yellow, cyan, green, magenta, red, blue, black. */
const BARS = [
  [235, 128, 128],
  [210, 16, 146],
  [170, 166, 16],
  [145, 54, 34],
  [106, 202, 222],
  [81, 90, 240],
  [41, 240, 110],
  [16, 128, 128],
];

const CAMERA_CAPABILITIES = Object.freeze({
  width: { min: 1, max: 1920 },
  height: { min: 1, max: 1080 },
  aspectRatio: { min: 1 / 1080, max: 1920 },
  frameRate: { min: 1, max: 60 },
  facingMode: ['user'],
  resizeMode: ['none', 'crop-and-scale'],
});

const MICROPHONE_CAPABILITIES = Object.freeze({
  sampleRate: { min: 8000, max: 48000 },
  sampleSize: { min: 16, max: 16 },
  channelCount: { min: 1, max: 2 },
  latency: { min: 0.01, max: 0.01 },
  echoCancellation: [true, false],
  autoGainControl: [true, false],
  noiseSuppression: [true, false],
});

/** A timer that does not keep the process alive. */
function every(ms, fn) {
  const handle = setInterval(fn, ms);
  handle.unref?.();
  return handle;
}

let fakeSeq = 0;

/** What every fake source shares: its listener, its timer, its end. */
class FakeSource {
  constructor(kind, label, device, settings) {
    this.kind = kind;
    this.label = label;
    this.device = device;
    this.id = `fake-source-${++fakeSeq}`;
    this._settings = { ...settings };
    this._events = null;
    this._timer = null;
    /** whether a reader has asked for frames (`wantFrames`) */
    this.wanted = false;
    this.stopped = false;
    this.ended = false;
    /** frames delivered */
    this.count = 0;
    this._began = performance.now();
  }

  listen(events) {
    this._events = events;
    events.muted(false);
    this._run();
  }

  settings() {
    return { ...this._settings };
  }

  capabilities() {
    return this.device?.capabilities ?? {};
  }

  wantFrames(on) {
    this.wanted = Boolean(on);
    this._run();
  }

  async reconfigure(settings) {
    Object.assign(this._settings, settings);
    this._run();
    return true;
  }

  stop() {
    this.stopped = true;
    this._run();
  }

  // --- what a test makes it do ---------------------------------------------------

  /** One frame (one 10 ms chunk for a microphone) now, wanted or not. */
  tick() {
    if (this.stopped || this.ended || !this._events) return;
    this._frame();
  }

  /** Muted by the system, or with `false` given back: the camera taken by
   *  another app and returned. */
  mute(muted = true) {
    this._events?.muted(muted);
  }

  /** Gone — unplugged, taken back — and every track of it ends. */
  end() {
    if (this.ended) return;
    this.ended = true;
    this._run();
    this._events?.ended();
  }

  _interval() {
    return 1000 / (this._settings.frameRate ?? 30);
  }

  _run() {
    if (this._timer !== null) clearInterval(this._timer);
    this._timer = null;
    if (this.stopped || this.ended || !this._events || !this.wanted) return;
    this._timer = every(this._interval(), () => this._frame());
  }
}

/** Colour bars at the settings' size, I420 (BT.601, video range). */
class FakePatternSource extends FakeSource {
  constructor(label, device, settings) {
    super('video', label, device, settings);
    this._still = null;
    this._planes = null;
  }

  _size() {
    return {
      width: Math.max(1, Math.round(this._settings.width ?? 640)),
      height: Math.max(1, Math.round(this._settings.height ?? 480)),
    };
  }

  settings() {
    return { ...this._settings, ...this._size() };
  }

  _background(width, height) {
    const cw = (width + 1) >> 1;
    const ch = (height + 1) >> 1;
    const y = new Uint8Array(width * height);
    const cb = new Uint8Array(cw * ch);
    const cr = new Uint8Array(cw * ch);
    const barOf = (x) =>
      BARS[Math.min(BARS.length - 1, Math.floor((x * BARS.length) / width))];
    for (let x = 0; x < width; x++) y[x] = barOf(x)[0];
    for (let row = 1; row < height; row++) y.copyWithin(row * width, 0, width);
    for (let x = 0; x < cw; x++) {
      cb[x] = barOf(x * 2)[1];
      cr[x] = barOf(x * 2)[2];
    }
    for (let row = 1; row < ch; row++) {
      cb.copyWithin(row * cw, 0, cw);
      cr.copyWithin(row * cw, 0, cw);
    }
    return [y, cb, cr];
  }

  _frame() {
    const { width, height } = this._size();
    if (!this._still || this._still[0].length !== width * height) {
      this._still = this._background(width, height);
      this._planes = this._still.map((p) => new Uint8Array(p.length));
    }
    const [y, cb, cr] = this._planes;
    y.set(this._still[0]);
    cb.set(this._still[1]);
    cr.set(this._still[2]);
    const count = this.count;
    const band = Math.max(1, height >> 5);
    const top = (count * 2) % height;
    for (let row = top; row < Math.min(height, top + band); row++) {
      y.fill(235, row * width, (row + 1) * width);
    }
    // the frame's number, 16 bits along the bottom
    const cell = Math.max(1, Math.floor(width / 16));
    const strip = Math.min(height, cell);
    for (let bit = 0; bit < 16 && (bit + 1) * cell <= width; bit++) {
      const on = (count >> (15 - bit)) & 1 ? 235 : 16;
      for (let row = height - strip; row < height; row++) {
        y.fill(on, row * width + bit * cell, row * width + (bit + 1) * cell);
      }
    }
    this.count += 1;
    const cw = (width + 1) >> 1;
    this._events.frame({
      format: 'I420',
      width,
      height,
      planes: this._planes,
      strides: [width, cw, cw],
      time: (performance.now() - this._began) / 1000,
      colorSpace: 'bt601',
      range: 'video',
    });
  }
}

/** A tone at a tenth of full scale, in 10 ms chunks: 440 Hz by default, and
 *  silence at `amplitude: 0`. */
class FakeToneSource extends FakeSource {
  constructor(
    label,
    device,
    settings,
    { frequency = 440, amplitude = 0.1 } = {},
  ) {
    super('audio', label, device, settings);
    this.frequency = frequency;
    this.amplitude = amplitude;
  }

  _interval() {
    return 10;
  }

  _frame() {
    const rate = this._settings.sampleRate ?? 48000;
    const frames = Math.round(rate / 100);
    const channels = [];
    for (let c = 0; c < (this._settings.channelCount ?? 1); c++) {
      channels.push(new Float32Array(frames));
    }
    const first = this.count * frames;
    for (let i = 0; i < frames; i++) {
      const sample =
        this.amplitude *
        Math.sin((2 * Math.PI * this.frequency * (first + i)) / rate);
      for (const channel of channels) channel[i] = sample;
    }
    this.count += 1;
    this._events.frame({
      sampleRate: rate,
      channels,
      frames,
      time: first / rate,
    });
  }
}

/** A speaker that plays nothing: what was pushed, and a clock the test
 *  moves with `advance`. */
class FakeAudioOutput {
  constructor(options) {
    this.sampleRate = options.sampleRate;
    this.channels = options.channels;
    this.deviceId = options.deviceId;
    /** every push, copied: `Float32Array[]` a channel */
    this.pushed = [];
    this.closed = false;
    this.latency = 0.02;
    this._queued = 0;
    this._played = 0;
  }

  write(channels) {
    if (this.closed) return 0;
    this.pushed.push(channels.map((c) => Float32Array.from(c)));
    this._queued += channels[0].length;
    return this._queued;
  }

  state() {
    return {
      currentTime: this._played / this.sampleRate,
      queued: this._queued,
      latency: this.latency,
    };
  }

  close() {
    this.closed = true;
    this._queued = 0;
  }

  // --- what a test makes it do ---------------------------------------------------

  /** The device plays `seconds` of what is queued, and silence past it. */
  advance(seconds) {
    const frames = Math.round(seconds * this.sampleRate);
    this._played += frames;
    this._queued = Math.max(0, this._queued - frames);
  }

  /** Every sample pushed to `channel`, in order, as one array. */
  samples(channel = 0) {
    const n = this.pushed.reduce((sum, p) => sum + p[channel].length, 0);
    const out = new Float32Array(n);
    let at = 0;
    for (const p of this.pushed) {
      out.set(p[channel], at);
      at += p[channel].length;
    }
    return out;
  }
}

const fakeCamera = (n = 1) => ({
  deviceId: n === 1 ? 'fake-camera' : `fake-camera-${n}`,
  groupId: n === 1 ? 'fake-camera' : `fake-camera-${n}`,
  kind: 'videoinput',
  label: n === 1 ? 'Fake camera' : `Fake camera ${n}`,
  isDefault: n === 1,
  capabilities: CAMERA_CAPABILITIES,
  defaults: {
    width: 640,
    height: 480,
    aspectRatio: 640 / 480,
    frameRate: 30,
    facingMode: 'user',
    resizeMode: 'none',
  },
});

const fakeMicrophone = (n = 1) => ({
  deviceId: n === 1 ? 'fake-microphone' : `fake-microphone-${n}`,
  groupId: 'fake-microphone',
  kind: 'audioinput',
  label: n === 1 ? 'Fake microphone' : `Fake microphone ${n}`,
  isDefault: n === 1,
  capabilities: MICROPHONE_CAPABILITIES,
  defaults: {
    sampleRate: 48000,
    sampleSize: 16,
    channelCount: 1,
    latency: 0.01,
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: true,
  },
});

const SYSTEM_AUDIO_CAPABILITIES = Object.freeze({
  sampleRate: { min: 8000, max: 48000 },
  channelCount: { min: 1, max: 2 },
  echoCancellation: [false],
  autoGainControl: [false],
  noiseSuppression: [false],
});

const SYSTEM_AUDIO_DEFAULTS = Object.freeze({
  sampleRate: 48000,
  channelCount: 2,
  echoCancellation: false,
  autoGainControl: false,
  noiseSuppression: false,
});

/** Other applications' sound: every one of them, and one fake player. */
const fakeSystemAudio = () => [
  {
    deviceId: 'system-audio',
    groupId: '',
    kind: 'systemaudio',
    label: 'System audio',
    isDefault: true,
    playing: true,
    capabilities: SYSTEM_AUDIO_CAPABILITIES,
    defaults: SYSTEM_AUDIO_DEFAULTS,
  },
  {
    deviceId: 'system-audio:com.example.player',
    groupId: '',
    kind: 'systemaudio',
    label: 'Fake player',
    appId: 'com.example.player',
    isDefault: false,
    playing: true,
    capabilities: SYSTEM_AUDIO_CAPABILITIES,
    defaults: SYSTEM_AUDIO_DEFAULTS,
  },
];

const fakeSpeaker = () => ({
  deviceId: 'fake-speaker',
  groupId: 'fake-microphone',
  kind: 'audiooutput',
  label: 'Fake speaker',
  isDefault: true,
  capabilities: {},
  defaults: {},
});

const SCREEN = Object.freeze({ width: 1280, height: 720 });

/** A straight-RGBA picture of `width` x `height`: a horizontal ramp of red
 *  over a vertical one of green, so any region of it says where it came from. */
function rampRGBA(width, height, x0 = 0, y0 = 0) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = ((x0 + x) * 255) / (SCREEN.width - 1);
      data[i + 1] = ((y0 + y) * 255) / (SCREEN.height - 1);
      data[i + 2] = 64;
      data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * Give `app` cameras, microphones, a speaker, a screen and other
 * applications' sound that are not there — `app.mediaCapture` — and, where
 * it has none, a permission service answering from a table. Call it before
 * the first render that asks for them.
 *
 * Options: `cameras` and `microphones` (how many, default 1), `speaker`
 * (default true), `screen` (default true), `systemAudio` (default true:
 * `system-audio` and `system-audio:com.example.player`, playing 660 Hz; an
 * application asked for by id that is not listed opens as silence),
 * `permission` — what camera, microphone, screen recording and system audio
 * recording answer until `setPermission` changes it (default `'granted'`) —
 * and `promptAnswer`, what a request answers a `'prompt'` with (default
 * `'granted'`).
 */
export function fakeMediaDevices(app, options = {}) {
  const devices = [];
  for (let i = 1; i <= (options.cameras ?? 1); i++) devices.push(fakeCamera(i));
  for (let i = 1; i <= (options.microphones ?? 1); i++) {
    devices.push(fakeMicrophone(i));
  }
  if (options.speaker ?? true) devices.push(fakeSpeaker());
  const systemAudio = options.systemAudio ?? true;
  if (systemAudio) devices.push(...fakeSystemAudio());
  const screen = options.screen ?? true;
  const watchers = new Set();
  const sources = [];
  const outputs = [];
  const screenshots = [];
  const permissions = {
    camera: options.permission ?? 'granted',
    microphone: options.permission ?? 'granted',
    'screen-recording': options.permission ?? 'granted',
    'system-audio-recording': options.permission ?? 'granted',
  };
  const requests = [];
  const changed = () => {
    for (const fn of [...watchers]) fn();
  };

  const fake = {
    backend: 'fake',
    features: {
      camera: Object.freeze({
        hotplug: true,
        labelsBeforePermission: true,
        nativePreview: false,
      }),
      audioInput: Object.freeze({
        hotplug: true,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        resample: true,
      }),
      audioOutput: Object.freeze({
        deviceSelection: true,
        echoReference: true,
      }),
      ...(systemAudio
        ? {
            systemAudio: Object.freeze({
              applications: true,
              excludesSelf: true,
              resample: true,
              hotplug: true,
              playing: true,
            }),
          }
        : {}),
      ...(screen
        ? {
            screenCapture: Object.freeze({
              picker: true,
              enumerate: true,
              screens: true,
              streams: true,
              windows: true,
              cursor: false,
              systemAudio: false,
              excludeWindows: false,
              screenshot: true,
              thumbnails: false,
            }),
          }
        : {}),
    },
    devices: () => devices.map((d) => ({ ...d })),
    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    async open(deviceId, settings, asked) {
      let device = devices.find((d) => d.deviceId === deviceId);
      // an application that is not running is tapped all the same: silence
      // until it plays
      const waiting =
        !device &&
        systemAudio &&
        asked?.kind === 'systemaudio' &&
        deviceId.startsWith('system-audio:');
      if (waiting) device = asked;
      if (!device || device.kind === 'audiooutput') {
        throw Object.assign(new Error(`there is no ${deviceId}`), {
          name: 'NotFoundError',
        });
      }
      if (fake.failNextOpen) {
        const err = fake.failNextOpen;
        fake.failNextOpen = null;
        throw err;
      }
      const source =
        device.kind === 'videoinput'
          ? new FakePatternSource(device.label, device, settings)
          : device.kind === 'systemaudio'
            ? new FakeToneSource(device.label, device, settings, {
                frequency: 660,
                amplitude: waiting ? 0 : 0.1,
              })
            : new FakeToneSource(device.label, device, settings);
      sources.push(source);
      return source;
    },
    openAudioOutput(opts) {
      const output = new FakeAudioOutput(opts);
      outputs.push(output);
      return output;
    },

    // --- what a test reads ----------------------------------------------------------

    /** Every source opened, in order. */
    sources,
    /** Every audio output opened, in order. */
    outputs,
    /** Every screenshot asked for: `{ source, region }`. */
    screenshots,
    /** Every permission request: the kind asked. */
    requests,
    /** The newest source of a kind (`'video'` or `'audio'`), or null. */
    last(kind) {
      return (
        sources.filter((s) => kind == null || s.kind === kind).at(-1) ?? null
      );
    },
    /** Sources of `deviceId` that are still running. */
    live(deviceId) {
      return sources.filter(
        (s) =>
          !s.stopped &&
          !s.ended &&
          (deviceId == null || s.device?.deviceId === deviceId),
      );
    },
    /** An `Error` with a `name` the next `open` rejects with — say
     *  `{ name: 'NotReadableError' }`, a camera in use elsewhere. */
    failNextOpen: null,
    /** What the picker answers: a source id, or null for a user who chose
     *  nothing. Default the screen. */
    pickerAnswer: 'fake-screen',

    // --- what a test makes it do -------------------------------------------------------

    /** A device plugged in: listed, and watchers told. */
    plug(device) {
      const defaults = {
        videoinput: [CAMERA_CAPABILITIES, fakeCamera().defaults],
        systemaudio: [SYSTEM_AUDIO_CAPABILITIES, SYSTEM_AUDIO_DEFAULTS],
      }[device.kind] ?? [{}, {}];
      devices.push({
        isDefault: false,
        groupId: device.deviceId,
        capabilities: defaults[0],
        defaults: defaults[1],
        label: device.deviceId,
        ...device,
      });
      changed();
    },
    /** A listed application starts or stops making a sound: `playing` in the
     *  list, and watchers told. */
    setPlaying(deviceId, playing = true) {
      const device = devices.find((d) => d.deviceId === deviceId);
      if (!device) return;
      device.playing = Boolean(playing);
      changed();
    },
    /** A device unplugged: gone from the list, and every source of it ends. */
    unplug(deviceId) {
      const at = devices.findIndex((d) => d.deviceId === deviceId);
      if (at !== -1) devices.splice(at, 1);
      for (const s of fake.live(deviceId)) s.end();
      changed();
    },
    /** What a kind answers from now on: `'granted'`, `'denied'`,
     *  `'restricted'` or `'prompt'`. */
    setPermission(kind, status) {
      permissions[kind] = status;
    },
  };

  if (screen) {
    const screenSource = {
      id: 'fake-screen',
      kind: 'screen',
      name: 'Fake screen',
      primary: true,
      x: 0,
      y: 0,
      ...SCREEN,
    };
    const windowSource = {
      id: 'fake-window',
      kind: 'window',
      name: 'Fake window',
      x: 100,
      y: 80,
      width: 640,
      height: 400,
    };
    const all = [screenSource, windowSource];
    fake.displaySources = async ({ types }) =>
      all.filter((s) => types.includes(s.kind)).map((s) => ({ ...s }));
    fake.openDisplay = async ({ source, video }) => {
      const id = source ?? fake.pickerAnswer;
      if (id == null) return null;
      const found = all.find((s) => s.id === id);
      if (!found) {
        throw Object.assign(new Error(`there is no source ${id}`), {
          name: 'NotFoundError',
        });
      }
      const opened = new FakePatternSource(found.name, null, {
        width: found.width,
        height: found.height,
        frameRate: video.frameRate ?? 30,
        displaySurface: found.kind === 'screen' ? 'monitor' : 'window',
      });
      sources.push(opened);
      return { video: opened };
    };
    fake.captureScreenshot = async ({ source, region }) => {
      screenshots.push({ source, region });
      const found = all.find((s) => s.id === (source ?? 'fake-screen'));
      if (!found) {
        throw Object.assign(new Error(`there is no source ${source}`), {
          name: 'NotFoundError',
        });
      }
      const r = region ?? {
        x: 0,
        y: 0,
        width: found.width,
        height: found.height,
      };
      return {
        width: r.width,
        height: r.height,
        data: rampRGBA(r.width, r.height, found.x + r.x, found.y + r.y),
      };
    };
  }

  app.mediaCapture = fake;
  if (!app.permissions) {
    app.permissions = {
      status: (kind) => permissions[kind] ?? 'unknown',
      async request(kind) {
        requests.push(kind);
        if (permissions[kind] === 'prompt') {
          permissions[kind] = options.promptAnswer ?? 'granted';
        }
        return permissions[kind] ?? 'unknown';
      },
      openSettings: () => true,
    };
  }
  return fake;
}
