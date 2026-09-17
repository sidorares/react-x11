// `letterSpacing`, `fontVariantNumeric` and `fontFeatureSettings` (#588):
// the space between letters, and the OpenType features — `tabular-nums` above
// all, the figures a live readout needs so that it holds its width while its
// digits change.
//
// react-x11's share is the vocabulary and the cascade: checking the values,
// inheriting them the way CSS does, resolving the two feature properties into
// the one tag bag the engines read, putting the spacing in device pixels, and
// deciding when a change re-measures. The shaping is the engines': ntk's on
// X11 (its docs/text.md, "Letter spacing and features") and CoreText's through
// `@windowkit/appkit` on Cocoa (cocoa-text-features.test.js).
//
// The widths are real text in Inter, which has proportional figures by
// default and tabular ones behind `tnum`: a `1` is much narrower than an `8`
// until the feature is on. Widths rather than pixels, since the width is what
// a readout that jitters gets wrong, and a width is exact.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';
import React from 'react';

import { measureLabel } from '../src/components/anchor.js';
import { createRoot } from '../src/index.js';
import {
  createStyles,
  DEFAULT_TEXT_STYLE,
  featuresOf,
  textStyleFrom,
} from '../src/styles.js';
import { cleanup, renderX11 } from '../src/testing/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const require = createRequire(import.meta.url);
const INTER =
  require.resolve('@fontsource/inter/files/inter-latin-400-normal.woff');
const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(cleanup);

// Every tree is rendered in the same column, and a rerender has to hand in
// the column too: without it React replaces the node under test with a new
// one, which measures fresh and proves nothing about invalidation.
const column = (children) =>
  h(
    'box',
    { style: { flexDirection: 'column', alignItems: 'flex-start' } },
    children,
  );

const render = (children, options) =>
  renderX11(column(children), {
    fonts: { 'sans-serif': INTER },
    width: 300,
    height: 300,
    ...options,
  });

const label = (ref, style, text) =>
  h('text', { ref, style: { fontSize: 30, ...style } }, text);

// --- figures ----------------------------------------------------------------

test('tabular-nums gives every digit one width', async () => {
  const refs = [0, 1, 2, 3].map(() => React.createRef());
  await render([
    label(refs[0], {}, '1111'),
    label(refs[1], {}, '8888'),
    label(refs[2], { fontVariantNumeric: 'tabular-nums' }, '1111'),
    label(refs[3], { fontVariantNumeric: 'tabular-nums' }, '8888'),
  ]);
  const [ones, eights, tabularOnes, tabularEights] = refs.map(
    (ref) => ref.current.abs.width,
  );
  // the control: without the feature this face's figures are proportional,
  // so the assertion below is about the feature and not about the face
  assert.ok(ones < eights - 10, `proportional: ${ones} against ${eights}`);
  assert.equal(tabularOnes, tabularEights);
});

test('fontFeatureSettings names the same feature by its tag', async () => {
  const refs = [0, 1, 2, 3].map(() => React.createRef());
  await render([
    label(refs[0], { fontFeatureSettings: ['tnum'] }, '1111'),
    label(refs[1], { fontFeatureSettings: { tnum: true } }, '8888'),
    // …and wins over the keyword where the two meet, as in CSS
    label(
      refs[2],
      { fontVariantNumeric: 'tabular-nums', fontFeatureSettings: { tnum: 0 } },
      '1111',
    ),
    label(refs[3], {}, '1111'),
  ]);
  const [ones, eights, overridden, plain] = refs.map(
    (ref) => ref.current.abs.width,
  );
  assert.equal(ones, eights);
  assert.equal(overridden, plain);
});

// A nested <text> is a span, and `collectSpans` names the fields it copies
// one at a time: a property can reach a top-level <text> and still be dropped
// on the way to a nested one (font-variation-settings.test.js has the story).
test('a nested span carries its own figures and its own spacing', async () => {
  const refs = [0, 1, 2, 3].map(() => React.createRef());
  await render([
    label(
      refs[0],
      {},
      h('text', { style: { fontVariantNumeric: 'tabular-nums' } }, '1111'),
    ),
    label(refs[1], { fontVariantNumeric: 'tabular-nums' }, '1111'),
    label(refs[2], {}, h('text', { style: { letterSpacing: 4 } }, 'abc')),
    label(refs[3], { letterSpacing: 4 }, 'abc'),
  ]);
  const [spanFigures, figures, spanSpacing, spacing] = refs.map(
    (ref) => ref.current.abs.width,
  );
  assert.equal(spanFigures, figures);
  assert.equal(spanSpacing, spacing);
});

// --- letter spacing ---------------------------------------------------------

