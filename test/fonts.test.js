// `openFont` / `loadFont` / `useFont` — a font file, opened by the app.
//
// The subject is the seam rather than the parsing: fontkit reads the file and
// ntk caches it, and what is tested here is the three decisions react-x11
// makes on top (issue #346).
//
//   1. **Opening registers nothing.** The distinction is invisible in
//      `match()` alone — a registered face only shadows a family somebody
//      asked for — so the assertion that carries it is the *fallback* chain,
//      which every registered font joins for every codepoint the current
//      face is missing.
//   2. **One cache.** A second `Font` for one file is a second glyph atlas,
//      so the test is object identity across both verbs, not a re-read that
//      happens to be fast.
//   3. **The family comes off the file** — the name a caller no longer has
//      to invent — with the tie broken only where a face would otherwise be
//      unreachable.
//
// The faces are KaTeX's, from devDependencies, so the names and weights are
// the same on every machine; fontconfig is the thing being replaced here and
// cannot also be the fixture. `KaTeX_Main` ships as Regular/Bold/Italic,
// which is a *family* rather than a collision, and that is the pair the
// scoping rule has to tell apart.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, describe, afterEach } from 'node:test';
import React from 'react';

import { FontManager, StaticFontSource } from 'ntk';

import { loadFont, openFont } from '../src/fonts.js';
import { useFont } from '../src/fonthooks.js';
import { cleanup, renderX11 } from '../src/testing/index.js';

const require = createRequire(import.meta.url);
const katex = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);
const MAIN = join(katex, 'KaTeX_Main-Regular.ttf');
const BOLD = join(katex, 'KaTeX_Main-Bold.ttf');
const AMS = join(katex, 'KaTeX_AMS-Regular.ttf');
// the system face for these tests: KaTeX's brackets, which have no letters
const SYSTEM = join(katex, 'KaTeX_Size1-Regular.ttf');
const VF = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'MonelogicsSubset[wght].ttf',
);

/** 'a' — in KaTeX_Main, and in none of the faces the system source has. */
const LETTER = 0x61;

/**
 * An app is only `app.fonts` as far as these two functions are concerned, so
 * this is the whole of one: a manager over a source holding a single face
 * that covers no letters, which makes "did this file join the fallback
 * chain?" a question with a yes/no answer.
 */
function fontApp() {
  const source = new StaticFontSource();
  source.add(readFileSync(SYSTEM), { family: 'System' });
  source.alias('sans-serif', 'system');
  return { fonts: new FontManager({ source }) };
}

const ps = (font) => font?.postscriptName ?? null;

// ---------------------------------------------------------------------------
// openFont — reading a file
// ---------------------------------------------------------------------------

