// The Cocoa text engine's glyph-run seams — what `<Terminal backend="vt">`
// reads (issue #432): a face from `fonts.match()` that answers `glyphIdFor`,
// `advanceOf`, `shape` and ntk's metric names; `fonts.fallbackFor`; and a
// context with `drawGlyphs`, `createSolidPicture` and `Render.PictOp`.
//
// Two layers. The first runs everywhere: the JS glue over a fake bridge —
// the grouping, the pen walk, the dy flip, the colour, the caches —
// asserted on what reaches the natives, which is the whole of what the glue
// decides. The second runs only where the real bridge loads (a Mac with
// @windowkit/appkit, or REACT_X11_CALAYERS_PATH at a built checkout) and
// pins the CoreText facts the glue relies on, ending in pixels: a glyph
// drawn through the whole stack lands upright at its baseline, in the ink
// it was given.
import assert from 'node:assert';
import { describe, test } from 'node:test';

import { CocoaContext2D } from '../src/cocoa/context2d.js';
import { CocoaFace, CocoaFontManager } from '../src/cocoa/fonts.js';
import { loadNative } from '../src/cocoa/native.js';

// --- the fake bridge ----------------------------------------------------------

/**
 * A bridge shaped like @windowkit/appkit's font and glyph natives. Handles
 * are plain objects keyed by what made them, so the same request answers
 * the same object — the property `drawGlyphs`'s grouping stands on. Glyph
 * ids are `codepoint + 1` in the base faces, so a test can tell an id from
 * the code point it came from.
 */
