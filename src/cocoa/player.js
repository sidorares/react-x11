// `<video src>` on macOS (docs/architecture/video.md §3.2, §9): a file or URL
// played by AVFoundation through @windowkit/appkit's player verbs — the
// platform's decoder, audio, seeking and HLS — with the picture on the
// player's own AVPlayerLayer.
//
// The player is what a `<video>`'s sprite part shows as its `contents`, the
// same way a `VideoFrames` sink is: lifted (src/cocoa/sprites.js), the
// AVPlayerLayer goes inside the part's layer and fills it, and AVFoundation
// puts every frame on the screen with nothing of ours in the way; declined,
// the element draws the frame showing, which `copyFrame` converts into a
// surface of its own in the colours the layer shows it in. Everything else —
// state, time, the end, failure — comes back as the bridge's `player-*`
// events, routed here by id (`CocoaApp._route`).

/** Has `native` the verbs a player needs? */
export function canPlay(native) {
  return (
    typeof native?.createPlayer === 'function' &&
    typeof native.playerSet === 'function' &&
    typeof native.playerSeek === 'function' &&
    typeof native.playerCopyFrame === 'function' &&
    typeof native.releasePlayer === 'function'
  );
}

/**
 * One file or URL, playing or not. `width`/`height` are the picture's once
 * the item is ready (0 before), `duration` its length in seconds (`Infinity`
 * for a live stream, NaN before it is known).
 */
export class CocoaPlayer {
  constructor(app, src, options = {}) {
    this.app = app;
    this._native = app._native;
    const made = this._native.createPlayer(String(src), {
      autoPlay: Boolean(options.autoPlay),
      loop: Boolean(options.loop),
      muted: Boolean(options.muted),
      volume: typeof options.volume === 'number' ? options.volume : 1,
      rate: typeof options.playbackRate === 'number' ? options.playbackRate : 1,
    });
    this.id = made.id;
    /** the AVPlayerLayer, a layer handle */
    this.layer = made.layer;
    this.width = 0;
    this.height = 0;
    this.duration = NaN;
    this.currentTime = 0;
    this.playing = false;
    this.ended = false;
    this.error = null;
    this.released = false;
    this._listeners = new Set();
    app._players.set(this.id, this);
  }

  /** A `player-*` event from the bridge: the state it says, then whoever
   *  listens. */
  _event(ev) {
    if (this.released) return;
    switch (ev.type) {
      case 'player-metadata':
        this.width = ev.width;
        this.height = ev.height;
        this.duration = ev.duration;
        break;
      case 'player-state':
        // AVFoundation reports every move of its time control — waiting,
        // playing, a loop's restart — and HTML's `play` and `pause` are the
        // moves between paused and not
        if (Boolean(ev.playing) === this.playing) return;
        this.playing = Boolean(ev.playing);
        if (this.playing) this.ended = false;
        break;
      case 'player-time':
        this.currentTime = ev.currentTime;
        break;
      case 'player-ended':
        this.ended = true;
        this.playing = false;
        break;
      case 'player-error':
        this.error = new Error(
          `react-x11: <video src> could not be played: ${ev.message}`,
        );
        break;
      default:
        return;
    }
    for (const fn of [...this._listeners]) fn(ev);
  }

  /** `fn(event)` for every event; answers the unsubscribe. */
  _subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** What `paused`, `playbackRate`, `volume`, `muted` and `loop` say now;
   *  what is left out stays. */
  set({ paused, playbackRate, volume, muted, loop } = {}) {
    if (this.released) return;
    const settings = {};
    if (typeof paused === 'boolean') settings.paused = paused;
    if (typeof playbackRate === 'number' && playbackRate > 0) {
      settings.rate = playbackRate;
    }
    if (typeof volume === 'number') settings.volume = volume;
    if (typeof muted === 'boolean') settings.muted = muted;
    if (typeof loop === 'boolean') settings.loop = loop;
    this._native.playerSet(this.id, settings);
  }

  play() {
    // HTML plays an ended item from its start
    if (this.ended) this.seek(0);
    this.set({ paused: false });
  }

  pause() {
    this.set({ paused: true });
  }

  seek(seconds) {
    if (this.released || !Number.isFinite(seconds)) return;
    this.currentTime = Math.max(0, seconds);
    this._native.playerSeek(this.id, this.currentTime);
  }

  /**
   * The frame showing, into `surface` (a `CocoaSurface` of the picture's
   * size): `{ width, height, time, written }`, or null when nothing is newer
   * than the last frame copied. `written` false means the surface is not the
   * frame's size, which the caller remakes.
   */
  copyFrame(surface) {
    if (this.released || !surface?._surfaceHandle) return null;
    return this._native.playerCopyFrame(this.id, surface._surfaceHandle);
  }

  release() {
    if (this.released) return;
    this.released = true;
    this._listeners.clear();
    this.app._players.delete(this.id);
    this._native.releasePlayer(this.id);
  }
}

/**
 * A player's picture on a sprite part's layer: its AVPlayerLayer inside the
 * part's, filling it. The bridge plays into it on AVFoundation's clock; this
 * only places it, and takes it out again when the part comes down.
 */
export class PlayerLift {
  constructor(native, player, layer) {
    this.native = native;
    this.player = player;
    this.layer = layer;
    this._bounds = null;
    native.addSublayer(layer, player.layer);
  }

  /** The part's layer is `bounds` (points) now: the picture fills it. */
  layout(bounds) {
    const was = this._bounds;
    if (was && was[2] === bounds[2] && was[3] === bounds[3]) return;
    this._bounds = bounds;
    this.native.setLayerProps(this.player.layer, {
      frame: [0, 0, bounds[2], bounds[3]],
    });
  }

  release() {
    this.native.removeFromSuperlayer(this.player.layer);
  }
}
