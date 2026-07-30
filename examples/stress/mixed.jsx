// The worst case: everything on screen at once, all of it live.
//
// The other panels isolate one thing so a frame log can be read against a
// known expectation. This one does the opposite — a document, a table, a
// chart, an animation and a form in one window, so that whatever costs more
// than it should has nowhere to hide.
//
// What to look for:
//   - the clock's second changing should repaint the clock, not the panel;
//     it is the smallest possible change in the busiest possible tree
//   - dragging the chart slider should not repaint the document or the table
//   - the animated bar and the clock running together should not compound:
//     two independent small changes in one frame make one union rect, and
//     it should still be far smaller than the window
//   - resizing the window is the one thing that *should* be a full repaint
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  createStyles,
  ProgressBar,
  Slider,
  Switch,
  Table,
  Tooltip,
} from '../../src/index.js';

const s = createStyles({
  panel: { flexGrow: 1, minHeight: 0, padding: 10, gap: 8 },
  head: { fontSize: 15, color: '#2d3436' },
  hint: { fontSize: 10, color: '#7f8c8d' },
  cols: { flexDirection: 'row', gap: 8, flexGrow: 1, minHeight: 0 },
  col: { flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0, gap: 8 },
  // The fixed column deliberately does *not* reuse `col`: flexBasis wins over
  // width on the main axis, so spreading `col`'s `flexBasis: 0` into a column
  // that also has `flexGrow: 0` collapses it to nothing.
  fixedCol: { width: 200, flexShrink: 0, minHeight: 0, gap: 8 },
  card: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#dfe6e9',
    borderRadius: 4,
    padding: 8,
    gap: 6,
    minHeight: 0,
  },
  title: { fontSize: 11, color: '#b2bec3' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  clock: { fontSize: 30, fontFamily: 'monospace', color: '#2d3436' },
});

const DOC = `### Release notes

Damage is now **bounded** for arbitrary React updates, not just for the
interaction paths. A node claims damage only when something it *draws*
changed, so a sibling whose style object was rebuilt with the same contents
costs nothing.

1. paint-relevant style compared by value
2. every non-style prop compared by identity
3. \`children\`, \`style\` and event handlers skipped

> A frame that no node claims repaints everything — safe by construction,
> which is also why a single-change test cannot prove a missed repaint.
`;

const ROWS = Array.from({ length: 400 }, (_, i) => ({
  id: i,
  step: `step-${String(i).padStart(3, '0')}`,
  state: ['ok', 'ok', 'ok', 'warn', 'fail'][i % 5],
  ms: ((i * 613) % 900) + 12,
}));

const COLUMNS = [
  { id: 'step', label: 'Step', width: 110 },
  {
    id: 'state',
    label: 'State',
    width: 64,
    render: (row) => (
      <text
        style={{
          fontSize: 10,
          color:
            row.state === 'fail'
              ? '#d63031'
              : row.state === 'warn'
                ? '#e17055'
                : '#00b894',
        }}
      >
        {row.state}
      </text>
    ),
  },
  { id: 'ms', label: 'ms', width: 54, align: 'right' },
];

/** A clock that only ever changes its own text — the smallest useful commit. */
function Clock({ running }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    <text style={s.clock}>
      {pad(now.getHours())}:{pad(now.getMinutes())}:{pad(now.getSeconds())}
    </text>
  );
}

export function MixedPanel() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0.35);
  const [amplitude, setAmplitude] = useState(30);
  const [threshold, setThreshold] = useState(500);
  const [name, setName] = useState('');
  const [presses, setPresses] = useState(0);
  const phase = useRef(0);

  // The animated bar and the clock tick on different periods on purpose, so
  // some frames carry one change and some carry two.
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      phase.current += 1;
      setProgress((p) => (p >= 1 ? 0 : p + 0.01));
    }, 80);
    return () => clearInterval(timer);
  }, [running]);

  const wave = useMemo(() => {
    const parts = [];
    for (let i = 0; i <= 64; i++) {
      const t = i / 64;
      const y = 40 - amplitude * Math.sin(t * Math.PI * 4);
      parts.push(
        `${i === 0 ? 'M' : 'L'}${(t * 240).toFixed(1)} ${y.toFixed(1)}`,
      );
    }
    return parts.join(' ');
  }, [amplitude]);

  const slow = ROWS.filter((r) => r.ms > threshold);

  return (
    <box style={s.panel}>
      <box style={s.row}>
        <text style={s.head}>Mixed</text>
        <text style={s.hint}>animate</text>
        <Switch checked={running} onChange={setRunning} />
        <text style={s.hint}>
          a clock at 1s and a bar at 80ms — some frames carry one change, some
          two, and the union of two small rects should still be small
        </text>
      </box>

      <box style={s.cols}>
        <box style={s.col}>
          <box style={s.card}>
            <text style={s.title}>clock + progress</text>
            <Clock running={running} />
            <ProgressBar value={progress} />
            <text style={s.hint}>{(progress * 100).toFixed(0)}%</text>
          </box>

          <box style={s.card}>
            <text style={s.title}>&lt;markdown&gt;</text>
            <markdown style={{ flexShrink: 0 }}>{DOC}</markdown>
          </box>
        </box>

        <box style={s.col}>
          <box style={s.card}>
            <text style={s.title}>svg from a slider</text>
            <svg viewBox="0 0 240 80" style={{ width: 240, height: 80 }}>
              <rect x={0} y={0} width={240} height={80} fill="#fbfcfd" />
              <path d={wave} stroke="#0984e3" strokeWidth={2} fill="none" />
            </svg>
            <box style={s.row}>
              <text style={s.hint}>amp</text>
              <Slider
                value={amplitude}
                min={0}
                max={38}
                onChange={setAmplitude}
                style={{ flexGrow: 1 }}
              />
            </box>
          </box>

          <box style={{ ...s.card, flexGrow: 1 }}>
            <text style={s.title}>
              {slow.length} of {ROWS.length} steps over {threshold}ms
            </text>
            <box style={s.row}>
              <text style={s.hint}>threshold</text>
              <Slider
                value={threshold}
                min={0}
                max={900}
                step={20}
                onChange={setThreshold}
                style={{ flexGrow: 1 }}
              />
            </box>
            <Table
              columns={COLUMNS}
              rows={slow}
              rowHeight={20}
              style={{ flexGrow: 1 }}
            />
          </box>
        </box>

        <box style={s.fixedCol}>
          <box style={s.card}>
            <text style={s.title}>a form, for focus</text>
            <textinput
              value={name}
              onChange={setName}
              placeholder="your name"
              style={{ width: '100%' }}
            />
            <textarea rows={3} placeholder="notes" style={{ width: '100%' }} />
            <Tooltip label="Nothing happens, by design">
              <Button
                primary
                label="Submit"
                onPress={() => setPresses((n) => n + 1)}
              />
            </Tooltip>
            <text style={s.hint}>
              {presses} presses{name ? `, hello ${name}` : ''}
            </text>
          </box>

          <box style={{ ...s.card, flexGrow: 1 }}>
            <text style={s.title}>static filler</text>
            {/* Nodes that never change, so they should never be repainted —
                they are here to make a full-window frame expensive enough to
                notice in the log's ms column. */}
            {Array.from({ length: 24 }, (_, i) => (
              <box key={i} style={s.row}>
                <box
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: i % 3 ? '#dfe6e9' : '#00b894',
                  }}
                />
                <text style={s.hint}>filler row {String(i)}</text>
              </box>
            ))}
          </box>
        </box>
      </box>
    </box>
  );
}
