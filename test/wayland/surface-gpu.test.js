// An offscreen `Surface` on the Wayland backend (src/wayland/surface.js),
// against a real GPU.
//
// What is being pinned down is the thing that made a held context a trap
// (#566): every context on this backend shares one GLES device, so a draw
// lands wherever that device was last pointed. The contexts now take it
// back when they find it in someone else's hands (src/wayland/device.js),
// which is what these assertions are about — a context held across draws
// the way ntk documents, two surfaces interleaved, and a surface painted in
// the middle of a window's frame leaving the window's own context alone.
//
// Needs a render node (x11-dri's `Gpu`), which CI does not have: the tests
// skip where `probe()` says no, and run on any Linux box with /dev/dri.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { WaylandContext2D } from '../../src/wayland/context2d.js';
import { releaseDevice } from '../../src/wayland/device.js';
import { WaylandSurface } from '../../src/wayland/surface.js';
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

/**
 * As much of `WaylandApp` as a surface asks for: the shared GL, a current
 * surface, and the window-backing rebind that `render()` and `copyWithin()`
 * do on the way out. `windowTarget` stands in for a window being painted.
 */
function fakeApp() {
  return {
    gl: env.gpu.gl,
    fonts: null,
    windowTarget: null,
    makeCurrent() {
      env.gpu.makeCurrent(env.holder);
    },
    rebindWindowTarget() {
      this.windowTarget?.bind();
    },
  };
}

/** Straight-alpha RGBA of one pixel of a surface. */
function pixel(surface, x, y) {
  return Array.from(surface.getContext('2d').getImageData(x, y, 1, 1).data);
}

test(
  'a held context draws into the surface, as ntk documents',
  { skip },
  () => {
    const surface = new WaylandSurface(fakeApp(), { width: 32, height: 32 });
    // no `render()` anywhere: the context is taken once and drawn through,
    // which is what the vt terminal, the tile cache and the flow grid do
    const ctx = surface.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 32, 16);
    ctx.fillStyle = '#0000ff';
    ctx.fillRect(0, 16, 32, 16);
    assert.deepEqual(pixel(surface, 8, 4), [255, 0, 0, 255], 'top half');
    assert.deepEqual(pixel(surface, 8, 24), [0, 0, 255, 255], 'bottom half');
    surface.destroy();
  },
);

test('a held context keeps its own state across draws', { skip }, () => {
  const surface = new WaylandSurface(fakeApp(), { width: 32, height: 32 });
  const ctx = surface.getContext('2d');
  ctx.translate(16, 0);
  ctx.beginPath();
  ctx.rect(0, 0, 16, 32);
  ctx.clip();
  ctx.fillStyle = '#00ff00';
  // in user space the whole surface; the transform and the clip put it in
  // the right half, and both are still in force on the next call
  ctx.fillRect(-16, 0, 32, 32);
  ctx.fillRect(-16, 0, 32, 32);
  assert.equal(pixel(surface, 4, 16)[3], 0, 'left half untouched');
  assert.deepEqual(pixel(surface, 24, 16), [0, 255, 0, 255], 'right half');
  surface.destroy();
});

test('two held contexts interleave without crossing', { skip }, () => {
  const app = fakeApp();
  const a = new WaylandSurface(app, { width: 32, height: 32 });
  const b = new WaylandSurface(app, { width: 32, height: 32 });
  const ca = a.getContext('2d');
  const cb = b.getContext('2d');
  ca.fillStyle = '#ff0000';
  ca.fillRect(0, 0, 32, 32);
  cb.fillStyle = '#0000ff';
  cb.fillRect(0, 0, 32, 32);
  // back to the first, with the device in the second's hands
  ca.fillStyle = '#00ff00';
  ca.fillRect(0, 0, 16, 32);
  assert.deepEqual(pixel(a, 4, 16), [0, 255, 0, 255], 'a: the late fill');
  assert.deepEqual(pixel(a, 24, 16), [255, 0, 0, 255], 'a: the first fill');
  assert.deepEqual(pixel(b, 4, 16), [0, 0, 255, 255], 'b: untouched by a');
  a.destroy();
  b.destroy();
});

