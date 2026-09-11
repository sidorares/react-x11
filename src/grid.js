// CSS grid, built in (docs/styling.md "Grid"; the design record is
// docs/architecture/grid-layout.md). A box with `display: 'grid'` — or
// `layout: 'grid'`, the same request under the name every layout goes by —
// arranges its children by CSS Grid's placement and track sizing algorithms
// (css-grid-2 §8.5 and §12), inside the pass that lays the window out. It is
// a layout on the seam (nodes/layouthost.js), written against the contract a
// registered one is handed; what makes it CSS's is the style, which is CSS's
// own and flat — the box says `gridTemplateColumns: 'auto 1fr'`, a child
// says `gridColumn: '1 / -1'` — so a grid copied from the web lays out here
// as it was written.
//
// Pure: strings and sizes in, rects out. The parsers are memoized on the
// value written, and styles.js runs them to validate a style, so a track
// list that would not lay out is an error where it was written rather than a
// box that fell back to flexbox.
//
// Left out, on purpose: subgrid (a child's tree is its own on this seam, so
// its items cannot join the parent's track sizing), baselines, named lines,
// and the second column pass of §12.1 step 3 — see the design record.

const EPS = 1e-6;

/**
 * The furthest a line number, a span or a repeat count reaches. CSS lets a
 * UA clamp the grid, and asks that lines within ±10000 be kept, so a list
 * placing its rows by number stays exact while a typo like
 * `gridColumn: 1e9` costs a wide grid rather than the process.
 */
const MAX_TRACKS = 10000;

// --- values -------------------------------------------------------------------

const AUTO = Object.freeze({ kind: 'auto' });
const MIN_CONTENT = Object.freeze({ kind: 'min-content' });
const MAX_CONTENT = Object.freeze({ kind: 'max-content' });
const ZERO = Object.freeze({ kind: 'fixed', px: 0 });
const track = (min, max, fit = null) => Object.freeze({ min, max, fit });

/** `minmax(0, 1fr)`: a share of the room that ignores what is in it — what a
 *  bare count of tracks means, as it does in Tailwind's `grid-cols-3`. */
const EQUAL = track(ZERO, Object.freeze({ kind: 'fr', f: 1 }));
const AUTO_TRACK = track(AUTO, AUTO);

/** An auto-fit track nothing landed in: no size, and no gap either side. */
const COLLAPSED = Object.freeze({
  min: ZERO,
  max: ZERO,
  fit: null,
  collapsed: true,
});

const NO_TRACKS = Object.freeze({ tracks: Object.freeze([]), repeat: null });
const AUTO_TRACKS = Object.freeze([AUTO_TRACK]);

/** A side of a placement that names neither a line nor a span. */
const AUTO_LINE = Object.freeze({});

const FLOWS = Object.freeze({
  row: { column: false, dense: false },
  column: { column: true, dense: false },
  dense: { column: false, dense: true },
  'row dense': { column: false, dense: true },
  'dense row': { column: false, dense: true },
  'column dense': { column: true, dense: true },
  'dense column': { column: true, dense: true },
});

const ITEM_ALIGNMENTS = ['flex-start', 'center', 'flex-end', 'stretch'];
const SELF_ALIGNMENTS = ['auto', ...ITEM_ALIGNMENTS];

/** The properties a grid reads off the box that yoga never sees — a change
 *  to one asks the layout again (nodes/animation.js `_retarget`). */
export const GRID_CONTAINER_PROPS = Object.freeze([
  'gridTemplateColumns',
  'gridTemplateRows',
  'gridTemplateAreas',
  'gridAutoColumns',
  'gridAutoRows',
  'gridAutoFlow',
  'justifyItems',
]);

/** …and off each child. */
export const GRID_ITEM_PROPS = Object.freeze([
  'gridColumn',
  'gridRow',
  'gridArea',
  'justifySelf',
]);

// --- parsing ------------------------------------------------------------------

const parsed = new Map();

/** A parse, remembered by the value written. Bounded: a transition over a
 *  track list writes a new string every frame. */
function memo(key, make) {
  let value = parsed.get(key);
  if (value === undefined) {
    if (parsed.size >= 512) parsed.clear();
    value = make();
    parsed.set(key, value);
  }
  return value;
}

function invalid(prop, value, why) {
  return new SyntaxError(
    `react-x11: invalid ${prop} ${JSON.stringify(value)} — ${why}`,
  );
}

const isFixedBreadth = (b) => b.kind === 'fixed' || b.kind === 'percent';

/** CSS's `<fixed-size>`: a track whose size can be counted before anything
 *  is in it, which is what an auto repeat is made of. */
const isFixedSize = (t) =>
  t.fit === null && (isFixedBreadth(t.min) || isFixedBreadth(t.max));

const LENGTH = /^(\d+(?:\.\d*)?|\.\d+)([a-z%]*)/i;

/**
 * A CSS track list: sizes, `minmax()`, `fit-content()` and — in a template —
 * `repeat()` with a count, `auto-fill` or `auto-fit`. Lengths are logical
 * pixels and come out in device pixels (`scale`), the way every length in a
 * style arrives at layout.
 */
