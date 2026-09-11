// Container queries: a style asking about the box it is inside rather than
// the window it is in — '@container width >= 400', or '@container sidebar
// width >= 400' to name the container. A container's size is what a layout
// pass produces, so the blocks are resolved after the pass and the tree laid
// out once more when an answer moved (nodes/queries.js `_resolveContainerQueries`).
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createStyles, flattenStyle } from '../src/styles.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const nodeOf = (app) => app.windows[0]._reactX11Node;

/** What a real ConfigureNotify does. */
async function resize(app, width, height = 300) {
  const wnd = app.windows[0];
  wnd.width = width;
  wnd.height = height;
  wnd.emit('resize', { width, height });
  await tick();
}

/** Run `fn` with console.error and console.warn captured, and put back
 *  `process.exitCode` — a reported style error marks the process failed. */
async function capturing(fn) {
  const errors = [];
  const warnings = [];
  const { error, warn } = console;
  const code = process.exitCode;
  console.error = (...args) => errors.push(args.join(' '));
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await fn({ errors, warnings });
  } finally {
    console.error = error;
    console.warn = warn;
    process.exitCode = code;
  }
  return { errors, warnings };
}

const s = createStyles({
  row: { flexDirection: 'row', flexGrow: 1 },
  sidebar: { container: true, width: 200 },
  main: { container: true, flexGrow: 1, minWidth: 0 },
  // stacked in a narrow container, side by side with room to spare
  card: {
    flexDirection: 'column',
    gap: 4,
    '@container width >= 400': { flexDirection: 'row', gap: 16 },
  },
  dot: { width: 10, height: 10 },
});

const card = (key, style = s.card) =>
  h(
    'box',
    { key, style },
    h('box', { key: 'a', style: s.dot }),
    h('box', { key: 'b', style: s.dot }),
  );

/** A sidebar pane of 200 and a main pane taking the rest, a card in each. */
async function mountPanes(width, { wrap = false, cardStyle = s.card } = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (style) => {
    const inMain = wrap
      ? h('box', { style: { flexGrow: 1 } }, card('m', style))
      : card('m', style);
    x11Root.render(
      h(
        'window',
        { width, height: 300 },
        h(
          'box',
          { style: s.row },
          h('box', { key: 's', style: s.sidebar }, card('s', style)),
          h('box', { key: 'm', style: s.main }, inMain),
        ),
      ),
    );
  };
  render(cardStyle);
  await tick();
  const [sidebar, main] = nodeOf(app).children[0].children;
  const sideCard = sidebar.children[0];
  const mainCard = wrap ? main.children[0].children[0] : main.children[0];
  return { app, x11Root, render, sidebar, main, sideCard, mainCard };
}

const stacked = (node) => {
  const [a, b] = node.children;
  return a.abs.x === b.abs.x && b.abs.y - a.abs.y === 14; // 10 tall plus the 4 gap
};
const sideBySide = (node) => {
  const [a, b] = node.children;
  return a.abs.y === b.abs.y && b.abs.x - a.abs.x === 26; // 10 wide plus the 16 gap
};

test('a block answers to the nearest container, not to the window', async () => {
  const { app, x11Root, sideCard, mainCard, main } = await mountPanes(800);
  assert.strictEqual(main.abs.width, 600, 'the main pane takes what is left');
  assert.strictEqual(
    sideCard.style.flexDirection,
    'column',
    '200 wide: stacked',
  );
  assert.strictEqual(mainCard.style.flexDirection, 'row', '600 wide: a row');
  // and the answer reached yoga in the same frame, not the style bag alone
  assert.ok(stacked(sideCard), 'the sidebar card is stacked');
  assert.ok(sideBySide(mainCard), 'the main card is side by side');

  // the window is still wide when the pane is not: a window query could
  // not tell these two cards apart
  await resize(app, 500);
  assert.strictEqual(main.abs.width, 300);
  assert.strictEqual(
    mainCard.style.flexDirection,
    'column',
    'the pane narrowed',
  );
  assert.ok(stacked(mainCard));
  await resize(app, 800);
  assert.strictEqual(mainCard.style.flexDirection, 'row', 'and back again');
  assert.ok(sideBySide(mainCard));
  await x11Root.unmount();
});

