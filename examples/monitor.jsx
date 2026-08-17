// A process monitor — and the answer to "one keystroke changes hundreds of
// things; how do I keep the field responsive?"
//
//   npm run examples:monitor
//
// ## The question this exists for
//
// Type in the filter. There are around eight hundred processes on this
// machine, each row draws a live graph of its own, and every character
// invalidates all of it. Without help, the field would stutter: the
// keystroke and the rebuilt list are one update, and nothing reaches the
// screen until the slow half finishes.
//
// The **defer** switch in the header is that help, on and off, on the real
// work rather than on a benchmark. On, the letters land the moment you type
// them and the list catches up a beat later — `useDeferredValue` gives React
// two priorities for one piece of state, so the field re-renders at
// keystroke urgency and the list at whatever is left. Off, both are the same
// update and you feel it in your fingers.
//
// The counters under the switch are the evidence: with deferring on, thirty
// keystrokes and a handful of list rebuilds, because React threw away the
// renders nobody would have seen.
//
// ## The escape hatch, twice
//
// Two elements here are not react-x11's — they are registered from this file
// with `registerElement`, which is what `docs/extending.md` is about and
// what nothing else in `examples/` demonstrates.
//
//   <sparkline>    a `Node` with a **size of its own**: `measureContent`
//                  reports a width per sample, so a row is as wide as its
//                  history rather than as wide as a style says.
//   <cpuhistory>   a `Scrollable(Node)`: content that is **pixels, not
//                  children**. It reports how far its drawing reaches and
//                  paints itself offset, and gets the wheel, the bars, the
//                  drags and the scroll keys for it. Scroll it back through
//                  the samples.
//
// What is deliberately **not** here, so the list is honest: sampling on a
// worker thread, paint caching, and the AT-SPI scene an element can describe.
// Each is its own section of extending.md and none of them is the rung this
// app actually climbs.
//
// ## Reading it over ssh
//
// This is the app to run on a machine that is not the one you are sitting
// at — `ssh -X somewhere npm run examples:monitor`. See docs/remote.md.
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';

import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  Button,
  Dialog,
  Switch,
  createRoot,
  createStyles,
} from '../src/index.js';
import { registerElement } from '../src/host.js';
import { Node, Scrollable } from '../src/node.js';

// ---------------------------------------------------------------------------
// Two elements of our own
// ---------------------------------------------------------------------------

const SAMPLE_PX = 3; // one sample is this many pixels wide
const HISTORY = 60; // …and this many are kept
const CORES = Math.max(1, cpus().length);

/**
 * A row's CPU history. The interesting part is `measureContent`: this element
 * has a **size of its own**, derived from how many samples it holds, so the
 * JSX never says how wide it is.
 */
class SparklineNode extends Node {
  constructor(props, app) {
    super('sparkline', props, app);
  }

  measureContent({ width }) {
    // The **capacity**, not the current length. Measuring the samples it
    // happens to hold would be the obvious thing and is wrong: the series
    // grows by one every tick, so every row would re-measure and the whole
    // list would reflow once a second — in the app whose subject is not
    // doing that. A size of its own still, just a stable one.
    const want = (this.props.capacity ?? HISTORY) * SAMPLE_PX;
    // never wider than the offer — an unbounded axis arrives as Infinity, so
    // `min` is the right answer in every mode
    return { width: Math.min(want, width), height: 14 };
  }

  applyProps(next, prev) {
    const before = prev ?? this.props;
    super.applyProps(next, prev);
    // only the capacity moves the measurement; new samples repaint inside a
    // box that has not changed size
    if (next.capacity !== before.capacity) this.invalidateMeasure();
  }

