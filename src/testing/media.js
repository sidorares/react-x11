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
