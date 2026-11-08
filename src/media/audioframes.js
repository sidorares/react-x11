// `AudioFrames`: a sink an application pushes decoded or received audio into,
// heard through the system's output — the counterpart of `VideoFrames`
// (design/architecture/media-capture.md §2.2, components' docs/prd-audio.md).
//
// No graph, no mixer, no resampler: planar `Float32Array`s at the rate the
// sink was made with, queued and played in order. What an app reads back is
// the clock — `currentTime`, the seconds the device has played — and
// `queued`, how much is waiting, which is how a decoder or a jitter buffer
// paces itself: keep `queued` near what the app can tolerate as latency and
// push when it drops.
//
// Unlike a video sink, **nothing is dropped**: audio skipped is a click, and
// a sink that dropped to stay current would turn a slow decoder into a
// broken one. A sink that runs dry plays silence until the next push.
//
// The output is the backend's (`openAudioOutput` on a capture rung,
// src/media/capture.js): on macOS the bridge's, through the same voice
// processing path an echo-cancelled microphone uses, so what is played here
// is the reference the canceller subtracts (§3). Where nothing can play,
// making one throws `NoAudioOutputError`, which `useDesktopCapability(
// 'audioOutput')` foretells.

import { appFor, rungWith } from './capture.js';

/**
 * Nothing on this display can play audio. **Typed**, the rule
 * `NoMediaPlaybackError` follows: a caller that branches on it keeps working
 * where there is no sound.
 */
export class NoAudioOutputError extends Error {
  constructor() {
    super(
      'react-x11: nothing on this display can play audio. On macOS that ' +
        'takes @windowkit/appkit 0.31 or later — `npm ls @windowkit/appkit` ' +
        'says which this app has; on X11 and ' +
        'Wayland there is no output rung yet (design/architecture/' +
        'media-capture.md §4); in a test, fakeMediaDevices(app) from ' +
        "'react-x11/test' gives one. Ask useDesktopCapability('audioOutput') " +
        'before making a sink.',
    );
    this.name = 'NoAudioOutputError';
    this.code = 'ENOAUDIOOUTPUT';
  }
}

const MAX_CHANNELS = 32;

/** The channels of `data` — `{ channels }`, or the array itself — each cut
 *  to `frames`, checked against the sink. */
function channelsOf(sink, data) {
  const channels = Array.isArray(data) ? data : data?.channels;
  if (
    !Array.isArray(channels) ||
    channels.length !== sink.channels ||
    !channels.every((c) => c instanceof Float32Array)
  ) {
    throw new TypeError(
      `react-x11: AudioFrames.push takes ${sink.channels} Float32Array` +
        `${sink.channels === 1 ? '' : 's'}, one a channel — as an array, or ` +
        'as { channels } (MediaAudioData)',
    );
  }
  if (
    !Array.isArray(data) &&
    data.sampleRate !== undefined &&
    data.sampleRate !== sink.sampleRate
  ) {
    throw new TypeError(
      `react-x11: AudioFrames.push: this sink plays ${sink.sampleRate} Hz ` +
        `and was handed ${data.sampleRate} Hz. A sink does not resample: make ` +
        'one at the rate the audio arrives in.',
    );
  }
  const frames = Array.isArray(data)
    ? channels[0].length
    : (data.frames ?? channels[0].length);
  if (!channels.every((c) => c.length >= frames)) {
    throw new TypeError(
      `react-x11: AudioFrames.push: every channel needs ${frames} samples`,
    );
  }
  return channels.map((c) => (c.length === frames ? c : c.subarray(0, frames)));
}

/** Where audio goes to be heard — `createAudioFrames(app, …)`. */
export class AudioFrames {
  constructor(app, options = {}) {
    const { sampleRate = 48000, channels = 2, deviceId } = options;
    if (
      !Number.isInteger(sampleRate) ||
      sampleRate < 1000 ||
      sampleRate > 384000
    ) {
      throw new TypeError(
        'react-x11: createAudioFrames: sampleRate is samples a second, a ' +
          `whole number from 1000 to 384000 (got ${sampleRate})`,
      );
    }
    if (
      !Number.isInteger(channels) ||
      channels < 1 ||
      channels > MAX_CHANNELS
    ) {
      throw new TypeError(
        `react-x11: createAudioFrames: channels is 1 to ${MAX_CHANNELS} ` +
          `(got ${channels})`,
      );
    }
    const rung = rungWith(app, 'openAudioOutput');
    if (!rung) throw new NoAudioOutputError();
    this.app = app;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.closed = false;
    this._out = rung.openAudioOutput({
      sampleRate,
      channels,
      deviceId: deviceId ?? null,
    });
  }

  /** Seconds of audio the device has played, by its own clock. */
  get currentTime() {
    return this.closed ? 0 : (this._out.state().currentTime ?? 0);
  }

  /** Seconds between a sample leaving the queue and being heard. */
  get latency() {
    return this.closed ? 0 : (this._out.state().latency ?? 0);
  }

  /** Seconds pushed and not yet played: what a decoder keeps topped up. */
  get queued() {
    if (this.closed) return 0;
    return (this._out.state().queued ?? 0) / this.sampleRate;
  }

  /**
   * Audio to play after what is queued: one `Float32Array` a channel,
   * samples from -1 to 1 — as an array, or `{ channels, frames, sampleRate }`
   * as a microphone track's frames arrive. Copied before the call returns.
   * Ignored once `close()` has run.
   */
  push(data) {
    if (this.closed) return;
    this._out.write(channelsOf(this, data));
  }

  /** Stops it: what is queued is dropped, and nothing more is taken. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this._out.close();
  }
}

/** A sink for `channels` of audio at `sampleRate`, on `app`'s output. */
export function createAudioFrames(app, options) {
  return new AudioFrames(app ?? appFor(options), options);
}
