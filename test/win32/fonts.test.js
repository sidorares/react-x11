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
});

describe('win32 fonts: the layout it answers', () => {
  it('derives a per-line descent, which half-leading needs', () => {
    const layout = manager().layout('hello', {});
    // DirectWrite reports a baseline and a height per line; nodes/text.js
    // subtracts `baseline + descent` from the height to recreate CSS
    // half-leading, so the descent has to be there.
    assert.deepEqual(
      layout.lines.map((l) => l.descent),
      [4],
    );
  });

  it('reports a min-content width, which the yoga floors pass asks for', () => {
    assert.equal(manager().layout('hello', {}).minWidth, 8);
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