function parseTrackList(src, scale, prop, template) {
  let i = 0;
  const n = src.length;
  const fail = (why) => {
    throw invalid(prop, src, why);
  };
  const space = () => {
    while (i < n && /\s/.test(src[i])) i++;
  };
  const word = () => {
    space();
    const m = /^[a-z][a-z-]*/i.exec(src.slice(i));
    if (m === null) return null;
    i += m[0].length;
    return m[0].toLowerCase();
  };
  const expect = (ch) => {
    space();
    if (src[i] !== ch) {
      fail(
        i < n
          ? `expected "${ch}" before "${src.slice(i)}"`
          : `expected "${ch}" at the end`,
      );
    }
    i++;
  };
  const breadth = () => {
    space();
    if (src[i] === '[') fail('named lines ("[name]") are not supported');
    if (src[i] === '-') fail('a track size is never negative');
    const m = LENGTH.exec(src.slice(i));
    if (m !== null) {
      i += m[0].length;
      const v = Number(m[1]);
      const unit = m[2].toLowerCase();
      if (unit === 'px') return { kind: 'fixed', px: v * scale };
      if (unit === 'fr') return { kind: 'fr', f: v };
      if (unit === '%') return { kind: 'percent', f: v / 100 };
      if (unit === '' && v === 0) return ZERO;
      if (unit === '') {
        fail(
          `a length in a track list is written with its unit, "${m[1]}px"` +
            (template
              ? ` — a number on its own is a count of equal tracks, ${prop}: ${m[1]}`
              : ''),
        );
      }
      fail(`"${unit}" is not a unit a track takes — px, % and fr are`);
    }
    const w = word();
    if (w === 'auto') return AUTO;
    if (w === 'min-content') return MIN_CONTENT;
    if (w === 'max-content') return MAX_CONTENT;
    if (w === 'subgrid') {
      fail('subgrid is not supported: a grid item lays its own children out');
    }
    return fail(
      w === null
        ? `expected a track size before "${src.slice(i)}"`
        : `"${w}" is not a track size`,
    );
  };
  const size = () => {
    const at = i;
    const w = word();
    if (w === 'minmax') {
      expect('(');
      const min = breadth();
      if (min.kind === 'fr') {
        fail(
          'minmax() cannot take a flexible minimum — minmax(0, 1fr) is the usual one',
        );
      }
      expect(',');
      const max = breadth();
      expect(')');
      return track(min, max);
    }
    if (w === 'fit-content') {
      expect('(');
      const limit = breadth();
      if (!isFixedBreadth(limit)) {
        fail('fit-content() takes a length or a percentage');
      }
      expect(')');
      return track(AUTO, MAX_CONTENT, limit);
    }
    i = at;
    const b = breadth();
    // `1fr` is `minmax(auto, 1fr)`: a share of the room, but never narrower
    // than what is in it
    return b.kind === 'fr' ? track(AUTO, b) : track(b, b);
  };
  const tracks = [];
  let repeat = null;
  for (;;) {
    space();
    if (i >= n) break;
    const at = i;
    if (word() !== 'repeat') {
      i = at;
      tracks.push(size());
      continue;
    }
    if (!template) {
      fail(
        'repeat() belongs in a template — an implicit track list is its sizes, taken in turn',
      );
    }
    expect('(');
    space();
    let times;
    const m = /^\d+/.exec(src.slice(i));
    if (m !== null) {
      i += m[0].length;
      times = Math.min(Number(m[0]), MAX_TRACKS);
      if (times < 1) fail('repeat() repeats its tracks at least once');
    } else {
      times = word();
      if (times !== 'auto-fill' && times !== 'auto-fit') {
        fail('repeat() takes a count, auto-fill or auto-fit first');
      }
    }
    expect(',');
    const body = [];
    for (;;) {
      space();
      if (i >= n || src[i] === ')') break;
      body.push(size());
    }
    expect(')');
    if (body.length === 0) fail('repeat() has no tracks to repeat');
    if (typeof times === 'number') {
      for (let k = 0; k < times && tracks.length < MAX_TRACKS; k++) {
        for (const t of body) tracks.push(t);
      }
    } else if (repeat !== null) {
      fail('a track list takes one repeat(auto-fill) or repeat(auto-fit)');
    } else if (!body.every(isFixedSize)) {
      fail(
        `repeat(${times}, …) repeats tracks whose size it can count — ` +
          'minmax(200px, 1fr) or 120px, not 1fr or auto',
      );
    } else {
      repeat = { at: tracks.length, tracks: body, fit: times === 'auto-fit' };
    }
  }
  if (repeat !== null && !tracks.every(isFixedSize)) {
    fail(
      `beside repeat(${repeat.fit ? 'auto-fit' : 'auto-fill'}, …) every ` +
        'track has a size it can count, so the room left for the repeats is known',
    );
  }
  if (!template && tracks.length === 0) {
    fail('an implicit track list names at least one size');
  }
  return { tracks, repeat };
}

/**
 * `gridTemplateColumns` / `gridTemplateRows`: a CSS track list, or a number
 * — that many equal tracks, `repeat(n, minmax(0, 1fr))`, the way a count
 * reads everywhere grid is written short (Tailwind's `grid-cols-3`). A count
 * rather than a length because a track list is not a length: `maxLines: 3`
 * and `flex: 1` are numbers that are not pixels either.
 */
export function templateTracks(value, scale = 1, prop = 'gridTemplateColumns') {
  if (value == null || value === 'none') return NO_TRACKS;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1) {
      throw invalid(
        prop,
        value,
        'a number is a count of equal tracks, a whole number from 1',
      );
    }
    return memo(`#${value}`, () => ({
      tracks: Object.freeze(Array(Math.min(value, MAX_TRACKS)).fill(EQUAL)),
      repeat: null,
    }));
  }
  if (typeof value !== 'string') {
    throw invalid(
      prop,
      value,
      'expected a track list like "200px 1fr", or a count of equal tracks',
    );
  }
  return memo(`t${scale}|${value}`, () =>
    parseTrackList(value, scale, prop, true),
  );
}

/**
 * `gridAutoColumns` / `gridAutoRows`: the sizes an implicit track takes, in
 * turn — a track list without `repeat()`, or a number, which here is a
 * length: an implicit track has a size and never a count.
 */
export function autoTracks(value, scale = 1, prop = 'gridAutoRows') {
  if (value == null) return AUTO_TRACKS;
  if (typeof value === 'number') {
    if (!(value >= 0) || !Number.isFinite(value)) {
      throw invalid(prop, value, 'a number is a length, 0 or more');
    }
    return memo(`a${scale}#${value}`, () => {
      const px = { kind: 'fixed', px: value * scale };
      return Object.freeze([track(px, px)]);
    });
  }
  if (typeof value !== 'string') {
    throw invalid(
      prop,
      value,
      'expected a track size like "120px" or "minmax(40px, auto)"',
    );
  }
  return memo(
    `a${scale}|${value}`,
    () => parseTrackList(value, scale, prop, false).tracks,
  );
}

const AREA_NAME = /^[\w\--￿]+$/;

/**
 * `gridTemplateAreas`: CSS's one quoted string per row, or — which reads
 * better in a style object — an array of the rows. Every row has as many
 * cells, a run of dots is an empty one, and every name covers a rectangle.
 */
export function templateAreas(value, prop = 'gridTemplateAreas') {
  if (value == null || value === 'none') return null;
  if (Array.isArray(value)) {
    if (!value.every((row) => typeof row === 'string')) {
      throw invalid(prop, value, 'an array of areas is one string per row');
    }
    return memo(`r|${value.join('\n')}`, () => parseAreas(value, prop, value));
  }
  if (typeof value !== 'string') {
    throw invalid(
      prop,
      value,
      `expected one quoted string per row — '"head head" "side main"' — or an array of rows`,
    );
  }
  return memo(`s|${value}`, () =>
    parseAreas(quotedRows(value, prop), prop, value),
  );
}

function quotedRows(src, prop) {
  const rows = [];
  const quoted = /\s*(?:"([^"]*)"|'([^']*)')\s*/y;
  let i = 0;
  while (i < src.length) {
    quoted.lastIndex = i;
    const m = quoted.exec(src);
    if (m === null) {
      if (/^\s*$/.test(src.slice(i))) break;
      throw invalid(
        prop,
        src,
        `each row is a quoted string — '"head head" "side main"' — or pass an array of rows`,
      );
    }
    rows.push(m[1] ?? m[2]);
    i = quoted.lastIndex;
  }
  return rows;
}

