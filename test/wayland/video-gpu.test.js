// `<video frames>` on the Wayland backend (src/wayland/video.js): a frame's
// planes go up as textures and a shader converts them into the `<video>`'s
// surface, against a real GPU.
//
// The reference is `frameToRGBA`, the conversion every other drawn path uses:
// the same matrix and range, so the same picture. Pinned too: which way up
// the frame lands, odd sizes whose chroma plane is rounded up, a decoder's
// padded rows, and that the shared device is handed back so the 2D context
// that draws next draws what it means to.
//
// Needs a render node (x11-dri's `Gpu`), which CI does not have: skipped
// where `probe()` says no.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { createVideoFrames, frameToRGBA } from '../../src/videoframes.js';
import { WaylandSurface } from '../../src/wayland/surface.js';
import {
  releaseVideoFrame,
  videoMatrix,
  writeVideoFrame,
} from '../../src/wayland/video.js';

const require = createRequire(import.meta.url);

function openGpu() {
  let dri;
  try {
    dri = require('x11-dri');
  } catch {
    return null;
  }
  try {
    const probe = dri.probe();
    if (probe.gbm !== true || probe.egl !== true || probe.gles !== true)
      return null;
    const gpu = new dri.Gpu({
      format: dri.FORMAT.ARGB8888,
      depthSize: 16,
      stencilSize: 8,
    });
    const holder = gpu.createSurface(1, 1);
    gpu.makeCurrent(holder);
    return { dri, gpu, holder };
  } catch {
    return null;
  }
}

const env = openGpu();
const skip = env ? false : 'no GPU render node on this machine';

/** As much of `WaylandApp` as a surface and the writer ask for. */
function fakeApp() {
  return {
    gl: env.gpu.gl,
    fonts: null,
    makeCurrent() {
      env.gpu.makeCurrent(env.holder);
    },
    rebindWindowTarget() {},
    videoFormats: () => ['NV12', 'I420', 'BGRA'],
  };
}

/** Straight RGBA of a whole surface, top row first. */
const pixels = (surface) =>
  surface.getContext('2d').getImageData(0, 0, surface.width, surface.height)
    .data;

/** Where two RGBA images part by more than `tolerance`, or null. */
function firstMiss(got, want, width, tolerance) {
  for (let i = 0; i < want.length; i++) {
    if (i % 4 === 3) continue;
    if (Math.abs(got[i] - want[i]) > tolerance) {
      const p = i >> 2;
      return `pixel ${p % width},${Math.floor(p / width)} channel ${i % 4}: ${got[i]} for ${want[i]}`;
    }
  }
  return null;
}

/** A frame whose chroma is constant over 2x2 blocks of 4x4 — so bilinear
 *  and nearest chroma agree away from the block edges, which is what the
 *  comparison reads — and whose luma ramps, so a flip or a shift shows. */
function blocks(format, width, height) {
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const y = new Uint8Array(width * height);
  for (let r = 0; r < height; r++)
    for (let x = 0; x < width; x++)
      y[r * width + x] = 16 + ((r * 7 + x * 3) % 220);
  const cb = new Uint8Array(cw * ch);
  const cr = new Uint8Array(cw * ch);
  for (let r = 0; r < ch; r++)
    for (let x = 0; x < cw; x++) {
      const block = (r >> 2) * 3 + (x >> 2);
      cb[r * cw + x] = 40 + ((block * 37) % 180);
      cr[r * cw + x] = 220 - ((block * 53) % 180);
    }
  if (format === 'I420') return [y, cb, cr];
  const uv = new Uint8Array(cw * 2 * ch);
  for (let i = 0; i < cw * ch; i++) {
    uv[i * 2] = cb[i];
    uv[i * 2 + 1] = cr[i];
  }
  return [y, uv];
}

/** Only the pixels whose chroma neighbours are all their own block's. */
function blockInteriors(rgba, width, height) {
  const out = new Uint8ClampedArray(rgba);
  for (let r = 0; r < height; r++)
    for (let x = 0; x < width; x++) {
      const edgeX = x % 8 === 0 || x % 8 >= 6;
      const edgeY = r % 8 === 0 || r % 8 >= 6;
      if (edgeX || edgeY)
        out.fill(0, (r * width + x) * 4, (r * width + x) * 4 + 3);
    }
  return out;
}

for (const [format, colorSpace, range] of [
  ['NV12', 'bt709', 'video'],
  ['I420', 'bt601', 'video'],
  ['NV12', 'bt2020', 'full'],
]) {
  test(
    `${format} ${colorSpace} ${range}: the shader draws the picture frameToRGBA makes`,
    { skip },
    () => {
      const app = fakeApp();
      const W = 48;
      const H = 32;
      const sink = createVideoFrames(app, {
        width: W,
        height: H,
        format,
        colorSpace,
        range,
      });
      sink.push(blocks(format, W, H));
      const surface = new WaylandSurface(app, { width: W, height: H });
      try {
        assert.equal(writeVideoFrame(app, surface, sink, sink.frame), true);
        const want = frameToRGBA(
          sink,
          sink.frame,
          new Uint8ClampedArray(W * H * 4),
        );
        const got = pixels(surface);
        const miss = firstMiss(
          blockInteriors(got, W, H),
          blockInteriors(want, W, H),
          W,
          2,
        );
        assert.equal(miss, null, miss);
      } finally {
        releaseVideoFrame(app, surface);
        surface.destroy();
      }
    },
  );
}

