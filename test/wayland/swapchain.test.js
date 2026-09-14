// The swapchain's bookkeeping (src/wayland/swapchain.js) over fakes: a GBM
// surface that rotates keys and bumps its generation on resize, a dmabuf
// global whose params answer `created`, and a wl_surface that records what
// was attached and damaged. No GPU, no compositor — the rules under test are
// the ones a real one would only reveal as stale rectangles.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { WaylandSwapchain } from '../../src/wayland/swapchain.js';

/** A GBM surface with N buffers handed out round-robin, held until released. */
function fakeGbm(count = 3) {
  let generation = 0;
  let next = 0;
  const held = new Set();
  const isNew = new Set();
  const reset = () => {
    held.clear();
    isNew.clear();
    for (let k = 1; k <= count; k++) isNew.add(`${generation}:${k}`);
  };
  reset();
  return {
    get generation() {
      return generation;
    },
    width: 0,
    height: 0,
    swaps: 0,
    swap() {
      this.swaps++;
      for (let i = 0; i < count; i++) {
        const key = ((next + i) % count) + 1;
        if (held.has(key)) continue;
        next = (next + i + 1) % count;
        held.add(key);
        const id = `${generation}:${key}`;
        const fresh = isNew.delete(id);
        return {
          key,
          generation,
          isNew: fresh,
          width: this.width,
          height: this.height,
          fd: fresh ? 100 + key : undefined,
          stride: 4 * this.width,
          offset: 0,
          modifier: 0n,
        };
      }
      return null;
    },
    release(ref) {
      if (ref.generation !== generation) return false;
      held.delete(ref.key);
      return true;
    },
    resize(w, h) {
      if (w === this.width && h === this.height) return;
      this.width = w;
      this.height = h;
      generation++;
      reset();
    },
    destroy() {},
  };
}

function fakeGpu(gbm) {
  return {
    createSurface(w, h) {
      gbm.width = w;
      gbm.height = h;
      return gbm;
    },
  };
}

/** zwp_linux_dmabuf_v1: params that answer `created` on the next tick. */
function fakeDmabuf(log) {
  return {
    imports: 0,
    async create_params() {
      const p = new EventEmitter();
      p.add = async (fd) => log.push(['add', fd]);
      p.$ = { destroy() {} };
      p.destroy = async () => {};
      p.create = async () => {
        this.imports++;
        const buffer = new EventEmitter();
        buffer.id = 1000 + this.imports;
        buffer.$ = { destroy: () => log.push(['destroy-buffer', buffer.id]) };
        setImmediate(() => p.emit('created', buffer));
      };
      return p;
    },
  };
}

function fakeSurface(log) {
  return {
    $: {
      attach: (id) => log.push(['attach', id]),
      damage_buffer: (...r) => log.push(['damage', ...r]),
      commit: () => log.push(['commit']),
    },
  };
}

const dri = { GBM_USE: { RENDERING: 4, LINEAR: 16 } };
const rect = (x, w = 10) => ({ x, y: 0, width: w, height: 10 });

test('a new buffer is imported once, then attached by its cached wl_buffer', async () => {
  const log = [];
  const gbm = fakeGbm(3);
  const dmabuf = fakeDmabuf(log);
  const chain = new WaylandSwapchain({
    surface: fakeSurface(log),
    dmabuf,
    gpu: fakeGpu(gbm),
    dri,
    format: 1,
  });
  chain.surfaceFor(100, 50);
  for (let i = 0; i < 3; i++) assert.equal(await chain.swap('all'), true);
  assert.equal(dmabuf.imports, 3, 'three buffers, three imports');
  assert.deepEqual(
    log.filter((l) => l[0] === 'add').map((l) => l[1]),
    [101, 102, 103],
    'each descriptor handed over once',
  );
  // release them all; the next three swaps reuse the cached wl_buffers
  for (const entry of chain.buffers.values()) entry.wlBuffer.emit('release');
  assert.equal(chain.inFlight, 0);
  for (let i = 0; i < 3; i++) assert.equal(await chain.swap('all'), true);
  assert.equal(dmabuf.imports, 3, 'no new imports in steady state');
  assert.equal(log.filter((l) => l[0] === 'attach').length, 6);
});

