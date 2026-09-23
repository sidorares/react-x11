// The dash offset on the Windows and macOS context (`BackendContext2D`).
//
// The context had `setLineDash` and no `lineDashOffset`, and sent every
// pattern to the bridge at an offset of nought. A caller that feature-tests
// with `'lineDashOffset' in ctx` — as it must, the property being optional
// in the canvas it was written against — found none and set none, so an
// animated edge's dashes were repainted sixteen times a second on those two
// backends and never moved. Both bridges take the offset already; this is
// what reaches them.
import assert from 'node:assert';
import { test } from 'node:test';

import { BackendContext2D } from '../src/backend/context2d.js';

/** a bridge that records the dash calls, and no-ops the rest */
function context() {
  const calls = [];
  const native = new Proxy(
    {
      ctxSetLineDash: (surface, dash, offset) =>
        calls.push([[...dash], offset]),
    },
    { get: (t, k) => (k in t ? t[k] : () => undefined) },
  );
  const surface = { fake: true };
  const ctx = new BackendContext2D(
    native,
    () => surface,
    () => 1,
  );
  // the first call on a fresh surface pushes the sticky state across
  ctx.lineWidth = 1;
  calls.length = 0;
  return { ctx, calls };
}

test('the offset is a property a caller can find, and it reaches the bridge', () => {
  const { ctx, calls } = context();
  assert.ok('lineDashOffset' in ctx, 'feature-tested with `in`');
  assert.strictEqual(ctx.lineDashOffset, 0);

  ctx.setLineDash([6, 4]);
  ctx.lineDashOffset = -3.5;
  assert.strictEqual(ctx.lineDashOffset, -3.5);
  assert.deepStrictEqual(calls, [
    [[6, 4], 0],
    [[6, 4], -3.5],
  ]);
});

test('a new pattern keeps the offset, as canvas does', () => {
  const { ctx, calls } = context();
  ctx.lineDashOffset = 5;
  ctx.setLineDash([2, 2]);
  assert.deepStrictEqual(calls.at(-1), [[2, 2], 5]);
});

test('anything but a finite number is ignored', () => {
  const { ctx, calls } = context();
  ctx.lineDashOffset = 2;
  calls.length = 0;
  for (const bad of [NaN, Infinity, -Infinity, '3', null, undefined]) {
    ctx.lineDashOffset = bad;
  }
  assert.strictEqual(ctx.lineDashOffset, 2);
  assert.deepStrictEqual(calls, []);
});

test('save and restore carry it', () => {
  const { ctx } = context();
  ctx.lineDashOffset = 1;
  ctx.save();
  ctx.lineDashOffset = 9;
  ctx.restore();
  assert.strictEqual(ctx.lineDashOffset, 1);
});