test('a wrapper between container and dependent changes nothing', async () => {
  const plain = await mountPanes(800);
  const wrapped = await mountPanes(800, { wrap: true });
  assert.strictEqual(wrapped.mainCard.style.flexDirection, 'row');
  assert.strictEqual(
    wrapped.mainCard.style.flexDirection,
    plain.mainCard.style.flexDirection,
    'the query reaches past the wrapper to the declared container',
  );
  await plain.x11Root.unmount();
  await wrapped.x11Root.unmount();
});

test('a frame where no answer moves pays no extra pass; a flip pays what the change would', async () => {
  // the control: the same tree with the wide layout written plainly
  const plain = createStyles({ card: { flexDirection: 'row', gap: 16 } });
  const control = await mountPanes(800, { cardStyle: plain.card });
  const queried = await mountPanes(800);
  const passes = async (mounted, fn) => {
    const root = nodeOf(mounted.app);
    const before = root._layoutPasses;
    await fn(mounted);
    return root._layoutPasses - before;
  };
  // a resize that crosses no threshold: main goes 600 -> 500, still >= 400
  const steadyControl = await passes(control, (m) => resize(m.app, 700));
  const steadyQueried = await passes(queried, (m) => resize(m.app, 700));
  assert.strictEqual(
    steadyQueried,
    steadyControl,
    'container blocks that keep their answer cost the frame nothing',
  );
  // one that does: 500 -> 300. What the flip costs on top of the resize is
  // at most what the same change costs when React makes it — a layout pass
  // and the content floors a changed layout property owes
  const flipped = await passes(queried, (m) => resize(m.app, 500));
  const fromReact = await passes(control, async (m) => {
    m.render({ flexDirection: 'column', gap: 4 });
    await tick();
  });
  assert.ok(flipped > steadyQueried, 'a flip re-lays out');
  assert.ok(
    flipped <= steadyQueried + fromReact,
    `the flip (${flipped}) costs at most the resize (${steadyQueried}) plus ` +
      `what the same change costs from React (${fromReact})`,
  );
  await control.x11Root.unmount();
  await queried.x11Root.unmount();
});

test('a tree with no container queries never enters the settle step', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 800, height: 300 },
      h(
        'box',
        { style: { flexGrow: 1, padding: 4 } },
        h('box', { style: s.dot }),
      ),
    ),
  );
  await tick();
  const root = nodeOf(app);
  assert.strictEqual(root._containerQueryNodes.size, 0, 'nothing registered');
  let rounds = 0;
  const original = root._resolveContainerQueries;
  root._resolveContainerQueries = function (...args) {
    rounds += 1;
    return original.apply(this, args);
  };
  const before = root._layoutPasses;
  await resize(app, 700);
  assert.strictEqual(root._layoutPasses - before, 1, 'the resize is one pass');
  assert.strictEqual(rounds, 0, 'and no round of container resolution ran');
  await x11Root.unmount();
});

test('a named query reaches past a nearer unnamed container', async () => {
  const named = createStyles({
    pane: { container: 'pane', width: 600, height: 200 },
    // the card is a container for its own contents, and narrow
    card: { container: true, width: 150, flexDirection: 'row' },
    // asks the card: it is 150 wide, so this stays small
    detail: { width: 10, height: 10, '@container width >= 400': { width: 40 } },
    // asks the pane by name, through the card: the pane is 600 wide
    label: {
      width: 10,
      height: 10,
      '@container pane width >= 400': { width: 40 },
    },
    // a name nothing above carries: the block does not apply, and nothing
    // is said about it — this is what lets one component render inside and
    // outside its context
    stray: {
      width: 10,
      height: 10,
      '@container drawer width >= 1': { width: 40 },
    },
  });
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const { errors } = await capturing(async () => {
    x11Root.render(
      h(
        'window',
        { width: 800, height: 300 },
        h(
          'box',
          { style: named.pane },
          h(
            'box',
            { style: named.card },
            h('box', { key: 'd', style: named.detail }),
            h('box', { key: 'l', style: named.label }),
            h('box', { key: 's', style: named.stray }),
          ),
        ),
      ),
    );
    await tick();
  });
  const [detail, label, stray] = nodeOf(app).children[0].children[0].children;
  assert.strictEqual(
    detail.style.width,
    10,
    'the card is the nearest container, and narrow',
  );
  assert.strictEqual(label.style.width, 40, '"pane" is found past the card');
  assert.strictEqual(stray.style.width, 10, 'an unknown name applies nothing');
  assert.deepStrictEqual(errors, [], 'and reports nothing');
  assert.strictEqual(label.abs.width, 40, 'the answer reached yoga');
  await x11Root.unmount();
});

