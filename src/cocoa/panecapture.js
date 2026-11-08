// Media capture in a `<Frame>` pane on macOS (design/architecture/
// media-capture.md §0.3). Two things a pane cannot have of its own. Its
// window is a buffer the host composites, so it has no layer tree for a
// camera's preview layer to live in. And the audio is not a pane's: echo
// cancellation subtracts what the one engine plays, so an output a pane made
// on an engine of its own would be heard by the host's microphone and never
// cancelled — nor would the host's by the pane's. So a pane's capture rung
// is the host's, as its players are (src/cocoa/paneplayer.js).
//
// `PaneMediaCapture` is what a pane's `app.mediaCapture` is: the rung shape
// src/media/capture.js asks of any backend, its verbs sent up the frame
// channel as `pane-capture` messages. The host answers each from its own
// rung (`HostedCapture`, made by src/cocoa/panehost.js) — through the same
// shared sources its own tracks run over (`acquireSource`), so a camera the
// host and two panes show is one session — and sends the rest back down:
// the sources' news, their frames, and the outputs' clocks.
//
// What crosses, and how:
//
//   - **A camera's picture goes by shared buffer.** A pane's `<video
//     srcObject>` is shown the way a pane's `<video src>` is
//     (src/cocoa/paneplayer.js): the host copies the camera's newest frame
//     into a ring of shared IOSurfaces (`copyFrameTo`, src/cocoa/panering.js)
//     and names the buffer, and the pane copies it out when the element
//     draws. No pixel crosses into JavaScript on either side.
//   - **Frames a reader asks for go by message.** `track.onFrame` in a pane
//     — an encoder's — is handed the planes the host's track was, cloned
//     down the channel (the fork's `serialization: 'advanced'`). A camera's
//     is the newest only, as on the host: no more than `IN_FLIGHT` frames
//     are on their way to a pane that has not answered (`seen`), and a pane
//     slower than the camera sees fewer frames, never older ones. A
//     microphone's chunks all go, since audio skipped is a click.
//   - **An output's queue is the host's, and its clock is estimated here.**
//     `AudioFrames` reads `queued` and `currentTime` synchronously, and a
//     round trip per read is not a clock. So the host says what its output's
//     state is after every write and every `CLOCK_MS`, and the pane runs the
//     clock on from there (`PaneAudioOutput.state`).
//   - **Permission stays the pane's own.** macOS answers for the process
//     responsible for a pane — its host's app, which forked it — so the
//     pane's `app.permissions` reads what the host's would, and its prompt
//     names the same app.

import {
  acquireSource,
  deviceTrack,
  MediaStreamTrack,
  soleSource,
} from '../media/stream.js';
import { OverconstrainedError } from '../media/errors.js';
import { canReadRing, HostRing, PaneRing } from './panering.js';
import { PlayerState } from './player.js';

/** The rung's verbs a host may offer a pane, each proxied when it does. */
const VERBS = [
  'devices',
  'watch',
  'open',
  'openAudioOutput',
  'captureScreenshot',
  'displaySources',
  'openDisplay',
];

// How often the host copies a camera's newest frame for a pane that shows
// it: the drawn `<video>`'s own cadence. A copy answers null for a frame
// that has not changed, so asking every display frame costs a call, and
// sends nothing.
const PULL_MS = 16;

// How many of a camera's frames may be on their way to a pane that has not
// answered for them: two, so the next is in the channel while the pane reads
// one, and a reader slower than the camera holds the host back from sending
// frames it would read late.
const IN_FLIGHT = 2;

// How often the host says where an output is when the pane writes nothing:
// enough to keep a clock the pane runs on from honest across a gap in the
// writes.
const CLOCK_MS = 100;

const DOM_NAMES = new Set([
  'NotAllowedError',
  'NotFoundError',
  'NotReadableError',
  'NotSupportedError',
  'AbortError',
]);

/** An error, as it crosses: its name, its message, its constraint. */
function wireError(err) {
  return {
    name: typeof err?.name === 'string' ? err.name : 'Error',
    message: err?.message ?? String(err),
    ...(typeof err?.constraint === 'string' && { constraint: err.constraint }),
  };
}

/** An error that crossed, as the exception it was on the host — whose
 *  message already says what failed, so nothing here says it again. */
