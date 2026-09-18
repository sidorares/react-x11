// The frame cost of the win32 backend, measured on a real window.
//
// The numbers are the ones `bench:presenters` keeps for Cocoa, and they are
// deliberately **structural** rather than milliseconds-first: how much of the
// window a one-cell change repaints, how many BeginDraws a frame opens, how
// many frames a window nobody can see is charged for. A shared machine's
// timings say little; "one cell repainted 60% of the window" is the same
// finding everywhere. The timings print beside them for the trend.
//
//   node --import tsx scripts/win32-bench.jsx [--rows 40] [--cols 12]
import React from 'react';

import { createRoot } from '../src/index.js';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const ROWS = arg('rows', 40);
const COLS = arg('cols', 12);

let setHot = null;

function Grid() {
  const [hot, set] = React.useState(-1);
  setHot = set;
  const rows = [];
  for (let r = 0; r < ROWS; r++) {
    const cells = [];
    for (let c = 0; c < COLS; c++) {
      const on = hot === r * COLS + c;
      cells.push(
        React.createElement(
          'box',
          {
            key: c,
            style: {
              width: 64,
              height: 22,
              margin: 2,
              borderRadius: 4,
              backgroundColor: on ? '#e67e22' : '#2c3e50',
              justifyContent: 'center',
              alignItems: 'center',
            },
          },
          React.createElement(
            'text',
            { style: { color: '#ecf0f1', fontSize: 11 } },
            `${r}.${c}`,
          ),
        ),
      );
    }
    rows.push(
      React.createElement(
        'box',
        { key: r, style: { flexDirection: 'row' } },
        cells,
      ),
    );
  }
  return React.createElement(
    'window',
    { width: COLS * 70 + 24, height: ROWS * 26 + 24, title: 'win32-bench' },
    React.createElement(
      'box',
      { style: { flexGrow: 1, padding: 12, backgroundColor: '#1b2631' } },
      rows,
    ),
  );
}

const root = await createRoot({ backend: 'win32' });
root.render(React.createElement(Grid));

const app = root.app ?? root._app;
const [wnd] = [...app._windows.values()];

// Wrap the frame to count what it actually opened and how long it took.
const frames = [];
const realPresent = wnd.presentFrame.bind(wnd);
wnd.presentFrame = (node, damage) => {
  const started = performance.now();
  const before = wnd._gen;
  realPresent(node, damage);
  frames.push({
    ms: performance.now() - started,
    rects: damage ? damage.length : 'full',
    opened: wnd._gen - before,
    area: damage
      ? damage.reduce((sum, r) => sum + r.width * r.height, 0)
      : wnd.width * wnd.height,
  });
};

const settle = () => new Promise((r) => setTimeout(r, 90));
const summarise = (list) => {
  const ms = list.map((f) => f.ms).sort((a, b) => a - b);
  return {
    frames: list.length,
    median: ms.length ? +ms[ms.length >> 1].toFixed(2) : 0,
    worst: ms.length ? +ms[ms.length - 1].toFixed(2) : 0,
    opened: list.reduce((s, f) => s + f.opened, 0),
    fullWindow: list.filter((f) => f.rects === 'full').length,
  };
};

await settle();
await settle();

const windowArea = wnd.width * wnd.height;
console.log(`grid    : ${ROWS}x${COLS} = ${ROWS * COLS} cells`);
console.log(`window  : ${wnd.width}x${wnd.height} device px, scale ${app.scale}`);

// --- the first frame, which is the whole window ------------------------------
console.log('\nmount   :', summarise(frames));

// --- one cell changes, thirty times -----------------------------------------
frames.length = 0;
for (let i = 0; i < 30; i++) {
  setHot(i % (ROWS * COLS));
  await settle();
}
const cells = summarise(frames);
const painted = frames.reduce((s, f) => s + f.area, 0) / Math.max(1, frames.length);
console.log('one cell:', cells);
console.log(
  `        : ${Math.round(painted)} px repainted per frame, ` +
    `${((painted / windowArea) * 100).toFixed(1)}% of the window ` +
    `(a cell is ${64 * app.scale * (22 * app.scale)} px)`,
);
if (cells.fullWindow > 0) {
  console.log(
    `        : WARNING — ${cells.fullWindow} of those repainted the whole ` +
      'window. That is the regression class AGENTS.md calls out.',
  );
}

app.close();
process.exit(0);
