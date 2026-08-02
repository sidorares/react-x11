// Live-server frame benchmark: what does a 60Hz animation actually cost on
// *this* X server?
//
//   npm run bench:frames                    # move a rounded box for 8s
//   npm run bench:frames -- color           # paint-only change (no layout)
//   npm run bench:frames -- text            # a re-laid-out label
//   npm run bench:frames -- move 8 --square # same box, no borderRadius
//
// The protocol bench (protocol.js) counts requests against an in-process
// server, so it is deterministic — and blind to how long a real server
// takes to execute them. This one renders against $DISPLAY and reports the
// two numbers that separate client cost from server cost:
//
//   paint    how long the client spent building each frame's requests
//   fence    ntk's measured GetInputFocus round trip after each frame —
//            how long the server took to drain them
//
// A healthy local server holds the fence well under a millisecond. A fence
// that dwarfs paint is a server-side bottleneck: RENDER ops falling back to
// software (glamor has no AddTraps acceleration — every rounded rectangle
// pays it), a virtualized GPU, a compositor recomposite per blit. Run
// `move` against `move --square` to see exactly what one rounded corner
// mask costs on your setup; on glamor/virgl it has been measured at 10-40x
// the fence of the square run.
//
// The damage columns catch the other regression class: `color` must stay
// rect-bounded (~the box's own area), while `move`/`text` currently degrade
// to FULL WINDOW because a layout pass claims unbounded damage.
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';

process.env.REACT_X11_NO_AUTORUN = '1';
const { createRoot } = await import('../../src/index.js');
const { startTrace } = await import('../../src/debug.js');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const MODE = args[0] ?? 'move';
const SECONDS = Number(args[1] ?? 8);
const SQUARE = process.argv.includes('--square');
if (!['move', 'color', 'text'].includes(MODE)) {
  console.error(`unknown mode ${JSON.stringify(MODE)} — move | color | text`);
  process.exit(1);
}

const e = React.createElement;
const W = 800;
const H = 600;

function App({ tick }) {
  const left =
    MODE === 'move' ? Math.round(340 + 300 * Math.sin(tick / 20)) : 340;
  const color =
    MODE === 'color' ? (tick % 2 ? '#3498db' : '#e74c3c') : '#3498db';
  const label = MODE === 'text' ? `tick ${tick}` : 'tick';
  return e(
    'window',
    {
      width: W,
      height: H,
      title: 'bench:frames',
      style: { backgroundColor: '#f4f4f4' },
    },
    e(
      'box',
      { style: { flexGrow: 1, padding: 16, gap: 12 } },
      e('text', { style: { fontSize: 20, color: '#222' } }, label),
      e('box', {
        style: {
          position: 'absolute',
          left,
          top: 80,
          width: 100,
          height: 100,
          backgroundColor: color,
          borderRadius: SQUARE ? 0 : 8,
        },
      }),
      e(
        'text',
        { style: { color: '#7f8c8d', marginTop: 200 } },
        'static text below the animation to give the frame some weight',
      ),
    ),
  );
}

const tracePath = join(tmpdir(), `react-x11-frames-${process.pid}.json`);
const trace = startTrace({ sink: 'chrome', path: tracePath });
const root = await createRoot();

let tick = 0;
root.render(e(App, { tick }));
await new Promise((r) => setTimeout(r, 500)); // mount and settle

const t0 = performance.now();
const timer = setInterval(() => {
  tick += 1;
  root.render(e(App, { tick }));
}, 16);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(timer);
const elapsed = (performance.now() - t0) / 1000;

const stats = trace.stop();
const events = JSON.parse(readFileSync(tracePath, 'utf8')).traceEvents;
unlinkSync(tracePath);

const frames = events.filter((ev) => ev.name === 'frame');
const paint = frames.map((f) => f.dur / 1000).sort((a, b) => a - b);
const fence = frames
  .map((f) => f.args?.fenceMs)
  .filter((v) => typeof v === 'number')
  .sort((a, b) => a - b);
const full = frames.filter((f) => f.args?.full).length;
const areas = frames
  .filter((f) => !f.args?.full)
  .map((f) => f.args.area)
  .sort((a, b) => a - b);

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const q = (a, p) =>
  a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null;
const ms = (v) => (v == null ? '   -' : v.toFixed(2).padStart(6));

console.log(
  `${MODE}${SQUARE ? ' (square)' : ''}: ${frames.length} frames in ${elapsed.toFixed(1)}s` +
    ` = ${(frames.length / elapsed).toFixed(1)} fps (${tick} ticks issued)`,
);
console.log(
  `  damage   ${full} FULL WINDOW, ${areas.length} bounded` +
    (areas.length ? ` (avg ${Math.round(avg(areas) / 1000)}kpx)` : ''),
);
console.log(
  `           min    avg    p95    max   (ms)\n` +
    `  paint  ${ms(paint[0])} ${ms(avg(paint))} ${ms(q(paint, 0.95))} ${ms(paint[paint.length - 1])}\n` +
    `  fence  ${ms(fence[0])} ${ms(avg(fence))} ${ms(q(fence, 0.95))} ${ms(fence[fence.length - 1])}`,
);
console.log(
  `  wire     ${stats.requests} requests, ${(stats.bytesOut / 1024).toFixed(0)}KB out, ${stats.replies} replies`,
);
process.exit(0);
