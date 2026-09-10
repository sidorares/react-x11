// grid-layout.js — a CSS Grid subset on react-x11's layout seam: the
// prototype behind the grid feasibility study (custom-layout.md).
//
//   registerGrid(registerLayout);
//   <box style={{ layout: { name: 'grid', columns: '120px 1fr' }, gap: 8 }}>
//     <box style={{ layoutItem: { column: 'span 2' } }} />
//
// In: track lists with px, %, fr, auto, min-content, max-content, minmax(),
// fit-content() and repeat(n | auto-fill | auto-fit, …); placement by line,
// span and named area; row-major auto-placement, sparse or dense; implicit
// rows and columns; the track sizing algorithm of css-grid-2 §12 in both
// axes, columns first; stretch/start/center/end alignment of items.
// Out: subgrid, baselines, named lines, column-major flow, negative lines,
// the re-run of column sizing after rows (§12.1 step 3), and distribution of
// free space by justify-content/align-content.

export const stats = { runs: 0, measures: 0, intrinsic: 0, ms: 0, log: null };

// --- track lists ---------------------------------------------------------------

const parsedTracks = new Map();

/** `'120px repeat(auto-fill, minmax(10rem, 1fr)) auto'` → tracks + the one
 *  auto repeat, lengths in device px. */
export function parseTracks(text, scale) {
  const key = `${scale}|${text}`;
  let list = parsedTracks.get(key);
  if (!list) {
    list = parseTrackList(text, scale);
    parsedTracks.set(key, list);
  }
  return list;
}

function parseTrackList(text, scale) {
  const src = String(text ?? '').trim();
  let i = 0;
  const fail = (what) => {
    throw new SyntaxError(`grid: ${what} at ${i} in "${src}"`);
  };
  const ws = () => {
    while (/\s/.test(src[i] ?? '')) i++;
  };
  const eat = (ch) => {
    ws();
    if (src[i] !== ch) fail(`expected "${ch}"`);
    i++;
  };
  const word = () => {
    ws();
    const m = /^[a-z][a-z-]*/.exec(src.slice(i));
    if (m) i += m[0].length;
    return m?.[0] ?? null;
  };
  const breadth = () => {
    ws();
    const m = /^(\d+(?:\.\d+)?|\.\d+)(px|fr|%)?/.exec(src.slice(i));
    if (m) {
      i += m[0].length;
      const v = Number(m[1]);
      if (m[2] === 'fr') return { kind: 'fr', f: v };
      if (m[2] === '%') return { kind: 'percent', f: v / 100 };
      return { kind: 'fixed', px: v * scale };
    }
    const w = word();
    if (w === 'auto' || w === 'min-content' || w === 'max-content') {
      return { kind: w };
    }
    return fail('expected a track size');
  };
  const track = () => {
    const at = i;
    const w = word();
    if (w === 'minmax') {
      eat('(');
      const min = breadth();
      eat(',');
      const max = breadth();
      eat(')');
      if (min.kind === 'fr') fail('an fr minimum');
      return { min, max, fit: null };
    }
    if (w === 'fit-content') {
      eat('(');
      const limit = breadth();
      eat(')');
      return {
        min: { kind: 'auto' },
        max: { kind: 'max-content' },
        fit: limit,
      };
    }
    i = at;
    const b = breadth();
    return { min: b.kind === 'fr' ? { kind: 'auto' } : b, max: b, fit: null };
  };
  const list = (inner) => {
    const tracks = [];
    let repeat = null;
    for (;;) {
      ws();
      if (i >= src.length || (inner && src[i] === ')'))
        return { tracks, repeat };
      const at = i;
      if (word() === 'repeat') {
        eat('(');
        ws();
        const n = /^\d+/.exec(src.slice(i));
        let count;
        if (n) {
          i += n[0].length;
          count = Number(n[0]);
        } else {
          count = word();
          if (count !== 'auto-fill' && count !== 'auto-fit') {
            fail('expected a repeat count');
          }
        }
        eat(',');
        const body = list(true).tracks;
        eat(')');
        if (typeof count === 'number') {
          for (let k = 0; k < count; k++) tracks.push(...body);
        } else if (repeat) {
          fail('a second auto repeat');
        } else {
          repeat = {
            fit: count === 'auto-fit',
            tracks: body,
            at: tracks.length,
          };
        }
        continue;
      }
      i = at;
      tracks.push(track());
    }
  };
  return list(false);
}

