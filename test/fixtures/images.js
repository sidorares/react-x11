// Encoded images for the <image> and decoder tests: two lossy WebPs libwebp
// encoded (the encoder the JavaScript decoder is held to), builders for
// lossless and animated WebPs and for PNGs of any pixels — so a test states
// the pixels it expects rather than trusting a binary blob — and a stand-in
// for Bun's decoder, so the Bun rung runs under Node.
import assert from 'node:assert';
import { inflateSync } from 'node:zlib';
import { MemoryImage, encodeWebP } from 'image-in-browser';
import { PNG } from 'pngjs';

/** RGBA pixels from rows of [r, g, b, a]. */
export function pixels(rows) {
  const height = rows.length;
  const width = rows[0].length;
  return { width, height, data: Uint8Array.from(rows.flat(2)) };
}

/** 16x16 in four 8x8 quadrants: red, green / blue, white — libwebp's lossy
 * encoder at quality 100, through Bun 1.4. */
export const LOSSY = Buffer.from(
  'UklGRkgAAABXRUJQVlA4IDwAAABQAgCdASoQABAAAAAAJaACdLoB+AH6Af0ACdAA/tJ///91f//+4QP//6aZ//+WIS5Ndan//8T02y+lwAA=',
  'base64',
);
/** The same, with the white quadrant transparent: VP8X + ALPH + VP8. */
export const LOSSY_ALPHA = Buffer.from(
  'UklGRnYAAABXRUJQVlA4WAoAAAAQAAAADwAADwAAQUxQSBQAAAABDzD/ERFCLJjkL905hYj+T8CeAFZQOCA8AAAAUAIAnQEqEAAQAAAAACWgAnS6AfgB+gH9AAnQAP7Sf///dX///uED//+mmf//liEuTXWp///E9NsvpcAA',
  'base64',
);

/** A lossless WebP (VP8L) of exactly these pixels. */
export function losslessWebP({ width, height, data }) {
  const image = new MemoryImage({ width, height, numChannels: 4 });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      image.setPixelRgba(x, y, data[i], data[i + 1], data[i + 2], data[i + 3]);
    }
  }
  return Buffer.from(encodeWebP({ image }));
}

/** An animated WebP of solid 4x4 frames: VP8X with the animation flag, an
 * ANIM chunk, and one ANMF per frame wrapping a VP8L bitstream. */
export function animatedWebP(...colours) {
  const chunk = (tag, payload) => {
    const out = Buffer.alloc(8 + payload.length + (payload.length & 1));
    out.write(tag, 0, 'ascii');
    out.writeUInt32LE(payload.length, 4);
    Buffer.from(payload).copy(out, 8);
    return out;
  };
  const u24 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255];
  const frame = (colour) => {
    const file = losslessWebP(pixels(Array(4).fill(Array(4).fill(colour))));
    // the simple file is RIFF, WEBP, then the one VP8L chunk
    const header = [...u24(0), ...u24(0), ...u24(3), ...u24(3), ...u24(100)];
    return chunk(
      'ANMF',
      Buffer.concat([Buffer.from([...header, 0]), file.subarray(12)]),
    );
  };
  const body = Buffer.concat([
    Buffer.from('WEBP'),
    chunk('VP8X', [0x02 | 0x10, 0, 0, 0, ...u24(3), ...u24(3)]),
    chunk('ANIM', [0, 0, 0, 0, 0, 0]),
    ...colours.map(frame),
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF'), size, body]);
}

/** A PNG of these pixels, as pngjs writes one: `stored` is the shape Bun's
 * `png({ compressionLevel: 0 })` answers — no compression, every row
 * filtered None — and `options` go to pngjs as they are. */
export function encodePng(
  { width, height, data },
  { stored = false, ...options } = {},
) {
  const png = new PNG({ width, height });
  Buffer.from(data).copy(png.data);
  return PNG.sync.write(
    png,
    stored ? { deflateLevel: 0, filterType: 0 } : options,
  );
}

/**
 * Install a stand-in `Bun` whose `Image` answers `respond(input)` — the
 * re-encoded bytes, or a throw — and count what the ladder asks of it.
 */
export function standInBun(respond) {
  const seen = { inputs: [], formats: [], inflates: 0 };
  globalThis.Bun = {
    Image: class {
      constructor(input) {
        this.input = input;
        seen.inputs.push(input);
      }
      png(options) {
        seen.formats.push(options);
        return this;
      }
      async bytes() {
        return respond(this.input);
      }
    },
    inflateSync(stream, options) {
      seen.inflates++;
      assert.equal(options?.windowBits, 15, 'PNG wraps its deflate in zlib');
      return inflateSync(stream);
    },
  };
  return seen;
}

export const bunError = (code, message) =>
  Object.assign(new Error(`Image: ${message}`), { code });

/** Under a real Bun the stand-in tests skip: a real `globalThis.Bun` is not
 * one to replace. Read once, before any stand-in is installed. */
export const realBun = typeof globalThis.Bun !== 'undefined';

/** For `afterEach`: take the stand-in down again. */
export function removeStandInBun() {
  if (!realBun) delete globalThis.Bun;
}
