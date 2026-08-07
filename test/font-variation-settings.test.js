// `fontVariationSettings` — a variable font's axes on a `<text>`.
//
// react-x11's share of this is small and worth stating exactly: it carries
// the prop into the style ntk resolves a face from, and it decides when that
// changed. Instancing, clamping, keys and glyph caching are ntk's (ntk >=
// 7.1.0, its docs/fonts.md); the tests here are about the seam.
//
// "Carries it" has two halves that fail independently. `textStyleFrom` puts
// it on the paragraph style, and `collectSpans` puts it on each span — that
// second one enumerates its fields by hand, so a prop can be plumbed all the
// way to `<text>` and still be dropped on the way to a *nested* `<text>`.
// Hence the pixel tests: asserting on `textStyleFrom` alone passes while
// span overrides silently do nothing.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { StaticFontSource, createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import { DEFAULT_TEXT_STYLE, textStyleFrom } from '../src/styles.js';

const require = createRequire(import.meta.url);
const katexFonts = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);
const VF = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'MonelogicsSubset[wght].ttf',
);

const W = 260;
const H = 120;
// Weight does not widen every string — in this face "flat span" *narrows*
// as it gets heavier. This one widens, so the direction is safe to assert.
const SAMPLE = 'Handgloves';

// --- the seam ---------------------------------------------------------------

test('the prop reaches the style ntk resolves a face from', () => {
  const style = textStyleFrom(
    {
      fontFamily: 'X',
      fontSize: 20,
      fontVariationSettings: { wght: 460, wdth: 87.5 },
    },
    DEFAULT_TEXT_STYLE,
  );
  assert.deepEqual(style.variations, { wght: 460, wdth: 87.5 });
});

test('it inherits into spans, like every other text style prop', () => {
  const paragraph = textStyleFrom(
    { fontVariationSettings: { wght: 300 } },
    DEFAULT_TEXT_STYLE,
  );
  // a span that says nothing keeps the paragraph's axes...
  assert.deepEqual(textStyleFrom({}, paragraph).variations, { wght: 300 });
  // ...and one that does, overrides them
  assert.deepEqual(
    textStyleFrom({ fontVariationSettings: { wght: 800 } }, paragraph)
      .variations,
    { wght: 800 },
  );
});

test('nothing is carried when nothing was asked for', () => {
  assert.equal(
    textStyleFrom({ fontSize: 12 }, DEFAULT_TEXT_STYLE).variations,
    undefined,
  );
});

// --- pixels -----------------------------------------------------------------

function variableFontApp() {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(VF), { family: 'Test VF' });
  fontSource.add(readFileSync(join(katexFonts, 'KaTeX_Main-Regular.ttf')), {
    family: 'Static',
  });
  fontSource.alias('sans-serif', 'test vf');
  return createClient({ stream: clientEnd, fontSource });
}

const settled = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

const readPixels = (ctx) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, d) => (err ? reject(err) : resolve(d))),
  );

/** ink the text put down, the cheapest thing an axis moves */
function ink(image) {
  let n = 0;
  for (let i = 0; i < image.data.length; i += 4) if (image.data[i] < 128) n++;
  return n;
}

const label = (ref, variations) =>
  React.createElement(
    'window',
    { width: W, height: H, style: { backgroundColor: '#ffffff' } },
    React.createElement(
      'text',
      {
        ref,
        style: {
          fontFamily: 'Test VF',
          fontSize: 34,
          color: '#000000',
          alignSelf: 'flex-start',
          fontVariationSettings: variations,
        },
      },
      SAMPLE,
    ),
  );

async function renderAndRead(app, root, element, ref) {
  await new Promise((resolve) => root.render(element, resolve));
  await new Promise((r) => setImmediate(r));
  const node = ref.current;
  node.root.flush();
  await settled(app);
  const ctx = (node.root._ctx ??= node.root.window.getContext('2d'));
  // the geometry is snapshotted here, not handed back on the node: every
  // render returns the *same* node, so reading `abs` at assertion time would
  // compare the last frame with itself
  return { image: await readPixels(ctx), node, width: node.abs.width };
}

