// `roundRect` on the Windows and macOS context (`BackendContext2D`), as
// canvas has it (HTML, "roundRect"): a radius, a `{ x, y }` point for an
// elliptical corner, or a list of one to four of either, scaled down
// together where two corners on a side would meet.
//
// The context took numbers only, and clamped each to half the shorter side
// on its own: a `{ x, y }` was `Number(object)`, NaN, a square corner — so
// a CSS `border-radius: 40px / 20px` drawn through it came out square, and
// uneven radii came out other than a browser draws them. Circular corners
// still go to the bridge as `ctxRoundRect`; elliptical ones as
// `ctxRoundRectXY` where the bridge has it, and as curves where it does not
// — including in the one-call path stream, which a bridge that does not
// know the op would stop reading at.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BackendContext2D } from '../src/backend/context2d.js';

/** A bridge recording the path verbs; `xy` gives it `ctxRoundRectXY`,
 *  `bulk` the one-call `ctxPath`. */
function context({ xy = false, bulk = false } = {}) {
  const calls = [];
  const verbs = {
    ctxRoundRect: (s, ...a) => calls.push(['roundRect', ...a]),
    ctxMoveTo: (s, x, y) => calls.push(['moveTo', x, y]),
    ctxLineTo: (s, x, y) => calls.push(['lineTo', x, y]),
    ctxCurveTo: (s, ...a) => calls.push(['curveTo', ...a]),
    ctxClosePath: () => calls.push(['closePath']),
    ctxFill: () => calls.push(['fill']),
  };
  if (xy) verbs.ctxRoundRectXY = (s, ...a) => calls.push(['roundRectXY', ...a]);
  if (bulk) verbs.ctxPath = (s, buf) => calls.push(['path', [...buf]]);
  const native = new Proxy(verbs, {
    get: (t, k) => (k in t ? t[k] : () => undefined),
  });
  const surface = {};
  const ctx = new BackendContext2D(
    native,
    () => surface,
    () => 1,
  );
  ctx.lineWidth = 1;
  calls.length = 0;
  return { ctx, calls };
}

describe('the radii a canvas takes', () => {
  const radiiOf = (radii, w = 200, h = 100) => {
    const { ctx, calls } = context();
    ctx.roundRect(0, 0, w, h, radii);
    return calls.find((c) => c[0] === 'roundRect').slice(5);
  };

  test('one, two, three or four of them, clockwise from the top left', () => {
    assert.deepEqual(radiiOf(8), [8, 8, 8, 8]);
    assert.deepEqual(radiiOf([8]), [8, 8, 8, 8]);
    assert.deepEqual(radiiOf([8, 4]), [8, 4, 8, 4]);
    assert.deepEqual(radiiOf([8, 4, 2]), [8, 4, 2, 4]);
    assert.deepEqual(radiiOf([8, 4, 2, 1]), [8, 4, 2, 1]);
  });

  test('scaled down together where two corners on a side would meet', () => {
    // top: 90 + 30 on a side of 100, so every radius is five sixths of
    // itself — where clamping each to half the side made them 50 and 30
    assert.deepEqual(radiiOf([90, 30, 0, 0], 100, 200), [75, 25, 0, 0]);
    // a uniform radius comes out as it always did, half the shorter side
    assert.deepEqual(radiiOf(80, 200, 100), [50, 50, 50, 50]);
  });

  test('a negative radius is none', () => {
    assert.deepEqual(radiiOf([-4, 6]), [0, 6, 0, 6]);
  });

  test('a box of negative extent is the same box, its corners swapped across', () => {
    const { ctx, calls } = context();
    ctx.roundRect(100, 50, -80, -40, [1, 2, 3, 4]);
    assert.deepEqual(calls[0], ['roundRect', 20, 10, 80, 40, 3, 4, 1, 2]);
  });

  test('a box that is not finite adds nothing', () => {
    const { ctx, calls } = context();
    ctx.roundRect(0, NaN, 10, 10, 2);
    ctx.roundRect(0, 0, Infinity, 10, 2);
    assert.deepEqual(calls, []);
  });
});

describe('an elliptical corner', () => {
  const ellipse = [{ x: 40, y: 20 }, 10, { x: 30, y: 30 }, { x: 5, y: 15 }];

  test('goes to a bridge that takes one whole', () => {
    const { ctx, calls } = context({ xy: true });
    ctx.roundRect(10, 20, 200, 100, ellipse);
    assert.deepEqual(calls, [
      ['roundRectXY', 10, 20, 200, 100, 40, 20, 10, 10, 30, 30, 5, 15],
    ]);
  });

  test('is curves to one that does not, a quarter ellipse at each corner', () => {
    const { ctx, calls } = context();
    ctx.roundRect(10, 20, 200, 100, ellipse);
    assert.deepEqual(
      calls.map((c) => c[0]),
      [
        'moveTo',
        'lineTo',
        'curveTo',
        'lineTo',
        'curveTo',
        'lineTo',
        'curveTo',
        'lineTo',
        'curveTo',
        'closePath',
      ],
    );
    // the top right corner runs from 10 in along the top to 10 down the side
    assert.deepEqual(calls[1], ['lineTo', 200, 20]);
    assert.deepEqual(calls[2].slice(-2), [210, 30]);
    // the top left one, 40 across and 20 down, closes the shape
    assert.deepEqual(calls[0], ['moveTo', 50, 20]);
    assert.deepEqual(calls[7], ['lineTo', 10, 40]);
  });

  test('with no extent on one of its axes is a square corner', () => {
    const { ctx, calls } = context();
    ctx.roundRect(0, 0, 100, 100, [{ x: 10, y: 0 }, 10, 10, 10]);
    assert.deepEqual(calls[0], ['roundRect', 0, 0, 100, 100, 0, 10, 10, 10]);
  });

  test('in a whole path, is curves to a bridge that does not know the op', () => {
    const { ctx, calls } = context({ bulk: true });
    ctx.beginPath();
    ctx.rect(0, 0, 300, 200);
    ctx.roundRect(10, 20, 200, 100, ellipse);
    ctx.fill('evenodd');
    const [, stream] = calls.find((c) => c[0] === 'path');
    // walk the stream by the ops' own lengths: no op 9 anywhere in it
    const lengths = [2, 2, 6, 4, 0, 4, 8, 6, 4];
    const ops = [];
    for (let i = 0; i < stream.length; i += 1 + lengths[stream[i]]) {
      ops.push(stream[i]);
    }
    assert.equal(ops[0], 5, 'the rect as it was');
    assert.ok(!ops.includes(9));
    assert.ok(ops.includes(2), 'the corners as curves');
  });

  test('in a whole path, is op 9 to a bridge that takes it', () => {
    const { ctx, calls } = context({ bulk: true, xy: true });
    ctx.beginPath();
    ctx.roundRect(10, 20, 200, 100, ellipse);
    ctx.fill();
    const [, stream] = calls.find((c) => c[0] === 'path');
    assert.deepEqual(
      stream,
      [9, 10, 20, 200, 100, 40, 20, 10, 10, 30, 30, 5, 15],
    );
  });
});
