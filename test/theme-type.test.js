// The palette's **type**: the face and the size text takes when nothing
// styled it.
//
// A theme has always carried `fontSize`, and until now almost nothing read
// it — the popup radii were derived from it and the icons were sized by it,
// and not one letter came out any different, because a `<text>` that named
// no size fell back to a module constant. `fontFamily` did not exist at all,
// so "this app is Inter" was a sentence that had to be said on every label.
//
// Both are read through `Node.inheritedTextStyle` now, alongside the ink,
// and that is what these tests are about — plus the thing that half of it
// silently: a theme swap does not re-render anything. The `<text>` element's
// props are identical across it, so nothing marks its measured layout
// dirty, and a cached layout carries the face and size it was *shaped* with.
// Two of these tests are pixels for that reason.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { StaticFontSource, createClient } from 'ntk';

import { createRoot, Select, ThemeProvider } from '../src/index.js';
import { capBand } from '../src/components/theme.js';
import { measureLabel } from '../src/components/anchor.js';
import { DefaultTheme } from '../src/palette.js';
import { createStyles, resolveTokens } from '../src/styles.js';
import { createMockApp, pressButton } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const nodeOf = (app, index = 0) => app.windows[index]._reactX11Node;

// --- the tokens -------------------------------------------------------------

test('the palette names both faces, and they are what text already had', () => {
  assert.equal(DefaultTheme.fontFamily, 'sans-serif');
  assert.equal(DefaultTheme.monoFamily, 'monospace');
});

test('$monoFamily is a token like any other', () => {
  const s = createStyles({ code: { fontFamily: '$monoFamily', fontSize: 12 } });
  const theme = { ...DefaultTheme, monoFamily: '"JetBrains Mono", monospace' };
  assert.equal(
    resolveTokens(s.code, theme).fontFamily,
    '"JetBrains Mono", monospace',
  );
  // which is the whole point of it being a token: the style is hoisted, so
  // the component that wrote it never saw the palette
  assert.equal(resolveTokens(s.code, DefaultTheme).fontFamily, 'monospace');
});

// --- what an unstyled <text> inherits ---------------------------------------

async function inheritedUnder(theme) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      ThemeProvider,
      { value: theme },
      h('window', { width: 200, height: 100 }, h('text', null, 'Handgloves')),
    ),
  );
  await tick();
  await tick();
  const find = (node) =>
    node.kind === 'text'
      ? node
      : node.children.reduce((hit, child) => hit ?? find(child), null);
  const text = find(nodeOf(app));
  const inherited = text.parent.inheritedTextStyle;
  await x11Root.unmount();
  return inherited;
}

test('a <text> that styles nothing takes the palette’s face, size and ink', async () => {
  const inherited = await inheritedUnder({
    fontFamily: '"Test Mono", monospace',
    fontSize: 22,
    text: '#ff0000',
  });
  assert.equal(inherited.family, '"Test Mono", monospace');
  assert.equal(inherited.size, 22);
  assert.equal(inherited.color, '#ff0000');
});

test('a palette that names neither leaves text where it was', async () => {
  const inherited = await inheritedUnder({ text: '#123456' });
  assert.equal(inherited.family, 'sans-serif');
  assert.equal(inherited.size, 14);
});

test('a bare theme prop derives nothing, so the type falls back', async () => {
  // `<box theme={…}>` merges and computes nothing (styling.md) — a palette
  // reaching a node that way can be missing either token entirely, and text
  // under it still has to have a face and a size.
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 200, height: 100, theme: { text: '#00ff00' } },
      h('text', null, 'Handgloves'),
    ),
  );
  await tick();
  const inherited = nodeOf(app).inheritedTextStyle;
  assert.equal(inherited.family, 'sans-serif');
  assert.equal(inherited.size, 14);
  assert.equal(inherited.color, '#00ff00', 'what it did name still lands');
  await x11Root.unmount();
});

test('the style property still wins over the palette', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      ThemeProvider,
      { value: { fontFamily: 'Test Mono', fontSize: 22 } },
      h(
        'window',
        { width: 200, height: 100 },
        h('text', { style: { fontFamily: 'Test Main', fontSize: 9 } }, 'Hand'),
      ),
    ),
  );
  await tick();
  await tick();
  const text = nodeOf(app).children[0];
  assert.equal(text.style.fontFamily, 'Test Main');
  assert.equal(text.style.fontSize, 9);
  await x11Root.unmount();
});

// --- the swap has to re-measure ---------------------------------------------
//
// Pixels, because this is the half that has no other witness: the element's
// own props do not change across a theme swap, so nothing re-renders the
// `<text>` and the memoised layout would otherwise survive with the old face
// baked into it.

