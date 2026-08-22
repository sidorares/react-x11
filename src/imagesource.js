// What `<image>` can show beyond a file path (issue #367): in-memory pixels
// — encoded bytes, raw RGBA, an ntk `Image` — and pictures that already live
// on the server, composited without a pixel ever crossing the wire.
//
// The split follows `decorations.js`: classification, validation, decoding
// and the `cacheKey` cache live here, where a test needs no server; the node
// half in nodes.js is only lifecycle — when to resolve, when to claim
// damage, when to let go.
import { Image, Picture, decodeImage } from 'ntk';

/**
 * A client-side object the 2d context composites as-is: an ntk `Image` or
 * `Surface`, or anything with a size and a `picture(app)`. The same
 * duck-typing ntk's own `drawImage` uses, so the two answers cannot drift —
 * whatever passes here is something the paint will accept.
 */
export function isDirectImageSource(src) {
  return (
    src != null &&
    typeof src === 'object' &&
    typeof src.picture === 'function' &&
    Number.isFinite(src.width) &&
    Number.isFinite(src.height)
  );
}

/**
 * A file path or file URL. URLs are matched structurally, mirroring the
 * declared `FileUrl` — the declarations use only ES lib types, so `URL`
 * cannot be named there, and the runtime accepting exactly what the type
 * accepts is what keeps the two from disagreeing.
 */
export function isPathImageSource(src) {
  if (typeof src === 'string' || src instanceof URL) return true;
  return (
    src != null &&
    typeof src === 'object' &&
    typeof src.href === 'string' &&
    typeof src.protocol === 'string'
  );
}

/** …normalized for ntk's `loadImage`, which wants a string or a real URL. */
export const toLoadablePath = (src) =>
  typeof src === 'string' || src instanceof URL ? src : new URL(src.href);

/** Raw straight-RGBA pixels: `{ width, height, data }` — the shape
 * `getImageData` hands back. (A `Buffer` of encoded bytes is a `Uint8Array`
 * subclass, so the two byte forms are one check elsewhere.) */
export function isRawImageSource(src) {
  return (
    src != null &&
    typeof src === 'object' &&
    !(src instanceof Uint8Array) &&
    !isPathImageSource(src) &&
    !isDirectImageSource(src) &&
    'data' in src
  );
}

const positiveInt = (v) => Number.isInteger(v) && v > 0;

const describe = (value) =>
  value === null
    ? 'null'
    : typeof value === 'object'
      ? (value.constructor?.name ?? 'an object')
      : typeof value;

/** Stated once, so every error lists the same set of accepted forms. */
const SRC_FORMS =
  'a file path or file URL (PNG/JPEG), encoded PNG/JPEG bytes (Buffer or ' +
  'Uint8Array), raw RGBA ({ width, height, data }), or an ntk Image/Surface';

function validateServerSource(kind, desc) {
  const shape =
    kind === 'drawable'
      ? '{ id, width, height, depth? }'
      : '{ id, width, height }';
  const explain =
    `react-x11: <image ${kind}> takes ${shape} — the ${kind === 'picture' ? 'Picture' : 'Pixmap/Window'}'s ` +
    'X id and its size in pixels. The size is stated by the caller because ' +
    'asking the server for it would be a round trip, which this prop exists to avoid.';
  if (desc == null || typeof desc !== 'object') {
    throw new Error(`${explain} Got ${describe(desc)}.`);
  }
  if (!positiveInt(desc.id)) {
    throw new Error(
      `${explain} \`id\` must be an X resource id, got ${desc.id}.`,
    );
  }
  if (!positiveInt(desc.width) || !positiveInt(desc.height)) {
    throw new Error(
      `${explain} Got a size of ${desc.width}x${desc.height} for id ${desc.id}.`,
    );
  }
  if (
    kind === 'drawable' &&
    desc.depth != null &&
    !(desc.depth in DEPTH_FORMATS)
  ) {
    throw new Error(
      `react-x11: <image drawable> supports depth 24 (rgb, the default), 32 ` +
        `(argb) and 8 (alpha only, composited as ink through its coverage) — ` +
        `got ${desc.depth}. A depth the RENDER standard formats do not cover ` +
        `cannot be composited without knowing the visual, so wrap the drawable ` +
        `in a Picture yourself and pass <image picture>.`,
    );
  }
}