  // `paintContent`, not `paint`: paint draws the background, then this, then
  // the border. Drawing after `super.paint()` would paint over the border.
  paintContent(ctx) {
    const data = this.props.data ?? [];
    if (data.length < 2) return;
    const { x, y, width, height } = this.contentBox();
    const top = this.props.max ?? Math.max(1, ...data);
    // plotted against the capacity, so a half-full series draws in the left
    // half rather than stretching to fill a box it has not earned
    const step = width / Math.max(1, (this.props.capacity ?? HISTORY) - 1);
    ctx.beginPath();
    data.forEach((value, i) => {
      const px = x + i * step;
      const py = y + height - (height * Math.min(value, top)) / top;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = this.props.color ?? '#7ee787';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/**
 * The whole machine's load, over time, as **pixels rather than children**.
 *
 * This is the case `<box overflow="scroll">` cannot serve: there is nothing
 * in the tree to lay out, so nothing can work out how far the content
 * reaches. Two answers buy the rest of the machinery — `measureScrollContent`
 * says how far the drawing goes, `paintContent` draws it offset by
 * `scrollX` — and the wheel, the scrollbars and their drags, the arrow and
 * Page keys and the tab stop all follow.
 */
class CpuHistoryNode extends Scrollable(Node) {
  constructor(props, app) {
    super('cpuhistory', props, app);
  }

  isScroller() {
    return true;
  }

  measureScrollContent() {
    const series = this.props.series ?? [];
    return { width: series.length * SAMPLE_PX, height: 0 };
  }

  paintContent(ctx) {
    const series = this.props.series ?? [];
    const box = this.contentBox();
    if (!series.length || box.width <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.width, box.height);
    ctx.clip();

    // `scrollX` is a distance from the edge the content starts at, already
    // clamped to the extent reported above — nothing here has to bound it.
    const originX = box.x - this.scrollX;
    const base = box.y + box.height;

    ctx.beginPath();
    ctx.moveTo(originX, base);
    series.forEach((value, i) => {
      const px = originX + i * SAMPLE_PX;
      ctx.lineTo(px, base - (box.height * Math.min(value, 100)) / 100);
    });
    ctx.lineTo(originX + (series.length - 1) * SAMPLE_PX, base);
    ctx.closePath();
    ctx.fillStyle = this.props.fill ?? '#1f6feb55';
    ctx.fill();

    ctx.beginPath();
    series.forEach((value, i) => {
      const px = originX + i * SAMPLE_PX;
      const py = base - (box.height * Math.min(value, 100)) / 100;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = this.props.color ?? '#58a6ff';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}

registerElement('sparkline', {
  create: (props, app) => new SparklineNode(props, app),
  // `data`, `color` and `max` are this element's own props rather than style
  // written flat — without this the DEV assertion that catches
  // `<box width={10}>` fires on them instead.
  semanticNames: ['data', 'color', 'max', 'capacity'],
});

registerElement('cpuhistory', {
  create: (props, app) => new CpuHistoryNode(props, app),
  semanticNames: ['series', 'color', 'fill'],
});

// ---------------------------------------------------------------------------
// Where the numbers come from
//
// A seam, for the same reason examples/chat.jsx has one: the tests drive a
// sampler that answers from a table, and nothing in the app knows which it
// has. It is also what makes this runnable on a machine whose `ps` says
// something else.
// ---------------------------------------------------------------------------

/** `ps` once, parsed. */
function readProcesses() {
  return new Promise((resolve, reject) => {
    const ps = spawn('ps', ['-eo', 'pid,pcpu,pmem,comm'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (chunk) => {
      out += chunk;
    });
    ps.on('error', reject);
    ps.on('close', () => {
      const rows = out
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const m = /^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/.exec(line);
          if (!m) return null;
          return {
            pid: Number(m[1]),
            cpu: Number(m[2]),
            mem: Number(m[3]),
            // the last path segment: `/usr/libexec/logd` reads as `logd`
            name: m[4].split('/').pop() || m[4],
            command: m[4],
          };
        })
        .filter(Boolean);
      resolve(rows);
    });
  });
}

/** The real one: `ps` on a timer, with a per-pid history ring. */
export function psSampler({ everyMs = 1500, history = HISTORY } = {}) {
  const listeners = new Set();
  const series = new Map(); // pid -> number[]
  const load = [];
  let timer = null;
  let stopped = false;

  const tick = async () => {
    let rows;
    try {
      rows = await readProcesses();
    } catch {
      return; // a machine without `ps`; the app shows what it has
    }
    if (stopped) return;
    const seen = new Set();
    for (const row of rows) {
      seen.add(row.pid);
      const past = series.get(row.pid) ?? [];
      past.push(row.cpu);
      if (past.length > history) past.shift();
      series.set(row.pid, past);
      row.history = past;
    }
    for (const pid of series.keys()) if (!seen.has(pid)) series.delete(pid);
    // `%CPU` is per core, so a busy machine sums to hundreds — dividing by
    // the core count is what turns it into the "how loaded is this box"
    // number a graph can plot. Summing and clamping, which is the obvious
    // thing, draws a solid block at 100 on anything with more than one core.
    const busy = rows.reduce((sum, r) => sum + r.cpu, 0) / CORES;
    load.push(Math.min(100, busy));
    if (load.length > history * 4) load.shift();
    listeners.forEach((fn) => fn({ rows, load: [...load] }));
  };

  return {
    start() {
      tick();
      timer = setInterval(tick, everyMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
    },
    onSample(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    kill(pid, signal = 'SIGTERM') {
      process.kill(pid, signal);
    },
  };
}

// ---------------------------------------------------------------------------

const s = createStyles({
  root: { flexGrow: 1, backgroundColor: '$background' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingStart: 12,
    paddingEnd: 12,
    paddingTop: 10,
    paddingBottom: 10,
    borderBottomWidth: '$borderWidth',
    borderColor: '$border',
  },
  filter: {
    width: 220,
    paddingStart: 10,
    paddingEnd: 10,
    paddingTop: '$paddingY',
    paddingBottom: '$paddingY',
    borderWidth: '$borderWidth',
    borderColor: '$border',
    borderRadius: '$radius',
    ':focus': { borderColor: '$accent' },
  },
  label: { fontSize: 11, color: '$textMuted' },
  count: { fontSize: 11, color: '$textMuted', width: 150 },

  graph: { height: 74, marginTop: 8, marginStart: 12, marginEnd: 12 },

  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingStart: 12,
    paddingEnd: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  list: { flexGrow: 1, overflow: 'scroll', paddingStart: 12, paddingEnd: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 2,
    paddingBottom: 2,
    borderRadius: '$radius',
    ':hover': { backgroundColor: '$surfaceHover' },
    ':active': { backgroundColor: '$surfaceActive' },
  },
  rowOn: {
    backgroundColor: '$accent',
    ':hover': { backgroundColor: '$accentHover' },
    ':active': { backgroundColor: '$accentActive' },
  },
  pid: { width: 58, fontSize: 11, color: '$textMuted', textAlign: 'end' },
  name: { flexGrow: 1, fontSize: 12, color: '$text' },
  num: { width: 52, fontSize: 11, color: '$text', textAlign: 'end' },
  onAccent: { color: '$accentText' },
  colHead: { fontSize: 10, color: '$textMuted' },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingStart: 12,
    paddingEnd: 12,
    paddingTop: 8,
    paddingBottom: 8,
    borderTopWidth: '$borderWidth',
    borderColor: '$border',
  },
});

const SORTS = {
  cpu: (a, b) => b.cpu - a.cpu,
  mem: (a, b) => b.mem - a.mem,
  pid: (a, b) => a.pid - b.pid,
  name: (a, b) => a.name.localeCompare(b.name),
};

function ProcessRow({ row, selected, onSelect }) {
  return (
    <box
      style={[s.row, selected && s.rowOn]}
      role="option"
      aria-label={`${row.name} ${row.pid}`}
      aria-selected={selected}
      focusable
      onClick={() => onSelect(row.pid)}
      onKeyDown={(ev) => {
        if (ev.codepoint === 32 || ev.keysym === 0xff0d) {
          ev.preventDefault();
          onSelect(row.pid);
        }
      }}
    >
      <text style={[s.pid, selected && s.onAccent]}>{String(row.pid)}</text>
      <text style={[s.name, selected && s.onAccent]}>{row.name}</text>
      <sparkline
        data={row.history ?? []}
        max={100}
        color={selected ? '#ffffff' : '#7ee787'}
      />
      <text style={[s.num, selected && s.onAccent]}>{row.cpu.toFixed(1)}</text>
      <text style={[s.num, selected && s.onAccent]}>{row.mem.toFixed(1)}</text>
    </box>
  );
}

export function MonitorPanel({ sampler }) {
  const [rows, setRows] = useState([]);
  const [load, setLoad] = useState([]);
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState('cpu');
  const [selected, setSelected] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [failed, setFailed] = useState(null);
  const [defer, setDefer] = useState(true);

  // The whole demonstration is this one line, and the switch that bypasses
  // it. `useDeferredValue` lets one piece of state be read at two urgencies:
  // the field renders from `filter` and the list from `shown`, which lags by
  // however long the list takes.
  const deferred = useDeferredValue(filter);
  const shown = defer ? deferred : filter;
  const stale = shown !== filter;

  const keystrokes = useRef(0);
  const rebuilds = useRef(0);

  useEffect(() => {
    const off = sampler.onSample(({ rows: next, load: nextLoad }) => {
      setRows(next);
      setLoad(nextLoad);
    });
    sampler.start();
    return () => {
      off();
      sampler.stop();
    };
  }, [sampler]);

  const visible = useMemo(() => {
    rebuilds.current += 1;
    const needle = shown.trim().toLowerCase();
    const matched = needle
      ? rows.filter(
          (r) =>
            r.name.toLowerCase().includes(needle) ||
            String(r.pid).includes(needle),
        )
      : rows;
    return [...matched].sort(SORTS[sortBy]);
  }, [rows, shown, sortBy]);

  const kill = useCallback(
    (pid) => {
      setConfirming(null);
      try {
        sampler.kill(pid);
        setFailed(null);
      } catch (err) {
        // The interesting half: most processes are not yours to signal.
        setFailed(
          `${pid}: ${err.code === 'EPERM' ? 'not yours to kill' : err.message}`,
        );
      }
    },
    [sampler],
  );

  return (
    <box style={s.root}>
      <box style={s.header}>
        <textinput
          value={filter}
          placeholder="filter — pid or name"
          aria-label="filter processes"
          onChange={(ev) => {
            keystrokes.current += 1;
            setFilter(ev.value);
          }}
          style={s.filter}
        />
        <Switch
          checked={defer}
          onChange={(ev) => setDefer(ev.value)}
          aria-label="defer the list"
        />
        <text style={s.label}>defer the list</text>
        <text style={s.count}>
          {`${visible.length} of ${rows.length}${stale ? ' — catching up' : ''}`}
        </text>
      </box>

      {/* pixels, not children: scroll it back through the samples */}
      <cpuhistory series={load} style={s.graph} aria-label="load over time" />

      <box style={s.headRow}>
        {[
          ['pid', 'PID'],
          ['name', 'process'],
          ['cpu', 'CPU%'],
          ['mem', 'MEM%'],
        ].map(([key, label]) => (
          <Button
            key={key}
            onPress={() => setSortBy(key)}
            style={{ paddingTop: 2, paddingBottom: 2 }}
          >
            <text style={s.colHead}>
              {sortBy === key ? `▾ ${label}` : label}
            </text>
          </Button>
        ))}
      </box>

      <box style={s.list} role="listbox" aria-label="processes">
        {visible.map((row) => (
          <ProcessRow
            key={row.pid}
            row={row}
            selected={row.pid === selected}
            onSelect={setSelected}
          />
        ))}
      </box>

      <box style={s.footer}>
        <Button
          disabled={selected == null}
          onPress={() => setConfirming(selected)}
        >
          Kill…
        </Button>
        <text style={s.label}>
          {failed ??
            `${keystrokes.current} keystrokes, ${rebuilds.current} list rebuilds`}
        </text>
      </box>

      <Dialog
        open={confirming != null}
        title="Kill this process?"
        width={340}
        height={170}
        onClose={() => setConfirming(null)}
        actions={
          <>
            <Button label="Cancel" onPress={() => setConfirming(null)} />
            <Button primary label="Kill" onPress={() => kill(confirming)} />
          </>
        }
      >
        <text style={{ fontSize: 12, color: '$text' }}>
          {`SIGTERM to ${confirming}. Most processes are not yours to signal, and the refusal is shown rather than swallowed.`}
        </text>
      </Dialog>
    </box>
  );
}

export function App({ sampler }) {
  const chosen = useMemo(() => sampler ?? psSampler(), [sampler]);
  return (
    <window
      width={760}
      height={560}
      title="react-x11 monitor"
      minWidth={560}
      minHeight={360}
      style={{ backgroundColor: '$background' }}
    >
      <MonitorPanel sampler={chosen} />
    </window>
  );
}

export default App;

if (!process.env.REACT_X11_NO_AUTORUN && !import.meta.hot) {
  const root = await createRoot();
  root.render(<App />);
}
