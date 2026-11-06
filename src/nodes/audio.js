// <audio>: a file or URL the platform plays (`src`, where there is a
// player), heard and never seen — `<video src>` without a picture.
//
// The player is the one `<video src>` has, the app's `createPlayer` — on
// macOS AVFoundation's (src/cocoa/player.js), in a `<Frame>` pane its
// host's (src/cocoa/paneplayer.js) — told it has no picture, so a pane's
// host copies no frames for it. Its events are HTML's, as a `<video>`'s
// are, and its `ref` is HTMLMediaElement's imperative half.
//
// It takes no room and draws nothing, whatever its style says: HTML's
// `audio:not([controls])` is `display: none`, and there are no controls
// here — the transport is the application's React. It is not one of the
// drawn kinds, and its yoga node is always `display: none`, so a row it is
// written in lays out as though it were not there and no paint, hit test
// or accessibility walk stops at it.
//
// Where there is no player it says so once, through `onError` — a
// `NoMediaPlaybackError` — and nothing is heard.
//
// `srcObject` is a `MediaStream` (design/architecture/media-capture.md
// §2.2): its first live audio track, read off the track (`onFrame`) into an
// `AudioFrames` sink made at the rate its audio arrives in — the push sink
// there is no graph behind. `muted`, `volume` and `paused` say what is
// heard of it. Where nothing can play audio it says so once, through
// `onError` — a `NoAudioOutputError`.

import {
  canPlayMedia,
  changedSettings,
  NoMediaPlaybackError,
  playerOptions,
} from '../mediaplayback.js';
import { createAudioFrames, NoAudioOutputError } from '../media/audioframes.js';
import { MediaStream, firstLiveTrack } from '../media/stream.js';
import { Node } from './node.js';

// The style an `<audio>` is laid out with, whatever it was written with.
const HIDDEN = Object.freeze({ display: 'none' });

// Apps already told, by an <audio src> with no `onError`, that this backend
// plays nothing: the answer is the backend's, so the second element to ask
// carries no news.
const warnedNoPlayback = new WeakSet();

/** `props` with the style an `<audio>` always has. */
const hidden = (props) =>
  props.style === HIDDEN ? props : { ...props, style: HIDDEN };

export class AudioElementNode extends Node {
  constructor(props, app) {
    super('audio', hidden(props), app);
    this.focusableByDefault = false;
    /** the player, from the commit that mounted it on */
    this._player = null;
    this._playerOff = null;
    this._refused = false;
    /** `srcObject`: the stream, the track heard from it, and the sink its
     *  audio goes into, made at the first chunk's rate */
    this._stream = null;
    this._streamOff = null;
    this._track = null;
    this._trackOff = null;
    this._sink = null;
    this._scratch = null;
    // Nothing is opened in the constructor: it runs in the render phase,
    // which React may discard, and a player made there would never be let
    // go. The reconciler's `commitMount` opens it, since a node laid out
    // `display: none` is never measured, which is when `<video>` opens its.
    this._dirty = true;
  }

  // --- the source -------------------------------------------------------------

  /** Opened in the commit that mounted it, or at the first call on the
   *  `ref`, whichever is first. */
  _ensure() {
    if (!this._dirty || this.destroyed) return;
    this._dirty = false;
    this._attach();
  }

  _attach() {
    const { src, srcObject } = this.props;
    if (src != null && srcObject != null) {
      throw new Error(
        'react-x11: <audio> takes src or srcObject, not both — src is played ' +
          'by the platform, srcObject is a MediaStream',
      );
    }
    if (srcObject != null) {
      if (!(srcObject instanceof MediaStream)) {
        throw new Error(
          'react-x11: <audio srcObject> must be a MediaStream — from ' +
            'useUserMedia(), getUserMedia() or new MediaStream(tracks)',
        );
      }
      this._stream = srcObject;
      this._streamOff = srcObject.onChange(() => this._retrack());
      this._retrack();
      return;
    }
    if (src == null) return;
    if (canPlayMedia(this.app)) this._play(src);
    else this._refuse();
  }

  _detach() {
    this._dropTrack();
    this._streamOff?.();
    this._streamOff = null;
    this._stream = null;
    this._playerOff?.();
    this._playerOff = null;
    this._player?.release();
    this._player = null;
    this._refused = false;
  }

  // --- srcObject ----------------------------------------------------------------

  /** The stream's first live audio track, while it is enabled and not muted:
   *  asked again whenever the stream changes. */
  _retrack() {
    if (this.destroyed || !this._stream) return;
    const track = firstLiveTrack(this._stream, 'audio');
    const heard = track?.enabled && !track.muted ? track : null;
    if (heard === this._track) return;
    this._dropTrack();
    this._track = heard;
    if (heard) this._trackOff = heard.onFrame((data) => this._chunk(data));
  }

  _dropTrack() {
    this._trackOff?.();
    this._trackOff = null;
    this._sink?.close();
    this._sink = null;
    this._track = null;
  }

