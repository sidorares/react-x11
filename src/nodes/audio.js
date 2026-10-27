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

import {
  canPlayMedia,
  changedSettings,
  NoMediaPlaybackError,
  playerOptions,
} from '../mediaplayback.js';
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
    const { src } = this.props;
    if (src == null) return;
    if (canPlayMedia(this.app)) this._play(src);
    else this._refuse();
  }

  _detach() {
    this._playerOff?.();
    this._playerOff = null;
    this._player?.release();
    this._player = null;
    this._refused = false;
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
    if (newProps.src === before.src) {
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
    return this._player ? !this._player.playing : true;
  }
}
