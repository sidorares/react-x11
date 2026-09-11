// What a grid costs, against the flexbox that does the nearest thing — and
// what `masonry` costs on the same cards. Layout time is
// WindowNode._layoutStep's, per frame, in the in-process server with real
// text shaping (KaTeX Main); "layouts" is every yoga calculateLayout the
// frame made, the window's own passes and each child tree's.
// docs/architecture/grid-layout.md §3.
//   npm run bench:grid
//
// Two resizes, because the difference between them is the thing to know. A
// window resized back and forth between two widths is answered from what
// each child said at those widths before; a live resize — a new width every
// frame — asks every child again, and is the one a drag feels.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderX11, cleanup, act } =
  await import('../../../src/testing/index.js');

const FONT = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
  'KaTeX_Main-Regular.ttf',
);
const fonts = { 'sans-serif': FONT };
const h = React.createElement;
const { useState } = React;
const W = 1000;
const H = 700;

const WORDS =
  'layout frame pass yoga track column row grid measure paint window server glyph cache blit damage'.split(
    ' ',
  );
const words = (i, n) =>
  Array.from(
    { length: n },
    (_, k) => WORDS[(i * 7 + k * 3) % WORDS.length],
  ).join(' ');

// a text a trial can change: setters[i](text)
let setters = [];
function Live({ i, initial, style }) {
  const [text, setText] = useState(initial);
  setters[i] = setText;
  return h('text', { style }, text);
}
const small = { fontSize: 12 };

// --- scenarios ------------------------------------------------------------------

const LABEL_W = 150;

function form(kind, n = 200) {
  const label = (i) =>
    h(Live, { key: `l${i}`, i, initial: words(i, 1 + (i % 4)), style: small });
  const field = (i) =>
    h(
      'box',
      {
        key: `f${i}`,
        style: { borderWidth: 1, borderColor: '#888', padding: 4 },
      },
      h('text', { style: small }, `value ${i}`),
    );
  if (kind === 'grid') {
    const cells = [];
    for (let i = 0; i < n; i++) cells.push(label(i), field(i));
    return h(
      'box',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          columnGap: 12,
          rowGap: 6,
          padding: 12,
          flexShrink: 0,
        },
      },
      cells,
    );
  }
  // flexbox cannot size a column by its widest label: a fixed width is the
  // nearest it comes
  return h(
    'box',
    { style: { gap: 6, padding: 12, flexShrink: 0 } },
    Array.from({ length: n }, (_, i) =>
      h(
        'box',
        { key: i, style: { flexDirection: 'row', gap: 12 } },
        h('box', { style: { width: LABEL_W } }, label(i)),
        h('box', { style: { flexGrow: 1 } }, field(i)),
      ),
    ),
  );
}

function card(i, style) {
  return h(
    'box',
    {
      key: i,
      style: {
        padding: 6,
        gap: 4,
        borderWidth: 1,
        borderColor: '#ccc',
        ...style,
      },
    },
    h(Live, { i, initial: words(i, 3 + ((i * 37) % 18)), style: small }),
    h('box', { style: { height: 40, backgroundColor: '#ddd' } }),
    h(
      'box',
      { style: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 } },
      Array.from({ length: 5 }, (_, k) =>
        h('box', {
          key: k,
          style: {
            width: 40 + ((i + k) % 3) * 10,
            height: 20,
            backgroundColor: '#eee',
          },
        }),
      ),
    ),
  );
}

function cards(kind, n = 300) {
  const pane = { gap: 8, padding: 8, flexShrink: 0 };
  if (kind === 'masonry') {
    return h(
      'box',
      { style: { layout: { name: 'masonry', columnWidth: 200 }, ...pane } },
      Array.from({ length: n }, (_, i) => card(i)),
    );
  }
  if (kind === 'grid') {
    return h(
      'box',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          ...pane,
        },
      },
      Array.from({ length: n }, (_, i) => card(i)),
    );
  }
  return h(
    'box',
    { style: { flexDirection: 'row', flexWrap: 'wrap', ...pane } },
    Array.from({ length: n }, (_, i) =>
      card(i, { flexBasis: 200, flexGrow: 1, minWidth: 0 }),
    ),
  );
}

