// `globalCompositeOperation` on the Cocoa context, and the row memcpy the
// `copy` op unlocks for a surface composited at a translate (issue #498).
//
// Two layers, as elsewhere in the Cocoa tests. The first runs everywhere: a
// fake bridge records what reaches the natives, which is the whole of what
// the JS decides — including what it decides when the bridge is an older
// @windowkit/appkit with neither verb, since that is what feature detection
// is for. The second runs where the bridge loads and ends in pixels, where
// the only thing worth pinning is that the blit and the draw agree.
import assert from 'node:assert';
import { describe, test } from 'node:test';

import { CocoaContext2D } from '../src/cocoa/context2d.js';
import { loadNative } from '../src/cocoa/native.js';

/**
 * A bridge shaped like @windowkit/appkit's surface natives. `verbs: false`
 * is anything before 0.7.0, which has neither `ctxSetBlendMode` nor
 * `blitSurface`; `vocabulary` is the set of ops the blend verb claims, so a
 * test can also be a bridge that knows fewer than this one does.
 */
const CANVAS_OPS = [
  'source-over',
  'copy',
  'destination-over',
  'source-in',
  'destination-in',
  'source-out',
  'destination-out',
  'source-atop',
  'destination-atop',
  'xor',
  'lighter',
  'multiply',
];

function fakeNative({ verbs = true, vocabulary = new Set(CANVAS_OPS) } = {}) {
  const calls = [];
  let seq = 0;
  const native = {
    calls,
    of: (name) => calls.filter((c) => c[0] === name).map((c) => c.slice(1)),
    createSurface(width, height, scale) {
      return { id: ++seq, width, height, scale };
    },
    surfaceSize: (handle) => ({ width: handle.width, height: handle.height }),
    ctxDrawSurface(dst, src, ...rest) {
      calls.push(['ctxDrawSurface', dst.id, src.id, ...rest]);
    },
    ctxRect(handle, ...rect) {
      calls.push(['ctxRect', ...rect]);
    },
    ctxClip() {
      calls.push(['ctxClip']);
    },
    ctxSave() {
      calls.push(['ctxSave']);
    },
    ctxRestore() {
      calls.push(['ctxRestore']);
    },
  };
  if (verbs) {
    // @windowkit/appkit 0.7.0's contract: the names are canvas's own, and
    // the answer is whether the mode is now that one. `vocabulary` is what
    // this bridge claims to know, so a test can be a bridge that knows less.
    native.ctxSetBlendMode = (handle, mode) => {
      calls.push(['ctxSetBlendMode', mode]);
      return vocabulary.has(mode);
    };
    native.blitSurface = (src, sx, sy, w, h, dst, dx, dy, clip) =>
      calls.push(['blitSurface', src.id, sx, sy, w, h, dst.id, dx, dy, clip]);
  }
  // Everything else the context syncs is a no-op — but the two verbs this
  // is about are exactly what the context feature-detects, so a bridge
  // without them has to answer undefined rather than a no-op function.
  const absent = new Set(verbs ? [] : ['ctxSetBlendMode', 'blitSurface']);
  return new Proxy(native, {
    get: (target, key) =>
      absent.has(key)
        ? undefined
        : key in target
          ? target[key]
          : () => undefined,
  });
}

/** A context over a fresh 200x100 destination, and a 40x20 source to draw. */
function context(options) {
  const native = fakeNative(options);
  const dst = native.createSurface(200, 100, 1);
  const src = native.createSurface(40, 20, 1);
  const ctx = new CocoaContext2D(
    native,
    () => dst,
    () => 1,
  );
  native.calls.length = 0;
  return { ctx, native, dst, src: { _surfaceHandle: src } };
}

/** The one blit a test expects, as [sx, sy, w, h, dx, dy, clip]. */
const blit = (native) => {
  const calls = native.of('blitSurface');
  assert.equal(calls.length, 1, `${calls.length} blits`);
  const [, sx, sy, w, h, , dx, dy, clip] = calls[0];
  return [sx, sy, w, h, dx, dy, clip];
};
const drew = (native) => native.of('ctxDrawSurface').length;

