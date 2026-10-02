// <video>: frames an application decodes (`frames`, a VideoFrames sink), or a
// file or URL the platform plays (`src`, where there is a player), fitted
// into the node's box (docs/architecture/video.md §6–7).
//
// A drawn node like `<image>`: it joins yoga, it is in the paint order and it
// is hit like anything else — which is the whole point. A video in a form
// sits under the form's popups and tooltips and inside its scroll panes, and
// a child window or a `<glarea>`'s layer can do neither.
//
// It is presented two ways, decided per frame:
//
// - **lifted** — it offers its picture as its one sprite part (`sprites()`),
//   with the sink as the part's `contents`; a presenter that lifts sprites
//   (the Cocoa surface presenter, over a bridge with video surfaces) puts
//   the frames on a layer of their own, written by `push` itself, and this
//   node leaves a hole where the picture is. No react-x11 frame per video
//   frame.
// - **drawn** — everywhere else, and in every frame the presenter declines
//   the part (something is painted over it, it fades, a rounded card does
//   not hold it): the newest frame is copied into a surface of the node's
//   own at paint, natively where the backend can (`app.writeVideoFrame`) and
//   through `frameToRGBA` where it cannot, and composited at the picture's
//   rect like an `<image>` whose pixels changed. A push claims the picture.
//
// `src` needs a platform player, which this backend has when
// `useSupports('mediaPlayback')` says so — the app's `createPlayer`, on macOS
// AVFoundation's (src/cocoa/player.js). The player is the part's `contents`
// the way a sink is: lifted, its own layer shows the picture; drawn, the
// frame showing is copied into the node's surface (`copyFrame`) for as long
// as it plays. Where there is no player the element says so once, through
// `onError`, and shows its poster — never a black box that looks like a
// video that has not started (#531's rule for `<foreign>`).

import { loadImageFile } from '../imagedecode.js';
import {
  decodeImageSource,
  freeImage,
  isDirectImageSource,
  isPathImageSource,
  toLoadablePath,
} from '../imagesource.js';
import { canPlayMedia, NoMediaPlaybackError } from '../mediaplayback.js';
import { Surface } from '../offscreen.js';
import { frameToRGBA, isVideoFrames } from '../videoframes.js';
import { fitRect, objectFitOf } from './fit.js';
import { intrinsicSize } from './layout.js';
import { Node } from './node.js';
import { DEV } from './util.js';

// HTML's size for a video that has nothing to say about its own
const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 150;

// How often a drawn player's frame is asked for while it plays: a display
// frame, since the copy answers null for one that has not changed and the
// claim follows only a new one.
const PULL_MS = 16;

// The player's settings among a `<video>`'s props, as the player takes them.
const PLAYER_PROPS = ['paused', 'muted', 'volume', 'loop', 'playbackRate'];

// Apps already told, by a <video src> with no `onError`, that this backend
// plays nothing: the answer is the backend's, so the second element to ask
// carries no news.
const warnedNoPlayback = new WeakSet();

/** Throws for a combination no `<video>` can be. */
export function validateVideoProps(props) {
  if (props.frames != null && props.src != null) {
    throw new Error(
      'react-x11: <video> takes frames or src, not both — frames are ' +
        'decoded by the application, src by the platform',
    );
  }
  if (props.frames != null && !isVideoFrames(props.frames)) {
    throw new Error(
      'react-x11: <video frames> must be a VideoFrames sink — from ' +
        'useVideoFrames({ width, height, format }) or createVideoFrames(app, …)',
    );
  }
}

export class VideoNode extends Node {
  constructor(props, app) {
    super('video', props, app);
    validateVideoProps(props);
    this.focusableByDefault = false;
    /** the sink being shown, subscribed to from the first layout on */
    this._sink = null;
    this._unsubscribe = null;
    /** whether the presenter has the picture on a layer (`spritesLifted`) */
    this._lifted = false;
    /** the drawn presentation: a surface at the frame's size, and which
     *  frame it holds */
    this._surface = null;
    this._drawn = -1;
    this._rgba = null;
    /** the poster, once loaded or decoded */
    this._poster = null;
    this._ownedPoster = null;
    this._posterToken = 0;
    this._refused = false;
    /** `<video src>`'s player, from the first layout on, and what the drawn
     *  presentation has of it: whether a frame is in the surface, and the
     *  timer that asks for the next one while it plays */
    this._player = null;
    this._playerOff = null;
    this._playerFrame = false;
    this._pull = null;
    // Like `<image>`, nothing is resolved in the constructor: it runs in the
    // render phase, which React may discard, and a subscription made there
    // would never be undone.
    this._dirty = true;
  }

  // --- the source -------------------------------------------------------------

