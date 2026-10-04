// The Windows text engine's JS half, against a fake bridge. What matters here
// is not DirectWrite — that is the bridge's — but the two translations this
// file owns: a list of styled spans becoming formatting ranges over one
// string, and the code-unit/code-point boundary.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Win32FontManager } from '../../src/win32/fonts.js';
import { createFakeBridge } from './fake-bridge.js';

const manager = () => new Win32FontManager(createFakeBridge());

describe('win32 fonts: spans', () => {
  it('joins spans into one string with ranges over it', () => {
    const bridge = createFakeBridge();
    const fonts = new Win32FontManager(bridge);
    fonts.layout(
      [
        { text: 'Hello, ', size: 24 },
        { text: 'X11', size: 24, color: '#ff0000' },
        { text: '!', size: 24 },
      ],
      { size: 24 },
    );

    const [, text, , spans] = bridge.calls.find((c) => c[0] === 'layoutCreate');
    assert.equal(text, 'Hello, X11!');
    // One layout, not three: this is what makes line breaking work *across*
    // <text> chunks rather than per chunk.
    assert.equal(spans.length, 3);
    assert.deepEqual(
      spans.map((s) => [s.start, s.length]),
      [
        [0, 7],
        [7, 3],
        [10, 1],
      ],
    );
    assert.equal(spans[1].r, 1, 'the coloured span lost its ink');
    assert.equal(spans[1].g, 0);
  });

  it("speaks the span vocabulary, which is ntk's and not CSS's", () => {
    // `collectSpans` and `resolvedTextStyle` in nodes/text.js produce
    // `family`/`size`/`weight`/`style`, not `fontFamily`/`fontSize`/… Reading
    // the CSS names instead is silent: every paragraph falls through to the
    // default size, so the whole app renders at one size whatever it asked
    // for — and on a scaled display that reads as the scale never having
    // reached the text engine, which is a different bug entirely.
    const bridge = createFakeBridge();
    new Win32FontManager(bridge).layout(
      [{ text: 'big', size: 36, weight: 700 }],
      { size: 36, weight: 700 },
    );
    const [, , options, spans] = bridge.calls.find(
      (c) => c[0] === 'layoutCreate',
    );
    assert.equal(spans[0].size, 36, 'the span size never reached the bridge');
    assert.equal(options.size, 36, 'the base size never reached the bridge');
    assert.equal(spans[0].weight, 700);
  });

  it('hands on letter spacing and OpenType features, the ligatures off under spacing', () => {
    // dropped, a `letter-spacing` was set tight on Windows, and <Html>,
    // which justifies through letter spacing on an engine that cannot,
    // laid a justified line's words over each other
    const bridge = createFakeBridge();
    new Win32FontManager(bridge).layout(
      [
        { text: 'spaced', letterSpacing: 2 },
        { text: 'caps', features: { smcp: 1 } },
        { text: 'both', letterSpacing: 1, features: { liga: 1, onum: 1 } },
        { text: 'plain' },
      ],
      {},
    );
    const [, , , spans] = bridge.calls.find((c) => c[0] === 'layoutCreate');
    assert.equal(spans[0].letterSpacing, 2);
    assert.deepEqual(spans[0].features, { liga: 0, clig: 0, dlig: 0, hlig: 0 });
    assert.equal(spans[1].letterSpacing, undefined);
    assert.deepEqual(spans[1].features, { smcp: 1 });
    assert.deepEqual(spans[2].features, {
      liga: 1,
      clig: 0,
      dlig: 0,
      hlig: 0,
      onum: 1,
    });
    assert.equal(spans[3].letterSpacing, undefined);
    assert.equal(spans[3].features, undefined);
  });

  it('falls back to 14 only when no size was given at all', () => {
    const bridge = createFakeBridge();
    new Win32FontManager(bridge).layout([{ text: 'x' }], {});
    const [, , options] = bridge.calls.find((c) => c[0] === 'layoutCreate');
    assert.equal(options.size, 14);
  });

  it('takes a bare string as one span', () => {
    const bridge = createFakeBridge();
    new Win32FontManager(bridge).layout('plain', { size: 12 });
    const [, text] = bridge.calls.find((c) => c[0] === 'layoutCreate');
    assert.equal(text, 'plain');
  });

  it('skips empty spans, which would otherwise be zero-length ranges', () => {
    const bridge = createFakeBridge();
    new Win32FontManager(bridge).layout(
      [{ text: 'a' }, { text: '' }, { text: 'b' }],
      {},
    );
    const [, text, , spans] = bridge.calls.find((c) => c[0] === 'layoutCreate');
    assert.equal(text, 'ab');
    assert.equal(spans.length, 2);
  });
});