function parseAreas(rows, prop, written) {
  if (rows.length === 0) throw invalid(prop, written, 'it names no rows');
  const grid = rows.map((row, r) => {
    const cells = row.match(/\.+|[^\s.]+/g) ?? [];
    if (cells.length === 0) {
      throw invalid(prop, written, `row ${r + 1} names no cells`);
    }
    for (const cell of cells) {
      if (cell[0] !== '.' && !AREA_NAME.test(cell)) {
        throw invalid(prop, written, `"${cell}" is not an area name`);
      }
    }
    return cells;
  });
  const cols = grid[0].length;
  grid.forEach((cells, r) => {
    if (cells.length !== cols) {
      throw invalid(
        prop,
        written,
        `every row has as many cells as the first — row 1 has ${cols}, ` +
          `row ${r + 1} has ${cells.length}`,
      );
    }
  });
  const names = new Map();
  grid.forEach((cells, r) =>
    cells.forEach((cell, c) => {
      if (cell[0] === '.') return;
      const a = names.get(cell);
      if (a === undefined) {
        names.set(cell, { r0: r, r1: r + 1, c0: c, c1: c + 1, cells: 1 });
      } else {
        a.r0 = Math.min(a.r0, r);
        a.r1 = Math.max(a.r1, r + 1);
        a.c0 = Math.min(a.c0, c);
        a.c1 = Math.max(a.c1, c + 1);
        a.cells++;
      }
    }),
  );
  for (const [name, a] of names) {
    // every cell in the bounding box is this name's, or there are fewer of
    // them than the box has cells
    if (a.cells !== (a.r1 - a.r0) * (a.c1 - a.c0)) {
      throw invalid(prop, written, `area "${name}" is not a rectangle`);
    }
    // the placement it stands for, made once
    a.rows = Object.freeze({
      start: { line: a.r0 + 1 },
      end: { line: a.r1 + 1 },
    });
    a.columns = Object.freeze({
      start: { line: a.c0 + 1 },
      end: { line: a.c1 + 1 },
    });
  }
  return { names, rows: grid.length, cols };
}

const clampLine = (line) => Math.max(-MAX_TRACKS, Math.min(MAX_TRACKS, line));

/** One side of a placement: a line number, `span <n>`, or `auto`. */
function gridLine(text, prop, value) {
  const t = text.trim();
  if (t === '') throw invalid(prop, value, 'one side of the "/" is empty');
  if (t === 'auto') return AUTO_LINE;
  const words = t.split(/\s+/);
  if (words.length === 1) {
    if (/^[+-]?\d+$/.test(t)) {
      const line = Number(t);
      if (line === 0) {
        throw invalid(
          prop,
          value,
          'there is no line 0 — lines count from 1 at the start, and from -1 at the end',
        );
      }
      return { line: clampLine(line) };
    }
    if (t === 'span') {
      throw invalid(prop, value, '"span" needs a number of tracks — span 2');
    }
    throw invalid(
      prop,
      value,
      `"${t}" would name a line, and named lines are not supported — name ` +
        "an area in the grid's gridTemplateAreas and place this with gridArea",
    );
  }
  if (words.length === 2 && (words[0] === 'span' || words[1] === 'span')) {
    const count = words[0] === 'span' ? words[1] : words[0];
    if (!/^\d+$/.test(count) || Number(count) < 1) {
      throw invalid(
        prop,
        value,
        'span takes a whole number of tracks, 1 or more — span 2',
      );
    }
    return { span: Math.min(Number(count), MAX_TRACKS) };
  }
  throw invalid(
    prop,
    value,
    `"${t}" is not a grid line — a line number, "span 2" or "auto"`,
  );
}

/**
 * `gridColumn` / `gridRow`: CSS's shorthand, `start / end`. A number is a
 * line, as it is in CSS (and in React DOM, which never gives it `px`):
 * counting from 1 at the start and from -1 at the end, so `'1 / -1'` is the
 * whole width however many columns there are.
 */
export function gridLines(value, prop = 'gridColumn') {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value === 0) {
      throw invalid(
        prop,
        value,
        'a number is a line: a whole number, counting from 1 at the start or from -1 at the end',
      );
    }
    return memo(`l#${value}`, () =>
      Object.freeze({ start: { line: clampLine(value) }, end: AUTO_LINE }),
    );
  }
  if (typeof value !== 'string') {
    throw invalid(prop, value, "expected a line like 2, 'span 2' or '1 / -1'");
  }
  return memo(`l|${value}`, () => {
    const sides = value.split('/');
    if (sides.length > 2) {
      throw invalid(
        prop,
        value,
        'it takes a start and an end — "1 / 3" — with one "/"',
      );
    }
    return Object.freeze({
      start: gridLine(sides[0], prop, value),
      end: sides.length === 2 ? gridLine(sides[1], prop, value) : AUTO_LINE,
    });
  });
}

const IDENT = /^-?[A-Za-z_-￿][\w\--￿]*$/;

/**
 * `gridArea`: the name of an area in the grid's `gridTemplateAreas`, or
 * CSS's four lines, `row-start / column-start / row-end / column-end`.
 * `gridColumn` and `gridRow` written beside it win for their axis, the way a
 * longhand wins over the shorthand it refines.
 */
export function gridArea(value, prop = 'gridArea') {
  if (typeof value === 'number') {
    return memo(`g#${value}`, () =>
      Object.freeze({ rows: gridLines(value, prop), columns: null }),
    );
  }
  if (typeof value !== 'string') {
    throw invalid(
      prop,
      value,
      "expected an area's name, or lines — 'row-start / column-start / row-end / column-end'",
    );
  }
  return memo(`g|${value}`, () => {
    const t = value.trim();
    if (IDENT.test(t) && t !== 'auto' && t !== 'span') {
      return Object.freeze({ name: t });
    }
    const sides = t.split('/');
    if (sides.length > 4) {
      throw invalid(
        prop,
        value,
        'it takes at most four lines — row-start / column-start / row-end / column-end',
      );
    }
    const side = (k) =>
      k < sides.length ? gridLine(sides[k], prop, value) : AUTO_LINE;
    return Object.freeze({
      rows: { start: side(0), end: side(2) },
      columns: { start: side(1), end: side(3) },
    });
  });
}

function oneOf(prop, value, allowed) {
  if (!allowed.includes(value)) {
    throw new Error(
      `react-x11: invalid ${prop} ${JSON.stringify(value)} (expected one of ${allowed.join(', ')})`,
    );
  }
}

/**
 * Throw, naming the property and what is wrong, for a grid value that would
 * not lay out — styles.js's validation, which runs in development wherever a
 * style is written. The same parsers the layout runs, so the two cannot
 * disagree about what is valid.
 */
export function validateGridValue(prop, value) {
  if (value == null) return;
  switch (prop) {
    case 'gridTemplateColumns':
    case 'gridTemplateRows':
      templateTracks(value, 1, prop);
      break;
    case 'gridAutoColumns':
    case 'gridAutoRows':
      autoTracks(value, 1, prop);
      break;
    case 'gridTemplateAreas':
      templateAreas(value, prop);
      break;
    case 'gridColumn':
    case 'gridRow':
      gridLines(value, prop);
      break;
    case 'gridArea':
      gridArea(value, prop);
      break;
    case 'gridAutoFlow':
      oneOf(prop, value, Object.keys(FLOWS));
      break;
    case 'justifyItems':
      oneOf(prop, value, ITEM_ALIGNMENTS);
      break;
    case 'justifySelf':
      oneOf(prop, value, SELF_ALIGNMENTS);
      break;
    default:
      break;
  }
}

