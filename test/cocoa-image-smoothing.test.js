// `imageSmoothingEnabled` and `imageSmoothingQuality` on the native
// context, over @windowkit/appkit's `ctxSetImageSmoothing`.
//
// Two layers, as elsewhere in the Cocoa tests. The first runs everywhere: a
// fake bridge records what reaches the natives, which is the whole of what
// the JS decides — including what it decides when the bridge is an older
// @windowkit/appkit without the verb, since that is what feature detection
// is for. The second runs where the bridge loads and has the verb, and ends
// in pixels.
import assert from 'node:assert';
import { describe, test } from 'node:test';

import { BackendContext2D } from '../src/backend/context2d.js';
import { loadNative } from '../src/cocoa/native.js';

/** A bridge shaped like @windowkit/appkit's surface natives, with the
 *  verb or without it, recording each call to it. */
function fakeNative({ verb = true } = {}) {
  const calls = [];
  let seq = 0;
  const native = {
    calls,
    of: (name) => calls.filter((c) => c[0] === name).map((c) => c.slice(1)),
    createSurface(width, height, scale) {
      return { id: ++seq, width, height, scale };
    },
    surfaceSize: (handle) => ({ width: handle.width, height: handle.height }),
    ctxSave() {
      calls.push(['ctxSave']);
    },
    ctxRestore() {
      calls.push(['ctxRestore']);
    },
  };
  if (verb) {
    native.ctxSetImageSmoothing = (handle, quality) =>
      calls.push(['ctxSetImageSmoothing', handle.id, quality]);
  }
  // everything else the context syncs is a no-op; the verb this is about is
  // exactly what the context feature-detects, so a bridge without it has to
  // answer undefined rather than a no-op function
  return new Proxy(native, {
    get: (target, key) =>
      key === 'ctxSetImageSmoothing' && !verb
        ? undefined
        : key in target
          ? target[key]
          : () => undefined,
  });
}

/** A context over a destination that a test can replace, as a resize does. */
function context(options) {
  const native = fakeNative(options);
  let dst = native.createSurface(200, 100, 1);
  let gen = 1;
  const ctx = new BackendContext2D(
    native,
    () => dst,
    () => gen,
  );
  native.calls.length = 0;
  return {
    ctx,
    native,
    replace() {
      dst = native.createSurface(200, 100, 1);
      gen += 1;
      return dst;
    },
  };
}

const told = (native) =>
  native.of('ctxSetImageSmoothing').map(([, quality]) => quality);

test("a context starts smoothing at 'medium', and tells the bridge nothing", () => {
  const { ctx, native } = context();
  assert.equal(ctx.imageSmoothingEnabled, true);
  assert.equal(ctx.imageSmoothingQuality, 'medium');
  assert.deepEqual(told(native), []);
});

test('a quality goes to the bridge, and smoothing off is the nearest pixel at any quality', () => {
  const { ctx, native } = context();
  ctx.imageSmoothingQuality = 'low';
  ctx.imageSmoothingEnabled = false;
  assert.equal(ctx.imageSmoothingQuality, 'low', 'the quality is kept');
  ctx.imageSmoothingQuality = 'high';
  ctx.imageSmoothingEnabled = true;
  assert.deepEqual(told(native), ['low', 'none', 'none', 'high']);
  // canvas ignores a quality it has no name for
  ctx.imageSmoothingQuality = 'best';
  assert.equal(ctx.imageSmoothingQuality, 'high');
  assert.equal(told(native).length, 4);
});

test('save and restore keep both, as the bridge keeps its own', () => {
  const { ctx, native } = context();
  ctx.imageSmoothingQuality = 'low';
  ctx.save();
  ctx.imageSmoothingQuality = 'high';
  ctx.imageSmoothingEnabled = false;
  ctx.restore();
  assert.equal(ctx.imageSmoothingQuality, 'low');
  assert.equal(ctx.imageSmoothingEnabled, true);
  assert.deepEqual(
    native.calls.map(([name, , quality]) =>
      name === 'ctxSetImageSmoothing' ? quality : name,
    ),
    ['low', 'ctxSave', 'high', 'none', 'ctxRestore'],
  );
});

test("a surface made again is told what the context holds, where that is not 'medium'", () => {
  const { ctx, native, replace } = context();
  ctx.imageSmoothingQuality = 'low';
  native.calls.length = 0;
  const next = replace();
  ctx.save(); // anything that reaches the surface
  assert.deepEqual(native.of('ctxSetImageSmoothing'), [[next.id, 'low']]);
  // and nothing where it is
  const fresh = context();
  fresh.replace();
  fresh.ctx.save();
  assert.deepEqual(told(fresh.native), []);
});

test('a bridge without the verb keeps both where they start, so an assignment read back says it did not take', () => {
  const { ctx, native } = context({ verb: false });
  ctx.imageSmoothingQuality = 'low';
  ctx.imageSmoothingEnabled = false;
  assert.equal(ctx.imageSmoothingQuality, 'medium');
  assert.equal(ctx.imageSmoothingEnabled, true);
  assert.deepEqual(native.calls, []);
});

// --- and in pixels ------------------------------------------------------------

let bridge = null;
try {
  bridge = loadNative();
} catch {
  bridge = null;
}
const hasVerb = bridge && typeof bridge.ctxSetImageSmoothing === 'function';

describe(
  'against the real bridge',
  {
    skip: hasVerb
      ? false
      : bridge
        ? 'this @windowkit/appkit is older than 0.23.0'
        : 'the @windowkit/appkit bridge is not loadable here',
  },
  () => {
    /** A 2x2 check drawn eight times its size through the context, as it
     *  is set up by `how`: how many pixels are neither black nor white. */
    const between = (how) => {
      const src = bridge.createSurface(2, 2, 1);
      bridge.ctxSetFillColor(src, 1, 1, 1, 1);
      bridge.ctxFillRect(src, 0, 0, 2, 2);
      bridge.ctxSetFillColor(src, 0, 0, 0, 1);
      bridge.ctxFillRect(src, 0, 0, 1, 1);
      bridge.ctxFillRect(src, 1, 1, 1, 1);
      const dst = bridge.createSurface(16, 16, 1);
      const ctx = new BackendContext2D(
        bridge,
        () => dst,
        () => 1,
      );
      how(ctx);
      ctx.drawImage({ _surfaceHandle: src }, 0, 0, 2, 2, 0, 0, 16, 16);
      const pixels = Buffer.from(bridge.ctxGetImageData(dst, 0, 0, 16, 16));
      bridge.releaseSurface(dst);
      bridge.releaseSurface(src);
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] !== 0 && pixels[i] !== 255) count++;
      }
      return count;
    };

    test('smoothing off draws the source as its pixels, and on the colours between them', () => {
      assert.equal(
        between((ctx) => {
          ctx.imageSmoothingEnabled = false;
        }),
        0,
      );
      assert.ok(between(() => {}) > 0, "'medium'");
      assert.ok(
        between((ctx) => {
          ctx.imageSmoothingQuality = 'low';
        }) > 0,
        "'low'",
      );
    });

    test('a restore puts smoothing back on the bridge as well as here', () => {
      assert.ok(
        between((ctx) => {
          ctx.save();
          ctx.imageSmoothingEnabled = false;
          ctx.restore();
        }) > 0,
      );
    });
  },
);
