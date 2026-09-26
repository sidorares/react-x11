// A Cocoa layout's runs hang off the spans they were laid out from, as
// ntk's do: `span` is the caller's own object, markers and all, and `run` the
// face and size it was set in and its direction. What reads them is every
// decoration a text element paints itself — a link's underline, a code
// chip's background, a strikethrough — in @react-x11/components' `<Html>`,
// `<Markdown>` and `<RichText>`. Runs used to come back as geometry alone,
// and on macOS none of those were drawn.
//
// Checked over a bridge that answers with the lines it is told to: each run
// carries the caller's span and a face that measures; a run CoreText made of
// two neighbouring spans is cut where they meet, left to right and right to
// left; a cached layout answers a later call with that call's spans; and
// `truncated` says whether a line cap dropped anything. Over the real bridge,
// where there is one: text of one colour with a link in it is laid out as one
// CoreText run, and comes back as a run a span, end to end.
import assert from 'node:assert';
import { describe, test } from 'node:test';

import { CocoaFontManager } from '../src/cocoa/fonts.js';
import { loadNative } from '../src/cocoa/native.js';

/**
 * The font and layout natives `layout()` reaches, laying out one line of
 * `lines` a call — each `{ runs, end? }` — with a caret 8px a code unit, or
 * mirrored for a right-to-left run.
 */
function fakeNative(lines = [], { rtl = false } = {}) {
  const native = {
    calls: [],
    matchFont: ({ families, size }) => ({ family: families[0], size }),
    fontApplyVariations: (handle) => handle,
    fontMetrics: (handle) => ({
      ascent: handle.size * 0.8,
      descent: handle.size * 0.2,
      leading: 0,
    }),
    createLayout(options) {
      native.calls.push(options);
      const text = options.spans.map((span) => span.text).join('');
      const laid = lines.length
        ? lines
        : [{ runs: [{ start: 0, end: text.length, rtl }] }];
      let y = 0;
      return {
        handle: native.calls.length,
        width: text.length * 8,
        height: laid.length * 16,
        lines: laid.map((line) => {
          const runs = line.runs.map((r) => ({
            x: r.start * 8,
            width: (r.end - r.start) * 8,
            start: r.start,
            end: r.end,
            rtl: !!r.rtl,
          }));
          const start = runs[0]?.start ?? 0;
          const end = line.end ?? runs.at(-1)?.end ?? 0;
          const out = {
            x: 0,
            y,
            width: (end - start) * 8,
            height: 16,
            baseline: y + 12,
            ascent: 12,
            descent: 4,
            start,
            end,
            runs,
          };
          y += 16;
          return out;
        }),
      };
    },
    layoutCaret: (handle, index) => {
      const width =
        native.calls[handle - 1].spans.map((s) => s.text).join('').length * 8;
      return {
        x: rtl ? width - index * 8 : index * 8,
        y: 0,
        height: 16,
        line: 0,
      };
    },
  };
  return native;
}

const base = { family: 'sans-serif', size: 16 };

