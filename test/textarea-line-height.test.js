// A `<textarea>` spaces its lines by its `lineHeight`, as a `<text>` does:
// the font's natural line box times the multiple the style comes to.
//
// It laid its value out at the natural line whatever the style said. Where
// nothing is laid over the field that is only a field set tighter than it
// asked, but a code editor lays its `<textarea>` over the `<pre>` it
// highlights, the two in one `line-height` — react-simple-code-editor's,
// on joshwcomeau.com's playgrounds, at `1.4375rem` — and the field's caret
// and selection drifted down away from the text a fraction of a line more
// at each line, a line off by the twentieth.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import React from 'react';
import { StaticFontSource, createClient } from 'ntk';
import xserver from 'x11/lib/xserver/index.js';

import { createRoot } from '../src/index.js';

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

const VALUE = 'one\ntwo\nthree\nfour';

async function mount(t, style, props = {}) {
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
  const tree = (s) =>
    h(
      'window',
      { width: 320, height: 400 },
      h('textarea', { ref, defaultValue: VALUE, ...props, style: s }),
    );
  await new Promise((resolve) => root.render(tree(style), resolve));
  const area = ref.current;
  const frame = () => {
    area.root._scheduled = false;
    area.root.flush();
  };
  frame();
  const restyle = async (s) => {
    await new Promise((resolve) => root.render(tree(s), resolve));
    frame();
  };
  return { app, area, frame, restyle };
}

/** The field's lines, as the text engine sets them for a `<text>` with
 *  the same style: what a `lineHeight` makes of one. */
function textLines(app, area, lineHeight) {
  return app.fonts.layout(VALUE, area.resolvedTextStyle(), {
    maxWidth: area.contentBox().width,
    align: 'start',
    direction: 'ltr',
    lineHeight,
  }).lines;
}

test("a textarea's lines are its lineHeight apart, a <text>'s with the same style", async (t) => {
  const { app, area } = await mount(t, { fontSize: 20, lineHeight: 2 });
  const lines = area._valueLayout().lines;
  const natural = app.fonts.layout('Mg', area.resolvedTextStyle()).height;
  assert.strictEqual(lines.length, 4);
  for (let i = 1; i < lines.length; i += 1) {
    assert.ok(
      Math.abs(lines[i].y - lines[i - 1].y - 2 * natural) < 1e-6,
      `line ${i} is two natural lines below the one before`,
    );
  }
  const text = textLines(app, area, 2);
  lines.forEach((line, i) => {
    assert.strictEqual(line.y, text[i].y, `line ${i}'s top`);
    assert.strictEqual(line.baseline, text[i].baseline, `line ${i}'s baseline`);
  });
  // the caret on the last line is where that line's glyphs are, and a press
  // there lands in it
  const end = Array.from(VALUE).length;
  const caret = area._valueLayout().caretPosition(end);
  const last = lines[3];
  assert.ok(
    caret.y >= last.y && caret.y + caret.height <= last.y + last.height,
  );
  assert.strictEqual(
    area._valueLayout().indexAt(0, last.y + last.height / 2),
    VALUE.lastIndexOf('\n') + 1,
  );
});

test('a lineHeight in a length is that multiple of the field’s own size', async (t) => {
  const { app, area } = await mount(t, { fontSize: 20, lineHeight: '60px' });
  const text = textLines(app, area, 3);
  assert.deepStrictEqual(
    area._valueLayout().lines.map((l) => l.y),
    text.map((l) => l.y),
  );
});

test('rows lines of it make the field’s height, and a new lineHeight measures it again', async (t) => {
  const { app, area, restyle } = await mount(
    t,
    { fontSize: 20, lineHeight: 2 },
    { rows: 2 },
  );
  const natural = app.fonts.layout('Mg', area.resolvedTextStyle()).height;
  assert.strictEqual(area.contentBox().height, Math.ceil(natural * 2 * 2));
  await restyle({ fontSize: 20, lineHeight: 1.5 });
  assert.strictEqual(area.contentBox().height, Math.ceil(natural * 1.5 * 2));
  const text = textLines(app, area, 1.5);
  assert.deepStrictEqual(
    area._valueLayout().lines.map((l) => l.y),
    text.map((l) => l.y),
    'and lays its value out again',
  );
  // and with none, the font's own line, as before
  await restyle({ fontSize: 20 });
  assert.strictEqual(area.contentBox().height, Math.ceil(natural * 2));
  assert.deepStrictEqual(
    area._valueLayout().lines.map((l) => l.y),
    textLines(app, area, undefined).map((l) => l.y),
  );
});
