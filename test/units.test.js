// CSS's relative units and its length functions: `em`, `rem`, the viewport
// units, `calc()`/`min()`/`max()`/`clamp()`, a percentage radius and every
// way CSS writes a line height (src/shorthands.js `RELATIVE` and
// `readExpression`, nodes/styling.js `Units`).
//
// What is pinned here is less the arithmetic than the three things a
// relative length depends on, each of which moves without React
// re-rendering the node that wrote it: the font size it inherits, the
// palette's, and the window's. A length that resolved once and never again
// passes every test that only mounts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import { readLength, readLineHeight } from '../src/shorthands.js';
import { flattenStyle, radiusOf, validateStyle } from '../src/styles.js';
import { loadLayout } from '../src/yoga.js';
import { createMockApp, flushFrames } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

await loadLayout();

/** A node's context, written out: its own font size, the one it inherits,
 *  the palette's, and its window's. */
const at = {
  em: 10,
  parentEm: 20,
  rem: 14,
  viewport: { width: 800, height: 600 },
  deps: 0,
};
const read = (key, value) => readLength(key, value, undefined, at);
const problem = (style) => {
  try {
    validateStyle(flattenStyle(style), '<box style>');
    return null;
  } catch (err) {
    return err.message;
  }
};

test('each relative unit is what CSS says it is relative to', () => {
  // `em` is the node's own size, and on `fontSize` the one it inherits
  assert.equal(read('width', '2em'), 20);
  assert.equal(read('fontSize', '2em'), 40);
  assert.equal(read('fontSize', '150%'), 30);
  assert.equal(read('letterSpacing', '0.1em'), 1);
  assert.equal(read('padding', '1.5rem'), 21);
  assert.equal(read('width', '10vw'), 80);
  assert.equal(read('height', '10vh'), 60);
  assert.equal(read('width', '10vmin'), 60);
  assert.equal(read('width', '10vmax'), 80);
  // the small, large and dynamic viewports are one window on a desktop
  assert.equal(read('height', '5dvh'), 30);
  assert.equal(read('height', '5svh'), 30);
  // a percentage is still the layout's everywhere but the font size
  assert.equal(read('width', '50%'), '50%');
  // with nothing to resolve against, a relative length is refused rather
  // than guessed: the funnel always has its node, so this is a path that
  // skipped it
  assert.throws(
    () => readLength('width', '2em'),
    /em is resolved for the node it is written on/,
  );
});

test('calc, min, max and clamp resolve to one number where the style is', () => {
  assert.equal(read('width', 'calc(1rem + 2px)'), 16);
  assert.equal(read('width', 'calc((1rem + 2px) * 2)'), 32);
  assert.equal(read('width', 'calc(calc(1px + 1px) * 2)'), 4);
  assert.equal(read('width', 'calc(-1 * 4px)'), -4);
  assert.equal(read('width', 'calc(10px - -2px)'), 12);
  // a bare number is pixels where it meets a length, as everywhere here
  assert.equal(read('width', 'calc(8 + 4)'), 12);
  assert.equal(read('width', 'calc(1em + 4)'), 14);
  assert.equal(read('width', 'min(10px, 5vw)'), 10);
  assert.equal(read('width', 'max(1em, 12px)'), 12);
  // fluid type: the font size between two bounds, by the window
  assert.equal(read('fontSize', 'clamp(12px, 2vw, 18px)'), 16);
  assert.equal(read('fontSize', 'clamp(12px, 1vw, 18px)'), 12);
  // percentages alone stay one, for yoga to resolve
  assert.equal(read('width', 'calc(100% / 3)'), '33.3333%');
  assert.equal(read('width', 'min(50%, 30%)'), '30%');
  // …and on a font size a percentage is the inherited size's, so it mixes
  assert.equal(read('fontSize', 'calc(100% + 2px)'), 22);
  // a radius takes a percentage of the box, and only alone
  assert.equal(read('borderRadius', 'calc(50% - 10%)'), '40%');
  assert.match(
    problem({ borderRadius: 'calc(50% - 4px)' }),
    /mixes a percentage with a length/,
  );
});

