// The decoder ladder behind <image src> bytes and files (src/imagedecode.js):
// the runtime's own decoder where there is one — `Bun.Image` — and
// JavaScript decoders elsewhere, WebP among them.
//
// These run under Node, so the Bun rung is driven through a stand-in
// `globalThis.Bun` shaped like Bun 1.4's: the part that matters is what the
// ladder does with what Bun answers — the stored PNG it unwraps, the PNG it
// hands pngjs instead, the animation it takes back, the error it rewrites.
// The last test asks a real Bun, when one is on PATH, whether its answers
// still have that shape.
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, afterEach } from 'node:test';

import {
  decodeImageBytes,
  imageFormat,
  isAnimatedWebP,
  loadImageFile,
  storedPngImage,
} from '../src/imagedecode.js';
import {
  LOSSY,
  LOSSY_ALPHA,
  animatedWebP,
  bunError,
  encodePng,
  losslessWebP,
  pixels,
  realBun,
  removeStandInBun,
  standInBun,
} from './fixtures/images.js';

afterEach(removeStandInBun);

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

const TWO_BY_TWO = pixels([
  [RED, GREEN],
  [BLUE, CLEAR],
]);

const at = (image, x, y) =>
  Array.from(image.data.subarray((y * image.width + x) * 4).slice(0, 4));

/** Within `tolerance` per channel — lossy pixels are near, not equal. */
function near(actual, expected, tolerance, what) {
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance),
    `${what}: ${actual} is not within ${tolerance} of ${expected}`,
  );
}

// --- telling formats apart ----------------------------------------------------

test('imageFormat names a format by its first bytes', () => {
  const sig = (...parts) =>
    Buffer.concat(
      parts.map((p) =>
        typeof p === 'string' ? Buffer.from(p) : Buffer.from(p),
      ),
    );
  const pad = Buffer.alloc(16);
  assert.equal(imageFormat(encodePng(TWO_BY_TWO)), 'png');
  assert.equal(imageFormat(sig([0xff, 0xd8, 0xff, 0xe0], pad)), 'jpeg');
  assert.equal(imageFormat(LOSSY), 'webp');
  assert.equal(imageFormat(sig('GIF89a', pad)), 'gif');
  assert.equal(imageFormat(sig('BM', pad)), 'bmp');
  assert.equal(imageFormat(sig('II', [42, 0], pad)), 'tiff');
  assert.equal(imageFormat(sig('MM', [0, 42], pad)), 'tiff');
  assert.equal(imageFormat(sig([0, 0, 0, 24], 'ftypheic', pad)), 'heic');
  assert.equal(imageFormat(sig([0, 0, 0, 24], 'ftypmif1', pad)), 'heic');
  assert.equal(imageFormat(sig([0, 0, 0, 24], 'ftypavif', pad)), 'avif');
  assert.equal(imageFormat(sig('<!DOCTYPE html>')), null);
  assert.equal(imageFormat(sig('RIFF')), null, 'too short to be anything');
});

test('isAnimatedWebP reads the VP8X animation flag', () => {
  assert.equal(isAnimatedWebP(animatedWebP(RED, BLUE)), true);
  assert.equal(isAnimatedWebP(LOSSY_ALPHA), false, 'VP8X, but still');
  assert.equal(isAnimatedWebP(LOSSY), false, 'a simple file has no VP8X');
});

// --- the JavaScript rung ------------------------------------------------------

test(
  'PNG and JPEG bytes decode synchronously without a runtime decoder',
  {
    skip: realBun,
  },
  () => {
    const image = decodeImageBytes(encodePng(TWO_BY_TWO));
    assert.equal(typeof image.then, 'undefined', 'an Image, not a promise');
    assert.deepStrictEqual(at(image, 1, 0), GREEN);
  },
);

test('a lossy WebP decodes, a moment later', { skip: realBun }, async () => {
  const pending = decodeImageBytes(LOSSY);
  assert.equal(typeof pending.then, 'function', 'the decoder loads on demand');
  const image = await pending;
  assert.deepStrictEqual([image.width, image.height], [16, 16]);
  near(at(image, 3, 3), RED, 4, 'red quadrant');
  near(at(image, 12, 3), GREEN, 4, 'green quadrant');
  near(at(image, 3, 12), BLUE, 4, 'blue quadrant');
  near(at(image, 12, 12), WHITE, 4, 'white quadrant');
});

