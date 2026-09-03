// Text below a legible size is painted as a strip of its ink where its
// lines are, not as glyphs (`TextNode._paintsStrip`, issue #445): a
// zoomed-out view's labels cost a glyph run each and nobody can read them.
// The size is in logical pixels, `createRoot({ textStripBelow })` moves the
// line, and 0 keeps glyphs at every size.
import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { renderX11, cleanup } from '../src/testing/index.js';
import { TEXT_STRIP_BELOW } from '../src/nodes.js';

const require = createRequire(import.meta.url);
const fonts = {
  'sans-serif': path.join(
    path.dirname(require.resolve('katex/package.json')),
    'dist',
    'fonts',
    'KaTeX_Main-Regular.ttf',
  ),
};
const h = React.createElement;

/** A context that records fills and refuses glyphs. */
function recorder() {
  const ops = [];
  const ctx = {
    ops,
    fillStyle: null,
    fillRects(rects) {
      ops.push(['fillRects', rects, ctx.fillStyle]);
    },
  };
  return ctx;
}

/** Paint `node`'s content into a recorder, saying whether glyphs were drawn. */
function paintText(node) {
  const ctx = recorder();
  const placed = node._placedLayout();
  let glyphs = 0;
  const draw = placed.layout.draw;
  placed.layout.draw = () => {
    glyphs += 1;
  };
  try {
    node.paintContent(ctx);
  } finally {
    placed.layout.draw = draw;
  }
  return { ops: ctx.ops, glyphs };
}

const labels = (refs, size = TEXT_STRIP_BELOW) =>
  h(
    'box',
    { style: { padding: 10 } },
    h(
      'text',
      { ref: refs.tiny, style: { fontSize: size - 2, color: '#ff0000' } },
      'label',
    ),
    h(
      'text',
      { ref: refs.big, style: { fontSize: size + 6, color: '#ff0000' } },
      'label',
    ),
  );

test('text below a legible size is painted as a strip of its ink, not as glyphs', async () => {
  const refs = { tiny: React.createRef(), big: React.createRef() };
  await renderX11(labels(refs), { width: 200, height: 100, fonts });
  const tiny = refs.tiny.current;
  assert.strictEqual(tiny._paintsStrip(), true);
  assert.strictEqual(refs.big.current._paintsStrip(), false);

  const small = paintText(tiny);
  assert.strictEqual(small.glyphs, 0, 'no glyphs');
  assert.strictEqual(small.ops.length, 1, 'one fill');
  const [, rects, ink] = small.ops[0];
  assert.strictEqual(rects.length, 4, 'one line, one rectangle');
  assert.strictEqual(ink, 'rgba(255, 0, 0, 0.45)', 'the ink, at coverage');
  const [x, y, width, height] = rects;
  const em = tiny.resolvedTextStyle().size;
  const box = tiny.contentBox();
  assert.strictEqual(x, box.x, 'from the line start');
  assert.ok(
    width > 0 && width <= box.width + 1,
    `as wide as the line: ${width}`,
  );
  assert.ok(
    y >= box.y && y + height <= box.y + box.height + 1,
    `inside the box: ${y}+${height} in ${box.y}+${box.height}`,
  );
  assert.ok(
    Math.abs(height - em * 0.7) < 1e-9,
    `the band the letters sit in: ${height} of ${em}`,
  );

  const large = paintText(refs.big.current);
  assert.strictEqual(large.glyphs, 1, 'glyphs');
  assert.strictEqual(large.ops.length, 0, 'and no strip');
  await cleanup();
});

test('createRoot({ textStripBelow }) moves the line, and 0 keeps glyphs at every size', async () => {
  const refs = { tiny: React.createRef(), big: React.createRef() };
  await renderX11(labels(refs), {
    width: 200,
    height: 100,
    fonts,
    textStripBelow: 20,
  });
  assert.strictEqual(refs.big.current._paintsStrip(), true, 'a 12px label too');
  await cleanup();

  const off = { tiny: React.createRef(), big: React.createRef() };
  await renderX11(labels(off), {
    width: 200,
    height: 100,
    fonts,
    textStripBelow: 0,
  });
  assert.strictEqual(
    off.tiny.current._paintsStrip(),
    false,
    'glyphs, however small',
  );
  assert.strictEqual(paintText(off.tiny.current).glyphs, 1);
  await cleanup();
});

test('a textStripBelow that is not a size says so', async () => {
  await assert.rejects(
    renderX11(h('text', null, 'x'), { fonts, textStripBelow: -1 }),
    /textStripBelow.*logical pixels/,
  );
  await cleanup();
});