describe('win32 fonts: families', () => {
  it('passes a generic family through for the bridge to resolve', () => {
    const bridge = createFakeBridge();
    new Win32FontManager(bridge).layout('x', { family: 'sans-serif' });
    const [, , options] = bridge.calls.find((c) => c[0] === 'layoutCreate');
    assert.equal(options.family, 'sans-serif');
  });

  it('takes the first family in a stack that this machine actually has', () => {
    const bridge = createFakeBridge(); // knows Segoe UI and Consolas only
    new Win32FontManager(bridge).layout('x', {
      family: '"Not Installed", Consolas, sans-serif',
    });
    const [, , options] = bridge.calls.find((c) => c[0] === 'layoutCreate');
    assert.equal(options.family, 'Consolas');
  });

  it('falls back to sans-serif when a stack names nothing installed', () => {
    const bridge = createFakeBridge();
    new Win32FontManager(bridge).layout('x', { family: 'Nope, Also Nope' });
    const [, , options] = bridge.calls.find((c) => c[0] === 'layoutCreate');
    assert.equal(options.family, 'sans-serif');
  });

  it('turns a named weight into a number, which is what DirectWrite takes', () => {
    const bridge = createFakeBridge();
    new Win32FontManager(bridge).layout('x', { weight: 'bold' });
    const [, , options] = bridge.calls.find((c) => c[0] === 'layoutCreate');
    assert.equal(options.weight, 700);
  });

  it("reaches a face DirectWrite files under another family, at that face's weight and width", () => {
    // "Segoe UI Black" is no family to DirectWrite, which groups faces by
    // weight, width and slope: it is Segoe UI at 900, and a page that named
    // it fell back to the default face. Blink sets it at its own weight
    // whatever the request's.
    const bridge = createFakeBridge();
    const fonts = new Win32FontManager(bridge);
    fonts.layout([{ text: 'x', family: 'Consolas Narrow' }], {
      family: '"Segoe UI Black", sans-serif',
      weight: 400,
    });
    const [, , options, spans] = bridge.calls.find(
      (c) => c[0] === 'layoutCreate',
    );
    assert.equal(options.family, 'Segoe UI');
    assert.equal(options.weight, 900);
    assert.equal(spans[0].family, 'Consolas');
    assert.equal(spans[0].stretch, 3, 'the narrow face, by its width');
    const light = fonts.match('Segoe UI Light', { weight: 700 });
    assert.equal(light.family, 'Segoe UI');
    assert.equal(light.weight, 300);
    assert.equal(
      fonts.match('Segoe UI Light', { style: 'italic' }).italic,
      true,
      "the request's slope is kept",
    );
  });

  it("tries Blink's alternate name where the one asked for is missing", () => {
    // Windows has Courier only as a bitmap font DirectWrite does not read,
    // and no Times: Chrome sets each in its Microsoft counterpart
    const bridge = createFakeBridge();
    new Win32FontManager(bridge).layout('x', { family: 'Times, serif' });
    const [, , options] = bridge.calls.find((c) => c[0] === 'layoutCreate');
    assert.equal(options.family, 'Times New Roman');
  });

  it('asks a face at its width, for its metrics and its glyphs', () => {
    const bridge = createFakeBridge();
    const asked = [];
    bridge.fontMetrics = (...args) => {
      asked.push(['metrics', args[4]]);
      return { ascent: 8, descent: 2, lineGap: 0 };
    };
    bridge.fontHandle = (...args) => {
      asked.push(['handle', args[4]]);
      return 1;
    };
    const face = new Win32FontManager(bridge).match('Consolas Narrow');
    face.metrics(10);
    face._handle(10);
    assert.deepEqual(asked, [
      ['metrics', 3],
      ['handle', 3],
    ]);
  });
});

