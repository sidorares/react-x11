// Where a field puts its one line of text, on a face that carries leading.
//
// docs/styling.md: a `<textinput>`'s "baseline goes where the space above the
// capitals equals the space under it". It did not, on any face with a real
// line gap: `_lineMetrics` derived its origin by subtracting `ascent`, while
// the painter puts the first baseline at the line's own `baseline` — and
// those differ by the leading the line carries above the glyphs.
//
// Measured on XQuartz, where `sans-serif` resolves to Hiragino Sans when
// Homebrew's fontconfig is first on PATH (#86):
//
//   Verdana         baseline - ascent = 0.23   invisible
//   Hiragino Sans   baseline - ascent = 3.50   three pixels low, every field
//
// **None of the fixture faces reproduce it.** Every KaTeX face ships a line
// gap of ~0, so an end-to-end render here is green either way — the same trap
// that hid the cap-band rounding in test/control-heights.test.js. So this
// drives `_lineMetrics` with a line that *does* carry leading, which is the
// smallest thing that can fail. `examples/labs/text-baseline.jsx` is the
// end-to-end half, and it needs a real server and a real font.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

import { renderX11, cleanup, screen } from '../src/testing/index.js';

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

/** A line as a face with a 0.5em gap reports one: the baseline sits a half
 *  leading below the top of the box, not at `ascent`. */
const LEADED_LINE = { ascent: 12.32, descent: 1.68, baseline: 15.82 };
const LEADED_LAYOUT = { height: 21, lines: [LEADED_LINE] };

async function field() {
  await renderX11(h('textinput', { placeholder: 'f', style: { width: 200 } }), {
    width: 240,
    height: 60,
    fonts: FONTS,
  });
  return screen.getByPlaceholder('f');
}

test('the capitals straddle the middle of the box, leading and all', async () => {
  const node = await field();
  const style = node.resolvedTextStyle();
  const cap = node.app.fonts
    .match(style.family, {})
    .metrics(style.size).capHeight;

  const content = { x: 0, y: 25, width: 200, height: Math.round(cap) };
  const { textY } = node._lineMetrics(LEADED_LAYOUT, content, style);

  // Where the painter will actually put the baseline.
  const baseline = textY + LEADED_LINE.baseline;
  const above = baseline - cap - content.y;
  const below = content.y + content.height - baseline;

  assert.ok(
    Math.abs(above - below) < 0.51,
    `space above capitals ${above.toFixed(3)} vs below baseline ${below.toFixed(3)}`,
  );
});

test('the caret band is measured from the glyphs, not from the box', async () => {
  const node = await field();
  const style = node.resolvedTextStyle();
  const content = { x: 0, y: 25, width: 200, height: 10 };
  const { textY, markY, markHeight } = node._lineMetrics(
    LEADED_LAYOUT,
    content,
    style,
  );

  // The ink starts a leading below the layout box it is drawn in. A caret
  // pinned to the box instead sits a leading high — visible as a caret that
  // does not line up with the text it is in.
  const inkTop = textY + (LEADED_LINE.baseline - LEADED_LINE.ascent);
  const inkBottom = inkTop + LEADED_LINE.ascent + LEADED_LINE.descent;

  assert.ok(
    markY <= inkTop + 0.01 && markY >= inkTop - 3.01,
    `caret top ${markY.toFixed(3)} against ink top ${inkTop.toFixed(3)}`,
  );
  assert.ok(
    markY + markHeight >= inkBottom - 0.01,
    `caret bottom ${(markY + markHeight).toFixed(3)} against ink bottom ${inkBottom.toFixed(3)}`,
  );
});