function errorFromHost({ name, message, constraint }) {
  if (name === 'OverconstrainedError') {
    return new OverconstrainedError(
      constraint ?? '',
      String(message).replace(/^react-x11: /, ''),
    );
  }
  if (DOM_NAMES.has(name)) return new DOMException(message, name);
  return Object.assign(new Error(message), { name });
}

/** A typed array that owns its bytes: a view into a larger buffer clones
 *  the whole buffer. */
const tight = (view) =>
  ArrayBuffer.isView(view) &&
  (view.byteOffset !== 0 || view.byteLength !== view.buffer.byteLength)
    ? view.slice()
    : view;

/** What a host offers a pane in the hello: which verbs, and the features
 *  its rung reports — a camera's preview is no layer in a pane, which has
 *  none to lift it onto, but a copy out of a shared buffer. */
export function paneCaptureOffer(capture) {
  const features = {};
  for (const [name, value] of Object.entries(capture.features ?? {})) {
    features[name] = { ...value };
  }
  if (features.camera) features.camera.nativePreview = false;
  return {
    backend: capture.backend ?? 'unknown',
    features,
    verbs: VERBS.filter((verb) => typeof capture[verb] === 'function'),
  };
}

let ids = 0;

// --- the pane's end ------------------------------------------------------------------

/** A pane's capture rung: the host's, over the frame channel. */
export class PaneMediaCapture {
  constructor(app, offer) {
    this.app = app;
    this._native = app._native;
    this.backend = offer.backend;
    this.features = {};
    for (const [name, value] of Object.entries(offer.features ?? {})) {
      this.features[name] = Object.freeze({ ...value });
    }
    /** requests the host has not answered, by number */
    this._pending = new Map();
    this._watchers = new Set();
    this._sources = new Map();
    this._outputs = new Map();
    const verbs = new Set(offer.verbs ?? []);
    if (verbs.has('devices')) this.devices = () => this._ask('devices');
    if (verbs.has('watch')) this.watch = (fn) => this._watch(fn);
    if (verbs.has('open')) {
      this.open = (deviceId, settings, device) =>
        this._open('open', { deviceId, settings, device });
    }
    if (verbs.has('openAudioOutput')) {
      this.openAudioOutput = (options) => new PaneAudioOutput(this, options);
    }
    if (verbs.has('captureScreenshot')) {
      this.captureScreenshot = (options) =>
        this._ask('screenshot', { options });
    }
    if (verbs.has('displaySources')) {
      this.displaySources = (options) =>
        this._ask('displaySources', { options });
    }
    if (verbs.has('openDisplay')) {
      this.openDisplay = (request) => this._openDisplay(request);
    }
  }

  // held until the host is listening, as the pane's windows are
  // (`CocoaApp._postWindow`): a `getUserMedia` in the pane's first commit
  // asks before the host has a pane host to answer
  _post(msg) {
    this.app._postWindow({ type: 'pane-capture', ...msg });
  }

  /** A request, answered by the host's `pane-capture-answer`. */
  _ask(op, fields = {}) {
    const req = ++ids;
    return new Promise((resolve, reject) => {
      this._pending.set(req, { resolve, reject });
      this._post({ op, req, ...fields });
    });
  }

  _watch(fn) {
    this._watchers.add(fn);
    if (this._watchers.size === 1) this._post({ op: 'watch', on: true });
    return () => {
      if (!this._watchers.delete(fn)) return;
      if (this._watchers.size === 0) this._post({ op: 'watch', on: false });
    };
  }

  async _open(op, fields) {
    const source = `pane-source-${++ids}`;
    const described = await this._ask(op, { source, ...fields });
    return this._made(source, described);
  }

  async _openDisplay(request) {
    const source = `pane-source-${++ids}`;
    const audio = `pane-source-${++ids}`;
    const described = await this._ask('openDisplay', {
      source,
      audio,
      request,
    });
    return {
      video: described.video ? this._made(source, described.video) : null,
      audio: described.audio ? this._made(audio, described.audio) : null,
    };
  }

  _made(id, described) {
    const source = new PaneSource(this, id, described);
    this._sources.set(id, source);
    return source;
  }

  /** A message from the host's end (`CocoaApp.attachPaneChannel`). */
  _fromHost(msg) {
    switch (msg.type) {
      case 'pane-capture-answer': {
        const pending = this._pending.get(msg.req);
        if (!pending) return;
        this._pending.delete(msg.req);
        if (msg.error) pending.reject(errorFromHost(msg.error));
        else pending.resolve(msg.value);
        return;
      }
      case 'pane-capture-devices':
        for (const fn of [...this._watchers]) fn();
        return;
      case 'pane-capture-output':
        this._outputs.get(msg.output)?._mirrored(msg);
        return;
      default:
        this._sources.get(msg.source)?._fromHost(msg);
    }
  }
}

