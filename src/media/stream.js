// `MediaStream` and `MediaStreamTrack`: the web's nouns, kept to what an app
// and the components facade read (design/architecture/media-capture.md §2).
//
// A track is a view of a **source** — a camera opened at some settings, a
// microphone, a screen — and the source is the backend's. Three things here
// are deliberate:
//
//   - **One device and settings is one session.** Sources a backend opened
//     are shared (`acquireSource`): two components that ask for the same
//     camera at the same size get two tracks over one capture session, and
//     the session stops when the last of them does. A track that asks for
//     other settings (`applyConstraints`) moves to another source — the same
//     one, if someone already runs the device at them. This is §7's "who owns
//     the device lifetime" answered: neither the hook nor the component, but
//     the count.
//   - **Frames come off a track by callback** — `track.onFrame(fn)` answers
//     the unsubscribe — not by a `ReadableStream` or a canvas round trip. A
//     video frame is `{ format, width, height, planes, strides, time,
//     colorSpace, range }`, the shape a `VideoFrames` sink takes, newest
//     wins; audio is `{ sampleRate, channels, frames, time }`, planar
//     `Float32Array`s, nothing dropped. A source pays for delivering frames
//     only while somebody reads them (`wantFrames`), which on macOS is the
//     difference between a preview that never crosses into JavaScript and one
//     that copies every frame.
//   - **No EventTarget.** State a component renders from — `muted`,
//     `readyState`, the settings — changes through `onChange(fn)`, which is
//     what a hook subscribes to. The facade builds `addEventListener('ended')`
//     on it where a page wants one.

import {
  constraintsCopy,
  constraintsKey,
  fitDevice,
  normalizeTrackConstraints,
} from './constraints.js';
import { errorFromBackend, OverconstrainedError } from './errors.js';

/**
 * One opened source and the tracks over it: the source's news fanned out,
 * and the source stopped once no track is left.
 */
class SharedSource {
  constructor(source, onIdle) {
    this.source = source;
    this.kind = source.kind;
    this.tracks = new Set();
    this.muted = false;
    this.ended = false;
    this.stopped = false;
    this._frameFns = new Set();
    this._onIdle = onIdle;
    source.listen({
      frame: (frame) => {
        for (const fn of this._frameFns) fn(frame);
      },
      muted: (muted) => {
        if (this.ended || Boolean(muted) === this.muted) return;
        this.muted = Boolean(muted);
        for (const track of [...this.tracks]) track._changed();
      },
      ended: () => {
        if (this.ended || this.stopped) return;
        this.ended = true;
        this._onIdle();
        for (const track of [...this.tracks]) track._end();
      },
    });
  }

  join(track) {
    this.tracks.add(track);
  }

  /** `track` is done with it; the last one out stops the source. */
  leave(track) {
    this.tracks.delete(track);
    if (this.tracks.size !== 0 || this.stopped) return;
    this.stopped = true;
    this._frameFns.clear();
    this._onIdle();
    this.source.stop();
  }

  /** `fn(frame)` for every frame, until the answer is called. The source is
   *  told to deliver frames while there is anyone to deliver them to. */
  frames(fn) {
    this._frameFns.add(fn);
    if (this._frameFns.size === 1) this.source.wantFrames?.(true);
    return () => {
      if (!this._frameFns.delete(fn)) return;
      if (this._frameFns.size === 0 && !this.stopped) {
        this.source.wantFrames?.(false);
      }
    };
  }
}

// Sources a backend opened for devices, by backend and then by what was
// opened: `kind|deviceId|settings`. An entry is the promise of the shared
// source, so two requests that arrive while the device is still opening wait
// for the one session.
const pools = new WeakMap();

const keyOf = (device, settings) =>
  `${device.kind}|${device.deviceId}|${constraintsKey(settings)}`;

/**
 * The shared source for `device` at `settings` on `rung` — opened if nobody
 * has it open, the running one otherwise. Rejects with the backend's error
 * as the exception its name means.
 */
export async function acquireSource(rung, device, settings) {
  let pool = pools.get(rung);
  if (!pool) pools.set(rung, (pool = new Map()));
  const key = keyOf(device, settings);
  for (let attempt = 0; attempt < 2; attempt++) {
    let entry = pool.get(key);
    if (!entry) {
      entry = {};
      const forget = () => {
        if (pool.get(key) === entry) pool.delete(key);
      };
      entry.promise = Promise.resolve()
        .then(() => rung.open(device.deviceId, settings, device))
        .then(
          (source) => new SharedSource(source, forget),
          (err) => {
            forget();
            throw errorFromBackend(err, `${device.label || device.deviceId}`);
          },
        );
      pool.set(key, entry);
    }
    const shared = await entry.promise;
    // the last track over it left while this request waited: open it again
    if (!shared.stopped && !shared.ended) return shared;
  }
  throw new DOMException(
    `react-x11: ${device.label || device.deviceId} closed while it was opening`,
    'AbortError',
  );
}

/** A source nobody shares — a screen the user picked, a test's — as the
 *  shared shape tracks run over. */
