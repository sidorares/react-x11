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
// `useSupports('mediaPlayback')` says so. Where it has none the element says
// so once, through `onError`, and shows its poster — never a black box that
// looks like a video that has not started (#531's rule for `<foreign>`).

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
      this._refuse();
    }
    if (poster != null) this._loadPoster(poster);
  }

  _detach() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._sink = null;
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
    if (!changed) return;
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
    const sink = this._sink;
    if (!sink?.frame || this.hidden) return null;
    const rect = this._pictureRect(this._natural());
    if (!(rect.width > 0 && rect.height > 0)) return null;
    const part = { key: 'video', rect, contents: sink };
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