test('a line height in any of CSS’s forms is a multiple of the font size', () => {
  const own = { ...at, em: 16 };
  assert.equal(readLineHeight(1.5, own), 1.5);
  assert.equal(readLineHeight('1.5', own), 1.5);
  assert.equal(readLineHeight('1.5em', own), 1.5);
  assert.equal(readLineHeight('150%', own), 1.5);
  // an absolute one is divided by the size it is applied to: "16 on 24"
  assert.equal(readLineHeight('24px', own), 1.5);
  assert.equal(readLineHeight('1.75rem', { ...at, em: 14 }), 1.75);
  assert.equal(readLineHeight('normal', own), undefined);
  assert.equal(problem({ lineHeight: '24px' }), null);
  assert.match(problem({ lineHeight: 'tall' }), /invalid lineHeight "tall"/);
  assert.match(problem({ lineHeight: -1 }), /it is not a multiple/);
});

test('a percentage radius is of the shorter side', () => {
  const style = (borderRadius) => ({ borderRadius });
  assert.equal(radiusOf(style(6), { width: 40, height: 40 }), 6);
  assert.equal(radiusOf(style('50%'), { width: 40, height: 40 }), 20);
  // a pill, where CSS would draw each corner as an ellipse
  assert.equal(radiusOf(style('50%'), { width: 100, height: 40 }), 20);
  assert.equal(radiusOf(style('10%'), { width: 200, height: 100 }), 10);
  assert.equal(radiusOf(style(undefined), { width: 10, height: 10 }), 0);
  assert.equal(radiusOf(undefined, { width: 10, height: 10 }), 0);
});

async function mount(element, { scale = 1 } = {}) {
  const app = createMockApp();
  const uncaught = [];
  const root = await createRoot({
    app,
    scale,
    onUncaughtError: (error) => uncaught.push(error),
  });
  const render = async (tree) => {
    root.render(tree);
    await tick();
    flushFrames(app.windows[0]);
    await tick();
  };
  await render(element);
  return {
    app,
    root,
    render,
    uncaught,
    window: () => app.windows[0]._reactX11Node,
  };
}

const rect = (node) => [
  node.abs.x,
  node.abs.y,
  node.abs.width,
  node.abs.height,
];

test('em follows the font size the box inherits, and moves when an ancestor’s does', async () => {
  const tree = (size) =>
    h(
      'window',
      { title: 't', width: 300, height: 200 },
      h(
        'box',
        { style: { fontSize: size } },
        h(
          'box',
          { style: { padding: '1em', alignSelf: 'flex-start' } },
          h('box', { style: { width: 4, height: 4 } }),
        ),
      ),
    );
  const { root, render, window, uncaught } = await mount(tree(20));
  const inner = () => window().children[0].children[0].children[0];
  assert.deepEqual(rect(inner()), [20, 20, 4, 4]);
  // a commit to the ancestor alone: React never re-renders the box with the
  // em in it, so only the text cascade can carry the move down
  await render(tree(30));
  assert.deepEqual(rect(inner()), [30, 30, 4, 4]);
  assert.deepEqual(uncaught, []);
  await root.unmount();
});

test('a font size in em or a percentage is of the size it inherits', async () => {
  const { root, window } = await mount(
    h(
      'window',
      { title: 't', width: 300, height: 200, style: { fontSize: 14 } },
      h('text', { style: { fontSize: '1.5em' } }, 'a'),
      h('text', { style: { fontSize: '150%' } }, 'b'),
      h(
        'box',
        { style: { fontSize: '2em' } },
        // em on the box under it is the box's 28, not the window's 14
        h('text', { style: { letterSpacing: '0.1em' } }, 'c'),
      ),
    ),
  );
  const [em, percent, box] = window().children;
  assert.equal(em.resolvedTextStyle().size, 21);
  assert.equal(percent.resolvedTextStyle().size, 21);
  const spaced = box.children[0].resolvedTextStyle();
  assert.equal(spaced.size, 28);
  assert.ok(Math.abs(spaced.letterSpacing - 2.8) < 1e-9);
  await root.unmount();
});