test('moving an axis re-measures and repaints', async () => {
  const app = await variableFontApp();
  const root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const thin = await renderAndRead(app, root, label(ref, { wght: 100 }), ref);
    const black = await renderAndRead(
      app,
      root,
      label(ref, { wght: 900 }),
      ref,
    );

    assert.ok(
      ink(black.image) > ink(thin.image) * 1.2,
      `wght 900 should be much heavier than 100, got ${ink(thin.image)} -> ${ink(black.image)}`,
    );
    assert.ok(
      black.width > thin.width,
      `and wider: ${thin.width} -> ${black.width}`,
    );
  } finally {
    await app.close();
  }
});

// A nested <text> is a style span, and spans are built by `collectSpans`,
// which names the fields it copies one at a time. A prop can therefore be
// plumbed correctly all the way to a top-level <text> and still vanish on a
// nested one — as this did, with `textStyleFrom` asserting green throughout.
test('a nested span carries its own axes', async () => {
  const app = await variableFontApp();
  const root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const paragraph = (spanAxes) =>
      React.createElement(
        'window',
        { width: W, height: H, style: { backgroundColor: '#ffffff' } },
        React.createElement(
          'text',
          {
            ref,
            style: {
              fontFamily: 'Test VF',
              fontSize: 34,
              color: '#000000',
              alignSelf: 'flex-start',
            },
          },
          React.createElement(
            'text',
            { style: { fontVariationSettings: spanAxes } },
            SAMPLE,
          ),
        ),
      );

    const flat = await renderAndRead(app, root, paragraph(undefined), ref);
    const heavy = await renderAndRead(app, root, paragraph({ wght: 900 }), ref);

    assert.ok(
      ink(heavy.image) > ink(flat.image) * 1.2,
      `the span should be heavier, got ${ink(flat.image)} -> ${ink(heavy.image)}`,
    );
    assert.ok(
      heavy.width > flat.width,
      `and the paragraph re-wraps around it: ${flat.width} -> ${heavy.width}`,
    );
  } finally {
    await app.close();
  }
});

test('an equal object literal does not re-measure', async () => {
  const app = await variableFontApp();
  const root = await createRoot({ app });
  try {
    const ref = React.createRef();
    await renderAndRead(app, root, label(ref, { wght: 700 }), ref);
    const node = ref.current;

    // React rebuilds sibling styles on every render, so this arrives as a
    // fresh object with identical contents on every commit. Believing `!==`
    // would re-shape the paragraph and re-rasterize its glyphs each time.
    let rebuilt = 0;
    const layouts = node._layouts;
    const clear = layouts.clear.bind(layouts);
    layouts.clear = () => {
      rebuilt++;
      clear();
    };

    await renderAndRead(app, root, label(ref, { wght: 700 }), ref);
    assert.equal(rebuilt, 0, 'same axes by value: nothing to redo');

    await renderAndRead(app, root, label(ref, { wght: 701 }), ref);
    assert.equal(rebuilt, 1, 'a real change still gets through');
  } finally {
    await app.close();
  }
});

test('a static face ignores axes rather than failing on them', async () => {
  const app = await variableFontApp();
  const root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const staticLabel = (variations) =>
      React.createElement(
        'window',
        { width: W, height: H, style: { backgroundColor: '#ffffff' } },
        React.createElement(
          'text',
          {
            ref,
            style: {
              fontFamily: 'Static',
              fontSize: 34,
              color: '#000000',
              alignSelf: 'flex-start',
              fontVariationSettings: variations,
            },
          },
          SAMPLE,
        ),
      );

    const plain = await renderAndRead(app, root, staticLabel(undefined), ref);
    const asked = await renderAndRead(
      app,
      root,
      staticLabel({ wght: 900 }),
      ref,
    );
    assert.equal(
      ink(asked.image),
      ink(plain.image),
      'a face with no axes is unmoved',
    );
  } finally {
    await app.close();
  }
});
