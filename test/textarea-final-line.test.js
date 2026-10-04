// A `<textarea>` whose value ends in a line break has a line after it: the
// empty one Return at the end opens, which the caret stands on.
//
// Neither text engine sets that line. ntk's TextLayout and CoreText both end
// a paragraph at its last break — right for a `<text>`, where CSS draws no
// line there either — so a textarea laid out "first line\nsecond line
// herethird\n" in two lines: the caret after Return was drawn at the end of
// "herethird", Up from it went to the first line, Down never reached it, and
// the scroll that follows the caret stopped a line short. On every backend:
// found on Cocoa by replaying the bridge's own key events, and the X11 field
// did exactly the same.
//
// The line is the engine's own empty paragraph moved under the last line
// (`withFinalLine`), so it is held here, engine by engine, to the line that
// engine sets when a break follows — `text + '\n'`, where the empty
// paragraph is no longer the last and both engines set it. Over ntk with a
// bundled face, and over CoreText where `@windowkit/appkit` is installed.
// Then the field itself: headless on X11, and on Cocoa over a bridge that
// answers the way CoreText does, Return included as the bridge reports it.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import React from 'react';
import { FontManager, StaticFontSource, createClient } from 'ntk';
import xserver from 'x11/lib/xserver/index.js';

import { CocoaFontManager } from '../src/cocoa/fonts.js';
import { loadNative } from '../src/cocoa/native.js';
import { createRoot } from '../src/index.js';
import { withFinalLine } from '../src/nodes/textarea.js';
import {
  cleanupCocoa,
  fakeCocoaBridge,
  mountCocoa,
} from './helpers/cocoa-bridge.js';

const h = React.createElement;
const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

function staticFonts() {
  const source = new StaticFontSource();
  source.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  source.alias('sans-serif', 'Test Main');
  return source;
}

const VALUE = 'first line\nsecond line herethird';

// --- the line, engine by engine -------------------------------------------

let bridge;
try {
  bridge = loadNative();
} catch {
  bridge = null;
}

const engines = [
  ['ntk', () => new FontManager({ source: staticFonts() })],
  ['CoreText', bridge && (() => new CocoaFontManager(bridge))],
];

const close = (actual, expected, what) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${what}: ${actual}, where the engine's own is ${expected}`,
  );

for (const [name, make] of engines) {
  describe(
    `the line after a final break, over ${name}`,
    { skip: make ? false : 'no @windowkit/appkit here' },
    () => {
      const style = { family: 'sans-serif', size: 20 };
      for (const text of [`${VALUE}\n`, 'ab\n\n', '\n', 'ab\r', 'ab ']) {
        for (const options of [
          {},
          { maxWidth: 300 },
          { maxWidth: 300, align: 'right' },
          { maxWidth: 300, align: 'center' },
          { maxWidth: 300, direction: 'rtl' },
          { lineHeight: 2 },
        ]) {
          test(`${JSON.stringify(text)}, ${JSON.stringify(options)}`, () => {
            const fonts = make();
            const plain = fonts.layout(text, style, options);
            const layout = withFinalLine(plain, text, () =>
              fonts.layout('\n', style, options),
            );
            // the empty paragraph with a break after it, which the engine
            // sets: where the line goes, and where the caret goes on it. The
            // same break again — a `\n` after a `\r` would be one break.
            const own = fonts.layout(text + text.at(-1), style, options);
            const n = own.lines.length - 1;
            assert.strictEqual(layout.lines.length, own.lines.length);
            for (const key of ['x', 'y', 'height', 'baseline']) {
              close(layout.lines[n][key], own.lines[n][key], key);
            }
            assert.strictEqual(layout.lines[n].start, text.length);
            close(layout.height, own.height, 'height');
            const end = Array.from(text).length;
            const caret = layout.caretPosition(end);
            const ownCaret = own.caretPosition(end);
            assert.strictEqual(caret.line, n);
            for (const key of ['x', 'y', 'height']) {
              close(caret[key], ownCaret[key], `the caret's ${key}`);
            }
            // a press anywhere on it, or below it, lands on it
            const mid = own.lines[n].y + own.lines[n].height / 2;
            assert.strictEqual(layout.indexAt(0, mid), end);
            assert.strictEqual(layout.indexAt(1e4, own.height + 40), end);
            // and the text above it is the engine's, untouched
            assert.deepStrictEqual(
              layout.caretPosition(end - 1),
              plain.caretPosition(end - 1),
            );
            assert.strictEqual(layout.indexAt(0, 1), plain.indexAt(0, 1));
            assert.strictEqual(layout.width, plain.width);
          });
        }
      }
    },
  );
}

