// `filter` on the native context: the colour functions of a CSS filter
// list, applied to the colours fills, strokes, gradients and glyph runs are
// drawn in, and to the pixels of images, surfaces and text layouts that
// carry colours of their own (src/backend/filter.js).
//
// Two layers, as elsewhere in the Cocoa tests. The first runs everywhere: a
// fake bridge records what reaches the natives, which is the whole of what
// the JS decides — including what it decides when the bridge cannot read a
// surface back, since that is what feature detection is for. The second
// runs where the bridge loads, and ends in pixels.
import assert from 'node:assert';
import { describe, test } from 'node:test';

import { BackendContext2D } from '../src/backend/context2d.js';
import {
  filterColour,
  filterPixels,
  parseCanvasFilter,
} from '../src/backend/filter.js';
import { CocoaFontManager } from '../src/cocoa/fonts.js';
import { loadNative } from '../src/cocoa/native.js';

/** A bridge shaped like @windowkit/appkit's surface natives, recording
 *  each call. `pixels` is what a read of any surface answers, straight
 *  RGBA, a pixel repeated. */
function fakeNative({ reads = true, pixel = [255, 0, 0, 255] } = {}) {
  const calls = [];
  let seq = 0;
  const native = {
    calls,
    of: (name) => calls.filter((c) => c[0] === name).map((c) => c.slice(1)),
    createSurface(width, height, scale) {
      calls.push(['createSurface', width, height]);
      return { id: ++seq, width, height, scale };
    },
    releaseSurface(handle) {
      calls.push(['releaseSurface', handle.id]);
    },
    surfaceSize: (handle) => ({ width: handle.width, height: handle.height }),
    ctxSetFillColor(handle, r, g, b, a) {
      calls.push(['ctxSetFillColor', handle.id, r, g, b, a]);
    },
    ctxSetStrokeColor(handle, r, g, b, a) {
      calls.push(['ctxSetStrokeColor', handle.id, r, g, b, a]);
    },
    ctxFillLinearGradient(handle, x0, y0, x1, y1, stops) {
      calls.push(['ctxFillLinearGradient', handle.id, stops]);
    },
    ctxDrawSurface(dst, src, ...rest) {
      calls.push(['ctxDrawSurface', dst.id, src.id, ...rest]);
    },
    ctxTransform(handle, ...m) {
      calls.push(['ctxTransform', handle.id, ...m]);
    },
    drawLayout(handle, layout, x, y) {
      calls.push(['drawLayout', handle.id, layout, x, y]);
    },
    ctxPutImageData(handle, data, width, height, x, y) {
      calls.push([
        'ctxPutImageData',
        handle.id,
        [...data.subarray(0, 4)],
        width,
        height,
        x,
        y,
      ]);
    },
  };
  if (reads) {
    native.ctxGetImageData = (handle, x, y, w, h) => {
      calls.push(['ctxGetImageData', handle.id, x, y, w, h]);
      const out = Buffer.alloc(w * h * 4);
      for (let i = 0; i < out.length; i += 4) out.set(pixel, i);
      return out;
    };
  }
  return new Proxy(native, {
    get: (target, key) =>
      key === 'ctxGetImageData' && !reads
        ? undefined
        : key in target
          ? target[key]
          : () => undefined,
    has: (target, key) => (key === 'ctxGetImageData' ? reads : key in target),
  });
}

function context(options) {
  const native = fakeNative(options);
  const dst = native.createSurface(200, 100, 1);
  const ctx = new BackendContext2D(
    native,
    () => dst,
    () => 1,
  );
  native.calls.length = 0;
  return { ctx, native, dst };
}

const near = (a, b, by = 1e-9) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= by);

