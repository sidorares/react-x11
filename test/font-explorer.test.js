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
});
