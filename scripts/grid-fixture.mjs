// The corpus test/grid-conformance.test.js holds the grid to: seeded grids,
// laid out by Chrome, with the rects Chrome gave each item written to
// test/fixtures/grid-chrome.json. Run it to regenerate the fixture — when the
// corpus should cover something new, or to hold the grid to a newer Chrome:
//
//   node scripts/grid-fixture.mjs
//   CHROME=/path/to/chrome node scripts/grid-fixture.mjs
//
// The grids hold boxes, never text — an item's content is a box of a fixed
// size, or a wrapping row of fixed chips where it needs a min-content width
// short of its max-content one — so both engines agree on every content size
// and the fixture is the same on any machine. Every case is tagged with the
// features it uses, so a mismatch can be charged to one. Half the corpus
// piles features together; the other half adds exactly one of the harder
// features to a case otherwise made of plain ones, so each has cases of its
// own (docs/architecture/grid-layout.md).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = new URL('../test/fixtures/grid-chrome.json', import.meta.url);

// --- the corpus -------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

// CSS's auto-repeat count for one track of a definite size
const autoCount = (track) => (width, gap) =>
  Math.max(1, Math.floor((width + gap) / (track + gap)));

// [template, column count or f(width, gap), tags]
const COLUMNS = [
  ['100px 1fr 2fr', 3, ['fixed', 'fr']],
  ['repeat(3, 1fr)', 3, ['repeat', 'fr']],
  ['repeat(4, 1fr)', 4, ['repeat', 'fr']],
  ['auto 1fr', 2, ['auto', 'fr']],
  ['auto auto auto', 3, ['auto']],
  ['minmax(100px, 1fr) 2fr', 2, ['minmax', 'fr']],
  [
    'repeat(auto-fill, minmax(80px, 1fr))',
    autoCount(80),
    ['auto-fill', 'minmax', 'fr'],
  ],
  [
    'repeat(auto-fit, minmax(80px, 1fr))',
    autoCount(80),
    ['auto-fit', 'minmax', 'fr'],
  ],
  ['max-content 1fr', 2, ['max-content', 'fr']],
  ['min-content 1fr', 2, ['min-content', 'fr']],
  ['fit-content(120px) 1fr', 2, ['fit-content', 'fr']],
  ['25% 1fr 25%', 3, ['percent', 'fr']],
  ['repeat(2, 60px 1fr)', 4, ['repeat', 'fixed', 'fr']],
  ['minmax(0, 1fr) minmax(0, 1fr)', 2, ['minmax', 'fr']],
  ['150px 150px', 2, ['fixed']],
  ['repeat(auto-fill, 90px)', autoCount(90), ['auto-fill', 'fixed']],
  ['1fr', 1, ['fr']],
  ['auto 120px auto', 3, ['auto', 'fixed']],
  ['2fr 1fr', 2, ['fr']],
  ['minmax(120px, max-content) 1fr', 2, ['minmax', 'max-content', 'fr']],
];

const ROWS = [
  ['40px', ['explicit-rows']],
  ['auto 60px', ['explicit-rows']],
  ['repeat(2, 30px)', ['explicit-rows', 'repeat']],
  ['minmax(50px, auto)', ['explicit-rows', 'minmax']],
  ['1fr 2fr', ['explicit-rows', 'fr-rows']],
];

const AREAS = [
  {
    columns: '80px 1fr',
    rows: '30px auto 20px',
    areas: ['head head', 'side main', 'foot foot'],
    names: ['head', 'side', 'main', 'foot'],
  },
  {
    columns: '1fr 1fr 1fr',
    areas: ['a a b', 'c d d'],
    names: ['a', 'b', 'c', 'd'],
  },
  {
    columns: 'auto 1fr',
    areas: ['nav main', 'nav aside'],
    names: ['nav', 'main', 'aside'],
  },
];

// the harder features, one of which an isolated case adds
const ISOLATED = [
  'neg-full-row',
  'neg-other',
  'span-overflow',
  'implicit-columns',
  'align-self',
  'justify-self',
  'justify-content',
  'align-content',
  'definite-height',
  'column-flow',
];

function content(r, tags) {
  const c = r();
  if (c < 0.3) {
    return {
      type: 'block',
      w: 20 + Math.floor(r() * 60),
      h: 10 + Math.floor(r() * 30),
    };
  }
  if (c < 0.65) {
    tags.add('chips');
    return {
      type: 'chips',
      chips: Array.from(
        { length: 2 + Math.floor(r() * 5) },
        () => 20 + Math.floor(r() * 40),
      ),
    };
  }
  if (c < 0.8) {
    tags.add('fixed-size-item');
    return {
      type: 'fixed',
      w: 30 + Math.floor(r() * 70),
      h: 10 + Math.floor(r() * 30),
    };
  }
  return { type: 'block', w: 0, h: 10 + Math.floor(r() * 30) };
}