// --- the property -------------------------------------------------------------

test('the default is source-over, and it goes nowhere near the bridge', () => {
  const { ctx, native } = context();
  assert.equal(ctx.globalCompositeOperation, 'source-over');
  assert.equal(native.of('ctxSetBlendMode').length, 0);
});

test('the op goes to the bridge as canvas spells it — there is no table here', () => {
  const { ctx, native } = context();
  for (const op of CANVAS_OPS) ctx.globalCompositeOperation = op;
  assert.deepEqual(
    native.of('ctxSetBlendMode').map(([mode]) => mode),
    CANVAS_OPS,
  );
  assert.equal(ctx.globalCompositeOperation, 'multiply');
});

test('an op the bridge refuses leaves the one in force, as canvas does', () => {
  // the bridge answering false is the whole mechanism: it left its own mode
  // alone, so this must leave its own state alone too
  const { ctx, native } = context({
    vocabulary: new Set(['source-over', 'copy']),
  });
  ctx.globalCompositeOperation = 'copy';
  native.calls.length = 0;
  for (const bad of ['xor', 'multiply', 'Copy', '', 'banana']) {
    ctx.globalCompositeOperation = bad;
    assert.equal(ctx.globalCompositeOperation, 'copy', String(bad));
  }
  assert.equal(native.of('ctxSetBlendMode').length, 5, 'each one was asked');
});

test('a value that is not a string never reaches the bridge', () => {
  const { ctx, native } = context();
  ctx.globalCompositeOperation = 'copy';
  native.calls.length = 0;
  for (const bad of [null, undefined, 3, {}]) {
    ctx.globalCompositeOperation = bad;
    assert.equal(ctx.globalCompositeOperation, 'copy', String(bad));
  }
  assert.equal(native.of('ctxSetBlendMode').length, 0);
});

test('on a bridge without the verb only source-over sticks — read it back', () => {
  const { ctx, native } = context({ verbs: false });
  ctx.globalCompositeOperation = 'copy';
  assert.equal(ctx.globalCompositeOperation, 'source-over');
  ctx.globalCompositeOperation = 'source-over';
  assert.equal(ctx.globalCompositeOperation, 'source-over');
  assert.equal(native.of('ctxSetBlendMode').length, 0);
});

test('save/restore carries the op, and a replaced surface is re-synced', () => {
  const { ctx, native } = context();
  ctx.globalCompositeOperation = 'copy';
  ctx.save();
  ctx.globalCompositeOperation = 'xor';
  ctx.restore();
  // the JS state is back; the native gstate came back with ctxRestore
  assert.equal(ctx.globalCompositeOperation, 'copy');

  let gen = 1;
  const surface = native.createSurface(8, 8, 1);
  const fresh = new CocoaContext2D(
    native,
    () => surface,
    () => gen,
  );
  fresh.globalCompositeOperation = 'copy';
  native.calls.length = 0;
  gen = 2;
  fresh.fillRect(0, 0, 1, 1);
  assert.deepEqual(native.of('ctxSetBlendMode'), [['copy']]);
  assert.equal(fresh.globalCompositeOperation, 'copy');
});

// --- the blit -----------------------------------------------------------------

test("under 'copy' at a whole-pixel translate the composite is a memcpy", () => {
  const { ctx, native, src } = context();
  ctx.globalCompositeOperation = 'copy';
  ctx.translate(30, 12);
  ctx.drawImage(src, 5, 7);
  assert.deepEqual(blit(native), [0, 0, 40, 20, 35, 19, null]);
  assert.equal(drew(native), 0);
});

test('a source rect draws that rect, and the size may be named twice', () => {
  const { ctx, native, src } = context();
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(src, 4, 6, 10, 8, 100, 50, 10, 8);
  assert.deepEqual(blit(native), [4, 6, 10, 8, 100, 50, null]);
  ctx.drawImage(src, 1, 2, 40, 20);
  const [, sx, sy, w, hh, , dx, dy] = native.of('blitSurface')[1];
  assert.deepEqual([sx, sy, w, hh, dx, dy], [0, 0, 40, 20, 1, 2]);
});

