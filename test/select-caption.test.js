// A `<Select>`'s caption is one line.
//
// It wrapped. A `<text>` is a paragraph by default — offer it less width
// than its string wants and it breaks at the nearest opportunity and comes
// back taller — which is right for prose and wrong for the value a control
// is showing. The trigger's height does not follow it there: under a native
// popup bezel it is AppKit's own (`bezelNatural`), so a caption like
// "Local / Unix socket" in a field too narrow for it put "Local / Unix"
// *above* the control, outside the bezel, with "socket" inside. On the drawn
// theme nothing overflowed and the bug was quieter for it: one field in a
// row of fields simply came out twice the height of the rest.
//
// The menu never had it, which is why the trigger's version survived: the
// sheet is sized to its longest option (`menuWidth`), so every row has room
// by construction. Every row except on a screen narrower than that longest
// label, which is the one case `menuWidth` clamps — and a menu row is a
// fixed height too.
//
// So both are one line, and both end in a `…` when the line runs out. What
// is pinned here is that pair: the caption stays on one line and the trigger
// stays the height of one whatever it is showing, and the menu still shows
// every option whole — an ellipsis in *there* would mean the sizing had gone
// wrong rather than the room having run out.
//
// Eliding is what lets the caption *give way* rather than push the trigger
// wider, and that half rests on a floor the two font engines had to be made
// to agree on: an eliding label measures at the mark it would end in, not at
// its longest word. The Cocoa engine answered max-content until #512 and
// turned this wrap into an overflow the other way — the title drawn over
// the arrow capsule. That half is pinned in test/cocoa-text-floor.test.js,
// where the engine is.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';

import {
  cleanup,
  renderX11,
  screen,
  textOf,
  userEvent,
  within,
} from '../src/testing/index.js';
import { Select } from '../src/index.js';

const require = createRequire(import.meta.url);
const FONT_DIR = path.join(
  path.dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);
// KaTeX Main covers U+2026, so the elided line really ends in a `…` rather
// than in ntk's fallback for a face without one.
const FONTS = { 'sans-serif': path.join(FONT_DIR, 'KaTeX_Main-Regular.ttf') };

const h = React.createElement;

// Wider than the 140px trigger below at 14px, and made of several words, so
// there is a break opportunity for the old behaviour to wrap at.
const LONG = 'Local / Unix socket';
const OPTIONS = [LONG, 'TCP', 'TLS'];

afterEach(cleanup);

/** Two `<Select>`s in a column too narrow for one of them. */
const pair = () =>
  h(
    'box',
    { style: { width: 140, padding: 10, gap: 8 } },
    h(Select, {
      'data-testname': 'long',
      value: LONG,
      options: OPTIONS,
    }),
    h(Select, { 'data-testname': 'short', value: 'TCP', options: OPTIONS }),
  );

/** The caption inside a trigger or a row, and the paragraph it came out as
 *  — `_placedLayout` is the one on screen, elision and all. */
function captionOf(node) {
  const [text] = within(node).all((n) => n.kind === 'text');
  return { text, layout: text._placedLayout().layout };
}

const ellipsisRun = (layout) =>
  layout.lines.at(-1).runs.find((run) => run.ellipsis) ?? null;

test('a caption with no room left is elided, not wrapped', async () => {
  await renderX11(pair(), { width: 400, height: 200, fonts: FONTS });

  const long = screen.getByTestName('long');
  const { layout } = captionOf(long);

  assert.equal(layout.lines.length, 1, 'one line');
  assert.equal(layout.truncated, true);
  assert.ok(ellipsisRun(layout), 'and it ends in a `…`');
});

test('so the trigger is the height it would be showing anything else', async () => {
  await renderX11(pair(), { width: 400, height: 200, fonts: FONTS });

  const long = screen.getByTestName('long');
  const short = screen.getByTestName('short');
  assert.equal(
    long.abs.height,
    short.abs.height,
    `"${LONG}" ${long.abs.height} vs "TCP" ${short.abs.height}`,
  );
  // and the caption is inside the control rather than over its edge, which
  // is what the native bezel's fixed height turns a second line into
  const { text } = captionOf(long);
  assert.ok(
    text.abs.y >= long.abs.y &&
      text.abs.y + text.abs.height <= long.abs.y + long.abs.height,
    `caption at ${text.abs.y}..${text.abs.y + text.abs.height}, ` +
      `trigger ${long.abs.y}..${long.abs.y + long.abs.height}`,
  );
});

test('a caption that fits is left alone', async () => {
  await renderX11(
    h(
      'box',
      { style: { width: 300, padding: 10 } },
      h(Select, { 'data-testname': 'roomy', value: LONG, options: OPTIONS }),
    ),
    { width: 400, height: 200, fonts: FONTS },
  );

  const { layout } = captionOf(screen.getByTestName('roomy'));
  assert.equal(layout.truncated, false);
  assert.equal(ellipsisRun(layout), null);
});

test('and the menu still shows every option whole', async () => {
  await renderX11(pair(), { width: 400, height: 300, fonts: FONTS });

  await userEvent.click(screen.getByTestName('long'));

  const options = screen.getAllByRole('option');
  assert.equal(options.length, OPTIONS.length);
  for (const option of options) {
    const { text, layout } = captionOf(option);
    assert.equal(
      layout.truncated,
      false,
      `"${textOf(text)}" elided in a menu ${text.abs.width}px wide`,
    );
    assert.equal(layout.lines.length, 1);
  }
});

test('a menu the screen clamps elides its rows rather than wrapping them', async () => {
  // The one case `menuWidth` cannot size its way out of: the longest label
  // is wider than the display, so the sheet is clamped and the row it was
  // measured for no longer fits in it. Wrapping there was the trigger's bug
  // one surface along — three lines of label in a 22-or-30px row, drawn
  // over the two options under it.
  const WIDE = 'Local / Unix socket connection to the daemon process';
  await renderX11(
    h(
      'box',
      { style: { width: 120, padding: 10 } },
      h(Select, {
        'data-testname': 'clamped',
        value: 'TCP',
        options: [WIDE, 'TCP'],
      }),
    ),
    {
      width: 180,
      height: 260,
      screen: { width: 200, height: 300 },
      fonts: FONTS,
    },
  );

  await userEvent.click(screen.getByTestName('clamped'));

  const [row] = screen.getAllByRole('option');
  const { text, layout } = captionOf(row);
  assert.equal(layout.lines.length, 1, `"${textOf(text)}" over one line`);
  assert.equal(layout.truncated, true);
  assert.ok(ellipsisRun(layout), 'and says so with a `…`');
  assert.ok(
    text.abs.height <= row.abs.height,
    `label ${text.abs.height}px tall in a ${row.abs.height}px row`,
  );
});