describe('openFont', () => {
  test('answers what a picker asks a font file', () => {
    const app = fontApp();
    const font = openFont(app, VF);

    assert.equal(font.familyName, 'monelogics Thin');
    assert.equal(font.variationAxes.wght.min, 100);
    assert.equal(font.variationAxes.wght.max, 900);
    assert.ok(font.hasGlyph(LETTER), 'the face has letters');
    // metrics are the numbers the renderer lays out with, scaled to a size
    const metrics = font.metrics(30);
    assert.ok(
      metrics.ascent > 0 && metrics.lineHeight > metrics.ascent,
      JSON.stringify(metrics),
    );
  });

  test('reads the file once, however often it is opened', () => {
    const app = fontApp();
    const first = openFont(app, MAIN);
    assert.strictEqual(openFont(app, MAIN), first, 'a second open re-reads');
    // and the load path lands on the same face rather than parsing again —
    // two Fonts for one file is two glyph atlases on the wire
    assert.strictEqual(loadFont(app, MAIN).font, first);
  });

  test('a second connection opens its own', () => {
    const a = fontApp();
    const b = fontApp();
    assert.notStrictEqual(openFont(a, MAIN), openFont(b, MAIN));
  });

  test('changes nothing about the app', () => {
    const app = fontApp();
    // the family the file calls itself resolves to the system face...
    assert.equal(ps(app.fonts.match('KaTeX_Main')), 'KaTeX_Size1-Regular');
    // ...and nothing covers a letter
    assert.equal(app.fonts.fallbackFor(LETTER, 'sans-serif'), null);

    openFont(app, MAIN);

    assert.equal(
      ps(app.fonts.match('KaTeX_Main')),
      'KaTeX_Size1-Regular',
      'opening a file must not make it a candidate for its own name',
    );
    assert.equal(
      app.fonts.fallbackFor(LETTER, 'sans-serif'),
      null,
      'nor put it in the fallback chain — a font browser would otherwise ' +
        'change the glyphs its own UI borrows',
    );
  });

  test('says which argument is missing when there is no connection', () => {
    assert.throws(() => openFont({}, MAIN), /app\.fonts/);
    assert.throws(() => loadFont(null, MAIN), /loadFont\(app/);
  });

  test('a file that is not there throws where it was asked for', () => {
    const app = fontApp();
    assert.throws(() => openFont(app, join(katex, 'NoSuchFont.ttf')));
  });
});

// ---------------------------------------------------------------------------
// loadFont — registering one
// ---------------------------------------------------------------------------

describe('loadFont', () => {
  test('hands back the family name it registered, read off the file', () => {
    const app = fontApp();
    const { font, family } = loadFont(app, MAIN);

    assert.equal(family, 'KaTeX_Main');
    assert.strictEqual(app.fonts.match(family), font);
    assert.strictEqual(
      app.fonts.fallbackFor(LETTER, 'sans-serif'),
      font,
      'a registered face is in the fallback chain, which is what openFont ' +
        'deliberately is not',
    );
  });

  test('several faces of one family keep that family', () => {
    const app = fontApp();
    const regular = loadFont(app, MAIN);
    const bold = loadFont(app, BOLD);

    assert.equal(bold.family, 'KaTeX_Main', 'a bold face is not a collision');
    assert.strictEqual(
      app.fonts.match('KaTeX_Main', { weight: 700 }),
      bold.font,
    );
    assert.strictEqual(
      app.fonts.match('KaTeX_Main', { weight: 400 }),
      regular.font,
    );
  });

  test('a second file that would be unreachable is scoped', () => {
    const app = fontApp();
    const first = loadFont(app, MAIN);
    // the same face arriving as bytes: a different file as far as anything
    // here can tell, at the same weight and slant, so the name is taken
    const second = loadFont(app, readFileSync(MAIN));

    assert.equal(second.family, 'KaTeX_Main 2');
    assert.notStrictEqual(second.font, first.font);
    assert.strictEqual(app.fonts.match('KaTeX_Main 2'), second.font);
    assert.strictEqual(
      app.fonts.match('KaTeX_Main'),
      first.font,
      'and the first file keeps the name it was given',
    );
  });

  test('loading the same file again registers nothing new', () => {
    const app = fontApp();
    const first = loadFont(app, MAIN);
    const again = loadFont(app, MAIN);

    assert.strictEqual(again, first);
    assert.equal(again.family, 'KaTeX_Main', 'not scoped against itself');
  });

  test('a family the caller names is used verbatim', () => {
    const app = fontApp();
    const { font, family } = loadFont(app, AMS, { family: 'preview' });

    assert.equal(family, 'preview');
    assert.strictEqual(app.fonts.match('preview'), font);
    // and it holds the name against a file that would have derived it
    const other = loadFont(app, MAIN, { family: 'preview' });
    assert.equal(other.family, 'preview');
  });

  test('weight the file does not claim can be declared for it', () => {
    const app = fontApp();
    const { font } = loadFont(app, MAIN, { weight: 900 });
    assert.strictEqual(app.fonts.match('KaTeX_Main', { weight: 900 }), font);
  });
});

// ---------------------------------------------------------------------------
// useFont — the same thing from a component
// ---------------------------------------------------------------------------

describe('useFont', () => {
  afterEach(cleanup);

  test('registers the file and re-uses it across renders', async () => {
    const seen = [];
    function Specimen({ sample }) {
      const picked = useFont(MAIN);
      seen.push(picked);
      return React.createElement(
        'text',
        { style: { fontFamily: picked.family, fontSize: 20 } },
        sample,
      );
    }

    const { app, rerender } = await renderX11(
      React.createElement(Specimen, { sample: 'Handgloves' }),
      { fonts: { 'sans-serif': SYSTEM } },
    );

    assert.equal(seen[0].family, 'KaTeX_Main');
    assert.strictEqual(app.fonts.match('KaTeX_Main'), seen[0].font);

    await rerender(React.createElement(Specimen, { sample: 'Hamburgefons' }));

    assert.ok(seen.length > 1, 'the component re-rendered');
    assert.strictEqual(
      seen.at(-1),
      seen[0],
      'a re-render must not re-read the file or register it a second time',
    );
  });

  test('a font nobody has picked yet is null, not a branch', async () => {
    let picked = 'unset';
    function Picker() {
      picked = useFont(null);
      return React.createElement('box');
    }
    await renderX11(React.createElement(Picker), {
      fonts: { 'sans-serif': SYSTEM },
    });
    assert.equal(picked, null);
  });
});
