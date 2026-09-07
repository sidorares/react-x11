// What the memcpy `copy` is worth, against the real Cocoa bridge (issue #498).
//
// `test/cocoa-composite.test.js` pins the invariant — the blit and the
// CGImage draw are the same picture — over a fake bridge in CI and over the
// real one where it loads. This is the other question, the one a test
// cannot answer: how much time the two routes actually cost, on this
// machine, at the sizes an element compositing a surface of its own works
// at.
//
//   node scripts/cocoa-composite-probe.mjs [iterations]
//
// The shape measured is `<Terminal backend="vt">`'s present
// (sidorares/react-x11-components#69 §6): a grid-sized surface composited
// into the window at a translate, every frame. Three destinations per size
// — the whole surface, a one-row damage rect, and a third of the grid —
// since a paint pass is clipped to its damage and the clip is the argument
// the blit needs to be given.
//
// Requires @windowkit/appkit 0.7.0 or newer, where `ctxSetBlendMode` and
// `blitSurface` arrived; on a bridge without them it says so and exits,
// since the fallback is what it would otherwise be measuring twice.
import { CocoaContext2D } from '../src/cocoa/context2d.js';
import { loadNative } from '../src/cocoa/native.js';

const ITERATIONS = Number(process.argv[2] ?? 200);

let bridge;
try {
  bridge = loadNative();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
for (const verb of ['ctxSetBlendMode', 'blitSurface']) {
  if (typeof bridge[verb] !== 'function') {
    console.error(
      `this @windowkit/appkit has no ${verb}() — nothing to compare against.\n` +
        'Point REACT_X11_CALAYERS_PATH at a build that has it.',
    );
    process.exit(1);
  }
}

/** A grid of cells, drawn once — the terminal's surface between presents. */
function grid(cols, rows, cw, ch) {
  const surface = bridge.createSurface(cols * cw, rows * ch, 2);
  const ctx = new CocoaContext2D(
    bridge,
    () => surface,
    () => 1,
  );
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = ((r * cols + c) % 16) / 16;
      ctx.fillStyle = `rgb(${20 + t * 200}, ${40 + t * 120}, ${60 + t * 90})`;
      ctx.fillRect(c * cw, r * ch, cw, ch);
    }
  }
  return { surface, width: cols * cw, height: rows * ch };
}

/** `fn` per iteration, in milliseconds, the best of three sweeps — a
 *  composite is a memory-bound loop and the machine's other tenants only
 *  ever add to it. */
function time(fn) {
  let best = Infinity;
  for (let sweep = 0; sweep < 3; sweep++) {
    fn(); // warm
    const t0 = performance.now();
    for (let i = 0; i < ITERATIONS; i++) fn();
    best = Math.min(best, (performance.now() - t0) / ITERATIONS);
  }
  return best;
}

const SIZES = [
  { label: '125x45 @2x (the PRD grid)', cols: 125, rows: 45, cw: 16, ch: 36 },
  { label: '80x24 @2x', cols: 80, rows: 24, cw: 16, ch: 36 },
  { label: '125x45 @1x', cols: 125, rows: 45, cw: 8, ch: 18 },
];

console.log(`${ITERATIONS} composites per cell, best of 3 sweeps\n`);
const rows = [];
for (const size of SIZES) {
  const src = grid(size.cols, size.rows, size.cw, size.ch);
  const dst = bridge.createSurface(src.width + 64, src.height + 96, 2);
  const damages = [
    { label: 'whole', rect: null },
    { label: 'one row', rect: [0, 0, src.width, size.ch] },
    { label: 'a third', rect: [0, 0, src.width, Math.round(src.height / 3)] },
  ];
  for (const damage of damages) {
    const run = (blits) => {
      const native = blits
        ? bridge
        : new Proxy(bridge, {
            get: (t, k) => (k === 'blitSurface' ? undefined : t[k]),
          });
      const ctx = new CocoaContext2D(
        native,
        () => dst,
        () => 1,
      );
      ctx.globalCompositeOperation = 'copy';
      return () => {
        ctx.save();
        ctx.translate(32, 48);
        if (damage.rect) {
          ctx.beginPath();
          ctx.rect(...damage.rect);
          ctx.clip();
        }
        ctx.drawImage({ _surfaceHandle: src.surface }, 0, 0);
        ctx.restore();
      };
    };
    const drawn = time(run(false));
    const blitted = time(run(true));
    rows.push({
      size: size.label,
      damage: damage.label,
      'CGImage draw (ms)': drawn.toFixed(3),
      'memcpy (ms)': blitted.toFixed(3),
      saved: `${(100 * (1 - blitted / drawn)).toFixed(0)}%`,
    });
  }
}
console.table(rows);