function placeItem(r, cols, tags, mixed) {
  const it = {};
  const p = r();
  if (mixed && p < 0.1) {
    it.column = '1 / -1';
    tags.add('neg-full-row');
  } else if (mixed && p < 0.15) {
    it.column = '-2';
    tags.add('neg-other');
  } else if (mixed && p < 0.2) {
    it.column = `span ${cols + 1}`;
    tags.add('span-overflow');
  } else if (mixed && p < 0.24) {
    it.column = cols + 2;
    tags.add('implicit-columns');
  } else if (cols >= 2 && p < 0.36) {
    it.column = 'span 2';
    tags.add('span');
  } else if (cols >= 3 && p < 0.41) {
    it.column = 'span 3';
    tags.add('span');
  } else if (p < 0.5) {
    it.column = 1 + Math.floor(r() * cols);
    tags.add('line');
  } else if (cols >= 2 && p < 0.55) {
    const a = 1 + Math.floor(r() * (cols - 1));
    it.column = `${a} / ${a + 2}`;
    tags.add('line-range');
  }
  if (r() < 0.1) {
    it.row = 'span 2';
    tags.add('row-span');
  } else if (r() < 0.06) {
    it.row = 1 + Math.floor(r() * 3);
    tags.add('row-line');
  }
  it.content = content(r, tags);
  return it;
}

function addIsolated(r, feature, grid, items, cols) {
  const some = () => {
    const k = 1 + Math.floor(r() * Math.min(3, items.length));
    const picked = new Set();
    while (picked.size < k) picked.add(Math.floor(r() * items.length));
    return [...picked].map((i) => items[i]);
  };
  const one = () => items[Math.floor(r() * items.length)];
  switch (feature) {
    case 'neg-full-row':
      one().column = '1 / -1';
      break;
    case 'neg-other':
      one().column = pick(r, ['-2', '2 / -1', '-3 / -1', 'span 2 / -1']);
      break;
    case 'span-overflow':
      one().column = `span ${cols + 1}`;
      break;
    case 'implicit-columns':
      one().column = cols + 2;
      break;
    case 'align-self':
      for (const it of some())
        it.alignSelf = pick(r, ['start', 'center', 'end']);
      break;
    case 'justify-self':
      for (const it of some()) {
        it.justifySelf = pick(r, ['start', 'center', 'end']);
      }
      break;
    case 'justify-content':
      grid.justifyContent = pick(r, [
        'center',
        'end',
        'space-between',
        'space-evenly',
      ]);
      break;
    case 'align-content':
      grid.height = 300;
      grid.alignContent = pick(r, ['center', 'end', 'space-between']);
      break;
    case 'definite-height':
      grid.height = 300;
      break;
    case 'column-flow':
      grid.autoFlow = 'column';
      delete grid.rows;
      break;
    default:
      break;
  }
}

/** `mode` 'mixed' piles the harder features into a third of the cases;
 *  'isolate' adds exactly one to two thirds of them, in turn. */
