// `layout`: a registered algorithm arranging a box's children inside the pass
// that lays the window out (src/layouts.js; the layout host in nodes.js;
// docs/styling.md "Custom layouts"). The children are yoga trees of their
// own and the box a measured leaf in its parent's, so these read `abs` the
// frame after a change — there is no later frame for an answer to arrive in.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import {
  registerLayout,
  unregisterLayout,
  registeredLayouts,
} from '../src/host.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = () => tick().then(tick);

async function mount(children, { width = 320, height = 240, scale } = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app, ...(scale && { scale }) });
  const render = (kids) => x11Root.render(h('window', { width, height }, kids));
  render(children);
  await frame();
  const wnd = app.windows[0];
  return { app, wnd, root: wnd._reactX11Node, x11Root, render };
}

async function resize(app, width, height) {
  const wnd = app.windows[0];
  wnd.width = width;
  wnd.height = height;
  wnd.emit('resize', { width, height });
  await frame();
}

const defined = [];
function define(name, definition) {
  registerLayout(name, definition);
  defined.push(name);
}
afterEach(() => {
  for (const name of defined.splice(0)) unregisterLayout(name);
});

/** console.error, captured. A reported problem also marks the process
 *  failed, which a test that provokes one on purpose has to put back. */
async function capturingErrors(fn) {
  const lines = [];
  const original = console.error;
  const code = process.exitCode;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn(lines);
  } finally {
    console.error = original;
    process.exitCode = code;
  }
  return lines;
}

/** Where a node landed, from its parent's corner. */
const rel = (node) => ({
  x: node.abs.x - node.parent.abs.x,
  y: node.abs.y - node.parent.abs.y,
});
const rects = (refs) =>
  refs.map((r) => ({
    ...rel(r.current),
    w: r.current.abs.width,
    h: r.current.abs.height,
  }));
const xs = (refs) => refs.map((r) => rel(r.current).x);
const ys = (refs) => refs.map((r) => rel(r.current).y);

/** Cards of the given heights, each taking its width from the layout. */
const cards = (heights, refs, extra = () => ({})) =>
  heights.map((height, i) =>
    h('box', { key: i, ref: refs?.[i], style: { height, ...extra(i) } }),
  );

/** A button's shape: a width from its content, and padding round it. */
const button = (ref, inner) =>
  h(
    'box',
    { ref, style: { padding: 8 } },
    h('box', { style: { width: inner, height: 10 } }),
  );

const refsOf = (n) => Array.from({ length: n }, () => React.createRef());

// --- registration -------------------------------------------------------------

test('registerLayout says what is wrong, and keeps its built-ins', () => {
  assert.throws(() => registerLayout('', { layout() {} }), /a name is letters/);
  assert.throws(
    () => registerLayout('nothing', {}),
    /needs a layout\(children, constraints, options, info\) function/,
  );
  assert.throws(
    () => registerLayout('masonry', { layout() {} }),
    /"masonry" is already registered, and is built in/,
  );
  assert.throws(
    () =>
      registerLayout('bad', {
        layout() {},
        childOptions: { span: { type: 'wide' } },
      }),
    /childOptions option "span" has type "wide"/,
  );
  assert.strictEqual(unregisterLayout('masonry'), false, 'a built-in stays');
  const names = registeredLayouts();
  assert.ok(names.includes('masonry') && names.includes('equal-row'));
});

// --- the contract -------------------------------------------------------------