export function soleSource(source) {
  return new SharedSource(source, () => {});
}

/**
 * A track: one kind of media from one source. Not constructed by an app —
 * `getUserMedia`, `getDisplayMedia` and `clone()` make them.
 */
export class MediaStreamTrack {
  /** @internal */
  constructor({ shared, device = null, rung = null, constraints, label }) {
    this.id = globalThis.crypto.randomUUID();
    this.kind = shared.kind;
    this.label = label ?? shared.source.label ?? '';
    this._shared = shared;
    this._device = device;
    this._rung = rung;
    this._constraints = constraintsCopy(constraints);
    this._enabled = true;
    this._ended = false;
    this._frameFns = new Set();
    this._frameOff = null;
    this._changeFns = new Set();
    shared.join(this);
  }

  /** `'live'`, or `'ended'` once stopped or once its source has gone. */
  get readyState() {
    return this._ended ? 'ended' : 'live';
  }

  /** Whether the source gives no frames for now: the camera taken by
   *  another app, the lid closed. Not the app's to set — that is `enabled`. */
  get muted() {
    return !this._ended && this._shared.muted;
  }

  /** False: no frames reach `onFrame`, and a `<video>` or `<audio>` showing
   *  it shows nothing and plays silence. The source keeps running. */
  get enabled() {
    return this._enabled;
  }

  set enabled(value) {
    const on = Boolean(value);
    if (on === this._enabled) return;
    this._enabled = on;
    this._changed();
  }

  /** What the source runs at: the size and rate a camera actually delivers,
   *  the rate a microphone's samples arrive at, whether echo cancellation
   *  engaged. */
  getSettings() {
    const settings = this._shared.source.settings?.() ?? {};
    const out = { ...settings };
    if (this._device) {
      out.deviceId = this._device.deviceId;
      if (this._device.groupId) out.groupId = this._device.groupId;
    }
    return out;
  }

  /** What the source can run at: a range per number, a list per choice. */
  getCapabilities() {
    const caps = {
      ...(this._shared.source.capabilities?.() ??
        this._device?.capabilities ??
        {}),
    };
    if (this._device) {
      caps.deviceId = this._device.deviceId;
      if (this._device.groupId) caps.groupId = this._device.groupId;
    }
    return caps;
  }

  /** The constraints it was last asked for, as they were written. */
  getConstraints() {
    return constraintsCopy(this._constraints);
  }

  /**
   * Ask it to run at other settings. A device's track moves to the source
   * that runs the device at them — opened if nobody does — and the frames
   * after it are the new size. Rejects with `OverconstrainedError` where a
   * required constraint cannot be met, and changes nothing then.
   */
  async applyConstraints(constraints = {}) {
    if (this._ended) return;
    const normalized =
      normalizeTrackConstraints(this.kind, constraints) ?? new Map();
    if (this._device && this._rung) {
      const fit = fitDevice(this._device, normalized);
      if (fit.failed) throw new OverconstrainedError(fit.failed);
      const before = this._shared;
      const settings = fit.settings;
      if (keyOf(this._device, settings) === before._key) {
        this._constraints = constraintsCopy(constraints);
        return;
      }
      // A device that runs one session at a time is let go before it is
      // opened again; one with other tracks over it is kept for them.
      const alone = before.tracks.size === 1;
      if (alone) this._unhookFrames();
      let next;
      try {
        if (alone) before.leave(this);
        next = await acquireSource(this._rung, this._device, settings);
      } catch (err) {
        if (alone) {
          // back to what it ran at, if the device will still have it
          try {
            const again = await acquireSource(
              this._rung,
              this._device,
              before._settings,
            );
            this._moveTo(again, before._settings);
          } catch {
            this._end();
          }
        }
        throw err;
      }
      if (this._ended) {
        next.join(this);
        next.leave(this);
        return;
      }
      if (!alone) before.leave(this);
      this._moveTo(next, settings);
      this._constraints = constraintsCopy(constraints);
      return;
    }
    // a source of its own (a screen): told, where it can be
    const settings = {};
    for (const [name, c] of normalized) {
      const v = c.exact ?? c.ideal;
      if (v !== undefined) settings[name] = Array.isArray(v) ? v[0] : v;
    }
    const ok = (await this._shared.source.reconfigure?.(settings)) ?? true;
    if (!ok) throw new OverconstrainedError('');
    this._constraints = constraintsCopy(constraints);
    this._changed();
  }

  _moveTo(shared, settings) {
    this._shared = shared;
    shared._settings = settings;
    shared._key = keyOf(this._device, settings);
    shared.join(this);
    if (this._frameFns.size !== 0) this._hookFrames();
    this._changed();
  }

  /** Ends it: no frame after this, and the source stopped if it was the
   *  last track over it. `onChange` hears it, so what shows the track lets
   *  go of it; a facade that dispatches the web's `ended` tells the two
   *  apart, since a browser fires none for a track a page stopped. */
  stop() {
    if (this._ended) return;
    this._ended = true;
    this._unhookFrames();
    this._frameFns.clear();
    this._shared.leave(this);
    this._changed();
  }