/**
 * A source the host opened for this pane. Its news is what the host's
 * track over it hears; its frames come when the pane's readers want them;
 * its picture, for a camera, comes through a shared ring.
 */
class PaneSource {
  constructor(capture, id, described) {
    this.capture = capture;
    this.id = id;
    this.kind = described.kind;
    this.label = described.label ?? '';
    this.muted = Boolean(described.muted);
    this._settings = described.settings ?? {};
    this._capabilities = described.capabilities ?? null;
    this._picture = Boolean(described.picture);
    this._events = null;
    this._stopped = false;
    /** the `<video>`s showing it, and the frame the host named last */
    this._presentations = new Set();
    this._shown = null;
    this._shownNo = 0;
    this._ring = null;
  }

  listen(events) {
    this._events = events;
    if (this.muted) events.muted(true);
  }

  settings() {
    return { ...this._settings };
  }

  capabilities() {
    return this._capabilities ?? undefined;
  }

  wantFrames(on) {
    if (this._stopped) return;
    this.capture._post({ op: 'want', source: this.id, on: Boolean(on) });
  }

  reconfigure(settings) {
    if (this._stopped) return false;
    return this.capture._ask('reconfigure', { source: this.id, settings });
  }

  /** What a `<video>` shows it through: a copy of the host's frame, where
   *  the host can copy one and this bridge can read it; otherwise null, and
   *  the element reads frames off the track. */
  present() {
    if (!this._picture || this._stopped) return null;
    if (!canReadRing(this.capture._native)) return null;
    const presentation = new PaneCapturePresentation(this);
    this._presentations.add(presentation);
    if (this._presentations.size === 1) {
      this._ring = new PaneRing(this.capture._native, {
        onDrop: () => {
          this._shown = null;
        },
      });
      this.capture._post({ op: 'present', source: this.id, on: true });
    }
    return presentation;
  }

  _unpresent(presentation) {
    if (!this._presentations.delete(presentation)) return;
    if (this._presentations.size !== 0) return;
    this._ring?.drop();
    this._ring = null;
    if (!this._stopped) {
      this.capture._post({ op: 'present', source: this.id, on: false });
    }
  }

  _fromHost(msg) {
    switch (msg.type) {
      case 'pane-capture-frame':
        if (this._events) this._events.frame(msg.frame);
        // read, by whoever reads it: the host may send the next
        if (msg.seq != null && !this._stopped) {
          this.capture._post({ op: 'seen', source: this.id, seq: msg.seq });
        }
        return;
      case 'pane-capture-picture':
        this._pictureFrom(msg);
        return;
      case 'pane-capture-state':
        if (msg.settings) this._settings = msg.settings;
        if (msg.ended) {
          this._gone();
          return;
        }
        if (Boolean(msg.muted) !== this.muted) {
          this.muted = Boolean(msg.muted);
          this._events?.muted(this.muted);
          for (const p of this._presentations) p._state();
        }
        return;
      default:
    }
  }

  /** The host named a buffer with the camera's newest frame in it. */
  _pictureFrom({ surface, width, height, time, seq }) {
    const ring = this._ring;
    const handle = ring?.lookUp(surface, width, height) ?? null;
    // this frame's lookup is done, whatever it found: the host may free the
    // buffer, which it kept for it (`HostRing._freeRing`)
    if (seq != null && !this._stopped) {
      this.capture._post({ op: 'seen-picture', source: this.id, seq });
    }
    if (!handle) return;
    this._shown = { handle, width, height, time };
    this._shownNo += 1;
    // a camera that delivers at another size than it said: the element's
    // surface is remade at this one, as a player's is on its metadata
    for (const p of this._presentations) p._sized(width, height);
  }

  _gone() {
    if (this._stopped) return;
    this._forget();
    this._events?.ended();
  }

  _forget() {
    this._stopped = true;
    this.capture._sources.delete(this.id);
    for (const p of [...this._presentations]) p._state();
    this._ring?.drop();
    this._ring = null;
  }

  stop() {
    if (this._stopped) return;
    this._forget();
    this.capture._post({ op: 'close', source: this.id });
  }
}

