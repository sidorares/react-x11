// A paragraph whose ink lies outside its box. A word too wide for its box,
// with nowhere to break, is drawn whole across the box's edge; a box trimmed
// to its capitals (`textBoxTrim`) leaves its descenders and tall ascenders
// outside it by design. A change that repaints the paragraph claimed the box,
// so the ink outside kept its old colour or stayed after its word had gone —
// and a repaint under the ink culled the paragraph by its box, and lost it.
//
// Held to pixels: each frame as it was painted against the same state painted
// again from scratch. Found by a random differential of exactly that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';

const h = React.createElement;
const require = createRequire(import.meta.url);
const W = 240;
const H = 100;

async function createHeadlessApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(
    readFileSync(
      join(
        dirname(require.resolve('katex/package.json')),
        'dist',
        'fonts',
        'KaTeX_Main-Regular.ttf',
      ),
    ),
    { family: 'Test Main' },
  );
  fontSource.alias('sans-serif', 'Test Main');
  return await createClient({ stream: clientEnd, fontSource });
}

const settle = (app) =>
  new Promise((resolve, reject) =>
    app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
  );

const readPixels = (ctx) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, data) =>
      err ? reject(err) : resolve(Buffer.from(data.data)),
    ),
  );

/** Render `scene(a)`, then `scene(b)`, and compare that frame with a full
 *  repaint of the same state. */
async function frameMatchesRepaint(t, scene, a, b) {
  const app = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await x11Root.unmount();
    await app.close();
  });
  const render = (state) =>
    new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: W, height: H, style: { backgroundColor: '#ffffff' } },
          scene(state),
        ),
        resolve,
      ),
    );
  const root = (await render(a))._reactX11Node;
  const frame = async () => {
    root._scheduled = false;
    root.flush();
    await settle(app);
  };
  await frame();
  await frame();
  await render(b);
  await frame();
  const painted = await readPixels(root._ctx);
  root.invalidate(false);
  await frame();
  const repainted = await readPixels(root._ctx);
  return painted.equals(repainted);
}

// a word six pixels of box cannot hold, with nowhere to break
const overflowing = ({ color = '#26a269', word = 'Overflowing' }) =>
  h(
    'box',
    { style: { padding: 10, flexDirection: 'row' } },
    h(
      'box',
      { style: { width: 6, backgroundColor: '#dbe4ee' } },
      h('text', { style: { color, fontSize: 16 } }, word),
    ),
  );

const trimmed = ({ color = '#26a269', word = 'gypsy jog' }) =>
  h(
    'box',
    { style: { padding: 10 } },
    h(
      'text',
      { style: { color, fontSize: 16, textBoxTrim: 'cap-alphabetic' } },
      word,
    ),
  );

test('a word wider than its box is recoloured past the box', async (t) => {
  assert.ok(
    await frameMatchesRepaint(t, overflowing, {}, { color: '#e01b24' }),
  );
});

test('a word wider than its box, changed, leaves none of the old word', async (t) => {
  assert.ok(await frameMatchesRepaint(t, overflowing, {}, { word: 'Over' }));
});

test('a trimmed label is recoloured down to its descenders', async (t) => {
  assert.ok(await frameMatchesRepaint(t, trimmed, {}, { color: '#e01b24' }));
});

test('a trimmed label, changed, leaves none of the old descenders', async (t) => {
  assert.ok(await frameMatchesRepaint(t, trimmed, {}, { word: 'HALT' }));
});

test('a repaint under a word’s overflow paints the word over it again', async (t) => {
  // the box under the ink is painted before the paragraph, so a repaint of
  // it has to bring the ink back — the paragraph is not culled by its box
  const under = ({ fill = '#dbe4ee' }) =>
    h(
      'box',
      { style: { padding: 10 } },
      h('box', {
        style: {
          position: 'absolute',
          left: 30,
          top: 8,
          width: 60,
          height: 26,
          backgroundColor: fill,
        },
      }),
      h(
        'box',
        { style: { width: 6 } },
        h('text', { style: { color: '#20304a', fontSize: 16 } }, 'Overflowing'),
      ),
    );
  assert.ok(await frameMatchesRepaint(t, under, {}, { fill: '#f6d32d' }));
});