// --- placement (§8) -------------------------------------------------------------

/** Where an item with no definite line in an axis starts, until placed. */
const AUTO_POS = -0x40000000;

const lineIndex = (line, explicit) =>
  line > 0 ? line - 1 : explicit + 1 + line;

/** A placement's two sides, as a start and a span (§8.3.1). Negative lines
 *  count back from the end of the explicit grid. */
function resolve(spec, explicit, starts, spans, i) {
  if (spec === null) {
    starts[i] = AUTO_POS;
    spans[i] = 1;
    return;
  }
  const a = spec.start.line;
  const b = spec.end.line;
  if (a !== undefined && b !== undefined) {
    let s = lineIndex(a, explicit);
    let e = lineIndex(b, explicit);
    if (s > e) {
      const t = s;
      s = e;
      e = t;
    }
    starts[i] = s;
    // the same line twice is one track from it
    spans[i] = Math.max(1, e - s);
    return;
  }
  if (a !== undefined) {
    starts[i] = lineIndex(a, explicit);
    spans[i] = spec.end.span ?? 1;
    return;
  }
  if (b !== undefined) {
    const span = spec.start.span ?? 1;
    starts[i] = lineIndex(b, explicit) - span;
    spans[i] = span;
    return;
  }
  // no line in this axis: placed automatically, with the span one side names
  // — the start's, when both do, as CSS drops the end's
  starts[i] = AUTO_POS;
  spans[i] = spec.start.span ?? spec.end.span ?? 1;
}

/**
 * CSS's grid item placement algorithm (§8.5), in the frame of the flow: the
 * _major_ axis is the one the flow runs along and grows (rows, for
 * `gridAutoFlow: 'row'`), the _minor_ one is fixed once the definite items
 * say how many tracks it has. A definite line before the first explicit one
 * adds tracks at the start, and the offset they make is returned.
 */
function placeItems(n, cS, cN, rS, rN, explicitCols, explicitRows, flow) {
  let cOff = 0;
  let rOff = 0;
  for (let i = 0; i < n; i++) {
    if (cS[i] !== AUTO_POS && -cS[i] > cOff) cOff = -cS[i];
    if (rS[i] !== AUTO_POS && -rS[i] > rOff) rOff = -rS[i];
  }
  if (cOff !== 0 || rOff !== 0) {
    for (let i = 0; i < n; i++) {
      if (cS[i] !== AUTO_POS) cS[i] += cOff;
      if (rS[i] !== AUTO_POS) rS[i] += rOff;
    }
  }
  const byColumn = flow.column;
  const mS = byColumn ? cS : rS;
  const mN = byColumn ? cN : rN;
  const kS = byColumn ? rS : cS;
  const kN = byColumn ? rN : cN;
  const occupied = [];
  const filled = [];
  const free = (m, k, ms, ks) => {
    for (let y = m; y < m + ms; y++) {
      const line = occupied[y];
      if (line === undefined) continue;
      for (let x = k; x < k + ks; x++) if (line[x] === 1) return false;
    }
    return true;
  };
  const take = (m, k, ms, ks) => {
    for (let y = m; y < m + ms; y++) {
      const line = (occupied[y] ??= []);
      for (let x = k; x < k + ks; x++) line[x] = 1;
      filled[y] = (filled[y] ?? 0) + ks;
    }
  };
  // 1. what is definite in both axes
  for (let i = 0; i < n; i++) {
    if (mS[i] !== AUTO_POS && kS[i] !== AUTO_POS) {
      take(mS[i], kS[i], mN[i], kN[i]);
    }
  }
  // 2. what is locked to a line of the flow: the first place along it that
  // is free (and, sparse, past what this step put there before)
  const behind = new Map();
  for (let i = 0; i < n; i++) {
    if (mS[i] === AUTO_POS || kS[i] !== AUTO_POS) continue;
    const m = mS[i];
    let k = flow.dense ? 0 : (behind.get(m) ?? 0);
    while (!free(m, k, mN[i], kN[i])) k++;
    kS[i] = k;
    take(m, k, mN[i], kN[i]);
    behind.set(m, k + kN[i]);
  }
  // 3. how many tracks the minor axis has: the explicit ones, every definite
  // item's reach, and the widest span still to place
  let minor = byColumn ? explicitRows + rOff : explicitCols + cOff;
  for (let i = 0; i < n; i++) {
    minor = Math.max(minor, (kS[i] === AUTO_POS ? 0 : kS[i]) + kN[i]);
  }
  // 4. everything else, in order, behind a cursor — reset to the start for
  // every item when dense, from the first line with a free cell in it
  let lowest = 0;
  const firstOpen = () => {
    while ((filled[lowest] ?? 0) >= minor) lowest++;
    return lowest;
  };
  let cm = 0;
  let ck = 0;
  for (let i = 0; i < n; i++) {
    if (mS[i] !== AUTO_POS) continue;
    const ms = mN[i];
    const ks = kN[i];
    if (kS[i] !== AUTO_POS) {
      const k = kS[i];
      if (flow.dense) cm = firstOpen();
      else if (k < ck) cm++;
      ck = k;
      while (!free(cm, k, ms, ks)) cm++;
      mS[i] = cm;
      take(cm, k, ms, ks);
    } else {
      if (flow.dense) {
        cm = firstOpen();
        ck = 0;
      }
      for (;;) {
        if (ck + ks > minor) {
          cm++;
          ck = 0;
        } else if (free(cm, ck, ms, ks)) {
          break;
        } else {
          ck++;
        }
      }
      mS[i] = cm;
      kS[i] = ck;
      take(cm, ck, ms, ks);
      ck += ks;
    }
  }
  let major = byColumn ? explicitCols + cOff : explicitRows + rOff;
  for (let i = 0; i < n; i++) major = Math.max(major, mS[i] + mN[i]);
  return byColumn
    ? { cols: major, rows: minor, cOff, rOff }
    : { cols: minor, rows: major, cOff, rOff };
}

const definite = (b, room) =>
  b.kind === 'fixed'
    ? b.px
    : b.kind === 'percent'
      ? room === null
        ? null
        : b.f * room
      : null;

const repeated = new WeakMap();

/**
 * The explicit tracks, with an auto repeat written out: as many repetitions
 * as fit in `room` without overflowing it (§7.2.3.2), each track counted at
 * its maximum if that is definite and its minimum otherwise — and one when
 * there is no room to count against.
 */