describe('a Cocoa layout hangs its runs off their spans', () => {
  test("each run carries the caller's span, markers and all, and a face that measures", () => {
    const spans = [
      { text: 'ab', href: 'https://example.com' },
      { text: 'cd', bg: '#ffeeaa', size: 20 },
    ];
    const manager = new CocoaFontManager(
      fakeNative([
        {
          runs: [
            { start: 0, end: 2 },
            { start: 2, end: 4 },
          ],
        },
      ]),
    );
    const [line] = manager.layout(spans, base).lines;
    assert.strictEqual(line.runs[0].span, spans[0]);
    assert.strictEqual(line.runs[1].span, spans[1]);
    assert.deepStrictEqual(
      line.runs.map((r) => [r.run.size, r.run.direction]),
      [
        [16, 'ltr'],
        [20, 'ltr'],
      ],
    );
    assert.strictEqual(line.runs[1].run.font.metrics(20).ascent, 16);
  });

  test('a run CoreText made of two spans is cut where they meet', () => {
    const spans = [
      { text: 'plain ' },
      { text: 'link', href: '#' },
      { text: '!' },
    ];
    const manager = new CocoaFontManager(fakeNative());
    const [line] = manager.layout(spans, base).lines;
    assert.deepStrictEqual(
      line.runs.map((r) => [r.start, r.end, r.x, r.width]),
      [
        [0, 6, 0, 48],
        [6, 10, 48, 32],
        [10, 11, 80, 8],
      ],
    );
    assert.deepStrictEqual(
      line.runs.map((r) => r.span),
      spans,
    );
  });

  test('and a right-to-left one, its first span rightmost', () => {
    const spans = [{ text: 'אב' }, { text: 'גד', href: '#' }];
    const manager = new CocoaFontManager(fakeNative([], { rtl: true }));
    const [line] = manager.layout(spans, base, { direction: 'rtl' }).lines;
    // left to right on the line: the second span, then the first
    assert.deepStrictEqual(
      line.runs.map((r) => [r.start, r.end, r.x, r.width, r.run.direction]),
      [
        [2, 4, 0, 16, 'rtl'],
        [0, 2, 16, 16, 'rtl'],
      ],
    );
    assert.strictEqual(line.runs[0].span, spans[1]);
  });

  test("a cached layout answers a later call with that call's spans", () => {
    const manager = new CocoaFontManager(fakeNative());
    const first = [{ text: 'see ' }, { text: 'this', href: '/a' }];
    const second = [{ text: 'see ' }, { text: 'this', underline: true }];
    const a = manager.layout(first, base);
    const b = manager.layout(second, base);
    assert.notStrictEqual(a, b, "another call's markers, another layout");
    assert.strictEqual(b.lines[0].runs[1].span, second[1]);
    assert.strictEqual(
      a.lines[0].runs[1].span,
      first[1],
      'the first keeps its own',
    );
    assert.strictEqual(
      manager.layout(first, base),
      a,
      'the same spans, the same layout',
    );
  });

  test('truncated says whether a line cap dropped anything', () => {
    const spans = [{ text: 'one two three' }];
    const cut = new CocoaFontManager(
      fakeNative([{ runs: [{ start: 0, end: 4 }], end: 4 }]),
    );
    assert.strictEqual(
      cut.layout(spans, base, { maxLines: 1 }).truncated,
      true,
    );
    const whole = new CocoaFontManager(fakeNative());
    assert.strictEqual(
      whole.layout(spans, base, { maxLines: 1 }).truncated,
      false,
    );
    assert.strictEqual(whole.layout(spans, base).truncated, false);
    // an eliding layout does not say, and a caller asks its line ends
    assert.strictEqual(
      cut.layout(spans, base, { maxLines: 1, overflow: 'ellipsis' }).truncated,
      undefined,
    );
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
  { skip: bridge ? false : 'no @windowkit/appkit here' },
  () => {
    test('text of one colour with a link in it comes back a run a span, end to end', () => {
      const manager = new CocoaFontManager(bridge);
      const spans = [
        { text: 'Read the ' },
        { text: 'release notes', href: 'https://example.com', underline: true },
        { text: ' first.' },
      ];
      const layout = manager.layout(spans, { family: 'Helvetica', size: 16 });
      const [line] = layout.lines;
      assert.deepStrictEqual(
        line.runs.map((r) => r.span),
        spans,
        'a run for each span, in order',
      );
      for (let i = 1; i < line.runs.length; i += 1) {
        const before = line.runs[i - 1];
        assert.ok(
          Math.abs(before.x + before.width - line.runs[i].x) < 0.01,
          `run ${i} starts where run ${i - 1} ends`,
        );
      }
      const covered = line.runs.reduce((sum, r) => sum + r.width, 0);
      assert.ok(
        Math.abs(covered - line.width) < 0.01,
        `the runs cover the line: ${covered} of ${line.width}`,
      );
    });
  },
);