describe('win32 fonts: what is asked of DirectWrite once', () => {
  it("a face states ntk's lineHeight beside DirectWrite's names", () => {
    // read off the field, <Html>'s `line-height: normal` was NaN, and every
    // document with one came up blank
    const m = manager().match('sans-serif').metrics(20);
    assert.equal(m.lineHeight, m.ascent + m.descent + m.lineGap);
  });

  it('a face asks for its metrics at a size once', () => {
    // A trimmed `<text>` asks on every placement of its layout, and each
    // answer was DirectWrite resolving the family again — on a graph of
    // widget cards, every body on every step of a drag.
    const bridge = createFakeBridge();
    let asked = 0;
    const metrics = bridge.fontMetrics;
    bridge.fontMetrics = (...args) => {
      asked++;
      return metrics(...args);
    };
    const face = new Win32FontManager(bridge).match('sans-serif');
    const first = face.metrics(14);
    assert.deepEqual(face.metrics(14), first);
    assert.equal(asked, 1, 'the same size, one question');
    face.metrics(16);
    assert.equal(asked, 2, 'another size is another question');
  });

  it('a font stack is resolved once', () => {
    const bridge = createFakeBridge();
    let asked = 0;
    const exists = bridge.fontExists;
    bridge.fontExists = (name) => {
      asked++;
      return exists(name);
    };
    const fonts = new Win32FontManager(bridge);
    fonts.match('Inter, Segoe UI, sans-serif');
    const after = asked;
    fonts.match('Inter, Segoe UI, sans-serif', { weight: 700 });
    assert.equal(asked, after, 'the second match asked nothing');
    assert.equal(fonts.match('Inter, Segoe UI').family, 'Segoe UI');
  });
});