test('a word overflowing inside a translucent box shows its overflow from its first frame', async (t) => {
  // `opacity` draws the subtree into a surface the size of its paint
  // bounds, and those were measured before the paragraph had ever drawn —
  // before the ink past its box was known — so the first frame cut the
  // overflow off at the box, and a repaint later drew it.
  const app = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await x11Root.unmount();
    await app.close();
  });
  const root = (
    await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: W, height: H, style: { backgroundColor: '#ffffff' } },
          h(
            'box',
            { style: { padding: 10 } },
            h(
              'box',
              { style: { width: 6, opacity: 0.5 } },
              h(
                'text',
                { style: { color: '#20304a', fontSize: 16 } },
                'Overflowing',
              ),
            ),
          ),
        ),
        resolve,
      ),
    )
  )._reactX11Node;
  const frame = async () => {
    root._scheduled = false;
    root.flush();
    await settle(app);
  };
  await frame();
  const first = await readPixels(root._ctx);
  root.invalidate(false);
  await frame();
  const repainted = await readPixels(root._ctx);
  assert.ok(first.equals(repainted));
});

test('a label its box leaves no width, inside a translucent box, shows its overflow from its first frame', async (t) => {
  // The surface a fade draws into is sized before the subtree draws, and a
  // paragraph in a box of no width is drawn unwrapped — at a width no
  // measure laid it out at — so the ink past its box was not known until
  // it drew, after the surface was cut to the box. The first frame lost the
  // overflow, and every frame after drew it.
  const app = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await x11Root.unmount();
    await app.close();
  });
  const root = (
    await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: W, height: H, style: { backgroundColor: '#ffffff' } },
          h(
            'box',
            { style: { padding: 10 } },
            h(
              'box',
              { style: { width: 20, opacity: 0.8 } },
              h(
                'box',
                { style: { width: 0 } },
                h(
                  'text',
                  { style: { color: '#20304a', fontSize: 16 } },
                  'Supercalifragilistic',
                ),
              ),
            ),
          ),
        ),
        resolve,
      ),
    )
  )._reactX11Node;
  const frame = async () => {
    root._scheduled = false;
    root.flush();
    await settle(app);
  };
  await frame();
  const first = await readPixels(root._ctx);
  root.invalidate(false);
  await frame();
  const repainted = await readPixels(root._ctx);
  assert.ok(first.equals(repainted), 'the first frame is what a repaint draws');
});

test('a label squeezed to no height, moved along by a sibling, leaves no old glyphs', async (t) => {
  // A row too short for its padding leaves its children no height, and a
  // paragraph with none still draws its lines — below a box of no area,
  // which claims nothing where it was or where it lands.
  const squeezed = ({ before = 0 }) =>
    h(
      'box',
      { style: { flexDirection: 'row', height: 10, padding: 8 } },
      h('box', { style: { width: before, backgroundColor: '#1c71d8' } }),
      h('text', { style: { color: '#20304a', fontSize: 20 } }, 'Ünïcødé'),
    );
  assert.ok(await frameMatchesRepaint(t, squeezed, {}, { before: 20 }));
  assert.ok(
    await frameMatchesRepaint(t, squeezed, { before: 20 }, { before: 0 }),
  );
});

test('a label its box leaves no width is drawn where it is claimed', async (t) => {
  // A box of no width is drawn unwrapped, which is not the layout the
  // measure pass made at no width, so the ink it would be drawn with was in
  // no layout yet when the frame claimed where the label had moved to.
  const narrowing = ({ width = 60 }) =>
    h(
      'box',
      { style: { width, padding: 8, backgroundColor: '#26a269' } },
      h(
        'box',
        { style: { borderWidth: 3, borderColor: '#20304a', height: 30 } },
        h(
          'text',
          { style: { color: '#f6d32d', fontSize: 12 } },
          'a longer label that wraps somewhere',
        ),
      ),
    );
  assert.ok(await frameMatchesRepaint(t, narrowing, {}, { width: 20 }));
});