test('rem is the palette’s font size, and moves with the theme', async () => {
  const tree = (fontSize) =>
    h(
      'window',
      { title: 't', width: 300, height: 200, theme: { fontSize } },
      h(
        'box',
        { style: { paddingLeft: '1rem', alignSelf: 'flex-start' } },
        h('box', { style: { width: 4, height: 4 } }),
      ),
      // the nearest palette is the one a rem reads, as a token is
      h(
        'box',
        { theme: { fontSize: 20 }, style: { paddingLeft: '1rem' } },
        h('box', { style: { width: 4, height: 4 } }),
      ),
    );
  const { root, render, window } = await mount(tree(10));
  const [plain, provided] = window().children;
  assert.equal(plain.children[0].abs.x, 10);
  assert.equal(provided.children[0].abs.x, 20);
  await render(tree(16));
  assert.equal(plain.children[0].abs.x, 16, 'a theme swap re-resolves it');
  assert.equal(provided.children[0].abs.x, 20, 'the nearer palette holds');
  await root.unmount();
});

test('the viewport units follow the window, and only the nodes that read it re-resolve', async () => {
  const tree = (units) =>
    h(
      'window',
      { title: 't', width: 400, height: 200 },
      h('box', {
        style: units
          ? { width: '25vw', height: '10vh', alignSelf: 'flex-start' }
          : { width: 10, height: 10, alignSelf: 'flex-start' },
      }),
    );
  const { app, root, render, window } = await mount(tree(true));
  const box = () => window().children[0];
  assert.deepEqual(rect(box()).slice(2), [100, 20]);
  assert.ok(window()._sizeQueryNodes.has(box()), 'it answers to a resize');
  const wnd = app.windows[0];
  wnd.width = 800;
  wnd.height = 400;
  wnd.emit('resize', { width: 800, height: 400 });
  await tick();
  flushFrames(wnd);
  await tick();
  assert.deepEqual(rect(box()).slice(2), [200, 40]);
  await render(tree(false));
  assert.ok(!window()._sizeQueryNodes.has(box()), 'and stops when it stops');
  await root.unmount();
});

test('a relative length is logical, and the display scale multiplies what it comes to', async () => {
  const { root, window } = await mount(
    h(
      'window',
      { title: 't', width: 300, height: 200, theme: { fontSize: 10 } },
      h(
        'box',
        { style: { paddingLeft: '1rem', alignSelf: 'flex-start' } },
        h('box', { style: { width: 4, height: 4 } }),
      ),
      h(
        'box',
        {
          style: { fontSize: 12, paddingLeft: '1em', alignSelf: 'flex-start' },
        },
        h('box', { style: { width: 4, height: 4 } }),
      ),
    ),
    { scale: 2 },
  );
  const [rem, em] = window().children;
  assert.equal(rem.children[0].abs.x, 20);
  assert.equal(em.children[0].abs.x, 24);
  await root.unmount();
});

test('an absolute line height is a multiple of the node’s own size', async () => {
  const { root, window } = await mount(
    h(
      'window',
      { title: 't', width: 300, height: 200 },
      h('text', { style: { fontSize: 16, lineHeight: '24px' } }, 'a'),
      h('text', { style: { fontSize: '2rem', lineHeight: '150%' } }, 'b'),
    ),
  );
  const [px, percent] = window().children;
  assert.equal(px.style.lineHeight, 1.5);
  assert.equal(percent.style.lineHeight, 1.5);
  await root.unmount();
});

test('a loop between relative ends travels between what they come to', async () => {
  const { root, window } = await mount(
    h(
      'window',
      { title: 't', width: 400, height: 200, theme: { fontSize: 10 } },
      h('box', {
        style: {
          height: 4,
          width: '1rem',
          animation: { width: { to: '25vw', duration: 1000 } },
        },
      }),
    ),
  );
  const [loop] = window().children[0]._loops;
  assert.equal(loop.from, 10);
  assert.equal(loop.to, 100);
  await root.unmount();
});