test('a layout sizes the box and places each child, margins and padding counted', async () => {
  define('diagonal', {
    options: { step: { type: 'length', default: 10 } },
    layout(children, constraints, { step }) {
      let width = 0;
      let height = 0;
      const placed = children.map((child, i) => {
        const size = child.measure();
        width = Math.max(width, i * step + size.width);
        height = Math.max(height, i * step + size.height);
        return { x: i * step, y: i * step };
      });
      return { width, height, children: placed };
    },
  });
  const host = React.createRef();
  const kids = refsOf(3);
  await mount(
    h(
      'box',
      { style: { flexDirection: 'row' } },
      h(
        'box',
        {
          ref: host,
          style: { layout: { name: 'diagonal', step: 15 }, padding: 5 },
        },
        kids.map((ref, i) =>
          h('box', {
            key: i,
            ref,
            style: { width: 20 + i * 10, height: 10, margin: 2 },
          }),
        ),
      ),
    ),
  );
  // the margin boxes are 24x14, 34x14 and 44x14, at 0, 15 and 30 diagonally
  // inside the 5px padding
  assert.deepStrictEqual(rects(kids), [
    { x: 7, y: 7, w: 20, h: 10 },
    { x: 22, y: 22, w: 30, h: 10 },
    { x: 37, y: 37, w: 40, h: 10 },
  ]);
  // …and the box is what the layout answered, with its padding round it
  assert.strictEqual(host.current.abs.width, 30 + 44 + 10);
  assert.strictEqual(host.current.abs.height, 30 + 14 + 10);
});

test('an answer that is not a size is reported, like a throw', async () => {
  define('nan', {
    layout: () => ({ width: Number.NaN, height: 10, children: [] }),
  });
  const lines = await capturingErrors(async () => {
    await mount(h('box', { style: { layout: 'nan' } }, cards([20], refsOf(1))));
  });
  assert.match(
    lines.join('\n'),
    /layout "nan" returned \{ width: NaN, height: 10 \} — both have to be finite/,
  );
});

test('a layout that throws is reported, and the box is a flex box in the same frame', async () => {
  define('broken', {
    layout() {
      throw new Error('kaboom');
    },
  });
  const refs = refsOf(2);
  const host = React.createRef();
  const tree = (layout) =>
    h('box', { ref: host, style: { layout } }, cards([20, 30], refs));
  const lines = await capturingErrors(async () => {
    const { render } = await mount(tree('broken'));
    assert.deepStrictEqual(ys(refs), [0, 20], 'stacked, as a flex column');
    assert.strictEqual(host.current._host, null, 'no longer a layout host');
    // a different layout is taken up again…
    render(tree({ name: 'masonry', columns: 2 }));
    await frame();
    assert.deepStrictEqual(xs(refs), [0, 160]);
    // …and the one that threw, named again, is asked again
    render(tree('broken'));
    await frame();
    assert.deepStrictEqual(ys(refs), [0, 20]);
  });
  const reports = lines.filter((l) =>
    l.includes('layout "broken" on <box> threw'),
  );
  assert.strictEqual(reports.length, 2, lines.join('\n'));
  assert.match(reports[0], /kaboom/);
  assert.match(
    reports[0],
    /laid out as flexbox until its style names another layout/,
  );
});

