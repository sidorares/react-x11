// A variable face's axis values on the Cocoa text engine: a span is set in
// the font `fontApplyVariations` makes of its face at those values, and
// that font is kept per face and value set, as a featured one is
// (cocoa-text-features.test.js). Asked again for every span of every
// layout, CoreText shaped each with a font it had never seen, and a page in
// a variable web font spent seconds setting its text.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CocoaFontManager } from '../src/cocoa/fonts.js';

/** The font and layout natives `layout()` reaches, counting what the
 *  variations and features verbs were asked; each answers a font of its
 *  own, as the bridge's do. */
function fakeNative() {
  const layouts = [];
  const varied = [];
  const featured = [];
  return {
    layouts,
    varied,
    featured,
    matchFont: ({ families, size }) => ({ family: families[0], size }),
    fontApplyVariations(handle, variations) {
      varied.push(variations);
      return { ...handle, variations };
    },
    fontApplyFeatures(handle, features) {
      featured.push(features);
      return { ...handle, features };
    },
    createLayout(options) {
      layouts.push(options);
      return { handle: layouts.length, width: 0, height: 0, lines: [] };
    },
  };
}

const spansOf = (native) => native.layouts.at(-1).spans;
const base = { family: 'Archivo', size: 16 };
const BOLD = { wght: 700, wdth: 100 };

describe('variable faces', () => {
  test('a span is set in its face at its axis values', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout([{ text: 'Bun', variations: BOLD }], base);
    assert.deepEqual(spansOf(native)[0].font, {
      family: 'Archivo',
      size: 16,
      variations: BOLD,
    });
  });

  test('the bridge is asked once per face and value set, however many spans and layouts', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    const paragraph = (i) =>
      Array.from({ length: 20 }, (_, j) => ({
        text: `word ${i}.${j} `,
        variations: BOLD,
      }));
    for (let i = 0; i < 10; i++) fonts.layout(paragraph(i), base);
    assert.equal(native.layouts.length, 10, 'ten paragraphs laid out');
    assert.equal(native.varied.length, 1, 'one varied font');
    const fonts0 = spansOf(native).map((span) => span.font);
    assert.ok(
      fonts0.every((font) => font === fonts0[0]),
      'every span in the one font',
    );
    // a value set written in a new object is the same set
    fonts.layout([{ text: 'again', variations: { ...BOLD } }], base);
    assert.equal(native.varied.length, 1);
    fonts.layout([{ text: 'light', variations: { wght: 300 } }], base);
    assert.equal(native.varied.length, 2, 'another value set, another font');
  });

  test('a varied font is featured once, since it is the same font each time', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    const style = { ...base, features: { tnum: 1 } };
    fonts.layout([{ text: '1111', variations: BOLD }], style);
    fonts.layout([{ text: '2222', variations: BOLD }], style);
    fonts.layout([{ text: '3333', variations: BOLD }], style);
    assert.equal(native.varied.length, 1);
    assert.equal(native.featured.length, 1);
    assert.deepEqual(spansOf(native)[0].font, {
      family: 'Archivo',
      size: 16,
      variations: BOLD,
      features: { tnum: 1 },
    });
  });

  test('no axis values is no varied font', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout([{ text: 'plain' }], base);
    fonts.layout([{ text: 'empty', variations: {} }], base);
    assert.equal(native.varied.length, 0);
    assert.equal('variations' in spansOf(native)[0].font, false);
  });

  test('a font kept goes with the face it was made from', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout([{ text: 'one', variations: BOLD }], base);
    assert.equal(native.varied.length, 1);
    // another scale lets every face's fonts go, and their varied fonts with
    // them: the face is made again, and so is its font at those values
    fonts.setScale(2);
    fonts.layout([{ text: 'two', variations: BOLD }], base);
    assert.equal(native.varied.length, 2);
  });
});
