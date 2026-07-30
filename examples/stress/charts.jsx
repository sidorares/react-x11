// SVG parametrised by state: four drawings whose geometry is recomputed from
// slider values on every change.
//
// This is the panel that hurts, and on purpose. `<svg>` children are real
// host elements (<path>, <circle>, …) reconciled by React, but SvgNode
// rebuilds the whole SvgView whenever anything in its subtree changes
// (src/richnodes.js:356), so dragging one slider re-serialises and re-parses
// the entire drawing per frame. The wave has ~120 points, which makes that
// cost easy to see in the frame log.
//
// What to look for:
//   - dragging a slider should repaint the card that changed, not the panel
//   - the frame log's ms column climbing with `points`, which is the
//     rebuild cost rather than the paint cost
//   - the donut's arcs closing exactly, with no seam at 12 o'clock
import React, { useState } from 'react';
import { createStyles, Slider, Switch } from '../../src/index.js';

const s = createStyles({
  panel: { flexGrow: 1, minHeight: 0, padding: 16, gap: 12 },
  head: { fontSize: 18, color: '#2d3436' },
  hint: { fontSize: 11, color: '#7f8c8d' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#dfe6e9',
    borderRadius: 4,
    padding: 10,
    gap: 8,
    width: 300,
  },
  title: { fontSize: 12, color: '#2d3436' },
  ctl: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ctlLabel: { fontSize: 10, color: '#7f8c8d', width: 62 },
  ctlValue: { fontSize: 10, color: '#2d3436', width: 34, textAlign: 'right' },
});

function Control({ label, value, min, max, step, onChange, format }) {
  return (
    <box style={s.ctl}>
      <text style={s.ctlLabel}>{label}</text>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={onChange}
        style={{ flexGrow: 1 }}
      />
      <text style={s.ctlValue}>{format ? format(value) : String(value)}</text>
    </box>
  );
}

// --- 1. a wave -------------------------------------------------------------