test('the colour functions come to the matrices Filter Effects 1 gives them', () => {
  const red = [1, 0, 0, 1];
  const of = (text, rgba = red) => filterColour(rgba, parseCanvasFilter(text));
  assert.ok(near(of('grayscale(1)'), [0.2126, 0.2126, 0.2126, 1]));
  assert.ok(near(of('grayscale()'), [0.2126, 0.2126, 0.2126, 1]), 'all of it');
  assert.ok(near(of('grayscale(300%)'), [0.2126, 0.2126, 0.2126, 1]));
  assert.ok(near(of('invert(1)'), [0, 1, 1, 1]));
  assert.ok(near(of('sepia(1)', [1, 1, 1, 1]), [1, 1, 0.937, 1]), 'clamped');
  assert.ok(near(of('brightness(.5) opacity(50%)'), [0.5, 0, 0, 0.5]));
  assert.ok(near(of('contrast(0)', [0.1, 0.8, 0.3, 1]), [0.5, 0.5, 0.5, 1]));
  assert.ok(near(of('hue-rotate(1turn)'), red, 1e-9), 'a turn is none');
  assert.ok(
    near(of('brightness(2) invert(1)', [0.8, 0.8, 0.8, 1]), [0, 0, 0, 1]),
    'each function clamped before the next',
  );
  const pixels = Uint8Array.of(255, 0, 0, 255, 9, 9, 9, 0);
  filterPixels(pixels, pixels, parseCanvasFilter('grayscale(1) opacity(.5)'));
  assert.deepEqual([...pixels], [54, 54, 54, 128, 0, 0, 0, 0]);
});

test('a filter of colour functions sticks and reads back as written, and anything else does not', () => {
  const { ctx } = context();
  assert.equal(ctx.filter, 'none');
  ctx.filter = ' grayscale(50%) hue-rotate(90deg) ';
  assert.equal(ctx.filter, 'grayscale(50%) hue-rotate(90deg)');
  for (const no of [
    'blur(2em)',
    'blur(-1px)',
    'grayscale(1) drop-shadow(1px 1px red)',
    'url(#f)',
    'grayscale(-1)',
    'grayscale(1',
    'nonsense',
    '',
  ]) {
    ctx.filter = no;
    assert.equal(ctx.filter, 'grayscale(50%) hue-rotate(90deg)', no);
  }
  ctx.save();
  ctx.filter = 'invert(1)';
  assert.equal(ctx.filter, 'invert(1)');
  ctx.restore();
  assert.equal(ctx.filter, 'grayscale(50%) hue-rotate(90deg)', 'restored');
  ctx.filter = 'NONE';
  assert.equal(ctx.filter, 'none');
});

test('a bridge that cannot read a surface back keeps the filter at none', () => {
  const { ctx } = context({ reads: false });
  ctx.filter = 'grayscale(1)';
  assert.equal(ctx.filter, 'none');
});

test('a fill, a stroke, a gradient and a glyph run are drawn in the colours the filter makes of theirs', () => {
  const { ctx, native, dst } = context();
  ctx.filter = 'invert(1)';
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 10, 10);
  ctx.strokeStyle = 'rgba(0, 0, 255, 0.5)';
  ctx.strokeRect(0, 0, 10, 10);
  const gradient = ctx.createLinearGradient(0, 0, 10, 0);
  gradient.addColorStop(0, '#000000');
  gradient.addColorStop(1, '#ffffff');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 10, 10);
  assert.deepEqual(native.of('ctxSetFillColor')[0], [dst.id, 0, 1, 1, 1]);
  assert.deepEqual(native.of('ctxSetStrokeColor')[0], [dst.id, 1, 1, 0, 0.5]);
  const [[, stops]] = native.of('ctxFillLinearGradient');
  assert.deepEqual(stops, [0, 1, 1, 1, 1, 1, 0, 0, 0, 1], 'stops inverted');
  ctx._fonts = { _runHandle: () => 'F' };
  ctx.drawGlyphs(null, ctx.createSolidPicture(0, 0.5, 0, 0.5), [
    { run: { font: {}, size: 10, glyphs: [{ id: 1, ax: 5 }] }, x: 0, y: 0 },
  ]);
  assert.deepEqual(
    native.of('ctxSetFillColor').at(-1),
    [dst.id, 1, 0, 1, 0.5],
    'a glyph run in green at half is in magenta at half',
  );
  ctx.filter = 'none';
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 10, 10);
  assert.deepEqual(native.of('ctxSetFillColor').at(-1), [dst.id, 1, 0, 0, 1]);
});

