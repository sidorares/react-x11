// The panel built for the dirty-rect work: a grid of cells where you control
// exactly how many change per commit, so the frame log can be read against a
// known expectation.
//
// The grid is deliberately large (up to 40x25 = 1000 cells). Each cell is a
// `<box>` with a `<text>` in it, so a commit that touches one cell walks a
// thousand nodes' `applyProps` and only one of them should claim damage.
//
// Read it like this — with the frame log next to the window:
//
//   "one cell"    a rect about one cell big. If it says FULL WINDOW, damage
//                 narrowing has regressed.
//   "one row"     a wide, short rect.
//   "one column"  a narrow, tall rect.
//   "scattered"   four rects, one per corner cell — not the box around them,
//                 which would be the whole grid. This mode is what justified
//                 making `_damage` a list of rects rather than one box; the
//                 frame log prints each rect and how much bigger a single box
//                 would have been.
//   "every cell"  FULL WINDOW, and it should be, which is what makes the
//                 other rows meaningful.
//
// The "animate" switch drives the same change on a timer instead of a click,
// so a sustained frame rate can be watched rather than a single frame.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, createStyles, Slider, Switch } from '../../src/index.js';

const s = createStyles({
  panel: { flexGrow: 1, minHeight: 0, padding: 12, gap: 8 },
  head: { fontSize: 16, color: '$text' },
  hint: { fontSize: 11, color: '$dim' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  label: { fontSize: 11, color: '$dim' },
  grid: {
    flexGrow: 1,
    minHeight: 0,
    gap: 1,
    padding: 4,
    backgroundColor: '$background',
    borderWidth: 1,
    borderColor: '$track',
    borderRadius: 3,
  },
  gridRow: { flexDirection: 'row', gap: 1, flexGrow: 1, flexBasis: 0 },
  cell: {
    flexGrow: 1,
    flexBasis: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 1,
  },
  cellText: { fontSize: 8 },
});

const MODES = [
  { id: 'one', label: 'one cell' },
  { id: 'row', label: 'one row' },
  { id: 'column', label: 'one column' },
  { id: 'scattered', label: 'scattered' },
  { id: 'all', label: 'every cell' },
];

const COLD = '#eef2f5';
const HOT = ['#0984e3', '#00b894', '#e17055', '#6c5ce7', '#fdcb6e'];

/** Which cells are hot for `mode` at step `n`, as a Set of "r:c" keys. */
function hotCells(mode, n, rows, cols) {
  const hot = new Set();
  const r = n % rows;
  const c = n % cols;
  if (mode === 'one') hot.add(`${r}:${c}`);
  else if (mode === 'row') for (let j = 0; j < cols; j++) hot.add(`${r}:${j}`);
  else if (mode === 'column')
    for (let i = 0; i < rows; i++) hot.add(`${i}:${c}`);
  else if (mode === 'scattered') {
    // four cells spread to the corners, so the box around them is the whole
    // grid and only a list of rects can bound this frame usefully
    hot.add(`0:0`);
    hot.add(`${rows - 1}:${cols - 1}`);
    hot.add(`0:${cols - 1}`);
    hot.add(`${rows - 1}:0`);
  } else if (mode === 'all') {
    for (let i = 0; i < rows; i++)
      for (let j = 0; j < cols; j++) hot.add(`${i}:${j}`);
  }
  return hot;
}

export function DamagePanel() {
  const [cols, setCols] = useState(24);
  const [rows, setRows] = useState(16);
  const [mode, setMode] = useState('one');
  const [step, setStep] = useState(0);
  const [animate, setAnimate] = useState(false);
  const [labels, setLabels] = useState(false);
  const frames = useRef(0);

  const bump = useCallback(() => setStep((n) => n + 1), []);

  useEffect(() => {
    if (!animate) return undefined;
    // 60ms rather than requestAnimationFrame: the point is a steady, known
    // rate of commits, not the fastest possible one
    const timer = setInterval(bump, 60);
    return () => clearInterval(timer);
  }, [animate, bump]);

  const hot = hotCells(mode, step, rows, cols);
  const color = HOT[step % HOT.length];
  frames.current += 1;

  return (
    <box style={s.panel}>
      <text style={s.head}>Damage — {rows * cols} cells</text>
      <text style={s.hint}>
        Every commit walks all {rows * cols} cells. Only the ones that changed
        should claim damage, so the frame log&apos;s rect is the assertion.
      </text>

      <box style={s.row}>
        {MODES.map((m) => (
          <Button
            key={m.id}
            primary={mode === m.id}
            label={m.label}
            onPress={() => {
              setMode(m.id);
              bump();
            }}
          />
        ))}
      </box>

      <box style={s.row}>
        <Button primary label="step" onPress={bump} />
        <text style={s.label}>animate</text>
        <Switch checked={animate} onChange={(ev) => setAnimate(ev.value)} />
        <text style={s.label}>labels</text>
        <Switch checked={labels} onChange={(ev) => setLabels(ev.value)} />
        <text style={s.label}>cols {String(cols)}</text>
        <Slider
          value={cols}
          min={4}
          max={40}
          onChange={(ev) => setCols(ev.value)}
          style={{ width: 90 }}
        />
        <text style={s.label}>rows {String(rows)}</text>
        <Slider
          value={rows}
          min={4}
          max={25}
          onChange={(ev) => setRows(ev.value)}
          style={{ width: 90 }}
        />
      </box>
      {/* There is deliberately no live step counter here. A changing number
          next to the grid re-measures its <text>, a re-measure is a layout
          change, and a layout change is a full repaint by definition — so a
          counter would make every step report FULL WINDOW and quietly
          destroy the thing this panel exists to show. The step number is in
          the frame log instead. */}

      <box style={s.grid}>
        {Array.from({ length: rows }, (_, i) => (
          <box key={i} style={s.gridRow}>
            {Array.from({ length: cols }, (_, j) => {
              const on = hot.has(`${i}:${j}`);
              return (
                <box
                  key={j}
                  style={{
                    ...s.cell,
                    backgroundColor: on ? color : COLD,
                  }}
                >
                  {labels ? (
                    <text
                      style={{
                        ...s.cellText,
                        color: on ? '$background' : '$border',
                      }}
                    >
                      {String(j)}
                    </text>
                  ) : null}
                </box>
              );
            })}
          </box>
        ))}
      </box>
    </box>
  );
}
