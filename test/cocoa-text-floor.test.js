// The Cocoa text engine's answer to "how narrow can you be?" — the
// min-content floor yoga measures every `<text>` for (`minWidth: 'auto'`,
// nodes.js `contentSpan`), which arrives at `fonts.layout()` as a width
// offer of zero.
//
// It used to be read as "no bound at all" and answered with the whole
// paragraph on one line, so a `<text>` held its flex item open at its
// longest line: two `flexGrow: 1, flexBasis: 0` columns in a 400px row came
// out 823px and 34px wide and the second one left the window, where the same
// tree on X11 wrapped at the longest word.
//
// Two layers, as in cocoa-glyph-runs.test.js. The first runs everywhere: a
// fake bridge, asserting what reaches `createLayout` — which is the whole of
// what this engine decides, since CoreText only shapes what it is handed.
// The second runs where the real bridge loads and measures the pixels: the
// floor is the longest word, to the same fraction as measuring that word
// alone.
import assert from 'node:assert';
import { describe, test } from 'node:test';

import { CocoaFontManager } from '../src/cocoa/fonts.js';
import { loadNative } from '../src/cocoa/native.js';

// --- the fake bridge ----------------------------------------------------------

/**
 * A bridge shaped like the font and layout natives `layout()` reaches:
 * handles by family and size, and a `createLayout` that records what it was
 * given rather than shaping anything.
 */
function fakeNative() {
  const layouts = [];
  return {
    layouts,
    matchFont: ({ families, size }) => ({ family: families[0], size }),
    fontApplyVariations: (handle) => handle,
    createLayout(options) {
      layouts.push(options);
      return { handle: layouts.length, width: 0, height: 0, lines: [] };
    },
  };
}

/** The text of each span the native was handed, last call. */
const textsOf = (native) => native.layouts.at(-1).spans.map((s) => s.text);

describe('the min-content floor', () => {
  const base = { family: 'sans-serif', size: 14 };

  test('a width offer of zero breaks the text at every opportunity', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout([{ text: 'Plain boxes. On the render server.' }], base, {
      maxWidth: 0,
    });

    assert.deepStrictEqual(textsOf(native), [
      'Plain',
      '\n',
      'boxes.',
      '\n',
      'On',
      '\n',
      'the',
      '\n',
      'render',
      '\n',
      'server.',
    ]);
    // The space each break consumed is gone rather than sitting at the end
    // of a line: CoreText's line width would count it, and ntk's does not.
    assert.strictEqual(
      native.layouts.at(-1).maxWidth,
      undefined,
      'the breaks are in the text, so the layout itself is unbounded',
    );
  });

  test('a real width is not broken up — CoreText wraps it', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    const text = 'Plain boxes. On the render server.';
    fonts.layout([{ text }], base, { maxWidth: 194 });
    assert.deepStrictEqual(textsOf(native), [text]);
    assert.strictEqual(native.layouts.at(-1).maxWidth, 194);
  });

  test('no width at all is still max-content: one line, nothing broken', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    const text = 'Plain boxes. On the render server.';
    fonts.layout([{ text }], base, {});
    assert.deepStrictEqual(textsOf(native), [text]);
    assert.strictEqual(native.layouts.at(-1).maxWidth, undefined);
  });

  test('a break between two spans leaves each side its own face', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout(
      [{ text: 'small ' }, { text: 'BIG', size: 28 }, { text: ' after' }],
      base,
      { maxWidth: 0 },
    );
    const spans = native.layouts.at(-1).spans;
    assert.deepStrictEqual(
      spans.map((s) => s.text),
      ['small', '\n', 'BIG', '\n', 'after'],
    );
    assert.strictEqual(spans[2].font.size, 28, 'the big span kept its size');
    assert.strictEqual(spans[4].font.size, 14);
  });

  test('a word that cannot break is one run, whatever it is offered', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout([{ text: 'supercalifragilistic' }], base, { maxWidth: 0 });
    assert.deepStrictEqual(textsOf(native), ['supercalifragilistic']);
  });

  test('a hard newline in the text is an opportunity like any other', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout([{ text: 'one\ntwo three' }], base, { maxWidth: 0 });
    assert.deepStrictEqual(textsOf(native), [
      'one',
      '\n',
      'two',
      '\n',
      'three',
    ]);
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
    skip: bridge ? false : 'the @windowkit/appkit bridge is not loadable here',
  },
  () => {
    const base = { family: 'sans-serif', size: 14 };
    const TEXT =
      'Plain boxes. On the macOS layer presenter these run in the render server.';

    test('the floor is the longest word, not the whole line', () => {
      const fonts = new CocoaFontManager(bridge);
      const at = (maxWidth) =>
        fonts.layout([{ text: TEXT }], base, { maxWidth });

      const maxContent = at(undefined).width;
      const minContent = at(0).width;
      const longestWord = Math.max(
        ...TEXT.split(' ').map(
          (word) => fonts.layout([{ text: word }], base, {}).width,
        ),
      );

      assert.ok(
        Math.abs(minContent - longestWord) < 0.5,
        `min-content ${minContent} is the longest word ${longestWord}`,
      );
      assert.ok(
        minContent < maxContent / 4,
        `min-content ${minContent} is far under max-content ${maxContent}`,
      );
      // …and it is a floor the text can actually be laid out at: wrapped at
      // it, no word is left hanging over the edge. The allowance is one
      // space: CoreText's line width counts a line's trailing whitespace and
      // ntk's does not, which is why the floor is measured with the breaks
      // in the text rather than read off a wrap.
      const wrapped = at(minContent);
      assert.ok(
        wrapped.width <= minContent + base.size,
        `wrapped at its floor, the widest line is ${wrapped.width}`,
      );
      assert.ok(wrapped.height > maxContent / minContent, 'many lines');
    });

    test('a paragraph offered a pixel still breaks inside its words', () => {
      // The reason the text is broken in the engine rather than by asking
      // CoreText for a narrow line: below the floor, CoreText's breaker
      // makes progress by splitting words, which is a floor of one
      // character. ntk does the same under its own floor, so this is not a
      // disagreement — it is why zero cannot be spelled as "very small".
      const fonts = new CocoaFontManager(bridge);
      const pixel = fonts.layout([{ text: TEXT }], base, { maxWidth: 1 });
      const floor = fonts.layout([{ text: TEXT }], base, { maxWidth: 0 });
      assert.ok(
        pixel.width < floor.width / 3,
        `a pixel offer measures ${pixel.width}, the floor is ${floor.width}`,
      );
    });
  },
);