function wavePath(points, amplitude, frequency, phase) {
  const parts = [];
  for (let i = 0; i <= points; i++) {
    const t = i / points;
    const x = t * 280;
    const y = 60 - amplitude * Math.sin(t * frequency * Math.PI * 2 + phase);
    parts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return parts.join(' ');
}

function WaveCard() {
  const [amplitude, setAmplitude] = useState(40);
  const [frequency, setFrequency] = useState(2);
  const [phase, setPhase] = useState(0);
  const [points, setPoints] = useState(120);
  const [filled, setFilled] = useState(false);

  const d = wavePath(points, amplitude, frequency, phase / 10);
  // closing the path back along the baseline is what makes a fill meaningful
  const area = `${d} L280 120 L0 120 Z`;

  return (
    <box style={s.card}>
      <text style={s.title}>Wave — {points} points</text>
      <svg viewBox="0 0 280 120" style={{ width: 280, height: 120 }}>
        <rect x={0} y={0} width={280} height={120} fill="#fbfcfd" />
        <line
          x1={0}
          y1={60}
          x2={280}
          y2={60}
          stroke="#dfe6e9"
          strokeWidth={1}
        />
        <path
          d={filled ? area : d}
          fill={filled ? 'rgba(9, 132, 227, 0.25)' : 'none'}
          stroke="#0984e3"
          strokeWidth={2}
        />
      </svg>
      <Control
        label="amplitude"
        value={amplitude}
        min={0}
        max={58}
        onChange={setAmplitude}
      />
      <Control
        label="frequency"
        value={frequency}
        min={1}
        max={12}
        onChange={setFrequency}
      />
      <Control
        label="phase"
        value={phase}
        min={0}
        max={62}
        onChange={setPhase}
      />
      <Control
        label="points"
        value={points}
        min={8}
        max={400}
        step={8}
        onChange={setPoints}
      />
      <box style={s.ctl}>
        <text style={s.ctlLabel}>fill</text>
        <Switch checked={filled} onChange={setFilled} />
      </box>
    </box>
  );
}

// --- 2. a donut ------------------------------------------------------------

/** One donut segment as an SVG arc path, from `a0` to `a1` radians. */
function arc(cx, cy, rOuter, rInner, a0, a1) {
  const p = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(rOuter, a0);
  const [x1, y1] = p(rOuter, a1);
  const [x2, y2] = p(rInner, a1);
  const [x3, y3] = p(rInner, a0);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return [
    `M${x0.toFixed(2)} ${y0.toFixed(2)}`,
    `A${rOuter} ${rOuter} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    `L${x2.toFixed(2)} ${y2.toFixed(2)}`,
    `A${rInner} ${rInner} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)}`,
    'Z',
  ].join(' ');
}

const DONUT_COLORS = ['#0984e3', '#00b894', '#fdcb6e', '#e17055', '#6c5ce7'];

function DonutCard() {
  const [values, setValues] = useState([30, 25, 20, 15, 10]);
  const [hole, setHole] = useState(40);

  const total = values.reduce((a, b) => a + b, 0) || 1;
  let angle = -Math.PI / 2; // start at 12 o'clock
  const segments = values.map((v, i) => {
    const sweep = (v / total) * Math.PI * 2;
    const d = arc(70, 70, 62, hole * 0.62, angle, angle + sweep);
    angle += sweep;
    return { d, color: DONUT_COLORS[i], value: v };
  });

  const set = (i) => (v) =>
    setValues((prev) => prev.map((old, j) => (j === i ? v : old)));

  return (
    <box style={s.card}>
      <text style={s.title}>Donut — {total} total</text>
      <box style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <svg viewBox="0 0 140 140" style={{ width: 140, height: 140 }}>
          {segments.map((seg, i) => (
            <path key={i} d={seg.d} fill={seg.color} />
          ))}
        </svg>
        <box style={{ flexGrow: 1, gap: 4 }}>
          {values.map((v, i) => (
            <box key={i} style={s.ctl}>
              <box
                style={{
                  width: 8,
                  height: 8,
                  backgroundColor: DONUT_COLORS[i],
                  borderRadius: 2,
                }}
              />
              <Slider
                value={v}
                min={0}
                max={50}
                onChange={set(i)}
                style={{ flexGrow: 1 }}
              />
              <text style={s.ctlValue}>{String(v)}</text>
            </box>
          ))}
        </box>
      </box>
      <Control label="hole" value={hole} min={0} max={90} onChange={setHole} />
    </box>
  );
}

// --- 3. a bezier with draggable-looking control points ---------------------

function BezierCard() {
  const [c1x, setC1x] = useState(70);
  const [c1y, setC1y] = useState(10);
  const [c2x, setC2x] = useState(200);
  const [c2y, setC2y] = useState(110);

  const d = `M10 100 C${c1x} ${c1y} ${c2x} ${c2y} 270 20`;

  return (
    <box style={s.card}>
      <text style={s.title}>Cubic bezier</text>
      <svg viewBox="0 0 280 120" style={{ width: 280, height: 120 }}>
        <rect x={0} y={0} width={280} height={120} fill="#fbfcfd" />
        {/* the control polygon, so the handles' effect is legible */}
        <path
          d={`M10 100 L${c1x} ${c1y} M${c2x} ${c2y} L270 20`}
          stroke="#dfe6e9"
          strokeWidth={1}
          fill="none"
        />
        <path d={d} stroke="#6c5ce7" strokeWidth={3} fill="none" />
        <circle cx={c1x} cy={c1y} r={5} fill="#e17055" />
        <circle cx={c2x} cy={c2y} r={5} fill="#00b894" />
        <circle cx={10} cy={100} r={4} fill="#2d3436" />
        <circle cx={270} cy={20} r={4} fill="#2d3436" />
      </svg>
      <Control label="c1 x" value={c1x} min={0} max={280} onChange={setC1x} />
      <Control label="c1 y" value={c1y} min={0} max={120} onChange={setC1y} />
      <Control label="c2 x" value={c2x} min={0} max={280} onChange={setC2x} />
      <Control label="c2 y" value={c2y} min={0} max={120} onChange={setC2y} />
    </box>
  );
}

// --- 4. a bar chart with gradients and text ------------------------------

const BARS = [
  { label: 'Mon', base: 32 },
  { label: 'Tue', base: 58 },
  { label: 'Wed', base: 41 },
  { label: 'Thu', base: 74 },
  { label: 'Fri', base: 66 },
  { label: 'Sat', base: 18 },
  { label: 'Sun', base: 12 },
];

function BarsCard() {
  const [scale, setScale] = useState(100);
  const [gap, setGap] = useState(8);

  const slot = (280 - gap) / BARS.length;
  const barWidth = Math.max(2, slot - gap);

  return (
    <box style={s.card}>
      <text style={s.title}>Bars — gradient fill + labels</text>
      <svg viewBox="0 0 280 140" style={{ width: 280, height: 140 }}>
        <defs>
          <linearGradient id="barFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00b894" />
            <stop offset="100%" stopColor="#0984e3" />
          </linearGradient>
        </defs>
        {BARS.map((bar, i) => {
          const h = (bar.base * scale) / 100;
          return (
            <rect
              key={bar.label}
              x={gap + i * slot}
              y={110 - h}
              width={barWidth}
              height={h}
              fill="url(#barFill)"
            />
          );
        })}
        <line
          x1={0}
          y1={110}
          x2={280}
          y2={110}
          stroke="#b2bec3"
          strokeWidth={1}
        />
        {BARS.map((bar, i) => (
          <text
            key={bar.label}
            x={gap + i * slot + barWidth / 2}
            y={126}
            fontSize={9}
            fill="#7f8c8d"
            textAnchor="middle"
          >
            {bar.label}
          </text>
        ))}
      </svg>
      <Control
        label="scale"
        value={scale}
        min={0}
        max={140}
        onChange={setScale}
        format={(v) => `${v}%`}
      />
      <Control label="gap" value={gap} min={0} max={30} onChange={setGap} />
    </box>
  );
}

export function ChartsPanel() {
  return (
    <scrollview style={s.panel}>
      <text style={s.head}>Charts — SVG from state</text>
      <text style={s.hint}>
        Every drawing is rebuilt from slider values. Watch the frame log while
        dragging: the damage rect should stay inside one card, and the ms column
        shows what re-serialising the subtree costs.
      </text>
      <box style={s.grid}>
        <WaveCard />
        <DonutCard />
        <BezierCard />
        <BarsCard />
      </box>
    </scrollview>
  );
}