  /** A chunk off the track, played: into a sink at its rate and channel
   *  count, made on the first one and again if either changes. */
  _chunk(data) {
    if (this.destroyed || this._refused) return;
    const props = this.props;
    const channels = data.channels.length;
    let sink = this._sink;
    if (
      !sink ||
      sink.sampleRate !== data.sampleRate ||
      sink.channels !== channels
    ) {
      sink?.close();
      this._sink = sink = null;
      try {
        sink = createAudioFrames(this.app, {
          sampleRate: data.sampleRate,
          channels,
          deviceId: props.sinkId ?? undefined,
        });
      } catch (err) {
        if (err instanceof NoAudioOutputError) {
          this._refuseOutput(err);
          return;
        }
        throw err;
      }
      this._sink = sink;
    }
    if (props.paused === true || props.muted === true) return;
    const volume = typeof props.volume === 'number' ? props.volume : 1;
    if (volume === 1) {
      sink.push(data);
      return;
    }
    // scaled into a scratch copy: the track's arrays are its own
    const frames = data.frames ?? data.channels[0].length;
    if (
      this._scratch?.length !== channels ||
      this._scratch[0].length < frames
    ) {
      this._scratch = data.channels.map(() => new Float32Array(frames));
    }
    const out = this._scratch.map((c, i) => {
      const src = data.channels[i];
      const view = c.subarray(0, frames);
      for (let j = 0; j < frames; j++) view[j] = src[j] * volume;
      return view;
    });
    sink.push({ channels: out, frames, sampleRate: data.sampleRate });
  }

  _refuseOutput(err) {
    this._refused = true;
    this.error = err;
    queueMicrotask(() => {
      if (this.destroyed || !this._refused) return;
      if (this.props.onError) this.props.onError(err);
      else if (this.app && !warnedNoPlayback.has(this.app)) {
        warnedNoPlayback.add(this.app);
        console.warn(err.message);
      }
    });
  }

  _play(src) {
    const player = this.app.createPlayer(src, {
      ...playerOptions(this.props),
      element: 'audio',
    });
    this._player = player;
    this._playerOff = player._subscribe((ev) => this._onPlayer(ev));
  }

  /** The player's news, as HTML's media events. */
  _onPlayer(ev) {
    if (this.destroyed) return;
    const player = this._player;
    const props = this.props;
    switch (ev.type) {
      case 'player-metadata':
        props.onLoadedMetadata?.({ duration: player.duration, node: this });
        return;
      case 'player-state':
        if (player.playing) props.onPlay?.();
        else props.onPause?.();
        return;
      case 'player-time':
        props.onTimeUpdate?.({ currentTime: player.currentTime, node: this });
        return;
      case 'player-ended':
        props.onEnded?.();
        return;
      case 'player-error':
        this.error = player.error;
        if (props.onError) props.onError(player.error);
        else console.warn(player.error.message);
        return;
    }
  }

  _refuse() {
    this._refused = true;
    const err = new NoMediaPlaybackError('audio');
    this.error = err;
    queueMicrotask(() => {
      if (this.destroyed || !this._refused) return;
      if (this.props.onError) this.props.onError(err);
      else if (this.app && !warnedNoPlayback.has(this.app)) {
        warnedNoPlayback.add(this.app);
        console.warn(err.message);
      }
    });
  }

  // --- props --------------------------------------------------------------------

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    super.applyProps(hidden(newProps), oldProps && hidden(oldProps));
    if (
      newProps.src === before.src &&
      newProps.srcObject === before.srcObject
    ) {
      // another output: the next chunk makes a sink there
      if (newProps.sinkId !== before.sinkId && this._sink) {
        this._sink.close();
        this._sink = null;
      }
      // the same player, told what changed of how it plays
      const settings = this._player && changedSettings(newProps, before);
      if (settings) this._player.set(settings);
      return;
    }
    this._detach();
    this._dirty = false;
    this._attach();
  }

  destroySubtree() {
    this.destroyed = true;
    this._detach();
    super.destroySubtree();
  }

  // --- the imperative half: what a `ref` can do, as HTMLMediaElement can ----------

  /** Play `src` — from its start if it has ended. */
  play() {
    this._ensure();
    this._player?.play();
  }

  pause() {
    this._ensure();
    this._player?.pause();
  }

  /** To `seconds` into `src`, exactly. */
  seek(seconds) {
    this._ensure();
    this._player?.seek(seconds);
  }

  /** Seconds into `src`, or 0. */
  get currentTime() {
    return this._player?.currentTime ?? 0;
  }

  /** Seconds; `Infinity` for a live stream, NaN before it is known. */
  get duration() {
    return this._player?.duration ?? NaN;
  }

  get paused() {
    if (this._stream) return this._track === null || this.props.paused === true;
    return this._player ? !this._player.playing : true;
  }
}
