// The offscreen `Surface` on the Cocoa backend (issue #433): ntk's contract
// over a CG bitmap, reached through `react-x11/ntk`'s `Surface`, which asks
// the app it is handed. Two layers, the shape of cocoa-glyph-runs.test.js:
// the JS over a fake bridge everywhere — what reaches the natives is the
// whole of what the glue decides — and, where the real bridge loads,
// pixels: a fill lands, a band moves in place, a composite arrives.
import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import React from 'react';
import * as ntk from 'ntk';

import { CocoaApp } from '../src/cocoa/app.js';
import { CocoaContext2D } from '../src/cocoa/context2d.js';
import { loadNative } from '../src/cocoa/native.js';
import { CocoaSurface } from '../src/cocoa/surface.js';
import { Surface } from '../src/ntk.js';
import { cleanup, renderX11 } from '../src/testing/index.js';

const h = React.createElement;

afterEach(cleanup);

// --- the fake bridge ----------------------------------------------------------

/**
 * A bridge shaped like @windowkit/appkit's surface natives: handles are
 * plain objects carrying their size, every verb that matters records what
 * it was given, and everything else the context syncs is a no-op.
 */
function fakeNative({ scrolls = true } = {}) {
  const calls = [];
  let seq = 0;
  const native = {
    calls,
    of: (name) => calls.filter((c) => c[0] === name),
    createSurface(width, height, scale) {
      const handle = { id: ++seq, width, height, scale };
      calls.push(['createSurface', width, height, scale]);
      return handle;
    },
    surfaceSize(handle) {
      return {
        width: handle.width,
        height: handle.height,
        scale: handle.scale,
      };
    },
    scrollSurface(handle, x, y, w, hh, dx, dy) {
      calls.push(['scrollSurface', handle.id, x, y, w, hh, dx, dy]);
      return scrolls;
    },
    ctxDrawSurface(dst, src, ...rest) {
      calls.push(['ctxDrawSurface', dst.id, src.id, ...rest]);
    },
    ctxClearRect(handle, ...rect) {
      calls.push(['ctxClearRect', handle.id, ...rect]);
    },
    ctxFillRect(handle, ...rect) {
      calls.push(['ctxFillRect', handle.id, ...rect]);
    },
    ctxSave(handle) {
      calls.push(['ctxSave', handle.id]);
    },
    ctxRestore(handle) {
      calls.push(['ctxRestore', handle.id]);
    },
    ctxTranslate(handle, x, y) {
      calls.push(['ctxTranslate', handle.id, x, y]);
    },
    ctxTransform(handle, ...m) {
      calls.push(['ctxTransform', handle.id, ...m]);
    },
    listScreens() {
      return [
        {
          x: 0,
          y: 0,
          width: 1440,
          height: 900,
          scale: 2,
          visible: { x: 0, y: 0, width: 1440, height: 875 },
        },
      ];
    },
  };
  return new Proxy(native, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

/** The three things a surface reads off its app. */
const appOver = (native, scale = 2) => ({
  _native: native,
  fonts: { engine: 'fake' },
  scale,
});

// --- the surface --------------------------------------------------------------

test('validates like ntk: positive integer sizes, and the formats this backend has', () => {
  const app = appOver(fakeNative());
  for (const bad of [
    {},
    { width: 0, height: 4 },
    { width: 4, height: -1 },
    { width: 2.5, height: 4 },
    { width: '8', height: 8 },
  ]) {
    assert.throws(
      () => new CocoaSurface(app, bad),
      /width and height must be positive integers/,
    );
  }
  assert.throws(
    () => new CocoaSurface(app, { width: 4, height: 4, format: 'a8' }),
    /'a8'.*not on the cocoa backend yet.*argb32/,
  );
  assert.throws(
    () => new CocoaSurface(app, { width: 4, height: 4, format: 'rgb24' }),
    /unknown format "rgb24" \(argb32 or a8\)/,
  );
  assert.equal(app._native.of('createSurface').length, 0, 'nothing allocated');
});

test('allocates a device-pixel bitmap carrying the app scale, and starts transparent', () => {
  const native = fakeNative();
  const app = appOver(native, 2);
  const surface = new CocoaSurface(app, { width: 64, height: 32 });
  assert.deepEqual(native.of('createSurface'), [['createSurface', 64, 32, 2]]);
  assert.equal(surface.app, app);
  assert.equal(surface.width, 64);
  assert.equal(surface.height, 32);
  assert.equal(surface.format, 'argb32');
  assert.equal(surface.depth, 32);
  assert.equal(surface.bytes, 64 * 32 * 4);
  assert.equal(surface._surfaceHandle.id, 1, "drawImage's handle");
  // the clear reached the bitmap, from a saved identity state
  const names = native.calls.map((c) => c[0]);
  const save = names.indexOf('ctxSave');
  const clear = names.indexOf('ctxClearRect');
  const restore = names.indexOf('ctxRestore');
  assert.ok(save >= 0 && save < clear && clear < restore, names.join(','));
  assert.deepEqual(native.of('ctxClearRect'), [
    ['ctxClearRect', 1, 0, 0, 64, 32],
  ]);
  // a scale the app does not know defaults to 1
  new CocoaSurface({ _native: native }, { width: 2, height: 2 });
  assert.deepEqual(native.of('createSurface')[1], ['createSurface', 2, 2, 1]);
});

test("getContext answers one context over the bitmap's one graphics state, with the app's fonts", () => {
  const app = appOver(fakeNative());
  const surface = new CocoaSurface(app, { width: 8, height: 8 });
  const ctx = surface.getContext('2d');
  assert.ok(ctx instanceof CocoaContext2D);
  assert.strictEqual(ctx._fonts, app.fonts);
  assert.strictEqual(surface.getContext('2d'), ctx, 'the same one every time');
  assert.strictEqual(surface.getContext(), ctx, "'2d' is the default");
  ctx.destroy(); // ntk's contract, honoured as a no-op
  assert.strictEqual(surface.getContext('2d'), ctx);
  assert.throws(
    () => surface.getContext('webgl'),
    /getContext\("webgl"\).*'2d' context and nothing else/,
  );
});

test('render brackets the callback: it starts from the identity and leaves no residue', () => {
  const native = fakeNative();
  const surface = new CocoaSurface(appOver(native), { width: 8, height: 8 });
  const ctx = surface.getContext('2d');
  // a held context with a translate in force, as a retained painter has
  ctx.translate(5, 5);
  ctx.fillStyle = '#123456';
  let seen = null;
  const back = surface.render((c) => {
    assert.strictEqual(c, ctx, 'the one context');
    seen = c.getTransform();
    c.translate(10, 20);
    c.fillStyle = '#f00';
    c.fillRect(0, 0, 1, 1);
  });
  assert.strictEqual(back, surface);
  assert.deepEqual(seen, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  assert.deepEqual(ctx.getTransform(), { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 });
  assert.equal(ctx.fillStyle, '#123456');
  // and the fill went out with the callback's colour
  assert.deepEqual(native.of('ctxFillRect').at(-1), [
    'ctxFillRect',
    1,
    0,
    0,
    1,
    1,
  ]);
});

test('clear reaches every pixel whatever transform the live context holds', () => {
  const native = fakeNative();
  const surface = new CocoaSurface(appOver(native), { width: 8, height: 8 });
  const ctx = surface.getContext('2d');
  ctx.translate(100, 100);
  const before = native.calls.length;
  assert.strictEqual(surface.clear(), surface);
  const since = native.calls.slice(before);
  // the identity is restored for the clear — a transform undoing the
  // translate goes out before it — and the caller's translate survives
  const transform = since.find((c) => c[0] === 'ctxTransform');
  assert.deepEqual(transform, ['ctxTransform', 1, 1, 0, 0, 1, -100, -100]);
  assert.deepEqual(
    since.find((c) => c[0] === 'ctxClearRect'),
    ['ctxClearRect', 1, 0, 0, 8, 8],
  );
  assert.deepEqual(ctx.getTransform(), {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: 100,
    f: 100,
  });
});

test("copyWithin: ntk#252's refusals in JS, then one scrollSurface of the clamped band", () => {
  const native = fakeNative();
  const surface = new CocoaSurface(appOver(native), { width: 64, height: 32 });
  const all = { x: 0, y: 0, width: 64, height: 32 };
  assert.equal(surface.copyWithin(all, 0, -0.5), false, 'a fractional shift');
  assert.equal(surface.copyWithin(all, 0, 0), false, 'no shift');
  assert.equal(surface.copyWithin(all, 0, -40), false, 'nothing survives');
  assert.equal(
    surface.copyWithin(all, 64, 0),
    false,
    'nothing survives across',
  );
  assert.equal(
    surface.copyWithin({ x: 0, y: 0, width: 0, height: 32 }, 0, -1),
    false,
  );
  assert.equal(surface.copyWithin({}, 0, -1), false, 'a rect with no numbers');
  assert.equal(
    native.of('scrollSurface').length,
    0,
    'every refusal is a refusal here',
  );
  // a band reaching outside the surface, with fractional edges: floored
  // and ceiled like ntk, clamped to the bitmap, and handed over whole —
  // the native does the same intersection and moves rect ∩ (rect + delta)
  assert.equal(
    surface.copyWithin({ x: -5, y: 10.5, width: 100, height: 20.2 }, 0, -8),
    true,
  );
  assert.deepEqual(native.of('scrollSurface'), [
    ['scrollSurface', 1, 0, 10, 64, 21, 0, -8],
  ]);
  assert.equal(surface.copyWithin(all, 3, 0), true, 'a horizontal shift');
  assert.deepEqual(native.of('scrollSurface')[1], [
    'scrollSurface',
    1,
    0,
    0,
    64,
    32,
    3,
    0,
  ]);
  // the native's answer is the answer
  const refusing = new CocoaSurface(appOver(fakeNative({ scrolls: false })), {
    width: 8,
    height: 8,
  });
  assert.equal(
    refusing.copyWithin({ x: 0, y: 0, width: 8, height: 8 }, 0, -1),
    false,
  );
});

test('drawImage composites one surface into another through ctxDrawSurface, in every arity', () => {
  const native = fakeNative();
  const app = appOver(native);
  const source = new CocoaSurface(app, { width: 16, height: 8 });
  const target = new CocoaSurface(app, { width: 64, height: 32 });
  const ctx = target.getContext('2d');
  ctx.drawImage(source, 3, 4);
  ctx.drawImage(source, 3, 4, 32, 16);
  ctx.drawImage(source, 2, 1, 8, 4, 10, 20, 16, 8);
  assert.deepEqual(native.of('ctxDrawSurface'), [
    ['ctxDrawSurface', 2, 1, 0, 0, 16, 8, 3, 4, 16, 8],
    ['ctxDrawSurface', 2, 1, 0, 0, 16, 8, 3, 4, 32, 16],
    ['ctxDrawSurface', 2, 1, 2, 1, 8, 4, 10, 20, 16, 8],
  ]);
  // a destroyed source is nothing to draw, like any source this backend
  // has no pixels for
  source.destroy();
  ctx.drawImage(source, 0, 0);
  assert.equal(native.of('ctxDrawSurface').length, 3);
});

test('destroy releases the bitmap through the bridge when it can, and once', () => {
  const native = fakeNative();
  const released = [];
  native.releaseSurface = (handle) => released.push(handle.id);
  const surface = new CocoaSurface(appOver(native), { width: 4, height: 4 });
  const id = surface._surfaceHandle.id;
  surface.destroy();
  surface.destroy();
  assert.deepEqual(released, [id], 'freed on the call, not on collection');
  // a bridge without the verb: the finalizer owns it, and destroy is a drop
  const older = fakeNative();
  const other = new CocoaSurface(appOver(older), { width: 4, height: 4 });
  assert.doesNotThrow(() => other.destroy());
  assert.equal(other._surfaceHandle, null);
});

test('destroy drops the handle, refuses further drawing with a reason, and is idempotent', () => {
  const native = fakeNative();
  const surface = new CocoaSurface(appOver(native), { width: 8, height: 8 });
  const ctx = surface.getContext('2d');
  surface.destroy();
  assert.equal(surface._surfaceHandle, null);
  assert.throws(
    () => ctx.fillRect(0, 0, 1, 1),
    /Surface: destroyed.*allocate a new Surface/,
  );
  assert.throws(() => surface.getContext('2d'), /Surface: destroyed/);
  assert.throws(() => surface.render(() => {}), /Surface: destroyed/);
  const before = native.calls.length;
  assert.strictEqual(
    surface.clear(),
    surface,
    'clear on a dead surface is nothing',
  );
  assert.equal(
    surface.copyWithin({ x: 0, y: 0, width: 8, height: 8 }, 0, -1),
    false,
  );
  assert.equal(native.calls.length, before);
  surface.destroy();
  const disposable = new CocoaSurface(appOver(native), { width: 8, height: 8 });
  disposable[Symbol.dispose]();
  assert.equal(disposable._surfaceHandle, null);
});

test('picture() says where the composite is instead', () => {
  const surface = new CocoaSurface(appOver(fakeNative()), {
    width: 8,
    height: 8,
  });
  assert.throws(
    () => surface.picture(surface.app),
    /no XRender Picture.*ctx\.drawImage\(surface/,
  );
});

// --- the context's part -------------------------------------------------------

test('a restore with nothing saved does nothing, as on canvas', () => {
  const native = fakeNative();
  const handle = native.createSurface(4, 4, 1);
  const ctx = new CocoaContext2D(
    native,
    () => handle,
    () => 1,
  );
  ctx.restore();
  assert.equal(native.of('ctxRestore').length, 0);
  ctx.save();
  ctx.fillStyle = '#f00';
  ctx.restore();
  ctx.restore();
  assert.equal(native.of('ctxRestore').length, 1);
  assert.equal(ctx.fillStyle, '#000');
  assert.equal(typeof ctx.destroy, 'function');
  ctx.destroy();
});

// --- the dispatch -------------------------------------------------------------

test("react-x11/ntk's Surface asks the app first: a Cocoa app answers its own", () => {
  const app = new CocoaApp(fakeNative());
  const surface = new Surface(app, { width: 32, height: 16 });
  assert.ok(surface instanceof CocoaSurface);
  assert.strictEqual(surface.app, app);
  assert.equal(surface.width, 32);
  assert.strictEqual(surface.getContext('2d')._fonts, app.fonts);
  assert.deepEqual(app._native.of('createSurface'), [
    ['createSurface', 32, 16, 2],
  ]);
  // any app with the seam is asked, and its answer is the answer
  const asked = [];
  const marker = { width: 1, height: 1 };
  const other = { createSurface: (options) => (asked.push(options), marker) };
  assert.strictEqual(new Surface(other, { width: 1, height: 1 }), marker);
  assert.deepEqual(asked, [{ width: 1, height: 1 }]);
});

test("react-x11/ntk's Surface falls through to ntk's pixmap on an X connection", async () => {
  const { app } = await renderX11(h('box', null));
  assert.equal(typeof app.createSurface, 'undefined', 'ntk has no such seam');
  const surface = new Surface(app, { width: 8, height: 8 });
  assert.ok(surface instanceof ntk.Surface);
  assert.equal(surface.width, 8);
  assert.equal(typeof surface.picture(app).id, 'number');
  surface.destroy();
});

// --- over the real bridge -----------------------------------------------------

let bridge = null;
if (process.platform === 'darwin') {
  try {
    bridge = loadNative();
  } catch {
    bridge = null;
  }
}

describe(
  'over the real bridge',
  {
    skip: bridge ? false : 'the @windowkit/appkit bridge is not loadable here',
  },
  () => {
    const app = () => ({ _native: bridge, fonts: null, scale: 1 });
    const pixel = (surface, x, y) => [
      ...bridge.ctxGetImageData(surface._surfaceHandle, x, y, 1, 1),
    ];
    const rows = (surface) => {
      const out = [];
      for (let y = 0; y < surface.height; y++)
        out.push(pixel(surface, 0, y)[0]);
      return out;
    };
    /** Row y painted red at level 32·y, so every row is its own colour. */
    const paintRows = (surface) => {
      const ctx = surface.getContext('2d');
      for (let y = 0; y < surface.height; y++) {
        ctx.fillStyle = `rgb(${32 * y}, 0, 0)`;
        ctx.fillRect(0, y, surface.width, 1);
      }
      return ctx;
    };

    test('a fresh surface is transparent, a fill lands, and clear reaches under a live translate', () => {
      const surface = new CocoaSurface(app(), { width: 16, height: 16 });
      assert.deepEqual(pixel(surface, 8, 8), [0, 0, 0, 0]);
      const ctx = surface.getContext('2d');
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 16, 16);
      assert.deepEqual(pixel(surface, 8, 8), [255, 0, 0, 255]);
      ctx.translate(100, 100); // and never restored
      surface.clear();
      assert.deepEqual(pixel(surface, 8, 8), [0, 0, 0, 0]);
      assert.deepEqual(pixel(surface, 0, 15), [0, 0, 0, 0]);
      assert.equal(ctx.getTransform().e, 100, "the caller's state is its own");
      surface.destroy();
    });

    test('copyWithin moves the band in place, overlap included, and leaves the exposed strip alone', () => {
      const surface = new CocoaSurface(app(), { width: 8, height: 8 });
      paintRows(surface);
      assert.deepEqual(rows(surface), [0, 32, 64, 96, 128, 160, 192, 224]);
      const all = { x: 0, y: 0, width: 8, height: 8 };
      // up by three: rows 0..4 take rows 3..7; rows 5..7 are the caller's
      assert.equal(surface.copyWithin(all, 0, -3), true);
      assert.deepEqual(rows(surface), [96, 128, 160, 192, 224, 160, 192, 224]);
      // down by one over the overlap: rows walk bottom-up, so nothing is
      // read after it was overwritten
      assert.equal(surface.copyWithin(all, 0, 1), true);
      assert.deepEqual(rows(surface), [96, 96, 128, 160, 192, 224, 160, 192]);
      // a band, sideways: only its pixels move
      paintRows(surface);
      const ctx = surface.getContext('2d');
      ctx.fillStyle = '#00ff00';
      ctx.fillRect(0, 2, 2, 1); // a green pair at the left of row 2
      assert.equal(
        surface.copyWithin({ x: 0, y: 2, width: 8, height: 1 }, 3, 0),
        true,
      );
      assert.deepEqual(pixel(surface, 3, 2), [0, 255, 0, 255]);
      assert.deepEqual(pixel(surface, 4, 2), [0, 255, 0, 255]);
      assert.deepEqual(
        pixel(surface, 5, 2),
        [64, 0, 0, 255],
        'row 2 red past the pair',
      );
      assert.deepEqual(
        pixel(surface, 0, 2),
        [0, 255, 0, 255],
        'the source column is not cleared',
      );
      assert.deepEqual(
        pixel(surface, 3, 1),
        [32, 0, 0, 255],
        'the row above is untouched',
      );
      assert.equal(surface.copyWithin(all, 0, -8), false, 'nothing survives');
      surface.destroy();
    });

    test('drawImage composites a surface into another, whole and cropped', () => {
      const source = new CocoaSurface(app(), { width: 4, height: 4 });
      source.render((c) => {
        c.fillStyle = '#ff0000';
        c.fillRect(0, 0, 2, 4);
        c.fillStyle = '#00ff00';
        c.fillRect(2, 0, 2, 4);
      });
      const target = new CocoaSurface(app(), { width: 16, height: 16 });
      const ctx = target.getContext('2d');
      ctx.drawImage(source, 6, 6);
      assert.deepEqual(pixel(target, 6, 6), [255, 0, 0, 255]);
      assert.deepEqual(pixel(target, 9, 9), [0, 255, 0, 255]);
      assert.deepEqual(pixel(target, 5, 5), [0, 0, 0, 0]);
      assert.deepEqual(pixel(target, 10, 10), [0, 0, 0, 0]);
      // the right half only, scaled up to fill a 4x4 block at the origin
      ctx.drawImage(source, 2, 0, 2, 4, 0, 0, 4, 4);
      assert.deepEqual(pixel(target, 0, 0), [0, 255, 0, 255]);
      assert.deepEqual(pixel(target, 3, 3), [0, 255, 0, 255]);
      assert.deepEqual(pixel(target, 4, 4), [0, 0, 0, 0]);
      source.destroy();
      target.destroy();
    });

    test("the retained renderer's life: draw rows, scroll, composite the grid into the window", () => {
      // the terminal's shape (@react-x11/components, RetainedRenderer):
      // one context for the surface's life, rows drawn into it, a scroll as
      // one copyWithin plus the exposed strip, the whole grid one drawImage
      const grid = new CocoaSurface(app(), { width: 8, height: 8 });
      const ctx = paintRows(grid);
      assert.equal(
        grid.copyWithin({ x: 0, y: 0, width: 8, height: 8 }, 0, -1),
        true,
      );
      ctx.fillStyle = '#0000ff';
      ctx.fillRect(0, 7, 8, 1); // the exposed row
      const window = new CocoaSurface(app(), { width: 24, height: 24 });
      window.getContext('2d').drawImage(grid, 0, 0, 8, 8, 4, 4, 8, 8);
      assert.deepEqual(
        pixel(window, 4, 4),
        [32, 0, 0, 255],
        'row 1 is now row 0',
      );
      assert.deepEqual(pixel(window, 4, 11), [0, 0, 255, 255], 'the new row');
      assert.deepEqual(pixel(window, 3, 3), [0, 0, 0, 0]);
      ctx.destroy();
      grid.destroy();
      window.destroy();
    });
  },
);