test('an image is read, run through the filter and drawn from a bitmap of its own, which is freed', () => {
  const { ctx, native, dst } = context({ pixel: [255, 0, 0, 255] });
  const src = native.createSurface(40, 30, 1);
  native.calls.length = 0;
  ctx.filter = 'grayscale(1)';
  // a source rect a fraction into the source, into a rect twice its size
  ctx.drawImage({ _surfaceHandle: src }, 4.5, 2, 10, 10, 50, 60, 20, 20);
  assert.deepEqual(native.of('ctxGetImageData'), [[src.id, 4, 2, 11, 10]]);
  const [[filtered, first, w, h]] = native.of('ctxPutImageData');
  assert.deepEqual([first, w, h], [[54, 54, 54, 255], 11, 10]);
  assert.deepEqual(native.of('ctxDrawSurface'), [
    [dst.id, filtered, 0.5, 0, 10, 10, 50, 60, 20, 20],
  ]);
  assert.deepEqual(native.of('releaseSurface'), [[filtered]]);
  assert.equal(ctx.filter, 'grayscale(1)', 'set aside for the draw only');
});

test('a layout with colours of its own is drawn on a bitmap of its own through the transform, filtered, and drawn where it lands', () => {
  const { ctx, native, dst } = context({ pixel: [0, 0, 255, 255] });
  ctx.translate(10.5, 20);
  ctx.filter = 'invert(1)';
  const layout = { _handle: 'L', width: 30, height: 10, _contextInk: false };
  ctx._drawLayout(layout, 2, 3);
  // its box and half its height each way, -3..37 across and -2..18 down,
  // moved by the translation to 7.5..47.5 and 18..38, in whole pixels
  assert.deepEqual(native.of('createSurface'), [[41, 20]]);
  const [[own, ...m]] = native.of('ctxTransform');
  assert.deepEqual(m, [1, 0, 0, 1, 3.5, 2], 'the transform, from its corner');
  assert.deepEqual(native.of('drawLayout'), [[own, 'L', 2, 3]]);
  const [[, first]] = native.of('ctxPutImageData');
  assert.deepEqual(first, [255, 255, 0, 255], 'blue inverted');
  assert.deepEqual(native.of('ctxDrawSurface'), [
    [dst.id, own, 0, 0, 41, 20, 7, 18, 41, 20],
  ]);
  assert.deepEqual(native.of('releaseSurface'), [[own]]);
  assert.equal(ctx.filter, 'invert(1)');
});

let bridge = null;
try {
  bridge = loadNative();
} catch {
  bridge = null;
}

test('a blur() sticks, and an image drawn under it is read with what the blur reaches round it, scaled down to a few pixels a deviation, blurred, and drawn back up over where it goes and round it', () => {
  const { ctx, native, dst } = context();
  ctx.filter = 'blur(6px) blur(8px) saturate(2)';
  assert.equal(ctx.filter, 'blur(6px) blur(8px) saturate(2)');
  const src = native.createSurface(100, 60, 1);
  native.calls.length = 0;
  // two blurs are one of ten pixels, which reaches thirty; scaled down by
  // five, it is two pixels a deviation
  ctx.drawImage({ _surfaceHandle: src }, 20, 10);
  const [[smallW, smallH]] = native.of('createSurface');
  assert.deepEqual([smallW, smallH], [32, 24], '160 by 120, a fifth of it');
  const small = native.calls.find((c) => c[0] === 'createSurface');
  const [down, up] = native.of('ctxDrawSurface');
  assert.deepEqual(
    down.slice(1),
    [src.id, 0, 0, 100, 60, 6, 6, 20, 12],
    'the source scaled down, its margin left empty round it',
  );
  assert.equal(native.of('ctxGetImageData')[0][1], 0);
  assert.deepEqual(native.of('ctxGetImageData')[0].slice(1), [0, 0, 32, 24]);
  assert.deepEqual(
    up.slice(0, 1).concat(up.slice(2)),
    [dst.id, 0, 0, 32, 24, -10, -20, 160, 120],
    'drawn back up over the image and thirty pixels round it',
  );
  assert.ok(native.of('releaseSurface').length >= 1, 'and let go');
  assert.equal(small[1], 32);
  // a fill under it is drawn sharp, in the colours the rest makes
  native.calls.length = 0;
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 10, 10);
  assert.equal(native.of('createSurface').length, 0);
});

