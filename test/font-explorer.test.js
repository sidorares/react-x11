// examples/fonts.jsx — the claims a font explorer has to earn.
//
// Named for the example rather than for the file it lives in, because
// `test/fonts.test.js` is taken: that one is the font *API* — `openFont`,
// `loadFont`, `useFont` (#346) — and this is the app built on it.
//
// The catalogue is a seam because fontconfig answers differently on every
// machine, which is the whole subject of the app and the one thing a test
// cannot depend on. These run against KaTeX's faces, which ship in
// devDependencies and therefore say the same thing everywhere.
import { test, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  waitFor,
  userEvent,
  within,
  textOf,
  pixelAt,
  isNear,
} from '../src/testing/index.js';

process.env.REACT_X11_NO_AUTORUN = '1';

const { FontsPanel, fixedCatalogue } = await import('../examples/fonts.jsx');

const require = createRequire(import.meta.url);
const FONTS = path.join(
  path.dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);
const face = (name) => path.join(FONTS, `${name}.ttf`);
const CATALOGUE = [
  face('KaTeX_Main-Regular'),
  face('KaTeX_Fraktur-Regular'),
  face('KaTeX_AMS-Regular'),
];

afterEach(cleanup);

const h = React.createElement;

const mount = async (props = {}) => {
  const handle = await renderX11(
    h(
      'window',
      { width: 980, height: 640, style: { flexGrow: 1 } },
      h(FontsPanel, { catalogue: fixedCatalogue(CATALOGUE), ...props }),
    ),
    {
      width: 980,
      height: 640,
      fonts: { 'sans-serif': face('KaTeX_Main-Regular') },
    },
  );
  await waitFor(() => {
    const field = screen.getByPlaceholder('sans-serif');
    assert.ok(field.abs?.width > 0, 'not laid out yet');
  });
  return handle;
};

const detail = () => within(screen.getByTestName('detail'));
// `getByText` matches substrings, and a family name is also inside the file
// path and the PostScript name — so the heading is found by an anchored
// regex rather than by its own text.
const heading = (family) => detail().getByText(new RegExp(`^${family}$`));
const facts = () => within(screen.getByTestName('facts'));

/** The value under a metric's label, which is the sibling text in its cell. */
const factValue = (label) => {
  const cell = facts().getByText(label).parent;
  const texts = within(cell)
    .getAllByRole('text')
    .map((n) => textOf(n));
  return texts[texts.indexOf(label) + 1];
};