test(
  'a lossy WebP keeps the alpha its ALPH chunk carries',
  {
    skip: realBun,
  },
  async () => {
    const image = await decodeImageBytes(LOSSY_ALPHA);
    near(at(image, 3, 3), RED, 4, 'opaque quadrant');
    assert.equal(at(image, 12, 12)[3], 0, 'the transparent quadrant');
  },
);

test(
  'a lossless WebP decodes to exactly its pixels',
  {
    skip: realBun,
  },
  async () => {
    const image = await decodeImageBytes(losslessWebP(TWO_BY_TWO));
    assert.deepStrictEqual([image.width, image.height], [2, 2]);
    assert.deepStrictEqual(Array.from(image.data), Array.from(TWO_BY_TWO.data));
  },
);

test('an animated WebP shows its first frame', { skip: realBun }, async () => {
  const image = await decodeImageBytes(animatedWebP(RED, BLUE));
  assert.deepStrictEqual([image.width, image.height], [4, 4]);
  assert.deepStrictEqual(at(image, 2, 2), RED);
});

test('a WebP cut short rejects, saying so', { skip: realBun }, async () => {
  await assert.rejects(
    decodeImageBytes(LOSSY.subarray(0, 40)),
    /WebP bytes did not decode.*damaged or cut short/s,
  );
});

test(
  'a format this runtime cannot decode says what will',
  {
    skip: realBun,
  },
  () => {
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)]);
    assert.throws(
      () => decodeImageBytes(gif),
      /GIF needs a decoder this runtime does not have.*PNG, JPEG and WebP.*Bun.*Convert the image/s,
    );
  },
);

test(
  'bytes that are no image name what they begin with',
  {
    skip: realBun,
  },
  () => {
    assert.throws(
      () => decodeImageBytes(Buffer.from('<!DOCTYPE html>')),
      /not an image format.*begin 3c 21 44 4f 43 54 59 50/s,
    );
    assert.throws(() => decodeImageBytes(new Uint8Array(0)), /empty buffer/);
  },
);

test(
  'a file path and a file URL decode a WebP on disk',
  {
    skip: realBun,
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'react-x11-decode-'));
    // no extension: the bytes say what the file is
    const file = join(dir, 'picture');
    await writeFile(file, losslessWebP(TWO_BY_TWO));
    for (const path of [file, pathToFileURL(file)]) {
      const image = await loadImageFile(path);
      assert.deepStrictEqual(at(image, 0, 1), BLUE);
    }
  },
);

// --- the runtime's rung: Bun.Image ----------------------------------------

test(
  'under Bun every format goes to Bun.Image, and its stored PNG is unwrapped without pngjs',
  {
    skip: realBun,
  },
  async () => {
    const seen = standInBun(() => encodePng(TWO_BY_TWO, { stored: true }));
    for (const bytes of [encodePng(TWO_BY_TWO), LOSSY]) {
      const pending = decodeImageBytes(bytes);
      assert.equal(
        typeof pending.then,
        'function',
        'off the JavaScript thread',
      );
      const image = await pending;
      assert.deepStrictEqual(
        Array.from(image.data),
        Array.from(TWO_BY_TWO.data),
      );
    }
    assert.equal(seen.inputs.length, 2, 'PNG and WebP alike');
    assert.deepStrictEqual(seen.formats, [
      { compressionLevel: 0 },
      { compressionLevel: 0 },
    ]);
    assert.equal(seen.inflates, 2, 'one native inflate per image');
  },
);

test(
  'a PNG from Bun the unwrap does not recognise is read by pngjs instead',
  {
    skip: realBun,
  },
  async () => {
    // what a later Bun might answer at level 0: rows run through a filter,
    // or an opaque picture written without its alpha channel
    const opaque = pixels([
      [RED, GREEN],
      [BLUE, WHITE],
    ]);
    for (const [source, answer] of [
      [TWO_BY_TWO, encodePng(TWO_BY_TWO, { filterType: 1 })],
      [opaque, encodePng(opaque, { colorType: 2, inputHasAlpha: true })],
    ]) {
      standInBun(() => answer);
      assert.equal(
        storedPngImage(answer),
        null,
        'premise: the fast path declines',
      );
      const image = await decodeImageBytes(LOSSY);
      assert.deepStrictEqual(Array.from(image.data), Array.from(source.data));
    }
  },
);