function validateRawSource(src) {
  if (!positiveInt(src.width) || !positiveInt(src.height)) {
    throw new Error(
      'react-x11: <image src={{ width, height, data }}> needs positive ' +
        `integer dimensions, got ${src.width}x${src.height}.`,
    );
  }
  const { data } = src;
  const bytes =
    data instanceof Uint8Array || data instanceof Uint8ClampedArray
      ? data.length
      : null;
  const want = src.width * src.height * 4;
  if (bytes !== want) {
    throw new Error(
      'react-x11: <image src={{ width, height, data }}> wants straight ' +
        '(non-premultiplied) RGBA bytes — data.length must be ' +
        `width × height × 4 = ${want}, got ${bytes ?? describe(data)}. ` +
        'For encoded PNG/JPEG bytes pass the buffer itself as `src`.',
    );
  }
}

/**
 * Structural validation for the source props, at prop-arrival time — so the
 * throw lands in render/commit where React can report it against the
 * component, never inside a layout or paint pass. Content failures (a file
 * that is not there, bytes that do not decode) are not structural and are
 * handled where they surface: logged, and the element shows nothing.
 */
export function validateImageProps(props) {
  const named = ['src', 'picture', 'drawable'].filter((k) => props[k] != null);
  if (named.length > 1) {
    throw new Error(
      `react-x11: <image> shows one source, got ${named.length} ` +
        `(${named.join(', ')}). Pass exactly one of \`src\` (client-side ` +
        'pixels), `picture` (an existing server-side Picture) or `drawable` ' +
        '(an existing server-side Pixmap/Window).',
    );
  }
  if (
    props.cacheKey != null &&
    (props.picture != null || props.drawable != null)
  ) {
    throw new Error(
      'react-x11: <image cacheKey> names decoded client-side pixels, and a ' +
        '`picture`/`drawable` is already server-side — there is nothing to ' +
        'cache. Drop the cacheKey; the composite is already upload-free.',
    );
  }
  if (props.picture != null) validateServerSource('picture', props.picture);
  if (props.drawable != null) validateServerSource('drawable', props.drawable);
  const src = props.src;
  if (src == null) return;
  if (isPathImageSource(src)) return;
  if (src instanceof Uint8Array) return;
  if (isDirectImageSource(src)) return;
  if (typeof src === 'object' && 'data' in src) return validateRawSource(src);
  throw new Error(
    `react-x11: <image src> must be ${SRC_FORMS} — got ${describe(src)}.`,
  );
}

/**
 * Decode a synchronous source into an ntk `Image`: encoded bytes through the
 * PNG/JPEG decoders, raw RGBA wrapped as-is (no copy — the object is treated
 * as immutable content from here on). File paths stay async and do not come
 * here. May throw on corrupt bytes; the caller treats that as a content
 * failure, because encoded bytes usually arrive from outside the program.
 */
export function decodeImageSource(src) {
  if (src instanceof Uint8Array) return decodeImage(src);
  return new Image({ width: src.width, height: src.height, data: src.data });
}

const sameServerSource = (a, b) =>
  (a?.id ?? null) === (b?.id ?? null) &&
  (a?.width ?? null) === (b?.width ?? null) &&
  (a?.height ?? null) === (b?.height ?? null) &&
  (a?.depth ?? null) === (b?.depth ?? null);

/**
 * Did the *content* behind the source props change?
 *
 * By value for the server descriptors — React rebuilds inline objects every
 * render, and `{ id: 7, … }` is the same picture however fresh the object.
 * By identity for client sources, except that an unchanged `cacheKey`
 * vouches for a rebuilt buffer: same key, same picture. A direct source (an
 * ntk `Image`) is its own identity, so the key never overrides one — a
 * caller switching between bytes and an `Image` under a stable key still
 * gets the switch.
 */
export function imageSourceChanged(next, prev) {
  if (!sameServerSource(next.picture, prev.picture)) return true;
  if (!sameServerSource(next.drawable, prev.drawable)) return true;
  if (next.cacheKey !== prev.cacheKey) return true;
  if (next.src === prev.src) return false;
  if ((next.src == null) !== (prev.src == null)) return true;
  if (isDirectImageSource(next.src) || isDirectImageSource(prev.src))
    return true;
  return next.cacheKey == null;
}