function repeatOut(list, room, gap) {
  const rep = list.repeat;
  if (rep === null) return { tracks: list.tracks, from: 0, to: 0, fit: false };
  const last = repeated.get(list);
  if (last !== undefined && last.room === room && last.gap === gap) {
    return last.out;
  }
  let times = 1;
  if (room !== null) {
    const size = (t) => definite(t.max, room) ?? definite(t.min, room) ?? 0;
    let others = 0;
    for (const t of list.tracks) others += size(t);
    let body = 0;
    for (const t of rep.tracks) body += size(t);
    const per = body + gap * rep.tracks.length;
    if (per > 0) {
      times = Math.floor(
        (room - others - gap * (list.tracks.length - 1) + EPS) / per,
      );
    }
    times = Math.max(1, Math.min(times, MAX_TRACKS));
  }
  const tracks = list.tracks.slice(0, rep.at);
  for (let k = 0; k < times; k++) for (const t of rep.tracks) tracks.push(t);
  for (let k = rep.at; k < list.tracks.length; k++) tracks.push(list.tracks[k]);
  const out = {
    tracks,
    from: rep.at,
    to: rep.at + times * rep.tracks.length,
    fit: rep.fit,
  };
  repeated.set(list, { room, gap, out });
  return out;
}

/**
 * An axis's tracks, explicit and implicit: the template's where it has one,
 * and the implicit sizes in turn around it — forwards after the explicit
 * grid, backwards before it. An auto-fit repeat nothing landed in collapses.
 */
function axisTracks(count, offset, explicit, auto, starts, spans, n) {
  const list = explicit.tracks;
  let used = null;
  if (explicit.fit) {
    used = new Uint8Array(count);
    for (let i = 0; i < n; i++) {
      for (let k = starts[i]; k < starts[i] + spans[i]; k++) used[k] = 1;
    }
  }
  const a = auto.length;
  const tracks = new Array(count);
  for (let k = 0; k < count; k++) {
    const e = k - offset;
    let t;
    if (e >= 0 && e < list.length) t = list[e];
    else if (e >= 0) t = auto[(e - list.length) % a];
    else t = auto[(a - (-e % a)) % a];
    if (used !== null && e >= explicit.from && e < explicit.to && !used[k]) {
      t = COLLAPSED;
    }
    tracks[k] = t;
  }
  return tracks;
}

// --- track sizing (§12) -----------------------------------------------------

// what a track's minimum and maximum sizing functions are, for the arrays
const FIXED = 0;
const AUTO_K = 1;
const MIN_K = 2;
const MAX_K = 3;
const FLEX = 4;
const FIT = 5;

const ALL = () => true;

const grow = (limit, v) => (limit === Infinity ? v : Math.max(limit, v));

/**
 * The track sizing algorithm, one axis (§12.3–12.8): base sizes and growth
 * limits from the tracks' own functions, raised by what the items in them
 * contribute — single-track items, then spanning ones in order of span, then
 * the ones that cross a flexible track — then the free space shared out, the
 * `fr` tracks expanded, and the `auto` ones stretched.
 *
 * `ask` is what the items say about this axis — `min(i)` and `max(i)`,
 * their min- and max-content contributions, and `declared(i)`, whether they
 * name a minimum of their own — each asked only if a track needs it, which
 * is what keeps a grid of fixed and `minmax(0, 1fr)` tracks from asking its
 * children anything. `constraint` is `null` for a definite `avail`, or
 * `'min'`/`'max'` for a grid sized to its min- or max-content.
 */