describe('withFinalLine', () => {
  const fonts = new FontManager({ source: staticFonts() });
  const style = { family: 'sans-serif', size: 20 };

  test('leaves a value that does not end in a break alone', () => {
    for (const text of [VALUE, 'ab\ncd', '']) {
      const layout = fonts.layout(text, style);
      const blank = () => assert.fail('no empty paragraph asked for');
      assert.strictEqual(withFinalLine(layout, text, blank), layout);
    }
  });

  test('leaves an engine that sets the line itself alone', () => {
    const line = (y, start, end) => ({ y, height: 16, start, end, runs: [] });
    const layout = {
      height: 32,
      lines: [line(0, 0, 3), line(16, 3, 3)],
      caretPosition: () => ({ x: 0, y: 16, height: 16, line: 1 }),
    };
    const blank = () => assert.fail('no empty paragraph asked for');
    assert.strictEqual(withFinalLine(layout, 'ab\n', blank), layout);
  });
});

// --- the field, on X11 ------------------------------------------------------

const XK = { up: 0xff52, down: 0xff54, home: 0xff50, end: 0xff57 };

async function mountX11(t, props) {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({
    stream: clientEnd,
    fontSource: staticFonts(),
  });
  const root = await createRoot({ app });
  t.after(async () => {
    await root.unmount();
    await app.close();
  });
  const ref = React.createRef();
  const wnd = await new Promise((resolve) =>
    root.render(
      h(
        'window',
        { width: 320, height: 200 },
        h('textarea', { ref, defaultValue: VALUE, ...props }),
      ),
      resolve,
    ),
  );
  const area = ref.current;
  const frame = () => {
    area.root._scheduled = false;
    area.root.flush();
  };
  frame();
  const press = (keysym, codepoint) => {
    app.X.keycode2keysyms[254] = [keysym];
    wnd.emit('keydown', { keycode: 254, codepoint, buttons: 0 });
    frame();
  };
  return { area, press, frame };
}

describe('on X11', () => {
  test('Return at the end puts the caret on a line of its own', async (t) => {
    const { area, press } = await mountX11(t, {
      style: { flexGrow: 1, fontSize: 20 },
    });
    area.focus();
    area._moveCaret(VALUE.length, false);
    press(0xff0d, 0x0d);
    const end = VALUE.length + 1;
    assert.strictEqual(area.value, `${VALUE}\n`);
    assert.strictEqual(area._caret, end);

    const layout = area._valueLayout();
    assert.strictEqual(layout.lines.length, 3);
    const [, second, third] = layout.lines;
    const caret = layout.caretPosition(end);
    assert.strictEqual(caret.line, 2);
    assert.strictEqual(caret.x, third.x);
    assert.ok(caret.y >= second.y + second.height, 'below the second line');

    // Up keeps the column the caret stood at, the start of the line
    press(XK.up);
    assert.strictEqual(area._caret, VALUE.indexOf('second'));
    press(XK.down);
    assert.strictEqual(area._caret, end, 'and Down comes back to it');
    press(XK.home);
    assert.strictEqual(area._caret, end, 'Home on an empty line');
    press(XK.end);
    assert.strictEqual(area._caret, end, 'End on an empty line');

    // typing goes on that line
    press(0x78, 0x78); // 'x'
    assert.strictEqual(area.value, `${VALUE}\nx`);
    assert.strictEqual(area._valueLayout().caretPosition(end + 1).line, 2);
  });

  test('the field scrolls to the line Return opened', async (t) => {
    // two lines tall, and two lines of text: the third is past the bottom
    const { area, press } = await mountX11(t, {
      rows: 2,
      style: { fontSize: 20 },
    });
    area.focus();
    area._moveCaret(VALUE.length, false);
    assert.strictEqual(area._scrollY, 0, 'the premise: the text fits');
    press(0xff0d, 0x0d);
    const content = area.contentBox();
    const rect = area.textCaretRect(area._caret);
    assert.ok(area._scrollY > 0, 'scrolled');
    assert.ok(
      rect.y >= content.y && rect.y + rect.height <= content.y + content.height,
      `the caret ${rect.y}..${rect.y + rect.height} inside ` +
        `${content.y}..${content.y + content.height}`,
    );
  });

  test('a press below the text lands at the end', async (t) => {
    const { area } = await mountX11(t, {
      defaultValue: `${VALUE}\n`,
      style: { flexGrow: 1, fontSize: 20 },
    });
    const content = area.contentBox();
    assert.strictEqual(
      area.textIndexAt(content.x + 100, content.y + content.height - 2),
      VALUE.length + 1,
    );
  });
});

// --- the field, on Cocoa ----------------------------------------------------

afterEach(cleanupCocoa);

