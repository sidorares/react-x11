// Which runs of a layout one frame makes, and where the frame's layout time
// goes: the algorithm, its children's measures, the placement or the rest of
// the pass — with what the seam remembered for the children and what it had
// to ask again. docs/architecture/grid-layout.md §3.
//   node --import tsx scripts/bench/grid/breakdown.mjs [grid|masonry] [n]
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderX11, act, screen } =
  await import('../../../src/testing/index.js');
const { registerLayout } = await import('../../../src/host.js');
const { registerGrid } = await import('./grid-layout.js');
registerGrid(registerLayout);

const FONT = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
  'KaTeX_Main-Regular.ttf',
);
const h = React.createElement;
const { useState } = React;
const which = process.argv[2] ?? 'grid';
const N = Number(process.argv[3] ?? 300);
const CHANGED = 41 % N; // the card whose text changes

const WORDS =
  'layout frame pass yoga track column row grid measure paint window server glyph cache blit damage'.split(
    ' ',
  );
const words = (i, n) =>
  Array.from(
    { length: n },
    (_, k) => WORDS[(i * 7 + k * 3) % WORDS.length],
  ).join(' ');
const setters = [];
function Live({ i, initial }) {
  const [text, setText] = useState(initial);
  setters[i] = setText;
  return h('text', { style: { fontSize: 12 } }, text);
}
const card = (i) =>
  h(
    'box',
    {
      key: i,
      style: { padding: 6, gap: 4, borderWidth: 1, borderColor: '#ccc' },
    },
    h(Live, { i, initial: words(i, 3 + ((i * 37) % 18)) }),
    h('box', { style: { height: 40, backgroundColor: '#ddd' } }),
    h(
      'box',
      { style: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 } },
      Array.from({ length: 5 }, (_, k) =>
        h('box', {
          key: k,
          style: { width: 40 + ((i + k) % 3) * 10, height: 20 },
        }),
      ),
    ),
  );
const layout =
  which === 'grid'
    ? { name: 'grid', columns: 'repeat(auto-fill, minmax(200px, 1fr))' }
    : { name: 'masonry', columnWidth: 200 };
const tree = h(
  'box',
  { style: { flexGrow: 1, overflow: 'scroll' } },
  h(
    'box',
    {
      'data-testname': 'host',
      style: { layout, gap: 8, padding: 8, flexShrink: 0 },
    },
    Array.from({ length: N }, (_, i) => card(i)),
  ),
);

const { windowNode } = await renderX11(tree, {
  fonts: { 'sans-serif': FONT },
  width: 1000,
  height: 700,
});
const host = screen.getByTestName('host');

