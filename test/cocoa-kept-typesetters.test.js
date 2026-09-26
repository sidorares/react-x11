// The Cocoa text engine keeps a paragraph's typesetter, and lays the
// paragraph out at another width from it (`CocoaFontManager._keptTypesetter`,
// @windowkit/appkit's `keep`/`typesetter`/`packed`/`releaseTypesetter`).
//
// Two thirds of a CoreText layout is the text becoming glyphs — the
// attributed string built from the spans, and the typesetter shaping it —
// and a paragraph laid out at another width breaks the same glyphs into
// other lines. A window resize does that to every paragraph of a document,
// and a paragraph's max-content and wrapped measurements are two layouts of
// one text.
//
// Two layers, as in cocoa-text-floor.test.js. The first runs everywhere: a
// fake bridge, asserting what reaches `createLayout` and `releaseTypesetter`
// — which paragraph is shaped, which is laid out again, which is let go. The
// second runs where a bridge that keeps typesetters loads: every layout the
// engine makes from a kept typesetter is the layout it makes without one.
import assert from 'node:assert';
import { describe, test } from 'node:test';

import { CocoaFontManager } from '../src/cocoa/fonts.js';
import { loadNative } from '../src/cocoa/native.js';

// --- the fake bridge ----------------------------------------------------------

/**
 * The layout natives `layout()` reaches, recording rather than shaping: a
 * `createLayout` that answers a typesetter when it is asked to keep one and
 * packed geometry when asked for it — one line, one run, over the text it
 * was given — and a `releaseTypesetter` that notes what was let go. `keeps:
 * false` is a bridge from before the verbs.
 */
function fakeNative({ keeps = true } = {}) {
  let ids = 0;
  const calls = [];
  const released = [];
  const native = {
    calls,
    released,
    matchFont: ({ families, size }) => ({ family: families[0], size }),
    fontApplyVariations: (handle) => handle,
    createLayout(options) {
      calls.push(options);
      const units = options.typesetter
        ? options.typesetter.units
        : options.spans.reduce((n, s) => n + s.text.length, 0);
      const raw = { handle: calls.length, width: 10, height: 12 };
      if (options.keep) raw.typesetter = { id: ++ids, units };
      if (options.packed) {
        raw.lineData = new Float64Array([1, 2, 10, 12, 9, 9, 3, 0, units, 1]);
        raw.runData = new Float64Array([1, 10, 0, units, 0]);
      } else {
        raw.lines = [];
      }
      return raw;
    },
    layoutCaret: (handle, cu) => ({ cu }),
    layoutIndexAt: (handle, x) => x,
  };
  if (keeps) native.releaseTypesetter = (handle) => released.push(handle.id);
  return native;
}

const base = { family: 'sans-serif', size: 14 };
const para = (text, extra) => [{ text, ...extra }];