/**
 * The fake bridge with CoreText's paragraphs: a line per paragraph, holding
 * its break, and none for the empty paragraph after a final break — with a
 * caret at the end of the text on the last line, after its last letter, as
 * CoreText puts it. A letter is 8px across; a line is the face's size tall,
 * as the empty paragraph `blankLine` builds from these metrics is.
 */
function coreTextShaped() {
  const native = fakeCocoaBridge();
  const laid = new Map();
  native.createLayout = ({ spans }) => {
    const text = spans.map((span) => span.text).join('');
    const size = spans[0]?.font?.size ?? 14;
    const lines = [];
    let width = 0;
    for (let start = 0; start < text.length;) {
      const br = text.indexOf('\n', start);
      const end = br < 0 ? text.length : br + 1;
      const content = (br < 0 ? end : br) - start;
      const y = lines.length * size;
      lines.push({
        x: 0,
        y,
        width: content * 8,
        height: size,
        baseline: y + size * 0.8,
        ascent: size * 0.8,
        descent: size * 0.2,
        start,
        end,
        content,
        runs: [{ x: 0, width: content * 8, start, end, rtl: false }],
      });
      width = Math.max(width, content * 8);
      start = end;
    }
    const handle = { layout: laid.size + 1 };
    laid.set(handle, lines);
    return { handle, width, height: lines.length * size, lines };
  };
  native.layoutCaret = (handle, cu) => {
    const lines = laid.get(handle);
    if (!lines.length) return { x: 0, y: 0, height: 0, line: 0 };
    let li = lines.length - 1;
    while (li > 0 && lines[li].start > cu) li -= 1;
    const line = lines[li];
    const x = Math.min(cu - line.start, line.content) * 8;
    return { x, y: line.y, height: line.height, line: li };
  };
  native.layoutIndexAt = (handle, x, y) => {
    const lines = laid.get(handle);
    if (!lines.length) return 0;
    const line = lines.findLast((l) => l.y <= y) ?? lines[0];
    return line.start + Math.max(0, Math.min(line.content, Math.round(x / 8)));
  };
  return native;
}

/** A bridge key press, as an NSEvent reaches `app._route` (kVK_*). */
function key(app, wnd, keyCode, chars) {
  const ev = {
    windowNumber: wnd.windowNumber,
    keyCode,
    ...(chars ? { charsBase: chars, charsShifted: chars } : {}),
    time: performance.now(),
  };
  app._route({ type: 'keydown', ...ev });
  app._route({ type: 'keyup', ...ev });
}
const KVK = { return: 36, up: 126, down: 125, home: 115, end: 119, x: 7 };

describe('on Cocoa', () => {
  test('Return at the end puts the caret on a line of its own', async () => {
    const area = React.createRef();
    const { app, wnd, frame } = await mountCocoa(
      h('textarea', {
        ref: area,
        defaultValue: VALUE,
        style: { flexGrow: 1, fontSize: 10 },
      }),
      { width: 300, height: 120, native: coreTextShaped() },
    );
    // scale 2: a 10px face is set at 20 device pixels, a line 20 tall
    const field = area.current;
    field.focus();
    field._moveCaret(VALUE.length, false);
    assert.strictEqual(field._valueLayout().lines.length, 2, 'the premise');

    key(app, wnd, KVK.return, '\r');
    frame();
    const end = VALUE.length + 1;
    assert.strictEqual(field.value, `${VALUE}\n`);
    const layout = field._valueLayout();
    assert.strictEqual(layout.lines.length, 3);
    assert.deepStrictEqual(
      layout.lines[2],
      {
        x: 0,
        y: 40,
        width: 0,
        height: 20,
        baseline: 56,
        ascent: 16,
        descent: 4,
        start: end,
        end,
        runs: [],
      },
      "the empty paragraph's line, under the second",
    );
    assert.deepStrictEqual(layout.caretPosition(end), {
      x: 0,
      y: 40,
      height: 20,
      line: 2,
    });
    const content = field.contentBox();
    assert.strictEqual(field.textCaretRect(end).y, content.y + 40);

    key(app, wnd, KVK.up);
    assert.strictEqual(field._caret, VALUE.indexOf('second'));
    key(app, wnd, KVK.down);
    assert.strictEqual(field._caret, end, 'and Down comes back to it');
    key(app, wnd, KVK.end);
    assert.strictEqual(field._caret, end);

    key(app, wnd, KVK.x, 'x');
    assert.strictEqual(field.value, `${VALUE}\nx`);
    assert.deepStrictEqual(field._valueLayout().caretPosition(end + 1), {
      x: 8,
      y: 40,
      height: 20,
      line: 2,
    });
  });
});