test('the paint still reports its damage — the blit is not a side door', () => {
  const { ctx, src } = context();
  let dirty = 0;
  ctx._onDirty = () => dirty++;
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(src, 0, 0);
  assert.equal(dirty, 2);
});

test('a bridge without blitSurface draws every time', () => {
  const { ctx, native, src } = context({ verbs: false });
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(src, 10, 10);
  assert.equal(native.of('blitSurface').length, 0);
  assert.equal(drew(native), 1);
});

describe('what makes it draw instead', () => {
  /** Sets up a `copy` blit, lets `set` spoil it, and asks who drew. */
  const spoiled = (set) => {
    const { ctx, native, src } = context();
    ctx.globalCompositeOperation = 'copy';
    set(ctx, src, native);
    ctx.drawImage(src, 10, 10);
    return { blits: native.of('blitSurface').length, draws: drew(native) };
  };
  const drawsInstead = (name, set) =>
    test(name, () => assert.deepEqual(spoiled(set), { blits: 0, draws: 1 }));

  drawsInstead('source-over — a blend is what CoreGraphics is for', (ctx) => {
    ctx.globalCompositeOperation = 'source-over';
  });
  drawsInstead('a scale — the draw resamples and the memcpy cannot', (ctx) => {
    ctx.scale(2, 2);
  });
  drawsInstead('a rotation', (ctx) => ctx.rotate(Math.PI / 2));
  drawsInstead('a fractional translate', (ctx) => ctx.translate(0.5, 0));
  drawsInstead('globalAlpha below 1', (ctx) => {
    ctx.globalAlpha = 0.99;
  });
  drawsInstead('a shadow that would ink', (ctx) => {
    ctx.shadowBlur = 4;
    ctx.shadowColor = '#000';
  });
  test('a shadow set to a transparent colour still blits', () => {
    assert.deepEqual(
      spoiled((ctx) => {
        ctx.shadowBlur = 4;
      }),
      { blits: 1, draws: 0 },
    );
  });
  test('a scaled destination rect draws; the same size blits', () => {
    const { ctx, native, src } = context();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(src, 0, 0, 40, 20, 0, 0, 80, 40);
    assert.equal(drew(native), 1);
    assert.equal(native.of('blitSurface').length, 0);
  });
  test('a fractional source rect draws — a half pixel has no row', () => {
    const { ctx, native, src } = context();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(src, 0.5, 0, 10, 8, 0, 0, 10, 8);
    assert.equal(drew(native), 1);
  });
  test('a surface composited into itself draws', () => {
    const { ctx, native, dst } = context();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage({ _surfaceHandle: dst }, 0, 0);
    assert.equal(native.of('blitSurface').length, 0);
    assert.equal(drew(native), 1);
  });
});

// --- the clip -----------------------------------------------------------------

/** The clip a paint pass sets: `beginPath` + `rect` + `clip`. */
function clipTo(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
}

