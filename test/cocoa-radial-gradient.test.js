// `createRadialGradient` on the native context: canvas's two-circle
// gradient, filled by @windowkit/appkit's `ctxFillRadialGradient`. Before
// the bridge had one the context answered with a linear gradient along no
// line, which paints flat — every radial gradient a page drew, a CSS one
// included, came out in one colour — and on a bridge without one it still
// does, taking no circles, which is how a caller tells the two apart.
//
// Two layers, as elsewhere in the Cocoa tests: a fake bridge records what
// reaches the natives, and where the real bridge loads with the fill, the
// pixels.
import assert from 'node:assert';
import { describe, test } from 'node:test';

import { BackendContext2D } from '../src/backend/context2d.js';
import { loadNative } from '../src/cocoa/native.js';

function fakeNative({ radial = true } = {}) {
  const calls = [];
  let seq = 0;
  const native = {
    calls,
    of: (name) => calls.filter((c) => c[0] === name).map((c) => c.slice(1)),
    createSurface(width, height) {
      return { id: ++seq, width, height };
    },
    ctxFillLinearGradient(handle, ...rest) {
      calls.push(['ctxFillLinearGradient', handle.id, ...rest]);
    },
    // what a filter needs of a bridge, or it does not stick
    ctxGetImageData: () => new Uint8Array(0),
    ctxPutImageData() {},
  };
  if (radial) {
    native.ctxFillRadialGradient = (handle, ...rest) => {
      calls.push(['ctxFillRadialGradient', handle.id, ...rest]);
    };
  }
  return new Proxy(native, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
    has: (target, key) => key in target,
  });
}

function context(options) {
  const native = fakeNative(options);
  const dst = native.createSurface(100, 100);
  const ctx = new BackendContext2D(
    native,
    () => dst,
    () => 1,
  );
  return { ctx, native, dst };
}

test('a radial gradient fills a rect, and a path, from its circles, its stops in order', () => {
  const { ctx, native, dst } = context();
  assert.equal(ctx.createRadialGradient.length, 6, 'it takes circles');
  const g = ctx.createRadialGradient(50, 40, 0, 50, 40, 30);
  g.addColorStop(1, '#0000ff');
  g.addColorStop(0, '#ff0000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 100, 80);
  ctx.beginPath();
  ctx.rect(10, 10, 20, 20);
  ctx.fill();
  const stops = [0, 1, 0, 0, 1, 1, 0, 0, 1, 1];
  assert.deepEqual(native.of('ctxFillRadialGradient'), [
    [dst.id, 50, 40, 0, 50, 40, 30, stops, 0, 0, 100, 80],
    [dst.id, 50, 40, 0, 50, 40, 30, stops],
  ]);
  assert.equal(native.of('ctxFillLinearGradient').length, 0);
});

test("a radial gradient's stops are drawn in the colours the filter makes, and a negative radius is refused", () => {
  const { ctx, native } = context();
  ctx.filter = 'invert(1)';
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 10);
  g.addColorStop(0, '#ff0000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 10, 10);
  const [[, , , , , , , stops]] = native.of('ctxFillRadialGradient');
  assert.deepEqual(stops.slice(1, 5), [0, 1, 1, 1], 'red inverted is cyan');
  assert.equal(stops.length, 10, 'one stop is a colour end to end');
  assert.throws(() => ctx.createRadialGradient(0, 0, -1, 0, 0, 10), RangeError);
});

test('a bridge with no radial fill keeps the flat stand-in, which takes no circles', () => {
  const { ctx, native } = context({ radial: false });
  assert.equal(ctx.createRadialGradient.length, 0);
  ctx.fillStyle = ctx.createRadialGradient(50, 50, 0, 50, 50, 40);
  ctx.fillRect(0, 0, 10, 10);
  assert.equal(native.of('ctxFillLinearGradient').length, 1);
});

let bridge = null;
try {
  bridge = loadNative();
} catch {
  bridge = null;
}

describe(
  'against the real bridge',
  {
    skip:
      bridge && 'ctxFillRadialGradient' in bridge
        ? false
        : 'no @windowkit/appkit bridge with ctxFillRadialGradient here',
  },
  () => {
    test('red at the centre, blue at the end circle and past it, and between halfway out', () => {
      const handle = bridge.createSurface(100, 100, 1);
      const ctx = new BackendContext2D(
        bridge,
        () => handle,
        () => 1,
      );
      const g = ctx.createRadialGradient(50, 50, 0, 50, 50, 40);
      g.addColorStop(0, '#ff0000');
      g.addColorStop(1, '#0000ff');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 100, 100);
      const at = (x, y) => [...bridge.ctxGetImageData(handle, x, y, 1, 1)];
      const close = (a, b, by = 6) =>
        a.every((v, i) => Math.abs(v - b[i]) <= by);
      assert.ok(close(at(50, 50), [255, 0, 0, 255]), `${at(50, 50)}`);
      assert.ok(close(at(95, 50), [0, 0, 255, 255]), `${at(95, 50)}`);
      const [r, , b] = at(70, 50);
      assert.ok(r > 90 && r < 165 && b > 90 && b < 165, `${at(70, 50)}`);
      bridge.releaseSurface(handle);
    });
  },
);
