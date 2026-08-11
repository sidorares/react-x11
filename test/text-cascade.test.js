// The text cascade: the ink, the face and the size travel down the tree.
//
// Three things are verified here as pixels, against node-x11's in-process X
// server and a real font, because every one of them is a bug that survives
// every assertion about styles and layout — the resolved style is right, the
// node is damaged, a frame is painted, and the glyphs on the screen are the
// old ones.
//
//   * a `:hover` (or `:focus`, or `:active`) block that sets `color` on a
//     `<text>` repaints it. The memoised `TextLayout` carries the span
//     colours it was built with, and `setStyleState` used to swap the style
//     without dropping it;
//   * a `transition` on a `color` reaches the new ink. Same cause, through
//     the animation tick, and worse — it never arrived at all, not even at
//     the end of the transition;
//   * `color` and `fontSize` on an enclosing element reach the text inside
//     it, and a `:hover` on a row therefore reaches the row's label, which
//     is what CSS does and what makes `group-hover` unnecessary.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import { setAnimationClock } from '../src/nodes.js';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

const W = 240;
const H = 120;

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
  fontSource.alias('sans-serif', 'Test Main');
  return createClient({ stream: clientEnd, fontSource });
}

const settled = (app) =>
  new Promise((resolve, reject) =>
    app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
  );

/**
 * How many pixels of each ink the window holds. `getImageData` speaks RGBA
 * (ntk >= 5.3), and the two inks are picked far enough apart that antialiased
 * edges land in neither bucket.
 */
function inks(image) {
  let red = 0;
  let black = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
    if (r > 150 && g < 90 && b < 90) red++;
    else if (r < 90 && g < 90 && b < 90) black++;
  }
  return { red, black };
}

/** Mount, paint the frame it asked for, and hand back a reader. */
async function mount(app, element) {
  const x11Root = await createRoot({ app });
  const instance = await new Promise((resolve) =>
    x11Root.render(element, resolve),
  );
  const root = instance._reactX11Node;
  const ctx = (root._ctx ??= root.window.getContext('2d'));
  const read = async () => {
    root._scheduled = false;
    root.flush();
    await settled(app);
    return inks(
      await new Promise((resolve, reject) =>
        ctx.getImageData(0, 0, W, H, (err, d) =>
          err ? reject(err) : resolve(d),
        ),
      ),
    );
  };
  return {
    root,
    read,
    render: (el) => new Promise((r) => x11Root.render(el, r)),
  };
}

const h = React.createElement;

/** A window with one `<text>`, wrapped in whatever `wrap` builds. */
const scene = (textStyle, boxStyle, refs = {}) =>
  h(
    'window',
    { width: W, height: H, style: { backgroundColor: '#ffffff' } },
    h(
      'box',
      { ref: refs.box, style: { alignSelf: 'flex-start', ...boxStyle } },
      h(
        'text',
        { ref: refs.text, style: { fontSize: 24, ...textStyle } },
        'Handgloves',
      ),
    ),
  );

const RED = '#ff0000';
const BLACK = '#000000';

test(':hover { color } on a <text> repaints it in the new ink', async () => {
  const app = await headlessApp();
  try {
    const refs = { text: React.createRef() };
    const { read } = await mount(
      app,
      scene({ color: BLACK, ':hover': { color: RED } }, null, refs),
    );
    const resting = await read();
    assert.ok(resting.black > 200 && resting.red === 0, 'resting is black');

    refs.text.current.setStyleState(':hover', true);
    const hovered = await read();
    assert.ok(
      hovered.red > 200 && hovered.black === 0,
      `hovering should repaint the glyphs red, got ${JSON.stringify(hovered)}`,
    );

    refs.text.current.setStyleState(':hover', false);
    const left = await read();
    assert.ok(
      left.black > 200 && left.red === 0,
      `leaving should put it back, got ${JSON.stringify(left)}`,
    );
  } finally {
    await app.close();
  }
});

test('a state block that only changes the ink does not reflow', async () => {
  const app = await headlessApp();
  try {
    const refs = { text: React.createRef() };
    const { read } = await mount(
      app,
      scene({ color: BLACK, ':hover': { color: RED } }, null, refs),
    );
    await read();
    const text = refs.text.current;
    const before = { ...text.abs };
    // the box is the measured text (`alignSelf: 'flex-start'`), so a width
    // that survives is evidence the measure function was not re-run — the
    // whole reason `color` is priced apart from the face and the size
    let measures = 0;
    const measureContent = text.measureContent.bind(text);
    text.measureContent = (c) => {
      measures++;
      return measureContent(c);
    };
    text.setStyleState(':hover', true);
    await read();
    assert.strictEqual(measures, 0, 'a new ink must not re-measure the text');
    assert.deepStrictEqual({ ...text.abs }, before, 'and must not move it');
  } finally {
    await app.close();
  }
});

test('a transitioned colour reaches the new ink', async () => {
  const app = await headlessApp();
  let clock = 1000;
  setAnimationClock(() => clock);
  try {
    const { read, render } = await mount(
      app,
      scene({ color: BLACK, transition: 100 }),
    );
    assert.ok((await read()).black > 200);

    await render(scene({ color: RED, transition: 100 }));
    clock += 1000; // well past the end of the transition
    const after = await read();
    assert.ok(
      after.red > 200 && after.black === 0,
      `the transition should land on red, got ${JSON.stringify(after)}`,
    );
  } finally {
    setAnimationClock(() => Date.now());
    await app.close();
  }
});

