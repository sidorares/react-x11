// The Cocoa text engine's answer to "how narrow can you be?" — the
// min-content floor yoga measures every `<text>` for (`minWidth: 'auto'`,
// nodes/window/floors.js `contentSpan`), which arrives at `fonts.layout()` as a width
// offer of zero.
//
// It used to be read as "no bound at all" and answered with the whole
// paragraph on one line, so a `<text>` held its flex item open at its
// longest line: two `flexGrow: 1, flexBasis: 0` columns in a 400px row came
// out 823px and 34px wide and the second one left the window, where the same
// tree on X11 wrapped at the longest word.
//
// A paragraph that **elides** is the other half of the same question, and
// it was still wrong after that, #512: a `<text textWrap="nowrap"
// textOverflow="ellipsis">` reaches the engine as `maxLines: 1, ellipsis:
// true`, and eliding needs a width the min-content probe has none of. Handed
// none, CoreText keeps the line count and puts everything that was over it
// back on the last line — a caption measured 472.5 against a max-content of
// 506.9, so every eliding label on this backend held its box open at its
// full width and overflowed sideways instead of giving way. An eliding
// paragraph does not need its longest word: it has somewhere to put the
// text it cannot show. Its floor is the mark, which is what ntk answers to
// the third decimal, so the cut is made here and the native is asked for
// neither a cap nor an elision.
//
// Two layers, as in cocoa-glyph-runs.test.js. The first runs everywhere: a
// fake bridge, asserting what reaches `createLayout` — which is the whole of
// what this engine decides, since CoreText only shapes what it is handed.
// The second runs where the real bridge loads and measures the pixels: the
// floor is the longest word, or the ellipsis where the text elides, to the
// same fraction as measuring either alone.
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

  test('an eliding paragraph floors at the mark, not at its longest word', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout([{ text: 'Plain boxes. On the render server.' }], base, {
      maxWidth: 0,
      maxLines: 1,
      overflow: 'ellipsis',
    });

    assert.deepStrictEqual(textsOf(native), ['\u2026']);
    // the cap and the cut are in the text, so the request carries neither —
    // asking the native to elide is asking it to do the one thing it cannot
    // do without a width
    const call = native.layouts.at(-1);
    assert.strictEqual(call.maxWidth, undefined);
    assert.strictEqual(call.maxLines, undefined);
    assert.strictEqual(call.ellipsis, false);
  });

  test('a cap of two keeps the first line and then the mark', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout([{ text: 'Plain boxes. On the render server.' }], base, {
      maxWidth: 0,
      maxLines: 2,
      overflow: 'ellipsis',
    });
    assert.deepStrictEqual(textsOf(native), ['Plain', '\n', '\u2026']);
  });

  test('a paragraph inside its cap is not given a mark it does not need', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout([{ text: 'Plain boxes.' }], base, {
      maxWidth: 0,
      maxLines: 3,
      overflow: 'ellipsis',
    });
    // two lines under a cap of three: nothing is over it, so nothing stands
    // for anything and the floor is the longest word, as it is for a
    // paragraph that wraps
    assert.deepStrictEqual(textsOf(native), ['Plain', '\n', 'boxes.']);
  });

  test('a word that cannot break is its whole self, mark or no mark', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout([{ text: 'supercalifragilistic' }], base, {
      maxWidth: 0,
      maxLines: 1,
      overflow: 'ellipsis',
    });
    assert.deepStrictEqual(textsOf(native), ['supercalifragilistic']);
  });

  test('the mark is set in the font of the run the cut fell in', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout(
      [{ text: 'small ' }, { text: 'BIG ', size: 28 }, { text: 'after' }],
      base,
      { maxWidth: 0, maxLines: 2, overflow: 'ellipsis' },
    );
    const spans = native.layouts.at(-1).spans;
    assert.deepStrictEqual(
      spans.map((sp) => sp.text),
      ['small', '\n', '\u2026'],
    );
    // the second line is where the cut fell, so the mark wears its face —
    // ntk picks the ellipsis against the cut run's own coverage
    assert.strictEqual(spans[2].font.size, 28);
  });

  test('an elision with a width to work to is left to the native', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    const text = 'Plain boxes. On the render server.';
    fonts.layout([{ text }], base, {
      maxWidth: 194,
      maxLines: 1,
      overflow: 'ellipsis',
    });
    const call = native.layouts.at(-1);
    assert.deepStrictEqual(textsOf(native), [text]);
    assert.strictEqual(call.maxWidth, 194);
    assert.strictEqual(call.maxLines, 1);
    assert.strictEqual(call.ellipsis, true);
  });

  test('an ellipsis with nothing to cap cannot fire, here either', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    // `maxLines: undefined` is how an uncapped paragraph arrives (TextNode
    // sends `_maxLines()` only when it is finite), and ntk elides off the
    // line count — so this is a plain min-content measurement
    fonts.layout([{ text: 'Plain boxes.' }], base, {
      maxWidth: 0,
      overflow: 'ellipsis',
    });
    assert.deepStrictEqual(textsOf(native), ['Plain', '\n', 'boxes.']);
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

    test('and when it elides, the floor is the mark itself', () => {
      const fonts = new CocoaFontManager(bridge);
      const elided = fonts.layout([{ text: TEXT }], base, {
        maxWidth: 0,
        maxLines: 1,
        overflow: 'ellipsis',
      });
      const mark = fonts.layout([{ text: '\u2026' }], base, {}).width;
      const wrapping = fonts.layout([{ text: TEXT }], base, {
        maxWidth: 0,
      }).width;

      assert.ok(
        Math.abs(elided.width - mark) < 0.5,
        `floored at ${elided.width}, the mark is ${mark}`,
      );
      assert.ok(
        elided.width < wrapping / 4,
        `an eliding label gives way further than a wrapping one ` +
          `(${elided.width} against ${wrapping})`,
      );
      // one line, and a line of the height the paragraph has anywhere else:
      // a floor is a width answer, and must not shorten the box
      assert.strictEqual(elided.lines.length, 1);
      assert.strictEqual(
        elided.height,
        fonts.layout([{ text: TEXT }], base, {}).height,
      );
    });

    test('a bounded elision is untouched by any of that', () => {
      const fonts = new CocoaFontManager(bridge);
      const at = (maxWidth) =>
        fonts.layout([{ text: TEXT }], base, {
          maxWidth,
          maxLines: 1,
          overflow: 'ellipsis',
        }).width;
      const room = fonts.layout([{ text: TEXT }], base, {}).width / 3;
      assert.ok(at(room) <= room, `elided to ${at(room)} inside ${room}`);
      assert.ok(at(room) > room / 2, 'and used the room it was given');
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