test('an unnamed query with no container above it is reported', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const { errors } = await capturing(async () => {
    x11Root.render(
      h(
        'window',
        { width: 800, height: 300 },
        h('box', {
          style: {
            width: 10,
            height: 10,
            '@container width >= 1': { width: 20 },
          },
        }),
      ),
    );
    await tick();
    await resize(app, 700);
  });
  assert.strictEqual(errors.length, 1, 'said once, not once per layout pass');
  assert.match(
    errors[0],
    /<box> has an "@container" block and no container above it/,
  );
  assert.match(errors[0], /The block does not apply/);
  assert.strictEqual(nodeOf(app).children[0].style.width, 10);
  await x11Root.unmount();
});

test('a design that cannot settle is pinned, and said once', async () => {
  // the container is sized by its content, and the block moves the content:
  // under 150 wide the child grows to 200, at 200 the block no longer
  // matches and the child is 100 again — no size satisfies it
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const { warnings } = await capturing(async () => {
    x11Root.render(
      h(
        'window',
        { width: 800, height: 300 },
        h(
          'box',
          {
            style: {
              container: true,
              flexDirection: 'row',
              alignSelf: 'flex-start',
            },
          },
          h('box', {
            style: {
              width: 100,
              height: 10,
              '@container width < 150': { width: 200 },
            },
          }),
        ),
      ),
    );
    await tick();
    // frames that lay out again find the same container size and hold
    await resize(app, 700);
    await resize(app, 600);
  });
  const container = nodeOf(app).children[0];
  const child = container.children[0];
  assert.strictEqual(warnings.length, 1, 'one warning, not one per frame');
  assert.match(warnings[0], /"@container" blocks on <box> cannot settle/);
  assert.strictEqual(child.style.width, 200, 'held at the answer it had');
  assert.strictEqual(container.abs.width, 200, 'and the layout agrees with it');
  await x11Root.unmount();
});

test('a block flipping during a live resize re-measures the floors it changed', async () => {
  // A pane of fixed height whose cards are rows while it is wide and
  // columns once it is not. As columns they no longer fit the pane, and
  // yoga would squeeze them down to whatever `minHeight` floor they carry —
  // the row's, unless the flip re-measures. `liveResizing` is the Cocoa
  // window's flag under which floor measurement is deferred during a drag.
  const live = createStyles({
    pane: { container: true, flexGrow: 1, padding: 12, gap: 12 },
    card: {
      flexDirection: 'column',
      gap: 10,
      padding: 12,
      '@container width >= 400': { flexDirection: 'row' },
    },
    thumb: { width: 40, height: 40 },
    body: { flexGrow: 1, minWidth: 0, gap: 4 },
    line: { height: 16 },
    toolbar: { width: 60, height: 20, flexShrink: 0 },
  });
  const cardEl = (key) =>
    h(
      'box',
      { key, style: live.card },
      h('box', { key: 't', style: live.thumb }),
      h(
        'box',
        { key: 'b', style: live.body },
        h('box', { key: '1', style: live.line }),
        h('box', { key: '2', style: live.line }),
      ),
      h('box', { key: 'x', style: live.toolbar }),
    );
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 800, height: 300 },
      h('box', { style: live.pane }, cardEl('a'), cardEl('b'), cardEl('c')),
    ),
  );
  await tick();
  const cards = nodeOf(app).children[0].children;
  assert.deepStrictEqual(
    cards.map((c) => c.abs.height),
    [64, 64, 64],
    'rows: 40 tall inside 12 of padding',
  );

  const wnd = app.windows[0];
  // a failing assertion must not leave the window mid-drag: the floor
  // catch-up waits on `liveResizing` and would keep the process alive
  try {
    wnd.liveResizing = true;
    await resize(app, 380);
    // 12 + 40 + 10 + (16 + 4 + 16) + 10 + 20 + 12, and three of them do not
    // fit in 300 — so this is only true if the floors were measured afresh
    assert.deepStrictEqual(
      cards.map((c) => c.abs.height),
      [140, 140, 140],
      'columns at their content height, mid-drag',
    );
    assert.deepStrictEqual(
      cards.map((c) => c.children[1].abs.height),
      [36, 36, 36],
      'and the body inside is not squeezed either',
    );
  } finally {
    wnd.liveResizing = false;
  }
  await tick();
  await tick();
  assert.deepStrictEqual(
    cards.map((c) => c.abs.height),
    [140, 140, 140],
  );
  await x11Root.unmount();
});

