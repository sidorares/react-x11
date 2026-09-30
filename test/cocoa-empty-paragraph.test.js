// An empty paragraph is one empty line on the Cocoa backend, as it is to
// ntk: as tall as a line of the face it would have been set in, with a caret
// that tall. CoreText sets no line for no text, so the layout came back with
// no lines, no height and a caret of none — and an empty `<textinput>`
// measures its caret from the line it shows, so a field with no value and no
// placeholder drew a caret of its mark padding alone, six pixels at 2x, that
// grew to the line the moment the first letter arrived. A DuckDuckGo search
// box in @react-x11/components' `<Html>` is where it was seen.
//
// Checked over a bridge that answers an empty paragraph the way CoreText
// does, and over the real bridge, where there is one: the empty line is the
// line a letter would have been set on, whatever the line height and the
// alignment.
import assert from 'node:assert';
import { describe, test } from 'node:test';

import { CocoaFontManager } from '../src/cocoa/fonts.js';
import { loadNative } from '../src/cocoa/native.js';

/** A bridge that sets no line for no text, as CoreText does, and one 16px
 *  line for any text, with a caret 8px a code unit. */
function fakeNative() {
  const native = {
    calls: [],
    matchFont: ({ families, size }) => ({ family: families[0], size }),
    fontApplyVariations: (handle) => handle,
    fontMetrics: (handle) => ({
      ascent: handle.size * 0.8,
      descent: handle.size * 0.2,
      leading: handle.size * 0.25,
    }),
    createLayout(options) {
      native.calls.push(options);
      const text = options.spans.map((span) => span.text).join('');
      if (!text) return { handle: native.calls.length, width: 0, height: 0 };
      return {
        handle: native.calls.length,
        width: text.length * 8,
        height: 16,
        lines: [
          {
            x: 0,
            y: 0,
            width: text.length * 8,
            height: 16,
            baseline: 12,
            ascent: 12,
            descent: 4,
            start: 0,
            end: text.length,
            runs: [
              { x: 0, width: text.length * 8, start: 0, end: text.length },
            ],
          },
        ],
      };
    },
    layoutCaret: () => ({ x: 0, y: 0, height: 0, line: 0 }),
    layoutIndexAt: () => 0,
  };
  return native;
}

const base = { family: 'sans-serif', size: 20 };

describe('an empty paragraph on the Cocoa backend', () => {
  test("is one line, as tall as its face's line, with a caret that tall", () => {
    const manager = new CocoaFontManager(fakeNative());
    const layout = manager.layout([{ text: '', ...base }], base);
    // 16 + 4 + 5: the face's ascent, descent and leading at 20px
    assert.strictEqual(layout.height, 25);
    assert.strictEqual(layout.width, 0);
    assert.deepStrictEqual(layout.lines, [
      {
        x: 0,
        y: 0,
        width: 0,
        height: 25,
        // the leading split either side of the glyphs
        baseline: 2.5 + 16,
        ascent: 16,
        descent: 4,
        start: 0,
        end: 0,
        runs: [],
      },
    ]);
    assert.deepStrictEqual(layout.caretPosition(0), {
      x: 0,
      y: 0,
      height: 25,
      line: 0,
    });
    assert.strictEqual(layout.indexAt(40, 10), 0);
  });

  test('takes its face from the span it would have been set in', () => {
    const manager = new CocoaFontManager(fakeNative());
    assert.strictEqual(manager.layout('', base).height, 25);
    assert.strictEqual(
      manager.layout([{ text: '', size: 40 }], base).lines[0].ascent,
      32,
    );
  });

  test('is a line height tall, with the leading split either side', () => {
    const manager = new CocoaFontManager(fakeNative());
    const [line] = manager.layout('', base, { lineHeight: 2 }).lines;
    assert.strictEqual(line.height, 50);
    assert.strictEqual(line.baseline, (50 - 20) / 2 + 16);
    assert.strictEqual(manager.layout('', base, { lineHeight: 0 }).height, 0);
  });

  test('stands where its alignment puts a line', () => {
    const manager = new CocoaFontManager(fakeNative());
    const at = (options) =>
      manager.layout('', base, options).caretPosition(0).x;
    assert.strictEqual(at({ maxWidth: 200 }), 0);
    assert.strictEqual(at({ maxWidth: 200, align: 'right' }), 200);
    assert.strictEqual(at({ maxWidth: 200, align: 'center' }), 100);
    assert.strictEqual(at({ maxWidth: 200, direction: 'rtl' }), 200);
    // with no box to align in there is nowhere to go
    assert.strictEqual(at({ align: 'right' }), 0);
  });

  test('is the same line when it is found again in the cache', () => {
    const native = fakeNative();
    const manager = new CocoaFontManager(native);
    const first = manager.layout([{ text: '', ...base }], base);
    const again = manager.layout([{ text: '', ...base }], base);
    assert.strictEqual(native.calls.length, 1, 'the second is a cache hit');
    assert.deepStrictEqual(again.lines, first.lines);
    assert.strictEqual(again.caretPosition(0).height, 25);
  });

  test('leaves a paragraph with text in it to the native', () => {
    const manager = new CocoaFontManager(fakeNative());
    const layout = manager.layout('ab', base);
    assert.strictEqual(layout.lines.length, 1);
    assert.strictEqual(layout.lines[0].height, 16);
    assert.strictEqual(layout.caretPosition(1).height, 0, "the native's");
  });
});

// --- over the real bridge -----------------------------------------------------

let bridge;
try {
  bridge = loadNative();
} catch {
  bridge = null;
}

describe(
  'over the real bridge',
  { skip: bridge ? false : 'no @windowkit/appkit here' },
  () => {
    const pick = ({ height, baseline, ascent, descent }) => ({
      height,
      baseline,
      ascent,
      descent,
    });

    for (const [name, options] of [
      ['a line', {}],
      ['a double line', { lineHeight: 2 }],
    ]) {
      test(`the empty line is ${name} a letter would have been set on`, () => {
        const manager = new CocoaFontManager(bridge);
        const style = { family: 'sans-serif', size: 40 };
        const empty = manager.layout([{ text: '', ...style }], style, options);
        const letter = manager.layout(
          [{ text: 'H', ...style }],
          style,
          options,
        );
        assert.deepStrictEqual(pick(empty.lines[0]), pick(letter.lines[0]));
        assert.strictEqual(empty.height, letter.height);
        const caret = empty.caretPosition(0);
        const lettered = letter.caretPosition(0);
        assert.strictEqual(caret.y, lettered.y);
        assert.strictEqual(caret.height, lettered.height);
        assert.ok(caret.height > 40, `a caret ${caret.height} tall`);
      });
    }

    test('right-aligned, it stands where a letter would start from', () => {
      const manager = new CocoaFontManager(bridge);
      const style = { family: 'sans-serif', size: 40 };
      const options = { maxWidth: 200, align: 'right' };
      const empty = manager.layout('', style, options);
      const letter = manager.layout('H', style, options);
      // the caret after the letter is where the line ends: the edge
      assert.strictEqual(empty.caretPosition(0).x, letter.caretPosition(1).x);
    });
  },
);