test(
  'under Bun a file is read and handed over as bytes',
  {
    skip: realBun,
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'react-x11-decode-'));
    const file = join(dir, 'photo.webp');
    await writeFile(file, LOSSY);
    const seen = standInBun(() => encodePng(TWO_BY_TWO, { stored: true }));
    const image = await loadImageFile(file);
    assert.deepStrictEqual([image.width, image.height], [2, 2]);
    assert.deepStrictEqual(Buffer.from(seen.inputs[0]), LOSSY);
  },
);

test(
  'an animated WebP Bun turns down comes from the JavaScript decoder',
  {
    skip: realBun,
  },
  async () => {
    const seen = standInBun(() => {
      throw bunError('ERR_IMAGE_DECODE_FAILED', 'decode failed');
    });
    const image = await decodeImageBytes(animatedWebP(GREEN, BLUE));
    assert.equal(seen.inputs.length, 1, 'Bun was asked first');
    assert.deepStrictEqual(at(image, 0, 0), GREEN);
    // a still image Bun cannot decode is damaged, not a job for the fallback
    await assert.rejects(decodeImageBytes(LOSSY), /decode failed/);
  },
);

test(
  'a format with no system codec says which systems have one',
  {
    skip: realBun,
  },
  async () => {
    standInBun(() => {
      throw bunError('ERR_IMAGE_FORMAT_UNSUPPORTED', 'format not supported');
    });
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from('ftypheic'),
      Buffer.alloc(16),
    ]);
    await assert.rejects(
      decodeImageBytes(heic),
      /HEIC has no decoder on this machine.*ImageIO on macOS, WIC on Windows.*Convert the image/s,
    );
  },
);

test(
  'bytes over a shared buffer reach Bun as a copy it accepts',
  {
    skip: realBun || typeof SharedArrayBuffer === 'undefined',
  },
  async () => {
    const seen = standInBun(() => encodePng(TWO_BY_TWO, { stored: true }));
    const shared = new Uint8Array(new SharedArrayBuffer(LOSSY.length));
    shared.set(LOSSY);
    await decodeImageBytes(shared);
    assert.ok(seen.inputs[0].buffer instanceof ArrayBuffer, 'not shared');
    assert.deepStrictEqual(Buffer.from(seen.inputs[0]), LOSSY);
    const plain = new Uint8Array(LOSSY);
    await decodeImageBytes(plain);
    assert.equal(seen.inputs[1], plain, 'an ordinary buffer is not copied');
  },
);

// --- a real Bun ---------------------------------------------------------------

function bunOnPath() {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test(
  'a real Bun.Image answers in the shape the unwrap reads',
  {
    skip:
      !bunOnPath() && 'no bun on PATH — the stand-in tests cover the ladder',
  },
  () => {
    // Run in a child: this process is Node. What is checked is the contract
    // the fast path rests on — level 0 comes back stored and unfiltered, so
    // the unwrap fires rather than handing every image to pngjs — and that a
    // WebP comes out of the whole ladder with its pixels.
    const decoder = new URL('../src/imagedecode.js', import.meta.url).href;
    const script = `
    const { decodeImageBytes, storedPngImage } = await import(${JSON.stringify(decoder)});
    if (typeof Bun.Image !== 'function') { console.log('null'); process.exit(0); }
    const webp = Buffer.from(${JSON.stringify(LOSSY.toString('base64'))}, 'base64');
    const png = await new Bun.Image(webp).png({ compressionLevel: 0 }).bytes();
    const image = await decodeImageBytes(webp);
    const px = (x, y) => Array.from(image.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
    console.log(JSON.stringify({
      unwrapped: storedPngImage(png) !== null,
      size: [image.width, image.height],
      corners: [px(3, 3), px(12, 3), px(3, 12), px(12, 12)],
    }));
  `;
    const out = execFileSync('bun', ['-e', script], {
      encoding: 'utf8',
    }).trim();
    if (out === 'null') return; // a Bun from before Bun.Image: the JS rung
    const result = JSON.parse(out);
    assert.equal(result.unwrapped, true, 'Bun still answers a stored PNG');
    assert.deepStrictEqual(result.size, [16, 16]);
    for (const [i, colour] of [RED, GREEN, BLUE, WHITE].entries()) {
      near(result.corners[i], colour, 4, `quadrant ${i}`);
    }
  },
);