test('thresholds are in the logical pixels the dependent writes its own lengths in', async () => {
  const scaled = createStyles({
    // 150 logical is 300 device pixels under scale 2
    container: { container: true, width: 150, height: 20 },
    wide: { container: true, width: 250, height: 20 },
    probe: { width: 10, height: 10, '@container width >= 200': { width: 40 } },
  });
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 800, height: 300 },
      h(
        'box',
        { scale: 2 },
        h(
          'box',
          { key: 'a', style: scaled.container },
          h('box', { style: scaled.probe }),
        ),
        h(
          'box',
          { key: 'b', style: scaled.wide },
          h('box', { style: scaled.probe }),
        ),
      ),
    ),
  );
  await tick();
  const [narrow, wide] = nodeOf(app).children[0].children;
  assert.strictEqual(
    narrow.abs.width,
    300,
    'the container really is 300 device pixels',
  );
  assert.strictEqual(
    narrow.children[0].style.width,
    20,
    '150 logical is under 200: not matched',
  );
  assert.strictEqual(
    wide.children[0].style.width,
    80,
    '250 logical is over it',
  );
  await x11Root.unmount();
});

test('an auto-sized window is created at the size its container blocks produce', async () => {
  const auto = createStyles({
    container: { container: true, width: 500 },
    card: {
      width: 50,
      height: 50,
      '@container width >= 400': { width: 300, height: 100 },
    },
  });
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      null,
      h('box', { style: auto.container }, h('box', { style: auto.card })),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  assert.strictEqual(wnd.width, 500);
  assert.strictEqual(
    wnd.height,
    100,
    'the block applied before CreateWindow, not a frame later',
  );
  await x11Root.unmount();
});

test('the same query key in two entries of a style array merges, like a state block', () => {
  assert.deepStrictEqual(
    flattenStyle([
      { '@container width >= 400': { gap: 8 } },
      { '@container width >= 400': { flexDirection: 'row' } },
    ]),
    { '@container width >= 400': { gap: 8, flexDirection: 'row' } },
  );
  assert.deepStrictEqual(
    flattenStyle([
      { '@width >= 600': { gap: 8 } },
      { '@width >= 600': { padding: 4 } },
    ]),
    { '@width >= 600': { gap: 8, padding: 4 } },
  );
});

test('a bad container query or declaration is an error that shows the shape', () => {
  assert.throws(
    () => createStyles({ a: { '@container 9pane width >= 1': {} } }),
    /bad query "@container 9pane width >= 1"/,
  );
  assert.throws(
    () => createStyles({ a: { '@container width => 1': {} } }),
    /bad query/,
  );
  assert.throws(
    () => createStyles({ a: { container: '9pane' } }),
    /invalid container "9pane"/,
  );
  assert.throws(
    () => createStyles({ a: { container: 1 } }),
    /invalid container 1/,
  );
  // a container block may carry layout properties, like a size query
  createStyles({
    a: { '@container width >= 1': { padding: 20, flexGrow: 2 } },
  });
  createStyles({ a: { container: 'side-bar_2' } });
});
