// `letterSpacing` and the OpenType features on the Cocoa text engine (#588).
//
// CoreText does the shaping; what this engine decides is what it hands the
// bridge. Features are a property of the font, so a span is set in a font
// with them applied (`fontApplyFeatures`, one per face and feature set).
// Letter spacing is the typesetter's kerning attribute on the span, and it
// turns the optional ligatures off, as ntk does and as CSS says to: an `fi`
// drawn as one glyph has no gap to open in its middle.
//
// Two layers, as in cocoa-text-floor.test.js. A fake bridge, everywhere, for
// what reaches `createLayout`; the real one, where it loads, for widths.
// text-spacing-features.test.js has the vocabulary and the X11 engine.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import React from 'react';

import { CocoaFontManager } from '../src/cocoa/fonts.js';
import { loadNative } from '../src/cocoa/native.js';
import { cleanupCocoa, mountCocoa } from './helpers/cocoa-bridge.js';

const h = React.createElement;

afterEach(cleanupCocoa);

// --- the fake bridge ----------------------------------------------------------

/** The font and layout natives `layout()` reaches, recording what the
 *  features verb and `createLayout` were handed. `features: false` is a
 *  bridge from before the verb. */
function fakeNative({ features = true } = {}) {
  const layouts = [];
  const applied = [];
  const native = {
    layouts,
    applied,
    matchFont: ({ families, size }) => ({ family: families[0], size }),
    fontApplyVariations: (handle) => handle,
    createLayout(options) {
      layouts.push(options);
      return { handle: layouts.length, width: 0, height: 0, lines: [] };
    },
  };
  if (features) {
    native.fontApplyFeatures = (handle, tags) => {
      applied.push(tags);
      return { ...handle, features: tags };
    };
  }
  return native;
}

const spansOf = (native) => native.layouts.at(-1).spans;
const base = { family: 'sans-serif', size: 14 };
const LIGATURES_OFF = { liga: 0, clig: 0, dlig: 0, hlig: 0 };

describe('what reaches the bridge', () => {
  test('a span is set in the font with its features applied', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout([{ text: '1111' }], { ...base, features: { tnum: 1 } });
    const [span] = spansOf(native);
    assert.deepEqual(span.font, {
      family: 'sans-serif',
      size: 14,
      features: { tnum: 1 },
    });
    assert.equal('letterSpacing' in span, false);
  });

  test('a span of its own wins over the paragraph', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout([{ text: '12', features: { tnum: 1 } }, { text: '34' }], {
      ...base,
      features: { onum: 1 },
    });
    const [own, inherited] = spansOf(native);
    assert.deepEqual(own.font.features, { tnum: 1 });
    assert.deepEqual(inherited.font.features, { onum: 1 });
  });

  test('the bridge is asked once per face and feature set', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    const style = { ...base, features: { tnum: 1 } };
    fonts.layout([{ text: '1111' }], style);
    fonts.layout([{ text: '2222' }], style);
    fonts.layout([{ text: '3333' }], { ...base, features: { tnum: 1 } });
    assert.equal(native.layouts.length, 3, 'three paragraphs laid out');
    assert.equal(native.applied.length, 1, 'one featured font');
    fonts.layout([{ text: '4444' }], { ...base, features: { onum: 1 } });
    assert.equal(native.applied.length, 2);
  });

  test('letter spacing rides on the span, with the optional ligatures off', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout([{ text: 'office' }], { ...base, letterSpacing: 2 });
    const [span] = spansOf(native);
    assert.equal(span.letterSpacing, 2);
    assert.deepEqual(span.font.features, LIGATURES_OFF);

    // …unless the style names one, which is asking for it
    fonts.layout([{ text: 'office' }], {
      ...base,
      letterSpacing: 2,
      features: { liga: 1, tnum: 1 },
    });
    assert.deepEqual(spansOf(native)[0].font.features, {
      ...LIGATURES_OFF,
      liga: 1,
      tnum: 1,
    });
  });

  test('nothing asked for is nothing sent', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    fonts.layout([{ text: 'office' }], { ...base, letterSpacing: 0 });
    const [span] = spansOf(native);
    assert.equal(native.applied.length, 0);
    assert.equal('features' in span.font, false);
    assert.equal('letterSpacing' in span, false);
  });

  test('a paragraph spaced differently is a different layout', () => {
    const native = fakeNative();
    const fonts = new CocoaFontManager(native);
    const plain = fonts.layout([{ text: 'abc' }], base);
    assert.ok(fonts.layout([{ text: 'abc' }], base) === plain, 'memoized');
    fonts.layout([{ text: 'abc' }], { ...base, letterSpacing: 1 });
    fonts.layout([{ text: 'abc' }], { ...base, features: { smcp: 1 } });
    assert.equal(native.layouts.length, 3);
  });

  test('a bridge from before the verb draws the face as it is, and says so once', (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (message) => warnings.push(message));
    const native = fakeNative({ features: false });
    const fonts = new CocoaFontManager(native);
    const style = { ...base, letterSpacing: 2, features: { tnum: 1 } };
    fonts.layout([{ text: '1111' }], style);
    fonts.layout([{ text: '2222' }], style);

    const [span] = spansOf(native);
    assert.deepEqual(span.font, { family: 'sans-serif', size: 14 });
    // an old bridge would take the option and ignore it; this engine does
    // not send what it knows nothing will read
    assert.equal('letterSpacing' in span, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no fontApplyFeatures, so letterSpacing/);
  });

  test('…and in production says nothing', (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (message) => warnings.push(message));
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const fonts = new CocoaFontManager(fakeNative({ features: false }));
      fonts.layout([{ text: '1111' }], { ...base, features: { tnum: 1 } });
    } finally {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
    }
    assert.deepEqual(warnings, []);
  });

  test('a <text> reaches the bridge in device pixels, figures and all', async () => {
    const { native } = await mountCocoa(
      h(
        'text',
        {
          style: {
            letterSpacing: 1.5,
            fontVariantNumeric: 'tabular-nums slashed-zero',
          },
        },
        '1020',
      ),
    );
    const call = native
      .of('createLayout')
      .map(([options]) => options)
      .findLast((options) => options.spans.some((s) => s.text === '1020'));
    assert.ok(call, 'the paragraph was laid out');
    const [span] = call.spans;
    assert.equal(span.letterSpacing, 3, 'scale 2');
    assert.deepEqual(span.font.features, {
      ...LIGATURES_OFF,
      tnum: 1,
      zero: 1,
    });
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
    const face = { family: 'system-ui', size: 30 };
    const width = (fonts, text, style = {}) =>
      fonts.layout([{ text }], { ...face, ...style }).width;

    test('tabular figures are one width', () => {
      const fonts = new CocoaFontManager(bridge);
      const ones = width(fonts, '1111');
      const eights = width(fonts, '8888');
      assert.ok(ones < eights - 5, `proportional: ${ones} against ${eights}`);
      const tnum = { features: { tnum: 1 } };
      assert.equal(width(fonts, '1111', tnum), width(fonts, '8888', tnum));
    });

    test('letter spacing is added after every letter', () => {
      const fonts = new CocoaFontManager(bridge);
      const plain = width(fonts, 'abc');
      const spaced = width(fonts, 'abc', { letterSpacing: 4 });
      assert.ok(
        Math.abs(spaced - (plain + 3 * 4)) < 0.01,
        `${plain} -> ${spaced}`,
      );
    });
  },
);