/**
 * A camera as a pane's `<video>` shows it: a player in all but name, like
 * the host's `CameraPresentation`, with no layer — a pane has nothing to
 * lift one onto — and a frame copied out of the host's ring.
 */
class PaneCapturePresentation extends PlayerState {
  constructor(source) {
    super('video');
    this.source = source;
    this.layer = null;
    this.width = source._settings.width ?? 0;
    this.height = source._settings.height ?? 0;
    this.duration = Infinity;
    this._copiedNo = 0;
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

  _state() {
    const live = !this.source._stopped && !this.source.muted;
    this._event({ type: 'player-state', playing: live, rate: live ? 1 : 0 });
  }

  _sized(width, height) {
    if (this.released || (width === this.width && height === this.height)) {
      return;
    }
    this.width = width;
    this.height = height;
    this._event({ type: 'player-metadata', width, height, duration: Infinity });
  }

  /** As `CameraPresentation.copyFrame`: the newest frame into `surface`, or
   *  null when the host has named none since this one's last copy. */
  copyFrame(surface) {
    const source = this.source;
    const shown = source._shown;
    if (this.released || source._stopped || !surface?._surfaceHandle) {
      return null;
    }
    if (!shown || this._copiedNo === source._shownNo) return null;
    const { width, height, time } = shown;
    const fits = surface.width === width && surface.height === height;
    if (fits) {
      source._ring.copy(shown.handle, width, height, surface._surfaceHandle);
      this._copiedNo = source._shownNo;
    }
    return { width, height, time, written: fits };
  }

  // a camera is not steered from a `<video>`'s ref
  set() {}
  seek() {}

  release() {
    if (this.released) return;
    this.released = true;
    this._listeners.clear();
    this.source._unpresent(this);
  }
}

/**
 * An output on the host's engine. What is written goes up; the clock is the
 * host's last word on it, run on by the time since — played out of what the
 * host had queued then, and nothing of what it had not been handed yet.
 */
class PaneAudioOutput {
  constructor(capture, { sampleRate, channels, deviceId }) {
    this.capture = capture;
    this.id = `pane-output-${++ids}`;
    this.sampleRate = sampleRate;
    this.closed = false;
    /** frames written here, and the host's last word: its state, and how
     *  many of those frames it had taken when it said */
    this._sent = 0;
    this._mirror = {
      currentTime: 0,
      queued: 0,
      latency: 0,
      received: 0,
      at: performance.now(),
    };
    capture._outputs.set(this.id, this);
    capture._post({
      op: 'output-open',
      output: this.id,
      sampleRate,
      channels,
      deviceId: deviceId ?? null,
    });
  }

  write(channels) {
    if (this.closed) return 0;
    const frames = channels[0]?.length ?? 0;
    this._sent += frames;
    this.capture._post({
      op: 'output-write',
      output: this.id,
      channels: channels.map(tight),
    });
    return frames;
  }

  state() {
    if (this.closed) return { currentTime: 0, queued: 0, latency: 0 };
    const m = this._mirror;
    const elapsed = Math.max(0, (performance.now() - m.at) / 1000);
    const played = Math.min(elapsed, m.queued / this.sampleRate);
    return {
      currentTime: m.currentTime + played,
      queued:
        Math.max(0, m.queued - played * this.sampleRate) +
        Math.max(0, this._sent - m.received),
      latency: m.latency,
    };
  }

  /** The host's word on where its output is. */
  _mirrored({ currentTime, queued, latency, received }) {
    this._mirror = {
      currentTime: currentTime ?? 0,
      queued: queued ?? 0,
      latency: latency ?? 0,
      received: received ?? 0,
      at: performance.now(),
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.capture._outputs.delete(this.id);
    this.capture._post({ op: 'output-close', output: this.id });
  }
}

// --- the host's end ------------------------------------------------------------------

/**
 * One pane's capture, done on the host's rung: its sources as host tracks,
 * their frames and pictures sent down, its outputs played here. Released
 * with the pane host, which stops every track the pane left running.
 */
export class HostedCapture {
  /** `app` is the host's, whose `mediaCapture` does the work; `send` is the
   *  pane's channel. */
  constructor(app, send) {
    this.capture = app.mediaCapture;
    this._native = app._native ?? null;
    this._send = send;
    this.released = false;
    this._sources = new Map();
    this._outputs = new Map();
    this._unwatch = null;
  }