test('a layout nobody registered is reported once, and the box is a flex box', async () => {
  const refs = refsOf(2);
  const tree = () =>
    h('box', { style: { layout: 'nope' } }, cards([20, 30], refs));
  const lines = await capturingErrors(async () => {
    const { render } = await mount(tree());
    render(tree());
    await frame();
  });
  assert.deepStrictEqual(ys(refs), [0, 20]);
  assert.strictEqual(lines.length, 1, lines.join('\n'));
  assert.match(
    lines[0],
    /layout "nope" is not registered \(registered: "masonry", "equal-row"/,
  );
});

test('a scroll pane is told to put its layout on a box inside it', async () => {
  const refs = refsOf(2);
  const lines = await capturingErrors(async () => {
    await mount(
      h(
        'box',
        { style: { overflow: 'scroll', flexGrow: 1, layout: 'masonry' } },
        cards([20, 30], refs),
      ),
    );
  });
  assert.deepStrictEqual(ys(refs), [0, 20], 'its children in flow');
  assert.match(lines.join('\n'), /put the layout on a <box> inside the pane/);
});

// --- masonry ------------------------------------------------------------------

test('masonry drops each child into the shortest column', async () => {
  const refs = refsOf(5);
  const host = React.createRef();
  await mount(
    h(
      'box',
      {
        ref: host,
        style: { layout: { name: 'masonry', columnWidth: 100 }, gap: 10 },
      },
      cards([50, 30, 70, 20, 40], refs),
    ),
  );
  // 320 wide: three columns of 100 and two gaps of 10
  assert.deepStrictEqual(rects(refs), [
    { x: 0, y: 0, w: 100, h: 50 },
    { x: 110, y: 0, w: 100, h: 30 },
    { x: 220, y: 0, w: 100, h: 70 },
    { x: 110, y: 40, w: 100, h: 20 },
    { x: 0, y: 60, w: 100, h: 40 },
  ]);
  assert.strictEqual(
    host.current.abs.height,
    100,
    'as tall as its tallest column',
  );
});

test('masonry takes a column count, and a child spans columns', async () => {
  const refs = refsOf(4);
  await mount(
    h(
      'box',
      {
        style: {
          layout: { name: 'masonry', columns: 2 },
          columnGap: 20,
          rowGap: 4,
        },
      },
      cards([30, 30, 50, 10], refs, (i) =>
        i === 2 ? { layoutItem: { span: 2 } } : {},
      ),
    ),
  );
  // two columns of 150 across 320, with a gap of 20
  assert.deepStrictEqual(rects(refs), [
    { x: 0, y: 0, w: 150, h: 30 },
    { x: 170, y: 0, w: 150, h: 30 },
    { x: 0, y: 34, w: 320, h: 50 },
    { x: 0, y: 88, w: 150, h: 10 },
  ]);
});

test('right to left the columns fill from the right, and the algorithm never knew', async () => {
  const refs = refsOf(3);
  await mount(
    h(
      'box',
      {
        style: {
          layout: { name: 'masonry', columnWidth: 100 },
          gap: 10,
          direction: 'rtl',
        },
      },
      cards([50, 30, 70], refs),
    ),
  );
  assert.deepStrictEqual(xs(refs), [220, 110, 0]);
});

test('lengths are logical pixels at any scale', async () => {
  const refs = refsOf(3);
  await mount(
    h(
      'box',
      { style: { layout: { name: 'masonry', columnWidth: 100 }, gap: 10 } },
      cards([20, 20, 20], refs),
    ),
    { scale: 2 },
  );
  // 640 device pixels: three columns of 200 and gaps of 20
  assert.deepStrictEqual(xs(refs), [0, 220, 440]);
});

// --- equal-row ----------------------------------------------------------------

test('equal-row makes every child as wide as the widest, and one height', async () => {
  const refs = refsOf(3);
  const host = React.createRef();
  await mount(
    h(
      'box',
      {
        ref: host,
        style: { layout: 'equal-row', gap: 8, justifyContent: 'flex-end' },
      },
      button(refs[0], 30),
      button(refs[1], 60),
      button(refs[2], 45),
    ),
  );
  // the widest is 60 and 16 of padding; the row is 320 wide, so the three
  // sit at its end
  assert.deepStrictEqual(rects(refs), [
    { x: 76, y: 0, w: 76, h: 26 },
    { x: 160, y: 0, w: 76, h: 26 },
    { x: 244, y: 0, w: 76, h: 26 },
  ]);
  assert.strictEqual(host.current.abs.height, 26);
});

test('a row of equal buttons takes its width from its content', async () => {
  const refs = refsOf(3);
  const host = React.createRef();
  await mount(
    h(
      'box',
      { style: { flexDirection: 'row', justifyContent: 'flex-end' } },
      h(
        'box',
        { ref: host, style: { layout: 'equal-row', gap: 8 } },
        button(refs[0], 30),
        button(refs[1], 60),
        button(refs[2], 45),
      ),
    ),
  );
  assert.strictEqual(host.current.abs.width, 3 * 76 + 2 * 8);
  assert.strictEqual(host.current.abs.x, 320 - (3 * 76 + 2 * 8));
  assert.deepStrictEqual(xs(refs), [0, 84, 168]);
});

// --- keeping up with the tree -------------------------------------------------

test('a child that grows is re-measured in the pass, and the ones after it move', async () => {
  const refs = refsOf(4);
  // the first card's height is two levels down, so the change reaches the
  // layout only through the card's own yoga tree
  const tree = (first) =>
    h(
      'box',
      { style: { layout: { name: 'masonry', columns: 2 }, gap: 10 } },
      h(
        'box',
        { key: 0, ref: refs[0] },
        h('box', { style: { height: first } }),
      ),
      ...cards([30, 40, 20], refs.slice(1)).map((el, i) =>
        React.cloneElement(el, { key: i + 1 }),
      ),
    );
  const { render } = await mount(tree(50));
  assert.deepStrictEqual(
    rects(refs).map((r) => [r.x, r.y]),
    [
      [0, 0],
      [165, 0],
      [165, 40],
      [0, 60],
    ],
  );
  render(tree(100));
  await frame();
  assert.deepStrictEqual(
    rects(refs).map((r) => [r.x, r.y]),
    [
      [0, 0],
      [165, 0],
      [165, 40],
      [165, 90],
    ],
  );
});

test('a child hidden since it mounted takes its place when it is shown', async () => {
  const refs = refsOf(3);
  const tree = (show) =>
    h(
      'box',
      { style: { layout: { name: 'masonry', columns: 3 } } },
      h('box', {
        key: 'a',
        ref: refs[0],
        style: { height: 20, display: show ? 'flex' : 'none' },
      }),
      h('box', { key: 'b', ref: refs[1], style: { height: 20 } }),
      h('box', { key: 'c', ref: refs[2], style: { height: 20 } }),
    );
  const { render } = await mount(tree(false));
  assert.deepStrictEqual(xs(refs.slice(1)), [0, 107]);
  render(tree(true));
  await frame();
  assert.deepStrictEqual(xs(refs), [0, 107, 213]);
});

test('children that arrive, leave or change places are laid out again', async () => {
  const refs = {
    a: React.createRef(),
    b: React.createRef(),
    c: React.createRef(),
    d: React.createRef(),
  };
  const tree = (keys) =>
    h(
      'box',
      { style: { layout: { name: 'masonry', columns: 3 } } },
      keys.map((k) =>
        h('box', { key: k, ref: refs[k], style: { height: 20 } }),
      ),
    );
  const { render } = await mount(tree(['a', 'b', 'c']));
  const x = (k) => rel(refs[k].current).x;
  assert.deepStrictEqual([x('a'), x('b'), x('c')], [0, 107, 213]);
  render(tree(['c', 'a', 'b']));
  await frame();
  assert.deepStrictEqual([x('c'), x('a'), x('b')], [0, 107, 213]);
  render(tree(['c', 'b']));
  await frame();
  assert.deepStrictEqual([x('c'), x('b')], [0, 107]);
  render(tree(['c', 'b', 'd']));
  await frame();
  assert.strictEqual(x('d'), 213);
});

test('a child’s layoutItem is read again when it changes', async () => {
  const refs = refsOf(3);
  const tree = (span) =>
    h(
      'box',
      { style: { layout: { name: 'masonry', columns: 2 } } },
      cards([20, 20, 20], refs, (i) =>
        i === 0 ? { layoutItem: { span } } : {},
      ),
    );
  const { render } = await mount(tree(1));
  assert.deepStrictEqual(ys(refs), [0, 0, 20]);
  render(tree(2));
  await frame();
  assert.deepStrictEqual(ys(refs), [0, 20, 20]);
});

test('a layout inside a layout: the outer places, then the inner', async () => {
  const cardRefs = refsOf(2);
  const buttons = refsOf(2);
  await mount(
    h(
      'box',
      { style: { layout: { name: 'masonry', columns: 2 } } },
      h(
        'box',
        { key: 0, ref: cardRefs[0], style: { padding: 4 } },
        h(
          'box',
          { style: { layout: 'equal-row', gap: 4 } },
          button(buttons[0], 20),
          button(buttons[1], 40),
        ),
      ),
      h('box', { key: 1, ref: cardRefs[1], style: { height: 30 } }),
    ),
  );
  assert.deepStrictEqual(xs(cardRefs), [0, 160]);
  // inside the first card, a row of two 56-wide buttons
  assert.deepStrictEqual(xs(buttons), [0, 60]);
  assert.deepStrictEqual(
    buttons.map((r) => r.current.abs.width),
    [56, 56],
  );
  assert.strictEqual(
    cardRefs[0].current.abs.height,
    26 + 8,
    'and the card fits them',
  );
});

test('in a scroll pane a scroll moves the children and asks the layout nothing', async () => {
  let calls = 0;
  define('column', {
    layout(children, c) {
      calls += 1;
      let y = 0;
      const placed = children.map((child) => {
        const at = y;
        y += child.measure({ width: c.width }).height;
        return { x: 0, y: at, width: c.width };
      });
      return { width: c.width, height: y, children: placed };
    },
  });
  const pane = React.createRef();
  const refs = refsOf(10);
  await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      h(
        'box',
        { style: { layout: 'column' } },
        cards(new Array(10).fill(50), refs),
      ),
    ),
  );
  assert.strictEqual(
    pane.current.contentHeight,
    500,
    'the pane scrolls what the layout made',
  );
  const before = calls;
  const y4 = refs[4].current.abs.y;
  pane.current.scrollTo(120);
  await frame();
  assert.strictEqual(refs[4].current.abs.y, y4 - 120);
  assert.strictEqual(
    calls,
    before,
    'a scroll is not a question for the layout',
  );
  pane.current.scrollTo(10000);
  await frame();
  assert.strictEqual(
    pane.current.scrollY,
    500 - 240,
    'clamped to what it made',
  );
});

