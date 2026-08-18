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
  countPixels,
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
const SAMPLE_LONG = 'Sphinx of black quartz judge my vow and more besides';
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

  test('two faces of one family are told apart', async () => {
    // The specimen is registered through `loadFont` (#346), whose derived
    // name is the file's *family* — and a family is a set of faces. Register
    // Regular and Bold under the "KaTeX_Main" they share and `ctx.font`,
    // which names a family and no weight, resolves both to the regular one:
    // the list would say Bold while the specimen went on drawing Regular.
    // Registering by PostScript name is what keeps them separable.
    const { app } = await mount({
      catalogue: fixedCatalogue([
        face('KaTeX_Main-Regular'),
        face('KaTeX_Main-Bold'),
      ]),
    });
    await waitFor(() => heading('KaTeX_Main'));

    await userEvent.click(
      screen.getByRole('option', { name: 'KaTeX_Main-Bold' }),
    );

    await waitFor(() => {
      assert.equal(
        app.fonts.match('KaTeX_Main-Bold').postscriptName,
        'KaTeX_Main-Bold',
      );
    });
    // …and the face picked first is still reachable, rather than shadowed by
    // the one picked second under a name they both wanted.
    assert.equal(
      app.fonts.match('KaTeX_Main-Regular').postscriptName,
      'KaTeX_Main-Regular',
    );
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
    // Before anything is pointed at, the strip reports the paragraph.
    readout().getByText(/^1 line {2}· {2}line box/);

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

  test('the guides are lines, and the switch turns them back on', async () => {
    // A drawing claim, so pixels are the assertion — counted over the whole
    // specimen rather than sampled at a computed baseline, so this says "the
    // baseline guide is drawn" without re-deriving where it goes.
    //
    // And it toggles *twice*. The first version clicked once, which passed
    // while both switches read `ev.checked` — a property the change event
    // does not carry — so every click after the first set the same falsy
    // value and did nothing.
    const { ctx } = await mount({ initialText: 'A' });
    await waitFor(() => heading('KaTeX_Main'));

    const canvas = screen.getByTestName('specimen');
    const region = {
      x: canvas.abs.x,
      y: canvas.abs.y,
      width: canvas.abs.width,
      height: canvas.abs.height,
    };
    const baselines = () => countPixels(ctx, region, '#ff9d7a', 20);

    await waitFor(async () => assert.ok((await baselines()) > 100, 'drawn'));
    await userEvent.click(screen.getByTestName('guides'));
    await waitFor(async () => assert.equal(await baselines(), 0, 'off'));
    await userEvent.click(screen.getByTestName('guides'));
    await waitFor(async () => assert.ok((await baselines()) > 100, 'back on'));
  });

  test('the shadow switch turns the shadow off and back on', async () => {
    // The other half of the same bug: the first click appeared to work
    // because it set a falsy value, and every click after it set that value
    // again.
    const { ctx } = await mount({ initialText: 'MMM', initialSize: 96 });
    await waitFor(() => heading('KaTeX_Main'));

    const canvas = screen.getByTestName('specimen');
    const region = {
      x: canvas.abs.x,
      y: canvas.abs.y,
      width: canvas.abs.width,
      height: canvas.abs.height,
    };
    const shadowed = () => countPixels(ctx, region, '#05070a', 30);

    await waitFor(async () => assert.ok((await shadowed()) > 50, 'drawn'));
    await userEvent.click(screen.getByTestName('shadow'));
    await waitFor(async () => assert.equal(await shadowed(), 0, 'off'));
    await userEvent.click(screen.getByTestName('shadow'));
    await waitFor(async () => assert.ok((await shadowed()) > 50, 'back on'));
  });

  test('gradient ink puts the dark end of the ramp inside the glyphs', async () => {
    // The point of filling the glyphs rather than the background: one glyph
    // carries the whole ramp. The *dark* end is what discriminates — plain
    // ink is near-white and its antialiased edges land within tolerance of
    // the ramp's light end, so counting that end would prove nothing.
    const darkGold = async (ink) => {
      const { ctx } = await mount({
        initialText: 'MMM',
        initialInk: ink,
        initialSize: 96,
      });
      await waitFor(() => heading('KaTeX_Main'));
      const canvas = screen.getByTestName('specimen');
      let out = 0;
      await waitFor(async () => {
        out = await countPixels(
          ctx,
          {
            x: canvas.abs.x,
            y: canvas.abs.y,
            width: canvas.abs.width,
            height: canvas.abs.height,
          },
          '#b8860b',
          40,
        );
        assert.ok(out >= 0);
      });
      cleanup();
      return out;
    };

    assert.ok((await darkGold('gold')) > 20, 'no dark end to the gold ramp');
    assert.equal(await darkGold('plain'), 0, 'plain ink should carry no gold');
  });

  test('the specimen starts at its own left margin', async () => {
    // `layout.draw` applies the context's clip but **not** its transform
    // (ntk#280), so an origin in node coordinates puts the text at the
    // window's left edge, where the clip cuts nearly all of it away — 390
    // ink pixels inside the canvas instead of 4915. What survives lands
    // against the canvas's own left edge, so the margin being empty is the
    // assertion that tells the two apart. Every other pixel test in this
    // file passed with the text 264px out of place: they counted colours
    // over the whole canvas and never asked *where*.
    const { ctx } = await mount({
      initialText: 'MMM',
      initialInk: 'plain',
      initialSize: 96,
    });
    await waitFor(() => heading('KaTeX_Main'));

    const canvas = screen.getByTestName('specimen');
    const column = (dx, width) =>
      countPixels(
        ctx,
        {
          x: canvas.abs.x + dx,
          y: canvas.abs.y,
          width,
          height: canvas.abs.height,
        },
        '#f4f7ff',
        20,
      );

    await waitFor(async () =>
      assert.ok((await column(20, 24)) > 100, 'text should start at x = 18'),
    );
    assert.equal(await column(1, 12), 0, 'the left margin should be empty');
  });

  test('the hit test follows a line built from more than one slice', async () => {
    // A line's `runs` are slices, each with its own `x` and its own glyphs,
    // so a cursor that runs straight across the line lands on the wrong
    // glyph from the second slice onward. A space is enough to split one.
    await mount({ initialText: 'A B' });
    await waitFor(() => heading('KaTeX_Main'));

    const canvas = screen.getByTestName('specimen');
    // `A` is 22.50px from x = 18 and the space carries the rest, so 52 is
    // inside `B` and nowhere near `A`.
    await userEvent.hover(canvas, {
      dx: Math.round(52 - canvas.abs.width / 2),
      dy: 0,
    });

    await waitFor(() =>
      within(screen.getByTestName('glyph')).getByText(/U\+0042/),
    );
  });

  test('the size slider reaches 120, and the specimen draws there', async () => {
    // Driven through the control rather than the prop, because the request
    // was about the *range*: End jumps a Slider to its maximum, so this
    // fails if the cap goes back to 96. 120px is also a big shadow surface
    // and a layout that has to fit its box, which is the other half.
    const END = 0xff57;
    const { ctx } = await mount({ initialText: 'MMM', initialInk: 'plain' });
    await waitFor(() => heading('KaTeX_Main'));

    await userEvent.click(screen.getByTestName('size'));
    await userEvent.key(END);
    // `120px` also turns up in the metrics pane at this size, so the size
    // readout is found by its own exact text.
    await waitFor(() =>
      assert.ok(screen.queryAllByText(/^120px$/).length >= 1, 'size reads 120'),
    );

    const canvas = screen.getByTestName('specimen');
    await waitFor(async () =>
      assert.ok(
        (await countPixels(
          ctx,
          {
            x: canvas.abs.x,
            y: canvas.abs.y,
            width: canvas.abs.width,
            height: canvas.abs.height,
          },
          '#f4f7ff',
          20,
        )) > 200,
        'glyphs should be drawn at 120px',
      ),
    );
  });

  test('wrapping makes more lines, and the face keeps its line box', async () => {
    await mount({ initialText: SAMPLE_LONG, initialSize: 34 });
    await waitFor(() => heading('KaTeX_Main'));

    const summary = () =>
      textOf(within(screen.getByTestName('glyph')).getByText(/line box/));
    const lines = () => Number(summary().match(/^(\d+) line/)[1]);
    const box = () => Number(summary().match(/line box ([\d.]+)px/)[1]);

    assert.equal(lines(), 1);
    const single = box();

    await userEvent.click(screen.getByTestName('wrap'));
    await waitFor(() => assert.ok(lines() > 1, `wrapped, got ${lines()}`));
    // Wrapping changes the count, not the box.
    assert.ok(Math.abs(box() - single) < 0.01);
  });

  test('the line height multiplies the face, not the size', async () => {
    // Not CSS's `line-height`. `×2` doubles the face's **natural** line
    // height, which for KaTeX_Main is 1.265em — so at 34px the box is
    // 86.02px (2.53em) rather than 68px. Both ntk and `docs/styling.md` say
    // so, and getting it backwards is the easiest misreading of the control.
    await mount({
      initialText: SAMPLE_LONG,
      initialSize: 34,
      initialLineHeight: 2,
    });
    await waitFor(() => heading('KaTeX_Main'));

    assert.match(
      textOf(within(screen.getByTestName('glyph')).getByText(/line box/)),
      /line box 86\.02px \(2\.53em\)/,
    );
  });

  test('two faces of one collection are two rows, not one', async () => {
    // A `.ttc` is a collection: Helvetica and Helvetica-Light live in one
    // file. Keying selection on the path highlights both at once *and* opens
    // whichever the collection lists first, so the pane describes a face the
    // reader did not pick. Real collections are macOS-only, so the seam
    // supplies the shape.
    const asked = [];
    const collection = {
      kind: 'stub',
      match: () => [
        { path: '/stub/Duo.ttc', postscriptName: 'Duo-Regular' },
        { path: '/stub/Duo.ttc', postscriptName: 'Duo-Light' },
      ],
      open: (path, app, opts) => {
        asked.push(opts?.postscriptName ?? null);
        return {
          familyName: 'Duo',
          postscriptName: opts?.postscriptName ?? 'Duo-Regular',
          unitsPerEm: 1000,
          variationAxes: {},
          hasGlyph: () => true,
          metrics: () => ({
            ascent: 24,
            descent: 6,
            lineGap: 0,
            lineHeight: 30,
            capHeight: 20,
            xHeight: 13,
          }),
        };
      },
    };

    await mount({ catalogue: collection });
    await waitFor(() => heading('Duo'));

    const rows = () =>
      within(screen.getByTestName('matches')).getAllByRole('option');
    assert.equal(rows().length, 2);

    await userEvent.click(screen.getByRole('option', { name: 'Duo-Light' }));

    // The pane describes the face that was clicked…
    await waitFor(() => assert.equal(factValue('PostScript'), 'Duo-Light'));
    // …which means the catalogue was asked for it by name, not by path.
    assert.ok(
      asked.includes('Duo-Light'),
      `open() never asked for the face: ${JSON.stringify(asked)}`,
    );
  });

  test('the specimen grows with its text instead of clipping it', async () => {
    // A 120px line does not fit a 150px box, and the panes below should move
    // down rather than the text being cut.
    await mount({ initialText: 'Handgloves', initialSize: 30 });
    await waitFor(() => heading('KaTeX_Main'));
    const small = screen.getByTestName('specimen').abs.height;

    const END = 0xff57;
    await userEvent.click(screen.getByTestName('size'));
    await userEvent.key(END);

    await waitFor(() => {
      const grown = screen.getByTestName('specimen').abs.height;
      assert.ok(
        grown > small + 20,
        `the specimen should grow for 120px text: ${small} -> ${grown}`,
      );
      // …and the line still fits inside it.
      const box = Number(
        textOf(
          within(screen.getByTestName('glyph')).getByText(/line box/),
        ).match(/line box ([\d.]+)px/)[1],
      );
      assert.ok(grown >= box, `${grown} should hold a ${box}px line`);
    });
  });
});