  /** Another track over the same source, live while either is. */
  clone() {
    const track = new MediaStreamTrack({
      shared: this._shared,
      device: this._device,
      rung: this._rung,
      constraints: this._constraints,
      label: this.label,
    });
    track._enabled = this._enabled;
    if (this._ended) track.stop();
    return track;
  }

  /**
   * `fn(frame)` for each frame while it is live, enabled and not muted; the
   * answer unsubscribes. Video: `{ format, width, height, planes, strides,
   * time, colorSpace, range }`, the newest only — a reader slower than the
   * camera sees fewer frames, never older ones. Audio: `{ sampleRate,
   * channels: Float32Array[], frames, time }`, every chunk. `time` is
   * seconds on the source's clock. The planes and channels are the source's
   * until the next frame: what keeps one copies it.
   */
  onFrame(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('react-x11: track.onFrame(fn) takes a function');
    }
    if (this._ended) return () => {};
    this._frameFns.add(fn);
    if (this._frameFns.size === 1) this._hookFrames();
    return () => {
      if (!this._frameFns.delete(fn)) return;
      if (this._frameFns.size === 0) this._unhookFrames();
    };
  }

  /** `fn()` whenever `readyState`, `muted`, `enabled` or the settings
   *  change; the answer unsubscribes. */
  onChange(fn) {
    this._changeFns.add(fn);
    return () => this._changeFns.delete(fn);
  }

  // --- internal ---------------------------------------------------------------

  _hookFrames() {
    this._unhookFrames();
    this._frameOff = this._shared.frames((frame) => {
      if (!this._enabled || this._shared.muted) return;
      for (const fn of [...this._frameFns]) fn(frame);
    });
  }

  _unhookFrames() {
    this._frameOff?.();
    this._frameOff = null;
  }

  /** The source's own presentation for a `<video>`, where it has one — a
   *  camera's layer on macOS — or null, and the element shows the frames. */
  _present() {
    if (this._ended) return null;
    return this._shared.source.present?.() ?? null;
  }

  _changed() {
    for (const fn of [...this._changeFns]) fn();
  }

  /** The source went away: ended, and said so. */
  _end() {
    if (this._ended) return;
    this._ended = true;
    this._unhookFrames();
    this._frameFns.clear();
    this._shared.leave(this);
    this._changed();
  }
}

/** A device track over a freshly acquired shared source. */
export function deviceTrack(shared, { device, rung, settings, constraints }) {
  shared._settings ??= settings;
  shared._key ??= keyOf(device, settings);
  return new MediaStreamTrack({ shared, device, rung, constraints });
}

/**
 * A set of tracks: what `getUserMedia` resolves with and what `<video
 * srcObject>` and `<audio srcObject>` take. `new MediaStream(tracks)` makes
 * one of tracks an app already has.
 */
export class MediaStream {
  constructor(init) {
    this.id = globalThis.crypto.randomUUID();
    this._tracks = new Map();
    this._changeFns = new Set();
    const tracks =
      init instanceof MediaStream ? init.getTracks() : (init ?? []);
    for (const track of tracks) this.addTrack(track);
  }

  /** Whether any track is live. */
  get active() {
    for (const track of this._tracks.keys()) {
      if (track.readyState === 'live') return true;
    }
    return false;
  }

  getTracks() {
    return [...this._tracks.keys()];
  }

  getVideoTracks() {
    return this.getTracks().filter((t) => t.kind === 'video');
  }

  getAudioTracks() {
    return this.getTracks().filter((t) => t.kind === 'audio');
  }

  getTrackById(id) {
    return this.getTracks().find((t) => t.id === id) ?? null;
  }

  addTrack(track) {
    if (!(track instanceof MediaStreamTrack)) {
      throw new TypeError(
        'react-x11: MediaStream.addTrack takes a MediaStreamTrack',
      );
    }
    if (this._tracks.has(track)) return;
    this._tracks.set(
      track,
      track.onChange(() => this._changed()),
    );
    this._changed();
  }

  removeTrack(track) {
    const off = this._tracks.get(track);
    if (!off) return;
    off();
    this._tracks.delete(track);
    this._changed();
  }

  /** A stream of clones of every track. */
  clone() {
    return new MediaStream(this.getTracks().map((t) => t.clone()));
  }

  /** `fn()` whenever a track is added or removed, or one of them changes;
   *  the answer unsubscribes. */
  onChange(fn) {
    this._changeFns.add(fn);
    return () => this._changeFns.delete(fn);
  }

  _changed() {
    for (const fn of [...this._changeFns]) fn();
  }
}

/** The track a `<video>` or an `<audio>` plays from `stream`: the first live
 *  one of the kind, or null. */
export function firstLiveTrack(stream, kind) {
  if (!stream) return null;
  const tracks =
    kind === 'video' ? stream.getVideoTracks() : stream.getAudioTracks();
  return tracks.find((t) => t.readyState === 'live') ?? null;
}
