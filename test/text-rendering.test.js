// `textRendering` — which glyph path a `<text>` takes.
//
// ntk decides that from size by default, which is a good guess for UI text
// and a bad one for a headline whose weight is under a slider: on the cached
// path glyph origins round to whole pixels, so as advances drift by
// hundredths one glyph eventually jumps a whole pixel by itself. This is how
// a `<text>` says which it wants.
//
// react-x11's share is the same two halves as `fontVariationSettings` —
// carrying it onto the paragraph *and* onto nested spans — plus one thing
// that property did not have: it must **not** reflow. Only draw-time
// rounding differs, and ntk's layout measures byte-identically for every
// value, so a change here is a repaint and nothing more.
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

const W = 300;
const H = 140;
const SAMPLE = 'Handgloves';

// --- the seam ---------------------------------------------------------------

test('the prop reaches the style ntk resolves a run with', () => {
  const style = textStyleFrom(
    { fontSize: 20, textRendering: 'geometricPrecision' },
    DEFAULT_TEXT_STYLE,
  );
  assert.equal(style.textRendering, 'geometricPrecision');
});

test('it inherits into spans, and a span may override it', () => {
  const paragraph = textStyleFrom(
    { textRendering: 'geometricPrecision' },
    DEFAULT_TEXT_STYLE,
  );
  assert.equal(
    textStyleFrom({}, paragraph).textRendering,
    'geometricPrecision',
  );
  assert.equal(
    textStyleFrom({ textRendering: 'optimizeSpeed' }, paragraph).textRendering,
    'optimizeSpeed',
  );
});

test('nothing is carried when nothing was asked for', () => {
  assert.equal(
    textStyleFrom({ fontSize: 12 }, DEFAULT_TEXT_STYLE).textRendering,
    undefined,
  );
});

// --- pixels -----------------------------------------------------------------

function app() {
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

const settled = (a) => new Promise((r) => a.X.GetInputFocus(() => r()));
const readPixels = (ctx) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, d) => (err ? reject(err) : resolve(d))),
  );

/** coverage-weighted ink centroid — where the text actually sits */
function centroid(image) {
  let sum = 0;
  let weighted = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = 255 - image.data[(y * W + x) * 4];
      if (c > 8) {
        sum += c;
        weighted += c * x;
      }
    }
  }
  return sum ? weighted / sum : 0;
}

// Yoga hands `<text>` a whole-pixel origin, so the difference reachable from
// here is the one that matters anyway: *advances*. The cached path bakes an
// integer advance into each glyph, so ten glyphs of "Handgloves" accumulate
// ten roundings; the precise path puts each where shaping asked.
const label = (ref, textRendering, left = 20) =>
  React.createElement(
    'window',
    { width: W, height: H, style: { backgroundColor: '#ffffff' } },
    React.createElement(
      'box',
      { style: { paddingLeft: left, alignItems: 'flex-start' } },
      React.createElement(
        'text',
        {
          ref,
          style: {
            fontFamily: 'Test VF',
            fontSize: 30,
            color: '#000000',
            alignSelf: 'flex-start',
            textRendering,
          },
        },
        SAMPLE,
      ),
    ),
  );

async function renderAndRead(a, root, element, ref) {
  await new Promise((resolve) => root.render(element, resolve));
  await new Promise((r) => setImmediate(r));
  const node = ref.current;
  node.root.flush();
  await settled(a);
  const ctx = (node.root._ctx ??= node.root.window.getContext('2d'));
  return { image: await readPixels(ctx), node, width: node.abs.width };
}

test('geometricPrecision reaches ntk and places glyphs differently', async () => {
  const a = await app();
  const client = await createRoot({ app: a });
  try {
    const ref = React.createRef();
    // 30px: the size thresholds would put this on the cached path
    const auto = await renderAndRead(a, client, label(ref, 'auto'), ref);
    const fine = await renderAndRead(
      a,
      client,
      label(ref, 'geometricPrecision'),
      ref,
    );
    const speed = await renderAndRead(
      a,
      client,
      label(ref, 'optimizeSpeed'),
      ref,
    );

    assert.notEqual(
      centroid(fine.image).toFixed(3),
      centroid(auto.image).toFixed(3),
      'unrounded advances put the ink somewhere the rounded ones cannot',
    );
    assert.equal(
      centroid(speed.image).toFixed(3),
      centroid(auto.image).toFixed(3),
      'optimizeSpeed is what auto already chose at this size',
    );
  } finally {
    await a.close();
  }
});

test('changing it repaints and does not reflow', async () => {
  const a = await app();
  const client = await createRoot({ app: a });
  try {
    const ref = React.createRef();
    const first = await renderAndRead(a, client, label(ref, 'auto', 20), ref);
    const node = ref.current;

    // the measure function is the reflow: count the times yoga asks for one
    let measured = 0;
    const dirty = node.yoga.markDirty.bind(node.yoga);
    node.yoga.markDirty = () => {
      measured++;
      dirty();
    };
    let layoutsCleared = 0;
    const clear = node._layouts.clear.bind(node._layouts);
    node._layouts.clear = () => {
      layoutsCleared++;
      clear();
    };

    const second = await renderAndRead(
      a,
      client,
      label(ref, 'geometricPrecision', 20),
      ref,
    );

    assert.equal(measured, 0, 'a draw-only property must not dirty the layout');
    assert.equal(layoutsCleared, 1, 'but the cached layout still has to go');
    assert.equal(second.width, first.width, 'and the box cannot have moved');
  } finally {
    await a.close();
  }
});

test('a nested span carries its own value', async () => {
  const a = await app();
  const client = await createRoot({ app: a });
  try {
    const ref = React.createRef();
    const paragraph = (spanRendering, left) =>
      React.createElement(
        'window',
        { width: W, height: H, style: { backgroundColor: '#ffffff' } },
        React.createElement(
          'box',
          { style: { paddingLeft: left, alignItems: 'flex-start' } },
          React.createElement(
            'text',
            {
              ref,
              style: {
                fontFamily: 'Test VF',
                fontSize: 30,
                color: '#000000',
                alignSelf: 'flex-start',
              },
            },
            React.createElement(
              'text',
              { style: { textRendering: spanRendering } },
              SAMPLE,
            ),
          ),
        ),
      );

    const plain = await renderAndRead(a, client, paragraph('auto', 20), ref);
    const precise = await renderAndRead(
      a,
      client,
      paragraph('geometricPrecision', 20),
      ref,
    );

    assert.notEqual(
      centroid(precise.image).toFixed(3),
      centroid(plain.image).toFixed(3),
      'a span that asks for precision gets it — collectSpans has to carry it',
    );
  } finally {
    await a.close();
  }
});