const definite = (size, avail) =>
  size.kind === 'fixed'
    ? size.px
    : size.kind === 'percent' && avail != null
      ? size.f * avail
      : null;

/** The list with its auto repeat written out: as many repetitions as fit in
 *  `room` (one when there is no room to go by), §7.2.3.2. */
function expand(list, room, gap) {
  if (!list.repeat) return { tracks: list.tracks, repeated: null };
  const { tracks: body, at, fit } = list.repeat;
  let count = 1;
  if (room != null) {
    const size = (t) => definite(t.max, room) ?? definite(t.min, room);
    const one = body.map(size);
    if (one.every((s) => s != null)) {
      const others = list.tracks.map(size);
      const sumO = others.reduce((a, s) => a + (s ?? 0), 0);
      const sumB = one.reduce((a, s) => a + s, 0);
      const nO = others.length;
      count = Math.max(
        1,
        Math.floor((room - sumO - gap * (nO - 1)) / (sumB + gap * body.length)),
      );
    }
  }
  const tracks = list.tracks.slice(0, at);
  for (let k = 0; k < count; k++) tracks.push(...body);
  tracks.push(...list.tracks.slice(at));
  return {
    tracks,
    repeated: { from: at, to: at + count * body.length, fit },
  };
}

// --- areas and placement ----------------------------------------------------------

const parsedAreas = new WeakMap();

function areasOf(areas) {
  if (!areas) return null;
  let out = parsedAreas.get(areas);
  if (out) return out;
  out = { map: new Map(), rows: areas.length, cols: 0 };
  areas.forEach((row, r) => {
    const cells = row.trim().split(/\s+/);
    out.cols = Math.max(out.cols, cells.length);
    cells.forEach((name, c) => {
      if (name === '.') return;
      const a = out.map.get(name);
      if (!a) out.map.set(name, { r0: r, r1: r + 1, c0: c, c1: c + 1 });
      else {
        a.r0 = Math.min(a.r0, r);
        a.r1 = Math.max(a.r1, r + 1);
        a.c0 = Math.min(a.c0, c);
        a.c1 = Math.max(a.c1, c + 1);
      }
    });
  });
  parsedAreas.set(areas, out);
  return out;
}

/** `2`, `'2 / 4'`, `'span 2'`, `'2 / span 3'` → a 0-based start (or null
 *  for auto) and a span. */
function placement(value) {
  if (value == null || value === 'auto') return { start: null, span: 1 };
  if (typeof value === 'number') return { start: value - 1, span: 1 };
  const [a, b] = String(value)
    .split('/')
    .map((s) => s.trim());
  const side = (s) => {
    if (s == null || s === 'auto') return {};
    const m = /^span\s+(\d+)$/.exec(s);
    if (m) return { span: Number(m[1]) };
    const n = Number(s);
    if (Number.isInteger(n) && n > 0) return { line: n - 1 };
    throw new SyntaxError(`grid: "${value}" is not a placement`);
  };
  const p = side(a);
  const q = side(b);
  if (p.line != null) {
    return {
      start: p.line,
      span: q.line != null ? Math.max(1, q.line - p.line) : (q.span ?? 1),
    };
  }
  if (q.line != null) {
    const span = p.span ?? 1;
    return { start: Math.max(0, q.line - span), span };
  }
  return { start: null, span: p.span ?? 1 };
}

/** §8.5, row flow: definite items, then row-locked ones, then the rest in
 *  order behind a cursor. Columns never grow past `cols`. */
