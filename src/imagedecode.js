// Encoded image bytes → an ntk `Image` of straight RGBA, through the best
// decoder this runtime has. A ladder, tried in order:
//
//   1. The runtime's own: `Bun.Image` under Bun. libjpeg-turbo, spng and
//      libwebp linked into the runtime, GIF and BMP everywhere, and TIFF,
//      HEIC and AVIF through the system's codecs on macOS and Windows — all
//      run on a worker thread. That is the reason to prefer it even for
//      the formats the next rung can do: a 1080p JPEG costs the JavaScript
//      thread ~7ms here against ~110ms inside jpeg-js (a 1080p PNG, ~5ms
//      against ~150ms in pngjs), and a decode on the JavaScript thread is
//      frames nobody gets. Found by its constructor, never by asking which
//      runtime this is.
//   2. JavaScript. ntk's PNG and JPEG decoders (pngjs, jpeg-js), which are
//      synchronous, and WebP through image-in-browser's decoder — imported
//      the first time a WebP arrives, because evaluating it takes ~140ms
//      that an app showing no WebP should never pay at startup.
//
// Two things here are easy to undo:
//
// - `Bun.Image` has no raw-pixel output: every terminal re-encodes. The
//   cheapest round trip is a PNG at compression level 0 — stored deflate
//   blocks, every row filtered None — which `storedPngImage` unwraps with
//   one native inflate and a row copy. Reading that PNG with pngjs instead
//   costs 80-130ms of the JavaScript thread at 1080p — all of what moving
//   the decode off it saved.
// - Bun's WebP decode is libwebp's still-image decoder, which refuses an
//   animation outright (Bun 1.4.0). An animated WebP that Bun turns down
//   goes to the JavaScript decoder for its first frame, which is what an
//   `<image>` shows of any animation; asking Bun first keeps a later Bun that
//   can do it on the fast rung.
import { Image, decodeImage } from 'ntk/image';

/** `Bun.Image`, where the runtime has one. Read per call: it is one
 * property lookup, and a cached answer would hide a test's stand-in. */
function runtimeDecoder() {
  const decoder = globalThis.Bun?.Image;
  return typeof decoder === 'function' ? decoder : null;
}

const ascii = (bytes, at, text) => {
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
};

/** ISO-BMFF major brands of a HEIF still image; AVIF is told apart first. */
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1']);

/**
 * The format a buffer's first bytes name, or null. The bytes, never a file
 * extension, say what an image is — which is how Bun and ntk tell too.
 */
export function imageFormat(bytes) {
  if (bytes.length >= 8 && ascii(bytes, 1, 'PNG') && bytes[0] === 0x89) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'jpeg';
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 'RIFF') &&
    ascii(bytes, 8, 'WEBP')
  ) {
    return 'webp';
  }
  if (bytes.length >= 6 && ascii(bytes, 0, 'GIF8')) return 'gif';
  if (bytes.length >= 14 && ascii(bytes, 0, 'BM')) return 'bmp';
  if (
    bytes.length >= 4 &&
    ((ascii(bytes, 0, 'II') && bytes[2] === 42 && bytes[3] === 0) ||
      (ascii(bytes, 0, 'MM') && bytes[2] === 0 && bytes[3] === 42))
  ) {
    return 'tiff';
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 'ftyp')) {
    if (ascii(bytes, 8, 'avif') || ascii(bytes, 8, 'avis')) return 'avif';
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    if (HEIF_BRANDS.has(brand)) return 'heic';
  }
  return null;
}

/** An extended-format WebP whose VP8X chunk says it is animated. */
export function isAnimatedWebP(bytes) {
  return (
    bytes.length >= 21 &&
    ascii(bytes, 0, 'RIFF') &&
    ascii(bytes, 8, 'WEBP') &&
    ascii(bytes, 12, 'VP8X') &&
    (bytes[20] & 0x02) !== 0
  );
}

const NAMES = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
  gif: 'GIF',
  bmp: 'BMP',
  tiff: 'TIFF',
  heic: 'HEIC',
  avif: 'AVIF',
};

const hex = (bytes) =>
  Array.from(bytes.subarray(0, 8), (b) => b.toString(16).padStart(2, '0'))
    .join(' ')
    .trim();

/**
 * Decode encoded bytes: an `Image`, or a promise of one where the decode
 * runs off the JavaScript thread (Bun) or its decoder loads on demand (WebP
 * elsewhere). Throws — or rejects — on bytes that are not an image this
 * runtime can decode, with what to do about it.
 *
 * The bytes are read, never written, and under Bun they are read on another
 * thread after this returns: the caller must not change them meanwhile,
 * which `<image>`'s contract (a source is immutable content) already says.
 */