// --- the cacheKey cache -----------------------------------------------------
//
// ntk's `Image` already caches its server upload per connection; what it
// cannot know is that the buffer an app re-derived this render is the same
// picture as last render's. `cacheKey` is the caller saying so — the same
// contract as `<canvas cacheKey>`: the key names the content, and two
// `<image>`s with one key share one decoded image and one upload.
//
// Refcounted rather than LRU, unlike the paint cache, for two reasons: an
// entry holds a server pixmap, the resource X gives no back-pressure on, and
// unlike a rendered widget an image cannot be re-made from its key once the
// source is gone. So an entry lives exactly as long as some mounted <image>
// holds it and is freed with the last one; a remount decodes again, which is
// the honest cost of not keeping dead pixmaps around.

/** app -> Map<key, entry>. Per connection, because the upload is. */
const sourceCaches = new WeakMap();

/**
 * Take a hold on the entry for `key`, creating it with `load()` on first
 * use. `load` returns `{ image }` for a synchronous source or `{ promise }`
 * for a file read — the promise resolves an `Image` or, on content failure,
 * `null` (never rejects; the loader reports the failure once, not per
 * holder). Every acquire is paired with a `releaseImageSource`.
 */
export function acquireImageSource(app, key, load) {
  let cache = sourceCaches.get(app);
  if (!cache) sourceCaches.set(app, (cache = new Map()));
  let entry = cache.get(key);
  if (!entry) {
    entry = { key, refs: 0, image: null, promise: null, released: false };
    cache.set(key, entry);
    const made = load();
    if (made.promise) {
      entry.promise = made.promise.then((image) => {
        entry.promise = null;
        // every holder unmounted while it decoded — free, don't adopt
        if (entry.released) {
          image?.destroy();
          return null;
        }
        entry.image = image;
        return image;
      });
    } else {
      entry.image = made.image;
    }
  }
  entry.refs++;
  return entry;
}

/** Drop one hold; the last one out frees the entry and its server upload. */
export function releaseImageSource(app, entry) {
  if (--entry.refs > 0) return;
  sourceCaches.get(app)?.delete(entry.key);
  entry.released = true;
  entry.image?.destroy();
  entry.image = null;
}

// --- server-side sources ----------------------------------------------------

/** RENDER's depth-implied standard formats — the ones a drawable can be
 * composited through without knowing its visual. */
const DEPTH_FORMATS = { 8: 'a8', 24: 'rgb24', 32: 'rgba32' };

/**
 * An existing server-side Picture, as a source `drawImage` accepts: showing
 * it is one `RenderComposite` — no `PutImage`, no readback, no round trip.
 *
 * The picture is the caller's: nothing here creates or frees anything. The
 * one liberty taken is temporary — drawing it *scaled* sets the picture's
 * transform and filter for the composite and resets them to
 * identity/nearest after, which is the same bracket ntk puts around its own
 * cached uploads. A picture that must keep a transform of its own should be
 * composited 1:1 (style the box to the stated size).
 */
export class PictureSource {
  constructor(app, { id, width, height }) {
    this.app = app;
    this.id = id;
    this.width = width;
    this.height = height;
    this._handle = null;
  }

  /** Built on first paint, so a headless tree never touches Render. */
  picture() {
    return (this._handle ??= {
      id: this.id,
      setFilter: (name, params) =>
        this.app.display.Render.SetPictureFilter(this.id, name, params),
    });
  }
}

/**
 * An existing server-side Pixmap or Window, composited through a Picture
 * created over it — created lazily at first paint, owned here, freed by
 * `destroy()`. The drawable itself stays the caller's.
 *
 * `depth` picks the picture format and defaults to 24, the screen's default
 * depth — what a window pixmap from Composite's `NameWindowPixmap` is. A
 * caller with an ARGB drawable says 32; 8 composites as ink through its
 * alpha, which is what previewing a mask looks like. A wrong depth is a
 * server-side BadMatch, which is why the mismatch the client *can* catch
 * (an unsupported number) throws in validation instead.
 */
export class DrawableSource {
  constructor(app, { id, width, height, depth = 24 }) {
    this.app = app;
    this.id = id;
    this.width = width;
    this.height = height;
    this.depth = depth;
    this._picture = null;
  }

  picture() {
    if (!this._picture) {
      const Render = this.app.display.Render;
      this._picture = new Picture(this.app, {
        drawable: { id: this.id },
        format: Render[DEPTH_FORMATS[this.depth]],
      });
    }
    return this._picture;
  }

  destroy() {
    this._picture?.destroy();
    this._picture = null;
  }
}