  /** A `pane-capture` message from the pane. */
  handle(msg) {
    if (this.released) return;
    const capture = this.capture;
    switch (msg.op) {
      case 'devices':
        return this._answer(msg.req, () => capture.devices());
      case 'displaySources':
        return this._answer(msg.req, () => capture.displaySources(msg.options));
      case 'screenshot':
        return this._answer(msg.req, () =>
          capture.captureScreenshot(msg.options),
        );
      case 'watch':
        return this._watch(msg.on);
      case 'open':
        return this._answer(msg.req, () => this._open(msg));
      case 'openDisplay':
        return this._answer(msg.req, () => this._openDisplay(msg));
      case 'reconfigure':
        return this._answer(msg.req, async () => {
          const hosted = this._sources.get(msg.source);
          return (await hosted?.source.reconfigure?.(msg.settings)) ?? true;
        });
      case 'want':
        return this._sources.get(msg.source)?.want(msg.on);
      case 'seen':
        return this._sources.get(msg.source)?.seen(msg.seq);
      case 'present':
        return this._sources.get(msg.source)?.present(msg.on);
      case 'seen-picture':
        return this._sources.get(msg.source)?.seenPicture(msg.seq);
      case 'close':
        this._sources.get(msg.source)?.release();
        return;
      case 'output-open':
        return this._openOutput(msg);
      case 'output-write':
        return this._outputs.get(msg.output)?.write(msg.channels);
      case 'output-close':
        this._outputs.get(msg.output)?.release();
        return;
      default:
    }
  }

  /** `fn()`'s value as the answer to request `req`, or its error. */
  async _answer(req, fn) {
    let reply;
    try {
      if (typeof fn !== 'function') throw new Error('not offered');
      reply = { value: await fn() };
    } catch (err) {
      reply = { error: wireError(err) };
    }
    if (!this.released) {
      this._send({ type: 'pane-capture-answer', req, ...reply });
    }
  }

  _watch(on) {
    if (on && !this._unwatch && typeof this.capture.watch === 'function') {
      this._unwatch = this.capture.watch(() =>
        this._send({ type: 'pane-capture-devices' }),
      );
    } else if (!on && this._unwatch) {
      this._unwatch();
      this._unwatch = null;
    }
  }

  /** A device, on the host's pool of shared sources: one session for the
   *  host and every pane that opens it at the same settings. */
  async _open({ source, deviceId, settings, device }) {
    const shared = await acquireSource(
      this.capture,
      device.deviceId === deviceId ? device : { ...device, deviceId },
      settings,
    );
    const track = deviceTrack(shared, {
      device,
      rung: this.capture,
      settings,
      constraints: {},
    });
    return this._hosted(source, track);
  }

  /** A screen, and the sound with it: sources of their own, as a picker's
   *  answer is. */
  async _openDisplay({ source, audio, request }) {
    const opened = await this.capture.openDisplay(request);
    const track = (raw) =>
      raw
        ? new MediaStreamTrack({ shared: soleSource(raw), constraints: {} })
        : null;
    const video = track(opened?.video);
    const sound = track(opened?.audio);
    return {
      video: video ? this._hosted(source, video) : null,
      audio: sound ? this._hosted(audio, sound) : null,
    };
  }

  /** `track` hosted for the pane as `id`: how the pane describes it. */
  _hosted(id, track) {
    if (this.released) {
      track.stop();
      throw Object.assign(new Error('the pane has gone'), {
        name: 'AbortError',
      });
    }
    const hosted = new HostedSource(this, id, track);
    this._sources.set(id, hosted);
    return hosted.describe();
  }

  _openOutput({ output, sampleRate, channels, deviceId }) {
    let out;
    try {
      out = this.capture.openAudioOutput({ sampleRate, channels, deviceId });
    } catch {
      // the pane's sink plays silence and its clock stands, as one over an
      // output that went away does
      return;
    }
    this._outputs.set(output, new HostedOutput(this, output, out));
  }

  release() {
    if (this.released) return;
    this.released = true;
    this._unwatch?.();
    this._unwatch = null;
    for (const hosted of [...this._sources.values()]) hosted.release();
    for (const out of [...this._outputs.values()]) out.release();
  }
}

/** A host track over one of the pane's sources. */
class HostedSource {
  constructor(hosted, id, track) {
    this.hosted = hosted;
    this.id = id;
    this.track = track;
    this.released = false;
    this._frameOff = null;
    this._frameSeq = 0;
    this._frameSeen = 0;
    this._ring = null;
    this._pull = null;
    this._size = null;
    this._offChange = track.onChange(() => this._changed());
  }