function autoPlace(items, cols, dense) {
  const occupied = [];
  const fits = (r, c, rs, cs) => {
    if (c + cs > cols) return false;
    for (let y = r; y < r + rs; y++) {
      const row = occupied[y];
      if (!row) continue;
      for (let x = c; x < c + cs; x++) if (row[x]) return false;
    }
    return true;
  };
  const mark = (cell) => {
    for (let y = cell.r; y < cell.r + cell.rs; y++) {
      const row = (occupied[y] ??= new Uint8Array(cols));
      for (let x = cell.c; x < cell.c + cell.cs; x++) row[x] = 1;
    }
  };
  const cells = new Array(items.length);
  items.forEach((it, i) => {
    if (it.row.start == null || it.col.start == null) return;
    cells[i] = {
      r: it.row.start,
      c: it.col.start,
      rs: it.row.span,
      cs: it.col.span,
    };
    mark(cells[i]);
  });
  const rowCursor = new Map();
  items.forEach((it, i) => {
    if (cells[i] || it.row.start == null) return;
    const r = it.row.start;
    const cs = Math.min(it.col.span, cols);
    let c = dense ? 0 : (rowCursor.get(r) ?? 0);
    while (c + cs <= cols && !fits(r, c, it.row.span, cs)) c++;
    if (c + cs > cols) c = 0; // the spec would add columns
    cells[i] = { r, c, rs: it.row.span, cs };
    mark(cells[i]);
    rowCursor.set(r, c + cs);
  });
  let cr = 0;
  let cc = 0;
  items.forEach((it, i) => {
    if (cells[i]) return;
    const rs = it.row.span;
    const cs = Math.min(it.col.span, cols);
    if (it.col.start != null) {
      const c = it.col.start;
      if (dense) cr = 0;
      else if (c < cc) cr++;
      while (!fits(cr, c, rs, cs)) cr++;
      cells[i] = { r: cr, c, rs, cs };
      cc = c;
    } else {
      if (dense) {
        cr = 0;
        cc = 0;
      }
      for (;;) {
        if (cc + cs > cols) {
          cr++;
          cc = 0;
        } else if (fits(cr, cc, rs, cs)) break;
        else cc++;
      }
      cells[i] = { r: cr, c: cc, rs, cs };
      cc += cs;
    }
    mark(cells[i]);
  });
  let rows = 0;
  for (const cell of cells) rows = Math.max(rows, cell.r + cell.rs);
  return { cells, rows };
}

// --- the track sizing algorithm, §12.3–12.8 ------------------------------------

const isFlex = (t) => t.max.kind === 'fr';
const intrinsicMin = (t, avail) =>
  t.min.kind === 'auto' ||
  t.min.kind === 'min-content' ||
  t.min.kind === 'max-content' ||
  (t.min.kind === 'percent' && avail == null);
const intrinsicMax = (t, avail) =>
  !isFlex(t) &&
  (t.fit != null ||
    t.max.kind === 'auto' ||
    t.max.kind === 'min-content' ||
    t.max.kind === 'max-content' ||
    (t.max.kind === 'percent' && avail == null));

/**
 * One axis. `spans` are the items as { start, span, min(), max() } — their
 * min-content and max-content contributions in this axis, asked for lazily.
 * `avail` is the definite room or null; `constraint` is 'min', 'max' or
 * null for a definite size. Answers the used size of each track.
 */