const timers = {};
const runs = [];
function wrap(obj, name, onCall) {
  let p = obj;
  while (p && !Object.prototype.hasOwnProperty.call(p, name)) {
    p = Object.getPrototypeOf(p);
  }
  if (!p) return console.log(`no ${name}`);
  const orig = p[name];
  const t = (timers[name] = { calls: 0, ms: 0, depth: 0 });
  p[name] = function (...args) {
    t.calls++;
    onCall?.(args);
    const outer = t.depth++ === 0;
    const s = performance.now();
    try {
      return orig.apply(this, args);
    } finally {
      t.depth--;
      if (outer) t.ms += performance.now() - s;
    }
  };
}
wrap(windowNode, '_layoutStep');
wrap(windowNode, '_layoutRoot');
wrap(windowNode, '_applyContentFloors');
wrap(windowNode, '_measureHostChildWidths');
wrap(windowNode, '_placeLayoutHosts');
wrap(host, '_runLayout', ([c, final]) =>
  runs.push(
    `${final ? 'final ' : ''}${c.widthMode} ${Math.round(c.width)} / ${c.heightMode} ${Math.round(c.height)}`,
  ),
);
const { isMeasuringExactly } = await import('../../../src/styles.js');
// hits and misses: a miss clears `_hostLaidAt` before it lays anything out
const SENTINEL = {};
const memo = { hit: 0, miss: 0, missExact: 0, keys: new Map() };
for (const name of ['_measureInHost', '_intrinsicInHost']) {
  let p = host;
  while (p && !Object.prototype.hasOwnProperty.call(p, name)) {
    p = Object.getPrototypeOf(p);
  }
  const orig = p[name];
  p[name] = function (c) {
    const before = this._hostLaidAt;
    this._hostLaidAt = SENTINEL;
    const out = orig.call(this, c);
    if (this._hostLaidAt === SENTINEL) {
      this._hostLaidAt = before;
      memo.hit++;
    } else {
      memo.miss++;
      if (isMeasuringExactly()) memo.missExact++;
      const key = `${name === '_intrinsicInHost' ? 'intrinsic' : JSON.stringify(c)}${isMeasuringExactly() ? ' exact' : ''}`;
      memo.keys.set(key, (memo.keys.get(key) ?? 0) + 1);
    }
    return out;
  };
}
let phase = 'other';
for (const name of ['_placeLayoutHosts', '_runLayout']) {
  let p = name === '_runLayout' ? host : windowNode;
  while (p && !Object.prototype.hasOwnProperty.call(p, name)) {
    p = Object.getPrototypeOf(p);
  }
  const orig = p[name];
  p[name] = function (...args) {
    const was = phase;
    phase = name === '_runLayout' ? 'run' : 'place';
    try {
      return orig.apply(this, args);
    } finally {
      phase = was;
    }
  };
}
const byPhase = {};
{
  let p = host.yoga;
  while (p && !Object.prototype.hasOwnProperty.call(p, 'calculateLayout')) {
    p = Object.getPrototypeOf(p);
  }
  const orig = p.calculateLayout;
  p.calculateLayout = function (...args) {
    byPhase[phase] = (byPhase[phase] ?? 0) + 1;
    return orig.apply(this, args);
  };
}
wrap(host, '_measureInHost');
wrap(host, '_intrinsicInHost');
wrap(host, '_measureHostChildHeights');
let resets = 0;
{
  let p = host;
  while (p && !Object.prototype.hasOwnProperty.call(p, '_hostSizesNow')) {
    p = Object.getPrototypeOf(p);
  }
  if (p) {
    const orig = p._hostSizesNow;
    p._hostSizesNow = function () {
      const before = this._hostSizes;
      const out = orig.call(this);
      if (this._hostSizes !== before) resets++;
      return out;
    };
  }
}

const reset = () => {
  for (const t of Object.values(timers)) {
    t.calls = 0;
    t.ms = 0;
  }
  runs.length = 0;
  resets = 0;
  memo.hit = 0;
  memo.miss = 0;
  memo.missExact = 0;
  memo.keys.clear();
  for (const k of Object.keys(byPhase)) delete byPhase[k];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastMemo = null;

async function frame(label, fn) {
  reset();
  await act(fn);
  await act(() => sleep(10));
  console.log(`\n== ${which}, ${N} cards: ${label}`);
  console.log(`  runs (${runs.length}): ${runs.join(' | ')}`);
  console.log(`  memo resets: ${resets}`);
  console.log(
    `  memo: ${memo.hit} hits, ${memo.miss} misses (${memo.missExact} off the grid); layouts by phase ${JSON.stringify(byPhase)}`,
  );
  const top = [...memo.keys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(
    `  missed most: ${top.map(([k, n]) => `${n}× ${k}`).join(' | ')}`,
  );
  const probe = host.children[5];
  const m = probe._hostSizes;
  console.log(
    `  child 5: memo ${m === lastMemo ? 'same' : 'NEW'}; exact ${m ? JSON.stringify([...m.exact.keys()]) : '-'}; onGrid ${m ? JSON.stringify([...m.onGrid.keys()]) : '-'}; laidAt ${JSON.stringify(probe._hostLaidAt)}; dirty ${probe.yoga.isDirty()}`,
  );
  lastMemo = m;
  for (const [name, t] of Object.entries(timers)) {
    if (t.calls) {
      console.log(
        `  ${name.padEnd(24)} ${String(t.calls).padStart(6)} calls ${t.ms.toFixed(2).padStart(8)} ms`,
      );
    }
  }
}

await act(() => sleep(20));
await frame('one text changed', () => setters[CHANGED](words(CHANGED, 40)));
await frame('it changed back', () => setters[CHANGED](words(CHANGED, 2)));
const wnd = windowNode.window;
await frame('resized 1000 -> 900', async () => {
  wnd.width = 900;
  wnd.emit('resize', { width: 900, height: 700 });
  await sleep(30);
});
process.exit(0);
