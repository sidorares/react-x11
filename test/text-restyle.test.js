// Restyling text re-measures it.
//
// `fontSize`, `fontWeight`, `fontFamily`, `fontStyle`, `lineHeight` and
// `textAlign` are the inputs to a `<text>`'s measure function, and none of
// them is a yoga property or a paint property. So a commit that changes one
// and nothing else reaches `applyProps` with nothing for `applyLayoutStyle`
// to notice and nothing for `_paintChanged` to claim — the frame is already
// decided by the time `TextNode.applyProps` marks the layout dirty. Ask for
// no relayout there and the cleared layout is never rebuilt: React's state
// is new, the node's props are new, the font manager hands back the right
// face, and the old glyphs stay on the screen with nothing reporting an
// error. Every test here changes exactly one of those properties and looks
// at the pixels.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

const W = 240;
const H = 120;

// Three real faces of one family, so `fontWeight` and `fontStyle` have
// somewhere to land: matching them is what the renderer is being asked to
// redo, and a family with one face would pass this test without moving.
async function headlessApp() {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  const add = (file, opts) =>
    fontSource.add(readFileSync(join(fontDir, file)), {
      family: 'Test Main',
      ...opts,
    });
  add('KaTeX_Main-Regular.ttf', { weight: 400 });
  add('KaTeX_Main-Bold.ttf', { weight: 700 });
  add('KaTeX_Main-Italic.ttf', { style: 'italic' });
  fontSource.alias('sans-serif', 'Test Main');
  return createClient({ stream: clientEnd, fontSource });
}

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );

const settled = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

/** How many pixels the text put ink in. */
function ink(image) {
  let n = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i] < 128) n++;
  }
  return n;
}

/**
 * Render `element`, paint the frame it asked for, and read the window back.
 * The second call onward is the one under test: it is an ordinary React
 * update, which is how a restyle actually arrives.
 */
async function renderAndRead(app, x11Root, element, ref) {
  await new Promise((resolve) => x11Root.render(element, resolve));
  await new Promise((r) => setImmediate(r));
  const node = ref.current;
  node.root.flush();
  await settled(app);
  const ctx = (node.root._ctx ??= node.root.window.getContext('2d'));
  return { image: await readPixels(ctx, W, H), node };
}

// `alignSelf: 'flex-start'` so the box is the measured text rather than the
// window's width — which is what makes `abs.width` evidence that the
// measure function ran again, and not just that something repainted.
const label = (ref, style) =>
  React.createElement(
    'window',
    { width: W, height: H, style: { backgroundColor: '#ffffff' } },
    React.createElement(
      'text',
      { ref, style: { color: '#000000', alignSelf: 'flex-start', ...style } },
      'Handgloves',
    ),
  );

/**
 * Restyle one `<text>` and report what moved: the ink on the screen and the
 * width yoga measured it at.
 */
async function restyle(from, to) {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const first = await renderAndRead(app, x11Root, label(ref, from), ref);
    const before = { ink: ink(first.image), width: first.node.abs.width };
    const second = await renderAndRead(app, x11Root, label(ref, to), ref);
    return {
      before,
      after: { ink: ink(second.image), width: second.node.abs.width },
    };
  } finally {
    await app.close();
  }
}

test('a bigger fontSize re-measures and repaints', async () => {
  const { before, after } = await restyle({ fontSize: 12 }, { fontSize: 28 });
  assert.ok(
    after.ink > before.ink * 1.5,
    `28px should put down much more ink than 12px, got ${before.ink} -> ${after.ink}`,
  );
  assert.ok(
    after.width > before.width,
    `the measured box should grow, got ${before.width} -> ${after.width}`,
  );
});

test('a smaller fontSize re-measures and repaints', async () => {
  const { before, after } = await restyle({ fontSize: 28 }, { fontSize: 12 });
  assert.ok(
    after.ink < before.ink,
    `12px should put down less ink than 28px, got ${before.ink} -> ${after.ink}`,
  );
  assert.ok(
    after.width < before.width,
    `the measured box should shrink, got ${before.width} -> ${after.width}`,
  );
});

test('a new fontWeight picks up the bold face', async () => {
  const { before, after } = await restyle(
    { fontSize: 24, fontWeight: 400 },
    { fontSize: 24, fontWeight: 700 },
  );
  assert.ok(
    after.ink > before.ink,
    `bold is heavier than regular, got ${before.ink} -> ${after.ink}`,
  );
});

test('a new fontStyle picks up the italic face', async () => {
  const { before, after } = await restyle(
    { fontSize: 24, fontStyle: 'normal' },
    { fontSize: 24, fontStyle: 'italic' },
  );
  assert.notEqual(
    after.ink,
    before.ink,
    'the italic face draws different glyphs from the roman',
  );
});

// The span has no yoga node of its own — the paragraph it belongs to owns
// the measure function, so the invalidation has to walk up to it. Restyling
// a span used to leave the paragraph laid out for the old style.
test('restyling a nested span re-measures the paragraph', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const paragraph = (spanStyle) =>
      React.createElement(
        'window',
        { width: W, height: H, style: { backgroundColor: '#ffffff' } },
        React.createElement(
          'text',
          {
            ref,
            style: {
              fontSize: 12,
              color: '#000000',
              alignSelf: 'flex-start',
            },
          },
          'plain ',
          React.createElement('text', { style: spanStyle }, 'span'),
        ),
      );

    const first = await renderAndRead(app, x11Root, paragraph({}), ref);
    const before = { ink: ink(first.image), width: first.node.abs.width };
    const second = await renderAndRead(
      app,
      x11Root,
      paragraph({ fontSize: 30 }),
      ref,
    );

    assert.ok(
      ink(second.image) > before.ink,
      `the span got bigger, got ${before.ink} -> ${ink(second.image)}`,
    );
    assert.ok(
      second.node.abs.width > before.width,
      `the paragraph re-wraps around it, got ${before.width} -> ${second.node.abs.width}`,
    );
  } finally {
    await app.close();
  }
});