test(
  'the first row of the frame is the top row of the picture',
  { skip },
  () => {
    const app = fakeApp();
    const sink = createVideoFrames(app, { width: 8, height: 8 });
    const bgra = new Uint8Array(8 * 8 * 4);
    for (let r = 0; r < 8; r++)
      for (let x = 0; x < 8; x++)
        bgra.set(r < 4 ? [0, 0, 255, 255] : [255, 0, 0, 255], (r * 8 + x) * 4);
    sink.push(bgra);
    const surface = new WaylandSurface(app, { width: 8, height: 8 });
    try {
      writeVideoFrame(app, surface, sink, sink.frame);
      const got = pixels(surface);
      assert.deepEqual([...got.subarray(0, 4)], [255, 0, 0, 255], 'red on top');
      assert.deepEqual(
        [...got.subarray(63 * 4, 64 * 4)],
        [0, 0, 255, 255],
        'blue at the bottom',
      );
    } finally {
      releaseVideoFrame(app, surface);
      surface.destroy();
    }
  },
);

test('an odd frame, and a decoder that pads its rows', { skip }, () => {
  const app = fakeApp();
  const W = 7;
  const H = 5;
  const sink = createVideoFrames(app, { width: W, height: H, format: 'I420' });
  // BT.709 video-range red in every pixel, each row padded to 16 bytes
  const y = new Uint8Array(16 * H).fill(0xee);
  const cb = new Uint8Array(16 * 3).fill(0xee);
  const cr = new Uint8Array(16 * 3).fill(0xee);
  for (let r = 0; r < H; r++) y.fill(63, r * 16, r * 16 + W);
  for (let r = 0; r < 3; r++) {
    cb.fill(102, r * 16, r * 16 + 4);
    cr.fill(240, r * 16, r * 16 + 4);
  }
  sink.push([y, cb, cr], { strides: [16, 16, 16] });
  const surface = new WaylandSurface(app, { width: W, height: H });
  try {
    assert.equal(writeVideoFrame(app, surface, sink, sink.frame), true);
    const got = pixels(surface);
    for (let p = 0; p < W * H; p++) {
      const px = [...got.subarray(p * 4, p * 4 + 3)];
      assert.ok(
        px.every((v, i) => Math.abs(v - [255, 0, 0][i]) <= 2),
        `pixel ${p % W},${Math.floor(p / W)} is ${px}: the padding was read`,
      );
    }
  } finally {
    releaseVideoFrame(app, surface);
    surface.destroy();
  }
});

test(
  'the device is handed back: a 2D draw after a frame draws as it means to',
  { skip },
  () => {
    const app = fakeApp();
    const sink = createVideoFrames(app, {
      width: 16,
      height: 16,
      format: 'NV12',
    });
    const frameSurface = new WaylandSurface(app, { width: 16, height: 16 });
    const other = new WaylandSurface(app, { width: 32, height: 32 });
    try {
      // a held context with something buffered, the way a window's is mid-frame
      const ctx = other.getContext('2d');
      ctx.fillStyle = '#00ff00';
      ctx.fillRect(0, 0, 32, 32);
      // BT.709 red, with a padded first plane so the row length is set
      const y = new Uint8Array(20 * 16).fill(63);
      const uv = Uint8Array.from({ length: 128 }, (_, i) =>
        i % 2 ? 240 : 102,
      );
      sink.push([y, uv], { strides: [20, 16] });
      writeVideoFrame(app, frameSurface, sink, sink.frame);
      // blended, scissored, into its own target, at its own size: none of the
      // writer's state may leak into this
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#0000ff';
      ctx.fillRect(16, 16, 16, 16);
      ctx.globalAlpha = 1;
      ctx.drawImage(frameSurface, 0, 0, 8, 8);
      const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
      assert.deepEqual(
        at(20, 4),
        [0, 255, 0, 255],
        'what was buffered before the frame landed',
      );
      assert.ok(
        Math.abs(at(20, 20)[1] - 128) <= 2 &&
          Math.abs(at(20, 20)[2] - 128) <= 2,
        'blending is back on',
      );
      const red = at(2, 2);
      assert.ok(
        red[0] >= 252 && red[1] <= 3 && red[2] <= 3,
        `the frame drawn from its surface: ${red}`,
      );
      // UNPACK_ROW_LENGTH is back at 0: an ImageData put after a frame lands
      // as written
      const img = ctx.createImageData(2, 1);
      img.data.set([10, 20, 30, 255, 40, 50, 60, 255]);
      ctx.putImageData(img, 30, 0);
      assert.deepEqual(at(31, 0), [40, 50, 60, 255]);
    } finally {
      releaseVideoFrame(app, frameSurface);
      frameSurface.destroy();
      other.destroy();
    }
  },
);

test('the matrix is frameToRGBA’s: video-range white and black are 1 and 0', () => {
  const { matrix, offset } = videoMatrix('bt709', 'video');
  const apply = ([y, cb, cr]) => {
    const v = [y / 255 - offset[0], cb / 255 - offset[1], cr / 255 - offset[2]];
    return [0, 1, 2].map(
      (row) =>
        matrix[row] * v[0] + matrix[3 + row] * v[1] + matrix[6 + row] * v[2],
    );
  };
  for (const [ycc, rgb] of [
    [
      [235, 128, 128],
      [1, 1, 1],
    ],
    [
      [16, 128, 128],
      [0, 0, 0],
    ],
  ]) {
    apply(ycc).forEach((c, i) =>
      assert.ok(Math.abs(c - rgb[i]) < 1e-6, `${ycc} -> ${apply(ycc)}`),
    );
  }
});
