// The `<textarea>` selection highlight: what it costs, and what it draws.
//
// A selection spans lines and a line is a rectangle, so the drawing that
// falls out of the geometry is one fill per selected line — every line,
// whether or not the viewport shows it. Ctrl+A in a 400-line value then
// sends 400 masked composites to light seven lines of highlight, and the
// clip throws the other 393 away *after* they have crossed the wire, which
// is the one cost a clip cannot save.
//
// Both halves of the fix are pinned here: the lines the viewport cannot show
// are never drawn, and the ones it can go out as a single
// `Render.FillRectangles` (`ctx.fillRects`, ntk >= 7.6). Together they make
// the highlight cost a constant — which is what the first test measures, by
// selecting ten times as much text and expecting the same bill.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import { startTrace } from '../src/debug.js';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

const W = 240;
const H = 200;

async function headlessApp() {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');
  return createClient({ stream: clientEnd, fontSource });
}

/** Wait for the server to work through everything sent so far. */
const settled = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );

/** A focused `<textarea>` of `lines` lines with everything selected. */
async function selectedTextarea(app, lines) {
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  await new Promise((resolve) =>
    x11Root.render(
      React.createElement(
        'window',
        { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
        React.createElement(
          'box',
          { style: { flexGrow: 1, padding: 6 } },
          React.createElement('textarea', {
            ref,
            defaultValue: Array.from(
              { length: lines },
              (_, i) => `line ${i}`,
            ).join('\n'),
            style: { flexGrow: 1, backgroundColor: '#ffffff' },
          }),
        ),
      ),
      resolve,
    ),
  );
  await new Promise((r) => setImmediate(r));
  const node = ref.current;
  node.focus();
  node._selectAll();
  const root = node.root;
  root.flush(); // the first paint, with its glyph uploads and clip masks
  await settled(app);
  return { node, root };
}

/** Requests the server sees for one repaint of the field. */
async function repaintCost(app, lines) {
  const { node, root } = await selectedTextarea(app, lines);
  const trace = startTrace({ app });
  node._repaint();
  root.flush();
  await settled(app);
  return trace.stop().requests;
}

test('the selection highlight costs the same however much is selected', async () => {
  const short = await headlessApp();
  const long = await headlessApp();
  try {
    const few = await repaintCost(short, 40);
    const many = await repaintCost(long, 400);
    // Ten times the selection, the same viewport. Not `===`: the values
    // differ ("line 39" against "line 399"), so a glyph page can land on
    // one side and not the other. Per-line fills would put ~360 requests
    // between these.
    assert.ok(
      Math.abs(many - few) <= 8,
      `40 selected lines cost ${few} requests, 400 cost ${many}`,
    );
  } finally {
    await short.close();
    await long.close();
  }
});

test('the batch paints exactly what a fill per line painted', async () => {
  const app = await headlessApp();
  try {
    const { node, root } = await selectedTextarea(app, 400);
    const ctx = root._ctx;

    // What the highlight actually asked for: one batch, and only the lines
    // the field can show. Both are what makes the comparison below a test of
    // the batched path rather than of two identical frames.
    const real = ctx.fillRects.bind(ctx);
    const batches = [];
    ctx.fillRects = (rects) => {
      batches.push(rects.length / 4);
      return real(rects);
    };
    node._repaint();
    root.flush();
    await settled(app);
    assert.strictEqual(batches.length, 1, 'the highlight is one batch');
    const visibleLines = Math.ceil(
      node.contentBox().height / node._valueLayout().lines[0].height,
    );
    assert.ok(
      batches[0] <= visibleLines + 2,
      `${batches[0]} rectangles for a field showing about ${visibleLines} lines`,
    );
    const batched = await readPixels(ctx, W, H);

    // ntk's own fallback for a gradient or a transformed context: the same
    // rectangles, one `fillRect` each. The pixels must not be able to tell.
    ctx.fillRects = (rects) => {
      const flat = Array.isArray(rects[0]) ? rects.flat() : rects;
      for (let i = 0; i + 3 < flat.length; i += 4) {
        ctx.fillRect(flat[i], flat[i + 1], flat[i + 2], flat[i + 3]);
      }
    };
    node._repaint();
    root.flush();
    await settled(app);
    const perLine = await readPixels(ctx, W, H);
    ctx.fillRects = real;

    let differences = 0;
    for (let i = 0; i < batched.data.length; i++) {
      if (batched.data[i] !== perLine.data[i]) differences++;
    }
    assert.strictEqual(differences, 0, `${differences} bytes differ`);

    // …and the highlight is actually on screen, so the comparison above is
    // not two identical blanks: the field's first line carries pixels that
    // the window background does not.
    const at = (x, y) => {
      const i = (y * W + x) * 4;
      return [batched.data[i], batched.data[i + 1], batched.data[i + 2]];
    };
    const field = node.contentBox();
    const inside = at(
      Math.round(field.x + 2),
      Math.round(field.y + field.height / 2),
    );
    assert.notDeepStrictEqual(
      inside,
      [255, 255, 255],
      'the selection tint should be over the field, not plain white',
    );
  } finally {
    await app.close();
  }
});