  /** The source under the track — the host's own, shared. */
  get source() {
    return this.track._shared.source;
  }

  describe() {
    const source = this.source;
    return {
      kind: this.track.kind,
      label: this.track.label,
      muted: this.track.muted,
      settings: source.settings?.() ?? {},
      capabilities: source.capabilities?.() ?? null,
      picture:
        typeof source.copyFrameTo === 'function' &&
        typeof this.hosted._native?.createSurfaceIOSurface === 'function',
    };
  }

  _send(msg) {
    this.hosted._send({ source: this.id, ...msg });
  }

  _changed() {
    if (this.released) return;
    if (this.track.readyState === 'ended') {
      this._send({ type: 'pane-capture-state', ended: true });
      this.release();
      return;
    }
    this._send({
      type: 'pane-capture-state',
      muted: this.track.muted,
      settings: this.source.settings?.() ?? {},
    });
  }

  want(on) {
    if (this.released) return;
    if (on && !this._frameOff) {
      this._frameOff = this.track.onFrame((frame) => this._frame(frame));
    } else if (!on && this._frameOff) {
      this._frameOff();
      this._frameOff = null;
    }
  }

  _frame(frame) {
    if (this.track.kind === 'audio') {
      this._send({
        type: 'pane-capture-frame',
        frame: { ...frame, channels: frame.channels.map(tight) },
      });
      return;
    }
    // the newest only: a pane still reading drops this one
    if (this._frameSeq - this._frameSeen >= IN_FLIGHT) return;
    this._send({
      type: 'pane-capture-frame',
      seq: ++this._frameSeq,
      frame: { ...frame, planes: frame.planes.map(tight) },
    });
  }

  seen(seq) {
    if (seq > this._frameSeen) this._frameSeen = seq;
  }

  /** The pane shows it, or has stopped: the copies into the ring start or
   *  stop, and the ring goes with them. */
  present(on) {
    if (this.released) return;
    if (on && this._pull === null) {
      this._ring = new HostRing(this.hosted._native);
      this._pull = setInterval(() => this._copy(), PULL_MS);
      this._pull.unref?.();
      this._copy();
    } else if (!on && this._pull !== null) {
      this._stopPictures();
    }
  }

  _copy() {
    const source = this.source;
    if (this.released || typeof source.copyFrameTo !== 'function') return;
    const settings = source.settings?.() ?? {};
    const size = this._size ?? settings;
    if (!(size.width > 0 && size.height > 0)) return;
    const { got, named } = this._ring.fill(size.width, size.height, (handle) =>
      source.copyFrameTo(handle),
    );
    if (named) {
      this._send({
        type: 'pane-capture-picture',
        surface: named.surface,
        width: got.width,
        height: got.height,
        time: got.time,
        seq: named.seq,
      });
    } else if (got?.width > 0 && got?.height > 0) {
      // the camera delivers at another size than it said: the next copy
      // goes into a ring of that size
      this._size = { width: got.width, height: got.height };
    }
  }

  seenPicture(seq) {
    this._ring?.seen(seq);
  }

  _stopPictures() {
    if (this._pull !== null) clearInterval(this._pull);
    this._pull = null;
    this._ring?.release();
    this._ring = null;
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.hosted._sources.delete(this.id);
    this._offChange();
    this._frameOff?.();
    this._frameOff = null;
    this._stopPictures();
    this.track.stop();
  }
}

/** An output on the host's rung for one of the pane's sinks, its state sent
 *  down after every write and every `CLOCK_MS`. */
class HostedOutput {
  constructor(hosted, id, out) {
    this.hosted = hosted;
    this.id = id;
    this.out = out;
    this._received = 0;
    this._clock = setInterval(() => this._mirror(), CLOCK_MS);
    this._clock.unref?.();
    this._mirror();
  }

  write(channels) {
    this._received += channels[0]?.length ?? 0;
    this.out.write(channels);
    this._mirror();
  }

  _mirror() {
    const s = this.out.state();
    this.hosted._send({
      type: 'pane-capture-output',
      output: this.id,
      currentTime: s.currentTime ?? 0,
      queued: s.queued ?? 0,
      latency: s.latency ?? 0,
      received: this._received,
    });
  }

  release() {
    clearInterval(this._clock);
    this.hosted._outputs.delete(this.id);
    this.out.close();
  }
}