test('blitHint is everything until every buffer has been seen, then the union of what they owe', async () => {
  const log = [];
  const gbm = fakeGbm(2);
  const chain = new WaylandSwapchain({
    surface: fakeSurface(log),
    dmabuf: fakeDmabuf(log),
    gpu: fakeGpu(gbm),
    dri,
    format: 1,
  });
  chain.surfaceFor(100, 50);
  assert.equal(chain.blitHint([rect(0)]), 'all', 'nothing known yet');
  await chain.swap([rect(0)]); // buffer 1 shown with frame A
  for (const e of chain.buffers.values()) e.wlBuffer.emit('release');
  assert.equal(
    chain.blitHint([rect(10)]),
    'all',
    'buffer 2 has never been seen',
  );
  await chain.swap([rect(10)]); // buffer 2 shown with frame B; buffer 1 now owes B
  for (const e of chain.buffers.values()) e.wlBuffer.emit('release');
  assert.equal(
    chain.steady,
    false,
    'a full rotation without a new buffer is not complete yet',
  );
  await chain.swap([rect(20)]); // buffer 1 again: owes B, shown with C; buffer 2 owes C
  for (const e of chain.buffers.values()) e.wlBuffer.emit('release');
  await chain.swap([rect(30)]);
  for (const e of chain.buffers.values()) e.wlBuffer.emit('release');
  assert.equal(chain.steady, true);
  const hint = chain.blitHint([rect(40)]);
  assert.notEqual(hint, 'all');
  const xs = hint.map((r) => r.x).sort((a, b) => a - b);
  assert.deepEqual(
    xs,
    [30, 40],
    'this frame plus what the other buffer still owes',
  );
});

test('each buffer is damaged by everything that changed since it was last shown', async () => {
  const log = [];
  const gbm = fakeGbm(2);
  const chain = new WaylandSwapchain({
    surface: fakeSurface(log),
    dmabuf: fakeDmabuf(log),
    gpu: fakeGpu(gbm),
    dri,
    format: 1,
  });
  chain.surfaceFor(100, 50);
  const damages = () =>
    log.filter((l) => l[0] === 'damage').map((l) => l.slice(1));
  await chain.swap([rect(0)]); // b1: A
  for (const e of chain.buffers.values()) e.wlBuffer.emit('release');
  await chain.swap([rect(10)]); // b2: B  (b1 owes B)
  for (const e of chain.buffers.values()) e.wlBuffer.emit('release');
  log.length = 0;
  await chain.swap([rect(20)]); // b1 again: must report B ∪ C
  const reported = damages()
    .map((d) => d[0])
    .sort((a, b) => a - b);
  assert.deepEqual(
    reported,
    [10, 20],
    'the buffer that missed frame B reports B and C',
  );
});

test('a resize replaces the buffers: new generation, new imports, old releases ignored', async () => {
  const log = [];
  const gbm = fakeGbm(2);
  const dmabuf = fakeDmabuf(log);
  const chain = new WaylandSwapchain({
    surface: fakeSurface(log),
    dmabuf,
    gpu: fakeGpu(gbm),
    dri,
    format: 1,
  });
  chain.surfaceFor(100, 50);
  await chain.swap('all');
  const [oldEntry] = chain.buffers.values();
  assert.equal(chain.surfaceFor(100, 50), gbm, 'the same size is free');
  assert.equal(gbm.generation, 0);
  chain.surfaceFor(200, 80);
  assert.equal(gbm.generation, 1, 'resized in place, generation moved on');
  assert.equal(
    chain.buffers.size,
    0,
    "the old generation's wl_buffers are gone",
  );
  assert.ok(
    log.some((l) => l[0] === 'destroy-buffer'),
    'and were destroyed on the wire',
  );
  assert.equal(chain.inFlight, 0);
  // a late release of an old-generation buffer is harmless
  oldEntry.wlBuffer.emit('release');
  assert.equal(chain.inFlight, 0);
  await chain.swap('all');
  assert.equal(dmabuf.imports, 2, 'the new generation imports afresh');
  assert.equal(chain.steady, false);
});

test('starvation: with every buffer held, swap answers false and recovers on release', async () => {
  const log = [];
  const gbm = fakeGbm(2);
  const chain = new WaylandSwapchain({
    surface: fakeSurface(log),
    dmabuf: fakeDmabuf(log),
    gpu: fakeGpu(gbm),
    dri,
    format: 1,
    policy: { maxInFlight: 8 },
  });
  chain.surfaceFor(10, 10);
  assert.equal(await chain.swap('all'), true);
  assert.equal(await chain.swap('all'), true);
  assert.equal(
    await chain.swap('all'),
    false,
    "both buffers are the compositor's",
  );
  assert.equal(chain.starved, true);
  let readied = 0;
  chain.onReady = () => readied++;
  [...chain.buffers.values()][0].wlBuffer.emit('release');
  assert.equal(
    readied,
    1,
    'a release while starved says a frame is possible again',
  );
  assert.equal(await chain.swap('all'), true);
  assert.equal(chain.starved, false);
});