test('a sticky header inside a laid-out card holds against the pane', async () => {
  const pane = React.createRef();
  const header = React.createRef();
  await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      h(
        'box',
        { style: { layout: { name: 'masonry', columns: 1 } } },
        h(
          'box',
          { key: 0 },
          h('box', {
            ref: header,
            style: { height: 20, position: 'sticky', top: 0 },
          }),
          h('box', { style: { height: 300 } }),
        ),
        h('box', { key: 1, style: { height: 300 } }),
      ),
    ),
  );
  pane.current.scrollTo(100);
  await frame();
  assert.strictEqual(
    header.current.abs.y - pane.current.abs.y,
    0,
    'held at the top',
  );
});

test('an absolutely positioned child is placed by its insets, not by the layout', async () => {
  const refs = refsOf(2);
  const badge = React.createRef();
  await mount(
    h(
      'box',
      { style: { layout: { name: 'masonry', columns: 2 }, padding: 10 } },
      h('box', { key: 'a', ref: refs[0], style: { height: 20 } }),
      h('box', {
        key: 'badge',
        ref: badge,
        style: {
          position: 'absolute',
          right: 0,
          top: 0,
          width: 30,
          height: 10,
        },
      }),
      h('box', { key: 'b', ref: refs[1], style: { height: 20 } }),
    ),
  );
  assert.deepStrictEqual(xs(refs), [10, 160], 'the layout never saw it');
  assert.deepStrictEqual(rel(badge.current), { x: 290, y: 0 });
});