function sizeTracks(tracks, spans, avail, gap, constraint, stretch) {
  const n = tracks.length;
  const base = new Float64Array(n);
  const limit = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const t = tracks[k];
    base[k] = definite(t.min, avail) ?? 0;
    const max = t.fit == null ? definite(t.max, avail) : null;
    limit[k] = Math.max(max ?? Infinity, base[k]);
  }
  const fitCap = (t) =>
    t.fit == null ? Infinity : (definite(t.fit, avail) ?? Infinity);

  // §12.5 step 2: items in one track, not a flexible one
  const flexItems = [];
  const bySpan = new Map();
  for (const item of spans) {
    let crossesFlex = false;
    for (let k = item.start; k < item.start + item.span; k++) {
      if (isFlex(tracks[k])) crossesFlex = true;
    }
    if (crossesFlex) {
      flexItems.push(item);
      continue;
    }
    if (item.span > 1) {
      if (!bySpan.has(item.span)) bySpan.set(item.span, []);
      bySpan.get(item.span).push(item);
      continue;
    }
    const k = item.start;
    const t = tracks[k];
    if (intrinsicMin(t, avail)) {
      const contribution =
        t.min.kind === 'max-content' ||
        (t.min.kind === 'auto' && constraint === 'max')
          ? item.max()
          : item.min();
      base[k] = Math.max(base[k], contribution);
    }
    if (intrinsicMax(t, avail)) {
      const contribution = Math.min(
        t.max.kind === 'min-content' ? item.min() : item.max(),
        fitCap(t),
      );
      limit[k] =
        limit[k] === Infinity ? contribution : Math.max(limit[k], contribution);
    }
    if (limit[k] < base[k]) limit[k] = base[k];
  }

  // §12.5 step 3: spanning items, fewest tracks first; §12.5.1 simplified to
  // an even split up to the growth limits, then past them
  const spanSizes = [...bySpan.keys()].sort((a, b) => a - b);
  for (const size of spanSizes) {
    const group = bySpan.get(size);
    const plannedBase = new Float64Array(n);
    const plannedLimit = new Float64Array(n);
    for (const item of group) {
      const ks = [];
      for (let k = item.start; k < item.start + item.span; k++) ks.push(k);
      const inner = gap * (item.span - 1);
      const minTracks = ks.filter((k) => intrinsicMin(tracks[k], avail));
      if (minTracks.length) {
        const want = item.min() - inner - ks.reduce((a, k) => a + base[k], 0);
        spread(want, minTracks, base, limit, plannedBase, (k) =>
          intrinsicMax(tracks[k], avail),
        );
      }
      const maxTracks = ks.filter((k) => intrinsicMax(tracks[k], avail));
      if (maxTracks.length) {
        const current = (k) => (limit[k] === Infinity ? base[k] : limit[k]);
        const want =
          item.max() - inner - ks.reduce((a, k) => a + current(k), 0);
        if (want > 0) {
          const each = want / maxTracks.length;
          for (const k of maxTracks) {
            plannedLimit[k] = Math.max(plannedLimit[k], current(k) + each);
          }
        }
      }
    }
    for (let k = 0; k < n; k++) {
      base[k] += plannedBase[k];
      if (plannedLimit[k] > 0) {
        limit[k] = Math.max(
          limit[k] === Infinity ? 0 : limit[k],
          Math.min(plannedLimit[k], fitCap(tracks[k])),
        );
      }
      if (limit[k] < base[k]) limit[k] = base[k];
    }
  }

  // §12.5 step 4: items crossing a flexible track grow the flexible tracks
  // they cross, by flex factor
  if (flexItems.length) {
    const planned = new Float64Array(n);
    for (const item of flexItems) {
      let used = gap * (item.span - 1);
      let factors = 0;
      const flex = [];
      for (let k = item.start; k < item.start + item.span; k++) {
        used += base[k];
        if (isFlex(tracks[k])) {
          flex.push(k);
          factors += tracks[k].max.f;
        }
      }
      const want = (constraint === 'max' ? item.max() : item.min()) - used;
      if (want <= 0) continue;
      for (const k of flex) {
        const share = factors > 0 ? tracks[k].max.f / factors : 1 / flex.length;
        planned[k] = Math.max(planned[k], want * share);
      }
    }
    for (let k = 0; k < n; k++) {
      base[k] += planned[k];
      if (limit[k] < base[k]) limit[k] = base[k];
    }
  }
  for (let k = 0; k < n; k++) if (limit[k] === Infinity) limit[k] = base[k];

  // §12.6 maximize: free space up to the growth limits
  const gaps = gapsOf(tracks, gap);
  if (constraint === 'max') {
    for (let k = 0; k < n; k++) base[k] = limit[k];
  } else if (avail != null && constraint !== 'min') {
    let free = avail - gaps - base.reduce((a, b) => a + b, 0);
    let open = [];
    for (let k = 0; k < n; k++) if (base[k] < limit[k]) open.push(k);
    while (free > 1e-6 && open.length) {
      const each = free / open.length;
      const next = [];
      for (const k of open) {
        const grow = Math.min(each, limit[k] - base[k]);
        base[k] += grow;
        free -= grow;
        if (base[k] < limit[k] - 1e-6) next.push(k);
      }
      open = next;
    }
  }

  // §12.7 flexible tracks
  const flexible = [];
  for (let k = 0; k < n; k++) if (isFlex(tracks[k])) flexible.push(k);
  if (flexible.length && constraint !== 'min') {
    let fr = 0;
    if (avail != null && constraint == null) {
      const frozen = new Set();
      for (;;) {
        let leftover = avail - gaps;
        let factors = 0;
        for (let k = 0; k < n; k++) {
          if (isFlex(tracks[k]) && !frozen.has(k)) factors += tracks[k].max.f;
          else leftover -= base[k];
        }
        const hyp = leftover / Math.max(1, factors);
        const small = flexible.filter(
          (k) => !frozen.has(k) && hyp * tracks[k].max.f < base[k],
        );
        if (!small.length) {
          fr = hyp;
          break;
        }
        for (const k of small) frozen.add(k);
      }
    } else {
      for (const k of flexible) {
        const f = tracks[k].max.f;
        fr = Math.max(fr, f > 1 ? base[k] / f : base[k]);
      }
      for (const item of flexItems) {
        let rest = item.max() - gap * (item.span - 1);
        let factors = 0;
        for (let k = item.start; k < item.start + item.span; k++) {
          if (isFlex(tracks[k])) factors += tracks[k].max.f;
          else rest -= base[k];
        }
        fr = Math.max(fr, rest / Math.max(1, factors));
      }
    }
    for (const k of flexible) base[k] = Math.max(base[k], fr * tracks[k].max.f);
  }

  // §12.8 stretch auto tracks into what is left
  if (stretch && avail != null && constraint == null) {
    const auto = [];
    for (let k = 0; k < n; k++) if (tracks[k].max.kind === 'auto') auto.push(k);
    const free = avail - gaps - base.reduce((a, b) => a + b, 0);
    if (free > 0 && auto.length) {
      for (const k of auto) base[k] += free / auto.length;
    }
  }
  return base;
}

