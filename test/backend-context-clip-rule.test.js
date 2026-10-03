// The fill rule of a clip on the Windows and macOS context
// (`BackendContext2D`), as canvas has it: `clip(rule)` and
// `clip(path, rule)`, the overloads `fill` takes.
//
// `clip` took one argument and called `ctxClip` with the surface alone, so
// `'evenodd'` never left the class and every clip was cut by nonzero. That
// was invisible until ntk 8.22.0's SvgView cut elements to a `<clipPath>`
// with its `clip-rule` (sidorares/ntk#529): a ring clipped `evenodd` on X11
// came out a filled square on macOS and Windows. The rule now reaches the
// bridge as the flag `ctxFill` takes.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BackendContext2D } from '../src/backend/context2d.js';

/** a bridge that records the path and clip calls, and no-ops the rest */
function context() {
  const calls = [];
  let seq = 0;
  const native = new Proxy(
    {
      createSurface: (width, height) => ({ id: ++seq, width, height }),
      surfaceSize: (s) => ({ width: s.width, height: s.height }),
      ctxBeginPath: () => calls.push(['begin']),
      ctxMoveTo: (s, x, y) => calls.push(['M', x, y]),
      ctxLineTo: (s, x, y) => calls.push(['L', x, y]),
      ctxRect: (s, x, y, w, h) => calls.push(['rect', x, y, w, h]),
      ctxClosePath: () => calls.push(['Z']),
      ctxClip: (s, evenodd) => calls.push(['clip', evenodd]),
      ctxSetBlendMode: () => true,
      blitSurface: (src, sx, sy, w, h, dst, dx, dy, clip) =>
        calls.push(['blit', clip]),
    },
    { get: (t, k) => (k in t ? t[k] : () => undefined) },
  );
  const surface = native.createSurface(200, 100);
  const ctx = new BackendContext2D(
    native,
    () => surface,
    () => 1,
  );
  calls.length = 0;
  return { ctx, calls, native };
}

/** the flag each `ctxClip` was handed, in order */
const clips = (calls) => calls.filter((c) => c[0] === 'clip').map((c) => c[1]);

/** a 40px square with a 20px hole: nonzero fills it, evenodd leaves the hole */
function ring(ctx) {
  ctx.beginPath();
  ctx.rect(0, 0, 40, 40);
  ctx.rect(10, 10, 20, 20);
}

/** the same ring as a Path2D: ntk's `_cmds`, which is what SvgView hands over */
const RING_PATH = {
  _cmds: [
    { type: 'M', x: 0, y: 0 },
    { type: 'L', x: 40, y: 0 },
    { type: 'L', x: 40, y: 40 },
    { type: 'L', x: 0, y: 40 },
    { type: 'Z' },
    { type: 'M', x: 10, y: 10 },
    { type: 'L', x: 30, y: 10 },
    { type: 'L', x: 30, y: 30 },
    { type: 'L', x: 10, y: 30 },
    { type: 'Z' },
  ],
};

describe('the rule reaches the bridge', () => {
  test("clip('evenodd') clips the current path evenodd", () => {
    const { ctx, calls } = context();
    ring(ctx);
    ctx.clip('evenodd');
    assert.deepEqual(clips(calls), [true]);
  });

  test("clip() and clip('nonzero') clip nonzero, as they always did", () => {
    const { ctx, calls } = context();
    ring(ctx);
    ctx.clip();
    ring(ctx);
    ctx.clip('nonzero');
    assert.deepEqual(clips(calls), [false, false]);
  });

  test("clip(path, 'evenodd') replays the path and clips it evenodd", () => {
    const { ctx, calls } = context();
    ctx.clip(RING_PATH, 'evenodd');
    const at = calls.findIndex((c) => c[0] === 'clip');
    // the path the clip cuts to is the one handed in, both of its rings
    assert.equal(calls.slice(0, at).filter((c) => c[0] === 'M').length, 2);
    assert.deepEqual(clips(calls), [true]);
  });

  test('clip(path) clips nonzero', () => {
    const { ctx, calls } = context();
    ctx.clip(RING_PATH);
    assert.deepEqual(clips(calls), [false]);
  });

  test('anything but evenodd is nonzero, as fill reads it', () => {
    const { ctx, calls } = context();
    ring(ctx);
    ctx.clip('even-odd');
    ctx.clip(RING_PATH, 'EVENODD');
    assert.deepEqual(clips(calls), [false, false]);
  });

  test('a path argument that is no path clips nothing', () => {
    const { ctx, calls } = context();
    ctx.clip({}, 'evenodd');
    assert.deepEqual(clips(calls), []);
  });

  test('fill and clip read the rule the same way', () => {
    // the pattern clip copies: the flag ctxFill has always taken
    const { ctx, native } = context();
    const fills = [];
    native.ctxFill = (s, evenodd) => fills.push(evenodd);
    for (const rule of ['evenodd', 'nonzero', undefined]) {
      ring(ctx);
      ctx.fill(rule);
      ctx.fill(RING_PATH, rule);
    }
    const { ctx: c2, calls } = context();
    for (const rule of ['evenodd', 'nonzero', undefined]) {
      ring(c2);
      c2.clip(rule);
      c2.clip(RING_PATH, rule);
    }
    assert.deepEqual(clips(calls), fills);
  });
});

// `_blit` copies with a memcpy that cannot see the CGContext's clip, so the
// class keeps the clip as a rect where it can name one. One rect is one
// subpath wound once, which either rule cuts alike — so an evenodd rect is
// still the rect, and the fast path must not drop it.
describe('the rect a blit is held to', () => {
  const blits = (calls) => calls.filter((c) => c[0] === 'blit');

  function copyOver(ctx, native) {
    ctx.globalCompositeOperation = 'copy';
    const src = { _surfaceHandle: native.createSurface(40, 20) };
    return () => ctx.drawImage(src, 0, 0);
  }

  test('an evenodd rect clip is the rect, and the blit is held to it', () => {
    const { ctx, calls, native } = context();
    const draw = copyOver(ctx, native);
    ctx.beginPath();
    ctx.rect(20, 10, 100, 40);
    ctx.clip('evenodd');
    draw();
    assert.deepEqual(blits(calls), [['blit', [20, 10, 100, 40]]]);
    assert.deepEqual(clips(calls), [true]);
  });

  test('an evenodd ring is not a rect: the blit is off under it', () => {
    const { ctx, calls, native } = context();
    const draw = copyOver(ctx, native);
    ring(ctx);
    ctx.clip('evenodd');
    draw();
    assert.deepEqual(blits(calls), []);
  });

  test('an evenodd rect inside a rect clip intersects with it', () => {
    const { ctx, calls, native } = context();
    const draw = copyOver(ctx, native);
    ctx.beginPath();
    ctx.rect(20, 10, 100, 40);
    ctx.clip();
    ctx.beginPath();
    ctx.rect(60, 0, 100, 30);
    ctx.clip('evenodd');
    draw();
    assert.deepEqual(blits(calls), [['blit', [60, 10, 60, 20]]]);
  });
});