test('a container query switches the layout in the frame the container crosses its threshold', async () => {
  const refs = refsOf(3);
  const { app } = await mount(
    h(
      'box',
      { style: { container: true } },
      h(
        'box',
        {
          style: {
            layout: { name: 'masonry', columns: 3 },
            '@container width < 250': {
              layout: { name: 'masonry', columns: 1 },
            },
          },
        },
        cards([20, 20, 20], refs),
      ),
    ),
  );
  assert.deepStrictEqual(xs(refs), [0, 107, 213]);
  await resize(app, 200, 240);
  assert.deepStrictEqual(xs(refs), [0, 0, 0]);
  assert.deepStrictEqual(ys(refs), [0, 20, 40]);
});

test('a style without the layout hands the children back to flexbox', async () => {
  const refs = refsOf(3);
  const host = React.createRef();
  const tree = (layout) =>
    h(
      'box',
      { ref: host, style: layout ? { layout } : {} },
      cards([20, 30, 40], refs),
    );
  const { render } = await mount(tree({ name: 'masonry', columns: 3 }));
  assert.deepStrictEqual(ys(refs), [0, 0, 0]);
  render(tree(null));
  await frame();
  assert.deepStrictEqual(ys(refs), [0, 20, 50], 'a column again, in order');
  assert.strictEqual(host.current._host, null);
});