function makeCases(seed, n, mode) {
  const r = rng(seed);
  const cases = [];
  for (let id = 0; id < n; id++) {
    const isolated =
      mode === 'isolate' && id % 3 !== 0
        ? ISOLATED[Math.floor(id / 1.5) % ISOLATED.length]
        : null;
    const mixed = mode === 'mixed' && id % 3 === 2;
    const tags = new Set();
    const width = pick(r, [300, 400, 520]);
    const grid = {};
    const g = r();
    grid.columnGap = g < 0.4 ? 0 : g < 0.8 ? 8 : 10;
    grid.rowGap = g < 0.4 ? 0 : g < 0.8 ? 8 : 4;
    if (grid.columnGap || grid.rowGap) tags.add('gap');
    const items = [];
    let cols = 0;
    if (!isolated && r() < 0.12) {
      const a = pick(r, AREAS);
      grid.columns = a.columns;
      if (a.rows) grid.rows = a.rows;
      grid.areas = a.areas;
      tags.add('areas');
      const names = [...a.names];
      for (let k = names.length - 1; k > 0; k--) {
        const j = Math.floor(r() * (k + 1));
        [names[k], names[j]] = [names[j], names[k]];
      }
      for (const name of names) {
        items.push({ area: name, content: content(r, tags) });
      }
      const extra = Math.floor(r() * 3);
      for (let k = 0; k < extra; k++) items.push({ content: content(r, tags) });
      if (extra) tags.add('auto-after-areas');
    } else {
      const [template, count, ctags] = pick(r, COLUMNS);
      grid.columns = template;
      for (const t of ctags) tags.add(t);
      cols = typeof count === 'function' ? count(width, grid.columnGap) : count;
      if (r() < 0.3) {
        const [rt, rtags] = pick(r, ROWS);
        grid.rows = rt;
        for (const t of rtags) tags.add(t);
      }
      const ar = r();
      if (ar < 0.12) {
        grid.autoRows = '30px';
        tags.add('auto-rows');
      } else if (ar < 0.2) {
        grid.autoRows = 'minmax(40px, auto)';
        tags.add('auto-rows');
        tags.add('minmax');
      }
      if (r() < 0.12 && isolated !== 'column-flow') {
        grid.autoFlow = 'row dense';
        tags.add('dense');
      }
      const count2 = 2 + Math.floor(r() * 9);
      for (let k = 0; k < count2; k++) {
        items.push(placeItem(r, cols, tags, mixed));
      }
    }
    if (r() < 0.15) {
      grid.justifyItems = pick(r, ['start', 'center', 'end']);
      tags.add('justify-items');
    }
    if (r() < 0.15) {
      grid.alignItems = pick(r, ['start', 'center', 'end']);
      tags.add('align-items');
    }
    if (isolated) {
      if (isolated === 'column-flow') {
        tags.delete('explicit-rows');
        tags.delete('fr-rows');
      }
      addIsolated(r, isolated, grid, items, cols);
      tags.add(isolated);
    }
    if (mixed) {
      if (r() < 0.25) {
        grid.justifyContent = pick(r, [
          'center',
          'end',
          'space-between',
          'space-evenly',
        ]);
        tags.add('justify-content');
      }
      if (r() < 0.2) {
        grid.height = 300;
        tags.add('definite-height');
        if (r() < 0.6) {
          grid.alignContent = pick(r, ['center', 'end', 'space-between']);
          tags.add('align-content');
        }
      }
      if (!grid.areas && r() < 0.12) {
        grid.autoFlow = r() < 0.5 ? 'column' : 'column dense';
        tags.delete('dense');
        tags.add('column-flow');
      }
      for (const it of items) {
        if (r() < 0.15) {
          it.alignSelf = pick(r, ['start', 'center', 'end']);
          tags.add('align-self');
        }
        if (r() < 0.15) {
          it.justifySelf = pick(r, ['start', 'center', 'end']);
          tags.add('justify-self');
        }
      }
    }
    cases.push({ id, width, tags: [...tags].sort(), grid, items });
  }
  return cases;
}

// --- Chrome -----------------------------------------------------------------

/* global document, CASES -- inPage runs in Chrome, not in node */

/** Lay every case out in the page and put the rects in `<pre id="out">`,
 *  which `--dump-dom` hands back. Runs in the browser. */