function sizeTracks(
  tracks,
  starts,
  spans,
  count,
  ask,
  clips,
  avail,
  gap,
  constraint,
  stretchAuto,
) {
  const n = tracks.length;
  const base = new Float64Array(n);
  const limit = new Float64Array(n);
  const minK = new Uint8Array(n);
  const maxK = new Uint8Array(n);
  const factor = new Float64Array(n);
  const fixedMax = new Float64Array(n);
  const fitCap = new Float64Array(n).fill(Infinity);
  const dead = new Uint8Array(n);
  let live = 0;
  for (let k = 0; k < n; k++) {
    const t = tracks[k];
    if (t.collapsed) {
      dead[k] = 1;
      continue;
    }
    live++;
    const lo = definite(t.min, avail);
    if (lo !== null) base[k] = lo;
    // a percentage with nothing to be a percentage of is `auto`
    else if (t.min.kind === 'min-content') minK[k] = MIN_K;
    else if (t.min.kind === 'max-content') minK[k] = MAX_K;
    else minK[k] = AUTO_K;
    if (t.fit !== null) {
      maxK[k] = FIT;
      limit[k] = Infinity;
      const cap = definite(t.fit, avail);
      if (cap !== null) fitCap[k] = cap;
    } else {
      const hi = definite(t.max, avail);
      if (hi !== null) {
        limit[k] = hi;
        fixedMax[k] = hi;
      } else if (t.max.kind === 'fr') {
        maxK[k] = FLEX;
        factor[k] = t.max.f;
        limit[k] = Infinity;
      } else {
        maxK[k] =
          t.max.kind === 'min-content'
            ? MIN_K
            : t.max.kind === 'max-content'
              ? MAX_K
              : AUTO_K;
        limit[k] = Infinity;
      }
    }
    if (limit[k] < base[k]) limit[k] = base[k];
  }
  const gaps = gap * Math.max(0, live - 1);
  const intrinsicMax = (k) => maxK[k] !== FIXED && maxK[k] !== FLEX;
  const maxContentMax = (k) =>
    maxK[k] === MAX_K || maxK[k] === AUTO_K || maxK[k] === FIT;

  // which items go where, and whether CSS's automatic minimum is theirs: a
  // floor of their content where they span an `auto`-minimum track and, if
  // they span more than one, no flexible one — and never for a box that
  // clips what it holds (§6.6)
  const autoMin = new Uint8Array(count);
  const singles = [];
  const spanning = [];
  const flexers = [];
  for (let i = 0; i < count; i++) {
    const s = starts[i];
    const e = s + spans[i];
    let flexed = false;
    let auto = false;
    for (let k = s; k < e; k++) {
      if (maxK[k] === FLEX) flexed = true;
      if (minK[k] === AUTO_K) auto = true;
    }
    if (auto && (spans[i] === 1 || !flexed) && !clips(i)) autoMin[i] = 1;
    if (flexed) flexers.push(i);
    else if (spans[i] === 1) singles.push(i);
    else spanning.push(i);
  }
  // CSS's minimum contribution: the content floor where the automatic
  // minimum applies or a minimum is written down (the floor measured for a
  // child that says `minWidth` is that minimum), and nothing otherwise
  const minimum = (i) => (autoMin[i] || ask.declared(i) ? ask.min(i) : 0);
  // what the spanned tracks' fixed maximums allow, when all of them have one
  const cap = (i) => {
    let sum = gap * (spans[i] - 1);
    for (let k = starts[i], e = k + spans[i]; k < e; k++) {
      if (maxK[k] === FIXED) sum += fixedMax[k];
      else if (maxK[k] === FIT && fitCap[k] !== Infinity) sum += fitCap[k];
      else return Infinity;
    }
    return sum;
  };
  const limitedMin = (i) => Math.max(Math.min(ask.min(i), cap(i)), minimum(i));
  const limitedMax = (i) => Math.max(Math.min(ask.max(i), cap(i)), minimum(i));
  // what an `auto` minimum takes: the min- or max-content contribution when
  // the grid is being sized to its own, the minimum contribution otherwise
  const low =
    constraint === 'min'
      ? limitedMin
      : constraint === 'max'
        ? limitedMax
        : minimum;

  // §12.5 step 2: the items in one track, where it is not flexible
  for (const i of singles) {
    const k = starts[i];
    if (minK[k] === MIN_K) base[k] = Math.max(base[k], ask.min(i));
    else if (minK[k] === MAX_K) base[k] = Math.max(base[k], ask.max(i));
    else if (minK[k] === AUTO_K) base[k] = Math.max(base[k], low(i));
    if (maxK[k] === MIN_K) limit[k] = grow(limit[k], ask.min(i));
    else if (maxK[k] === MAX_K || maxK[k] === AUTO_K) {
      limit[k] = grow(limit[k], ask.max(i));
    } else if (maxK[k] === FIT) {
      limit[k] = grow(limit[k], Math.min(ask.max(i), fitCap[k]));
    }
  }
  for (let k = 0; k < n; k++) if (limit[k] < base[k]) limit[k] = base[k];

  // §12.5.1: share out what a group of items still needs among the tracks
  // they span — up to each track's limit first, then past it — and take, for
  // each track, the most any one item asked of it
  const planned = new Float64Array(n);
  const incurred = new Float64Array(n);
  const touched = new Uint8Array(n);
  const growable = new Uint8Array(n);
  const fill = (ks, space, weighted, room) => {
    let open = ks;
    while (space > EPS && open.length > 0) {
      let total = 0;
      for (const k of open) total += weighted ? factor[k] : 1;
      if (!(total > 0)) {
        weighted = false;
        total = open.length;
      }
      let given = 0;
      const next = [];
      for (const k of open) {
        const share = (space * (weighted ? factor[k] : 1)) / total;
        const r = room(k);
        if (r > share + EPS) {
          incurred[k] += share;
          given += share;
          next.push(k);
        } else if (r > 0) {
          incurred[k] += r;
          given += r;
        }
      }
      space -= given;
      if (given <= EPS) break;
      open = next;
    }
    return space;
  };
  const distribute = (group, toBase, affected, contribution, beyond, flex) => {
    planned.fill(0);
    touched.fill(0);
    const current = (k) =>
      (toBase || limit[k] === Infinity ? base[k] : limit[k]) + incurred[k];
    const upTo = toBase
      ? (k) => Math.min(limit[k], fitCap[k]) - current(k)
      : (k) => (growable[k] || limit[k] === Infinity ? Infinity : 0);
    // a fit-content() track counts as max-content past its limit only as far
    // as its argument, and as fixed beyond it
    const past = (k) => (maxK[k] === FIT ? fitCap[k] - current(k) : Infinity);
    for (const i of group) {
      const s = starts[i];
      const e = s + spans[i];
      let size = gap * (e - s - 1);
      const ks = [];
      for (let k = s; k < e; k++) {
        size += toBase || limit[k] === Infinity ? base[k] : limit[k];
        if (!dead[k] && affected(k)) ks.push(k);
      }
      if (ks.length === 0) continue;
      for (const k of ks) {
        touched[k] = 1;
        incurred[k] = 0;
      }
      let space = contribution(i) - size;
      if (!(space > EPS)) continue;
      // flexible tracks share by their factors, when those add up to one
      let weighted = false;
      if (flex) {
        let sum = 0;
        for (const k of ks) sum += factor[k];
        weighted = sum >= 1;
      }
      space = fill(ks, space, weighted, upTo);
      if (space > EPS) {
        let into = ks.filter(beyond);
        if (into.length === 0) into = ks;
        space = fill(into, space, weighted, past);
        if (space > EPS) fill(into, space, weighted, () => Infinity);
      }
      for (const k of ks)
        if (incurred[k] > planned[k]) planned[k] = incurred[k];
    }
    for (let k = 0; k < n; k++) {
      if (touched[k] === 0) continue;
      if (toBase) base[k] += planned[k];
      else {
        const was = limit[k];
        limit[k] = (was === Infinity ? base[k] : was) + planned[k];
        if (was === Infinity) growable[k] = 1;
      }
    }
  };
  const increase = (group, flex) => {
    const only = flex
      ? (pred) => (k) => maxK[k] === FLEX && pred(k)
      : (pred) => pred;
    distribute(
      group,
      true,
      only((k) => minK[k] !== FIXED),
      low,
      intrinsicMax,
      flex,
    );
    distribute(
      group,
      true,
      only((k) => minK[k] === MIN_K || minK[k] === MAX_K),
      ask.min,
      intrinsicMax,
      flex,
    );
    distribute(
      group,
      true,
      only(
        constraint === 'max'
          ? (k) => minK[k] === AUTO_K || minK[k] === MAX_K
          : (k) => minK[k] === MAX_K,
      ),
      constraint === 'max' ? limitedMax : ask.max,
      maxContentMax,
      flex,
    );
    for (let k = 0; k < n; k++) if (limit[k] < base[k]) limit[k] = base[k];
    // a flexible track's maximum is not intrinsic: nothing below reaches it
    if (flex) return;
    // a growth limit going from infinite to finite here is still free to
    // grow in the next step, and only then (§12.5 step 3)
    distribute(group, false, intrinsicMax, ask.min, ALL, false);
    distribute(group, false, maxContentMax, ask.max, ALL, false);
    growable.fill(0);
  };
  // §12.5 step 3: spanning items, the fewest tracks first
  if (spanning.length > 0) {
    spanning.sort((a, b) => spans[a] - spans[b]);
    for (let g = 0; g < spanning.length;) {
      let e = g + 1;
      while (e < spanning.length && spans[spanning[e]] === spans[spanning[g]]) {
        e++;
      }
      increase(spanning.slice(g, e), false);
      g = e;
    }
  }
  // §12.5 step 4: the ones crossing a flexible track, all together, into the
  // flexible tracks alone
  if (flexers.length > 0) increase(flexers, true);
  for (let k = 0; k < n; k++) if (limit[k] === Infinity) limit[k] = base[k];

  const sum = () => {
    let total = 0;
    for (let k = 0; k < n; k++) total += base[k];
    return total;
  };

  // §12.6: the free space, equally, up to each track's growth limit —
  // all of it, sized to its max-content, and none to its min-content
  if (constraint === 'max') {
    for (let k = 0; k < n; k++) base[k] = limit[k];
  } else if (constraint === null && avail !== null) {
    let free = avail - sum() - gaps;
    let open = [];
    for (let k = 0; k < n; k++) if (limit[k] > base[k] + EPS) open.push(k);
    while (free > EPS && open.length > 0) {
      const each = free / open.length;
      const next = [];
      for (const k of open) {
        const room = limit[k] - base[k];
        if (room > each + EPS) {
          base[k] += each;
          free -= each;
          next.push(k);
        } else {
          base[k] = limit[k];
          free -= room;
        }
      }
      open = next;
    }
  }

  // §12.7: the flexible tracks, at the size of an fr
  const flexed = [];
  for (let k = 0; k < n; k++) if (maxK[k] === FLEX) flexed.push(k);
  if (flexed.length > 0 && constraint !== 'min') {
    const frSize = (from, to, space) => {
      const inflexible = new Uint8Array(n);
      for (;;) {
        let leftover = space;
        let tracksIn = 0;
        let factors = 0;
        for (let k = from; k < to; k++) {
          if (dead[k]) continue;
          tracksIn++;
          if (maxK[k] === FLEX && !inflexible[k]) factors += factor[k];
          else leftover -= base[k];
        }
        leftover -= gap * Math.max(0, tracksIn - 1);
        const hypothetical = leftover / Math.max(factors, 1);
        let again = false;
        for (let k = from; k < to; k++) {
          if (
            maxK[k] === FLEX &&
            !inflexible[k] &&
            hypothetical * factor[k] < base[k]
          ) {
            inflexible[k] = 1;
            again = true;
          }
        }
        if (!again) return Math.max(0, hypothetical);
      }
    };
    let fr = 0;
    if (constraint === null && avail !== null) {
      if (avail - sum() - gaps > EPS) fr = frSize(0, n, avail);
    } else {
      // no room to share: an fr is as big as it has to be for every flexible
      // track to keep its base size, and every item crossing one its content
      for (const k of flexed) {
        fr = Math.max(fr, factor[k] > 1 ? base[k] / factor[k] : base[k]);
      }
      for (const i of flexers) {
        fr = Math.max(fr, frSize(starts[i], starts[i] + spans[i], ask.max(i)));
      }
    }
    for (const k of flexed) {
      if (fr * factor[k] > base[k]) base[k] = fr * factor[k];
    }
  }

  // §12.8: what is left goes to the `auto` tracks, unless the box distributes
  // its content some other way
  if (stretchAuto && constraint === null && avail !== null) {
    const free = avail - sum() - gaps;
    if (free > EPS) {
      let autos = 0;
      for (let k = 0; k < n; k++) if (maxK[k] === AUTO_K && !dead[k]) autos++;
      if (autos > 0) {
        for (let k = 0; k < n; k++) {
          if (maxK[k] === AUTO_K && !dead[k]) base[k] += free / autos;
        }
      }
    }
  }
  return base;
}

