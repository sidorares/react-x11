// The window's frame over a real render node, with the swapchain and the
// window faked: what the viewport is told about the buffer a frame attaches.
//
// A buffer may be larger than the window it shows (the swapchain's slack),
// and the viewport's source rectangle says which part of it is the window.
// A source past the buffer shown is a protocol error, which is fatal, so the
// rectangle goes out only with a commit that attaches a buffer: a commit with
// none — every buffer busy, a frame request to deliver — shows the last
// buffer, of its own size.
//
// Needs a render node (x11-dri's `Gpu`); skips where `probe()` says no.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { WaylandGLContext } from '../../src/wayland/glcontext.js';
import { WaylandWindow } from '../../src/wayland/window.js';

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
    const holder = gpu.createSurface(64, 64);
    gpu.makeCurrent(holder);
    return { dri, gpu, holder };
  } catch {
    return null;
  }
}

const env = openGpu();
const skip = env ? false : 'no GPU render node on this machine';

test(
  'the part of the buffer shown goes out only with a buffer',
  { skip },
  async () => {
    const told = [];
    const window = new EventEmitter();
    Object.assign(window, {
      bufferWidth: 40,
      bufferHeight: 30,
      showsPartOfBuffer: true,
      scheduleFrame: () => Promise.resolve(0),
      ackPending() {},
      showBufferPart: (w, h) => told.push([w, h]),
      surface: { $: { commit: () => told.push('commit') } },
    });
    let presents = true;
    const chain = {
      width: 0,
      height: 0,
      allocWidth: 64,
      allocHeight: 64,
      surfaceFor(w, h, { slack }) {
        assert.equal(slack, true, 'a window with a viewport asks for slack');
        this.width = w;
        this.height = h;
        return env.holder;
      },
      blitHint: () => 'all',
      swap: async () => presents,
      destroy() {},
    };
    const ctx = new WaylandGLContext({ window, gpu: env.gpu, chain });
    ctx.beginFrame();
    await ctx.endFrame('all');
    assert.deepEqual(
      told,
      [[40, 30], 'commit'],
      'with a buffer: the part, then the commit',
    );
    told.length = 0;
    presents = false;
    window.bufferWidth = 50;
    ctx.beginFrame();
    await ctx.endFrame('all');
    assert.deepEqual(told, ['commit'], 'with none: the commit alone');
    ctx.destroy();
  },
);

// The viewport is told only what changed, and nothing where there is none.
test('showBufferPart says each size once, and nothing without a viewport', () => {
  const sent = [];
  const win = {
    _viewport: { $: { set_source: (...a) => sent.push(a) } },
    _shownPart: null,
  };
  const show = WaylandWindow.prototype.showBufferPart;
  show.call(win, 100, 50);
  show.call(win, 100, 50);
  show.call(win, 96, 50);
  assert.deepEqual(sent, [
    [0, 0, 100, 50],
    [0, 0, 96, 50],
  ]);
  show.call({ _viewport: null, _shownPart: null }, 10, 10);
  assert.equal(sent.length, 2, 'no viewport, no request');
});