test('letterSpacing is added after every letter, the last one included', async () => {
  const refs = [0, 1, 2].map(() => React.createRef());
  await render([
    label(refs[0], {}, 'abc'),
    label(refs[1], { letterSpacing: 4 }, 'abc'),
    label(refs[2], { letterSpacing: -2 }, 'abc'),
  ]);
  const [plain, spaced, tight] = refs.map((ref) => ref.current.abs.width);
  assert.equal(spaced, plain + 3 * 4);
  // negative tightens; the box is whole pixels, the spacing need not be
  assert.ok(Math.abs(tight - (plain - 3 * 2)) <= 1, `${plain} -> ${tight}`);
});

test('letterSpacing is in logical pixels, like every length', async () => {
  const refs = [0, 1].map(() => React.createRef());
  await render(
    [label(refs[0], {}, 'abc'), label(refs[1], { letterSpacing: 4 }, 'abc')],
    { scale: 2 },
  );
  const [plain, spaced] = refs.map((ref) => ref.current.abs.width);
  assert.equal(spaced, plain + 3 * 4 * 2, 'device pixels at scale 2');
});

test('all three inherit across a box, and a node of its own wins', async () => {
  const refs = [0, 1, 2, 3, 4].map(() => React.createRef());
  await render([
    h(
      'box',
      {
        style: {
          alignItems: 'flex-start',
          letterSpacing: 4,
          fontVariantNumeric: 'tabular-nums',
        },
      },
      label(refs[0], {}, '1111'),
      label(refs[1], {}, '8888'),
      label(
        refs[2],
        { letterSpacing: 0, fontVariantNumeric: 'normal' },
        '1111',
      ),
    ),
    label(refs[3], { fontVariantNumeric: 'tabular-nums' }, '1111'),
    label(refs[4], {}, '1111'),
  ]);
  const [ones, eights, own, tabular, plain] = refs.map(
    (ref) => ref.current.abs.width,
  );
  assert.equal(ones, eights, 'the figures came down');
  assert.equal(ones, tabular + 4 * 4, 'and so did the spacing');
  assert.equal(own, plain, 'normal and zero put both back');
});

test('a change re-measures, and an equal settings literal does not', async () => {
  const ref = React.createRef();
  const tree = (style) => label(ref, style, '1111');
  const api = await render(tree({ fontFeatureSettings: { tnum: true } }));
  const node = ref.current;
  const tabular = node.abs.width;

  // React hands a fresh object with the same contents on every render, and
  // believing `!==` would re-shape the paragraph each time
  let rebuilt = 0;
  const layouts = node._layouts;
  const clear = layouts.clear.bind(layouts);
  layouts.clear = () => {
    rebuilt++;
    clear();
  };
  await api.rerender(column(tree({ fontFeatureSettings: { tnum: true } })));
  assert.ok(ref.current === node, 'the same node, updated');
  assert.equal(rebuilt, 0, 'same features by value: nothing to redo');

  await api.rerender(column(tree({ fontFeatureSettings: { tnum: false } })));
  assert.equal(rebuilt, 1, 'a real change still gets through');
  assert.ok(node.abs.width < tabular, `${tabular} -> ${node.abs.width}`);

  // the spacing alone, the features left as they were
  await api.rerender(
    column(tree({ fontFeatureSettings: { tnum: false }, letterSpacing: 2 })),
  );
  assert.equal(rebuilt, 2, 'and so does the spacing');
});

// A field keeps its value's layout keyed by the style it was shaped with,
// and that key is written out field by field: a property missing from it is
// a caret placed against the old glyphs after the style changed.
for (const element of ['textinput', 'textarea']) {
  test(`a <${element}> lays its value out with the figures and spacing it inherits`, async () => {
    const ref = React.createRef();
    const tree = (style) =>
      h(
        'box',
        { style: { alignSelf: 'stretch', ...style } },
        h(element, { ref, value: '1111', style: { fontSize: 30 } }),
      );
    const api = await render(tree({}));
    const node = ref.current;
    const plain = node._valueLayout().lines[0].width;

    await api.rerender(column(tree({ fontVariantNumeric: 'tabular-nums' })));
    assert.ok(ref.current === node, 'the same field, updated');
    const tabular = node._valueLayout().lines[0].width;
    assert.ok(tabular > plain + 10, `${plain} -> ${tabular}`);

    await api.rerender(
      column(tree({ fontVariantNumeric: 'tabular-nums', letterSpacing: 4 })),
    );
    assert.equal(node._valueLayout().lines[0].width, tabular + 4 * 4);
  });
}

