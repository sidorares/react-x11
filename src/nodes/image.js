// <image>: an image source, loaded or decoded, sized from its intrinsic size
// and drawn into the node's box.

import {
  DrawableSource,
  PictureSource,
  acquireImageSource,
  decodeImageSource,
  freeImage,
  imageSourceChanged,
  isDirectImageSource,
  isPathImageSource,
  isRawImageSource,
  isSymbolImageSource,
  releaseImageSource,
  toLoadablePath,
  validateImageProps,
} from '../imagesource.js';
import { loadImageFile } from '../imagedecode.js';
import { symbolWeight, symbolsFor, warnOnce } from '../symbols.js';
import { fitRect, objectFitOf } from './fit.js';
import { intrinsicSize } from './layout.js';
import { Node } from './node.js';
import { DEV } from './util.js';

/** The props `ImageNode.applyProps` diffs by value itself, kept out of the
 * base class's identity walk — a buffer rebuilt under an unchanged
 * `cacheKey` and a `{ id, … }` descriptor rebuilt with the same numbers are
 * both "nothing changed". */
const IMAGE_SOURCE_PROPS = new Set(['src', 'picture', 'drawable', 'cacheKey']);

const BYTES_FAILED = 'react-x11: <image src> bytes did not decode:';

/** A load that never rejects: a failure is logged and resolves null. */
const reported = (promise, prefix) =>
  promise.then(
    (image) => image,
    (err) => {
      console.error(prefix, err.message);
      return null;
    },
  );

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
    /** `{ symbol, … }`, when the source is a name the platform draws */
    this._symbol = null;
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
    if (this._symbol) {
      const name = this._symbol.symbol;
      const size = symbolsFor(this.app).size(name, this._symbolOptions());
      // A name this desktop does not have takes no room and draws nothing,
      // which is right for an app that runs on both and wrong for a typo —
      // development tells the two apart for it.
      if (!size) {
        warnOnce(
          `react-x11: <image src={{ symbol: ${JSON.stringify(name)} }}> is ` +
            'not a symbol this desktop has, so it takes no room and draws ' +
            'nothing. SF Symbols are the names on macOS, and the icon ' +
            "theme's names, like 'audio-volume-high', elsewhere.",
        );
      }
      return intrinsicSize(
        { width: (size?.width ?? 0) * s, height: (size?.height ?? 0) * s },
        constraints,
      );
    }
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
    if (isSymbolImageSource(src)) {
      // nothing to load: the platform draws the name at paint, which is also
      // when the text colour it is drawn in is known
      this._symbol = src;
      return;
    }
    if (isDirectImageSource(src)) {
      // the caller's object — its upload cache is the dedupe, and it is
      // never destroyed here
      this.image = src;
      return;
    }
    if (cacheKey != null) {
      const entry = acquireImageSource(this.app, cacheKey, () =>
        this._load(src),
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
    const { image, promise } = this._load(src);
    if (image) {
      this._ownedImage = image;
      this.image = image;
    } else if (promise) {
      this._adopt(promise);
    }
  }

  /**
   * `{ image }` for a source decoded on the spot, `{ promise }` for a file
   * read or a decode that lands later — off the JavaScript thread under
   * Bun, or behind a decoder loaded on demand. The promise resolves an
   * Image, or null on a content failure, which is reported once, here: not
   * per node holding the key.
   */
  _load(src) {
    if (isPathImageSource(src)) {
      return {
        promise: reported(
          loadImageFile(toLoadablePath(src)),
          `react-x11: failed to load image ${src}:`,
        ),
      };
    }
    let decoded;
    try {
      decoded = decodeImageSource(src);
    } catch (err) {
      // corrupt or unrecognized bytes are a content failure, not a
      // programming error: log and show nothing, like a missing file
      console.error(BYTES_FAILED, err.message);
      return { image: null };
    }
    return typeof decoded?.then === 'function'
      ? { promise: reported(decoded, BYTES_FAILED) }
      : { image: decoded };
  }

  /** Take an Image that lands after the frame that asked for it — unless
   * the source changed or the node went first, in which case it was never
   * painted, so nothing was uploaded and there is nothing to free. */
  async _adopt(promise) {
    const token = ++this._loadToken;
    const image = await promise;
    if (!image || token !== this._loadToken || this.destroyed) return;
    this._ownedImage = image;
    this._setImage(image);
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
    this._loadToken++; // orphan any in-flight read or decode
    if (this._hold) {
      releaseImageSource(this.app, this._hold);
      this._hold = null;
    }
    if (this._ownedImage) {
      // frees the per-app upload; the caller's own Images are never here
      freeImage(this.app, this._ownedImage);
      this._ownedImage = null;
    }
    if (this._serverSource) {
      this._serverSource.destroy?.();
      this._serverSource = null;
    }
    this._symbol = null;
    this.image = null;
  }

  /**
   * How a symbol is drawn beside the text around it: at that text's size and
   * weight unless the source says otherwise — what SF Symbols are designed
   * for, and what lets a toolbar of them follow a theme's `fontSize` — in its
   * colour, which is `currentColor` for an `<svg>` too. Sizes are logical.
   */
  _symbolOptions() {
    const text = this.resolvedTextStyle();
    const src = this._symbol;
    return {
      pointSize: text.size / this.scale,
      weight: symbolWeight(src.weight ?? text.weight),
      scale: src.scale,
      variableValue: src.variableValue,
      displayScale: this.scale,
      color: text.color,
    };
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    const sourceChanged = imageSourceChanged(newProps, before);
    // before super touches anything, so a bad update leaves the node whole
    if (sourceChanged) validateImageProps(newProps);
    super.applyProps(newProps, oldProps);
    if (!sourceChanged) return;
    const prev = this.image;
    const wasSymbol = this._symbol;
    this._releaseSource();
    this._sourceDirty = false;
    this._resolveSource();
    // paintChanged already claimed this node's box through super; only a
    // new intrinsic size needs more than that — and a symbol's size is the
    // platform's to say, so any change to one is measured again
    if (
      wasSymbol ||
      this._symbol ||
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
    if (this._symbol) {
      symbolsFor(this.app).draw(
        ctx,
        this._symbol.symbol,
        this.contentBox(),
        this._symbolOptions(),
      );
      return;
    }
    if (!this.image) return;
    const content = this.contentBox();
    const fit = objectFitOf(this.style, 'fill');
    if (fit === 'fill') {
      ctx.drawImage(
        this.image,
        content.x,
        content.y,
        content.width,
        content.height,
      );
      return;
    }
    // the source's size in device pixels, as `measureContent` takes it
    const s = this.scale;
    const rect = fitRect(
      content,
      (this.image.width ?? 0) * s,
      (this.image.height ?? 0) * s,
      fit,
    );
    if (!(rect.width > 0 && rect.height > 0)) return;
    const inside =
      rect.x >= content.x &&
      rect.y >= content.y &&
      rect.x + rect.width <= content.x + content.width &&
      rect.y + rect.height <= content.y + content.height;
    if (!inside) {
      // `cover`, and `none` larger than the box: cut to the content box
      ctx.save();
      ctx.beginPath();
      ctx.rect(content.x, content.y, content.width, content.height);
      ctx.clip();
    }
    try {
      ctx.drawImage(this.image, rect.x, rect.y, rect.width, rect.height);
    } finally {
      if (!inside) ctx.restore();
    }
  }
}
