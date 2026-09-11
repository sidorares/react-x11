// <image>: an image source, loaded or decoded, sized from its intrinsic size
// and drawn into the node's box.

import {
  DrawableSource,
  PictureSource,
  acquireImageSource,
  decodeImageSource,
  imageSourceChanged,
  isDirectImageSource,
  isPathImageSource,
  isRawImageSource,
  releaseImageSource,
  toLoadablePath,
  validateImageProps,
} from '../imagesource.js';
// Namespace import for `Surface`, the same shape and the same reason as
// `paintcache.js`: a named import of something an older ntk does not export
// is a *load-time* SyntaxError, which would take the renderer down rather
// than the one feature that needs it.
import * as ntk from 'ntk';
import { intrinsicSize } from './layout.js';
import { Node } from './node.js';
import { DEV } from './util.js';

/** The props `ImageNode.applyProps` diffs by value itself, kept out of the
 * base class's identity walk — a buffer rebuilt under an unchanged
 * `cacheKey` and a `{ id, … }` descriptor rebuilt with the same numbers are
 * both "nothing changed". */
const IMAGE_SOURCE_PROPS = new Set(['src', 'picture', 'drawable', 'cacheKey']);

export class ImageNode extends Node {
  constructor(props, app) {
    super('image', props, app);
    validateImageProps(props);
    this.image = null;
    this._loadToken = 0;
    /** hold on the `cacheKey` cache entry, when one is held */
    this._hold = null;
    /** an Image decoded for this node alone (no cacheKey), freed on release */
    this._ownedImage = null;
    /** PictureSource/DrawableSource, when the source is server-side */
    this._serverSource = null;
    // Resolution waits for the first layout/paint: the constructor runs in
    // the render phase, which React may discard, and resolving here would
    // start file reads and take cache holds nothing would ever release.
    this._sourceDirty = true;
  }

  get selfDamagedProps() {
    return IMAGE_SOURCE_PROPS;
  }

  paintChanged(next, prev) {
    return imageSourceChanged(next, prev) || super.paintChanged(next, prev);
  }

  /** The source's size, kept to its aspect ratio. Read per measure rather
   * than once, because a decode can arrive late.
   *
   * Source pixels are *logical* pixels, the browser's rule: a 100px-wide
   * PNG occupies 100 logical px at any display scale (upscaled onto the
   * device grid at 2x, the way an `<img>` without `srcset` is), rather
   * than shrinking to half its neighbours' size. The constraints are
   * already device, so only the natural size converts (src/scale.js). */
  measureContent(constraints) {
    this._ensureSource();
    const s = this.scale;
    return intrinsicSize(
      {
        width: (this.image?.width ?? 0) * s,
        height: (this.image?.height ?? 0) * s,
      },
      constraints,
    );
  }

  /** First layout or paint after a mount or a source change — both run
   * after commit, so an instance a concurrent render threw away never
   * resolves anything. */
  _ensureSource() {
    if (!this._sourceDirty || this.destroyed) return;
    this._sourceDirty = false;
    this._resolveSource();
  }

  _resolveSource() {
    const { src, picture, drawable, cacheKey } = this.props;
    if (picture != null || drawable != null) {
      this._serverSource =
        picture != null
          ? new PictureSource(this.app, picture)
          : new DrawableSource(this.app, drawable);
      this.image = this._serverSource;
      return;
    }
    if (src == null) return;
    if (isDirectImageSource(src)) {
      // the caller's object — its upload cache is the dedupe, and it is
      // never destroyed here
      this.image = src;
      return;
    }
    if (cacheKey != null) {
      const entry = acquireImageSource(this.app, cacheKey, () =>
        this._loadEntry(src),
      );
      this._hold = entry;
      if (entry.image) {
        this.image = entry.image;
        if (DEV) this._devCheckCacheKey(src, entry.image, cacheKey);
      } else {
        entry.promise?.then((image) => {
          if (image && this._hold === entry && !this.destroyed) {
            this._setImage(image);
          }
        });
      }
      return;
    }
    if (isPathImageSource(src)) {
      this._loadFile(src);
      return;
    }
    const image = this._decode(src);
    if (image) {
      this._ownedImage = image;
      this.image = image;
    }
  }