/** Grow `tracks`' base sizes by `want` between them, evenly and up to their
 *  limits first, then past them into the ones `past` allows. Planned, not
 *  applied: the largest item's increase wins, as §12.5.1 has it. */
function spread(want, ks, base, limit, planned, past) {
  if (want <= 0) return;
  const grow = new Map(ks.map((k) => [k, 0]));
  let left = want;
  let open = ks.filter((k) => base[k] < limit[k]);
  while (left > 1e-6 && open.length) {
    const each = left / open.length;
    const next = [];
    for (const k of open) {
      const room = limit[k] - base[k] - grow.get(k);
      const g = Math.min(each, room);
      grow.set(k, grow.get(k) + g);
      left -= g;
      if (g < room - 1e-6) next.push(k);
    }
    open = next;
  }
  if (left > 1e-6) {
    const beyond = ks.filter(past);
    const into = beyond.length ? beyond : ks;
    for (const k of into) grow.set(k, grow.get(k) + left / into.length);
  }
  for (const [k, g] of grow) planned[k] = Math.max(planned[k], g);
}

// --- the layout ----------------------------------------------------------------------

const ALIGN = {
  start: 'start',
  'flex-start': 'start',
  center: 'center',
  end: 'end',
  'flex-end': 'end',
  stretch: 'stretch',
};