describe('win32 fonts: the layout it answers', () => {
  it("derives a per-line descent, which a line's ink is measured with", () => {
    const layout = manager().layout('hello', {});
    // DirectWrite reports a baseline and a height per line; a field and the
    // edit menu measure a line's ink as its ascent plus its descent, so the
    // descent has to be there.
    assert.deepEqual(
      layout.lines.map((l) => l.descent),
      [4],
    );
  });

  it('reports a min-content width, which the yoga floors pass asks for', () => {
    assert.equal(manager().layout('hello', {}).minWidth, 40);
  });

  it('answers a width offer of zero with the paragraph at its min-content width', () => {
    // yoga's floors pass asks a `<text>` how narrow it can be with an offer
    // of zero. The bridge builds such a layout unbounded, so the answer was
    // the whole paragraph on one line, and no text in a flex row could give
    // way below its full length.
    const layout = manager().layout('hello wide world', {}, { maxWidth: 0 });
    assert.equal(layout.width, 40, 'the widest word, not the line');
  });

  it("answers an eliding line's floor with the mark alone", () => {
    const layout = manager().layout(
      'a long title',
      {},
      { maxWidth: 0, maxLines: 1, overflow: 'ellipsis' },
    );
    assert.equal(layout.width, 8);
  });

  it('breaks at the width and keeps `maxLines` lines, saying it dropped some', () => {
    // The bridge read `maxLines: 1` as "do not wrap": a one-line `<text>`
    // came back as the whole paragraph, as wide as all of it
    const bridge = createFakeBridge();
    const layout = new Win32FontManager(bridge).layout(
      'aaa bbb ccc ddd eee',
      {},
      { maxWidth: 64, maxLines: 1 },
    );
    assert.equal(layout.lines.length, 1);
    assert.equal(layout.truncated, true);
    assert.ok(layout.width <= 64, `within the width: ${layout.width}`);
    for (const call of bridge.calls.filter((c) => c[0] === 'layoutCreate')) {
      assert.equal(call[2].maxLines, undefined, 'the bridge is never asked');
    }
    const two = manager().layout(
      'aaa bbb ccc ddd eee',
      {},
      { maxWidth: 64, maxLines: 2 },
    );
    assert.equal(two.lines.length, 2);
    const all = manager().layout(
      'aaa bbb ccc ddd eee',
      {},
      { maxWidth: 64, maxLines: 5 },
    );
    assert.equal(all.lines.length, 3);
    assert.equal(all.truncated, false);
  });

  it('ends an eliding paragraph in an ellipsis that fits beside what it keeps', () => {
    const bridge = createFakeBridge();
    const layout = new Win32FontManager(bridge).layout(
      [{ text: 'aaa bbb ' }, { text: 'ccc ddd', marker: 'link' }],
      {},
      { maxWidth: 60, maxLines: 1, overflow: 'ellipsis' },
    );
    const last = bridge.calls.filter((c) => c[0] === 'layoutCreate').at(-1);
    assert.match(last[1], /…$/, `ends in the mark: ${last[1]}`);
    assert.ok(last[1].length * 8 <= 60, `fits: ${last[1]}`);
    assert.equal(layout.lines.length, 1);
    assert.equal(layout.truncated, true);
  });

  it('measures a line without the space it wrapped at, which its advance keeps', () => {
    // A line that fitted read as wider than its box, the space a wrap ended
    // it on included, and <Html> moved every line beside a float below it
    const layout = manager().layout('aaa bbb ccc', {}, { maxWidth: 64 });
    assert.equal(layout.lines[0].width, 56);
    assert.equal(layout.lines[0].advance, 64);
  });

  it('aligns the lines of a paragraph with no width within its widest', () => {
    // the bridge aligns an unbounded paragraph in a box a million pixels
    // wide, and <Html> measured a centred heading in a shrink-to-fit box as
    // wide as all the room it had
    const bridge = createFakeBridge();
    const layout = new Win32FontManager(bridge).layout(
      'centred',
      {},
      { align: 'center' },
    );
    assert.equal(layout.lines[0].x, 0);
    assert.equal(layout.width, 56);
    const last = bridge.calls.filter((c) => c[0] === 'layoutCreate').at(-1);
    assert.equal(last[2].maxWidth, 56, 'laid out again at its own width');
  });

  it('counts a no-break space a line ends on in its width, as ntk does', () => {
    // DirectWrite leaves it out as it leaves out a space, so a lone one
    // measured nothing, and <Html> — which spaces an inline box's edges
    // with one — made every edge a space too wide
    const bridge = createFakeBridge();
    const metrics = bridge.layoutMetrics;
    bridge.layoutMetrics = (handle) => ({ ...metrics(handle), width: 0 });
    const layout = new Win32FontManager(bridge).layout('\u00a0', {});
    assert.equal(layout.width, 8);
    assert.equal(layout.lines[0].width, 8);
  });

  it("puts each line's baseline from the top of the layout, as ntk does", () => {
    const layout = manager().layout('aaa bbb ccc', {}, { maxWidth: 64 });
    assert.deepEqual(
      layout.lines.map((l) => l.baseline),
      [12, 28],
    );
  });

  it('keeps the ascent and descent the bridge measured off the faces', () => {
    // under a `lineHeight` the bridge sets the baseline at 0.8 of the
    // face's; worked out from it, the descent overran the line box and a
    // line read as shorter than its own strut
    const bridge = createFakeBridge();
    bridge.measuresLines = true;
    const layout = new Win32FontManager(bridge).layout(
      'x',
      {},
      { lineHeight: 1 },
    );
    assert.equal(layout.lines[0].ascent, 12);
    assert.equal(layout.lines[0].descent, 4);
  });

  it('hangs each run off the span it came from, cut where two spans meet', () => {
    // what a painter reads a link's underline off: without it <Html> drew no
    // underline, chip or highlight on Windows
    const plain = { text: 'ab', size: 12 };
    const link = { text: 'cd', size: 12, marker: 'link' };
    const layout = manager().layout([plain, link], {});
    const runs = layout.lines[0].runs;
    assert.equal(runs.length, 2);
    assert.equal(runs[0].span, plain);
    assert.equal(runs[1].span, link);
    assert.deepEqual(
      runs.map((r) => [r.start, r.end, r.x, r.width]),
      [
        [0, 2, 0, 16],
        [2, 4, 16, 16],
      ],
    );
    assert.equal(runs[1].run.size, 12);
    assert.equal(typeof runs[1].run.font.metrics, 'function');
  });

  it('draws through the context, not the native, so one wrapper serves both bridges', () => {
    const layout = manager().layout('hi', {});
    const seen = [];
    layout.draw(
      { _drawLayout: (l, x, y) => seen.push([l === layout, x, y]) },
      4,
      6,
    );
    assert.deepEqual(seen, [[true, 4, 6]]);
  });
});