describe(
  'against the real bridge',
  {
    skip: bridge ? false : 'the @windowkit/appkit bridge is not loadable here',
  },
  () => {
    const surface = (w, h) => {
      const handle = bridge.createSurface(w, h, 1);
      const ctx = new BackendContext2D(
        bridge,
        () => handle,
        () => 1,
      );
      return { handle, ctx };
    };
    const pixelAt = (handle, x, y) => [
      ...bridge.ctxGetImageData(handle, x, y, 1, 1),
    ];
    const close = (a, b, by = 2) => a.every((v, i) => Math.abs(v - b[i]) <= by);

    test('a surface drawn under grayscale(1) is grey, and a fill under invert(1) is its inverse', () => {
      const red = surface(8, 8);
      red.ctx.fillStyle = '#ff0000';
      red.ctx.fillRect(0, 0, 8, 8);
      const dst = surface(20, 10);
      dst.ctx.filter = 'grayscale(1)';
      dst.ctx.drawImage({ _surfaceHandle: red.handle }, 0, 0);
      dst.ctx.filter = 'invert(1)';
      dst.ctx.fillStyle = '#ff0000';
      dst.ctx.fillRect(10, 0, 10, 10);
      assert.ok(close(pixelAt(dst.handle, 4, 4), [54, 54, 54, 255]));
      assert.ok(close(pixelAt(dst.handle, 15, 4), [0, 255, 255, 255]));
      bridge.releaseSurface(red.handle);
      bridge.releaseSurface(dst.handle);
    });

    test('a surface drawn under blur(4px) fades out across its edge, in its own colour', () => {
      const red = surface(20, 20);
      red.ctx.fillStyle = '#ff0000';
      red.ctx.fillRect(0, 0, 20, 20);
      const dst = surface(60, 60);
      dst.ctx.filter = 'blur(4px)';
      dst.ctx.drawImage({ _surfaceHandle: red.handle }, 20, 20);
      const alpha = (x) => pixelAt(dst.handle, x, 30)[3];
      assert.ok(alpha(30) > 230, `the middle is all but whole: ${alpha(30)}`);
      assert.ok(
        Math.abs(alpha(20) - 128) < 40,
        `half at the edge: ${alpha(20)}`,
      );
      assert.ok(alpha(14) > 0 && alpha(14) < alpha(20), 'less outside');
      assert.ok(alpha(4) < 8, `and next to nothing well past it: ${alpha(4)}`);
      const [r, g, b] = pixelAt(dst.handle, 16, 30);
      assert.ok(r > 200 && g < 30 && b < 30, `red, faded: ${[r, g, b]}`);
      bridge.releaseSurface(red.handle);
      bridge.releaseSurface(dst.handle);
    });

    test('a layout in a colour of its own is drawn through the filter', () => {
      const manager = new CocoaFontManager(bridge);
      const layout = manager.layout(
        [{ text: '████', size: 20, color: '#ff0000' }],
        { size: 20 },
        {},
      );
      const dst = surface(120, 40);
      dst.ctx._fonts = manager;
      dst.ctx.filter = 'grayscale(1)';
      dst.ctx._drawLayout(layout, 4, 4);
      // the reddest pixel drawn is no redder than it is green
      const pixels = bridge.ctxGetImageData(dst.handle, 0, 0, 120, 40);
      let inked = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 200) continue;
        inked += 1;
        assert.ok(
          Math.abs(pixels[i] - pixels[i + 1]) <= 2,
          `${[...pixels.subarray(i, i + 4)]}`,
        );
      }
      assert.ok(inked > 0, 'it drew');
      bridge.releaseSurface(dst.handle);
    });
  },
);