describe('examples/fonts', () => {
  test('the first match is marked as the one the query gives you', async () => {
    await mount();

    // The point of the whole left column: fontconfig returns a *ranking*, and
    // an app that shows a list without saying which one wins has answered a
    // different question than the one that was asked.
    const rows = within(screen.getByTestName('matches')).getAllByRole('option');
    assert.equal(rows.length, CATALOGUE.length);
    within(rows[0]).getByText('what this query gives you');
    assert.equal(
      within(rows[1]).queryAllByText('what this query gives you').length,
      0,
    );
  });

  test('the winning face is what the detail pane opens', async () => {
    await mount();
    await waitFor(() => heading('KaTeX_Main'));
    assert.equal(factValue('Units per em'), '1000');
    assert.equal(factValue('Cap height'), '20.49px');
  });

  test('picking another face re-reads the file, not the list', async () => {
    await mount();
    await waitFor(() => heading('KaTeX_Main'));

    await userEvent.click(
      screen.getByRole('option', { name: 'KaTeX_Fraktur-Regular' }),
    );

    // Fraktur's cap height differs from Main's, so this only passes if the
    // second file was actually opened and measured.
    await waitFor(() => heading('KaTeX_Fraktur'));
    assert.equal(factValue('Cap height'), '21.87px');
  });

  test('a metric the face does not declare says so, rather than NaN', async () => {
    // `metrics()` answers `null` for a cap height a face never stated — Comic
    // Sans MS is one, but it is macOS-only, so the seam supplies the case
    // instead of the filesystem. The renderer takes the same view of a
    // missing cap height (`_lineMetrics` leaves the box alone), so an
    // explorer printing `NaNpx` would be reporting a bug that is not there.
    const undeclared = {
      kind: 'stub',
      match: () => [
        { path: '/stub/Undeclared.ttf', postscriptName: 'Undeclared' },
      ],
      open: () => ({
        familyName: 'Undeclared',
        postscriptName: 'UndeclaredPS',
        unitsPerEm: 1000,
        variationAxes: {},
        hasGlyph: () => true,
        metrics: () => ({
          ascent: 24,
          descent: 6,
          lineGap: 0,
          lineHeight: 30,
          capHeight: null,
          xHeight: null,
        }),
      }),
    };
    await mount({ catalogue: undeclared });
    await waitFor(() => heading('Undeclared'));
    assert.equal(factValue('Cap height'), 'not declared');
    assert.equal(factValue('x-height'), 'not declared');
    // …and a face that does state it still reads as a number.
    cleanup();
    await mount();
    await waitFor(() => heading('KaTeX_Main'));
    assert.equal(factValue('Cap height'), '20.49px');
  });

  test('coverage names the characters this face does not have', async () => {
    await mount({ initialText: 'Aя' });
    await waitFor(() => heading('KaTeX_Main'));

    // KaTeX_Main has Latin and no Cyrillic, so this is the substitution the
    // reader is being warned about: what they see is another font's work.
    const coverage = within(screen.getByTestName('coverage'));
    await waitFor(() => coverage.getByText(/Not in this face/));
    assert.match(textOf(coverage.getByText(/Not in this face/)), /я/);
  });

  test('coverage follows the specimen as it is typed', async () => {
    await mount({ initialText: 'A' });
    const coverage = () => within(screen.getByTestName('coverage'));
    await waitFor(() => coverage().getByText(/has all/));

    await userEvent.type(screen.getByPlaceholder('type a specimen'), 'я');
    await waitFor(() => coverage().getByText(/Not in this face/));
  });

  test('a face with no variable axes says which property is empty', async () => {
    await mount();
    const axes = within(screen.getByTestName('axes'));
    await waitFor(() => axes.getByText(/declares none/));
  });

  test('the query narrows the list', async () => {
    await mount();
    assert.equal(
      within(screen.getByTestName('matches')).getAllByRole('option').length,
      3,
    );

    // The field starts at `sans-serif`, so typing would append to it — clear
    // it first. `userEvent.key` takes a keysym number, not a name.
    const BACKSPACE = 0xff08;
    await userEvent.click(screen.getByPlaceholder('sans-serif'));
    for (let i = 0; i < 'sans-serif'.length; i += 1)
      await userEvent.key(BACKSPACE);
    await userEvent.type(screen.getByPlaceholder('sans-serif'), 'fraktur');

    await waitFor(() => {
      const rows = within(screen.getByTestName('matches')).getAllByRole(
        'option',
      );
      assert.equal(rows.length, 1);
    });
    await waitFor(() => heading('KaTeX_Fraktur'));
  });

  test('hovering a glyph reports that glyph, not the whole string', async () => {
    // Everything here comes off `app.fonts.shape()` — the same shaped run the
    // renderer draws from — so the numbers are the glyph's own. The exact
    // advance is the assertion that matters: `A` at 30px in KaTeX_Main is
    // 22.50px and the whole of `AV` is 45.00px, so a readout that reported
    // the string would be caught rather than merely look plausible.
    await mount({ initialText: 'AV' });
    await waitFor(() => heading('KaTeX_Main'));

    const readout = () => within(screen.getByTestName('glyph'));
    readout().getByText(/Point at a glyph/);

    // The specimen draws its text at x = 18, and `hover` takes an offset from
    // the node's centre.
    const overFirstGlyph = async () => {
      const canvas = screen.getByTestName('specimen');
      await userEvent.hover(canvas, {
        dx: Math.round(24 - canvas.abs.width / 2),
        dy: 0,
      });
    };

    await overFirstGlyph();
    await waitFor(() => readout().getByText(/U\+0041/));
    const line = textOf(readout().getByText(/U\+0041/));
    assert.match(line, /advance 22\.50px/);
    assert.match(line, /drawn from KaTeX_Main/);

    // …and the face it names is the one the run was drawn with, not the one
    // the pane happens to be showing: a different file gives both a different
    // advance and a different name.
    await userEvent.click(
      screen.getByRole('option', { name: 'KaTeX_Fraktur-Regular' }),
    );
    await waitFor(() => heading('KaTeX_Fraktur'));
    await overFirstGlyph();
    await waitFor(() => {
      const next = textOf(readout().getByText(/U\+0041/));
      assert.match(next, /advance 21\.54px/);
      assert.match(next, /drawn from KaTeX_Fraktur/);
    });
  });

  test('the guides are lines on the canvas, and the switch turns them off', async () => {
    // A drawing claim, so a pixel is the assertion. The sample is at x = 5,
    // left of the text's own x = 18, so nothing but a guide can be there.
    const { ctx } = await mount({ initialText: 'A' });
    await waitFor(() => heading('KaTeX_Main'));

    const canvas = screen.getByTestName('specimen');
    const baseline = Math.round(canvas.abs.height / 2 + 30 * 0.34);
    const at = { x: canvas.abs.x + 5, y: canvas.abs.y + baseline };

    await waitFor(async () =>
      assert.ok(
        isNear(await pixelAt(ctx, at.x, at.y), '#ff9d7a', 24),
        'the baseline guide should be drawn at the baseline',
      ),
    );

    // A Switch has no text of its own, so its role name cannot find it —
    // hence the test name on the control.
    await userEvent.click(screen.getByTestName('guides'));
    await waitFor(async () =>
      assert.ok(
        !isNear(await pixelAt(ctx, at.x, at.y), '#ff9d7a', 24),
        'turning guides off should leave the background',
      ),
    );
  });

  test('gradient ink paints the top of a glyph differently from the bottom', async () => {
    // The point of filling the glyphs rather than the background: one glyph
    // is two colours down its height. `M` at 64px gives a thick vertical
    // stem to sample, and the *plain* ink is the control — without it this
    // would pass on any two pixels that happen to differ, the shadow
    // included.
    const stemOf = (canvas) => ({
      x: canvas.abs.x + 66,
      top: canvas.abs.y + Math.round(canvas.abs.height / 2 + 64 * 0.34) - 40,
      bottom: canvas.abs.y + Math.round(canvas.abs.height / 2 + 64 * 0.34) - 8,
    });

    const spread = async (ink) => {
      const { ctx } = await mount({
        initialText: 'M',
        initialInk: ink,
        initialSize: 64,
      });
      await waitFor(() => heading('KaTeX_Main'));
      const at = stemOf(screen.getByTestName('specimen'));
      let out = null;
      await waitFor(async () => {
        const top = await pixelAt(ctx, at.x, at.top);
        const bottom = await pixelAt(ctx, at.x, at.bottom);
        // Both samples must be *on* the glyph, or this measures background.
        assert.ok(
          top[0] > 120 && bottom[0] > 120,
          `off the stem: ${top} ${bottom}`,
        );
        out = Math.abs(top[2] - bottom[2]);
      });
      cleanup();
      return out;
    };

    const gold = await spread('gold');
    const plain = await spread('plain');
    assert.ok(gold > 30, `a gold ramp should vary down the stem, got ${gold}`);
    assert.ok(plain < 10, `plain ink should not vary, got ${plain}`);
  });
});
