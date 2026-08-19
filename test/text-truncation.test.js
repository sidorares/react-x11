// Truncation (#350): `textOverflow: 'ellipsis'` and `maxLines`.
//
// The whole feature is ntk's — `TextLayout` caps lines, elides at a grapheme
// boundary, re-shapes the tail and picks the ellipsis character against the
// cut run's own coverage. What is here is the wiring, and the wiring has two
// decisions in it that no upstream test can pin:
//
//  1. **An ellipsis with no cap can never fire.** ntk elides off a line
//     count, so `textOverflow: 'ellipsis'` alone has to mean one line or it
//     is a property that silently does nothing.
//  2. **`textWrap: 'nowrap'` measures at unbounded width** so that its
//     overflow is horizontal — which leaves exactly one line, which is never
//     over the cap. So an eliding `nowrap` has to stop taking that path, and
//     the visible half of that is what the node reports back to *layout*: a
//     clipping `nowrap` label pushes its row wider, an eliding one gives way.
//     Pinned here in both directions, because the day it silently reverts is
//     the day every table column starts fighting for width again.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

import { renderX11, cleanup, screen } from '../src/testing/index.js';
import { a11yName } from '../src/a11y.js';

const require = createRequire(import.meta.url);
const FONT_DIR = path.join(
  path.dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);
// KaTeX Main covers U+2026, so the `…` branch of ntk's `_elide` is the one
// taken here; `mono` is a second real face, for the question of *whose* font
// the ellipsis is set in.
const FONTS = {
  'sans-serif': path.join(FONT_DIR, 'KaTeX_Main-Regular.ttf'),
  mono: path.join(FONT_DIR, 'KaTeX_Typewriter-Regular.ttf'),
};

const h = React.createElement;

// Wider than the 160px box below at 14px, and made of several words, so
// there is both a line break opportunity to wrap at and a word to cut into.
const LONG = 'Application Support and other long names';

afterEach(cleanup);

/** The paragraph as it is on screen, inside a 160px box that clips. */
async function laidOut(style, { boxStyle = {}, children = [LONG] } = {}) {
  await renderX11(
    h(
      'box',
      { style: { width: 160, overflow: 'hidden', ...boxStyle } },
      h('text', { 'data-testname': 'subject', style }, ...children),
    ),
    { width: 300, height: 120, fonts: FONTS },
  );
  const node = screen.getByTestName('subject');
  return { node, layout: node._placedLayout().layout };
}

const runsOf = (layout, line = 0) => layout.lines[line].runs;
const ellipsisRun = (layout, line = 0) =>
  runsOf(layout, line).find((run) => run.ellipsis) ?? null;

// --- the cap ---------------------------------------------------------------

test('textOverflow: ellipsis elides, and means one line on its own', async () => {
  const { layout } = await laidOut({ textOverflow: 'ellipsis' });
  assert.equal(layout.truncated, true);
  assert.equal(layout.lines.length, 1);
  const mark = ellipsisRun(layout);
  assert.ok(mark, 'the last line ends in an ellipsis run');
  // it is the visually last thing on the line, and the line still fits
  const last = runsOf(layout).at(-1);
  assert.equal(last.ellipsis, true);
  assert.ok(layout.width <= 160, `elided to ${layout.width}, box is 160`);
});

test('the same text without it wraps instead, and nothing is cut', async () => {
  const { layout } = await laidOut({});
  assert.equal(layout.truncated, false);
  assert.equal(layout.lines.length, 2);
  assert.equal(ellipsisRun(layout, 1), null);
});

test('maxLines caps a wrapping paragraph, and clips by default', async () => {
  const { layout } = await laidOut(
    { maxLines: 2 },
    // narrow enough that the text needs four lines, so two are dropped
    { boxStyle: { width: 80 } },
  );
  assert.equal(layout.lines.length, 2);
  assert.equal(layout.truncated, true);
  assert.equal(ellipsisRun(layout, 1), null, 'clip is the default');
});

test('maxLines with ellipsis puts the mark on the last kept line', async () => {
  const { layout } = await laidOut(
    { maxLines: 2, textOverflow: 'ellipsis' },
    { boxStyle: { width: 80 } },
  );
  assert.equal(layout.lines.length, 2);
  assert.equal(ellipsisRun(layout, 0), null);
  assert.ok(ellipsisRun(layout, 1), 'the second line is the one that ends');
});

test('maxLines wins over the one line an ellipsis would imply', async () => {
  const { layout } = await laidOut(
    { maxLines: 3, textOverflow: 'ellipsis' },
    {
      boxStyle: { width: 80 },
    },
  );
  assert.equal(layout.lines.length, 3);
});

test('a cap below one still keeps a line, rather than rendering nothing', async () => {
  const { layout } = await laidOut({ maxLines: 0, textOverflow: 'ellipsis' });
  assert.equal(layout.lines.length, 1);
});

// --- nowrap ---------------------------------------------------------------

test('nowrap + ellipsis is shaped against the box, not at unbounded width', async () => {
  const { layout } = await laidOut({
    textWrap: 'nowrap',
    textOverflow: 'ellipsis',
  });
  assert.equal(layout.truncated, true);
  assert.equal(layout.lines.length, 1);
  assert.ok(ellipsisRun(layout));
  assert.ok(layout.width <= 160, `elided to ${layout.width}, box is 160`);
});

