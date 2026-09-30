// What a family list becomes on its way to the bridge. `-apple-system` and
// `BlinkMacSystemFont` are the macOS system font's names in WebKit/Gecko and
// in Blink, and a stack written for the web leads with both; neither is a
// family CoreText can look up, so the list used to move on to Helvetica.
//
// Two layers, as test/cocoa-glyph-runs.test.js has them: the list the glue
// hands a fake bridge, which runs everywhere, and the face the real bridge
// answers with, which runs where it loads.
import assert from 'node:assert';
import { describe, test } from 'node:test';

import { CocoaFontManager } from '../src/cocoa/fonts.js';
import { loadNative } from '../src/cocoa/native.js';

const GITHUB =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';

/** A bridge that remembers what it was asked to match and to list. */
function fakeNative() {
  const matched = [];
  const listed = [];
  return {
    matched,
    listed,
    matchFont(request) {
      matched.push(request);
      return { ps: `${request.families[0]}-${request.weight}` };
    },
    fontMetrics: (handle) => ({
      ascent: 11,
      descent: 3,
      leading: 0,
      familyName: '',
      postScriptName: handle.ps,
    }),
    listFonts(query) {
      listed.push(query);
      return [];
    },
  };
}

test('the web’s two names for the system font reach the bridge as system-ui', () => {
  const native = fakeNative();
  const fonts = new CocoaFontManager(native);
  fonts.match(GITHUB, { weight: 500 }).metrics(14);
  assert.deepEqual(native.matched, [
    {
      families: [
        'system-ui',
        'system-ui',
        'Segoe UI',
        'Noto Sans',
        'Helvetica',
        'Arial',
        'sans-serif',
      ],
      size: 14,
      weight: 500,
      italic: false,
    },
  ]);
});

test('in any case, quoted or not, and in a list that is already an array', () => {
  const native = fakeNative();
  const fonts = new CocoaFontManager(native);
  const families = (family) => {
    fonts.match(family).metrics(14);
    return native.matched.at(-1).families;
  };
  assert.deepEqual(families('blinkmacsystemfont'), ['system-ui']);
  assert.deepEqual(families('"-Apple-System", Arial'), ['system-ui', 'Arial']);
  assert.deepEqual(families(['BlinkMacSystemFont', 'Arial']), [
    'system-ui',
    'Arial',
  ]);
  // a family of its own, whatever it starts with
  assert.deepEqual(families('-apple-system-body'), ['-apple-system-body']);
});

test('the catalogue lists them as it lists system-ui: by the visible family', async () => {
  const native = fakeNative();
  const { source } = new CocoaFontManager(native);
  await source.matchSortedAsync({ family: 'system-ui' });
  await source.matchSortedAsync({ family: '-apple-system' });
  await source.matchSortedAsync({ family: 'BlinkMacSystemFont' });
  assert.equal(native.listed.length, 3);
  assert.deepEqual(native.listed[1], native.listed[0]);
  assert.deepEqual(native.listed[2], native.listed[0]);
});

// --- over the real bridge ---------------------------------------------------------

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
    // 500 is the weight that tells: GitHub's buttons are set in it, and SF
    // has a medium where Helvetica, the list's first installed family, does
    // not.
    for (const weight of [400, 500, 600]) {
      test(`at ${weight}, each name and GitHub's stack are the face system-ui is`, () => {
        const fonts = new CocoaFontManager(bridge);
        const system = fonts.match('system-ui', { weight }).postscriptName;
        assert.notEqual(system, '');
        for (const family of ['-apple-system', 'BlinkMacSystemFont', GITHUB]) {
          assert.equal(
            fonts.match(family, { weight }).postscriptName,
            system,
            family,
          );
        }
      });
    }
  },
);
