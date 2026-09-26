// Where `<text>` sets its glyphs in a line box taller or shorter than they
// are: in the middle of it, the leading split evenly above and below them.
// That is CSS's half-leading, and the text engines do it — ntk since 6.0.0,
// @windowkit/appkit since 0.15.0 — so `<text>` draws the layout where its
// box is and does nothing more.
//
// It used to shift the layout down by half the leading it found under the
// last line, to make up for an engine that put all of the leading there.
// Over an engine that splits it, that moved the glyphs a second time, a
// quarter of the leading too far down: half a pixel at the default line
// height of the 24px fixture face below, whose line gap is small, but 4px at
// 1.5 and 16px at 3 — and 8px at 2.5 in 18px Arial.
//
// Checked at multipliers from 0.5 to 3: the layout is drawn at the top of
// the content box, and each line's glyphs are as far from the top of its line
// box as from the bottom; and in pixels, capitals set at 3 straddle the
// middle of their box.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

import { renderX11, cleanup } from '../src/testing/index.js';

const require = createRequire(import.meta.url);
const FONTS = {
  'sans-serif': path.join(
    path.dirname(require.resolve('katex/package.json')),
    'dist',
    'fonts',
    'KaTeX_Main-Regular.ttf',
  ),
};

const h = React.createElement;

afterEach(cleanup);

/** A `<text>` in a white box, and the render it is in. */
async function paragraph(style, text) {
  const ref = React.createRef();
  const result = await renderX11(
    h(
      'box',
      {
        style: {
          padding: 10,
          alignItems: 'flex-start',
          backgroundColor: 'white',
        },
      },
      h('text', { ref, style: { color: 'black', ...style } }, text),
    ),
    { width: 300, height: 300, fonts: FONTS },
  );
  return { node: ref.current, result };
}

for (const lineHeight of [0.5, 1, 1.5, 3]) {
  test(`at lineHeight ${lineHeight}, each line's glyphs sit in the middle of its box`, async () => {
    const { node } = await paragraph(
      { fontSize: 24, lineHeight, width: 150 },
      'Hamburg, set in lines that wrap',
    );
    const content = node.contentBox();
    const placed = node._placedLayout();
    assert.ok(
      Math.abs(placed.y - content.y) < 0.01,
      `the layout is drawn where its box is, not ${(placed.y - content.y).toFixed(3)}px below`,
    );
    const { lines } = placed.layout;
    assert.ok(lines.length >= 2, `the text wraps: ${lines.length} lines`);
    for (const line of lines) {
      const above = line.baseline - line.ascent - line.y;
      const below = line.y + line.height - (line.baseline + line.descent);
      assert.ok(
        Math.abs(above - below) < 0.01,
        `line at ${line.y}: ${above.toFixed(3)} above the glyphs, ` +
          `${below.toFixed(3)} below`,
      );
    }
  });
}

const readPixels = (ctx, w, hgt) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, hgt, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );

test('in pixels, capitals set at 3 straddle the middle of their box', async () => {
  const { node, result } = await paragraph(
    { fontSize: 32, lineHeight: 3 },
    'HHH',
  );
  const ctx = result.ctx; // one context: each read of the getter makes another
  const dark = (image, x, y) => {
    const i = (y * 300 + x) * 4;
    return image.data[i] < 128 && image.data[i + 1] < 128;
  };
  let inkTop = null;
  let inkBottom = null;
  for (let attempt = 0; attempt < 50 && inkTop == null; attempt++) {
    const image = await readPixels(ctx, 300, 300);
    for (let y = 0; y < 300; y++) {
      for (let x = 0; x < 300; x++) {
        if (dark(image, x, y)) {
          inkTop ??= y;
          inkBottom = y;
          break;
        }
      }
    }
    if (inkTop == null) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(inkTop != null, 'the capitals are drawn');
  const box = node.contentBox();
  // Cap-only text sits (ascent - capHeight - descent) / 2 off the middle of
  // the glyph box, about a pixel in KaTeX Main at this size; drawn a quarter
  // of the leading low, it was 20px off.
  const offset = (inkTop + inkBottom + 1) / 2 - (box.y + box.height / 2);
  assert.ok(
    Math.abs(offset) <= 2.5,
    `ink [${inkTop}..${inkBottom}] against a box at ${box.y}, ` +
      `${box.height} high: ${offset.toFixed(2)}px off its middle`,
  );
});