test('render() starts clean and the pixels persist', { skip }, () => {
  const surface = new WaylandSurface(fakeApp(), { width: 32, height: 32 });
  const ctx = surface.getContext('2d');
  ctx.translate(100, 100); // what `render()` is documented to reset
  surface.render((c) => {
    c.fillStyle = '#ff0000';
    c.fillRect(0, 0, 32, 32);
  });
  surface.render((c) => {
    c.fillStyle = '#0000ff';
    c.fillRect(0, 0, 16, 32);
  });
  assert.deepEqual(pixel(surface, 4, 16), [0, 0, 255, 255], 'second render');
  assert.deepEqual(pixel(surface, 24, 16), [255, 0, 0, 255], 'first survives');
  surface.clear();
  assert.equal(pixel(surface, 4, 16)[3], 0, 'cleared');
  surface.destroy();
});

test(
  "a surface painted mid-frame leaves the window's context alone",
  { skip },
  () => {
    const app = fakeApp();
    const win = new GLTarget(env.gpu.gl, {
      width: 64,
      height: 64,
      stencil: true,
    });
    app.windowTarget = win;
    const wctx = new WaylandContext2D(env.gpu.gl, {
      fontManager: null,
      target: win,
    });
    wctx.init();
    wctx.begin(64, 64);
    wctx.clearRect(0, 0, 64, 64);
    // a clip in force across the interruption — the scissor and the blend
    // state are exactly what used to come back wrong
    wctx.beginPath();
    wctx.rect(0, 0, 64, 32);
    wctx.clip();
    wctx.fillStyle = '#ff0000';
    wctx.fillRect(0, 0, 64, 64);

    // …and now a node paints into an offscreen surface, mid-frame
    const surface = new WaylandSurface(app, { width: 16, height: 16 });
    surface.render((c) => {
      c.fillStyle = '#0000ff';
      c.fillRect(0, 0, 16, 16);
    });

    // no `restoreGLState()` here: the window's context takes the device back
    wctx.fillStyle = '#00ff00';
    wctx.fillRect(0, 0, 16, 64);
    wctx.drawImage(surface, 32, 0);
    wctx.end();

    const at = (x, y) => Array.from(wctx.getImageData(x, y, 1, 1).data);
    assert.deepEqual(at(4, 4), [0, 255, 0, 255], 'drawn after the surface');
    assert.deepEqual(at(20, 4), [255, 0, 0, 255], 'drawn before it');
    assert.deepEqual(at(36, 4), [0, 0, 255, 255], 'the surface, composited');
    assert.equal(at(4, 48)[3], 0, 'the clip still held');
    assert.deepEqual(
      Array.from(surface.getContext('2d').getImageData(4, 4, 1, 1).data),
      [0, 0, 255, 255],
      'and the surface kept its own pixels',
    );

    surface.destroy();
    wctx.destroy();
    win.destroy();
  },
);

test('a released device is taken back before the next draw', { skip }, () => {
  const surface = new WaylandSurface(fakeApp(), { width: 32, height: 32 });
  const ctx = surface.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 32, 8);

  // What `GLTarget`'s blits do to the device on their way out: the default
  // framebuffer bound, the scissor off, and `releaseDevice` said so. (The
  // blits themselves need `glBlitFramebuffer`, which not every GLES build
  // this runs against exposes, so the state change is made directly here.)
  const gl = env.gpu.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.disable(gl.SCISSOR_TEST);
  releaseDevice(gl);

  ctx.fillStyle = '#0000ff';
  ctx.fillRect(0, 24, 32, 8);
  assert.deepEqual(pixel(surface, 4, 4), [255, 0, 0, 255], 'before');
  assert.deepEqual(pixel(surface, 4, 28), [0, 0, 255, 255], 'after');
  surface.destroy();
});