export function decodeImageBytes(bytes) {
  if (bytes.length === 0) {
    throw new Error('react-x11: an empty buffer is not an image.');
  }
  const decoder = runtimeDecoder();
  if (decoder) return decodeWithRuntime(decoder, bytes);
  const format = imageFormat(bytes);
  if (format === 'png' || format === 'jpeg') return decodeImage(bytes);
  if (format === 'webp') return decodeWebP(bytes);
  if (format) {
    throw new Error(
      `react-x11: ${NAMES[format]} needs a decoder this runtime does not ` +
        'have. Under Node, <image> decodes PNG, JPEG and WebP; under Bun it ' +
        'decodes GIF and BMP too, and TIFF, HEIC and AVIF on macOS and ' +
        'Windows. Convert the image, or run the app with Bun.',
    );
  }
  throw new Error(
    'react-x11: these bytes are not an image format react-x11 recognizes ' +
      `(PNG, JPEG or WebP; more under Bun) — they begin ${hex(bytes)}.`,
  );
}

/** Read a file path or file URL and decode it. */
export async function loadImageFile(path) {
  const { readFile } = await import('node:fs/promises');
  return decodeImageBytes(await readFile(path));
}

async function decodeWithRuntime(BunImage, bytes) {
  // Bun borrows the bytes on its worker thread and refuses a shared or a
  // resizable buffer; those, and only those, it is handed a copy of
  const input =
    bytes.buffer instanceof ArrayBuffer && !bytes.buffer.resizable
      ? bytes
      : bytes.slice();
  let png;
  try {
    png = await new BunImage(input).png({ compressionLevel: 0 }).bytes();
  } catch (err) {
    if (err?.code === 'ERR_IMAGE_DECODE_FAILED' && isAnimatedWebP(bytes)) {
      return decodeWebP(bytes);
    }
    if (err?.code === 'ERR_IMAGE_FORMAT_UNSUPPORTED') {
      const name = NAMES[imageFormat(bytes)] ?? 'This format';
      throw new Error(
        `react-x11: ${name} has no decoder on this machine. Bun decodes ` +
          "TIFF, HEIC and AVIF through the system's codecs — ImageIO on " +
          'macOS, WIC on Windows (HEIC and AVIF need the HEIF and AV1 ' +
          'extensions from the Microsoft Store) — and Linux has none. ' +
          'Convert the image to PNG, JPEG or WebP.',
        { cause: err },
      );
    }
    throw err;
  }
  return storedPngImage(png) ?? decodeImage(png);
}

const IHDR = 0x49484452;
const IDAT = 0x49444154;
const IEND = 0x49454e44;

/**
 * The pixels of the PNG `Bun.Image` re-encodes into, without pngjs: 8-bit
 * RGBA, not interlaced, every row filtered None — what
 * `png({ compressionLevel: 0 })` writes — read with one native inflate and a
 * row copy. Null for any other PNG, which pngjs reads instead: correct, and
 * slower, so a Bun that changes what it writes degrades rather than breaks.
 */
export function storedPngImage(png) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  const chunks = [];
  let total = 0;
  for (let at = 8; at + 12 <= png.length;) {
    const length = view.getUint32(at);
    const type = view.getUint32(at + 4);
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === IHDR) {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      // bit depth 8, colour type 6 (RGBA), no interlace
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) return null;
    } else if (type === IDAT) {
      chunks.push(body);
      total += length;
    } else if (type === IEND) {
      break;
    }
    at += 12 + length;
  }
  if (!width || !height || !chunks.length) return null;
  let stream = chunks[0];
  if (chunks.length > 1) {
    stream = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      stream.set(chunk, at);
      at += chunk.length;
    }
  }
  // windowBits 15: the zlib wrapper PNG puts around its deflate stream
  const rows = globalThis.Bun.inflateSync(stream, { windowBits: 15 });
  const stride = width * 4;
  if (rows.length !== height * (stride + 1)) return null;
  const data = new Uint8Array(height * stride);
  for (let y = 0, from = 0; y < height; y++, from += stride + 1) {
    if (rows[from] !== 0) return null;
    data.set(rows.subarray(from + 1, from + 1 + stride), y * stride);
  }
  return new Image({ width, height, data });
}

let webpModule = null;

/** A WebP through image-in-browser's decoder; an animation's first frame. */
async function decodeWebP(bytes) {
  webpModule ??= import('image-in-browser/lib/src/formats/webp-decoder.js');
  const { WebPDecoder } = await webpModule;
  // frame 0 alone: without an index it decodes every frame of an animation
  // and still answers the first
  const decoded = new WebPDecoder().decode({ bytes, frameIndex: 0 });
  if (!decoded) {
    throw new Error(
      'react-x11: these WebP bytes did not decode — the file is damaged or ' +
        'cut short.',
    );
  }
  // order 0 is ChannelOrder.rgba; a WebP always decodes to four channels
  const data = decoded.getBytes({ order: 0 });
  return new Image({ width: decoded.width, height: decoded.height, data });
}