test('hit testing and onLayout see where the layout put a child', async () => {
  const refs = refsOf(3);
  const seen = [];
  const { root } = await mount(
    h(
      'box',
      { style: { layout: { name: 'masonry', columns: 3 }, padding: 4 } },
      cards([20, 20, 20], refs, (i) => (i === 2 ? { margin: 3 } : {})).map(
        (el, i) =>
          i === 2
            ? React.cloneElement(el, { onLayout: (ev) => seen.push(ev) })
            : el,
      ),
    ),
  );
  const third = refs[2].current;
  assert.ok(
    root.hitTest(third.abs.x + 5, third.abs.y + 5) === third,
    'the press lands on it',
  );
  await frame();
  const last = seen.at(-1);
  assert.strictEqual(
    last.x,
    third.abs.x - third.parent.abs.x,
    'x within its parent',
  );
  assert.strictEqual(last.y, 4 + 3);
});

test('a host that unmounts takes its children’s trees with it', async () => {
  const refs = refsOf(2);
  const { render } = await mount(
    h('box', { style: { layout: 'masonry' } }, cards([20, 20], refs)),
  );
  const kids = refs.map((r) => r.current);
  render(null);
  await frame();
  assert.ok(
    kids.every((k) => k.yoga === null),
    'freed',
  );
});

// --- the pixels ---------------------------------------------------------------

const require = createRequire(import.meta.url);

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

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );

test('a masonry paints where it placed', async () => {
  const app = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const colours = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad'];
    const instance = await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: 200, height: 120, style: { backgroundColor: '#ffffff' } },
          h(
            'box',
            { style: { layout: { name: 'masonry', columns: 2 }, gap: 10 } },
            [40, 20, 30, 50].map((height, i) =>
              h('box', {
                key: i,
                style: { height, backgroundColor: colours[i] },
              }),
            ),
          ),
        ),
        resolve,
      ),
    );
    const root = instance._reactX11Node;
    root._scheduled = false;
    root.flush();
    await settle(app);
    const pixels = await readPixels(root._ctx, 200, 120);
    const hex = (x, y) => {
      const i = (y * 200 + x) * 4;
      return (
        '#' +
        [...pixels.data.slice(i, i + 3)]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('')
      );
    };
    // columns of 95 with a gap of 10: red over green on the left, blue over
    // purple on the right, each dropped where the column was shortest
    assert.strictEqual(hex(40, 20), colours[0]);
    assert.strictEqual(hex(150, 10), colours[1]);
    assert.strictEqual(hex(150, 45), colours[2]);
    assert.strictEqual(hex(40, 75), colours[3]);
    assert.strictEqual(hex(100, 20), '#ffffff', 'and the gap between them');
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});