const W = 240;
const H = 120;

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

// Two families with visibly different advances: a proportional serif and a
// typewriter face. A theme that swaps between them has to move the ink.
async function headlessApp() {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Typewriter-Regular.ttf')), {
    family: 'Test Mono',
  });
  fontSource.alias('sans-serif', 'Test Main');
  fontSource.alias('monospace', 'Test Mono');
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

// `alignSelf: 'flex-start'` so the box is the measured text and not the
// window's width — which is what makes `abs.width` evidence that the measure
// function ran again rather than that something merely repainted. The
// `<text>` names no face and no size: the palette is the only thing saying
// what it is.
const label = (ref, theme) =>
  h(
    'window',
    { width: W, height: H, theme, style: { backgroundColor: '#ffffff' } },
    h(
      'text',
      { ref, style: { color: '#000000', alignSelf: 'flex-start' } },
      'Handgloves',
    ),
  );

async function renderAndRead(app, x11Root, element, ref) {
  await new Promise((resolve) => x11Root.render(element, resolve));
  await new Promise((r) => setImmediate(r));
  const node = ref.current;
  node.root.flush();
  await settled(app);
  const ctx = (node.root._ctx ??= node.root.window.getContext('2d'));
  return { image: await readPixels(ctx, W, H), node };
}

/** Swap the palette over an unchanged `<text>` and report what moved. */
async function reTheme(from, to) {
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

test('a palette that only moves the size re-measures and repaints', async () => {
  const { before, after } = await reTheme(
    { ...DefaultTheme, fontSize: 12 },
    { ...DefaultTheme, fontSize: 28 },
  );
  assert.ok(
    after.ink > before.ink * 1.5,
    `28px should put down much more ink than 12px, got ${before.ink} -> ${after.ink}`,
  );
  assert.ok(
    after.width > before.width,
    `the measured box should grow, got ${before.width} -> ${after.width}`,
  );
});

test('a palette that only moves the face re-measures and repaints', async () => {
  const { before, after } = await reTheme(
    { ...DefaultTheme, fontSize: 24, fontFamily: 'Test Main' },
    { ...DefaultTheme, fontSize: 24, fontFamily: 'Test Mono' },
  );
  assert.notEqual(
    after.width,
    before.width,
    `the typewriter face measures differently from the serif, got ` +
      `${before.width} -> ${after.width}`,
  );
  assert.notEqual(
    after.ink,
    before.ink,
    'and the glyphs on the screen are the new face’s',
  );
});

// --- the widgets that had 14 written into their geometry ---------------------

test('a popup is measured in the face its label will be drawn in', () => {
  // The bug this pins showed up as a `Select` whose own options wrapped: the
  // rows painted in the palette's monospace and the menu was sized in
  // `sans-serif`, which is narrower, so the width was short by the
  // difference. Every popup here measures a label that names no family.
  const asked = [];
  const node = {
    app: {
      fonts: {
        layout: (text, style) => (asked.push(style), { width: 10, height: 10 }),
      },
    },
    inheritedTextStyle: { family: '"JetBrains Mono", monospace', size: 20 },
  };
  measureLabel(node, 'three', { size: 20 });
  assert.equal(asked[0].family, '"JetBrains Mono", monospace');

  // an explicit family still wins — a caller that knows better says so
  measureLabel(node, 'three', { size: 20, family: 'Inter' });
  assert.equal(asked[1].family, 'Inter');
});

test('a Select’s rows are sized from the palette, not from 14', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      ThemeProvider,
      { value: { fontSize: 22 } },
      h(
        'window',
        { width: 300, height: 200 },
        h(
          'box',
          { style: { flexGrow: 1, padding: 10 } },
          h(Select, { options: ['one', 'two', 'three'], value: 'one' }),
        ),
      ),
    ),
  );
  await tick();
  await tick();

  const wnd = app.windows[0];
  const trigger = wnd._reactX11Node.children[0].children[0].children[0];
  pressButton(wnd, trigger.abs.x + 4, trigger.abs.y + 4);
  await tick();
  await tick();

  const sheet = app.windows[1]._reactX11Node.children[0];
  const rows = sheet.children[0].children;
  // ITEM_PAD is 10 either side of the cap band — the row is its label with
  // even space all round, and the label is now 22px because it inherits.
  assert.equal(
    rows[0].style.height,
    capBand(22) + 20,
    'the row grew with the type it holds',
  );
  assert.ok(
    rows[0].style.height > capBand(14) + 20,
    'which is to say it is not the 14px row any more',
  );

  await x11Root.unmount();
});