  /** `{ image }` or `{ promise }` for the cache. Failures resolve to null
   * and are reported once, here — not per node holding the key. */
  _loadEntry(src) {
    if (isPathImageSource(src)) {
      return {
        promise: ntk.loadImage(toLoadablePath(src)).then(
          (image) => image,
          (err) => {
            console.error(
              `react-x11: failed to load image ${src}:`,
              err.message,
            );
            return null;
          },
        ),
      };
    }
    return { image: this._decode(src) };
  }

  _decode(src) {
    try {
      return decodeImageSource(src);
    } catch (err) {
      // corrupt or unrecognized bytes are a content failure, not a
      // programming error: log and show nothing, like a missing file
      console.error(
        'react-x11: <image src> bytes did not decode:',
        err.message,
      );
      return null;
    }
  }

  async _loadFile(src) {
    const token = ++this._loadToken;
    try {
      const image = await ntk.loadImage(toLoadablePath(src));
      if (token !== this._loadToken || this.destroyed) return;
      this._ownedImage = image;
      this._setImage(image);
    } catch (err) {
      if (token === this._loadToken && !this.destroyed) {
        console.error(`react-x11: failed to load image ${src}:`, err.message);
      }
    }
  }

  /** Adopt pixels that arrived after the frame that asked for them. A size
   * change reflows; same-size new pixels claim only this node's box. */
  _setImage(image) {
    const prev = this.image;
    this.image = image;
    if (
      (prev?.width ?? 0) !== (image?.width ?? 0) ||
      (prev?.height ?? 0) !== (image?.height ?? 0)
    ) {
      this.invalidateMeasure('content');
    } else {
      this.root?.invalidate(false, this, 'content');
    }
  }

  /** Two different pictures sharing one cacheKey is the one mistake this
   * design can make show stale pixels; the raw form carries enough to catch
   * the common case cheaply. */
  _devCheckCacheKey(src, image, key) {
    if (!isRawImageSource(src)) return;
    if (src.width === image.width && src.height === image.height) return;
    console.error(
      `react-x11: <image cacheKey=${JSON.stringify(key)}> is ` +
        `${image.width}x${image.height} in the cache, but this src says ` +
        `${src.width}x${src.height}. Two different pictures are sharing one ` +
        'cacheKey — the key must name the content, so include whatever ' +
        'distinguishes them.',
    );
  }

  _releaseSource() {
    this._loadToken++; // orphan any in-flight file read
    if (this._hold) {
      releaseImageSource(this.app, this._hold);
      this._hold = null;
    }
    if (this._ownedImage) {
      // frees the per-app upload; the caller's own Images are never here
      this._ownedImage.destroy();
      this._ownedImage = null;
    }
    if (this._serverSource) {
      this._serverSource.destroy?.();
      this._serverSource = null;
    }
    this.image = null;
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    const sourceChanged = imageSourceChanged(newProps, before);
    // before super touches anything, so a bad update leaves the node whole
    if (sourceChanged) validateImageProps(newProps);
    super.applyProps(newProps, oldProps);
    if (!sourceChanged) return;
    const prev = this.image;
    this._releaseSource();
    this._sourceDirty = false;
    this._resolveSource();
    // paintChanged already claimed this node's box through super; only a
    // new intrinsic size needs more than that
    if (
      (prev?.width ?? 0) !== (this.image?.width ?? 0) ||
      (prev?.height ?? 0) !== (this.image?.height ?? 0)
    ) {
      this.invalidateMeasure('content');
    }
  }

  destroySubtree() {
    this._releaseSource();
    super.destroySubtree();
  }

  paintContent(ctx) {
    this._ensureSource();
    if (!this.image) return;
    const content = this.contentBox();
    ctx.drawImage(
      this.image,
      content.x,
      content.y,
      content.width,
      content.height,
    );
  }
}