function grid(children, c, options, info) {
  const t = performance.now();
  try {
    return gridRun(children, c, options, info);
  } finally {
    stats.ms += performance.now() - t;
    stats.log?.push(
      `${c.widthMode} ${Math.round(c.width)} / ${c.heightMode} ${Math.round(c.height)}`,
    );
  }
}

function gridRun(children, c, options, { style, scale }) {
  stats.runs++;
  const colGap = style.columnGap ?? style.gap ?? 0;
  const rowGap = style.rowGap ?? style.gap ?? 0;
  const areas = areasOf(options.areas);

  // columns: how much room decides how many an auto repeat makes
  const room = c.widthMode === 'unconstrained' ? null : c.width;
  const colList = parseTracks(options.columns, scale);
  const { tracks: explicitCols, repeated } = expand(colList, room, colGap);
  const rowList = parseTracks(options.rows, scale);
  const explicitRows = expand(rowList, null, rowGap).tracks;
  const autoCol = parseTracks(options.autoColumns, scale).tracks;
  const autoRow = parseTracks(options.autoRows, scale).tracks;

  // placement
  const wanted = children.map((child) => {
    const o = child.options;
    const area = o.area != null ? areas?.map.get(o.area) : null;
    if (area) {
      return {
        row: { start: area.r0, span: area.r1 - area.r0 },
        col: { start: area.c0, span: area.c1 - area.c0 },
      };
    }
    return { row: placement(o.row), col: placement(o.column) };
  });
  let cols = Math.max(explicitCols.length, areas?.cols ?? 0, 1);
  for (const w of wanted) {
    cols = Math.max(cols, (w.col.start ?? 0) + w.col.span);
  }
  const dense = options.autoFlow === 'row dense';
  const { cells, rows: usedRows } = autoPlace(wanted, cols, dense);
  const rows = Math.max(usedRows, explicitRows.length, areas?.rows ?? 0);
  const trackAt = (explicit, auto, count) =>
    Array.from(
      { length: count },
      (_, k) => explicit[k] ?? auto[(k - explicit.length) % auto.length],
    );
  let colTracks = trackAt(explicitCols, autoCol, cols);
  const rowTracks = trackAt(explicitRows, autoRow, rows);

  // auto-fit: a repeated track nothing is in collapses to nothing
  if (repeated?.fit) {
    const used = new Uint8Array(cols);
    for (const cell of cells)
      for (let x = cell.c; x < cell.c + cell.cs; x++) used[x] = 1;
    colTracks = colTracks.map((t, k) =>
      k >= repeated.from && k < repeated.to && !used[k]
        ? {
            min: { kind: 'fixed', px: 0 },
            max: { kind: 'fixed', px: 0 },
            fit: null,
            collapsed: true,
          }
        : t,
    );
  }

  // column sizes: the min- and max-content contributions are widths
  const intrinsic = children.map(() => null);
  const widthsOf = (i) => {
    if (!intrinsic[i]) {
      stats.intrinsic++;
      intrinsic[i] = children[i].intrinsicSizes();
    }
    return intrinsic[i];
  };
  const colSpans = cells.map((cell, i) => ({
    start: cell.c,
    span: cell.cs,
    min: () => widthsOf(i).minContentWidth,
    max: () => widthsOf(i).maxContentWidth,
  }));
  const stretchCols = style.justifyContent == null;
  let widths;
  if (c.widthMode === 'exactly') {
    widths = sizeTracks(
      colTracks,
      colSpans,
      c.width,
      colGap,
      null,
      stretchCols,
    );
  } else if (c.widthMode === 'unconstrained') {
    widths = sizeTracks(colTracks, colSpans, null, colGap, 'max', false);
  } else if (c.width <= 0) {
    widths = sizeTracks(colTracks, colSpans, null, colGap, 'min', false);
  } else {
    // shrink to fit: max-content, unless that is wider than the room
    widths = sizeTracks(colTracks, colSpans, null, colGap, 'max', false);
    if (sum(widths) + gapsOf(colTracks, colGap) > c.width) {
      widths = sizeTracks(
        colTracks,
        colSpans,
        c.width,
        colGap,
        null,
        stretchCols,
      );
    }
  }
  const colAt = offsets(widths, colTracks, colGap);

  // row sizes: an item's height at the width its columns came to
  const heights = cells.map(() => null);
  const heightOf = (i) => {
    if (heights[i] == null) {
      const cell = cells[i];
      stats.measures++;
      heights[i] = children[i].measure({
        width: areaSize(colAt, widths, cell.c, cell.cs),
      }).height;
    }
    return heights[i];
  };
  const rowSpans = cells.map((cell, i) => ({
    start: cell.r,
    span: cell.rs,
    min: () => heightOf(i),
    max: () => heightOf(i),
  }));
  const rowAvail = c.heightMode === 'exactly' ? c.height : null;
  const tall = sizeTracks(
    rowTracks,
    rowSpans,
    rowAvail,
    rowGap,
    rowAvail == null ? 'max' : null,
    style.alignContent == null,
  );
  const rowAt = offsets(tall, rowTracks, rowGap);

  const width =
    c.widthMode === 'exactly'
      ? c.width
      : sum(widths) + gapsOf(colTracks, colGap);
  const height =
    c.heightMode === 'exactly'
      ? c.height
      : sum(tall) + gapsOf(rowTracks, rowGap);
  const justify = ALIGN[options.justifyItems] ?? 'stretch';
  const align = ALIGN[style.alignItems] ?? 'stretch';
  return {
    width,
    height,
    children: cells.map((cell, i) => {
      const x = colAt[cell.c];
      const y = rowAt[cell.r];
      const w = areaSize(colAt, widths, cell.c, cell.cs);
      const h = areaSize(rowAt, tall, cell.r, cell.rs);
      const rect = { x, y };
      if (justify === 'stretch') rect.width = w;
      else {
        const own = Math.min(w, widthsOf(i).maxContentWidth);
        rect.width = own;
        rect.x +=
          justify === 'center'
            ? (w - own) / 2
            : justify === 'end'
              ? w - own
              : 0;
      }
      if (align === 'stretch') rect.height = h;
      else {
        const own = children[i].measure({ width: rect.width }).height;
        rect.y +=
          align === 'center' ? (h - own) / 2 : align === 'end' ? h - own : 0;
      }
      return rect;
    }),
  };
}