function dashboard(_kind, n = 120) {
  return h(
    'box',
    {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(6, 1fr)',
        gridAutoFlow: 'dense',
        gap: 8,
        padding: 8,
        flexShrink: 0,
      },
    },
    Array.from({ length: n }, (_, i) =>
      h(
        'box',
        {
          key: i,
          style: {
            padding: 6,
            gap: 4,
            borderWidth: 1,
            borderColor: '#ccc',
            gridColumn: `span ${i % 3 === 0 ? 2 : 1}`,
            gridRow: `span ${i % 5 === 0 ? 2 : 1}`,
          },
        },
        h(Live, { i, initial: words(i, 2 + (i % 9)), style: small }),
        h('box', { style: { height: 30, backgroundColor: '#ddd' } }),
      ),
    ),
  );
}

// --- timing -----------------------------------------------------------------------

let layoutMs = 0;
let frames = 0;
let layouts = 0;
let patched = false;

const owner = (obj, name) => {
  let p = obj;
  while (p && !Object.prototype.hasOwnProperty.call(p, name)) {
    p = Object.getPrototypeOf(p);
  }
  return p;
};

function patch(windowNode) {
  if (patched) return;
  patched = true;
  const proto = owner(windowNode, '_layoutStep');
  const step = proto._layoutStep;
  let depth = 0;
  proto._layoutStep = function (...args) {
    if (depth++ === 0) frames++;
    const t = performance.now();
    try {
      return step.apply(this, args);
    } finally {
      if (--depth === 0) layoutMs += performance.now() - t;
    }
  };
  const yoga = owner(windowNode.yoga, 'calculateLayout');
  const calculate = yoga.calculateLayout;
  yoga.calculateLayout = function (...args) {
    layouts++;
    return calculate.apply(this, args);
  };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reset = () => {
  layoutMs = 0;
  frames = 0;
  layouts = 0;
};
const ms = (v) => `${v.toFixed(1).padStart(5)} ms`;

async function trial(name, build, kind) {
  const tree = () =>
    h('box', { style: { flexGrow: 1, overflow: 'scroll' } }, build(kind));
  // mounted four times; the first render is where the prototypes get
  // patched, so it is not counted
  const mounts = [];
  let windowNode;
  for (let k = 0; k < 4; k++) {
    cleanup();
    setters = [];
    reset();
    ({ windowNode } = await renderX11(tree(), { fonts, width: W, height: H }));
    await act(() => sleep(20));
    if (k > 0) mounts.push(layoutMs);
    patch(windowNode);
  }

  // one item's text goes from two words to forty and back
  const changes = [];
  for (let k = 0; k < 9; k++) {
    const i = (k * 41) % setters.length;
    reset();
    await act(() => setters[i](words(i, k % 2 ? 40 : 2)));
    await act(() => sleep(5));
    changes.push(layoutMs / Math.max(1, frames));
  }

  const wnd = windowNode.window;
  const resize = async (width) => {
    reset();
    await act(async () => {
      wnd.width = width;
      wnd.height = H;
      wnd.emit('resize', { width, height: H });
      await sleep(30);
    });
    return { ms: layoutMs, layouts: layouts / Math.max(1, frames) };
  };
  const between = [];
  for (let k = 0; k < 9; k++) between.push(await resize(k % 2 ? W : W - 100));
  const live = [];
  for (let k = 1; k <= 15; k++) live.push(await resize(W - 100 - k * 7));
  cleanup();
  console.log(
    `${name.padEnd(26)} mount ${ms(median(mounts))} | a text changed ` +
      `${ms(median(changes))} | resized 1000↔900 ${ms(median(between.map((r) => r.ms)))}` +
      ` | live resize ${ms(median(live.map((r) => r.ms)))},` +
      ` ${Math.round(median(live.map((r) => r.layouts)))} layouts a frame`,
  );
}

for (const [name, build, kinds] of [
  ['form, 200 rows', form, ['flex', 'grid']],
  ['cards, 300', cards, ['flex', 'grid', 'masonry']],
  ['dashboard, 120 with spans', dashboard, ['grid']],
]) {
  for (const kind of kinds) await trial(`${name} — ${kind}`, build, kind);
}
process.exit(0);
