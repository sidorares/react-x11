// What the grid prototype costs on the layout seam, against the flexbox that
// does the nearest thing — and what `masonry` costs on the same cards. Layout
// time is WindowNode._layoutStep's, per frame, in the in-process server with
// real text shaping (KaTeX Main). docs/architecture/grid-layout.md §3.
//   npm run bench:grid
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderX11, cleanup, act } =
  await import('../../../src/testing/index.js');
const { registerLayout } = await import('../../../src/host.js');
const { registerGrid, stats } = await import('./grid-layout.js');
registerGrid(registerLayout);

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

function form(grid, n = 200) {
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
  if (grid) {
    const cells = [];
    for (let i = 0; i < n; i++) cells.push(label(i), field(i));
    return h(
      'box',
      {
        style: {
          layout: { name: 'grid', columns: 'auto 1fr' },
          columnGap: 12,
          rowGap: 6,
          padding: 12,
          flexShrink: 0,
        },
      },
      cells,
    );
  }
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

function cards(grid, n = 300) {
  if (grid === 'masonry') {
    return h(
      'box',
      {
        style: {
          layout: { name: 'masonry', columnWidth: 200 },
          gap: 8,
          padding: 8,
          flexShrink: 0,
        },
      },
      Array.from({ length: n }, (_, i) => card(i)),
    );
  }
  if (grid) {
    return h(
      'box',
      {
        style: {
          layout: {
            name: 'grid',
            columns: 'repeat(auto-fill, minmax(200px, 1fr))',
          },
          gap: 8,
          padding: 8,
          flexShrink: 0,
        },
      },
      Array.from({ length: n }, (_, i) => card(i)),
    );
  }
  return h(
    'box',
    {
      style: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        padding: 8,
        flexShrink: 0,
      },
    },
    Array.from({ length: n }, (_, i) =>
      card(i, { flexBasis: 200, flexGrow: 1, minWidth: 0 }),
    ),
  );
}

function dashboard(_grid, n = 120) {
  return h(
    'box',
    {
      style: {
        layout: {
          name: 'grid',
          columns: 'repeat(6, 1fr)',
          autoFlow: 'row dense',
        },
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
            layoutItem: {
              column: `span ${i % 3 === 0 ? 2 : 1}`,
              row: `span ${i % 5 === 0 ? 2 : 1}`,
            },
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
let patched = false;
function patch(windowNode) {
  if (patched) return;
  patched = true;
  const proto = Object.getPrototypeOf(windowNode);
  const orig = proto._layoutStep;
  let depth = 0;
  proto._layoutStep = function (...args) {
    if (depth++ === 0) frames++;
    const t = performance.now();
    try {
      return orig.apply(this, args);
    } finally {
      if (--depth === 0) layoutMs += performance.now() - t;
    }
  };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reset = () => {
  layoutMs = 0;
  frames = 0;
  stats.runs = 0;
  stats.measures = 0;
  stats.intrinsic = 0;
};

async function trial(name, build, grid) {
  // mount, three times
  const mounts = [];
  let windowNode;
  for (let k = 0; k < 3; k++) {
    cleanup();
    setters = [];
    reset();
    const pane = h(
      'box',
      { style: { flexGrow: 1, overflow: 'scroll' } },
      build(grid),
    );
    ({ windowNode } = await renderX11(pane, { fonts, width: W, height: H }));
    patch(windowNode);
    if (k === 0) {
      reset();
      cleanup();
      setters = [];
      ({ windowNode } = await renderX11(pane, { fonts, width: W, height: H }));
    }
    await act(() => sleep(20));
    mounts.push(layoutMs);
  }
  const mountStats = { ...stats };

  // one item's text changes, short to long and back
  const changes = [];
  const perChange = [];
  for (let k = 0; k < 9; k++) {
    const i = (k * 41) % setters.length;
    reset();
    await act(() => setters[i](words(i, k % 2 ? 40 : 2)));
    await act(() => sleep(5));
    changes.push(layoutMs / Math.max(1, frames));
    perChange.push({ ...stats, frames });
  }

  // the window resized, 1000 <-> 900
  const resizes = [];
  const wnd = windowNode.window;
  for (let k = 0; k < 9; k++) {
    const width = k % 2 ? W : W - 100;
    reset();
    await act(async () => {
      wnd.width = width;
      wnd.height = H;
      wnd.emit('resize', { width, height: H });
      await sleep(30);
    });
    resizes.push({ ms: layoutMs, frames });
  }
  cleanup();
  const pc = perChange[perChange.length >> 1];
  console.log(
    `${name.padEnd(28)} mount ${median(mounts).toFixed(2).padStart(7)} ms` +
      ` | one text changed ${median(changes).toFixed(3).padStart(7)} ms/frame` +
      ` | resize ${median(resizes.map((r) => r.ms))
        .toFixed(2)
        .padStart(6)} ms` +
      ` (${median(resizes.map((r) => r.frames))} frames)` +
      (grid
        ? ` | mount: ${mountStats.runs} runs, ${mountStats.intrinsic} intrinsic, ${mountStats.measures} measures;` +
          ` change: ${pc.runs} runs, ${pc.intrinsic} intrinsic, ${pc.measures} measures`
        : ''),
  );
}

for (const [name, build, both] of [
  ['form, 200 rows', form, true],
  ['cards, 300', cards, true],
  ['dashboard, 120 with spans', dashboard, false],
]) {
  if (both) await trial(`${name} — flex`, build, false);
  await trial(`${name} — grid`, build, true);
  if (build === cards) await trial(`${name} — masonry`, build, 'masonry');
}
process.exit(0);