describe('the kept typesetter', () => {
  test('a paragraph laid out at another width is laid out from its typesetter', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout(para('A paragraph of text.'), base, { maxWidth: 300 });
    fonts.layout(para('A paragraph of text.'), base, { maxWidth: 200 });
    fonts.layout(para('A paragraph of text.'), base, {});
    const [first, second, third] = native.calls;
    assert.ok(first.spans && first.keep, 'shaped once, and kept');
    assert.strictEqual(second.spans, undefined, 'not shaped again');
    assert.strictEqual(second.typesetter.id, 1, 'laid out from the kept one');
    assert.strictEqual(second.keep, false, 'and not kept twice');
    assert.strictEqual(second.maxWidth, 200, 'at its own width');
    assert.strictEqual(third.typesetter?.id, 1, 'max-content is a width too');
    assert.strictEqual(native.released.length, 0);
  });

  test('another text, style or direction is another typesetter', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout(para('Words'), base, { maxWidth: 100 });
    fonts.layout(para('Words.'), base, { maxWidth: 90 });
    fonts.layout(para('Words'), { ...base, size: 15 }, { maxWidth: 90 });
    fonts.layout(para('Words', { color: '#f00' }), base, { maxWidth: 90 });
    fonts.layout(para('Words'), base, { maxWidth: 90, direction: 'rtl' });
    for (const call of native.calls) {
      assert.ok(call.spans, 'shaped from its spans');
    }
    // …and the width, alignment, line height and line cap are not
    fonts.layout(para('Words'), base, {
      maxWidth: 80,
      align: 'center',
      lineHeight: 1.5,
      maxLines: 2,
      overflow: 'ellipsis',
    });
    assert.strictEqual(native.calls.at(-1).typesetter?.id, 1);
  });

  test('a min-content measurement lays out other text, and keeps its own', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout(para('Plain boxes on glass'), base, { maxWidth: 200 });
    fonts.layout(para('Plain boxes on glass'), base, { maxWidth: 0 });
    const probe = native.calls.at(-1);
    assert.ok(probe.spans, 'the broken text is shaped, not the paragraph');
    assert.ok(
      probe.spans.some((s) => s.text === '\n'),
      'broken',
    );
    // …and the paragraph's own is still the paragraph's
    fonts.layout(para('Plain boxes on glass'), base, { maxWidth: 150 });
    assert.strictEqual(native.calls.at(-1).typesetter?.id, 1);
    fonts.layout(para('Plain boxes on glass'), base, { maxWidth: 0 });
    // (the layout memo answers the repeated question outright)
    assert.strictEqual(native.calls.length, 3);
  });

  test('past a megabyte of text the paragraph laid out least recently is let go', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    const big = (c) => c.repeat(400_000);
    fonts.layout(para(big('a')), base, { maxWidth: 500 }); // 1
    fonts.layout(para(big('b')), base, { maxWidth: 500 }); // 2
    fonts.layout(para(big('a')), base, { maxWidth: 400 }); // 1 is recent now
    assert.deepStrictEqual(native.released, []);
    fonts.layout(para(big('c')), base, { maxWidth: 500 }); // 3: over, 2 goes
    assert.deepStrictEqual(native.released, [2]);
    fonts.layout(para(big('b')), base, { maxWidth: 300 });
    assert.ok(native.calls.at(-1).spans, 'a paragraph let go is shaped again');
    assert.deepStrictEqual(native.released, [2, 1]);
  });

  test('a font the app loads lets every kept typesetter go', () => {
    const native = fakeNative();
    native.fontFromData = () => ({ cg: {}, familyName: 'Loaded' });
    const fonts = new CocoaFontManager(native);
    fonts.layout(para('One'), base, { maxWidth: 100 });
    fonts.layout(para('Two'), base, { maxWidth: 100 });
    fonts.load(Buffer.alloc(16), {});
    assert.deepStrictEqual(native.released.sort(), [1, 2]);
    fonts.layout(para('One'), base, { maxWidth: 90 });
    assert.ok(native.calls.at(-1).spans, 'shaped again, against the new face');
  });

  test('the packed geometry is the lines, key for key', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    const spans = para('abc');
    const layout = fonts.layout(spans, base, { maxWidth: 100 });
    // the geometry the bridge sent, and the span each run hangs off
    const geometry = layout.lines.map((line) => ({
      ...line,
      runs: line.runs.map(({ span, run, ...r }) => r),
    }));
    assert.strictEqual(layout.lines[0].runs[0].span, spans[0]);
    assert.deepStrictEqual(geometry, [
      {
        x: 1,
        y: 2,
        width: 10,
        height: 12,
        baseline: 9,
        ascent: 9,
        descent: 3,
        start: 0,
        end: 3,
        runs: [{ x: 1, width: 10, start: 0, end: 3, rtl: false }],
      },
    ]);
  });

  test('a bridge from before the verbs is asked the old way', () => {
    const native = fakeNative({ keeps: false });
    const fonts = new CocoaFontManager(native);
    fonts.layout(para('Words'), base, { maxWidth: 100 });
    fonts.layout(para('Words'), base, { maxWidth: 90 });
    for (const call of native.calls) {
      assert.ok(call.spans, 'shaped every time');
      assert.strictEqual(call.keep, undefined);
      assert.strictEqual(call.packed, undefined);
    }
  });

  test('a code point is a code unit until a surrogate pair says otherwise', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    const plain = fonts.layout(para('héllo wörld'), base, {});
    assert.deepStrictEqual(plain.caretPosition(4), { cu: 4 });
    assert.deepStrictEqual(plain.caretPosition(99), { cu: 11 }, 'clamped');
    assert.deepStrictEqual(plain.caretPosition(-2), { cu: 0 });
    assert.strictEqual(plain.indexAt(5.2, 0), 6, 'the boundary at or after');
    assert.strictEqual(plain.indexAt(40, 0), 11);
    const astral = fonts.layout(para('a😀b'), base, {});
    assert.deepStrictEqual(
      astral.caretPosition(2),
      { cu: 3 },
      'after the pair',
    );
    assert.strictEqual(astral.indexAt(3, 0), 2);
  });
});

// --- over the real bridge -----------------------------------------------------

let bridge = null;
try {
  bridge = loadNative();
} catch {
  bridge = null;
}

describe(
  'over the real bridge',
  {
    skip:
      typeof bridge?.releaseTypesetter === 'function'
        ? false
        : 'no @windowkit/appkit here that keeps typesetters',
  },
  () => {
    test('a paragraph laid out from its typesetter is the paragraph laid out from its spans', () => {
      const kept = new CocoaFontManager(bridge);
      // the same bridge with the verb hidden: every layout from the spans
      const fresh = new CocoaFontManager(
        new Proxy(bridge, {
          get: (target, key) =>
            key === 'releaseTypesetter' ? undefined : target[key],
        }),
      );
      const spans = [
        { text: 'A paragraph set in ' },
        { text: 'two weights', weight: 700, color: '#c33' },
        { text: ', spaced ', letterSpacing: 1.5 },
        { text: 'and an emoji 😀, long enough to wrap at every width.' },
      ];
      // a run's face is its manager's, so it is compared by what it is
      const shape = (layout) =>
        JSON.stringify(
          { w: layout.width, h: layout.height, lines: layout.lines },
          (key, value) =>
            key === 'run' && value?.font
              ? { face: value.font.key, size: value.size, dir: value.direction }
              : value,
        );
      for (const options of [
        { maxWidth: 400 },
        { maxWidth: 250, align: 'center' },
        { maxWidth: 160, lineHeight: 1.4 },
        { maxWidth: 160, maxLines: 2, overflow: 'ellipsis' },
        {},
        { maxWidth: 0 },
        { maxWidth: 100, direction: 'rtl' },
      ]) {
        assert.strictEqual(
          shape(kept.layout(spans, base, options)),
          shape(fresh.layout(spans, base, options)),
          JSON.stringify(options),
        );
      }
      assert.ok(kept._typesetters.size > 0, 'the typesetters were kept');
    });
  },
);
