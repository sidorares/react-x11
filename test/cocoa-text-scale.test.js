// Text on a Retina display is set at its point size. A size the Cocoa engine
// is handed is in device pixels, and CoreText reads some of a face's data by
// point size — San Francisco's optical size and tracking, Apple Color
// Emoji's `trak` — so a font made at the device size was the face as it is
// set at twice the size on a 2x display: a 13px label 8% narrower than
// AppKit sets it, a 19px emoji 1em wide where it is 23pt at 19pt. The bridge
// makes a font at a scale instead (windowkit/appkit#106): at `size / scale`
// points, answering in device pixels.
//
// Two layers, as test/cocoa-glyph-runs.test.js has them. The first runs
// everywhere: every way the engine makes a font hands the bridge the app's
// scale, and a 1x app asks exactly what it always asked. The second runs
// where the real bridge loads and takes the scale, and holds the widths the
// engine answers at 2x to twice the 1x ones.
import assert from 'node:assert';
import { describe, test } from 'node:test';

import { CocoaFontManager } from '../src/cocoa/fonts.js';
import { loadNative } from '../src/cocoa/native.js';

/** A bridge that remembers how it was asked for each font. */
function fakeNative() {
  const asked = [];
  return {
    asked,
    matchFont(request) {
      asked.push(['matchFont', request]);
      return { ps: `${request.families[0]}-${request.size}` };
    },
    cgFontWithSize(...args) {
      asked.push(['cgFontWithSize', ...args]);
      return { ps: `registered-${args[1]}` };
    },
    fontByPostScriptName(...args) {
      asked.push(['fontByPostScriptName', ...args]);
      return { ps: args[0] };
    },
    fontFromData: () => ({
      cg: 'cg',
      familyName: 'Loaded',
      postScriptName: 'Loaded-Regular',
      weight: 400,
      italic: false,
    }),
    fontMetrics: (handle) => ({
      ascent: 11,
      descent: 3,
      leading: 0,
      familyName: '',
      postScriptName: handle.ps,
    }),
  };
}

/** Every way the engine makes a font: a family it matches, a face the app
 *  loaded, and a face handed over as a span's `font`. */
function makeEach(fonts) {
  fonts.match('Helvetica', { weight: 700 }).metrics(26);
  fonts.load(Buffer.from([0, 1, 0, 0, 0, 0]));
  fonts.match('Loaded').metrics(26);
  fonts._runHandle({ postscriptName: 'Opened-Regular', key: 'opened' }, 26);
}

test('at 2x, every font the engine makes is made at the app’s scale', () => {
  const native = fakeNative();
  makeEach(new CocoaFontManager(native, { scale: 2 }));
  assert.deepEqual(native.asked, [
    [
      'matchFont',
      {
        families: ['Helvetica'],
        size: 26,
        weight: 700,
        italic: false,
        scale: 2,
      },
    ],
    ['cgFontWithSize', 'cg', 26, 2],
    // whether the face is installed, which no size changes
    ['fontByPostScriptName', 'Opened-Regular', 12],
    ['fontByPostScriptName', 'Opened-Regular', 26, 2],
  ]);
});

test('at 1x, the bridge is asked what it always was', () => {
  for (const options of [
    undefined,
    { scale: 1 },
    { scale: NaN },
    { scale: 0 },
  ]) {
    const native = fakeNative();
    makeEach(new CocoaFontManager(native, options));
    assert.deepEqual(
      native.asked,
      [
        [
          'matchFont',
          { families: ['Helvetica'], size: 26, weight: 700, italic: false },
        ],
        ['cgFontWithSize', 'cg', 26],
        ['fontByPostScriptName', 'Opened-Regular', 12],
        ['fontByPostScriptName', 'Opened-Regular', 26],
      ],
      JSON.stringify(options),
    );
  }
});

// --- the real bridge ------------------------------------------------------------

let bridge = null;
if (process.platform === 'darwin') {
  try {
    bridge = loadNative();
  } catch {
    bridge = null;
  }
}

const SENTENCE = 'The quick brown fox jumps';
const EMOJI = '\u{1F605}';
const width = (fonts, text, family, size) =>
  fonts.layout([{ text }], { family, size }, {}).width;

/** Whether the bridge makes a font at a scale, asked of the bridge alone:
 *  San Francisco at 13pt is wider than at 26pt, so a 26px line at 2x that
 *  is not wider than one at 1x is a bridge that ignored the scale. */
function takesScale(native) {
  const at = (scale) => {
    const font = native.matchFont({
      families: ['system-ui'],
      size: 26,
      weight: 400,
      italic: false,
      scale,
    });
    return native.createLayout({ spans: [{ text: SENTENCE, font }] }).width;
  };
  return at(2) > at(1) + 1;
}

describe(
  'over the real bridge',
  {
    skip: !bridge
      ? 'the @windowkit/appkit bridge is not loadable here'
      : !takesScale(bridge)
        ? 'this @windowkit/appkit makes no font at a scale'
        : false,
  },
  () => {
    test('the system face at 2x is twice its 1x width, as AppKit sets it', () => {
      const at1 = new CocoaFontManager(bridge, { scale: 1 });
      const at2 = new CocoaFontManager(bridge, { scale: 2 });
      for (const size of [11, 13, 19]) {
        const one = width(at1, SENTENCE, 'system-ui', size);
        const two = width(at2, SENTENCE, 'system-ui', size * 2);
        assert.ok(
          Math.abs(two - one * 2) < 1e-3,
          `${size}px: ${two} against ${one * 2}`,
        );
        // and not the face as it is set at twice the size
        assert.ok(
          Math.abs(two - width(at1, SENTENCE, 'system-ui', size * 2)) > 1,
          `${size}px is not set as ${size * 2}px`,
        );
      }
    });

    test('an emoji at 2x is twice its 1x width, to the pixel CoreText rounds it to', () => {
      const at1 = new CocoaFontManager(bridge, { scale: 1 });
      const at2 = new CocoaFontManager(bridge, { scale: 2 });
      for (const size of [13, 16, 19]) {
        const one = width(at1, EMOJI, 'Helvetica', size);
        const two = width(at2, EMOJI, 'Helvetica', size * 2);
        assert.ok(
          Math.abs(two - one * 2) <= 1,
          `${size}px: ${two} against ${one * 2}`,
        );
        assert.ok(two > size * 2 + 2, `${size}px: wider than 1em, ${two}`);
      }
    });

    test('a face with no size-dependent data measures as it did', () => {
      const at1 = new CocoaFontManager(bridge, { scale: 1 });
      const at2 = new CocoaFontManager(bridge, { scale: 2 });
      for (const family of ['Helvetica', 'Menlo']) {
        const before = width(at1, SENTENCE, family, 26);
        const now = width(at2, SENTENCE, family, 26);
        assert.ok(
          Math.abs(now - before) < 1e-3,
          `${family}: ${now} against ${before}`,
        );
      }
    });
  },
);
