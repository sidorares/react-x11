// `useFrame` — the per-surface frame clock.
//
// The bus is the whole mechanism, and it is a plain object, so most of this
// is hermetic. The one thing worth checking against a real surface is that
// subscribing makes it animate: a `<Canvas3D>` redraws on demand by default,
// and a clock nothing drives would tick once and stop.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createFrameBus } from '../src/frame3d.js';

describe('the frame bus', () => {
  test('runs subscribers in order and reports that it did', () => {
    const bus = createFrameBus();
    const order = [];
    bus.subscribe(() => order.push('first'));
    bus.subscribe(() => order.push('second'));
    assert.equal(bus.run({}, 0.016), true);
    assert.deepEqual(order, ['first', 'second']);
  });

  test('an empty bus reports that nothing ran', () => {
    // this is what keeps a demand-driven surface from animating for nobody
    assert.equal(createFrameBus().run({}, 0.016), false);
  });

  test('hands each subscriber the state and the delta', () => {
    const bus = createFrameBus();
    const seen = [];
    bus.subscribe((state, delta) => seen.push({ state, delta }));
    bus.run({ elapsed: 1.5, frame: 90 }, 0.016);
    assert.equal(seen[0].delta, 0.016);
    assert.equal(seen[0].state.elapsed, 1.5);
    assert.equal(seen[0].state.frame, 90);
  });

  test('unsubscribing stops the callback and empties the bus', () => {
    const bus = createFrameBus();
    let runs = 0;
    const stop = bus.subscribe(() => runs++);
    bus.run({}, 0);
    stop();
    bus.run({}, 0);
    assert.equal(runs, 1);
    assert.equal(bus.size, 0);
  });

  test('a subscriber that unmounts mid-frame does not skip its neighbour', () => {
    // the callbacks are iterated over a copy for exactly this: unsubscribing
    // during iteration would otherwise shift the set under the loop
    const bus = createFrameBus();
    const ran = [];
    let stopSecond;
    bus.subscribe(() => {
      ran.push('first');
      stopSecond();
    });
    stopSecond = bus.subscribe(() => ran.push('second'));
    bus.subscribe(() => ran.push('third'));
    bus.run({}, 0);
    assert.deepEqual(ran, ['first', 'second', 'third']);
  });

  test('a subscriber added during a frame joins the next one', () => {
    const bus = createFrameBus();
    const ran = [];
    bus.subscribe(() => {
      ran.push('first');
      if (bus.size === 1) bus.subscribe(() => ran.push('late'));
    });
    bus.run({}, 0);
    assert.deepEqual(ran, ['first'], 'not this frame');
    bus.run({}, 0);
    assert.deepEqual(ran, ['first', 'first', 'late'], 'the next one');
  });
});

describe('the surface clock', () => {
  /** A `<glarea>`-shaped stub: just the parts _runFrameCallbacks touches. */
  async function surfaceWithBus(bus) {
    const { GlAreaNode } = await import('../src/glnodes.js');
    const node = Object.create(GlAreaNode.prototype);
    node.props = { frames: bus };
    node.scene = { camera: { width: 4, height: 2 } };
    return node;
  }

  test('delta is seconds, and elapsed counts from the first frame', async () => {
    const bus = createFrameBus();
    const seen = [];
    bus.subscribe((state, delta) => seen.push({ state, delta }));
    const node = await surfaceWithBus(bus);

    node._runFrameCallbacks({ width: 10, height: 5 }, { backend: 'direct' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    node._runFrameCallbacks({ width: 10, height: 5 }, { backend: 'direct' });

    assert.equal(seen[0].delta, 0, 'the first frame has no previous one');
    assert.ok(
      seen[1].delta >= 0.02 && seen[1].delta < 0.1,
      `~30ms in seconds, got ${seen[1].delta}`,
    );
    assert.ok(seen[1].state.elapsed >= 0.02);
    assert.deepEqual(
      seen.map((s) => s.state.frame),
      [1, 2],
    );
  });

  test('a long stall does not teleport whatever integrates on delta', async () => {
    const bus = createFrameBus();
    const deltas = [];
    bus.subscribe((_state, delta) => deltas.push(delta));
    const node = await surfaceWithBus(bus);
    node._runFrameCallbacks({ width: 1, height: 1 }, {});
    // the surface was occluded, or the process was paused
    node._lastFrameAt -= 5000;
    node._runFrameCallbacks({ width: 1, height: 1 }, {});
    assert.equal(deltas[1], 0.1, 'clamped, rather than five seconds of motion');
  });

  test('the state carries what a callback needs to draw with', async () => {
    const bus = createFrameBus();
    let state = null;
    bus.subscribe((s) => (state = s));
    const node = await surfaceWithBus(bus);
    const gl = { backend: 'direct' };
    node._runFrameCallbacks({ width: 320, height: 240 }, gl);
    assert.equal(state.gl, gl);
    assert.equal(state.backend, 'direct');
    assert.equal(state.width, 320);
    assert.equal(state.height, 240);
    assert.equal(state.camera, node.scene.camera);
    assert.equal(state.node, node);
  });

  test('an indirect context is reported as such', async () => {
    const bus = createFrameBus();
    let backend = null;
    bus.subscribe((s) => (backend = s.backend));
    const node = await surfaceWithBus(bus);
    // the indirect context has no `backend` field of its own
    node._runFrameCallbacks({ width: 1, height: 1 }, {});
    assert.equal(backend, 'indirect');
  });

  test('a surface with no subscribers does no per-frame work', async () => {
    const node = await surfaceWithBus(createFrameBus());
    assert.equal(node._runFrameCallbacks({ width: 1, height: 1 }, {}), false);
    assert.equal(node._frameCount, undefined, 'not even a frame counter');
  });
});