test('color on an enclosing <box> reaches the text inside it', async () => {
  const app = await headlessApp();
  try {
    const { read, render } = await mount(app, scene(null, { color: BLACK }));
    assert.ok((await read()).black > 200, 'the box names the ink');

    await render(scene(null, { color: RED }));
    const after = await read();
    assert.ok(
      after.red > 200 && after.black === 0,
      `changing the box's colour should restyle the label, got ${JSON.stringify(after)}`,
    );
  } finally {
    await app.close();
  }
});

test("a node's own colour wins over what it inherits", async () => {
  const app = await headlessApp();
  try {
    const { read } = await mount(app, scene({ color: BLACK }, { color: RED }));
    const shown = await read();
    assert.ok(
      shown.black > 200 && shown.red === 0,
      `the <text> named black, so black it is, got ${JSON.stringify(shown)}`,
    );
  } finally {
    await app.close();
  }
});

test(':hover on a row reaches the label inside it', async () => {
  const app = await headlessApp();
  try {
    const refs = { box: React.createRef() };
    const { read } = await mount(
      app,
      scene(null, { color: BLACK, ':hover': { color: RED } }, refs),
    );
    assert.ok((await read()).black > 200);

    // exactly what the event manager does: `:hover` marks the ancestor chain,
    // and what the child does about it is inheritance rather than a selector
    refs.box.current.setStyleState(':hover', true);
    const hovered = await read();
    assert.ok(
      hovered.red > 200 && hovered.black === 0,
      `hovering the row should light its label, got ${JSON.stringify(hovered)}`,
    );
  } finally {
    await app.close();
  }
});

test('a descendant that names its own ink absorbs an ancestor change', async () => {
  const app = await headlessApp();
  try {
    const refs = { box: React.createRef(), text: React.createRef() };
    const { read } = await mount(
      app,
      scene({ color: BLACK }, { ':hover': { color: RED } }, refs),
    );
    await read();
    // the walk stops at the node whose answer did not change, so nothing
    // under it is re-resolved and nothing under it is damaged
    let dropped = 0;
    const text = refs.text.current;
    const paintChanged = text._textPaintChanged.bind(text);
    text._textPaintChanged = () => {
      dropped++;
      paintChanged();
    };
    refs.box.current.setStyleState(':hover', true);
    const hovered = await read();
    assert.strictEqual(dropped, 0, 'the label resolves to the same ink');
    assert.ok(hovered.black > 200 && hovered.red === 0);
  } finally {
    await app.close();
  }
});

test('fontSize on an enclosing <box> re-measures the text inside it', async () => {
  const app = await headlessApp();
  try {
    const refs = { text: React.createRef() };
    const wide = h(
      'window',
      { width: W, height: H, style: { backgroundColor: '#ffffff' } },
      h(
        'box',
        { style: { alignSelf: 'flex-start', fontSize: 12 } },
        h('text', { ref: refs.text, style: { color: BLACK } }, 'Handgloves'),
      ),
    );
    const { read, render } = await mount(app, wide);
    const small = await read();
    const smallWidth = refs.text.current.abs.width;

    await render(
      h(
        'window',
        { width: W, height: H, style: { backgroundColor: '#ffffff' } },
        h(
          'box',
          { style: { alignSelf: 'flex-start', fontSize: 28 } },
          h('text', { ref: refs.text, style: { color: BLACK } }, 'Handgloves'),
        ),
      ),
    );
    const big = await read();
    assert.ok(
      big.black > small.black * 1.5,
      `28px should put down much more ink than 12px, got ${small.black} -> ${big.black}`,
    );
    assert.ok(
      refs.text.current.abs.width > smallWidth,
      `and the measured box should grow, got ${smallWidth} -> ${refs.text.current.abs.width}`,
    );
  } finally {
    await app.close();
  }
});

test('a <canvas mono> takes the ink of the element around it', async () => {
  const app = await headlessApp();
  try {
    const draw = (ctx, { width, height }) => {
      ctx.fillRect(0, 0, width, height);
    };
    const swatch = (color) =>
      h(
        'window',
        { width: W, height: H, style: { backgroundColor: '#ffffff' } },
        h(
          'box',
          { style: { color } },
          h('canvas', {
            mono: true,
            onDraw: draw,
            style: { width: 40, height: 40 },
          }),
        ),
      );
    const { read, render } = await mount(app, swatch(BLACK));
    assert.ok((await read()).black > 1000, 'the swatch takes the box ink');
    await render(swatch(RED));
    const after = await read();
    assert.ok(
      after.red > 1000 && after.black === 0,
      `an <Icon> in a row follows the row, got ${JSON.stringify(after)}`,
    );
  } finally {
    await app.close();
  }
});

test('an unstyled <text> still falls back to the palette', async () => {
  const app = await headlessApp();
  try {
    const { read } = await mount(
      app,
      h(
        'window',
        {
          width: W,
          height: H,
          theme: { text: RED },
          style: { backgroundColor: '#ffffff' },
        },
        h('text', { style: { fontSize: 24 } }, 'Handgloves'),
      ),
    );
    const shown = await read();
    assert.ok(
      shown.red > 200 && shown.black === 0,
      `the floor under the cascade is the palette, got ${JSON.stringify(shown)}`,
    );
  } finally {
    await app.close();
  }
});