test('a state block may round a corner in rem', async () => {
  const { root, window } = await mount(
    h(
      'window',
      { title: 't', width: 300, height: 200, theme: { fontSize: 10 } },
      h('box', {
        style: {
          width: 40,
          height: 40,
          borderRadius: 2,
          ':hover': { borderRadius: '0.5rem' },
        },
      }),
    ),
  );
  const box = window().children[0];
  box.setStyleState(':hover', true);
  assert.equal(box.style.borderRadius, 5);
  await root.unmount();
});

const W = 140;
const H = 80;

async function server(t) {
  const srv = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  srv.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await x11Root.unmount();
    await app.close();
  });
  const settle = () =>
    new Promise((resolve, reject) =>
      app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
    );
  const render = (tree) =>
    new Promise((resolve) => x11Root.render(tree, resolve));
  const frame = async (root) => {
    root._scheduled = false;
    root.flush();
    await settle();
  };
  const pixels = (root) =>
    new Promise((resolve, reject) =>
      root._ctx.getImageData(0, 0, W, H, (err, data) =>
        err ? reject(err) : resolve(Buffer.from(data.data)),
      ),
    );
  return { render, frame, pixels };
}

test('a percentage radius paints the circle and the pill its pixels name', async (t) => {
  const { render, frame, pixels } = await server(t);
  // one radius for both boxes, or one each
  const paint = async (square, pill = square) => {
    const root = (
      await render(
        h(
          'window',
          { width: W, height: H, style: { backgroundColor: '#ffffff' } },
          h(
            'box',
            { style: { flexDirection: 'row', gap: 10, padding: 10 } },
            h('box', {
              style: {
                width: 40,
                height: 40,
                borderRadius: square,
                backgroundColor: '#c0392b',
              },
            }),
            h('box', {
              style: {
                width: 70,
                height: 30,
                borderRadius: pill,
                backgroundColor: '#2980b9',
              },
            }),
          ),
        ),
      )
    )._reactX11Node;
    root.invalidate(false);
    await frame(root);
    return pixels(root);
  };
  // a quarter of each shorter side: 10 for the square, 7.5 for the pill
  const percent = await paint('25%');
  assert.ok(
    percent.some((v, i) => i % 4 !== 3 && v !== 255),
    'the premise: something was drawn',
  );
  assert.ok(!percent.equals(await paint(0)), 'the premise: corners are round');
  assert.ok(!percent.equals(await paint(10)), 'one number is not both radii');
  assert.ok(percent.equals(await paint(10, 7.5)), 'each box its own share');
  // and half is a circle on the square and a pill on the other
  assert.ok((await paint('50%')).equals(await paint(20, 15)));
});

test('a percentage radius that grows with its box repaints its corners', async (t) => {
  const { render, frame, pixels } = await server(t);
  // A box whose origin holds and only grows claims the edges that moved
  // (`_edgeBands`). A percentage radius moves with the box, so its corners
  // at the edges that held change too — and the child that grows it sits at
  // the bottom, nowhere near the top corners, so nothing else repaints them.
  const tree = (inner) =>
    h(
      'window',
      { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
      h(
        'box',
        { style: { padding: 10, alignItems: 'flex-start' } },
        h(
          'box',
          {
            style: {
              width: 120,
              borderRadius: '30%',
              backgroundColor: '#ffffff',
              borderWidth: 2,
              borderColor: '#2d3436',
              alignItems: 'center',
            },
          },
          h('box', { style: { width: 6, height: inner } }),
        ),
      ),
    );
  const root = (await render(tree(20)))._reactX11Node;
  await frame(root);
  await frame(root);
  await render(tree(50));
  await frame(root);
  const painted = await pixels(root);
  root.invalidate(false);
  await frame(root);
  assert.ok(painted.equals(await pixels(root)), 'as a full repaint paints it');
});