/** The tracks laid end to end, gaps between. */
function extent(sizes, tracks, gap) {
  let total = 0;
  let live = 0;
  for (let k = 0; k < sizes.length; k++) {
    total += sizes[k];
    if (!tracks[k].collapsed) live++;
  }
  return total + gap * Math.max(0, live - 1);
}

/**
 * Where each track starts and ends, distributed by `justifyContent` /
 * `alignContent` when there is room to, and **snapped to whole pixels at the
 * lines** rather than per item: two items sharing a line share its pixel,
 * so neighbours in `1fr 1fr 1fr` meet with no seam, and a child's tree is
 * never laid out at a fraction — the input yoga divides a rounding residue
 * by (issue #411).
 */
function trackLines(sizes, tracks, gap, room, distribution) {
  const n = sizes.length;
  let live = 0;
  let total = 0;
  for (let k = 0; k < n; k++) {
    total += sizes[k];
    if (!tracks[k].collapsed) live++;
  }
  total += gap * Math.max(0, live - 1);
  let at = 0;
  let extra = 0;
  if (room !== null && distribution != null) {
    const free = room - total;
    switch (distribution) {
      case 'center':
        at = free / 2;
        break;
      case 'flex-end':
        at = free;
        break;
      case 'space-between':
        if (free > 0 && live > 1) extra = free / (live - 1);
        break;
      case 'space-around':
        if (free > 0 && live > 0) {
          extra = free / live;
          at = extra / 2;
        } else at = free / 2;
        break;
      case 'space-evenly':
        if (free > 0) {
          extra = free / (live + 1);
          at = extra;
        } else at = free / 2;
        break;
      default:
        break;
    }
  }
  const x0 = new Int32Array(n);
  const x1 = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    x0[k] = Math.round(at);
    at += sizes[k];
    x1[k] = Math.round(at);
    if (!tracks[k].collapsed) at += gap + extra;
  }
  return { x0, x1 };
}

// --- the layout -----------------------------------------------------------------

const START = 0;
const CENTER = 1;
const END = 2;
const STRETCH = 3;
const MODES = {
  'flex-start': START,
  center: CENTER,
  'flex-end': END,
  stretch: STRETCH,
};

/** An alignment keyword as a mode: `auto` (or nothing) is the fallback, and a
 *  value grid has no use for — `baseline`, the `space-*` ones — the start. */
const modeOf = (value, fallback) =>
  value == null || value === 'auto' ? fallback : (MODES[value] ?? START);

const lengthOf = (v) => (typeof v === 'number' && v > 0 ? v : 0);

/** Up to a whole pixel, with a thousandth of slack for a sum that should have
 *  been whole. */
const wholePixels = (v) => Math.ceil(v - 1e-3);

const offsetBy = (mode, free) =>
  mode === CENTER ? Math.round(free / 2) : mode === END ? free : 0;

const noop = () => {};

/**
 * The layout the seam runs (`registerLayout('grid', …)` in layouts.js). One
 * call answers how big the grid's content is for the room on offer, and —
 * with both modes `'exactly'` — where each child goes: the rect of its grid
 * area, or of its own size inside the area where it is not stretched.
 */