const sum = (xs) => {
  let s = 0;
  for (const x of xs) s += x;
  return s;
};

/** Gaps between the tracks, not counting a collapsed track's. */
function gapsOf(tracks, gap) {
  const live = tracks.filter((t) => !t.collapsed).length;
  return gap * Math.max(0, live - 1);
}

/** Where each track line is: offsets[k] is where track k starts, and
 *  offsets[n] one gap past the last one's end. */
function offsets(sizes, tracks, gap) {
  const at = new Float64Array(sizes.length + 1);
  let x = 0;
  for (let k = 0; k < sizes.length; k++) {
    at[k] = x;
    x += sizes[k] + (tracks[k].collapsed ? 0 : gap);
  }
  at[sizes.length] = x;
  return at;
}

/** From the start of an area's first track to the end of its last. */
const areaSize = (at, sizes, start, span) =>
  at[start + span - 1] + sizes[start + span - 1] - at[start];

export function registerGrid(registerLayout) {
  registerLayout('grid', {
    options: {
      columns: { type: 'string', default: 'auto' },
      rows: { type: 'string', default: '' },
      autoColumns: { type: 'string', default: 'auto' },
      autoRows: { type: 'string', default: 'auto' },
      autoFlow: { type: ['row', 'row dense'], default: 'row' },
      areas: { type: 'any' },
      justifyItems: {
        type: ['stretch', 'start', 'center', 'end'],
        default: 'stretch',
      },
    },
    childOptions: {
      column: { type: 'any' },
      row: { type: 'any' },
      area: { type: 'string' },
    },
    layout: grid,
  });
}