  /** First layout or paint after a mount or a change: both after commit. */
  _ensure() {
    if (!this._dirty || this.destroyed) return;
    this._dirty = false;
    this._attach();
  }

  _attach() {
    const { frames, src, poster } = this.props;
    if (frames != null) {
      this._sink = frames;
      this._unsubscribe = frames._subscribe((frame) => this._onFrame(frame));
      this._metadata();
    } else if (src != null) {
      if (canPlayMedia(this.app)) this._play(src);
      else this._refuse();
    }
    if (poster != null) this._loadPoster(poster);
  }

  _detach() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._sink = null;
    this._playerOff?.();
    this._playerOff = null;
    this._player?.release();
    this._player = null;
    this._playerFrame = false;
    this._stopPull();
    this._posterToken++;
    if (this._ownedPoster) {
      freeImage(this.app, this._ownedPoster);
      this._ownedPoster = null;
    }
    this._poster = null;
    this._refused = false;
  }

  /**
   * A push, or a close. Lifted, the layer shows the frame and the window
   * paints nothing; otherwise the picture is claimed, and the frame that
   * claim brings asks for the parts again — which is how the first frame
   * goes up onto a layer and a close takes the picture back down.
   */
  _onFrame(frame) {
    if (this.destroyed) return;
    if (frame === null || !this._lifted) {
      this.root?.invalidate(false, this, 'content');
    }
  }

  _metadata() {
    const sink = this._sink;
    const handler = this.props.onLoadedMetadata;
    if (!handler || !sink) return;
    // after the commit that mounted it: the ordinary answer to the news is
    // to set state, which React refuses in the middle of a commit
    queueMicrotask(() => {
      if (this.destroyed || this._sink !== sink) return;
      handler({
        width: sink.width,
        height: sink.height,
        // a sink is a live source: HTML's duration for one
        duration: Infinity,
        node: this,
      });
    });
  }

  /** `src` on the platform's player, playing from the start if the props
   *  say so: a controlled `paused={false}`, or `autoPlay`. */
  _play(src) {
    const p = this.props;
    const player = this.app.createPlayer(src, {
      autoPlay:
        p.paused !== undefined ? p.paused === false : Boolean(p.autoPlay),
      loop: p.loop,
      muted: p.muted,
      volume: p.volume,
      playbackRate: p.playbackRate,
    });
    this._player = player;
    this._playerOff = player._subscribe((ev) => this._onPlayer(ev));
  }

  /** The player's news, as HTML's media events — after the frame they
   *  change has been asked for. */
  _onPlayer(ev) {
    if (this.destroyed) return;
    const player = this._player;
    const props = this.props;
    switch (ev.type) {
      case 'player-metadata':
        // a size at last, or a new one: laid out again, and a part to offer
        this.invalidateMeasure('content');
        this.spritesChanged();
        props.onLoadedMetadata?.({
          width: player.width,
          height: player.height,
          duration: player.duration,
          node: this,
        });
        return;
      case 'player-state':
        this._syncPull();
        if (player.playing) props.onPlay?.();
        else props.onPause?.();
        return;
      case 'player-time':
        // a seek while paused shows another frame, which nothing else pulls
        if (!player.playing) this._pullFrame();
        props.onTimeUpdate?.({ currentTime: player.currentTime, node: this });
        return;
      case 'player-ended':
        this._syncPull();
        props.onEnded?.();
        return;
      case 'player-error':
        this.error = player.error;
        if (props.onError) props.onError(player.error);
        else console.warn(player.error.message);
        return;
    }
  }

  /** While the picture is drawn and playing, the frame showing is asked for
   *  every display frame; lifted or paused, nothing is. */
  _syncPull() {
    const want =
      this._player !== null &&
      !this._lifted &&
      this._player.playing &&
      !this.destroyed;
    if (want && this._pull === null) {
      this._pull = setInterval(() => this._pullFrame(), PULL_MS);
      this._pull.unref?.();
    } else if (!want) {
      this._stopPull();
    }
  }

  _stopPull() {
    if (this._pull !== null) clearInterval(this._pull);
    this._pull = null;
  }

  /** The frame showing into the surface, and the picture claimed if it was
   *  a new one. */
  _pullFrame() {
    if (this._lifted || this.destroyed) return;
    if (this._copyPlayerFrame()) this.root?.invalidate(false, this, 'content');
  }

  /** True when a new frame went into the surface. */
  _copyPlayerFrame() {
    const player = this._player;
    if (!player || !(player.width > 0)) return false;
    const surface = this._surfaceFor(player.width, player.height);
    if (!surface) return false;
    const copied = player.copyFrame(surface);
    // another size than the surface: the metadata that says so remakes it
    if (!copied?.written) return false;
    this._playerFrame = true;
    return true;
  }

  _refuse() {
    if (canPlayMedia(this.app)) return;
    this._refused = true;
    const err = new NoMediaPlaybackError();
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

  /** The poster through `<image>`'s own ladder: a file read, bytes decoded
   *  now or — WebP, or anything under Bun — later, raw RGBA or an Image as
   *  it is. A failure is a content failure: said once, and no poster. */
  _loadPoster(src) {
    if (isDirectImageSource(src)) {
      this._poster = src;
      return;
    }
    let decoded;
    try {
      decoded = isPathImageSource(src)
        ? loadImageFile(toLoadablePath(src))
        : decodeImageSource(src);
    } catch (err) {
      console.error('react-x11: <video poster> did not decode:', err.message);
      return;
    }
    if (typeof decoded?.then !== 'function') {
      this._ownedPoster = decoded;
      this._poster = decoded;
      return;
    }
    const token = ++this._posterToken;
    decoded.then(
      (image) => {
        if (!image || token !== this._posterToken || this.destroyed) return;
        this._ownedPoster = image;
        this._poster = image;
        if (!this._sink) this.invalidateMeasure('content');
        else this.root?.invalidate(false, this, 'content');
      },
      (err) => {
        if (token !== this._posterToken || this.destroyed) return;
        console.error(
          `react-x11: <video poster> ${isPathImageSource(src) ? src : 'bytes'} did not load:`,
          err.message,
        );
      },
    );
  }

  // --- layout -------------------------------------------------------------------

  /** The picture's size in source pixels, which are logical pixels — the
   *  browser's rule, and `<image>`'s: a 1280x720 stream is 1280 logical px
   *  wide at any scale. The stream's size once it is known, then the
   *  poster's, then HTML's 300x150. */
  _natural() {
    const sink = this._sink;
    if (sink) return { width: sink.width, height: sink.height };
    const player = this._player;
    if (player?.width > 0 && player?.height > 0) {
      return { width: player.width, height: player.height };
    }
    const poster = this._poster;
    if (poster?.width > 0 && poster?.height > 0) {
      return { width: poster.width, height: poster.height };
    }
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }

  /**
   * HTML's video sizing: a style that names one axis gets the other from
   * the picture's ratio — larger than the stream as well as smaller, which
   * is where a video parts from `<image>` — and a style that names neither
   * gets the stream's size, shrunk to fit what is on offer. Whole pixels:
   * a fractional answer is an input yoga's line arithmetic cannot take.
   */
  measureContent(constraints) {
    this._ensure();
    const s = this.scale;
    const n = this._natural();
    const natural = { width: n.width * s, height: n.height * s };
    const { width, height, widthMode, heightMode } = constraints;
    if (widthMode === 'exactly' && heightMode !== 'exactly') {
      return { width, height: Math.round((width * n.height) / n.width) };
    }
    if (heightMode === 'exactly' && widthMode !== 'exactly') {
      return { width: Math.round((height * n.width) / n.height), height };
    }
    const size = intrinsicSize(natural, constraints);
    return { width: Math.round(size.width), height: Math.round(size.height) };
  }

  /** Where the picture goes in the content box, device pixels, snapped to
   *  whole ones so the hole a lifted picture leaves and the layer that
   *  fills it meet without a seam. */
  _pictureRect(natural) {
    const s = this.scale;
    return fitRect(
      this.contentBox(),
      natural.width * s,
      natural.height * s,
      objectFitOf(this.style, 'contain'),
    );
  }

  // --- props --------------------------------------------------------------------

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    const changed =
      newProps.frames !== before.frames ||
      newProps.src !== before.src ||
      newProps.poster !== before.poster;
    if (changed) validateVideoProps(newProps);
    super.applyProps(newProps, oldProps);
    if (!changed) {
      // the same player, told what changed of how it plays
      if (
        this._player &&
        PLAYER_PROPS.some((name) => newProps[name] !== before[name])
      ) {
        const settings = {};
        for (const name of PLAYER_PROPS) {
          if (newProps[name] !== before[name]) settings[name] = newProps[name];
        }
        this._player.set(settings);
      }
      return;
    }
    const was = this._natural();
    this._detach();
    this._dirty = false;
    this._attach();
    this._releaseSurface();
    this.spritesChanged();
    const now = this._natural();
    if (was.width !== now.width || was.height !== now.height) {
      this.invalidateMeasure('content');
    }
  }

  destroySubtree() {
    this.destroyed = true;
    this._detach();
    this._releaseSurface();
    super.destroySubtree();
  }

  // --- sprites --------------------------------------------------------------------

  /**
   * The picture, as one part whose content is the sink: offered once there
   * is a frame to show, and cut to the content box where `objectFit:
   * 'cover'` makes it larger.
   */
  sprites() {
    if (this.hidden) return null;
    const sink = this._sink;
    const player = this._player;
    // a sink with a frame, or a player that knows its size and works
    const contents = sink?.frame
      ? sink
      : player?.width > 0 && !player.error
        ? player
        : null;
    if (contents === null) return null;
    const rect = this._pictureRect(this._natural());
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const part = { key: 'video', rect, contents };
    const box = this.contentBox();
    if (
      rect.x < box.x ||
      rect.y < box.y ||
      rect.x + rect.width > box.x + box.width ||
      rect.y + rect.height > box.y + box.height
    ) {
      part.clip = box;
    }
    return [part];
  }

  spritesLifted(keys) {
    this._lifted = keys.has('video');
    if (this._player) {
      this._syncPull();
      // given back: the frame showing, for the paint this frame owes it
      if (!this._lifted) this._copyPlayerFrame();
    }
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

  /** Seconds into `src`; a sink's newest frame's time, or 0. */
  get currentTime() {
    if (this._player) return this._player.currentTime;
    return this._sink?.frame?.time ?? 0;
  }

  /** Seconds; `Infinity` for a live stream and for a sink, NaN before it is
   *  known. */
  get duration() {
    if (this._player) return this._player.duration;
    return this._sink ? Infinity : NaN;
  }

  get paused() {
    return this._player ? !this._player.playing : true;
  }

  // --- paint ----------------------------------------------------------------------

  paintContent(ctx) {
    this._ensure();
    const sink = this._sink;
    if (sink?.frame) {
      // the layer is showing it, and the bitmap under it is a hole
      if (this._lifted) return;
      if (this._drawFrame(ctx, sink)) return;
    }
    const player = this._player;
    if (player?.width > 0 && !player.error) {
      if (this._lifted) return;
      if (this._playerFrame || this._copyPlayerFrame()) {
        this._drawFitted(ctx, this._surface, {
          width: player.width,
          height: player.height,
        });
        return;
      }
    }
    const poster = this._poster;
    if (poster?.width > 0 && poster?.height > 0) {
      this._drawFitted(ctx, poster, {
        width: poster.width,
        height: poster.height,
      });
    }
  }

  _drawFitted(ctx, image, natural) {
    const rect = this._pictureRect(natural);
    if (!(rect.width > 0 && rect.height > 0)) return;
    const box = this.contentBox();
    const overflows =
      rect.x < box.x ||
      rect.y < box.y ||
      rect.x + rect.width > box.x + box.width ||
      rect.y + rect.height > box.y + box.height;
    if (overflows) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.width, box.height);
      ctx.clip();
    }
    try {
      ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
    } finally {
      if (overflows) ctx.restore();
    }
  }

  /** The newest frame into the node's surface, if it is not there yet, and
   *  the surface composited. False where there is no surface to be had —
   *  the headless mock — and the poster stands in. */
  _drawFrame(ctx, sink) {
    const frame = sink.frame;
    const surface = this._surfaceFor(sink.width, sink.height);
    if (!surface) return false;
    if (this._drawn !== frame.version) {
      try {
        this._upload(surface, sink, frame);
      } catch (err) {
        if (DEV) {
          console.warn(
            `react-x11: <video> could not draw a frame: ${err?.message ?? err}`,
          );
        }
        return false;
      }
      this._drawn = frame.version;
    }
    this._drawFitted(ctx, surface, { width: sink.width, height: sink.height });
    return true;
  }

  _upload(surface, sink, frame) {
    // natively where the backend converts in its own code (the Cocoa
    // bridge's writeVideoSurface: a copy for BGRA, VideoToolbox for YCbCr,
    // colour-matched to what a layer shows)
    if (this.app?.writeVideoFrame?.(surface, sink, frame)) return;
    const w = sink.width;
    const h = sink.height;
    if (this._rgba?.width !== w || this._rgba?.height !== h) {
      this._rgba = {
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      };
    }
    frameToRGBA(sink, frame, this._rgba.data);
    surface.render((sctx) => sctx.putImageData(this._rgba, 0, 0));
  }

  _surfaceFor(width, height) {
    const kept = this._surface;
    if (kept && kept.width === width && kept.height === height) return kept;
    this._releaseSurface();
    this._playerFrame = false;
    const app = this.app;
    if (!app?.display?.Render && typeof app?.createSurface !== 'function') {
      return null;
    }
    try {
      this._surface = new Surface(app, { width, height });
    } catch {
      this._surface = null;
    }
    this._drawn = -1;
    return this._surface;
  }

  _releaseSurface() {
    const surface = this._surface;
    this._surface = null;
    this._rgba = null;
    this._drawn = -1;
    try {
      surface?.destroy();
    } catch {
      // gone with its connection
    }
  }
}