export function gridLayout(children, c, _options, info) {
  const style = info.style;
  const scale = info.scale ?? 1;
  const report = info.report ?? noop;
  const colGap = lengthOf(style.columnGap ?? style.gap);
  const rowGap = lengthOf(style.rowGap ?? style.gap);
  const areas = templateAreas(style.gridTemplateAreas);
  const flow = FLOWS[style.gridAutoFlow] ?? FLOWS.row;
  const colRoom = c.widthMode === 'exactly' ? c.width : null;
  const rowRoom = c.heightMode === 'exactly' ? c.height : null;
  const colList = repeatOut(
    templateTracks(style.gridTemplateColumns, scale, 'gridTemplateColumns'),
    colRoom,
    colGap,
  );
  const rowList = repeatOut(
    templateTracks(style.gridTemplateRows, scale, 'gridTemplateRows'),
    rowRoom,
    rowGap,
  );
  const explicitCols = Math.max(
    colList.tracks.length,
    areas === null ? 0 : areas.cols,
  );
  const explicitRows = Math.max(
    rowList.tracks.length,
    areas === null ? 0 : areas.rows,
  );

  // where each child asked to go
  const n = children.length;
  const cS = new Int32Array(n);
  const cN = new Int32Array(n);
  const rS = new Int32Array(n);
  const rN = new Int32Array(n);
  const justify = new Uint8Array(n);
  const align = new Uint8Array(n);
  const itemsJustify = modeOf(style.justifyItems, STRETCH);
  const itemsAlign = modeOf(style.alignItems, STRETCH);
  for (let i = 0; i < n; i++) {
    const s = children[i].style;
    let columns = null;
    let rows = null;
    if (s.gridArea != null) {
      const a = gridArea(s.gridArea);
      if (a.name === undefined) {
        rows = a.rows;
        columns = a.columns;
      } else {
        const box = areas === null ? undefined : areas.names.get(a.name);
        if (box !== undefined) {
          rows = box.rows;
          columns = box.columns;
        } else {
          report(
            `react-x11: gridArea ${JSON.stringify(a.name)} names no area of ` +
              (areas === null
                ? 'this grid, which has no gridTemplateAreas'
                : `this grid's gridTemplateAreas (${[...areas.names.keys()]
                    .map((name) => JSON.stringify(name))
                    .join(', ')})`),
            'The child is placed automatically',
          );
        }
      }
    }
    if (s.gridColumn != null) columns = gridLines(s.gridColumn, 'gridColumn');
    if (s.gridRow != null) rows = gridLines(s.gridRow, 'gridRow');
    resolve(columns, explicitCols, cS, cN, i);
    resolve(rows, explicitRows, rS, rN, i);
    justify[i] = modeOf(s.justifySelf, itemsJustify);
    align[i] = modeOf(s.alignSelf, itemsAlign);
    if (s.layoutItem != null) {
      report(
        'react-x11: a grid does not read layoutItem — its children are ' +
          'placed by gridColumn, gridRow and gridArea in their own style',
        'It is ignored',
      );
    }
  }
  const placed = placeItems(
    n,
    cS,
    cN,
    rS,
    rN,
    explicitCols,
    explicitRows,
    flow,
  );
  const colTracks = axisTracks(
    placed.cols,
    placed.cOff,
    colList,
    autoTracks(style.gridAutoColumns, scale, 'gridAutoColumns'),
    cS,
    cN,
    n,
  );
  const rowTracks = axisTracks(
    placed.rows,
    placed.rOff,
    rowList,
    autoTracks(style.gridAutoRows, scale, 'gridAutoRows'),
    rS,
    rN,
    n,
  );
  const clips = (i) => {
    const o = children[i].style.overflow;
    return o === 'hidden' || o === 'scroll';
  };

  // the columns, from what each child says about its width
  const minW = new Float64Array(n).fill(Number.NaN);
  const maxW = new Float64Array(n).fill(Number.NaN);
  const widths = {
    min: (i) => {
      if (Number.isNaN(minW[i])) {
        minW[i] = children[i].intrinsicSizes().minContentWidth;
      }
      return minW[i];
    },
    max: (i) => {
      if (Number.isNaN(maxW[i])) {
        maxW[i] = children[i].intrinsicSizes().maxContentWidth;
      }
      return maxW[i];
    },
    declared: (i) => {
      const s = children[i].style;
      return s.minWidth != null || typeof s.width === 'number';
    },
  };
  const columnSizes = (avail, constraint) =>
    sizeTracks(
      colTracks,
      cS,
      cN,
      n,
      widths,
      clips,
      avail,
      colGap,
      constraint,
      constraint === null && style.justifyContent == null,
    );
  let colSizes;
  let width;
  if (c.widthMode === 'exactly') {
    colSizes = columnSizes(c.width, null);
    width = c.width;
  } else if (c.widthMode === 'at-most' && c.width > 0) {
    // shrink to fit: the width its columns would like, if there is room for
    // it, the narrowest they can be if there is not room even for that, and
    // otherwise the room
    colSizes = columnSizes(null, 'max');
    width = extent(colSizes, colTracks, colGap);
    if (width > c.width + EPS) {
      const narrowest = columnSizes(null, 'min');
      const least = extent(narrowest, colTracks, colGap);
      if (least >= c.width - EPS) {
        colSizes = narrowest;
        width = least;
      } else {
        colSizes = columnSizes(c.width, null);
        width = c.width;
      }
    }
  } else {
    colSizes = columnSizes(
      null,
      c.widthMode === 'unconstrained' ? 'max' : 'min',
    );
    width = extent(colSizes, colTracks, colGap);
  }
  const cols = trackLines(
    colSizes,
    colTracks,
    colGap,
    colRoom,
    style.justifyContent,
  );

  // the rows, from each child's height at the width its columns came to —
  // asked at the snapped width the child is then laid out at, so the answer
  // the seam remembers is the one the placement reads
  const measured = new Array(n);
  const measureItem = (i) => {
    let m = measured[i];
    if (m === undefined) {
      const w = cols.x1[cS[i] + cN[i] - 1] - cols.x0[cS[i]];
      m = measured[i] =
        justify[i] === STRETCH
          ? children[i].measure({ width: w })
          : children[i].measure({ width: w, widthMode: 'at-most' });
    }
    return m;
  };
  const heights = {
    min: (i) => measureItem(i).height,
    max: (i) => measureItem(i).height,
    declared: (i) => {
      const s = children[i].style;
      return s.minHeight != null || typeof s.height === 'number';
    },
  };
  let rowSizes = null;
  let height;
  if (c.heightMode === 'exactly' && c.widthMode !== 'exactly') {
    // nothing asks where the rows are, and the height is given
    height = c.height;
  } else {
    const content = style.alignContent;
    rowSizes = sizeTracks(
      rowTracks,
      rS,
      rN,
      n,
      heights,
      clips,
      rowRoom,
      rowGap,
      rowRoom === null ? 'max' : null,
      content == null ||
        content === 'stretch' ||
        content === 'auto' ||
        content === 'baseline',
    );
    height = rowRoom ?? extent(rowSizes, rowTracks, rowGap);
  }
  if (c.widthMode !== 'exactly' || c.heightMode !== 'exactly') {
    return { width, height };
  }

  const rows = trackLines(
    rowSizes,
    rowTracks,
    rowGap,
    rowRoom,
    style.alignContent,
  );
  const rects = new Array(n);
  for (let i = 0; i < n; i++) {
    const x0 = cols.x0[cS[i]];
    const areaW = cols.x1[cS[i] + cN[i] - 1] - x0;
    const y0 = rows.x0[rS[i]];
    const areaH = rows.x1[rS[i] + rN[i] - 1] - y0;
    const rect = { x: x0, y: y0, width: areaW };
    if (justify[i] !== STRETCH) {
      // its own width — CSS's fit-content in the area — placed in it
      const w = wholePixels(measureItem(i).width);
      rect.width = w;
      rect.x += offsetBy(justify[i], areaW - w);
    }
    if (align[i] === STRETCH) {
      rect.height = areaH;
    } else {
      // its own height, at that width; the rect leaves it to the child
      rect.y += offsetBy(align[i], areaH - wholePixels(measureItem(i).height));
    }
    rects[i] = rect;
  }
  return { width, height, children: rects };
}