function fakeNative() {
  const calls = [];
  const handles = new Map();
  const handleFor = (key, props) => {
    let h = handles.get(key);
    if (!h) {
      h = { key, ...props };
      handles.set(key, h);
    }
    return h;
  };
  const emojiAt = (size) =>
    handleFor(`AppleColorEmoji@${size}`, {
      ps: 'AppleColorEmoji',
      family: 'Emoji',
      size,
    });
  const native = {
    calls,
    matchFont({ families, size, weight, italic }) {
      const family = families[0];
      return handleFor(`${family}|${weight}|${italic}|${size}`, {
        ps: `${family}-${weight}${italic ? 'Italic' : ''}`,
        family,
        size,
      });
    },
    fontMetrics(h) {
      return {
        ascent: h.size * 0.8,
        descent: h.size * 0.2,
        leading: h.size * 0.1,
        capHeight: h.size * 0.7,
        xHeight: h.size * 0.5,
        size: h.size,
        familyName: h.family,
        postScriptName: h.ps,
      };
    },
    fontHasGlyph(h, text) {
      return native.fontGlyphForCodepoint(h, text.codePointAt(0)) !== null;
    },
    fontGlyphForCodepoint(h, cp) {
      if (h.family === 'Emoji') return cp >= 0x1f000 ? cp - 0x1f000 + 1 : null;
      if (h.family === 'Fallback') return cp >= 0x80 && cp < 0x3000 ? cp : null;
      if (h.family === 'Loaded') return cp === 0x2500 ? 7 : null;
      return cp < 0x80 ? cp + 1 : null;
    },
    fontGlyphAdvances(h, glyphs) {
      return Float64Array.from(glyphs, () => h.size * 0.6);
    },
    fontWithSize(h, size) {
      return handleFor(`${h.ps}@${size}`, { ps: h.ps, family: h.family, size });
    },
    fontFallbackFor(h, text) {
      const cp = text.codePointAt(0);
      if (cp < 0x80) return h; // the base covers it
      if (cp >= 0x1f000) return emojiAt(h.size);
      if (cp < 0x3000) {
        return handleFor(`Fallback@${h.size}`, {
          ps: 'Fallback-Regular',
          family: 'Fallback',
          size: h.size,
        });
      }
      return null;
    },
    fontShapeText(h, text) {
      if (text === 'é') {
        // a base and a mark: the mark sits back over the base, raised
        return {
          width: 8,
          runs: [
            {
              font: null,
              glyphs: Uint16Array.from([0x66, 0x302]),
              positions: Float64Array.from([0, 0, 6, 2]),
              advances: Float64Array.from([8, 0]),
            },
          ],
        };
      }
      if (text === '☺️') {
        // CoreText substituted the emoji face for the whole cluster
        return {
          width: 16,
          runs: [
            {
              font: emojiAt(h.size),
              glyphs: Uint16Array.from([77]),
              positions: Float64Array.from([0, 0]),
              advances: Float64Array.from([16]),
            },
          ],
        };
      }
      const cps = [...text].map((ch) => ch.codePointAt(0));
      return {
        width: cps.length * 8,
        runs: [
          {
            font: null,
            glyphs: Uint16Array.from(cps, (cp) => cp + 1),
            positions: Float64Array.from(cps.flatMap((_, i) => [i * 8, 0])),
            advances: Float64Array.from(cps, () => 8),
          },
        ],
      };
    },
    fontFromData() {
      return {
        cg: { name: 'Loaded' },
        familyName: 'Loaded',
        postScriptName: 'Loaded-Regular',
        weight: 400,
        italic: false,
      };
    },
    cgFontWithSize(cg, size) {
      return handleFor(`cg:${cg.name}@${size}`, {
        ps: `${cg.name}-Regular`,
        family: cg.name,
        size,
      });
    },
    fontByPostScriptName(name, size) {
      if (name !== 'KaTeX_Main-Regular') return null;
      return handleFor(`ps:${name}@${size}`, {
        ps: name,
        family: 'KaTeX_Main',
        size,
      });
    },
    ctxSetFillColor(surface, r, g, b, a) {
      calls.push(['fill', r, g, b, a]);
    },
    ctxDrawGlyphs(surface, runs, replace) {
      calls.push([
        'draw',
        runs.map((run) => ({
          font: run.font,
          glyphs: [...run.glyphs],
          positions: [...run.positions],
        })),
        replace,
      ]);
    },
  };
  // every other ctx verb the context syncs on a fresh surface is a no-op
  return new Proxy(native, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

function context(native) {
  const surface = { fake: true };
  const ctx = new CocoaContext2D(
    native,
    () => surface,
    () => 1,
  );
  ctx._fonts = new CocoaFontManager(native);
  let dirty = 0;
  ctx._onDirty = () => dirty++;
  return { ctx, fonts: ctx._fonts, dirty: () => dirty };
}

const glyph = (id, ax, dx = 0, dy = 0) => ({ id, ax, dx, dy });

// --- the face -----------------------------------------------------------------

test('a matched face answers ntk seams: glyph ids, advances at a size, both metric vocabularies', () => {
  const fonts = new CocoaFontManager(fakeNative());
  const face = fonts.match('Menlo', { weight: 400 });
  assert.ok(face instanceof CocoaFace);
  assert.strictEqual(fonts.match('Menlo', { weight: 400 }), face, 'cached');
  assert.equal(face.glyphIdFor(0x30), 0x31);
  assert.equal(face.glyphIdFor(0x2500), null, 'uncovered is null, not 0');
  assert.equal(face.glyphIdFor('0'), null, 'a code point, not a string');
  // hasGlyph in both forms it has been asked in
  assert.equal(face.hasGlyph(0x41), true);
  assert.equal(face.hasGlyph(0x2500), false);
  assert.equal(face.hasGlyph('A'), true);
  // the advance is read off the handle AT that size — 16 * 0.6 in the fake
  assert.equal(face.advanceOf(0x31, 16), 9.6);
  assert.equal(face.advanceOf(0x31, 10), 6);
  const m = face.metrics(20);
  assert.equal(m.ascent, 16);
  assert.equal(m.descent, 4);
  assert.equal(m.leading, 2, "CoreText's name stays");
  assert.equal(m.lineGap, 2, "ntk's name for the same gap");
  assert.equal(m.lineHeight, 22, 'ascent + descent + gap, finite');
  assert.equal(m.capHeight, 14);
  assert.equal(face.familyName, 'Menlo');
  assert.equal(face.postscriptName, 'Menlo-400');
});

test('shape walks the pen: ax from the advances, dx/dy from the positions, y up', () => {
  const fonts = new CocoaFontManager(fakeNative());
  const face = fonts.match('Menlo');
  const shaped = face.shape('é', 14);
  assert.strictEqual(shaped.font, face);
  assert.equal(shaped.size, 14);
  assert.equal(shaped.width, 8);
  assert.deepEqual(shaped.glyphs, [glyph(0x66, 8), glyph(0x302, 0, -2, 2)]);
  const plain = face.shape('Hi', 14).glyphs;
  assert.deepEqual(plain, [glyph(0x49, 8), glyph(0x6a, 8)]);
});

test('a run CoreText substituted carries its face on the glyph, and it is the fallback face', () => {
  const fonts = new CocoaFontManager(fakeNative());
  const face = fonts.match('Menlo');
  const shaped = face.shape('☺️', 14);
  assert.strictEqual(shaped.font, face, 'the result is still this face');
  assert.equal(shaped.glyphs.length, 1);
  const emoji = shaped.glyphs[0].font;
  assert.ok(emoji instanceof CocoaFace);
  assert.equal(emoji.postscriptName, 'AppleColorEmoji');
  assert.equal(emoji.glyphIdFor(0x1f600), 0x601);
  // one object per PostScript name, whichever route found it
  assert.strictEqual(fonts.fallbackFor(0x1f600, 'Menlo'), emoji);
  // and it answers at every size through fontWithSize
  assert.equal(emoji.advanceOf(1, 20), 12);
  assert.equal(emoji.metrics(10).lineHeight, 11);
});

test('fallbackFor: the base for what it covers, a cascade face otherwise, null when nothing does, cached', () => {
  const fonts = new CocoaFontManager(fakeNative());
  const base = fonts.match('Menlo', { weight: 700, style: 'italic' });
  const opts = { weight: 'bold', style: 'italic' };
  assert.strictEqual(fonts.fallbackFor(0x41, 'Menlo', opts), base);
  const box = fonts.fallbackFor(0x2500, 'Menlo', opts);
  assert.ok(box instanceof CocoaFace);
  assert.notStrictEqual(box, base);
  assert.equal(box.familyName, 'Fallback');
  assert.equal(box.glyphIdFor(0x2500), 0x2500);
  assert.strictEqual(fonts.fallbackFor(0x2500, 'Menlo', opts), box, 'cached');
  assert.equal(fonts.fallbackFor(0x3000, 'Menlo', opts), null);
  assert.equal(fonts.fallbackFor(0xd800, 'Menlo', opts), null, 'not a scalar');
  assert.equal(fonts.fallbackFor(Number.NaN, 'Menlo', opts), null);
  // a string is tolerated: its first code point
  assert.strictEqual(fonts.fallbackFor('─', 'Menlo', opts), box);
});

test('a face the app loaded is consulted before the cascade', () => {
  const fonts = new CocoaFontManager(fakeNative());
  fonts.load(Buffer.from([0, 1, 0, 0, 0, 0]));
  const loaded = fonts.fallbackFor(0x2500, 'Menlo');
  assert.ok(loaded instanceof CocoaFace);
  assert.equal(loaded.familyName, 'Loaded');
  assert.equal(loaded.key, 'registered:Loaded-Regular');
  assert.equal(loaded.glyphIdFor(0x2500), 7);
  assert.strictEqual(fonts.fallbackFor(0x2500, 'Menlo'), loaded);
  // what the loaded face lacks still goes to the cascade
  assert.equal(fonts.fallbackFor(0x2501, 'Menlo').familyName, 'Fallback');
});

// --- the context --------------------------------------------------------------

test('Render.PictOp and createSolidPicture are there, in XRender numbering', () => {
  const { ctx } = context(fakeNative());
  assert.equal(ctx.Render.PictOp.Over, 3);
  assert.equal(ctx.Render.PictOp.Src, 1);
  assert.equal(typeof ctx.createSolidPicture, 'function');
  assert.equal(typeof ctx.drawGlyphs, 'function');
  assert.ok(ctx.createSolidPicture(1, 0, 0, 1));
});

test('drawGlyphs groups by face and size, walks the pen, flips dy, and sets the ink once', () => {
  const native = fakeNative();
  const { ctx, fonts, dirty } = context(native);
  const menlo = fonts.match('Menlo');
  const run = {
    font: menlo,
    size: 14,
    glyphs: [glyph(1, 8), glyph(2, 8, 1, 2), glyph(3, 8)],
  };
  const other = { font: menlo, size: 20, glyphs: [glyph(4, 12)] };
  // premultiplied half-alpha red in, straight red at half alpha out
  const src = ctx.createSolidPicture(0.5, 0, 0, 0.5);
  ctx.drawGlyphs(ctx.Render.PictOp.Over, src, [
    { run, x: 10, y: 20 },
    { run: other, x: 100, y: 50 },
    { run, x: 30, y: 40 },
  ]);
  assert.equal(native.calls.length, 2);
  assert.deepEqual(native.calls[0], ['fill', 1, 0, 0, 0.5]);
  const [, runs, replace] = native.calls[1];
  assert.equal(replace, false);
  assert.equal(runs.length, 2, 'one native run per (face, size)');
  const at14 = runs.find((r) => r.font.size === 14);
  const at20 = runs.find((r) => r.font.size === 20);
  assert.equal(at14.font.family, 'Menlo');
  assert.deepEqual(at14.glyphs, [1, 2, 3, 1, 2, 3]);
  // pen: x, x + 8, x + 16; the second glyph offset by (dx 1, dy 2 up)
  assert.deepEqual(
    at14.positions,
    [10, 20, 19, 18, 26, 20, 30, 40, 39, 38, 46, 40],
  );
  assert.deepEqual(at20.glyphs, [4]);
  assert.deepEqual(at20.positions, [100, 50]);
  assert.equal(dirty(), 1);
});

test('a glyph with a face of its own draws with that face; a run nobody can resolve is skipped', () => {
  const native = fakeNative();
  const { ctx, fonts } = context(native);
  const menlo = fonts.match('Menlo');
  const emoji = fonts.fallbackFor(0x1f600, 'Menlo');
  const cluster = {
    font: menlo,
    size: 14,
    glyphs: [glyph(1, 8), { ...glyph(77, 16), font: emoji }, glyph(2, 8)],
  };
  ctx.drawGlyphs(3, ctx.createSolidPicture(1, 1, 1, 1), [
    { run: cluster, x: 0, y: 10 },
    {
      run: { font: { not: 'a face' }, size: 14, glyphs: [glyph(9, 8)] },
      x: 0,
      y: 0,
    },
    { run: { font: menlo, size: 14, glyphs: [] }, x: 0, y: 0 },
  ]);
  const [, runs] = native.calls[1];
  assert.equal(runs.length, 2);
  const base = runs.find((r) => r.font.family === 'Menlo');
  const sub = runs.find((r) => r.font.family === 'Emoji');
  assert.deepEqual(base.glyphs, [1, 2]);
  assert.deepEqual(
    base.positions,
    [0, 10, 24, 10],
    'the pen advanced past the emoji',
  );
  assert.deepEqual(sub.glyphs, [77]);
  assert.deepEqual(sub.positions, [8, 10]);
  assert.equal(sub.font.size, 14, "the substitute at the run's size");
});

test('Src replaces, anything else composites; nothing to draw is no call at all', () => {
  const native = fakeNative();
  const { ctx, fonts, dirty } = context(native);
  const run = { font: fonts.match('Menlo'), size: 14, glyphs: [glyph(1, 8)] };
  ctx.drawGlyphs(ctx.Render.PictOp.Src, ctx.createSolidPicture(0, 0, 0, 1), [
    { run, x: 0, y: 0 },
  ]);
  assert.equal(native.calls[1][2], true);
  ctx.drawGlyphs(12, ctx.createSolidPicture(0, 0, 0, 1), [{ run, x: 0, y: 0 }]);
  assert.equal(native.calls[3][2], false);
  const before = native.calls.length;
  ctx.drawGlyphs(3, ctx.createSolidPicture(0, 0, 0, 1), []);
  ctx.drawGlyphs(3, ctx.createSolidPicture(0, 0, 0, 1), undefined);
  assert.equal(native.calls.length, before);
  assert.equal(dirty(), 2);
});

test('the source may be a CSS colour, a straight array, or the fill style in force', () => {
  const native = fakeNative();
  const { ctx, fonts } = context(native);
  const run = { font: fonts.match('Menlo'), size: 14, glyphs: [glyph(1, 8)] };
  ctx.drawGlyphs(3, '#00ff00', [{ run, x: 0, y: 0 }]);
  assert.deepEqual(native.calls[0], ['fill', 0, 1, 0, 1]);
  ctx.drawGlyphs(3, [0, 0, 1, 0.5], [{ run, x: 0, y: 0 }]);
  assert.deepEqual(native.calls[2], ['fill', 0, 0, 1, 0.5]);
  ctx.fillStyle = 'rgba(255, 0, 0, 0.25)';
  ctx.drawGlyphs(3, null, [{ run, x: 0, y: 0 }]);
  assert.deepEqual(native.calls[4], ['fill', 1, 0, 0, 0.25]);
});

test("an ntk Font as run.font resolves to CoreText by its PostScript name, so openFont()'s glyph ids hold", () => {
  const native = fakeNative();
  const { ctx } = context(native);
  const katex = { key: 'katex-main', postscriptName: 'KaTeX_Main-Regular' };
  ctx.drawGlyphs(3, ctx.createSolidPicture(0, 0, 0, 1), [
    { run: { font: katex, size: 18, glyphs: [glyph(40, 9)] }, x: 5, y: 5 },
  ]);
  const [, runs] = native.calls[1];
  assert.equal(runs.length, 1);
  assert.equal(runs[0].font.ps, 'KaTeX_Main-Regular');
  assert.equal(runs[0].font.size, 18);
  assert.deepEqual(runs[0].glyphs, [40]);
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
    const redRows = (px, width, height) => {
      const rows = new Set();
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (px[i] > 128 && px[i + 1] < 64) rows.add(y);
        }
      }
      return [...rows].sort((a, b) => a - b);
    };

    test('Menlo: a glyph id, its advance, and a line height that is finite', () => {
      const fonts = new CocoaFontManager(bridge);
      const menlo = fonts.match('Menlo');
      const zero = menlo.glyphIdFor(0x30);
      assert.ok(Number.isInteger(zero) && zero > 0);
      assert.equal(menlo.hasGlyph(0x30), true);
      assert.equal(menlo.glyphIdFor(0x1f600), null, 'no emoji in Menlo');
      const advance = menlo.advanceOf(zero, 14);
      assert.ok(advance > 7 && advance < 10, `Menlo 14 advance ${advance}`);
      const m = menlo.metrics(14);
      assert.ok(Number.isFinite(m.lineHeight));
      assert.equal(m.lineHeight, m.ascent + m.descent + m.leading);
      assert.equal(m.lineGap, m.leading);
      assert.equal(menlo.familyName, 'Menlo');
    });

    test('fallbackFor: emoji to Apple Color Emoji, a noncharacter to null, the base for what it covers', () => {
      const fonts = new CocoaFontManager(bridge);
      const menlo = fonts.match('Menlo');
      const emoji = fonts.fallbackFor(0x1f600, 'Menlo');
      assert.ok(emoji instanceof CocoaFace);
      assert.equal(emoji.familyName, 'Apple Color Emoji');
      assert.ok(emoji.glyphIdFor(0x1f600) > 0);
      assert.ok(emoji.advanceOf(emoji.glyphIdFor(0x1f600), 14) > 0);
      assert.strictEqual(fonts.fallbackFor(0x30, 'Menlo'), menlo);
      assert.equal(fonts.fallbackFor(0xffff, 'Menlo'), null);
    });

    test('shape: a cluster comes back positioned, a substituted one carrying its face', () => {
      const fonts = new CocoaFontManager(bridge);
      const menlo = fonts.match('Menlo');
      const accented = menlo.shape('é', 14);
      assert.ok(accented.glyphs.length >= 1);
      assert.ok(accented.width > 0);
      for (const g of accented.glyphs) {
        assert.ok(Number.isInteger(g.id));
        assert.ok(Number.isFinite(g.ax + g.dx + g.dy));
      }
      const smiley = menlo.shape('☺️', 14);
      assert.ok(smiley.glyphs.length >= 1);
      assert.ok(
        smiley.glyphs[0].font instanceof CocoaFace,
        'CoreText substituted a face',
      );
      assert.equal(smiley.glyphs[0].font.familyName, 'Apple Color Emoji');
    });

    test('drawGlyphs puts an H upright between the cap line and its baseline, in the ink asked for', () => {
      const surface = bridge.createSurface(64, 32, 1);
      const ctx = new CocoaContext2D(
        bridge,
        () => surface,
        () => 1,
      );
      const fonts = new CocoaFontManager(bridge);
      ctx._fonts = fonts;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 64, 32);
      const menlo = fonts.match('Menlo');
      const h = menlo.glyphIdFor(0x48);
      const run = { font: menlo, size: 20, glyphs: [glyph(h, 12)] };
      ctx.drawGlyphs(
        ctx.Render.PictOp.Over,
        ctx.createSolidPicture(1, 0, 0, 1),
        [{ run, x: 4, y: 24 }],
      );
      const rows = redRows(
        bridge.ctxGetImageData(surface, 0, 0, 64, 32),
        64,
        32,
      );
      assert.ok(rows.length > 0, 'ink');
      const capHeight = menlo.metrics(20).capHeight;
      // the top of the H is a cap height above the baseline; nothing below it
      assert.ok(
        Math.abs(rows[0] - (24 - capHeight)) <= 1.5,
        `top row ${rows[0]}`,
      );
      assert.equal(
        rows[rows.length - 1],
        23,
        'the last inked row is just above the baseline',
      );
      // and the fill style the context carries was not disturbed for the next painter
      ctx.fillStyle = '#0f0';
      ctx.fillRect(0, 0, 2, 2);
      const px = bridge.ctxGetImageData(surface, 0, 0, 1, 1);
      assert.deepEqual([...px].slice(0, 3), [0, 255, 0]);
    });

    test('Src replaces where Over composites', () => {
      const fonts = new CocoaFontManager(bridge);
      const menlo = fonts.match('Menlo');
      const run = {
        font: menlo,
        size: 20,
        glyphs: [glyph(menlo.glyphIdFor(0x48), 12)],
      };
      const stem = (op) => {
        const surface = bridge.createSurface(32, 32, 1);
        const ctx = new CocoaContext2D(
          bridge,
          () => surface,
          () => 1,
        );
        ctx._fonts = fonts;
        ctx.fillStyle = '#f00';
        ctx.fillRect(0, 0, 32, 32);
        ctx.drawGlyphs(op, ctx.createSolidPicture(0.5, 0.5, 0.5, 0.5), [
          { run, x: 4, y: 24 },
        ]);
        // the left stem of the H, mid-height
        return [...bridge.ctxGetImageData(surface, 6, 16, 1, 1)];
      };
      assert.deepEqual(stem(3), [255, 128, 128, 255]);
      assert.deepEqual(stem(1), [255, 255, 255, 128]);
    });
  },
);
