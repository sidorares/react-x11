// Live-server frame benchmark: what does a 60Hz animation actually cost on
// *this* X server?
//
//   npm run bench:frames                    # move a rounded box for 8s
//   npm run bench:frames -- color           # paint-only change (no layout)
//   npm run bench:frames -- text            # a re-laid-out label
//   npm run bench:frames -- move 8 --square # same box, no borderRadius
//   npm run bench:frames -- cards           # a wall of rounded bordered cards
//   npm run bench:frames -- spinner         # <ProgressBar indeterminate>
//
// The protocol bench (protocol.js) counts requests against an in-process
// server, so it is deterministic — and blind to how long a real server
// takes to execute them. This one renders against $DISPLAY and reports the
// two numbers that separate client cost from server cost:
//
//   paint    how long the client spent building each frame's requests
//   landed   how long the frame took to be answered — ntk's frameLatency,
//            whose meaning follows the clock the window is on
//
// On ntk >= 7 a window presents by default and its frames end on the
// display, so `landed` is time-to-display and reads about one refresh
// period: 16ms on a 60Hz screen is the system working, not a stall. What to
// watch there is `fps` against the refresh rate, and `dropped`.
//
// On the fence clock (`frameClock: 'fence'`) it is a server round trip
// instead, and a healthy local server holds it well under a millisecond;
// one that dwarfs paint is a server-side bottleneck — RENDER ops falling
// back to software (glamor has no AddTraps acceleration, so every rounded
// rectangle pays it), a virtualized GPU, a compositor recomposite per blit.
// That is the arm to use for server-cost questions: run `move` against
// `move --square` to see what one rounded corner mask costs on your setup,
// where on glamor/virgl it has been measured at 10-40x the square run.
//
// The damage columns catch the other regression class: `color` must stay
// rect-bounded (~the box's own area), while `move`/`text` currently degrade
// to FULL WINDOW because a layout pass claims unbounded damage.
//
// `cards` is the wall from issue #219: N rounded, bordered cards, all
// recoloured every frame, so the frame is box chrome and nothing else. With
// ntk >= 6.7.0 a recognized box goes out as cached corner glyphs plus
// FillRectangles instead of polygon rasterization, and the `boxes` line
// reports how many took that route — a bail-out is a silent perf cliff, so
// the A/B is worth running both ways:
//
//   npm run bench:frames -- cards 8 --border=2        # fast path
//   npm run bench:frames -- cards 8 --border=2 --no-glyphs   # forced fallback
//
// `spinner` is issue #352's question: what does an indeterminate progress bar
// cost? It renders once and never again — the block moves on a style loop
// (`animation`, docs/styling.md#loops), so there is no React work per frame
// at all — and the number to read is the damage line, which must stay
// bounded at about the bar's own area with no FULL WINDOW frames. The A/B is
// the thing an app would otherwise have written:
//
//   npm run bench:frames -- spinner
//   npm run bench:frames -- spinner 8 --interval   # setInterval + setState
//
// The `--interval` arm moves an identical bar from React state at the same
// cadence. It re-renders the tree per frame and its damage goes unbounded —
// a layout change claims the whole window — which is the difference the
// primitive exists for.
//
// `--border=N` matters more than it looks: an odd border width makes the
// stroke's centre-line radius half-integer, which the fast path declines
// (see docs/debugging.md).
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';

process.env.REACT_X11_NO_AUTORUN = '1';
const { createRoot } = await import('../../src/index.js');
const { startTrace, formatShapes } = await import('../../src/debug.js');
const { ProgressBar } = await import('../../src/components/index.js');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const MODE = args[0] ?? 'move';
const SECONDS = Number(args[1] ?? 8);
const SQUARE = process.argv.includes('--square');
const flag = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
};
const CARDS = flag('cards', 48);
const BORDER = flag('border', 1);
const NO_GLYPHS = process.argv.includes('--no-glyphs');
const INTERVAL = process.argv.includes('--interval');
if (!['move', 'color', 'text', 'cards', 'spinner'].includes(MODE)) {
  console.error(
    `unknown mode ${JSON.stringify(MODE)} — move | color | text | cards | spinner`,
  );
  process.exit(1);
}

const e = React.createElement;
const W = 800;
const H = 600;

// Card geometry is held integer on purpose: a fractional box is one of the
// documented bail-out reasons, so a wall laid out on half-pixels would
// measure the fallback while claiming to measure the fast path.
const CARD_W = 130;
const CARD_H = 70;
const GAP = 12;
const PAD = 16;
const CARD_TINTS = ['#ffffff', '#eef4fb', '#fdf1e7', '#eefaf1'];

/**
 * A wall of rounded, bordered cards, every one recoloured each frame: the
 * frame is box chrome and nothing else. Cards sit at absolute integer
 * positions rather than in a wrapping flex row, so the geometry the fast
 * path sees does not depend on how yoga rounds a wrap.
 */
function CardWall({ tick }) {
  const perRow = Math.max(1, Math.floor((W - 2 * PAD + GAP) / (CARD_W + GAP)));
  const cards = [];
  for (let i = 0; i < CARDS; i += 1) {
    cards.push(
      e('box', {
        key: i,
        style: {
          position: 'absolute',
          left: PAD + (i % perRow) * (CARD_W + GAP),
          top: PAD + Math.floor(i / perRow) * (CARD_H + GAP),
          width: CARD_W,
          height: CARD_H,
          backgroundColor: CARD_TINTS[(i + tick) % CARD_TINTS.length],
          borderRadius: SQUARE ? 0 : 8,
          ...(BORDER > 0
            ? { borderWidth: BORDER, borderColor: '#c3ccd8' }
            : null),
        },
      }),
    );
  }
  return e(
    'window',
    {
      width: W,
      height: H,
      title: 'bench:frames cards',
      style: { backgroundColor: '#e9edf2' },
    },
    e('box', { style: { flexGrow: 1 } }, ...cards),
  );
}

