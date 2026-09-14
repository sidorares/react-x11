// The 2d context's path fills and clips (src/wayland/context2d.js) against a
// real GPU: coverage-rasterised fills are antialiased, stencil clips are
// exact, nested clips intersect, and `restore()` drops them. The pixels are
// read back with `getImageData`, so the assertions are on what a frame
// would have carried.
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

const SIZE = 64;

function makeContext(env) {
  const target = new GLTarget(env.gpu.gl, {
    width: SIZE,
    height: SIZE,
    stencil: true,
  });
  const ctx = new WaylandContext2D(env.gpu.gl, { fontManager: null, target });
  ctx.init();
  return { ctx, target };
}

/** Straight-alpha RGBA of one pixel, after ending the frame. */
function pixel(ctx, x, y) {
  return Array.from(ctx.getImageData(x, y, 1, 1).data);
}

function fresh(ctx) {
  ctx.begin(SIZE, SIZE);
  ctx.clearRect(0, 0, SIZE, SIZE);
}

const env = openGpu();
const skip = env ? false : 'no GPU render node on this machine';

test(
  'a path fill is antialiased at its edge and solid inside',
  { skip },
  () => {
    const { ctx, target } = makeContext(env);
    fresh(ctx);
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(SIZE, 0);
    ctx.lineTo(0, SIZE);
    ctx.closePath();
    ctx.fill();
    ctx.end();
    assert.deepEqual(pixel(ctx, 10, 10), [255, 0, 0, 255], 'inside');
    assert.equal(pixel(ctx, 40, 40)[3], 0, 'outside');
    // the pixel whose centre sits on the diagonal is half covered
    const edge = pixel(ctx, 31, 32)[3];
    assert.ok(edge > 40 && edge < 215, `edge coverage ${edge} is partial`);
    assert.equal(ctx.shapeStats.paths, 1);
    ctx.destroy();
    target.destroy();
  },
);

test('even-odd leaves the hole', { skip }, () => {
  const { ctx, target } = makeContext(env);
  fresh(ctx);
  ctx.fillStyle = '#00ff00';
  ctx.beginPath();
  ctx.moveTo(8, 8);
  ctx.lineTo(56, 8);
  ctx.lineTo(56, 56);
  ctx.lineTo(8, 56);
  ctx.closePath();
  ctx.moveTo(24, 24);
  ctx.lineTo(40, 24);
  ctx.lineTo(40, 40);
  ctx.lineTo(24, 40);
  ctx.closePath();
  ctx.fill('evenodd');
  ctx.end();
  assert.deepEqual(pixel(ctx, 12, 12), [0, 255, 0, 255], 'ring');
  assert.equal(pixel(ctx, 32, 32)[3], 0, 'hole');
  ctx.destroy();
  target.destroy();
});

test('a rounded clip is exact, not its bounding box', { skip }, () => {
  const { ctx, target } = makeContext(env);
  fresh(ctx);
  ctx.beginPath();
  ctx.roundRect(0, 0, SIZE, SIZE, SIZE / 2); // a circle
  ctx.clip();
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.end();
  assert.deepEqual(pixel(ctx, 32, 32), [0, 0, 255, 255], 'centre');
  assert.deepEqual(pixel(ctx, 1, 32), [0, 0, 255, 255], 'left middle');
  assert.equal(pixel(ctx, 1, 1)[3], 0, 'outside the corner');
  assert.equal(pixel(ctx, 62, 62)[3], 0, 'outside the far corner');
  assert.equal(ctx.clipApproximations, 0);
  ctx.destroy();
  target.destroy();
});

test('nested clips intersect, and restore() drops them', { skip }, () => {
  const { ctx, target } = makeContext(env);
  fresh(ctx);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, SIZE, SIZE, SIZE / 2); // the circle
  ctx.clip();
  ctx.beginPath();
  ctx.rect(0, 0, 32, SIZE); // the left half: a scissor
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(SIZE, 0);
  ctx.lineTo(0, SIZE);
  ctx.closePath(); // the upper-left triangle: a second stencil clip
  ctx.clip();
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.restore();
  // no clip left: a second fill reaches everywhere
  ctx.fillStyle = 'rgba(0, 0, 255, 1)';
  ctx.fillRect(0, 0, 8, 8);
  ctx.end();
  assert.deepEqual(pixel(ctx, 16, 20), [255, 0, 0, 255], 'in all three');
  assert.equal(pixel(ctx, 40, 10)[3], 0, 'right half is out (scissor)');
  assert.equal(pixel(ctx, 20, 50)[3], 0, 'below the diagonal is out');
  assert.equal(pixel(ctx, 12, 12)[0], 255, 'inside the circle');
  assert.deepEqual(pixel(ctx, 1, 1), [0, 0, 255, 255], 'after restore');
  ctx.destroy();
  target.destroy();
});

test('a clip survives a flush and a foreign-GL state restore', { skip }, () => {
  const { ctx, target } = makeContext(env);
  fresh(ctx);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(SIZE, 0);
  ctx.lineTo(0, SIZE);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.flush();
  // what a <glarea> leaves behind
  const gl = env.gpu.gl;
  gl.disable(gl.STENCIL_TEST);
  gl.enable(gl.DEPTH_TEST);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  ctx.restoreGLState();
  ctx.fillStyle = '#00ff00';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.end();
  assert.deepEqual(pixel(ctx, 10, 10), [0, 255, 0, 255], 'inside, green');
  assert.equal(pixel(ctx, 50, 50)[3], 0, 'still clipped');
  ctx.destroy();
  target.destroy();
});

test('a stroke is antialiased', { skip }, () => {
  const { ctx, target } = makeContext(env);
  fresh(ctx);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 32.5);
  ctx.lineTo(SIZE, 32.5);
  ctx.stroke();
  ctx.end();
  assert.equal(pixel(ctx, 20, 32)[3], 255, 'on the line');
  assert.equal(pixel(ctx, 20, 31)[3], 0, 'above');
  assert.equal(pixel(ctx, 20, 33)[3], 0, 'below');
  fresh(ctx);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(SIZE, SIZE);
  ctx.stroke();
  ctx.end();
  const beside = pixel(ctx, 32, 31)[3];
  assert.ok(beside > 0 && beside < 255, `diagonal edge ${beside} is partial`);
  ctx.destroy();
  target.destroy();
});

test.after(() => {
  if (!env) return;
  try {
    env.holder.destroy();
  } catch {
    /* gone */
  }
});