describe('win32 fonts: the index boundary', () => {
  it('answers indexAt in code points where the bridge speaks code units', () => {
    // Two astral characters: four UTF-16 code units, two code points.
    const layout = manager().layout('\u{1F600}\u{1F601}ab', {});
    // The fake puts a character every eight pixels, in code units.
    assert.equal(layout.indexAt(0, 0), 0);
    assert.equal(layout.indexAt(16, 0), 1, 'a surrogate pair counted as two');
    assert.equal(layout.indexAt(32, 0), 2);
  });

  it('takes caretPosition in code points and asks in code units', () => {
    const layout = manager().layout('\u{1F600}x', {});
    // Code point 1 is the 'x', which begins at code unit 2.
    assert.equal(layout.caretPosition(1).x, 16);
  });

  it('clamps a caret past the end rather than answering undefined', () => {
    const layout = manager().layout('ab', {});
    assert.equal(layout.caretPosition(99).x, 16);
  });
});

describe('win32 fonts: what it refuses honestly', () => {
  it('reports no fallback rather than guessing a family', () => {
    // DirectWrite's MapCharacters is the right answer and is not bound yet. A
    // wrong face is worse than tofu, because nothing downstream can tell it
    // went wrong.
    assert.equal(manager().fallbackFor(0x4e00), null);
  });
});

describe('win32 fonts: coverage', () => {
  // A layout's coverage without a surface (#673) is the bridge's to compute —
  // DirectWrite's glyph-run analysis — and this file's to hand over: the
  // layout's own handle, the pad asked for, and an honest null where the
  // bridge cannot answer, so a caller keeps its readback.
  it("asks the bridge for its own layout's coverage, with the pad asked for", () => {
    const bridge = createFakeBridge();
    const asked = [];
    bridge.layoutCoverage = (handle, pad) => {
      asked.push([handle, pad]);
      const width = 8 * 3 + pad * 2;
      const height = 16 + pad * 2;
      return { width, height, data: new Uint8Array(width * height) };
    };
    const fonts = new Win32FontManager(bridge);
    const layout = fonts.layout('abc', {});
    const coverage = layout.coverage({ pad: 3 });
    assert.deepEqual(asked, [[layout._handle, 3]]);
    assert.equal(coverage.width, 30, 'the layout box with the pad round it');
    assert.equal(coverage.height, 22);
    assert.equal(coverage.data.length, 30 * 22);
    layout.coverage();
    assert.deepEqual(asked[1], [layout._handle, 0], 'no pad unless asked');
  });

  it('answers null on a bridge that predates it, so a caller keeps its readback', () => {
    const layout = manager().layout('abc', {});
    assert.equal(layout.coverage({ pad: 2 }), null);
  });

  it('answers null for a layout that has been destroyed', () => {
    const bridge = createFakeBridge();
    let asked = 0;
    bridge.layoutCoverage = () => {
      asked++;
      return { width: 1, height: 1, data: new Uint8Array(1) };
    };
    const layout = new Win32FontManager(bridge).layout('abc', {});
    layout.destroy();
    assert.equal(layout.coverage(), null);
    assert.equal(asked, 0, 'a released handle is never handed to the bridge');
  });
});
