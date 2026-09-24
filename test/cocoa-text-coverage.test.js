// A layout's coverage on the Cocoa text engine (#673): how much of each
// device pixel its glyphs cover, one byte a pixel, without drawing them — the
// bridge's `layoutCoverage`, which fills CoreText's outlines by the
// accumulation ntk rasterizes with (windowkit/appkit#73).
//
// Two layers, as in cocoa-text-features.test.js. A fake bridge, everywhere,
// for what this file's engine owns: the layout's own handle and the pad
// handed over, and an honest null from a bridge that predates the verb, so a
// caller keeps its readback. The real one, where it loads with the verb, for
// the contract end to end: the raster and its pad, the ink where
// `layout.draw` puts it, and no part for the span's colour.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BackendContext2D } from '../src/backend/context2d.js';
import { CocoaFontManager } from '../src/cocoa/fonts.js';
import { loadNative } from '../src/cocoa/native.js';

// --- the fake bridge ----------------------------------------------------------

/** The natives `layout()` reaches, each layout 8px a character and 16px a
 *  line; `coverage: false` is a bridge from before the verb. */
function fakeNative({ coverage = true } = {}) {
  const asked = [];
  const native = {
    asked,
    matchFont: ({ families, size }) => ({ family: families[0], size }),
    fontApplyVariations: (handle) => handle,
    createLayout({ spans }) {
      const text = spans.map((span) => span.text).join('');
      return {
        handle: { layout: text },
        width: text.length * 8,
        height: 16,
        lines: [],
      };
    },
  };
  if (coverage) {
    native.layoutCoverage = (handle, pad) => {
      asked.push([handle, pad]);
      const width = handle.layout.length * 8 + pad * 2;
      const height = 16 + pad * 2;
      return { width, height, data: new Uint8Array(width * height) };
    };
  }
  return native;
}

const base = { family: 'sans-serif', size: 14 };

describe('what reaches the bridge', () => {
  test("its own layout's coverage, with the pad asked for", () => {
    const native = fakeNative();
    const layout = new CocoaFontManager(native).layout('abc', base);
    const coverage = layout.coverage({ pad: 3 });
    assert.deepEqual(native.asked, [[layout._handle, 3]]);
    assert.equal(coverage.width, 30, 'the layout box with the pad round it');
    assert.equal(coverage.height, 22);
    assert.equal(coverage.data.length, 30 * 22);
    layout.coverage();
    assert.deepEqual(
      native.asked[1],
      [layout._handle, 0],
      'no pad unless asked',
    );
  });

  test('a bridge that predates it answers null, so a caller keeps its readback', () => {
    const layout = new CocoaFontManager(fakeNative({ coverage: false })).layout(
      'abc',
      base,
    );
    assert.equal(layout.coverage({ pad: 2 }), null);
  });

  test("the bridge's null is the answer, never undefined", () => {
    const native = fakeNative();
    native.layoutCoverage = () => undefined;
    const layout = new CocoaFontManager(native).layout('', base);
    assert.equal(layout.coverage(), null);
  });
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
    skip: !bridge
      ? 'the @windowkit/appkit bridge is not loadable here'
      : typeof bridge.layoutCoverage !== 'function'
        ? 'this @windowkit/appkit has no layoutCoverage'
        : false,
  },
  () => {
    const PAD = 3;
    const text = [{ text: 'Hamburg 12' }];
    const at24 = { family: 'sans-serif', size: 24 };

    /** Total ink and its centre, over a raster read by `alpha(x, y)`. */
    const ink = (width, height, alpha) => {
      let sum = 0;
      let sx = 0;
      let sy = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const a = alpha(x, y);
          sum += a;
          sx += a * x;
          sy += a * y;
        }
      }
      return { sum, x: sx / sum, y: sy / sum };
    };

    test('the raster is the layout box in whole pixels, with the pad round it', () => {
      const layout = new CocoaFontManager(bridge).layout(text, at24);
      const coverage = layout.coverage({ pad: PAD });
      assert.equal(coverage.width, Math.ceil(layout.width) + PAD * 2);
      assert.equal(coverage.height, Math.ceil(layout.height) + PAD * 2);
      assert.ok(coverage.data instanceof Uint8Array);
      assert.equal(coverage.data.length, coverage.width * coverage.height);
      let whole = 0;
      let grey = 0;
      for (const a of coverage.data) {
        if (a === 255) whole++;
        else if (a > 0) grey++;
      }
      assert.ok(whole > 50, `pixels wholly inside the stems: ${whole}`);
      assert.ok(grey > 50, `antialiased edge pixels: ${grey}`);
    });

    test('the ink is where layout.draw puts it, at (pad, pad)', () => {
      const fonts = new CocoaFontManager(bridge);
      const layout = fonts.layout(text, at24);
      const coverage = layout.coverage({ pad: PAD });
      const { width, height, data } = coverage;
      const surface = bridge.createSurface(width, height, 1);
      const ctx = new BackendContext2D(
        bridge,
        () => surface,
        () => 1,
      );
      ctx._fonts = fonts;
      ctx.fillStyle = '#fff';
      layout.draw(ctx, PAD, PAD);
      const px = bridge.ctxGetImageData(surface, 0, 0, width, height);
      const covered = ink(width, height, (x, y) => data[y * width + x]);
      const drawn = ink(width, height, (x, y) => px[(y * width + x) * 4 + 3]);
      assert.ok(
        Math.abs(covered.x - drawn.x) < 0.75 &&
          Math.abs(covered.y - drawn.y) < 0.75,
        `coverage centred at ${covered.x},${covered.y}; drawn at ${drawn.x},${drawn.y}`,
      );
    });

    test("a span's colour plays no part: the ink is the caller's", () => {
      const fonts = new CocoaFontManager(bridge);
      const plain = fonts.layout(text, at24).coverage({ pad: PAD });
      const faint = fonts
        .layout([{ text: 'Hamburg 12', color: 'rgba(255, 0, 0, 0.25)' }], at24)
        .coverage({ pad: PAD });
      assert.equal(faint.width, plain.width);
      assert.equal(faint.height, plain.height);
      assert.ok(
        Buffer.compare(faint.data, plain.data) === 0,
        'a translucent span covers less than an uncoloured one',
      );
    });
  },
);