describe('the clip a memcpy cannot see', () => {
  test('a rect clip rides along as the rect the blit is held to', () => {
    const { ctx, native, src } = context();
    ctx.globalCompositeOperation = 'copy';
    clipTo(ctx, 20, 10, 100, 40);
    ctx.drawImage(src, 0, 0);
    assert.deepEqual(blit(native)[6], [20, 10, 100, 40]);
  });

  test('the clip is in surface pixels: the transform is applied to it', () => {
    const { ctx, native, src } = context();
    ctx.globalCompositeOperation = 'copy';
    ctx.translate(8, 4);
    clipTo(ctx, 20, 10, 100, 40);
    ctx.drawImage(src, 0, 0);
    const [, , , , dx, dy, clip] = blit(native);
    assert.deepEqual([dx, dy], [8, 4]);
    assert.deepEqual(clip, [28, 14, 100, 40]);
  });

  test('two clips intersect, and a restore brings the outer one back', () => {
    const { ctx, native, src } = context();
    ctx.globalCompositeOperation = 'copy';
    clipTo(ctx, 20, 10, 100, 40);
    ctx.save();
    clipTo(ctx, 60, 0, 100, 30);
    ctx.drawImage(src, 0, 0);
    assert.deepEqual(blit(native)[6], [60, 10, 60, 20]);
    ctx.restore();
    ctx.drawImage(src, 0, 0);
    assert.deepEqual(native.of('blitSurface')[1][8], [20, 10, 100, 40]);
  });

  test('clips that do not meet leave an empty rect, not a wrong one', () => {
    const { ctx, native, src } = context();
    ctx.globalCompositeOperation = 'copy';
    clipTo(ctx, 0, 0, 10, 10);
    clipTo(ctx, 50, 50, 10, 10);
    ctx.drawImage(src, 0, 0);
    assert.deepEqual(blit(native)[6], [50, 50, 0, 0]);
  });

  test('a surface replaced under the context takes the clip with it', () => {
    const native = fakeNative();
    let gen = 1;
    let surface = native.createSurface(200, 100, 1);
    const ctx = new CocoaContext2D(
      native,
      () => surface,
      () => gen,
    );
    const src = { _surfaceHandle: native.createSurface(40, 20, 1) };
    ctx.globalCompositeOperation = 'copy';
    clipTo(ctx, 0, 0, 10, 10);
    surface = native.createSurface(200, 100, 1);
    gen = 2;
    native.calls.length = 0;
    ctx.drawImage(src, 0, 0);
    assert.equal(blit(native)[6], null);
  });

  describe('a clip this class cannot name turns the blit off', () => {
    const cannotName = (name, set) =>
      test(name, () => {
        const { ctx, native, src } = context();
        ctx.globalCompositeOperation = 'copy';
        ctx.beginPath();
        set(ctx);
        ctx.clip();
        ctx.drawImage(src, 0, 0);
        assert.equal(native.of('blitSurface').length, 0);
        assert.equal(drew(native), 1);
      });

    cannotName('a rounded rect', (ctx) => ctx.roundRect(0, 0, 40, 40, 6));
    cannotName('an arc', (ctx) => ctx.arc(20, 20, 10, 0, Math.PI * 2));
    cannotName('a polygon', (ctx) => {
      ctx.moveTo(0, 0);
      ctx.lineTo(10, 0);
      ctx.lineTo(10, 10);
      ctx.closePath();
    });
    cannotName('two rects, which is a union rather than a rect', (ctx) => {
      ctx.rect(0, 0, 10, 10);
      ctx.rect(20, 20, 10, 10);
    });
    cannotName('a rect on half pixels', (ctx) => ctx.rect(0.5, 0, 10, 10));
    cannotName('a rect under a rotation', (ctx) => {
      ctx.rotate(0.3);
      ctx.rect(0, 0, 10, 10);
    });

    test('and it stays off for every clip inside it', () => {
      const { ctx, native, src } = context();
      ctx.globalCompositeOperation = 'copy';
      ctx.beginPath();
      ctx.arc(20, 20, 10, 0, Math.PI * 2);
      ctx.clip();
      clipTo(ctx, 0, 0, 10, 10);
      ctx.drawImage(src, 0, 0);
      assert.equal(native.of('blitSurface').length, 0);
    });

    test('a restore past it puts the blit back', () => {
      const { ctx, native, src } = context();
      ctx.globalCompositeOperation = 'copy';
      clipTo(ctx, 20, 10, 100, 40);
      ctx.save();
      ctx.beginPath();
      ctx.arc(20, 20, 10, 0, Math.PI * 2);
      ctx.clip();
      ctx.restore();
      ctx.drawImage(src, 0, 0);
      assert.deepEqual(blit(native)[6], [20, 10, 100, 40]);
    });
  });
});

// --- and in pixels ------------------------------------------------------------

let bridge = null;
try {
  bridge = loadNative();
} catch {
  bridge = null;
}
const hasVerbs =
  bridge &&
  typeof bridge.blitSurface === 'function' &&
  typeof bridge.ctxSetBlendMode === 'function';