test('a popup label is measured with the spacing and figures it will be drawn with', async () => {
  const refs = [0, 1, 2].map(() => React.createRef());
  await render(
    [
      h(
        'box',
        { style: { letterSpacing: 4 } },
        h('text', { ref: refs[0] }, 'x'),
      ),
      h(
        'box',
        { style: { fontVariantNumeric: 'tabular-nums' } },
        h('text', { ref: refs[1] }, 'x'),
      ),
      h('text', { ref: refs[2] }, 'x'),
    ],
    { scale: 2 },
  );
  // the node a Menu or a Select measures from: its rows inherit what it does
  const measure = (i, text) =>
    measureLabel(refs[i].current, text, { size: 30 }).width;
  const [spaced, plain] = [measure(0, 'abc'), measure(2, 'abc')];
  assert.ok(Math.abs(spaced - (plain + 3 * 4)) < 0.01, `${plain} -> ${spaced}`);
  assert.ok(
    Math.abs(measure(1, '1111') - measure(1, '8888')) < 0.01,
    'tabular figures are one width',
  );
  assert.ok(measure(2, '1111') < measure(2, '8888') - 5, 'the control');
});

// --- the cascade ------------------------------------------------------------

test('the two feature properties inherit apart and resolve together', () => {
  const parent = textStyleFrom(
    { fontVariantNumeric: 'tabular-nums', fontFeatureSettings: { zero: 1 } },
    DEFAULT_TEXT_STYLE,
  );
  assert.deepEqual(parent.features, { tnum: 1, zero: 1 });
  // a keyword below replaces the keyword above and leaves the settings be
  const child = textStyleFrom({ fontVariantNumeric: 'oldstyle-nums' }, parent);
  assert.deepEqual(child.features, { onum: 1, zero: 1 });
  assert.deepEqual(
    textStyleFrom({ fontVariantNumeric: 'normal' }, parent).features,
    { zero: 1 },
  );
  // nothing asked for is nothing handed to the engines
  assert.equal(
    textStyleFrom({ fontSize: 12 }, DEFAULT_TEXT_STYLE).features,
    undefined,
  );
  assert.equal(featuresOf('normal', undefined), undefined);
  // and the same pair is the same object, which is what a cascade compares
  assert.ok(
    featuresOf('tabular-nums', { zero: true }) ===
      featuresOf('tabular-nums', { zero: true }),
  );
  assert.deepEqual(featuresOf(undefined, { salt: 2, liga: false }), {
    salt: 2,
    liga: 0,
  });
});

test('across a scale boundary the spacing is re-expressed, like the size', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { width: 200, height: 200 },
      h(
        'box',
        { style: { letterSpacing: 2 } },
        h(
          'box',
          { scale: 2 },
          h('text', null, 'zoomed'),
          h('popup', { width: 50, height: 20 }, h('text', null, 'menu')),
        ),
      ),
    ),
  );
  await tick();
  const outer = app.windows[0]._reactX11Node.children[0];
  const zoomed = outer.children[0];
  const popup = zoomed.children.find((node) => node.isWindow);
  assert.equal(outer.resolvedTextStyle().letterSpacing, 2);
  assert.equal(zoomed.children[0].resolvedTextStyle().letterSpacing, 4);
  // a popup is its own root: back at the display's unit
  assert.equal(popup.children[0].resolvedTextStyle().letterSpacing, 2);
  await root.unmount();
});

test('a value that is not one says what to write', () => {
  const bad = [
    [
      { letterSpacing: '2px' },
      /invalid letterSpacing "2px".*a number of pixels/,
    ],
    [{ fontVariantNumeric: 'tabular' }, /invalid fontVariantNumeric "tabular"/],
    // two from one group contradict each other, so CSS refuses the pair
    [
      { fontVariantNumeric: 'lining-nums oldstyle-nums' },
      /invalid fontVariantNumeric "lining-nums oldstyle-nums"/,
    ],
    [{ fontFeatureSettings: 'tnum' }, /invalid fontFeatureSettings "tnum"/],
    [{ fontFeatureSettings: ['tnum1'] }, /invalid fontFeatureSettings/],
    [{ fontFeatureSettings: { tnum: 'on' } }, /invalid fontFeatureSettings/],
    [{ fontFeatureSettings: { salt: -1 } }, /invalid fontFeatureSettings/],
  ];
  for (const [style, message] of bad) {
    assert.throws(() => createStyles({ bad: style }), message);
  }
  // the ones that are, a token and unset among them
  createStyles({
    spaced: { letterSpacing: -0.33 },
    themed: { letterSpacing: '$tracking' },
    unset: { letterSpacing: undefined, fontVariantNumeric: undefined },
    figures: { fontVariantNumeric: 'lining-nums tabular-nums slashed-zero' },
    normal: { fontVariantNumeric: 'normal' },
    tags: { fontFeatureSettings: ['tnum', 'ss01'] },
    values: { fontFeatureSettings: { liga: false, salt: 2, cv11: true } },
  });
});
