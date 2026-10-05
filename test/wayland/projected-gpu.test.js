// `drawImageProjected` on the Wayland context (src/wayland/context2d.js): an
// image drawn through a projection in one quad, its texture coordinates
// interpolated in perspective. What separates that from a quad drawn
// through the projection's corners is where the middle of the image lands:
// a plane turned away from the viewer shows its far half smaller than its
// near half, and a quad interpolated in the plane of the screen shows the
// two halves the same size — the fold RENDER on glamor draws.
//
// Needs a render node (x11-dri's `Gpu`), which CI does not have: the tests
// skip where `probe()` says no, and run on any Linux box with /dev/dri.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { WaylandContext2D } from '../../src/wayland/context2d.js';
import { GLTarget } from '../../src/wayland/target.js';

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

const W = 160;
const H = 48;

function makeContext() {
  const target = new GLTarget(env.gpu.gl, {
    width: W,
    height: H,
    stencil: true,
  });
  const ctx = new WaylandContext2D(env.gpu.gl, { fontManager: null, target });
  ctx.init();
  ctx.begin(W, H);
  ctx.clearRect(0, 0, W, H);
  return ctx;
}

/** 64x8, its left half red and its right half blue: straight RGBA. */
function halves() {
  const data = new Uint8Array(64 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 64; x++) {
      const o = (y * 64 + x) * 4;
      data[o] = x < 32 ? 255 : 0;
      data[o + 2] = x < 32 ? 0 : 255;
      data[o + 3] = 255;
    }
  }
  return { width: 64, height: 8, data };
}

const at = (ctx, x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);

test(
  'an image in perspective: its far half smaller than its near half',
  { skip },
  () => {
    const ctx = makeContext();
    ctx.translate(4, 4);
    // w = 1 + u/64: the right edge twice as far as the left, so the quad
    // runs from x 4 to 132 and the middle of the image, u = 32, lands at
    // 4 + 4·32/1.5 ≈ 89 — not at the quad's own middle, 68
    const drawn = ctx.drawImageProjected(halves(), [
      4,
      0,
      0,
      0,
      4,
      0,
      1 / 64,
      0,
      1,
    ]);
    ctx.end();
    assert.equal(drawn, true);
    // u ≈ 26 here in perspective, red; 37 interpolated in the screen, blue
    assert.deepEqual(
      at(ctx, 78, 10),
      [255, 0, 0, 255],
      'the near half reaches past the middle',
    );
    assert.deepEqual(
      at(ctx, 100, 10),
      [0, 0, 255, 255],
      'the far half is beyond the image middle',
    );
    assert.equal(at(ctx, 140, 10)[3], 0, 'nothing past the far edge');
    ctx.destroy();
  },
);

test('a corner behind the viewer draws nothing, and says so', { skip }, () => {
  const ctx = makeContext();
  // w = 1 - u/32 is below zero past u = 32
  const drawn = ctx.drawImageProjected(halves(), [
    1,
    0,
    0,
    0,
    1,
    0,
    -1 / 32,
    0,
    1,
  ]);
  ctx.end();
  assert.equal(drawn, false);
  assert.equal(at(ctx, 10, 4)[3], 0);
  ctx.destroy();
});

test(
  'a projection that is a matrix of the plane draws what drawImage draws through it',
  { skip },
  () => {
    const a = makeContext();
    a.drawImageProjected(halves(), [1.5, 0.25, 10, 0.1, 2, 6, 0, 0, 1]);
    a.end();
    const b = makeContext();
    b.transform(1.5, 0.1, 0.25, 2, 10, 6);
    b.drawImage(halves(), 0, 0);
    b.end();
    const pa = a.getImageData(0, 0, W, H).data;
    const pb = b.getImageData(0, 0, W, H).data;
    let worst = 0;
    for (let k = 0; k < pa.length; k++)
      worst = Math.max(worst, Math.abs(pa[k] - pb[k]));
    assert.ok(worst <= 2, `differs by ${worst} levels at most`);
    a.destroy();
    b.destroy();
  },
);