describe(
  'against the real bridge',
  {
    skip: hasVerbs
      ? false
      : bridge
        ? 'this @windowkit/appkit is older than 0.7.0'
        : 'the @windowkit/appkit bridge is not loadable here',
  },
  () => {
    const W = 128;
    const H = 96;
    const SW = 61;
    const SH = 37;

    /** A source surface whose every pixel is a function of where it is, so
     *  a blit landing one row or column off is a difference. */
    const source = () => {
      const s = bridge.createSurface(SW, SH, 1);
      for (let y = 0; y < SH; y++) {
        for (let x = 0; x < SW; x++) {
          bridge.ctxSetFillColor(s, x / SW, y / SH, ((x + y) % 8) / 8, 1);
          bridge.ctxFillRect(s, x, y, 1, 1);
        }
      }
      return s;
    };

    /** Composite `src` at (dx, dy) into a fresh destination, `blits` saying
     *  which route: the memcpy, or the CGImage draw the bridge would take
     *  without it. Returns the destination's pixels. */
    const composite = ({ src, dx, dy, clip, blits, translate = [0, 0] }) => {
      const dst = bridge.createSurface(W, H, 1);
      const native = blits
        ? bridge
        : new Proxy(bridge, {
            get: (t, k) => (k === 'blitSurface' ? undefined : t[k]),
          });
      const ctx = new CocoaContext2D(
        native,
        () => dst,
        () => 1,
      );
      ctx.fillStyle = '#2b8a3e';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'copy';
      assert.equal(ctx.globalCompositeOperation, 'copy');
      ctx.translate(translate[0], translate[1]);
      if (clip) {
        ctx.beginPath();
        ctx.rect(clip[0], clip[1], clip[2], clip[3]);
        ctx.clip();
      }
      ctx.drawImage({ _surfaceHandle: src }, dx, dy);
      return Buffer.from(bridge.ctxGetImageData(dst, 0, 0, W, H));
    };

    const agree = (name, options) =>
      test(name, () => {
        const src = source();
        const blitted = composite({ ...options, src, blits: true });
        const drawn = composite({ ...options, src, blits: false });
        let differing = 0;
        for (let i = 0; i < drawn.length; i++) {
          if (blitted[i] !== drawn[i]) differing++;
        }
        assert.equal(differing, 0, `${differing} channels differ`);
        // and the source actually landed: the ground is one colour, so a
        // no-op blit would be a destination of nothing but it
        let ink = 0;
        for (let i = 0; i < blitted.length; i += 4) {
          if (blitted[i] !== 43 || blitted[i + 1] !== 138) ink++;
        }
        assert.ok(ink > 100, `the source landed: ${ink} pixels`);
      });

    agree('at the origin', { dx: 0, dy: 0 });
    agree('at an offset', { dx: 21, dy: 13 });
    agree('under a translate', { dx: 5, dy: 7, translate: [30, 20] });
    agree('clipped to a rect it straddles', {
      dx: 20,
      dy: 20,
      clip: [30, 30, 20, 12],
    });
    agree('clipped and translated', {
      dx: 4,
      dy: 4,
      translate: [16, 8],
      clip: [20, 10, 40, 40],
    });
    agree('hanging off the right and bottom edges', { dx: W - 12, dy: H - 9 });

    test('the memcpy writes the source alpha, where a blend would not', () => {
      // a translucent source: `copy` replaces the destination's alpha with
      // the source's, which is the whole difference between it and
      // source-over, and the memcpy has to make that difference too
      const src = bridge.createSurface(8, 8, 1);
      bridge.ctxSetFillColor(src, 1, 0, 0, 0.5);
      bridge.ctxFillRect(src, 0, 0, 8, 8);
      const px = composite({ src, dx: 4, dy: 4, blits: true });
      const at = (x, y) => [...px.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];
      assert.deepEqual(at(6, 6), [255, 0, 0, 128]);
      assert.deepEqual(at(0, 0), [43, 138, 62, 255]);
    });
  },
);