test('nowrap on its own still measures unbounded — the clip path is intact', async () => {
  const { layout } = await laidOut({ textWrap: 'nowrap' });
  assert.equal(layout.truncated, false);
  assert.equal(layout.lines.length, 1);
  assert.ok(
    layout.width > 160,
    `clipping nowrap reports its full ${layout.width}px, over the 160px box`,
  );
});

/**
 * The behaviour change the two paths add up to, in a row that has to divide
 * 200px between a label and a 60px column beside it.
 *
 * Clipping, the label's min-content floor is the whole string, so the column
 * is pushed clean off the end of the row. Eliding, the floor is small, the
 * label takes what is left and says so with a `…`.
 */
async function row(style) {
  await renderX11(
    h(
      'box',
      { style: { flexDirection: 'row', width: 200 } },
      h('text', { 'data-testname': 'label', style }, LONG),
      h('box', {
        'data-testname': 'column',
        style: { width: 60, height: 10, flexShrink: 0 },
      }),
    ),
    { width: 300, height: 120, fonts: FONTS },
  );
  return {
    label: screen.getByTestName('label'),
    columnX: screen.getByTestName('column').contentBox().x,
  };
}

test('a clipping nowrap label pushes what follows it out of the row', async () => {
  const { columnX } = await row({ textWrap: 'nowrap' });
  assert.ok(columnX > 200, `the 60px column starts at ${columnX}, past 200`);
});

test('an eliding one gives way instead, and the column stays in the row', async () => {
  const { label, columnX } = await row({
    textWrap: 'nowrap',
    textOverflow: 'ellipsis',
  });
  assert.equal(columnX, 140, 'the column keeps its 60px at the end of 200');
  assert.equal(label._placedLayout().layout.truncated, true);
});

// --- who the ellipsis belongs to ------------------------------------------

test('the ellipsis is set in the font of the run it cut into', async () => {
  const { layout } = await laidOut(
    { textOverflow: 'ellipsis' },
    {
      boxStyle: { width: 150 },
      children: [
        'App ',
        h(
          'text',
          { style: { fontFamily: 'mono', fontSize: 20 } },
          'Utilities Terminal.app',
        ),
      ],
    },
  );
  const mark = ellipsisRun(layout);
  assert.ok(mark, 'the line was elided');
  // the cut lands inside the 20px monospace span, so the mark matches it —
  // a paragraph-style ellipsis after a 20px word reads as a different size
  // of type rather than as more text
  assert.equal(mark.span.family, 'mono');
  assert.equal(mark.span.size, 20);
});

// --- bidi ------------------------------------------------------------------

test('in an RTL paragraph the ellipsis lands on the visual left', async () => {
  const { layout } = await laidOut(
    { textOverflow: 'ellipsis' },
    { boxStyle: { direction: 'rtl' } },
  );
  const runs = runsOf(layout);
  assert.equal(runs[0].ellipsis, true, 'first in visual order, i.e. leftmost');
  assert.ok(runs.slice(1).every((run) => !run.ellipsis));
});

test('and on the visual right in an LTR one', async () => {
  const { layout } = await laidOut({ textOverflow: 'ellipsis' });
  const runs = runsOf(layout);
  assert.equal(runs.at(-1).ellipsis, true);
  assert.ok(runs.slice(0, -1).every((run) => !run.ellipsis));
});

// --- what is reported, and what is cached ----------------------------------

test('a truncated <text> reports the whole string, not the elided one', async () => {
  const { node, layout } = await laidOut({ textOverflow: 'ellipsis' });
  assert.equal(layout.truncated, true);
  // both the accessible name and the string the caret indices index into:
  // what was cut is a fact about the pixels, and a screen reader that heard
  // "Application Sup…" would be reading the layout rather than the content
  assert.equal(a11yName(node), LONG);
  assert.equal(node.textContent(), LONG);
});

test('the layout cache keys on the truncation options, not just the width', async () => {
  const { node } = await laidOut({ textOverflow: 'ellipsis' });
  const width = node.contentBox().width;
  const elided = node._layoutFor(width);
  assert.equal(elided.truncated, true);

  // the same node, the same width, a different cap: a cache keyed on the
  // width alone would hand back the one-line answer
  node.style = { ...node.style, maxLines: 3 };
  const clamped = node._layoutFor(width);
  assert.equal(clamped.lines.length, 2, 'two lines is all this string needs');
  assert.equal(clamped.truncated, false);
  assert.equal(
    node._layoutFor(width).lines.length,
    2,
    'and the second ask comes back off the cache under the new key',
  );
});

test('changing maxLines through a re-render re-measures the box', async () => {
  const tree = (style) =>
    h(
      'box',
      { style: { width: 160, overflow: 'hidden' } },
      h('text', { 'data-testname': 'subject', style }, LONG),
    );
  // Neither `maxLines` nor `textOverflow` is a yoga property or a paint
  // property, so a commit that moves one and nothing else reaches
  // `applyProps` with nothing for layout to notice — the same trap
  // test/text-restyle.test.js exists for. It has to ask for the pass itself.
  const { rerender } = await renderX11(tree({ textOverflow: 'ellipsis' }), {
    width: 300,
    height: 120,
    fonts: FONTS,
  });
  const before = screen.getByTestName('subject').contentBox().height;

  await rerender(tree({ textOverflow: 'ellipsis', maxLines: 2 }));
  const after = screen.getByTestName('subject').contentBox().height;
  assert.ok(
    after > before,
    `two lines (${after}) is taller than one (${before})`,
  );
});