function inPage() {
  const built = [];
  for (const c of CASES) {
    const g = document.createElement('div');
    const G = c.grid;
    const rejected = [];
    const set = (el, prop, value) => {
      el.style[prop] = value;
      if (el.style[prop] === '') rejected.push(`${prop}: ${value}`);
    };
    g.style.display = 'grid';
    g.style.width = c.width + 'px';
    g.style.marginBottom = '24px';
    if (G.height != null) g.style.height = G.height + 'px';
    if (G.columns) set(g, 'gridTemplateColumns', G.columns);
    if (G.rows) set(g, 'gridTemplateRows', G.rows);
    if (G.autoRows) set(g, 'gridAutoRows', G.autoRows);
    if (G.autoFlow) set(g, 'gridAutoFlow', G.autoFlow);
    if (G.areas) {
      set(g, 'gridTemplateAreas', G.areas.map((a) => '"' + a + '"').join(' '));
    }
    g.style.columnGap = (G.columnGap ?? 0) + 'px';
    g.style.rowGap = (G.rowGap ?? 0) + 'px';
    if (G.justifyItems) set(g, 'justifyItems', G.justifyItems);
    if (G.alignItems) set(g, 'alignItems', G.alignItems);
    if (G.justifyContent) set(g, 'justifyContent', G.justifyContent);
    if (G.alignContent) set(g, 'alignContent', G.alignContent);
    const els = c.items.map((it) => {
      const e = document.createElement('div');
      if (it.column != null) set(e, 'gridColumn', String(it.column));
      if (it.row != null) set(e, 'gridRow', String(it.row));
      if (it.area) set(e, 'gridArea', it.area);
      if (it.alignSelf) set(e, 'alignSelf', it.alignSelf);
      if (it.justifySelf) set(e, 'justifySelf', it.justifySelf);
      const ct = it.content;
      if (ct.type === 'fixed') {
        e.style.width = ct.w + 'px';
        e.style.height = ct.h + 'px';
      } else if (ct.type === 'block') {
        const b = document.createElement('div');
        b.style.width = ct.w + 'px';
        b.style.height = ct.h + 'px';
        e.appendChild(b);
      } else {
        const f = document.createElement('div');
        f.style.cssText =
          'display:flex;flex-wrap:wrap;column-gap:4px;row-gap:4px';
        for (const w of ct.chips) {
          const chip = document.createElement('div');
          chip.style.cssText = 'flex:none;height:10px;width:' + w + 'px';
          f.appendChild(chip);
        }
        e.appendChild(f);
      }
      g.appendChild(e);
      return e;
    });
    document.body.appendChild(g);
    built.push({ c, g, els, rejected });
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  const out = built.map(({ c, g, els, rejected }) => {
    const gr = g.getBoundingClientRect();
    return {
      id: c.id,
      size: [r2(gr.width), r2(gr.height)],
      rects: els.map((e) => {
        const r = e.getBoundingClientRect();
        return [r2(r.x - gr.x), r2(r.y - gr.y), r2(r.width), r2(r.height)];
      }),
      rejected,
    };
  });
  document.getElementById('out').textContent = JSON.stringify(out);
}

function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const found = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((path) => existsSync(path));
  if (!found) throw new Error('no Chrome found — set CHROME to its binary');
  return found;
}

/**
 * `--dump-dom` prints the document once the page has run — and headless
 * Chrome does not always leave after that (its updater keeps it alive on
 * macOS), so the document arriving is what ends the run.
 */
function dumpDom(url, profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      chrome(),
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
        '--dump-dom',
        url,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    let timer = null;
    const done = (error) => {
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(out);
    };
    timer = setTimeout(
      () => done(new Error('Chrome did not hand the page back in two minutes')),
      120_000,
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('</html>')) done(null);
    });
    child.on('error', done);
    child.on('exit', () => done(null));
  });
}

async function layOut(cases) {
  const dir = mkdtempSync(join(tmpdir(), 'grid-fixture-'));
  try {
    const page = join(dir, 'page.html');
    writeFileSync(
      page,
      '<!doctype html><meta charset="utf-8"><style>' +
        '*{box-sizing:border-box;margin:0;padding:0}</style><body>' +
        '<pre id="out"></pre><script>' +
        `const CASES = ${JSON.stringify(cases)};\n(${inPage.toString()})();` +
        '</script>',
    );
    const dom = await dumpDom(`file://${page}`, join(dir, 'profile'));
    const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
    if (m === null) throw new Error('Chrome handed back no rects');
    return JSON.parse(
      m[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&'),
    );
  } finally {
    // Chrome, killed, may go on writing its profile for a moment
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    } catch {
      // a temporary directory left behind is the system's to clear
    }
  }
}

// --- the fixture ------------------------------------------------------------

const cases = [
  ...makeCases(7, 200, 'mixed'),
  ...makeCases(8, 200, 'isolate'),
].map((c, id) => ({ ...c, id }));
const laid = await layOut(cases);
let version = 'unknown';
try {
  version = execFileSync(chrome(), ['--version'], {
    encoding: 'utf8',
    timeout: 20_000,
  })
    .trim()
    .replace(/^Google Chrome |^Chromium /, '');
} catch {
  // the version is for the reader of the fixture; the rects are the point
}
const lines = cases.map((c, i) => {
  const got = laid[i];
  if (got.id !== c.id || got.rejected.length > 0) {
    throw new Error(
      `case ${c.id}: Chrome rejected ${got.rejected.join('; ')} — the corpus wrote CSS it does not take`,
    );
  }
  return JSON.stringify({ ...c, size: got.size, rects: got.rects });
});
// one case a line: a regenerated fixture diffs case by case
writeFileSync(
  OUT,
  `{"generatedBy":"scripts/grid-fixture.mjs","chrome":${JSON.stringify(version)},"cases":[\n` +
    `${lines.join(',\n')}\n]}\n`,
);
console.log(`${cases.length} cases, laid out by Chrome ${version}`);