const BAR_W = 400;
const BAR_H = 8;
const BLOCK = '40%';

/**
 * An indeterminate bar, both ways round. The loop arm is the shipped
 * `<ProgressBar indeterminate>`; the `--interval` arm is the same drawing
 * with its position coming from a React state change per frame instead, so
 * the two lines of the comparison differ in nothing but who moves the block.
 */
function Spinner({ tick }) {
  // 68 ticks of 16ms is the widget's own 1100ms crossing, so the two arms
  // move at the same speed and the numbers compare
  const at = -40 + ((tick % 68) / 68) * 140;
  return e(
    'window',
    {
      width: W,
      height: H,
      title: `bench:frames spinner${INTERVAL ? ' (setInterval)' : ''}`,
      style: { backgroundColor: '#f4f4f4' },
    },
    e(
      'box',
      { style: { flexGrow: 1, padding: 16, gap: 12, alignItems: 'center' } },
      e(
        'text',
        { style: { color: '#7f8c8d' } },
        'static text above the bar to give the frame some weight',
      ),
      INTERVAL
        ? e(
            'box',
            {
              style: {
                width: BAR_W,
                height: BAR_H,
                borderRadius: BAR_H / 2,
                backgroundColor: '#dfe6ee',
                overflow: 'hidden',
              },
            },
            e('box', {
              style: {
                position: 'absolute',
                top: 0,
                height: BAR_H,
                width: BLOCK,
                left: `${at}%`,
                borderRadius: BAR_H / 2,
                backgroundColor: '#3498db',
              },
            }),
          )
        : e(ProgressBar, {
            indeterminate: true,
            height: BAR_H,
            style: { width: BAR_W },
          }),
      e(
        'text',
        { style: { color: '#7f8c8d', marginTop: 200 } },
        'static text below the animation to give the frame some weight',
      ),
    ),
  );
}

function App({ tick }) {
  if (MODE === 'cards') return e(CardWall, { tick });
  if (MODE === 'spinner') return e(Spinner, { tick });
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

// The A/B switch: `maxRadius: 0` is ntk's documented off position for the
// rounded-box fast path, so the same scene can be measured on the polygon
// route without rebuilding anything.
if (NO_GLYPHS) root.app.shapePolicy = { maxRadius: 0 };

let tick = 0;
root.render(e(App, { tick }));
await new Promise((r) => setTimeout(r, 500)); // mount and settle

const t0 = performance.now();
// The loop arm renders once and is never touched again — that *is* the
// measurement, so there is no timer to start.
const timer =
  MODE === 'spinner' && !INTERVAL
    ? null
    : setInterval(() => {
        tick += 1;
        root.render(e(App, { tick }));
      }, 16);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
if (timer) clearInterval(timer);
const elapsed = (performance.now() - t0) / 1000;

const stats = trace.stop();
const events = JSON.parse(readFileSync(tracePath, 'utf8')).traceEvents;
unlinkSync(tracePath);

const frames = events.filter((ev) => ev.name === 'frame');
const paint = frames.map((f) => f.dur / 1000).sort((a, b) => a - b);
const landed = frames
  .map((f) => f.args?.landedMs)
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

const scene =
  MODE === 'cards'
    ? `cards x${CARDS}${SQUARE ? ' square' : ' r8'} bw=${BORDER}` +
      (NO_GLYPHS ? ' (glyphs off)' : '')
    : MODE === 'spinner'
      ? `spinner (${INTERVAL ? 'setInterval + setState' : 'style loop'})`
      : `${MODE}${SQUARE ? ' (square)' : ''}`;
console.log(
  `${scene}: ${frames.length} frames in ${elapsed.toFixed(1)}s` +
    ` = ${(frames.length / elapsed).toFixed(1)} fps (${tick} ticks issued)`,
);
console.log(
  `  damage   ${full} FULL WINDOW, ${areas.length} bounded` +
    (areas.length ? ` (avg ${Math.round(avg(areas) / 1000)}kpx)` : ''),
);
console.log(
  `           min    avg    p95    max   (ms)\n` +
    `  paint  ${ms(paint[0])} ${ms(avg(paint))} ${ms(q(paint, 0.95))} ${ms(paint[paint.length - 1])}\n` +
    `  landed ${ms(landed[0])} ${ms(avg(landed))} ${ms(q(landed, 0.95))} ${ms(landed[landed.length - 1])}`,
);
// per frame, not per run: when a route change moves the frame rate by 10x,
// the totals compare different numbers of frames and say nothing
const perFrameKB = frames.length
  ? (stats.bytesOut / 1024 / frames.length).toFixed(1)
  : '-';
console.log(
  `  wire     ${stats.requests} requests, ${(stats.bytesOut / 1024).toFixed(0)}KB out` +
    ` (${perFrameKB}KB/frame), ${stats.replies} replies`,
);
const boxes = formatShapes(stats.shapes);
if (boxes) {
  const perFrame = (n) =>
    frames.length ? (n / frames.length).toFixed(1) : '-';
  const fell = Object.values(stats.shapes.misses).reduce((s, v) => s + v, 0);
  console.log(
    `  boxes    ${boxes}` +
      ` — ${perFrame(stats.shapes.hits)} fast, ${perFrame(fell)} fallback per frame`,
  );
}
process.exit(0);
